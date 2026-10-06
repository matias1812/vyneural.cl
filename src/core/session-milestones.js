// src/core/session-milestones.js
// Onboarding progresivo — módulo de lógica pura (sin DOM, sin fetch, sin
// async) para decidir qué pregunta de onboarding corresponde mostrar según
// cuántas sesiones completó el usuario y qué ya respondió/saltó.
//
// Reutiliza sanitizeHistory (session-store.js) para no duplicar la
// sanitización del historial persistido (ob-history-v1).

import { sanitizeHistory } from './session-store.js';

const HISTORY_KEY = 'ob-history-v1';

/**
 * Cuenta de sesiones completadas, leída directamente del storage (inyectable
 * para tests). Nunca lanza: JSON corrupto o storage ausente/roto → 0.
 */
export function getCompletedSessionCount(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  if (!storage || typeof storage.getItem !== 'function') return 0;
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    return sanitizeHistory(parsed).length;
  } catch {
    return 0;
  }
}

export const ONBOARDING_MILESTONES = Object.freeze([
  { step: 'goal', atCount: 1 },
  { step: 'content_preferences', atCount: 3 },
  { step: 'discovery', atCount: 6 },
  { step: 'satisfaction', atCount: 10 },
]);

export const SKIP_COOLDOWN_SESSIONS = 2;

/**
 * Determina cuál es el siguiente hito de onboarding pendiente, dado el
 * número de sesiones completadas y el estado de respuestas/skips.
 * `state` shape: { answered: { [step]: boolean }, skippedAt: { [step]: { count } } }
 * Devuelve el `step` string a mostrar, o null si ninguno corresponde aún.
 */
export function nextDueStep(count, state) {
  for (const { step, atCount } of ONBOARDING_MILESTONES) {
    if (count < atCount) continue;
    if (state?.answered?.[step]) continue;
    const skipped = state?.skippedAt?.[step];
    if (skipped && count < skipped.count + SKIP_COOLDOWN_SESSIONS) continue;
    return step;
  }
  return null;
}
