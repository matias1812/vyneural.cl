// src/core/audio-health.js
// Pure decision logic for the audio watchdog.
//
// Kept DOM/Audio-free on purpose so the scientific suite (npm test) can
// validate it headless. SimulationEngine.loop() samples the live audio state
// every ~0.5 s, feeds it to evaluateAudioHealth(), and applies the returned
// action (resume / refade / none).
//
// Why it exists: on mobile the OS can suspend the AudioContext without firing
// visibilitychange (iOS locks the screen, Android loses audio focus, some
// devices suspend on fullscreen enter/exit). Without a watchdog the UI stays
// "en play" while the session is silent.

export const HEALTH_THRESHOLD = 3; // consecutive bad samples before acting

// Estados del ciclo de recuperación al volver de segundo plano (P0.5.9).
export const RECOVERY = {
  NONE: 'NONE',
  REQUIRED: 'REQUIRED',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

/**
 * Decide qué recuperación hace falta al volver de segundo plano (P0.5.9).
 * Se ejecuta UNA SOLA vez al volver; nunca reinicia la sesión completa.
 * @param {object} s
 * @param {boolean} s.wasSuspended   El AudioContext estaba suspendido al volver.
 * @param {string} s.ctxState        'running' | 'suspended' | 'interrupted' | null
 * @param {string} [s.transportMode] 'element' | 'direct'
 * @param {boolean} [s.elementPaused] ¿El <audio> real está pausado?
 * @returns {{action: string, state: string}}
 *   action: 'none' | 'recover' | 'reaffirm-element'
 */
export function planRecovery({ wasSuspended, ctxState, transportMode = 'direct', elementPaused = null }) {
  if (!wasSuspended && transportMode === 'element' && elementPaused === true) {
    // El contexto nunca se suspendió pero el SO pausó el elemento: re-afirmar.
    return { action: 'reaffirm-element', state: RECOVERY.RUNNING };
  }
  if (wasSuspended && (ctxState === 'suspended' || ctxState === 'interrupted')) {
    return { action: 'recover', state: RECOVERY.REQUIRED };
  }
  if (wasSuspended && ctxState === 'running') {
    return { action: 'none', state: RECOVERY.SUCCESS };
  }
  return { action: 'none', state: RECOVERY.NONE };
}

/**
 * @param {object} s
 * @param {boolean} s.isPlaying    Is the session supposed to be playing?
 * @param {string|null} s.ctxState 'running' | 'suspended' | 'interrupted' | null
 * @param {number} s.gain          Master gain value (0..1)
 * @param {number|null} s.rms      Analyser RMS (0..1), null if not available
 * @param {number} [s.prevHealth]  Accumulated bad samples from previous call
 * @returns {{ action: 'resume'|'refade'|'none', health: number }}
 */
export function evaluateAudioHealth({ isPlaying, ctxState, gain, rms, prevHealth = 0 }) {
  // Not playing or no context yet → nothing to do.
  if (!isPlaying || ctxState == null) return { action: 'none', health: 0 };

  let health = prevHealth;

  // Context suspended by the OS → count consecutive samples, then resume.
  if (ctxState === 'suspended' || ctxState === 'interrupted') {
    health += 1;
    if (health >= HEALTH_THRESHOLD) return { action: 'resume', health: 0 };
    return { action: 'none', health };
  }

  // Context running: only flag silence when the gain is not user-muted.
  // A muted session (gain at the 0.0001 floor or below 0.02) is intentional —
  // the watchdog must never fight the user's volume slider.
  if (gain > 0.02) {
    if (rms !== null && rms < 0.003) {
      health += 1;
      if (health >= HEALTH_THRESHOLD) return { action: 'refade', health: 0 };
      return { action: 'none', health };
    }
  }

  // Healthy signal (or muted by the user) → reset the counter.
  return { action: 'none', health: 0 };
}
