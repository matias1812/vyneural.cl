import './style.css';
import { inject } from '@vercel/analytics';
import { BinauralEngine } from './audio.js';
import { AmbientEngine } from './ambient.js';
import { WaveField } from './wavefield.js';
import { CymaticsRenderer } from './cymatics.js';
import { SimulationEngine } from './core/simulation.js';
import { ExperimentRunner } from './core/experiments.js';
import { createSilentAudio } from './core/media-anchor.js';
import { SimulationConfig, experimentToJson } from './core/reproducibility.js';
import { PROFILES, getProfileById } from './models/profiles.js';
import { CARRIER_BASE, carrierBaseFor } from './core/carrier.js';
import { initStarfield } from './starfield.js';
import {
  getAlarms,
  notificationSupported,
  permissionsDisabled,
  iosNeedsInstall,
  requestPermission,
  playChime,
  nextAlarmAt,
  buildGoogleCalendarUrl,
  downloadIcs,
  swReady,
  pushSupported,
  showSwNotification,
  showLocalNotification,
  isIos,
  isStandalone,
  rruleFor,
  saveAlarms,
} from './notifications.js';
import { AlarmManager, createDurableStore, alarmOwnerForPlatform } from './core/alarm-manager.js';
import { createNotificationManager } from './core/notification-manager.js';
import { getCachedPushStatus } from './api/push.js';
// P0 — Separación Core / Platform: el bridge nativo (futura APK Android) y
// la fusión honesta de capacidades. Sin bridge, todo queda como web pura.
import { createNativeBridgeAdapter, parseBridgeResponse } from './platform/native-bridge.js';
import { mergePlatformCapabilities } from './platform/platform-capabilities.js';
import { detectNotificationCapabilities, capabilitySummary } from './core/notification-capabilities.js';

import { runBineuralDiagnostics } from './validation/diagnostics.js';
import {
  evaluatePermissions,
  notifStateText,
  wakeStateText,
  enabledStateText,
} from './core/permissions.js';
import { AppLifecycle } from './core/lifecycle.js';
// P2 Fase 1 — máquina de estados CENTRAL del audio (UI ≠ AUDIO ≠ EXPERIMENTO).
import { AudioStateMachine } from './core/audio-state.js';
import { ExperimentEventLog } from './core/experiment-events.js';
import { probeCapabilities } from './core/capabilities.js';
import { AudioTransport } from './core/audio-transport.js';
import { planRecovery } from './core/audio-health.js';
// P1 — forense de duplicación de audio: cancelación de automation (M1) y
// deduplicación de restores de sesión por máquina de estados (M3).
import { muteMasterGain, restoreMasterGain } from './core/audio-automation.js';
import { RestoreGate } from './core/restore-gate.js';
// P5.4 — instrumentación causal: anillo de eventos de reproducción (quién
// emitió cada PLAY/PAUSE/STOP y en qué estado), para auditar reproducción
// fantasma. Espejo conceptual del anillo nativo Diagnostics.trace (Kotlin).
import { createCausalLog } from './core/causal-log.js';
// P5.2 — protocolo único Web→Nativo (contrato puro, testeado): PLAY/PAUSE/STOP
// simétricos — cada acción genera exactamente un comando nativo (o ninguno
// cuando el nativo ya la aplicó).
import {
  nativePlayCommand,
  nativePauseCommand,
  nativeStopCommand,
  NativeCommandCoalescer,
} from './core/native-protocol.js';
// P3 — sanitización de datos persistidos (crash recovery / corrupción).
import { sanitizeSession, sanitizeFavorites, sanitizeHistory } from './core/session-store.js';
// Backend (aditivo, FASE 17): sin VITE_API_URL ni flag local no hace nada.
import { initBackendIfConfigured } from './api/integration.js';
import { getAccessToken } from './api/client.js';
// Favoritos en la nube (aditivo): solo actúa con sesión iniciada.
import { syncFavoriteToCloud, syncUnfavoriteFromCloud } from './api/fav-sync.js';
// Guardar frecuencias personalizadas: inline, junto al panel de ajuste (ver
// #custom-save-freq más abajo) — ya no un modal aparte, para tener toda la
// config del panel personalizado en un solo lugar bajo el reproductor.
import { createFrequency } from './api/frequencies.js';
// Alarmas en la nube (P6-FEAT-001): la alarma del generador se sincroniza al
// backend cuando hay sesión, para que el scheduler server-side pueda enviar
// el Web Push a la hora exacta (app cerrada). Best-effort: un fallo nunca
// rompe la alarma local.
import { createAlarm, deleteAlarm, listAlarms as listServerAlarms } from './api/alarms.js';
// P1.5 Fase 5 — proveedor ÚNICO de audio (WEB | NATIVE | NONE). Nunca dos motores.
import { assertSingleAudioProvider, providerLabel } from './core/audio-provider.js';

// Initialize Vercel Analytics (no-op in development)
inject();

// Expose diagnostics to console
window.runBineuralDiagnostics = runBineuralDiagnostics;

// Controlador del fondo espacial (fondo decorativo de estrellas).
const starfield = initStarfield();

const cymatics = new CymaticsRenderer();
const simulation = new SimulationEngine(cymatics);
const ambient = new AmbientEngine();
simulation.ambient = ambient; // Link for auditory masking model

// ── Transporte de audio (P0.5) ───────────────────────────────────────────────
// Pipeline único: AudioContext → master → compressor → analyser →
// MediaStreamDestination → <audio> real (el que el SO ve como reproducción)
// en Android/desktop; en iOS (que no reproduce streams de Web Audio en un
// <audio>) el sonido sale directo por ctx.destination y el ancla muda queda
// como fallback legacy SOLO para reclamar la MediaSession.
simulation.audio.transport = new AudioTransport({ isIos: isIos() });

// R2 — coalescing de comandos de CONFIGURACIÓN nativa (volumen/onda/retune):
// una ráfaga de cambios (slider de volumen, clicks rápidos de onda/estado)
// entrega SOLO el último comando al servicio nativo en vez de uno por evento
// (forense R2: el startId se inflaba 3→78 sin crear reproducción). Los
// comandos de reproducción (START/RESUME/PAUSE/STOP) NO pasan por aquí.
const nativeCmdCoalescer = new NativeCommandCoalescer();
window.__nativeCmdCoalescer = nativeCmdCoalescer;

// ── Bridge nativo (P0, plan APK) ─────────────────────────────────────────────
// Adaptador seguro hacia el shell Android (WebView → Kotlin). Sin la APK
// (web/PWA) `present === false` y cada comando devuelve NOT_SUPPORTED: el
// comportamiento actual no cambia. La futura APK inyecta `window.AndroidBridge`
// y la web usa sus capacidades nativas sin tocar el core.
const nativeBridge = createNativeBridgeAdapter();
// P5.6 — frontera APK: el motor web nace inaudible si hay bridge nativo.
applyPlatformMutePolicy();
window.__nativeBridge = nativeBridge;

// ── Proveedor único de audio (P1.5 Fase 5) ──────────────────────────────────
// 'native' | 'web' | 'none'. El invariante assertSingleAudioProvider() falla
// si ambos motores suenan a la vez (la WebView mutea su motor cuando el
// servicio nativo reproduce). Se expone para el HUD, /diagnostico y tests.
let audioProvider = 'none';
window.__audioProvider = () => audioProvider;
window.__assertSingleAudioProvider = () =>
  assertSingleAudioProvider({
    provider: audioProvider,
    webGain: simulation.audio && simulation.audio.masterGain ? simulation.audio.masterGain.gain.value : 0,
  });
function setAudioProvider(p) {
  audioProvider = p;
  ilog('provider', providerLabel(p));
  if (!window.__assertSingleAudioProvider()) {
    console.warn('[vyneural] ¡doble motor de audio detectado: nativo activo y web con ganancia > 0!');
  }
}

function updatePlatformUI() {
  const badge = document.getElementById('platform-badge');
  if (!badge) return;
  const caps = mergedCapabilities();
  if (caps.native) {
    badge.textContent = 'APK';
    badge.classList.remove('hidden', 'pwa', 'web');
  } else if (isStandalone()) {
    badge.textContent = 'PWA';
    badge.classList.remove('hidden', 'web');
    badge.classList.add('pwa');
  } else {
    badge.textContent = '.cl';
    badge.classList.remove('hidden', 'pwa');
    badge.classList.add('web');
  }
}

// ── Sincronización con el servicio de audio nativo (APK) ────────────────────
// En la APK el servicio foreground (con audio focus + notificación de
// control) es el transporte persistente: la WebView le manda base/beat/onda
// y nivel, y él sostiene el sonido aunque la app navegue o la pantalla se
// bloquee. En la web (sin bridge) no se hace nada.
function nativeAudio() {
  // Consulta en vivo: el wrapper window.AndroidBridge se inyecta en
  // onPageFinished, después de que main.js corre. La detección estática
  // (capturada al crear el adaptador) puede ser stale.
  if (typeof window !== 'undefined' && (window.AndroidBridge || window.AndroidBridgeNative)) {
    return nativeBridge;
  }
  return null;
}
// Arranca el servicio nativo con los parámetros actuales de sesión. Envía
// START explícito (no RETUNE): el retune NO arranca el motor (P2 — el
// emulador reveló que delegar aquí en syncNativeAudioRetune dejaba el
// servicio corriendo pero mudo cuando retuneNative=true).
function syncNativeAudioStart() {
  const b = nativeAudio();
  if (!b) return;
  const p = currentParams();
  // P4-D — el nivel viaja en el START: el motor nativo arranca con el volumen
  // del usuario (si llegara después vía SET_AUDIO_LEVEL, el fade-in arrancaría
  // al default 0.6 y haría un overshoot breve audible al pulsar play).
  b.startBackgroundAudio({ base: p.base, beat: p.beat, wave: p.wave, title: selected.name, level: volumeLevel });
  if (b.setAudioLevel) b.setAudioLevel({ level: volumeLevel });
  // La web queda muda: el sonido real lo genera el servicio nativo.
  muteWebForNative();
}

// P5.6 — política de plataforma: en la APK el motor web es PERMANENTEMENTE
// inaudible (el servicio nativo es el único owner de audio). Se aplica al
// init y en cada muteWebForNative(); el motor consulta _platformMuted en
// TODAS sus operaciones de ganancia (start, setCondition, setVolume, fadeTo,
// recoverFade) — frontera estructural, no un parche por función.
function applyPlatformMutePolicy() {
  if (simulation && simulation.audio && typeof simulation.audio.setPlatformMuted === 'function') {
    simulation.audio.setPlatformMuted(!!nativeAudio());
  }
}

// En la APK la web solo dibuja (P5.3): su motor queda mudo y su <audio>
// pausado, para que el SO vea UNA sola MediaSession (la nativa) y no suenen
// dos motores a la vez. Se cancelan las rampas programadas (un gain.value=0
// sin cancelar deja un ramp pendiente que re-eleva el volumen).
function muteWebForNative() {
  // P5.6 — frontera estructural: marca el motor como inaudible por plataforma
  // (ninguna operación de ganancia podrá volverlo audible) y mutea ya.
  if (simulation.audio && typeof simulation.audio.setPlatformMuted === 'function') {
    simulation.audio.setPlatformMuted(true);
  }
  if (simulation.audio && simulation.audio.masterGain) {
    try {
      const g = simulation.audio.masterGain.gain;
      const now = simulation.audio.ctx ? simulation.audio.ctx.currentTime : 0;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
    } catch (_) {
      /* contexto cerrado */
    }
  }
  if (simulation.audio && simulation.audio.transport) {
    try {
      simulation.audio.transport.pause();
    } catch (_) {
      /* elemento no disponible */
    }
  }
}

// P5.2 — protocolo simétrico PLAY/PAUSE/STOP: una reanudación tras pausa
// envía 1 RESUME (nunca un START duplicado con re-solicitud de focus).
function syncNativeAudioResume() {
  const b = nativeAudio();
  if (!b) return;
  if (b.resumeBackgroundAudio) b.resumeBackgroundAudio();
  muteWebForNative();
}

// ¿El servicio nativo está vivo? (para elegir RESUME vs START en la APK).
function nativeServiceRunning() {
  const b = nativeAudio();
  if (!b || typeof b.getAudioState !== 'function') return false;
  const d = parseBridgeResponse(b.getAudioState());
  return !!(d && d.serviceRunning);
}
function syncNativeAudioRetune() {
  const b = nativeAudio();
  if (!b) return;
  // P5.6 (H3) — RETUNE NUNCA significa START: la configuración no puede crear
  // reproducción (violaría la jerarquía de comandos). El retune se envía tal
  // cual; si el servicio no está vivo, el lado nativo lo descarta (guard
  // serviceAlive) y el próximo START lleva los parámetros completos.
  // R2 — coalescido: una ráfaga de cambios de estado/portadora/frecuencia
  // entrega SOLO el último retune al servicio (el fn lee currentParams() en
  // el momento del envío, así que gana el último valor de la ráfaga).
  nativeCmdCoalescer.schedule('retune', () => {
    const nb = nativeAudio();
    if (!nb) return;
    const p = currentParams();
    if (nb.retuneBackgroundAudio) nb.retuneBackgroundAudio({ base: p.base, beat: p.beat, wave: p.wave });
  });
}
function syncNativeAudioStop() {
  const b = nativeAudio();
  // P5.1 — STOP de un servicio inactivo es no-op en la APK: no se crea audio
  // para detenerlo (el estado de la UI ya se alinea con el evento nativo).
  if (b) {
    if (nativeStopCommand({ serviceRunning: nativeServiceRunning() }) === 'stop') b.stopBackgroundAudio();
  } else if (simulation.audio && simulation.audio.masterGain) {
    // Al volver a la web (no-APK) o al pausar, restaura el nivel web. P1 (M1):
    // se cancela la automation pendiente ANTES de fijar el valor — una rampa
    // residual (fade-in del start, recoverFade del watchdog) pisa el valor
    // asignado y puede dejar el motor web audible sobre el nativo.
    const ctx = simulation.audio.ctx;
    restoreMasterGain(simulation.audio.masterGain, volumeLevel, ctx ? ctx.currentTime : 0);
  }
}
// ── P4-B — re-sincronización UI ↔ servicio nativo tras navegar ──────────────
// Navegar dentro de la APK (otra página, back/forward) recarga el JavaScript
// pero NO detiene el audio: el servicio nativo lo sostiene aparte. Sin esto la
// UI volvería a mostrar "Comenzar sesión" con el audio sonando (mentira de
// estado) y un play del usuario re-arrancaría la sesión. Aquí se lee el estado
// REAL (GET_AUDIO_STATE) y, si la sesión nativa sigue en playing, la UI se
// alinea con esos parámetros SIN tocar el servicio (nunca re-START).
// Arranca el motor web MUDO (solo visualizador) sin enviar ningún comando al
// servicio nativo: aplica la sesión y cancela la rampa audible de inmediato.
function startWebVisualizerMuted(base) {
  try {
    applyAudio();
    if (simulation.audio && simulation.audio.masterGain) {
      const g = simulation.audio.masterGain.gain;
      const now = simulation.audio.ctx ? simulation.audio.ctx.currentTime : 0;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
    }
    if (simulation.audio && simulation.audio.transport) {
      simulation.audio.transport.pause();
    }
  } catch (_) {
    /* sin visualizador (pestaña sin gesto previo): el audio nativo sigue */
  }
}

// Lee la sesión nativa y sincroniza la UI. Devuelve true si se alineó.
function syncUiWithNativeSession() {
  const b = nativeAudio();
  if (!b || typeof b.getAudioState !== 'function') return false;
  const data = parseBridgeResponse(b.getAudioState());
  if (!data || !data.serviceRunning || data.playbackState !== 'playing') return false;
  // Alinear la UI a la sesión REAL (frecuencias, onda, volumen).
  const base = typeof data.base === 'number' && data.base > 0 ? data.base : null;
  const beat = typeof data.beat === 'number' && data.beat > 0 ? data.beat : null;
  const wave = typeof data.wave === 'string' && data.wave ? data.wave : null;
  const vol = typeof data.volume === 'number' && data.volume > 0 && data.volume <= 1 ? data.volume : null;
  const customState = STATES.find((s) => s.custom);
  if (base && customState) {
    selectState(customState);
    customBase.value = String(Math.round(base * 10) / 10);
    if (beat) customBeat.value = String(Math.round(beat * 10) / 10);
    if (wave) selectedWave = wave;
    syncWaveButtons();
    syncCarrierChips();
    updateCustomPanel();
    updateCarrierWarning();
    updateCustomLabels();
  }
  if (vol !== null) {
    volumeLevel = vol;
    volume.value = String(vol);
    if (volumeLabel) volumeLabel.textContent = `${Math.round(vol * 100)}%`;
  }
  if (playing) return true;
  // Marcar la sesión como ACTIVA sin re-arrancar el servicio nativo: solo la
  // UI y el visualizador web (mudo). El estado real lo sigue poseyendo el SO.
  playing = true;
  sessionStartTime = Date.now();
  lifecycle.transition('start');
  audioState.transition('system_play', { reason: 'page-reload-sync' });
  // R1 — tras el resync con sesión nativa activa, la máquina debe llegar a
  // PLAYING igual que en start() y en el evento vyneural:audioplayback:
  // sin esto la UI quedaba en INITIALIZING para siempre (forense R1).
  audioState.transition('started', { reason: 'engine-running' });
  sessionLog.reset();
  sessionLog.start({
    state: selected.name,
    band: selected.band,
    base: currentParams().base,
    beat: currentParams().beat,
    wave: selectedWave,
    condition: EXP_CONDITION_TO_SESSION[expCondition] || 'BINAURAL',
  });
  playBtn.classList.add('playing');
  playBtn.innerHTML = ICONS.pause;
  playBtn.setAttribute('aria-label', 'Pausar sesión');
  updateStatus();
  armTimer();
  saveSession();
  // P4-B — el proveedor REAL de la sesión restaurada es el servicio nativo:
  // la UI no debe declarar 'none' con audio sonando (mentira de estado).
  setAudioProvider('native');
  startWebVisualizerMuted(base);
  ilog('playback', 'ui-resynced-from-native');
  return true;
}

// Capacidades fusionadas (web + nativo) para la UI de permisos y diagnóstico.
function mergedCapabilities() {
  return mergePlatformCapabilities({
    web: probeCapabilities({
      notificationSupported: notificationSupported(),
      notificationPermission: notificationSupported() ? Notification.permission : null,
      mediaSessionSupported: MEDIA_SESSION != null,
      mediaSessionActive: playing,
      wakeLockSupported: 'wakeLock' in navigator,
      wakeLockActive: !!(_wakeLock && !_wakeLock.released),
      pushSupported: 'PushManager' in window && 'serviceWorker' in navigator,
      // Estado REAL del backend (consultado en initBackendIfConfigured): sin
      // sesión o sin consulta todavía, configured=false — la API exista no
      // basta (notification-capabilities.js).
      pushConfigured: !!(getCachedPushStatus() && getCachedPushStatus().configured),
      iosNeedsInstall: iosNeedsInstall(),
    }),
    native: nativeBridge.getState(),
    // Entorno real: el UA clasifica (desktop/ios/android-browser), pero las
    // capacidades nativas SOLO las concede el handshake del bridge (§8).
    env: { ua: navigator.userAgent, bridgePresent: nativeBridge.present },
  });
}

// ── Monitor de ciclo de vida e integridad de sesión (P5/P19/P20) ────────────
// El estado del ciclo de vida lo decide la máquina pura AppLifecycle a partir
// de eventos reales (visibilitychange + ctx.onstatechange), nunca de
// suposiciones sobre la pestaña. El registro de eventos guarda cada cambio
// con su audioTime para reconstruir la sesión y calcular su integridad.
const lifecycle = new AppLifecycle();
// P2 Fase 1 — el audio tiene su PROPIO estado, independiente de la UI: ningún
// evento visual (menú, scroll, HUD, diagnóstico, pestañas) puede transicionarlo.
const audioState = new AudioStateMachine();
const sessionLog = new ExperimentEventLog({
  audioTime: () => (simulation.audio.ctx ? simulation.audio.ctx.currentTime : 0),
});
window.__lifecycle = lifecycle;
window.__audioState = audioState;
window.__sessionLog = sessionLog;
// Hook de diagnóstico (solo lectura): estado real del motor para CI y para
// verificación en dispositivo (conteo de osciladores, contexto, RMS,
// transporte y elemento).
window.__audioProbe = () => ({
  ctx: simulation.audio.ctx,
  stats: simulation.audio.getAudioStats(),
  transport: simulation.audio.transport ? simulation.audio.transport.getState() : null,
});

// ── Instrumentación en vivo (HUD + /diagnostico) ───────────────────────────
// Registro de interferencias de audio/plataforma (ctx, visibilidad, foco
// nativo, wake lock, media session, fullscreen) y métricas de rendimiento
// del bucle de dibujo. Se exponen en window.__interferenceLog / window.__perf
// y alimentan el HUD de la home (tecla D) y la página /diagnostico.
const __interferenceLog = [];
const __MAX_ILOG = 40;
function ilog(kind, detail) {
  __interferenceLog.push({
    kind,
    detail,
    at: Date.now(),
    audioTime: simulation.audio.ctx ? +simulation.audio.ctx.currentTime.toFixed(2) : 0,
  });
  if (__interferenceLog.length > __MAX_ILOG) __interferenceLog.shift();
}
window.__interferenceLog = __interferenceLog;
window.__interferenceLogPush = ilog;
// P5.4 — instrumentación causal: cada acción de reproducción queda en un
// anillo con timestamp/source/estados (espejo del anillo nativo
// Diagnostics.trace) para responder "¿qué componente emitió el primer PLAY?"
// si reaparece la reproducción fantasma.
const causalLog = createCausalLog();
window.__causalLog = causalLog;
function traceCausal(action, source = '', extra = {}) {
  return causalLog.push({
    action,
    source,
    from: audioState ? audioState.state : null,
    playing,
    provider: audioProvider,
    native: !!nativeAudio(),
    ...extra,
  });
}
window.__traceCausal = traceCausal;
// Evento nativo (APK): cambios de audio focus del shell (llamada, otro audio…).
window.addEventListener('vyneural:audiofocus', (e) => {
  const label = e.detail && e.detail.state ? e.detail.state : 'event';
  ilog('focus', label);
  traceCausal('NATIVE_FOCUS_EVENT', label);
  if (label === 'GAIN') audioState.transition('focus_gain', { reason: 'audio-focus' });
  else if (label === 'DUCK') audioState.transition('focus_duck', { reason: 'audio-focus' });
  else if (label === 'LOSS_TRANSIENT' || label === 'LOSS') {
    audioState.transition('focus_loss', { reason: label.toLowerCase() });
  } else if (label === 'UNKNOWN') {
    // P2 — UNKNOWN es un estado EXPLÍCITO y visible (nunca pérdida genérica
    // silenciosa): interrupción defensiva; la APK aplica pausa + watchdog.
    audioState.transition('focus_loss', { reason: 'unknown-focus' });
  }
});
// Evento nativo (APK): cambios de reproducción desde los controles del SO
// (lock screen, notificación, Bluetooth). La UI de la WebView NUNCA inventa
// estado: se sincroniza con lo que el servicio nativo realmente hizo.
window.addEventListener('vyneural:audioplayback', (e) => {
  const state = e.detail && e.detail.state ? e.detail.state : 'event';
  ilog('playback', state);
  traceCausal('NATIVE_PLAYBACK_EVENT', state);
  if (state === 'paused' && playing) pauseUiOnly();
  else if (state === 'stopped') {
    audioState.transition('system_stop', { reason: 'lock-screen' });
    if (playing) stop(false);
  } else if (state === 'playing') {
    audioState.transition('system_play', { reason: 'lock-screen' });
    audioState.transition('started', { reason: 'engine-running' });
    if (!playing) resumeSession('lock-screen');
  }
});
// Evento nativo (APK): adelantar/retroceder la frecuencia desde los controles
// del SO (skip/seek de la MediaSession). El motor NATIVO ya retuneó; la UI de
// la WebView se re-sincroniza (nunca inventa estado, nunca re-arranca audio).
window.addEventListener('vyneural:audiofreq', (e) => {
  const d = (e.detail || {});
  const base = typeof d.base === 'number' && d.base >= 60 && d.base <= 400 ? d.base : null;
  const beat = typeof d.beat === 'number' && d.beat >= 0 && d.beat <= 499 ? d.beat : null;
  if (base == null) return;
  ilog('audiofreq', `native→${base}Hz/${beat}`);
  traceCausal('NATIVE_FREQ_EVENT', `${base}/${beat}`);
  const customState = STATES.find((s) => s.custom);
  if (!customState) return;
  selectState(customState);
  carrier = 'personalizado';
  syncCarrierChips();
  updateCustomPanel();
  customBase.value = String(Math.round(base * 10) / 10);
  if (beat != null) customBeat.value = String(Math.round(beat * 10) / 10);
  updateCustomLabels();
  updateStatus();
  updateCarrierWarning();
  // Solo el proveedor WEB retunea (el nativo ya lo hizo): si el motor web
  // está sonando, se re-afina en vivo sin cortar la sesión.
  if (playing && providerLabel() === 'WEB') simulation.audio.retune(currentParams());
  saveSession();
  updateUrl();
});
document.addEventListener('fullscreenchange', () => {
  ilog('fullscreen', document.fullscreenElement ? 'enter' : 'exit');
});

// ── Guardia UI → audio (P2 Fase 9) ──────────────────────────────────────────
// Instrumenta TODOS los caminos de interacción (click, scroll, orientación,
// resize, apertura de menú/HUD/modal) y verifica que NINGUNO cambie el estado
// de audio salvo los controles explícitos de audio. Si un evento UI detuviera
// la sesión (el bug histórico "el audio se corta al interactuar"), queda
// registrado con event/ts/before/after en __uiAudioGuard y se marca WARN —
// nunca se aplica un workaround sin ver la causa.
const __uiAudioGuard = [];
window.__uiAudioGuard = __uiAudioGuard;
// Controles que SÍ pueden modificar el audio por diseño.
const AUDIO_CONTROL_HINTS = [
  'play-btn',
  'volume',
  'custom-base',
  'custom-beat',
  'carrier-options',
  'wave-options',
  'custom-wave-options',
  'viz-switch',
  'timer-options',
  'ambient-options',
  'ambient-volumes',
  'exp-condition',
  'exp-run',
];
function guardUiEvent(kind, target) {
  // Sin sesión activa no hay nada que proteger.
  if (audioState.state === 'IDLE' || audioState.state === 'STOPPED' || audioState.state === 'ERROR') return;
  const before = audioState.state;
  const el = target && target.nodeType === 1 ? target.closest('button,input,select,[id]') : null;
  const id = el ? String(el.id || el.className || el.tagName || '') : '';
  const expected = AUDIO_CONTROL_HINTS.some((c) => id.includes(c));
  // El estado se lee tras el tick del evento (los handlers ya corrieron).
  setTimeout(() => {
    const after = audioState.state;
    const changed = before !== after;
    __uiAudioGuard.push({ kind, ts: Date.now(), id: id || null, before, after, changed, expected });
    if (__uiAudioGuard.length > 60) __uiAudioGuard.shift();
    if (changed) {
      ilog('ui-guard', `${kind}:${id || '?'}:${before}→${after}`);
      if (!expected) {
        console.warn('[vyneural] ¡evento UI cambió el estado de audio!', { kind, id, before, after });
      }
    }
  }, 80);
}
document.addEventListener('click', (e) => guardUiEvent('click', e.target), true);
document.addEventListener('pointerdown', (e) => guardUiEvent('touch', e.target), true);
document.addEventListener('scroll', (e) => guardUiEvent('scroll', e.target), { capture: true, passive: true });
window.addEventListener('orientationchange', () => guardUiEvent('orientation', null));
let _resizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeT);
  _resizeT = setTimeout(() => guardUiEvent('resize', null), 200);
});

// Métricas del bucle de dibujo (EMA) + memoria del heap JS.
const __perf = { fps: 0, frameMs: 0, emaFrameMs: 0, lastT: performance.now(), memoryMB: 0 };
window.__perf = __perf;
function perfTick() {
  const now = performance.now();
  const dt = now - __perf.lastT;
  __perf.lastT = now;
  __perf.frameMs = dt;
  __perf.emaFrameMs = __perf.emaFrameMs ? __perf.emaFrameMs * 0.9 + dt * 0.1 : dt;
  __perf.fps = __perf.emaFrameMs > 0 ? 1000 / __perf.emaFrameMs : 0;
  if (performance.memory) __perf.memoryMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
}
// Estado real del AudioContext como fuente de verdad: iOS al bloquear y la
// pérdida de audio focus suspenden el contexto sin disparar visibilitychange.
simulation.audio.onCtxStateChange = (state) => {
  ilog('ctx', state);
  lifecycle.transition('ctx', { ctxState: state, visible: !document.hidden, playing });
  if (state === 'suspended') {
    sessionLog.suspend({ reason: 'ctx-suspended' });
  } else if (state === 'running') {
    // Si estábamos volviendo (RETURNING), completar la transición real.
    if (lifecycle.state === 'RETURNING') lifecycle.transition('resume', { resumeOk: true });
    sessionLog.recover({ reason: 'ctx-running' });
  }
};

// ---------------------------------------------------------------- Iconos SVG
// Reemplazan a los emojis: iconos de trazo (estilo Lucide) que heredan el
// color del texto (currentColor) y escalan con el tamaño de fuente (.ico).
function icon(paths) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
const ICONS = {
  meditacion: icon('<circle cx="12" cy="4.5" r="2.5"/><path d="M12 7.5c-2.2 0-3.8 1.5-3.8 3.4 0 1.4.5 2.3 1.3 2.8L8 18.5h8l-1.5-4.8c.8-.5 1.3-1.4 1.3-2.8 0-1.9-1.6-3.4-3.8-3.4z"/><path d="M8.5 18.5 6 21M15.5 18.5 18 21"/>'),
  sueno: icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  relajacion: icon('<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>'),
  concentracion: icon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>'),
  energia: icon('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
  creatividad: icon('<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/><path d="M19 3v4M17 5h4"/>'),
  aprendizaje: icon('<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12.5V17c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/><path d="M22 10v5"/>'),
  schumann: icon('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  'sueno-ligero': icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/><path d="M18 2.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'),
  profundidad: icon('<path d="M12 3v13"/><path d="m6.5 11.5 5.5 5.5 5.5-5.5"/><path d="M5 21h14"/>'),
  calma: icon('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'),
  intuicion: icon('<path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>'),
  lucidez: icon('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>'),
  alerta: icon('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  memoria: icon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  armonia: icon('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
  despertar: icon('<path d="M12 2v8"/><path d="m8 6 4-4 4 4"/><path d="m4.93 10.93 1.41 1.41"/><path d="m19.07 10.93-1.41 1.41"/><path d="M16 18a4 4 0 0 0-8 0"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="M22 22H2"/>'),
  foco: icon('<circle cx="12" cy="12" r="9"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>'),
  renovacion: icon('<path d="M7 20h10"/><path d="M12 20v-8"/><path d="M12 12C12 8.5 9.5 6.5 5.5 6.5c0 3.5 2.5 5.5 6.5 5.5z"/><path d="M12 9c0-2.5-1.5-4.5-4.5-5 0 2.5 1.5 4.5 4.5 5z"/>'),
  silencio: icon('<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>'),
  vitalidad: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
  vision: icon('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  'gamma-60': icon('<path d="M2 12h4l3-8 4 16 3-8h6"/>'),
  'gamma-100': icon('<path d="M2 12h3l2-6 4 12 3-10 2 4h6"/>'),
  estudio: icon('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  paz: icon('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>'),
  equilibrio: icon('<path d="M12 4v17"/><path d="M8 21h8"/><path d="M4 7h16"/><path d="M4 7a3 3 0 0 0 6 0"/><path d="M14 7a3 3 0 0 0 6 0"/>'),
  gateway: icon('<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>'),
  hemisync: icon('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
  'solfeggio963': icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>'),
  personalizado: icon('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>'),
  // Iconos de la interfaz
  headphones: icon('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
  music: icon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  sparkle: icon('<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>'),
  grid: icon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'),
  volume: icon('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  clock: icon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  history: icon('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
  leaf: icon('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'),
  droplet: icon('<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>'),
  tree: icon('<path d="M12 2l-4.5 8h3L6 18h12l-4.5-8h3z"/><path d="M12 18v3"/>'),
  bird: icon('<path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/>'),
  sliders: icon('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>'),
  alert: icon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  heart: icon('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
  play: icon('<polygon points="6 3 20 12 6 21 6 3"/>'),
  pause: icon('<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'),
  star: icon('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>'),
  share: icon('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>'),
  alarm: icon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  expand: icon('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  compress: icon('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>'),
};

// Inject icons from ICONS into each PROFILE so the card renderer has `profile.icon`
PROFILES.forEach(p => { p.icon = ICONS[p.iconKey] || ''; });
const STATES = PROFILES;

// ---------------------------------------------------------------- DOM
const grid = document.getElementById('states-grid');
const goalFilter = document.getElementById('goal-filter');
const playBtn = document.getElementById('play-btn');
const volume = document.getElementById('volume');
const volumeLabel = document.getElementById('volume-label');
const timerOptions = document.getElementById('timer-options');
const timerDisplay = document.getElementById('timer-display');
const ambientOptions = document.getElementById('ambient-options');
const customPanel = document.getElementById('custom-panel');
const customBase = document.getElementById('custom-base');
const customBaseLabel = document.getElementById('custom-base-label');
const customBeat = document.getElementById('custom-beat');
const customBeatLabel = document.getElementById('custom-beat-label');
const waveOptions = document.getElementById('wave-options');
const customWaveOptions = document.getElementById('custom-wave-options');
const statusName = document.getElementById('status-name');
const statusFreqs = document.getElementById('status-freqs');
const statusState = document.getElementById('status-state');
const legendLeft = document.getElementById('legend-left');
const legendRight = document.getElementById('legend-right');
const legendBeat = document.getElementById('legend-beat');
const canvas = document.getElementById('visualizer');
const ctx2d = canvas.getContext('2d');

// ---------------------------------------------------------------- Estado de la app
let selected = STATES[0];
let playing = false;
let volumeLevel = 0.6;
let timerMinutes = 0;
let timerEnd = 0;
let timerInterval = null;
// Remanente del temporizador congelado al pausar (lock screen / API): un play
// posterior reanuda la cuenta donde quedó, como YouTube, en vez de reiniciar.
let pausedRemainingMs = null;
let lastPulse = 0;
let accentColor = STATES[0].color;
let sessionStartTime = 0;
let sessionAmbient = []; // ambientes activos al iniciar la sesión (para el resumen)
let fading = false;
// Colores del visualizador (se inicializan aquí para que estén disponibles
// desde el arranque; selectState los actualiza al elegir estado).
let LANE_LEFT_COLOR = '#60a5fa';
let LANE_RIGHT_COLOR = '#f472b6';
let LANE_LEFT_COLOR_RGB = [96, 165, 250];
let LANE_RIGHT_COLOR_RGB = [244, 114, 182];
let ACCENT_RGB = [167, 139, 250];

// ---------------------------------------------------------------- Persistencia local
// Todo queda en localStorage (sin servidores ni cuentas): la sesión (último
// estado, volumen, ambientes y temporizador), los favoritos y el historial
// de sesiones.
const LS_SESSION = 'ob-session-v1';
const LS_FAVS = 'ob-favs-v1';
const LS_HISTORY = 'ob-history-v1';
// Visualizador elegido: 'gotas' (simulación de ondas actual) o 'cimatica'
// (placa circular con gotas de Faraday). Persistente entre visitas.
const LS_VIZ = 'ob-viz-v1';

function lsGet(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}
function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (_) {
    /* almacenamiento no disponible */
  }
}

// ---------------------------------------------------------------- Portadora
// La portadora (f1) es ortogonal al estado: el estado define el Δf (latido)
// y la portadora define la frecuencia base. Así cualquier combinación es
// posible (p. ej. Beta + 136,1 Hz) sin multiplicar los presets fijos.
// CARRIER_BASE/scaleCarrier viven en core/carrier.js — compartidos con el
// panel "Personalizar" de itinerarios (rutina.js) para que ambos escalen
// exactamente igual.
const LS_CARRIER = 'ob-carrier-v1';
let carrier = lsGet(LS_CARRIER, 'estandar');
if (!(carrier in CARRIER_BASE)) carrier = 'estandar';
const carrierOptions = document.getElementById('carrier-options');
const carrierWarning = document.getElementById('carrier-warning');

let favorites = new Set(sanitizeFavorites(lsGet(LS_FAVS, [])));

// ---------------------------------------------------------------- Tarjetas
// Los estados se organizan por objetivo (Dormir, Meditar, Relajarse…):
// enfoque de usuario en vez de bandas técnicas, con encabezado por grupo.
const GOALS = [
  { id: 'dormir', label: 'Dormir', emoji: '😴', stateIds: ['sueno', 'sueno-ligero', 'profundidad', 'renovacion'], tagline: 'Descanso profundo' },
  { id: 'meditar', label: 'Meditar', emoji: '🧘', stateIds: ['meditacion', 'intuicion', 'silencio', 'paz', 'equilibrio', 'gateway', 'hemisync'], tagline: 'Calma y conexión' },
  { id: 'relajarse', label: 'Relajarse', emoji: '🌿', stateIds: ['relajacion', 'calma', 'armonia', 'despertar'], tagline: 'Suelta el estrés' },
  { id: 'concentrarse', label: 'Concentrarse', emoji: '🧠', stateIds: ['concentracion', 'energia', 'creatividad', 'lucidez', 'alerta', 'foco', 'vitalidad', 'estudio'], tagline: 'Foco y productividad' },
  { id: 'aprender', label: 'Aprender', emoji: '📚', stateIds: ['aprendizaje', 'memoria', 'vision', 'gamma-60', 'gamma-100'], tagline: 'Memoria y retención' },
  { id: 'especiales', label: 'Especiales', emoji: '✨', stateIds: ['schumann', 'schumann-armonico', 'solfeggio963', 'personalizado'], tagline: 'Resonancias únicas y a tu medida' },
];
const goalOf = (s) => GOALS.find((g) => g.stateIds.includes(s.id)) || GOALS[1];

// Construye la rejilla en grupos (sección con encabezado + sub-rejilla).
const groups = GOALS.map((goal) => {
  const section = document.createElement('section');
  section.className = 'state-group';
  section.dataset.goal = goal.id;
  section.innerHTML = `<h3 class="state-group-title"><span class="sgt-emoji">${goal.emoji}</span><span class="sgt-name">${goal.label}</span><span class="sgt-tagline">${goal.tagline}</span></h3>`;
  const sub = document.createElement('div');
  sub.className = 'grid';
  section.appendChild(sub);
  grid.appendChild(section);
  return { goal, section, sub };
});

const cards = STATES.map((s) => {
  const card = document.createElement('button');
  card.className = 'card';
  card.dataset.id = s.id;
  const fav = favorites.has(s.id);
  // Las dos frecuencias del estado: una por oído (base y base + latido).
  const f1 = Math.round(s.base * 10) / 10;
  const f2 = Math.round((s.base + s.beat) * 10) / 10;
  card.innerHTML = `
    <span class="card-star${fav ? ' fav' : ''}" role="button" tabindex="0" aria-label="Marcar ${s.name} como favorito" aria-pressed="${fav}">${ICONS.star}</span>
    <span class="card-icon" style="color:${s.color}">${s.icon}</span>
    <span class="card-name">${s.name}</span>
    <span class="card-band">${s.band}</span>
    <span class="card-freqs">${f1} Hz · ${f2} Hz</span>
    <span class="card-desc">${s.desc}</span>
  `;
  card.addEventListener('click', () => selectState(s));
  const star = card.querySelector('.card-star');
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(s, star);
  });
  star.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(s, star);
    }
  });
  groups.find((g) => g.goal.id === goalOf(s).id).sub.appendChild(card);
  return card;
});

// Marca o desmarca un estado como favorito (persistente en localStorage).
function toggleFav(state, starEl) {
  if (favorites.has(state.id)) favorites.delete(state.id);
  else favorites.add(state.id);
  lsSet(LS_FAVS, [...favorites]);
  // Espejo en la nube (aditivo, nunca bloquea): si hay sesión, el favorito
  // viaja al backend y aparece en /cuenta y en otros dispositivos.
  const nowFav = favorites.has(state.id);
  if (nowFav) {
    syncFavoriteToCloud({
      stateId: state.id,
      name: state.name,
      base: state.base,
      beat: state.beat,
      band: state.band,
      wave: typeof selectedWave === 'string' ? selectedWave : 'sine',
    }).catch(() => {});
  } else {
    syncUnfavoriteFromCloud(state.id).catch(() => {});
  }
  if (starEl) {
    starEl.classList.toggle('fav', favorites.has(state.id));
    starEl.setAttribute('aria-pressed', String(favorites.has(state.id)));
  }
  // Si estamos filtrando por favoritos, actualizar la rejilla al momento.
  const activeChip = goalFilter.querySelector('.band-chip.active');
  if (activeChip && activeChip.dataset.goal === 'favs') applyGoalFilter('favs');
}

// Guarda la sesión actual (último estado, volumen, ambientes, temporizador,
// forma de onda, valores personalizados y filtro) para recuperarla al volver
// a la página. Se llama en cada cambio y también antes de cerrar la pestaña.
function saveSession() {
  const layerVolumes = {};
  document.querySelectorAll('#ambient-volumes input').forEach((i) => {
    layerVolumes[i.dataset.type] = parseFloat(i.value);
  });
  const activeChip = goalFilter ? goalFilter.querySelector('.band-chip.active') : null;
  lsSet(LS_SESSION, {
    state: selected.id,
    volume: volumeLevel,
    ambient: [...ambientTypes],
    ambientVolume: ambientVolumeLevel,
    layerVolumes,
    timer: timerMinutes,
    wave: selectedWave,
    // Valores del panel personalizado: sin esto, la base y el ritmo
    // personalizados se perdían al recargar.
    custom: {
      base: parseFloat(customBase ? customBase.value : NaN),
      beat: parseFloat(customBeat ? customBeat.value : NaN),
    },
    // Filtro activo de la rejilla (Dormir, Meditar, Favoritos…).
    goal: activeChip ? activeChip.dataset.goal : 'destacados',
  });
}

// Persiste el último estado también al cerrar u ocultar la pestaña, para no
// perder los cambios hechos justo antes de irse (aunque el navegador cierre).
window.addEventListener('beforeunload', saveSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
  // P2 Fase 1: el fondo/foreground ES un evento de audio (la WebView se
  // pausa), pero no detiene la sesión: PLAYING → BACKGROUND (sigue sonando).
  if (document.visibilityState === 'hidden') {
    audioState.transition('app_background', { reason: 'visibility' });
  } else {
    audioState.transition('app_foreground', { reason: 'visibility' });
  }
});

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Mezcla dos colores hex (t = 0 → a, t = 1 → b).
function mixHex(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const c = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function selectState(state) {
  selected = state;
  // El estado Personalizado usa su propia portadora (el slider de base).
  if (state.custom && carrier !== 'personalizado') {
    carrier = 'personalizado';
    syncCarrierChips();
  }
  cards.forEach((c) => c.classList.toggle('selected', c.dataset.id === state.id));
  accentColor = state.color;
  ACCENT_RGB = hexToRgb(state.color);
  document.documentElement.style.setProperty('--accent', state.color);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(state.color, 0.16));
  // Las tres gotas adoptan la paleta del estado: frecuencia 1 se tiñe hacia
  // azul, frecuencia 2 hacia rosa, y el cerebro usa el color del estado.
  // Así cada frecuencia se ve distinta en las gotas al cambiar de estado.
  LANE_LEFT_COLOR = mixHex(state.color, '#60a5fa', 0.5);
  LANE_RIGHT_COLOR = mixHex(state.color, '#f472b6', 0.5);
  LANE_LEFT_COLOR_RGB = hexToRgb(LANE_LEFT_COLOR);
  LANE_RIGHT_COLOR_RGB = hexToRgb(LANE_RIGHT_COLOR);
  updateCustomPanel();
  updateStatus();
  updateCarrierWarning();
  
  // Set the profile on the simulation engine
  simulation.setProfile(state, currentParams().base);

  // P5.6 (H1) — en la APK el estado seleccionado también retunea el motor
  // NATIVO en vivo: antes solo cambiaba la UI y el sonido seguía en el estado
  // anterior hasta el próximo START (divergencia UI↔nativo).
  if (playing) syncNativeAudioRetune();

  // Registro de eventos: el cambio de estímulo queda documentado (P19), solo
  // durante una sesión activa (seleccionar estados sin sesión es ruido).
  if (playing) {
    sessionLog.note('stimulusChanged', {
      state: state.name,
      band: state.band,
      base: currentParams().base,
      beat: currentParams().beat,
    });
  }
  
  if (playing) {
    applyAmbient();
  }
  saveSession();
  updateUrl();
}

// ---------------------------------------------------------------- Audio
function currentParams() {
  // El estado Personalizado también pasa por carrierBaseFor (core/carrier.js):
  // la propia base dialada es su "base propia" a escalar, así que elegir una
  // familia de portadora (Solfeggio/Ancestral/Schumann/Estándar 220) SÍ
  // retona lo que armaste a mano, igual que con cualquier preset — antes el
  // slider era la única fuente de verdad y los chips de portadora quedaban
  // muertos (marcaban "activo" pero no afectaban el sonido) en este estado.
  // El resto delega igual en carrierBaseFor, que hace el mismo escalado
  // proporcional para las familias fijas (solfeggio/solfeggio963/ancestral)
  // y los casos literales (schumann/estandar220/personalizado).
  const base = selected.custom
    ? carrierBaseFor(carrier, parseFloat(customBase.value), parseFloat(customBase.value))
    : carrierBaseFor(carrier, selected.base, parseFloat(customBase.value));
  const beat = selected.custom ? parseFloat(customBeat.value) : (selected.stimulus ? selected.stimulus.beat : 10);
  const wave = selectedWave;
  return { base, beat, wave, volume: volumeLevel };
}

function applyAudio() {
  simulation.start(currentParams().base);
  // P5 — la onda elegida se re-afirma SIEMPRE tras el arranque: el motor
  // (core) arranca con la onda del perfil del estado ('sine' en Personalizado)
  // y aquí se aplica la onda que eligió el usuario (bug: custom + onda ≠ sine).
  // setWave muta el tipo del oscilador en vivo, sin cortar el sonido.
  simulation.audio.setWave(selectedWave);
  // Aplica el volumen del slider a la sesión: el motor arranca con un valor
  // por defecto y aquí se re-afirma el nivel real elegido por el usuario.
  simulation.setVolume(volumeLevel);
  applyAmbient();
}

function applyAmbient() {
  if (!playing) return;
  ambient.attach(simulation.audio.ctx, simulation.audio.masterGain);
  ambient.syncToEngine(simulation.audio);
  ambient.setVolume(ambientVolumeLevel);
  // Las capas activas coinciden con los botones elegidos y la respiración
  // queda alineada a la fase del latido (mismo reloj que las ondas).
  ambient.applySet(ambientTypes, currentParams().beat, simulation.audio.getBeatEpoch());
}

// Arranca la sesión (nueva o reanudada desde una pausa). Con resume=true la
// sesión y su registro continúan: no se reinicia el temporizador, el reloj de
// pared ni el log experimental (el play posterior a una pausa de lock screen
// retoma la MISMA sesión, como YouTube — no empieza una nueva).
function start({ resume = false, source = 'ui-play' } = {}) {
  // La condición experimental elegida se aplica a la sesión nueva (el motor
  // la lee al construir sus fuentes; en vivo setExpCondition la reconstruye).
  if (simulation && simulation.audio) simulation.audio.setCondition(expCondition);
  // `playing` se marca antes de applyAudio(): applyAmbient() depende de él
  // para crear las capas de ambiente al arrancar la sesión.
  playing = true;
  // `resume` NO alcanza para distinguir "sesión nueva" de "reanudar una
  // pausa": resumeSession() (el botón play normal, tanto el primer play de
  // la sesión como cualquier reanudación real) SIEMPRE llama
  // start({resume:true}) — solo el quickstart de bienvenida (LS_QUICK, una
  // vez por navegador) llama start() con resume:false. `freshSession` es la
  // señal correcta: sessionStartTime en 0 significa que no hay una sesión
  // en curso de verdad, sea cual sea el valor de `resume`. Sin esto,
  // sessionStartTime/sessionAmbient/sessionLog nunca se inicializaban fuera
  // del quickstart — recordHistory() no registraba NINGUNA sesión para un
  // usuario recurrente (bug real, confirmado con un play/stop de prueba: el
  // historial quedaba vacío), el resumen de sesión mostraba "Ninguno" de
  // ambiente aunque hubiera sonido de fondo, y sessionLog.integrityText()
  // (el % de continuidad honesto) siempre devolvía null. Una pausa→resume
  // real conserva sessionStartTime (no entra acá, ya es != 0) — la duración
  // y el ambiente siguen midiéndose desde el arranque original, como
  // corresponde. `resume` sigue intacto para todo lo demás (transición de
  // audioState, comando nativo START/RESUME): eso ya se resuelve aparte por
  // si el servicio nativo está corriendo.
  const freshSession = !resume || !sessionStartTime;
  if (freshSession) {
    sessionStartTime = Date.now();
    sessionAmbient = [...ambientTypes];
  }
  const p0 = currentParams();
  const prevState = audioState.state;
  lifecycle.transition('start');
  const tr = audioState.transition(resume ? 'system_play' : 'user_play', { reason: source });
  traceCausal(resume ? 'RESUME' : 'PLAY', source, { from: prevState, to: tr ? tr.to : audioState.state, resume });
  if (freshSession) {
    // Sesión nueva = registro nuevo: si la sesión anterior terminó, se
    // descarta (start() solo se llama desde el estado detenido).
    sessionLog.reset();
    sessionLog.start({
      state: selected.name,
      band: selected.band,
      base: p0.base,
      beat: p0.beat,
      wave: p0.wave,
      condition: EXP_CONDITION_TO_SESSION[expCondition] || 'BINAURAL',
    });
  } else {
    // Continuar la sesión pausada: el log conserva la duración acumulada.
    sessionLog.resume({ source });
  }
  // Reclama la Media Session ANTES de que suene el audio: el navegador
  // asocia el controlador de notificaciones a la sesión en marcha y algunos
  // Android solo lo muestran si el metadata ya estaba asignado al empezar.
  updateMediaSession();
  applyAudio();
  // P2 Fase 1 (web): el motor ya arrancó de forma síncrona dentro de este
  // gesto — transicionar a PLAYING. Antes solo el evento nativo de la APK
  // (vyneural:audioplayback) disparaba 'started', así que en la web la máquina
  // quedaba en INITIALIZING para siempre (el HUD y /diagnostico mentían). En
  // la APK es idempotente: PLAYING no acepta 'started' y se ignora.
  audioState.transition('started', { reason: 'engine-running' });
  // APK: protocolo simétrico (P5.2, contrato puro native-protocol.js) — sesión
  // nueva = 1 START; reanudación tras pausa = 1 RESUME (nunca un START
  // duplicado); reanudación del lock screen = 0 comandos (el nativo ya
  // reanudó, la web solo sincroniza).
  const nb = nativeAudio();
  if (nb) {
    const cmd = nativePlayCommand({ resume, source, serviceRunning: nativeServiceRunning() });
    if (cmd === 'resume') syncNativeAudioResume();
    else if (cmd === 'start') syncNativeAudioStart();
    else muteWebForNative();
  } else {
    // Ancla de medios: registra la pestaña como reproducción ante el SO para
    // que el controlador del reproductor aparezca y el AudioContext no se
    // suspenda al cambiar de app o bloquear la pantalla (mismo gesto de
    // usuario que play). En la APK NO se usa: la MediaSession la posee el
    // servicio nativo (P5.3 — la WebView solo dibuja).
    startAnchor();
  }
  setAudioProvider(nb ? 'native' : 'web');
  playBtn.classList.add('playing');
  playBtn.innerHTML = ICONS.pause;
  playBtn.setAttribute('aria-label', 'Pausar sesión');
  updateStatus();
  armTimer();
  // Rutina secuencial: el countdown del paso actual corre solo con play
  // (reanuda donde quedó tras una pausa; nunca arranca sin gesto).
  if (seq) armSeqTimer();
  saveSession();
  // Permisos: notificaciones + WakeLock en el mismo gesto del usuario (play).
  // WakeLock impide que el SO interrumpa el audio al bloquear la pantalla.
  requestMediaNotificationPermission();
  // WakeLock ya se adquiere dentro de requestMediaNotificationPermission → requestAllPermissions.
  // En iPhone el controlador del reproductor solo aparece si la PWA está
  // instalada; se avisa una sola vez para que el usuario lo sepa.
  if (iosNeedsInstall() && !lsGet('vyneural_ios_hint', false)) {
    lsSet('vyneural_ios_hint', true);
    showToast('💡 Para controlar el reproductor desde la pantalla de bloqueo, instala Bineural: Compartir → Añadir a pantalla de inicio.');
  }
}

// stop(withSummary): el resumen se muestra cuando la sesión termina por el
// temporizador (endSession), no al pausar manualmente.
// ---- Ancla de medios --------------------------------------------------------
// Elemento <audio> mudo en bucle que registra la pestaña como reproducción de
// medios ante el SO: en Android hace que Chrome muestre el controlador del
// reproductor en las notificaciones y NO suspenda el AudioContext al cambiar
// de app (evita la interferencia al moverse por el celular); en iOS (PWA
// instalada) habilita los controles en la pantalla de bloqueo. El sonido real
// sigue saliendo por el AudioContext; el ancla es silencio.
let audioAnchor = null;
function startAnchor() {
  // Fallback legacy SOLO para el transporte 'direct' (iOS): cuando el audio
  // real sale por ctx.destination no hay elemento que reclame la MediaSession,
  // así que el ancla muda lo hace. En modo 'element' el propio <audio> real
  // es la reproducción: añadir un ancla sería duplicar la vía de medios.
  const transport = simulation.audio.transport;
  if (transport && transport.mode === 'element') return;
  if (!audioAnchor) {
    try {
      audioAnchor = createSilentAudio(); // pista larga (ANCHOR_SECONDS=8 s)
      // Adjunto al DOM (oculto) por robustez: algunos navegadores exigen que
      // el elemento esté en el documento para reproducir de forma fiable.
      audioAnchor.style.display = 'none';
      audioAnchor.setAttribute('aria-hidden', 'true');
      audioAnchor.setAttribute('tabindex', '-1');
      document.body.appendChild(audioAnchor);
    } catch (_) {
      audioAnchor = null;
    }
  }
  if (!audioAnchor) return;
  const p = audioAnchor.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}
function stopAnchor() {
  if (audioAnchor) {
    try {
      audioAnchor.pause();
    } catch (_) {
      /* sin ancla */
    }
  }
}

function stop(withSummary) {
  traceCausal('STOP', withSummary ? 'timer-complete' : 'user-stop', {
    from: audioState.state,
  });
  syncNativeAudioStop();
  setAudioProvider('none');
  stopAnchor();
  simulation.stop();
  ambient.stopAll();
  releaseWakeLock(); // liberar pantalla activa al pausar
  playing = false;
  playBtn.classList.remove('playing');
  playBtn.innerHTML = ICONS.play;
  playBtn.setAttribute('aria-label', 'Comenzar sesión');
  updateStatus();
  disarmTimer();
  disarmSeqTimer();
  const summary = withSummary ? captureSessionSummary() : null;
  recordHistory();
  saveSession();
  // Cierre sincronizado (P31): audio, UI, MediaSession, timer y registro de
  // eventos quedan alineados; nunca dejan MediaSession en 'playing' con la
  // UI en stop.
  lifecycle.transition('stop');
  audioState.transition('user_stop', { reason: withSummary ? 'completed' : 'ui-stop' });
  sessionLog.stop({ reason: withSummary ? 'completed' : 'stopped' });
  if (summary) showSessionSummary(summary);
}

// Pausa real (lock screen / notificación / botón de la app): congela el motor
// y el temporizador (remanente guardado en pausedRemainingMs) SIN terminar la
// sesión — no se registra historial ni se resetea el reloj. En la APK el
// motor nativo ya quedó en pausa (evento vyneural:audioplayback): aquí solo
// se sincroniza la UI y el visualizador web (mudo), sin reenviar STOP al
// servicio, así un play posterior retoma la MISMA sesión nativa.
function pauseSession(source = 'lock-screen') {
  if (!playing) return;
  // P5.2 — protocolo simétrico: la pausa de la UI/teclado/API también pausa el
  // servicio nativo (antes solo se sincronizaba la UI y el motor nativo seguía
  // sonando con la UI en pausa). Si la pausa viene del lock screen el servicio
  // YA pausó (evento vyneural:audioplayback): 0 comandos, solo sincronizar.
  const nb = nativeAudio();
  if (nb && nb.pauseBackgroundAudio && nativePauseCommand({ source }) === 'pause') nb.pauseBackgroundAudio();
  // Congelar la cuenta regresiva donde está (YouTube): al reanudar se restaura.
  pausedRemainingMs = timerEnd ? Math.max(0, timerEnd - Date.now()) : null;
  const prevState = audioState.state;
  const tr = audioState.transition('system_pause', { reason: source });
  traceCausal('PAUSE', source, { from: prevState, to: tr ? tr.to : audioState.state });
  simulation.stop();
  ambient.stopAll();
  stopAnchor();
  playing = false;
  playBtn.classList.remove('playing');
  playBtn.innerHTML = ICONS.play;
  playBtn.setAttribute('aria-label', 'Comenzar sesión');
  updateStatus();
  disarmTimer();
  // Congelar el countdown del paso actual de la rutina (igual que el
  // temporizador global): un play posterior reanuda el mismo paso.
  if (seq) {
    seq.remainingMs = seq.stepEnd ? Math.max(0, seq.stepEnd - Date.now()) : seq.remainingMs;
    seq.stepEnd = 0;
  }
  disarmSeqTimer();
  lifecycle.transition('stop');
  sessionLog.pause({ source });
  setAudioProvider('none');
  ilog('playback', 'ui-paused');
}

// Alias histórico del evento nativo de la APK (vyneural:audioplayback).
function pauseUiOnly() {
  pauseSession('lock-screen');
}

// Reanuda la sesión pausada donde quedó (misma sesión, mismo temporizador).
// Si no había una pausa activa (p. ej. sesión detenida), arranca una nueva.
function resumeSession(source = 'lock-screen') {
  if (playing) return;
  const rem = pausedRemainingMs;
  pausedRemainingMs = null;
  start({ resume: true, source });
  // Restaurar la cuenta regresiva congelada (solo si sigue habiendo
  // temporizador; si el usuario lo cambió a ∞ durante la pausa, queda ∞).
  if (rem != null && timerMinutes > 0 && rem > 1000) {
    timerEnd = Date.now() + rem;
  }
  ilog('playback', 'ui-resumed');
}

// ---------------------------------------------------------------- Historial
// Registra la sesión terminada (estado, duración real y fecha) en
// localStorage y refresca el resumen del día.
function recordHistory() {
  if (!sessionStartTime) return;
  const durMin = Math.max(1, Math.round((Date.now() - sessionStartTime) / 60000));
  const rec = {
    id: selected.id,
    name: selected.name,
    band: selected.band,
    min: durMin,
    ts: Date.now(),
  };
  const h = sanitizeHistory(lsGet(LS_HISTORY, []));
  h.push(rec);
  lsSet(LS_HISTORY, h.slice(-50));
  sessionStartTime = 0;
  updateHistory();
}

// El historial vive en el botón con forma de reloj (esquina superior
// izquierda del visualizador): solo el icono, y el resumen del día se
// muestra como tooltip. La lista completa está en el modal.
function updateHistory() {
  const btn = document.getElementById('history-btn');
  if (!btn) return;
  btn.innerHTML = ICONS.history;
  const h = sanitizeHistory(lsGet(LS_HISTORY, []));
  const today = h.filter((r) => new Date(r.ts).toDateString() === new Date().toDateString());
  if (today.length) {
    const mins = today.reduce((a, r) => a + r.min, 0);
    const hm = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
    btn.setAttribute('aria-label', `Historial de sesiones · ${hm} hoy`);
    btn.title = `Historial de sesiones · ${hm} hoy`;
  } else {
    btn.setAttribute('aria-label', 'Historial de sesiones');
    btn.title = 'Historial de sesiones';
  }
}

function openHistory() {
  renderHistory();
  document.getElementById('history-modal').classList.remove('hidden');
}

function closeHistory() {
  document.getElementById('history-modal').classList.add('hidden');
}

function renderHistory() {
  const h = sanitizeHistory(lsGet(LS_HISTORY, []));
  const todayEl = document.getElementById('history-today');
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const today = h.filter((r) => new Date(r.ts).toDateString() === new Date().toDateString());
  if (today.length) {
    const mins = today.reduce((a, r) => a + r.min, 0);
    const hm = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
    todayEl.classList.remove('hidden');
    todayEl.innerHTML = `${ICONS.clock} Hoy: <b>${hm}</b> de práctica · ${today.length} ${today.length === 1 ? 'sesión' : 'sesiones'}`;
  } else {
    todayEl.classList.add('hidden');
  }
  list.innerHTML = '';
  if (!h.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  [...h].reverse().forEach((r) => {
    const li = document.createElement('li');
    const d = new Date(r.ts);
    const state = STATES.find((s) => s.id === r.id);
    const when =
      d.toLocaleDateString('es', { day: 'numeric', month: 'short' }) +
      ' · ' +
      d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `
      <span class="hl-icon" style="color:${state ? state.color : 'var(--accent)'}">${state ? state.icon : ICONS.history}</span>
      <span class="hl-main"><b>${r.name}</b><small>${r.band} · ${when}</small></span>
      <span class="hl-min">${r.min} min</span>
    `;
    li.addEventListener('click', () => {
      const st = STATES.find((s) => s.id === r.id);
      if (st) selectState(st);
      closeHistory();
    });
    list.appendChild(li);
  });
}

// Abrir/cerrar el panel de historial.
document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
document.getElementById('history-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('history-modal')) closeHistory();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && moreMenu && !moreMenu.classList.contains('hidden')) {
    closeMoreMenu();
  } else if (e.key === 'Escape' && !document.getElementById('history-modal').classList.contains('hidden')) {
    closeHistory();
  } else if (e.key === 'Escape' && !document.getElementById('summary-modal').classList.contains('hidden')) {
    closeSessionSummary();
  } else if (e.key === 'Escape' && !document.getElementById('experiment-modal').classList.contains('hidden')) {
    closeExperiment();
  } else if (e.key === 'Escape' && !document.getElementById('permissions-modal').classList.contains('hidden')) {
    closePermissions();
  }
});

// ---------------------------------------------------------------- Respaldo de datos
// Exporta e importa todos los datos de la app (preferencias, favoritos,
// historial, alarmas y consentimientos) en un archivo JSON. Así los datos
// sobreviven a un cambio de dispositivo o a un navegador que borra el
// almacenamiento local. Es la capa final de la persistencia local.
const BACKUP_KEYS = [
  'ob-session-v1', // sesión (estado, volumen, ambientes, valores, filtro)
  'ob-favs-v1', // estados favoritos
  'ob-history-v1', // historial de sesiones
  'ob-carrier-v1', // portadora elegida
  'ob-viz-v1', // visualizador elegido (gotas / cimática)
  'ob-quickstart-v1', // inicio rápido ya visto
  'ob-install-v1', // banner de instalación cerrado
  'vyneural-cookie-consent', // elección del aviso de privacidad
  'vyneural_alarms', // recordatorios de sesión
];

function backupPayload() {
  const data = { app: 'vyneural', version: 1, exportedAt: new Date().toISOString(), keys: {} };
  for (const key of BACKUP_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) data.keys[key] = raw;
    } catch {
      /* sin almacenamiento disponible */
    }
  }
  return data;
}

function downloadBackup() {
  const data = backupPayload();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `vyneural-respaldo-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  setBackupStatus('✅ Respaldo descargado. Guardalo en un lugar seguro.', 'ok');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || data.app !== 'vyneural' || !data.keys || typeof data.keys !== 'object') {
        throw new Error('formato inválido');
      }
      let restored = 0;
      for (const [key, raw] of Object.entries(data.keys)) {
        if (!BACKUP_KEYS.includes(key)) continue;
        try {
          localStorage.setItem(key, String(raw));
          restored++;
        } catch {
          /* ignorar claves que no se puedan escribir */
        }
      }
      setBackupStatus(
        restored > 0
          ? `✅ Se restauraron ${restored} bloques de datos. Recargamos la página para aplicarlos.`
          : '⚠️ El respaldo no contenía datos reconocibles de Vyneural.',
        'ok',
      );
      if (restored > 0) setTimeout(() => location.reload(), 1400);
    } catch {
      setBackupStatus('⚠️ No pudimos leer ese archivo: no parece un respaldo de Vyneural.', 'err');
    }
  };
  reader.onerror = () => setBackupStatus('⚠️ No pudimos leer el archivo. Intentá de nuevo.', 'err');
  reader.readAsText(file);
}

const backupExport = document.getElementById('backup-export');
const backupImport = document.getElementById('backup-import');
const backupFile = document.getElementById('backup-file');
const backupStatus = document.getElementById('backup-status');

function setBackupStatus(msg, kind) {
  if (!backupStatus) return;
  backupStatus.textContent = msg;
  backupStatus.dataset.kind = kind || 'ok';
  backupStatus.classList.remove('hidden');
  clearTimeout(setBackupStatus._t);
  setBackupStatus._t = setTimeout(() => backupStatus.classList.add('hidden'), 7000);
}

if (backupExport) backupExport.addEventListener('click', downloadBackup);
if (backupImport && backupFile) {
  backupImport.addEventListener('click', () => backupFile.click());
  backupFile.addEventListener('change', () => {
    if (backupFile.files && backupFile.files[0]) importBackup(backupFile.files[0]);
    backupFile.value = '';
  });
}

// ---------------------------------------------------------------- Resumen de sesión
// Al terminar una sesión por el temporizador se muestra un resumen con la
// duración real, la frecuencia usada y el ambiente que sonó.
const summaryModal = document.getElementById('summary-modal');
const AMBIENT_NAMES = { lluvia: 'Lluvia', rio: 'Río', bosque: 'Bosque', pajaros: 'Pájaros', oceano: 'Océano', fuego: 'Fuego' };

function captureSessionSummary() {
  const elapsed = Math.max(0, Math.round((Date.now() - sessionStartTime) / 1000));
  const p = currentParams();
  const amb = sessionAmbient.map((t) => AMBIENT_NAMES[t] || t);
  return {
    elapsed,
    freq: `${selected.name} · ${p.base} / ${+(p.base + p.beat).toFixed(1)} Hz · latido ${p.beat} Hz`,
    ambient: amb.length ? amb.join(' + ') : 'Ninguno',
    // Honestidad experimental (P20): si el SO interrumpió el audio, el
    // resumen lo dice en vez de fingir una sesión continua.
    integrity: sessionLog.integrityText(),
  };
}

function showSessionSummary(s) {
  if (!summaryModal) return;
  document.getElementById('summary-duration').textContent =
    s.elapsed >= 60 ? `${Math.floor(s.elapsed / 60)} min ${s.elapsed % 60} s` : `${s.elapsed} s`;
  document.getElementById('summary-freq').textContent = s.freq;
  document.getElementById('summary-ambient').textContent = s.ambient;
  const intEl = document.getElementById('summary-integrity');
  if (intEl) intEl.textContent = s.integrity || '—';
  summaryModal.classList.remove('hidden');
}

function closeSessionSummary() {
  if (summaryModal) summaryModal.classList.add('hidden');
}

if (summaryModal) {
  document.getElementById('summary-close').addEventListener('click', closeSessionSummary);
  summaryModal.addEventListener('click', (e) => {
    if (e.target === summaryModal) closeSessionSummary();
  });
  document.getElementById('summary-history').addEventListener('click', () => {
    closeSessionSummary();
    openHistory();
  });
}

playBtn.addEventListener('click', () => {
  if (playing) pauseSession('ui');
  else resumeSession('ui');
});
// Estado inicial del play sobre las gotas (solo icono).
playBtn.innerHTML = ICONS.play;
playBtn.setAttribute('aria-label', 'Comenzar sesión');

// ---------------------------------------------------------------- Rutina secuencial
// Reproducción de un itinerario (la rutina unificada) paso a paso: cada paso
// retunea el audio a su frecuencia y un countdown avanza al siguiente. REGLA
// DE ORO: nunca autoplay — el enlace llega configurado en pausa y el countdown
// corre SOLO con un play explícito del usuario. El estado vive en `seq`:
// { name, steps:[{name,base,beat,wave,dur}], index, stepEnd, remainingMs }.
let seq = null;
let seqTimer = null;

function disarmSeqTimer() {
  if (seqTimer) {
    clearInterval(seqTimer);
    seqTimer = null;
  }
}

function seqRemainMs() {
  if (!seq) return 0;
  if (seq.stepEnd) return Math.max(0, seq.stepEnd - Date.now());
  const step = seq.steps[seq.index];
  return seq.remainingMs != null ? seq.remainingMs : step ? step.dur * 1000 : 0;
}

function updateSeqBar() {
  const bar = document.getElementById('seq-bar');
  if (!bar) return;
  if (!seq) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const step = seq.steps[seq.index];
  const nameEl = document.getElementById('seq-name');
  const stepEl = document.getElementById('seq-step');
  const remainEl = document.getElementById('seq-remain');
  const fill = document.getElementById('seq-fill');
  if (nameEl) nameEl.textContent = seq.name;
  if (stepEl) stepEl.textContent = `Paso ${seq.index + 1}/${seq.steps.length}`;
  if (!step) {
    if (remainEl) remainEl.textContent = '';
    return;
  }
  const totalMs = step.dur * 1000;
  const remain = seqRemainMs();
  const secs = Math.max(0, Math.round(remain / 1000));
  if (remainEl) {
    remainEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${Math.round(step.base)} Hz`;
  }
  if (fill && totalMs > 0) {
    fill.style.width = `${Math.max(0, Math.min(100, (100 * remain) / totalMs))}%`;
  }
}

// Configura el paso `index` del itinerario (frecuencia, ritmo y onda) SIN
// arrancar audio: es la meta de la rutina; el play la activa (nunca autoplay).
function applySeqStep(index) {
  if (!seq) return;
  const step = seq.steps[index];
  if (!step) return;
  seq.index = index;
  seq.remainingMs = null;
  seq.stepEnd = 0;
  const customState = STATES.find((s) => s.custom);
  if (!customState) return;
  selectState(customState);
  carrier = 'personalizado';
  syncCarrierChips();
  updateCustomPanel();
  customBase.value = String(Math.round(step.base * 10) / 10);
  customBeat.value = String(Math.round(step.beat * 10) / 10);
  selectedWave = step.wave;
  syncWaveButtons();
  updateCustomLabels();
  updateCarrierWarning();
  updateStatus();
  // En vivo: retunea el motor (web) o el servicio nativo (APK) al nuevo paso.
  if (playing) {
    const nb = nativeAudio();
    if (nb && nb.retuneBackgroundAudio) {
      // El retune de paso se entrega directo (no por el coalescer): es un
      // cambio puntual por paso, no una ráfaga de slider.
      nb.retuneBackgroundAudio({ base: step.base, beat: step.beat, wave: step.wave });
    } else {
      simulation.audio.retune(currentParams());
      applyAmbient();
    }
    sessionLog.note('seqStep', { index });
  }
  saveSession();
  updateUrl();
  updateSeqBar();
}

// Countdown del paso actual: solo corre cuando la sesión está reproduciendo.
function armSeqTimer() {
  disarmSeqTimer();
  if (!seq) return;
  const step = seq.steps[seq.index];
  if (!step) {
    clearSeq();
    return;
  }
  if (!(step.dur > 0)) {
    // Paso sin duración: no se queda colgado, avanza al siguiente (o termina).
    if (seq.steps.some((s) => s.dur > 0)) setTimeout(advanceSeq, 0);
    else clearSeq();
    return;
  }
  const totalMs = step.dur * 1000;
  // Reanuda donde quedó tras una pausa (like the global timer) o arranca
  // el paso completo en el primer play.
  const remain = seq.remainingMs != null && seq.remainingMs <= totalMs ? seq.remainingMs : totalMs;
  seq.remainingMs = remain;
  seq.stepEnd = Date.now() + remain;
  seqTimer = setInterval(tickSeq, 250);
  tickSeq();
}

function tickSeq() {
  if (!seq) return;
  const remain = Math.max(0, seq.stepEnd - Date.now());
  seq.remainingMs = remain;
  updateSeqBar();
  if (remain <= 0) advanceSeq();
}

function advanceSeq() {
  if (!seq) return;
  disarmSeqTimer();
  if (seq.index >= seq.steps.length - 1) {
    // Último paso: termina la sesión con el resumen (como el temporizador).
    const doneName = seq.name;
    clearSeq();
    if (playing) endSession();
    else showToast(`✅ ${doneName}: completada`);
    return;
  }
  applySeqStep(seq.index + 1);
  armSeqTimer();
}

function clearSeq() {
  disarmSeqTimer();
  seq = null;
  updateSeqBar();
}

const seqCancelBtn = document.getElementById('seq-cancel');
if (seqCancelBtn) {
  seqCancelBtn.addEventListener('click', () => {
    // Cancelar la rutina: se detiene la sesión y se limpia la secuencia.
    const wasPlaying = playing;
    clearSeq();
    if (wasPlaying) stop(false);
  });
}

// ---------------------------------------------------------------- Volumen
// Aplica un nivel de volumen compartido por el slider de las gotas y el del
// modo girado.
function setVolume(v) {
  volumeLevel = parseFloat(v);
  volume.value = String(volumeLevel);
  if (volumeLabel) volumeLabel.textContent = `${Math.round(volumeLevel * 100)}%`;
  // APK: el nivel real lo aplica el servicio nativo (la web está muda); no
  // tocar el masterGain web o se desmutea y suena doble tono.
  // R2 — el slider emite ráfagas de eventos: solo el último nivel de la
  // ráfaga llega al servicio (coalescido), sin perder respuesta audible.
  const b = nativeAudio();
  if (b) {
    nativeCmdCoalescer.schedule('level', () => {
      const nb = nativeAudio();
      if (nb && nb.setAudioLevel) nb.setAudioLevel({ level: volumeLevel });
    });
  } else {
    simulation.setVolume(volumeLevel);
  }
  saveSession();
}
volume.addEventListener('input', () => {
  setVolume(volume.value);
  sessionLog.note('volumeChanged', { to: volumeLevel });
});

// Sube/baja el volumen de la sesión desde los controles del sistema (Media
// Session: volumeup/volumedown) o la API __vyneural. Nunca sale de [0, 1] y
// la UI refleja el cambio al instante (mismo camino que el slider).
function setVolumeBy(delta) {
  const next = Math.max(0, Math.min(1, Math.round((volumeLevel + delta) * 100) / 100));
  if (next === volumeLevel) return;
  setVolume(next);
  sessionLog.note('volumeChanged', { to: next, source: 'media-session' });
}

// ---------------------------------------------------------------- Temporizador
function armTimer() {
  disarmTimer();
  if (!timerMinutes) {
    timerDisplay.classList.add('hidden');
    return;
  }
  timerEnd = Date.now() + timerMinutes * 60000;
  timerDisplay.classList.remove('hidden');
  timerInterval = setInterval(tickTimer, 250);
  tickTimer();
  // Pedir permiso de notificación dentro del gesto del usuario, para poder
  // avisar cuando la sesión termine aunque cambies de pestaña.
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function tickTimer() {
  const remain = Math.max(0, Math.round((timerEnd - Date.now()) / 1000));
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  timerDisplay.innerHTML = `${ICONS.clock} ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  updateMediaPosition();
  if (remain <= 0) endSession();
}

// Fin del temporizador: el audio se desvanece suavemente en vez de cortar,
// se avisa con una notificación (si la pestaña no está visible) y la sesión
// queda registrada en el historial.
// M1 — en la APK la notificación la publica el SISTEMA (bridge SESSION_END →
// NotificationHelper): la WebView no muestra new Notification(). En web/PWA
// sigue el camino web (Notification API).
function endSession() {
  if (fading) return;
  fading = true;
  disarmTimer();
  timerDisplay.innerHTML = `${ICONS.clock} Desvaneciendo…`;
  if (document.hidden) {
    const nb = nativeAudio();
    if (nb && nb.sessionEnd) {
      // APK: notificación nativa real (canal propio, sonido del sistema).
      try {
        nb.sessionEnd({
          title: 'Vyneural',
          body: `Tu sesión de ${selected.name} ha terminado. Que descanses.`,
        });
      } catch (_) {
        /* el bridge falló: seguir con el camino web */
      }
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('Vyneural', {
          body: `Tu sesión de ${selected.name} ha terminado. Que descanses.`,
          icon: 'icons/icon-192.png',
          badge: 'icons/icon-192.png',
          tag: 'vyneural-session-end',
        });
      } catch (_) {
        /* el navegador rechazó la notificación */
      }
    }
  }
  // Época de la sesión que termina: si el usuario pulsa play durante el
  // fundido (fade de 1,8 s), el callback diferido no debe detener la sesión
  // nueva (sessionStartTime cambia en start()).
  const epoch = sessionStartTime;
  simulation.audio.fadeAndStop(1800, () => {
    fading = false;
    timerDisplay.classList.add('hidden');
    if (sessionStartTime !== epoch) return;
    stop(true);
  });
}

function disarmTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

timerOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('.timer-btn');
  if (!btn) return;
  timerMinutes = parseInt(btn.dataset.minutes, 10);
  timerOptions.querySelectorAll('.timer-btn').forEach((b) => b.classList.toggle('active', b === btn));
  if (playing) {
    armTimer();
    // La barra del sistema refleja YA el nuevo temporizador (o se limpia si
    // pasó a ∞): sin forzar el refresh, el throttle de 1 s puede dejar la
    // barra anterior visible en la pantalla de bloqueo unos segundos.
    lastPosUpdate = 0;
    updateMediaPosition();
  } else {
    timerDisplay.classList.add('hidden');
  }
  saveSession();
});

// ---------------------------------------------------------------- Ambiente
// Varios sonidos a la vez: cada botón activa/desactiva su capa.
let ambientTypes = new Set();
let ambientVolumeLevel = 0.7;

const ambientVolume = document.getElementById('ambient-volume');
const ambientVolumeLabel = document.getElementById('ambient-volume-label');
ambientVolume.addEventListener('input', () => {
  ambientVolumeLevel = parseFloat(ambientVolume.value);
  ambientVolumeLabel.textContent = `${Math.round(ambientVolumeLevel * 100)}%`;
  ambient.setVolume(ambientVolumeLevel);
  saveSession();
});

// Volumen individual por sonido de ambiente.
document.querySelectorAll('#ambient-volumes input').forEach((inp) => {
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    const label = inp.closest('.av').querySelector('b');
    label.textContent = `${Math.round(v * 100)}%`;
    ambient.setLayerVolume(inp.dataset.type, v);
    saveSession();
  });
});

// El mezclador de ambientes se abre/cierra con un botón.
const mixerBtn = document.getElementById('ambient-mixer-btn');
const mixer = document.getElementById('ambient-mixer');
mixerBtn.addEventListener('click', () => {
  const open = mixer.classList.toggle('open');
  mixerBtn.setAttribute('aria-expanded', String(open));
  mixerBtn.innerHTML = open ? `${ICONS.sliders} Cerrar mezclador` : `${ICONS.sliders} Mezclador`;
});

function updateAmbientButtons() {
  ambientOptions.querySelectorAll('.ambient-btn').forEach((b) => {
    const t = b.dataset.type;
    b.classList.toggle('active', t ? ambientTypes.has(t) : ambientTypes.size === 0);
  });
}

ambientOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('.ambient-btn');
  if (!btn) return;
  const type = btn.dataset.type;
  if (!type) {
    ambientTypes.clear();
  } else if (ambientTypes.has(type)) {
    ambientTypes.delete(type);
  } else {
    ambientTypes.add(type);
  }
  updateAmbientButtons();
  saveSession();
  if (playing) {
    applyAmbient();
  } else if (ambientTypes.size > 0) {
    // P5.8 (F2) — seleccionar ambiente SIN sesión NUNCA arranca el reproductor:
    // la configuración no es una causa de PLAY (violaba la jerarquía de
    // comandos: un toque en el mixer arrancaba la sesión completa). El ambiente
    // queda guardado para la próxima sesión; el play lo decide el usuario.
    showToast('Ambiente configurado — toca play para comenzar 🎧');
  }
});

// ---------------------------------------------------------------- Personalizado
function updateCustomLabels() {
  customBaseLabel.textContent = `Portada: ${customBase.value} Hz`;
  customBeatLabel.textContent = `Ritmo binaural: ${customBeat.value} Hz`;
}

customBase.addEventListener('input', () => {
  updateCustomLabels();
  if ((selected.custom || carrier === 'personalizado') && playing) {
    simulation.audio.retune(currentParams());
    syncNativeAudioRetune();
    applyAmbient();
  }
  // El reproductor (estado, leyenda y frecuencias) refleja el valor nuevo.
  updateStatus();
  updateCarrierWarning();
  if (playing) sessionLog.note('stimulusChanged', { base: parseFloat(customBase.value) });
  saveSession();
  updateUrl();
});
customBeat.addEventListener('input', () => {
  updateCustomLabels();
  if (selected.custom && playing) {
    simulation.audio.retune(currentParams());
    syncNativeAudioRetune();
    applyAmbient();
  }
  // El reproductor (estado, leyenda y frecuencias) refleja el valor nuevo.
  updateStatus();
  if (playing) sessionLog.note('stimulusChanged', { beat: parseFloat(customBeat.value) });
  saveSession();
});
// ---------------------------------------------------------------- Forma de onda
// Las cuatro formas del motor (Web Audio: sine, triangle, sawtooth, square),
// con su mini-icono para que se vea cómo es cada onda. Aplica a la frecuencia
// seleccionada (preset o personalizada) y se comparte entre el selector de
// los ajustes y el del panel personalizado.
const WAVES = [
  { id: 'sine', label: 'Senoidal', path: 'M0 8 C 2.5 0 7.5 0 10 8 S 17.5 16 20 8 S 27.5 0 30 8 S 37.5 16 40 8' },
  { id: 'triangle', label: 'Triangular', path: 'M0 8 L 10 0 L 20 16 L 30 0 L 40 8' },
  { id: 'sawtooth', label: 'Diente de sierra', path: 'M0 0 L 20 16 L 20 0 L 40 16' },
  { id: 'square', label: 'Cuadrada', path: 'M0 8 L 0 0 L 10 0 L 10 16 L 20 16 L 20 0 L 30 0 L 30 16 L 40 16 L 40 8' },
];
let selectedWave = 'sine';

function waveIcon(path) {
  return `<svg class="wave-icon" viewBox="0 0 40 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

function initWaveGroup(container) {
  if (!container) return;
  container.innerHTML = '';
  WAVES.forEach((w) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wave-btn';
    btn.dataset.wave = w.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.setAttribute('aria-label', `Onda ${w.label}`);
    btn.innerHTML = `${waveIcon(w.path)}<span>${w.label}</span>`;
    container.appendChild(btn);
  });
}

function syncWaveButtons() {
  document.querySelectorAll('.wave-btn').forEach((btn) => {
    const on = btn.dataset.wave === selectedWave;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

function applyWave(wave) {
  if (!WAVES.some((w) => w.id === wave)) wave = 'sine';
  selectedWave = wave;
  syncWaveButtons();
  // El tipo del oscilador es mutable: se cambia en vivo sin cortar el sonido.
  if (playing) simulation.audio.setWave(selectedWave);
  // APK: mismo set de ondas en el servicio nativo (R2 — coalescido: una
  // ráfaga de clicks entrega solo el último wave).
  nativeCmdCoalescer.schedule('wave', () => {
    const nb = nativeAudio();
    if (nb && nb.setWave) nb.setWave(selectedWave);
  });
  updateStatus();
  if (playing) sessionLog.note('stimulusChanged', { wave: selectedWave });
  saveSession();
}

// Los dos grupos visuales (ajustes y personalizado) comparten el estado.
[waveOptions, customWaveOptions].forEach((container) => {
  if (!container) return;
  initWaveGroup(container);
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.wave-btn');
    if (btn) applyWave(btn.dataset.wave);
  });
});

// ---------------------------------------------------------------- Portadora
// Cambia la portadora activa y reajusta todo (audio, estado, URL, sesión).
function applyCarrier(c) {
  if (!(c in CARRIER_BASE)) return;
  carrier = c;
  syncCarrierChips();
  updateCustomPanel();
  if (playing) {
    simulation.audio.retune(currentParams());
    syncNativeAudioRetune();
    applyAmbient();
  }
  updateStatus();
  updateCarrierWarning();
  lsSet(LS_CARRIER, carrier);
  saveSession();
  updateUrl();
}

// El panel personalizado se muestra con el estado Personalizado o con la
// portadora Personalizado; en ese último caso solo aplica la base (el Δf
// lo sigue dando el estado).
function updateCustomPanel() {
  const show = selected.custom || carrier === 'personalizado';
  customPanel.classList.toggle('hidden', !show);
  customPanel.querySelectorAll('.custom-beat-only').forEach((el) =>
    el.classList.toggle('hidden', !selected.custom),
  );
}

// Aviso sutil si la portadora es tan grave que el latido se percibe mal.
function updateCarrierWarning() {
  if (!carrierWarning) return;
  const base = currentParams().base;
  carrierWarning.classList.toggle('hidden', !(typeof base === 'number' && base < 80));
}

// Guardar la frecuencia actual en la cuenta: inline, junto al panel de
// ajuste (ya no un modal aparte). Los valores salen en vivo del panel
// personalizado / estado actual, igual que antes.
const customSaveFreqBtn = document.getElementById('custom-save-freq');
const customSaveNameEl = document.getElementById('custom-save-name');
const customSaveNoteEl = document.getElementById('custom-save-note');

function setCustomSaveNote(msg, isError) {
  if (!customSaveNoteEl) return;
  customSaveNoteEl.textContent = msg;
  customSaveNoteEl.classList.toggle('hidden', !msg);
  customSaveNoteEl.classList.toggle('custom-save-note-error', !!isError);
}

if (customSaveFreqBtn) {
  customSaveFreqBtn.addEventListener('click', async () => {
    // Guardar frecuencias vive en el backend: sin sesión, se pide iniciar
    // sesión (mismo gesto que el resto de las acciones que requieren cuenta).
    if (!getAccessToken()) {
      setCustomSaveNote('');
      const auth = window.__vyneuralAuth;
      if (auth && typeof auth.open === 'function') auth.open('login');
      return;
    }
    const p = currentParams();
    const name = (customSaveNameEl && customSaveNameEl.value.trim())
      || (selected.custom ? 'Personalizada' : `Mi ${selected.name}`);
    customSaveFreqBtn.disabled = true;
    setCustomSaveNote('Guardando…');
    try {
      await createFrequency({
        name: name.slice(0, 120),
        carrier_frequency: Math.round((p.base || 220) * 10) / 10,
        beat_frequency: Math.round((p.beat || 10) * 10) / 10,
        waveform: p.wave || 'sine',
        condition: 'binaural',
        config: { source: 'generator' },
      });
      if (customSaveNameEl) customSaveNameEl.value = '';
      setCustomSaveNote('✅ Guardada en tu cuenta.');
    } catch (err) {
      setCustomSaveNote((err && err.detail) || 'No se pudo guardar. Intentá de nuevo.', true);
    } finally {
      customSaveFreqBtn.disabled = false;
    }
  });
}

// La URL refleja estado + portadora para compartir y enlazar directo. Lleva la
// familia de portadora (?carrier=…) porque la base efectiva de las familias
// fijas se deriva del estado al cargar; solo en Personalizado se fija f1.
function currentUrlParams() {
  const p = new URLSearchParams();
  p.set('state', selected.id);
  if (carrier !== 'estandar') p.set('carrier', carrier);
  if (carrier === 'personalizado') {
    const base = currentParams().base;
    if (typeof base === 'number') p.set('f1', String(Math.round(base * 10) / 10));
  }
  return p;
}
function updateUrl() {
  history.replaceState(null, '', `${location.pathname}?${currentUrlParams()}`);
}

carrierOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('.carrier-btn');
  if (btn) applyCarrier(btn.dataset.carrier);
});

// ---------------------------------------------------------------- Inicio rápido
// "¿Qué necesitas ahora?": en la primera visita se ofrece elegir una intención
// y arrancar una sesión recomendada con un solo clic (estado + ambiente +
// temporizador). El usuario siempre puede saltarlo con "Explorar".
const LS_QUICK = 'ob-quickstart-v1';
const QUICK_RECOS = {
  dormir:       { state: 'sueno',         ambient: 'lluvia',  minutes: 30, ambientLabel: 'Lluvia suave' },
  relajarme:    { state: 'relajacion',    ambient: 'lluvia',  minutes: 25, ambientLabel: 'Lluvia suave' },
  concentrarme: { state: 'concentracion', ambient: 'rio',     minutes: 25, ambientLabel: 'Río' },
  meditar:      { state: 'meditacion',    ambient: 'bosque',  minutes: 20, ambientLabel: 'Bosque' },
};
let quickIntent = null;
const quickModal = document.getElementById('quickstart');
const quickOptions = document.getElementById('quick-options');
const quickReco = document.getElementById('quick-reco');

function showQuickstart() {
  if (!quickModal) return;
  quickModal.classList.remove('hidden');
  const first = quickOptions.querySelector('.quick-opt');
  if (first) first.focus();
}
function closeQuickstart(persist) {
  if (!quickModal) return;
  quickModal.classList.add('hidden');
  quickOptions.classList.remove('hidden');
  quickReco.classList.add('hidden');
  if (persist) lsSet(LS_QUICK, '1');
}

function pickQuickIntent(intent) {
  const reco = QUICK_RECOS[intent];
  const st = STATES.find((s) => s.id === reco.state);
  if (!st) return;
  quickIntent = intent;
  document.getElementById('quick-reco-main').textContent =
    `${st.beat} Hz · ${reco.ambientLabel} · ${reco.minutes} min`;
  document.getElementById('quick-reco-state').textContent =
    `${st.name} · ${st.band}`;
  quickOptions.classList.add('hidden');
  quickReco.classList.remove('hidden');
}

function quickExplore() {
  closeQuickstart(true);
  document.getElementById('states-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Arranque en un solo clic: aplica la recomendación (estado + ambiente +
// temporizador) y empieza a sonar sin más configuración.
function quickStartSession() {
  const reco = QUICK_RECOS[quickIntent];
  if (!reco) return;
  const st = STATES.find((s) => s.id === reco.state);
  if (!st) return;
  selectState(st);
  // Solo el ambiente recomendado.
  ambientTypes.clear();
  if (reco.ambient) ambientTypes.add(reco.ambient);
  updateAmbientButtons();
  saveSession();
  // Temporizador recomendado.
  const tb = timerOptions.querySelector(`.timer-btn[data-minutes="${reco.minutes}"]`);
  if (tb) tb.click();
  start();
  closeQuickstart(true);
  const panel = document.querySelector('.visual-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

if (quickModal && quickOptions && quickReco) {
  quickOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-opt');
    if (!btn) return;
    const intent = btn.dataset.intent;
    if (intent === 'explorar') quickExplore();
    else pickQuickIntent(intent);
  });
  document.getElementById('quick-start').addEventListener('click', quickStartSession);
  document.getElementById('quick-back').addEventListener('click', () => {
    quickOptions.classList.remove('hidden');
    quickReco.classList.add('hidden');
  });
  // Cerrar tocando fuera o con Escape (equivale a "saltar por ahora").
  quickModal.addEventListener('click', (e) => {
    if (e.target === quickModal) closeQuickstart(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !quickModal.classList.contains('hidden')) closeQuickstart(true);
  });
}

// ---------------------------------------------------------------- PWA
// Instalación: el banner aparece cuando el navegador permite instalar
// (beforeinstallprompt) y no se haya cerrado antes.
const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const installClose = document.getElementById('install-close');
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Dentro de la APK ya instalada "Instalá Vyneural" no tiene sentido —
  // el WebView nativo no debería disparar beforeinstallprompt, pero si
  // algún Chromium de fábrica lo hace igual, no mostrar el banner ahí.
  if (installBanner && !nativeBridge.present && !lsGet('ob-install-v1', null)) {
    installBanner.classList.remove('hidden');
  }
});
if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch (_) {
      /* el usuario cerró el diálogo nativo */
    }
    deferredPrompt = null;
    installBanner.classList.add('hidden');
  });
  installClose.addEventListener('click', () => {
    installBanner.classList.add('hidden');
    lsSet('ob-install-v1', '1');
  });
}
window.addEventListener('appinstalled', () => {
  if (installBanner) installBanner.classList.add('hidden');
  deferredPrompt = null;
});

// ---------------------------------------------------------------- Extras
// Toast efímero para confirmaciones (enlace copiado, etc.).
let toastTimer = null;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// Compartir: Web Share API con deep link al estado seleccionado
// (/?state=…) y fallback a copiar el enlace.
const shareBtn = document.getElementById('share-btn');
shareBtn.innerHTML = ICONS.share;

// Compartir: Web Share API con deep link al estado + portadora seleccionados
// y fallback a copiar el enlace. Lo usan el botón principal y el del modo girado.
async function shareLink() {
  const url = `${location.origin}/?${currentUrlParams()}`;
  const data = {
    title: 'Vyneural',
    text: `Escucha "${selected.name}" (${selected.band}) y viaja por el sonido.`,
    url,
  };
  try {
    if (navigator.share) {
      await navigator.share(data);
      return; // el usuario compartió (o canceló): no hacemos nada más
    }
  } catch (_) {
    return; // canceló el compartir nativo
  }
  // Sin Web Share: copiar al portapapeles, con último recurso de texto.
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      showToast('Enlace copiado 🔗');
      return;
    }
  } catch (_) {
    /* portapapeles bloqueado: sigue al fallback */
  }
  window.prompt('Copia el enlace:', url);
}
shareBtn.addEventListener('click', shareLink);

// Pantalla completa / modo inmersivo: las gotas llenan la pantalla. En
// escritorio se añaden los controles al lado; en teléfono (iOS o Android)
// solo las gotas a pantalla completa, sin giros ni ajustes, con play,
// compartir y volumen sobre el lienzo. iOS Safari solo tiene soporte
// parcial de la Fullscreen API: si no entra, el modo CSS llena igual el
// viewport.
const fullscreenBtn = document.getElementById('fullscreen-btn');

// Marca la portadora activa en la fila principal.
function syncCarrierChips() {
  carrierOptions.querySelectorAll('.carrier-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.carrier === carrier),
  );
}

fullscreenBtn.innerHTML = ICONS.expand;
function setFullscreenIcon(on) {
  fullscreenBtn.innerHTML = on ? ICONS.compress : ICONS.expand;
  fullscreenBtn.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
}
fullscreenBtn.addEventListener('click', async () => {
  if (!document.fullscreenElement && !document.body.classList.contains('immersive')) {
    const el = document.documentElement;
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (req) {
      try {
        await req();
      } catch (_) {
        /* fullscreen no soportado: el modo CSS llena igual la pantalla */
        document.body.classList.add('immersive');
        setFullscreenIcon(true);
        lockPortrait();
        updateRotateOverlay();
        setTimeout(() => requestRestore(true), 250);
      }
      // Soporte parcial (iOS): si no llegó a entrar de verdad, activa el modo CSS.
      setTimeout(() => {
        if (!document.fullscreenElement) {
          document.body.classList.add('immersive');
          setFullscreenIcon(true);
          lockPortrait();
          updateRotateOverlay();
        }
        resizeCanvas();
        setTimeout(() => requestRestore(true), 250);
      }, 250);
    } else {
      document.body.classList.add('immersive');
      setFullscreenIcon(true);
      lockPortrait();
      updateRotateOverlay();
      resizeCanvas();
      setTimeout(() => requestRestore(true), 250);
    }
  } else {
    document.body.classList.remove('immersive');
    setFullscreenIcon(false);
    unlockOrientation();
    updateRotateOverlay();
    const ext = document.exitFullscreen?.bind(document) ?? document.webkitExitFullscreen?.bind(document);
    if (ext) {
      try {
        await ext();
      } catch (_) {
        /* no había fullscreen real activo */
      }
    }
    requestAnimationFrame(resizeCanvas);
    // En el modo CSS (sin fullscreen real) no llega fullscreenchange: se
    // reanuda el audio igualmente al salir.
    setTimeout(() => requestRestore(true), 200);
  }
});
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  document.body.classList.toggle('immersive', on);
  setFullscreenIcon(on);
  // En el teléfono se intenta bloquear la orientación vertical al entrar
  // (Android lo permite en pantalla completa; iOS no, por eso también hay
  // un aviso visual para girar el celular).
  if (on) lockPortrait();
  updateRotateOverlay();
  // El canvas se re-mide al entrar/salir del modo (el layout cambia). Se
  // espera un frame para que el CSS ya haya aplicado el nuevo tamaño.
  requestAnimationFrame(resizeCanvas);
  // Al entrar o salir de pantalla completa algunos navegadores (Android/iOS)
  // suspenden el AudioContext: se reanuda para que la sesión no quede muda
  // con el botón en play.
  setTimeout(() => requestRestore(true), on ? 250 : 200);
});

// ---------------------------------------------------------------- Orientación de las gotas
// En pantalla completa (modo inmersivo) las gotas se disfrutan en vertical:
// si el celular está apaisado se muestra un aviso que tapa el lienzo hasta
// volver a ponerlo de pie, y donde el navegador lo permite se bloquea la
// orientación directamente (Android en pantalla completa; iOS no lo soporta
// y usa solo el aviso). En escritorio o en vertical nunca aparece.
const rotateOverlay = document.getElementById('rotate-overlay');

function isTouchDevice() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function updateRotateOverlay() {
  if (!rotateOverlay) return;
  const immersive = document.body.classList.contains('immersive');
  const landscape = window.innerWidth > window.innerHeight;
  rotateOverlay.classList.toggle('hidden', !(immersive && isTouchDevice() && landscape));
}

async function lockPortrait() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      await screen.orientation.lock('portrait');
    }
  } catch (_) {
    /* sin bloqueo de orientación: el aviso de girar cubre el caso */
  }
}

function unlockOrientation() {
  try {
    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch (_) {
    /* nunca se bloqueó */
  }
}

window.addEventListener('resize', updateRotateOverlay);
window.addEventListener('orientationchange', updateRotateOverlay);
updateRotateOverlay();

// ---------------------------------------------------------------- Primer plano / segundo plano
// El audio NO se enmudece al pasar a segundo plano: la sesión sigue sonando
// con el celular bloqueado o al cambiar de aplicación, como una app nativa
// (Spotify no se calla al bloquear la pantalla). El sistema puede suspender
// el AudioContext —p. ej. iOS al bloquear—; al volver se reanuda solo y con
// suavidad, sin cortes ni interferencias externas.
// P1 (M3) — RestoreGate: el unlock dispara restore desde hasta 5 vías
// (visibilitychange, pageshow, focus, resume, pointerdown) en el mismo burst.
// El gate deduplica por máquina de estados: el primer trigger ejecuta, los
// siguientes dentro de la ventana de settle se ignoran (salvo force, p. ej.
// un toque posterior que reintenta porque el AudioContext sigue suspendido).
const restoreGate = new RestoreGate();
window.__restoreGate = restoreGate;
function requestRestore(force = false) {
  const d = restoreGate.request({ force });
  if (d.action === 'run') {
    restoreFromBackground();
    restoreGate.complete();
  }
  return d;
}

function restoreFromBackground() {
  if (!playing) return;
  traceCausal('RESTORE', 'background');
  const audio = simulation.audio;
  const ctx = audio.ctx;
  const wasSuspended = !!(ctx && ctx.state === 'suspended');
  const ts = audio.transport ? audio.transport.getState() : null;
  // Plan de recuperación UNA SOLA VEZ (P0.5.9): decidir qué hay que hacer
  // según el estado real; nunca se reinicia la sesión completa.
  const plan = planRecovery({
    wasSuspended,
    ctxState: ctx ? ctx.state : null,
    transportMode: ts ? ts.mode : 'direct',
    elementPaused: ts ? ts.elementPaused : null,
  });
  // Máquina de ciclo de vida: visible + suspendido → RETURNING; la llegada
  // real a 'running' (ctx.onstatechange) completa la transición a FOREGROUND.
  lifecycle.transition('visibility', { visible: true, ctxState: ctx ? ctx.state : null, playing });
  sessionLog.foreground();
  // APK: el sonido lo sostiene el servicio nativo; la web queda muda siempre
  // (si se desmutea al volver, suenan dos motores a la vez).
  const nb = nativeAudio();
  if (nb) {
    // P1 (M1): enmudecer el motor web con CANCELACIÓN de automation. Asignar
    // gain.value=0 sin cancelar deja una rampa pendiente (fade-in del start o
    // recoverFade del watchdog) que re-eleva la ganancia y hace audible el
    // segundo motor → batido/acoplamiento con el servicio nativo al volver.
    if (audio.masterGain) {
      muteMasterGain(audio.masterGain, ctx ? ctx.currentTime : 0);
    }
    // P2 (I2/I3): dueño único de Media Session — el elemento web queda pausado
    // para que la WebView no reclame una segunda MediaSession ante el SO.
    if (audio.transport) {
      try {
        audio.transport.pause();
      } catch (_) {
        /* elemento no disponible */
      }
    }
  } else if (plan.action === 'recover') {
    // Reanudación sin clics: ganancia al piso, resume, rampa (recoverFade).
    audio.recoverFade(volumeLevel, 0.8);
  } else if (plan.action !== 'reaffirm-element') {
    // Contexto siguió corriendo: solo se re-afirma el nivel de la sesión.
    audio.fadeTo(volumeLevel, 0.4);
  }
  // P5.3 — en la APK la WebView NO ejecuta el protocolo de recuperación de
  // audio web: el transporte y la MediaSession pertenecen al servicio nativo
  // (el motor web queda mudo y su elemento pausado; nada que reafirmar). Solo
  // en Web/PWA se re-afirma el transporte y la sesión de medios al volver.
  if (!nb) {
    const transport = audio.transport;
    if (transport && transport.mode === 'element') {
      transport.reaffirm();
    } else if (audioAnchor && audioAnchor.paused) {
      const p = audioAnchor.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    // Re-afirma la sesión de medios al volver: algunos navegadores (iOS) la
    // pierden al suspender la pestaña y el controlador de notificaciones
    // desaparece hasta el siguiente play. Es barato y no molesta.
    updateMediaSession();
  }
}

document.addEventListener('visibilitychange', () => {
  ilog('visibility', document.hidden ? 'hidden' : 'visible');
  if (document.hidden) {
    // El audio NUNCA se bloquea ni se enmudece al pasar a segundo plano: la
    // sesión sigue sonando dentro del navegador y fuera de él (pantalla de
    // bloqueo / controles del sistema), igual que YouTube. El sistema puede
    // suspender el AudioContext (p. ej. iOS Safari sin PWA instalada); al
    // volver, restoreFromBackground() lo reanuda solo y con suavidad al nivel
    // de la sesión. No se aplica ningún duck: enmudecer la sesión al salir
    // sería "bloquear" el audio para ahorrar problemas, y es justo lo que no
    // se quiere (el usuario pausa solo cuando quiere pausar).
    const ctx = simulation.audio.ctx;
    const audioRunning = !!(ctx && ctx.state === 'running');
    lifecycle.transition('visibility', { visible: false, ctxState: ctx ? ctx.state : null, playing });
    // Si el audio sigue sonando en segundo plano (Android con ancla, PWA
    // instalada), la exposición continúa; si no, se marca la interrupción.
    sessionLog.background(audioRunning);
  } else {
    requestRestore();
  }
});
window.addEventListener('pageshow', () => requestRestore());
window.addEventListener('focus', () => requestRestore());
// Ciclo de vida de la página (Chrome): al "descongelarse" una pestaña que el
// navegador congeló en segundo plano, se re-afirma la sesión para que el audio
// nunca se quede mudo con el botón en play.
document.addEventListener('resume', () => requestRestore());
// iOS suele exigir un gesto del usuario para reanudar el contexto: si al
// volver seguía suspendido, se reanuda con el primer toque sobre la página.
// P2 Fase 11: SOLO se actúa si el contexto quedó suspendido. Con la sesión
// sana, un toque en la UI (menú, scroll, slider, HUD…) NO debe re-ejecutar
// el restore completo: re-crea MediaMetadata, re-rampa la ganancia y
// registra un evento de log por toque (ruido + micro-interferencia).
window.addEventListener('pointerdown', () => {
  if (!playing) return;
  const ctx = simulation.audio && simulation.audio.ctx;
  // force=true: el toque posterior es el gesto que iOS exige para reanudar;
  // debe reintentarse aunque un restore anterior esté en la ventana de settle.
  if (ctx && ctx.state === 'suspended') requestRestore(true);
}, { passive: true });

// Atajos de teclado: Espacio = play/pausa, ←/→ = cambiar de estado.
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && typeof t.matches === 'function' && t.matches('input, select, textarea, [contenteditable="true"]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) pauseSession('keyboard');
    else resumeSession('keyboard');
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const visible = cards.filter((c) => !c.classList.contains('filtered-out'));
    if (!visible.length) return;
    const idx = visible.findIndex((c) => c.dataset.id === selected.id);
    const next = visible[(idx + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
    selectState(STATES.find((st) => st.id === next.dataset.id));
    next.scrollIntoView({ block: 'nearest' });
  }
});

// ---------------------------------------------------------------- Media Session + WakeLock
// Reproductor en las notificaciones y la pantalla de bloqueo (como Spotify):
// la sesión aparece con su nombre, frecuencias y portada, y se controla desde
// el sistema (play, pausa, siguiente, anterior y el seek del temporizador).
// Funciona en Android, escritorio y iOS (Safari 15.4+ / PWA instalada 16.4+).
const MEDIA_SESSION = 'mediaSession' in navigator ? navigator.mediaSession : null;

// ---- WakeLock ---------------------------------------------------------------
// Screen Wake Lock API: impide que el SO dimme/apague la pantalla mientras
// suena la sesión. En Android Chrome esto también previene la interferencia
// de audio al bloquear la pantalla. Se libera al pausar y se re-adquiere al
// volver al primer plano.
let _wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (_wakeLock && !_wakeLock.released) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    ilog('wakelock', 'acquired');
    _wakeLock.addEventListener('release', () => {
      // Si se libera automáticamente (ej. al cambiar de tab), re-adquirir al volver.
      _wakeLock = null;
      ilog('wakelock', 'released');
    });
  } catch (_) {
    /* El usuario denegó o el navegador no soporta */
  }
}
async function releaseWakeLock() {
  if (_wakeLock && !_wakeLock.released) {
    try { await _wakeLock.release(); } catch (_) {}
    _wakeLock = null;
  }
}

// Volver al primer plano: re-adquirir el wake lock si la sesión sigue activa.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && playing) acquireWakeLock();
});

// ---- Permisos ---------------------------------------------------------------
// Un solo punto de entrada que pide notificaciones + wakeLock en el mismo
// gesto de usuario (play). Se muestra solo si aún no se ha decidido.
// LS_PERM_ASKED: guardamos si ya pedimos permisos para no molestar cada vez.
const LS_PERM_ASKED = 'ob-perm-asked-v1';
// El usuario puede desactivar los permisos desde el modal ⋯ → Permisos de la web.
const LS_PERM_DISABLED = 'vyneural_perms_disabled';

function permsDisabled() {
  return lsGet(LS_PERM_DISABLED, false) === true;
}

async function requestAllPermissions() {
  // La decisión (pura y testeada en src/core/permissions.js) dice QUÉ hay que
  // pedir en este momento: nada si están desactivados, nada si ya se decidió,
  // nada en iOS sin PWA instalada (no existe diálogo), y Wake Lock solo si
  // hay soporte y no está ya activo.
  const decision = evaluatePermissions({
    disabled: permsDisabled(),
    notificationSupported: notificationSupported(),
    notifPermission: notificationSupported() ? Notification.permission : null,
    wakeLockSupported: 'wakeLock' in navigator,
    wakeLockHeld: !!(_wakeLock && !_wakeLock.released),
    iosNeedsInstall: iosNeedsInstall(),
  });

  // 1. Notificaciones: SOLO para alarmas y recordatorios del sistema. El
  //    control del reproductor (Media Session) es una capacidad propia que
  //    NO depende de este permiso (P6).
  if (decision.willPromptNotifications) {
    try {
      await Notification.requestPermission();
    } catch (_) { /* denegado o no soportado */ }
  }

  // 2. WakeLock: mantiene la pantalla activa (no es una garantía de audio
  //    en segundo plano — P11; eso lo decide el navegador).
  if (decision.shouldAcquireWakeLock) await acquireWakeLock();

  // 3. Marcar como solicitado para no volver a preguntar
  lsSet(LS_PERM_ASKED, true);
}

// Alias para compatibilidad con el código antiguo
async function requestMediaNotificationPermission() {
  await requestAllPermissions();
}

// ---- Actualizar Media Session ------------------------------------------------
function updateMediaSession() {
  if (!MEDIA_SESSION) return;
  if (typeof MediaMetadata !== 'function') return;
  // P6 — en la APK el propietario de la MediaSession es el servicio NATIVO
  // (pantalla de bloqueo, notificación, Bluetooth): la web no declara ni
  // actualiza una segunda sesión — el SO vería dos. La WebView solo dibuja.
  if (nativeAudio()) return;

  const p = currentParams();

  // Artwork: intentamos con la portada real, con fallback al icono de la app.
  MEDIA_SESSION.metadata = new MediaMetadata({
    title: selected.name,
    artist: 'Vyneural · Ondas binaurales',
    album: `${selected.band} · ${p.base} / ${(p.base + p.beat).toFixed(1)} Hz`,
    artwork: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });

  // Estado de reproducción: 'playing' | 'paused' | 'none'
  MEDIA_SESSION.playbackState = playing ? 'playing' : 'paused';

  // setActive() (Chrome 92+): necesario para que Android muestre el widget en
  // el sombreado de notificaciones. Sin esto el metadata se asigna pero el
  // controlador no aparece hasta que el usuario baje la barra de notificaciones.
  if (typeof MEDIA_SESSION.setActive === 'function') {
    try { MEDIA_SESSION.setActive(playing); } catch (_) {}
  }

  ilog('mediasession', playing ? 'playing' : 'paused');
  updateMediaPosition();
}

// Barra de progreso del reproductor del sistema: sigue el temporizador de la
// sesión (si hay uno) y se refresca cada segundo mientras suena, como la barra
// de YouTube. Con ∞ no hay duración definida y el estado de posición se
// limpia: el controlador del sistema queda solo con play/pausa (sin barra),
// exactamente como un contenido sin duración en YouTube.
let lastPosUpdate = 0;
function updateMediaPosition() {
  if (!MEDIA_SESSION || !playing) return;
  if (!timerMinutes || !timerEnd) {
    // Sin duración: limpiar el estado de posición previo (p. ej. al pasar de
    // un temporizador a ∞ a mitad de sesión) para que la barra desaparezca.
    // setPositionState(null) resetea el estado (web.dev + W3C MediaSession).
    try {
      MEDIA_SESSION.setPositionState(null);
    } catch (_) {
      try {
        MEDIA_SESSION.setPositionState({});
      } catch (_) {
        /* el navegador no soporta posición */
      }
    }
    return;
  }
  const now = Date.now();
  if (now - lastPosUpdate < 1000) return;
  lastPosUpdate = now;
  const dur = timerMinutes * 60;
  const pos = Math.max(0, Math.min(dur, (timerEnd - now) / 1000));
  try {
    MEDIA_SESSION.setPositionState({ duration: dur, playbackRate: 1, position: pos });
  } catch (_) {
    /* el navegador no soporta positionState */
  }
}

const seekBy = (secs) => {
  if (!playing || !timerMinutes || !timerEnd) return;
  const dur = timerMinutes * 60;
  const pos = Math.max(0, Math.min(dur, (timerEnd - Date.now()) / 1000 + secs));
  timerEnd = Date.now() + (dur - pos) * 1000;
};
const moveTrack = (dir) => {
  const visible = cards.filter((c) => !c.classList.contains('filtered-out'));
  if (!visible.length) return;
  const idx = visible.findIndex((c) => c.dataset.id === selected.id);
  const next = visible[(idx + dir + visible.length) % visible.length];
  selectState(STATES.find((st) => st.id === next.dataset.id));
};
// P5 — API de control web estable para integraciones (teclado, scripts,
// bookmarks, home automation): window.__vyneural con las mismas acciones
// que Media Session + lectura de estado. Nunca rompe el flujo de la UI.
// Independiente de MEDIA_SESSION a propósito: el WebView de la APK no
// expone `navigator.mediaSession` (a diferencia de Chrome for Android), y
// esto vivía adentro de `if (MEDIA_SESSION)` — window.__vyneural (y con él
// cualquier integración/automatización) simplemente no existía ahí, aunque
// no tiene nada que ver con la Media Session API.
window.__vyneural = {
  play: () => { if (!playing) resumeSession('api'); return window.__vyneural.state(); },
  pause: () => { if (playing) pauseSession('api'); return window.__vyneural.state(); },
  toggle: () => { if (playing) pauseSession('api'); else resumeSession('api'); return window.__vyneural.state(); },
  stop: () => { if (playing) stop(); return window.__vyneural.state(); },
  volumeUp: () => { setVolumeBy(0.1); return window.__vyneural.state(); },
  volumeDown: () => { setVolumeBy(-0.1); return window.__vyneural.state(); },
  next: () => moveTrack(1),
  prev: () => moveTrack(-1),
  seekBy,
  selectState: (id) => {
    const st = STATES.find((s) => s.id === id);
    if (st) selectState(st);
  },
  state: () => {
    const p = currentParams();
    return {
      playing,
      state: selected.id,
      name: selected.name,
      base: p.base,
      beat: p.beat,
      wave: p.wave,
      volume: p.volume,
      timeLeft: timerEnd ? Math.max(0, Math.round((timerEnd - Date.now()) / 1000)) : null,
    };
  },
};
window.__vyneural.state();
if (MEDIA_SESSION) {
  try {
    // P6 — en la APK los controles del SO (lock screen, notificación,
    // Bluetooth) los maneja la MediaSession NATIVA; la web no registra
    // handlers propios (una sola sesión por app).
    if (nativeAudio()) {
      ilog('mediasession', 'apk-native-owner');
    } else {
      // Pausa/play REALES (tipo YouTube): pausar congela el temporizador y un
      // play posterior reanuda la MISMA sesión donde quedó; stop() solo lo
      // dispara la acción 'stop' del sistema (termina la sesión).
      MEDIA_SESSION.setActionHandler('play', () => { if (!playing) resumeSession('lock-screen'); });
      MEDIA_SESSION.setActionHandler('pause', () => { if (playing) pauseSession('lock-screen'); });
      MEDIA_SESSION.setActionHandler('stop', () => { if (playing) stop(); });
      MEDIA_SESSION.setActionHandler('previoustrack', () => moveTrack(-1));
      MEDIA_SESSION.setActionHandler('nexttrack', () => moveTrack(1));
      MEDIA_SESSION.setActionHandler('seekto', (d) => {
        if (d && d.seekTime != null && timerMinutes && timerEnd) {
          const dur = timerMinutes * 60;
          const pos = Math.max(0, Math.min(dur, d.seekTime));
          timerEnd = Date.now() + (dur - pos) * 1000;
        }
      });
      MEDIA_SESSION.setActionHandler('seekbackward', () => seekBy(-15));
      MEDIA_SESSION.setActionHandler('seekforward', () => seekBy(15));
      // Volumen del motor desde el sistema (asistentes, teclas de volumen del
      // controlador): mismo camino que el slider, nunca silencia ni satura.
      MEDIA_SESSION.setActionHandler('volumeup', () => setVolumeBy(0.1));
      MEDIA_SESSION.setActionHandler('volumedown', () => setVolumeBy(-0.1));
    }
  } catch (_) {
    /* setActionHandler no soportado (Safari < 15.4) */
  }
}

// ---------------------------------------------------------------- Estado
function updateStatus() {
  const p = currentParams();
  statusName.innerHTML = `${selected.icon} ${selected.name}`;
  statusFreqs.textContent = `Izquierda: ${p.base} Hz · Derecha: ${(p.base + p.beat).toFixed(1)} Hz · Latido percibido: ${p.beat} Hz`;
  legendLeft.textContent = `${p.base} Hz`;
  legendRight.textContent = `${(p.base + p.beat).toFixed(1)} Hz`;
  legendBeat.textContent = `${p.beat} Hz`;
  const dotL = document.getElementById('legend-dot-left');
  const dotR = document.getElementById('legend-dot-right');
  if (dotL) dotL.style.setProperty('--c', LANE_LEFT_COLOR);
  if (dotR) dotR.style.setProperty('--c', LANE_RIGHT_COLOR);
  statusState.textContent = playing ? '● Reproduciendo' : '○ En pausa';
  updateMediaSession();
}

// ---------------------------------------------------------------- Visualizador
// Física real de ondas en agua: cada gota es una cuenca circular simulada
// con la ecuación de onda 2D (WaveField). Las fuentes excitan el agua, las
// ondas se propagan, rebotan en el borde y se superponen formando patrones
// de interferencia reales. En la gota del cerebro conviven tres fuentes
// (azul = frecuencia 1, rosa = frecuencia 2, acento = latido) que chocan
// entre sí, y el latido inyecta un impulso exacto en cada pulso real.
//
// Alternativa: la simulación de cimática (CymaticsRenderer), que el usuario
// elige con el interruptor del panel (💧 Gotas / 🔮 Cimática) y que también
// se guarda en localStorage para la próxima visita.

// Visualizador activo: 'gotas' (por defecto) o 'cimatica'.
let vizMode = lsGet(LS_VIZ, 'gotas');
if (vizMode !== 'gotas' && vizMode !== 'cimatica') vizMode = 'gotas';
// cymatics ya fue instanciado arriba y pasado al SimulationEngine.

// Interruptor para elegir la simulación (💧 Gotas / 🔮 Cimática).
const vizSwitch = document.getElementById('viz-switch');
const vizBtns = vizSwitch ? [...vizSwitch.querySelectorAll('.viz-switch-btn')] : [];
function setVizMode(mode) {
  if (mode !== 'gotas' && mode !== 'cimatica') return;
  vizMode = mode;
  lsSet(LS_VIZ, mode);
  // El fondo (starfield) NO cambia al alternar entre gotas y cimática: se
  // mantiene estable para que el cambio de visualización no altere el fondo.
  vizBtns.forEach((b) => {
    const on = b.dataset.viz === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  // En algunos dispositivos (móvil) crear/cambiar de simulación puede hacer
  // que el navegador suspenda el AudioContext; se re-afirma la sesión para
  // que el cambio de visualización nunca deje el audio mudo con el botón
  // "en play". restoreFromBackground() ya ignora el caso en pausa.
  if (playing) setTimeout(() => requestRestore(true), 150);
}
if (vizSwitch) {
  vizSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.viz-switch-btn');
    if (btn) setVizMode(btn.dataset.viz);
  });
  setVizMode(vizMode); // refleja el valor guardado al cargar
}

// ---------------------------------------------------------------- Más opciones (⋯)
// Menú desplegable: Panel Bineural Engine, Modo experimental y Permisos de la web.
// Evita superponer más botones sobre historial/alarma/viz-switch.
const moreBtn = document.getElementById('more-btn');
const moreMenu = document.getElementById('more-menu');

function closeMoreMenu() {
  if (!moreMenu) return;
  moreMenu.classList.add('hidden');
  if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
}

if (moreBtn && moreMenu) {
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = moreMenu.classList.contains('hidden');
    moreMenu.classList.toggle('hidden', !open);
    moreBtn.setAttribute('aria-expanded', String(open));
  });
  moreMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.more-item');
    if (!item) return;
    closeMoreMenu();
    const action = item.dataset.action;
    if (action === 'fps') {
      const hud = byId('hud');
      if (hud) {
        const collapsed = hud.classList.contains('collapsed');
        hud.classList.toggle('collapsed', !collapsed);
        lsSet(LS_HUD, collapsed);
      }
    } else if (action === 'hud') {
      if (simulation) simulation.hud.toggleVisible();
    } else if (action === 'experiment') {
      openExperiment();
    } else if (action === 'permissions') {
      openPermissions();
    } else if (action === 'share') {
      // Compartir también desde el menú ⋯: disponible en pantalla completa
      // (igual que reportar un problema), mismo camino que el botón del lienzo.
      shareLink();
    } else if (action === 'history') {
      // Historial también desde el menú ⋯ (fullscreen incluido).
      openHistory();
    } else if (action === 'bug') {
      // La burbuja flotante se oculta en pantalla completa (CSS); desde el
      // menú ⋯ el reporte de bugs sigue accesible (window.__bugReport lo
      // expone report-bug.js vía site.js).
      if (window.__bugReport) window.__bugReport.open();
      else console.warn('[vyneural] report-bug no inicializado');
    }
  });
  document.addEventListener('click', (e) => {
    if (!moreMenu.classList.contains('hidden') && !moreMenu.contains(e.target) && !moreBtn.contains(e.target)) {
      closeMoreMenu();
    }
  });
  if (simulation) {
    simulation.hud.onVisibilityChange = (visible) => {
      const hudItem = moreMenu.querySelector('[data-action="hud"]');
      if (hudItem) hudItem.classList.toggle('active', visible);
    };
  }
}

// ---------------------------------------------------------------- Modo experimental (Fase 10)
// Compara condiciones de estímulo en el modelo reducido (simulación headless,
// reproducible con semilla). Ver src/core/experiments.js.
const experimentModal = document.getElementById('experiment-modal');
const expConditions = document.getElementById('exp-conditions');
const expConditionsSettings = document.getElementById('exp-conditions-settings');
const expCarrier = document.getElementById('exp-carrier');
const expBeat = document.getElementById('exp-beat');
const expCarrierV = document.getElementById('exp-carrier-v');
const expBeatV = document.getElementById('exp-beat-v');
const expDuration = document.getElementById('exp-duration');
const expSeed = document.getElementById('exp-seed');
const expRun = document.getElementById('exp-run');
const expResults = document.getElementById('exp-results');
const expExport = document.getElementById('exp-export');
let expCondition = 'binaural';
let expLast = null; // { runner, results }

function openExperiment() {
  if (experimentModal) experimentModal.classList.remove('hidden');
}
function closeExperiment() {
  if (experimentModal) experimentModal.classList.add('hidden');
}

if (experimentModal) {
  const expClose = document.getElementById('experiment-close');
  if (expClose) expClose.addEventListener('click', closeExperiment);
  experimentModal.addEventListener('click', (e) => {
    if (e.target === experimentModal) closeExperiment();
  });
}

// La condición del modo experimental es una sola: se elige desde el modal o
// desde los ajustes bajo el reproductor (fila nueva) y ambos se sincronizan.
// La sesión viva la registra (sessionLog) para no ocultar la condición real.
const EXP_CONDITION_TO_SESSION = {
  binaural: 'BINAURAL',
  'pure-tone': 'PURE_TONE_CONTROL',
  noise: 'NOISE_CONTROL',
  'amplitude-modulation': 'AMPLITUDE_MODULATION',
  none: 'SILENCE',
};

function setExpCondition(cond) {
  expCondition = cond;
  [expConditions, expConditionsSettings].forEach((group) => {
    if (!group) return;
    group.querySelectorAll('.exp-cond').forEach((c) => c.classList.toggle('active', c.dataset.cond === cond));
  });
  // La condición cambia el estímulo REAL: se reconstruye el audio en vivo con
  // crossfade (sin clics ni reinicio de sesión) y se registra el cambio.
  if (simulation && simulation.audio) {
    simulation.audio.setCondition(cond);
    if (playing && sessionLog) {
      sessionLog.conditionChanged({ condition: EXP_CONDITION_TO_SESSION[cond] || cond });
    }
    // Ambientes: solo las condiciones rítmicas (binaural/AM) respiran al
    // latido; las demás respiran a un ritmo natural lento.
    const rhythmic = cond === 'binaural' || cond === 'amplitude-modulation';
    if (ambient && ambient.ctx) {
      ambient.setBeat(rhythmic ? currentParams().beat : 0.3, simulation.audio.getBeatEpoch());
    }
  }
}

[expConditions, expConditionsSettings].forEach((group) => {
  if (!group) return;
  group.addEventListener('click', (e) => {
    const b = e.target.closest('.exp-cond');
    if (!b) return;
    setExpCondition(b.dataset.cond);
  });
});

// ── Ajustes desplegables ────────────────────────────────────────────────────
// Duración, ambiente, portadora, forma de onda y condición experimental quedan
// plegados bajo un botón (el usuario pidió que se desplieguen con un toque).
// El estado abierto/cerrado se recuerda entre visitas.
const settingsToggle = document.getElementById('settings-toggle');
const settingsBody = document.getElementById('settings-body');
function toggleSettings(open) {
  if (!settingsBody) return;
  const on = open != null ? open : settingsBody.classList.contains('hidden');
  settingsBody.classList.toggle('hidden', !on);
  if (settingsToggle) settingsToggle.setAttribute('aria-expanded', String(on));
  try {
    localStorage.setItem('vyneural_settings_open', on ? '1' : '0');
  } catch {
    /* sin almacenamiento */
  }
}
if (settingsToggle && settingsBody) {
  settingsToggle.addEventListener('click', () => toggleSettings());
  let saved = null;
  try {
    saved = localStorage.getItem('vyneural_settings_open');
  } catch {
    /* sin almacenamiento */
  }
  toggleSettings(saved === '1'); // por defecto: plegado
}

function syncExpLabels() {
  if (expCarrierV) expCarrierV.textContent = `${expCarrier.value} Hz`;
  if (expBeatV) expBeatV.textContent = `${expBeat.value} Hz`;
}
if (expCarrier && expBeat) {
  expCarrier.addEventListener('input', syncExpLabels);
  expBeat.addEventListener('input', syncExpLabels);
  syncExpLabels();
}

function renderExperiment(res) {
  expResults.classList.remove('hidden');
  const f = res.final;
  const fmt = (x, d = 2) => (typeof x === 'number' && isFinite(x) ? x.toFixed(d) : '--');
  const bar = (v) => `<div class="exp-bar"><i style="width:${Math.max(2, Math.min(100, v * 100))}%"></i></div>`;
  const bands = [
    ['Delta', f.neural.delta, 'δ'],
    ['Theta', f.neural.theta, 'θ'],
    ['Alpha', f.neural.alpha, 'α'],
    ['Beta', f.neural.beta, 'β'],
    ['Gamma', f.neural.gamma, 'γ'],
  ]
    .map(([n, v, g]) => `<div class="exp-band"><span>${g} ${n} <em>SIMULADO</em></span>${bar(v)}<b>${fmt(v)}</b></div>`)
    .join('');
  const cog = [
    ['Arousal', f.cognitive.arousal],
    ['Atención', f.cognitive.attention],
    ['Relajación', f.cognitive.relaxation],
    ['Flow', f.cognitive.flow],
  ]
    .map(([n, o]) => `<div class="exp-band"><span>${n} <em>ESTIMADO</em></span>${bar(o.value)}<b>${fmt(o.value)} <i>c ${fmt(o.confidence)}</i></b></div>`)
    .join('');

  expResults.innerHTML = `
    <div class="exp-head">
      <b>${res.conditionLabel}</b>
      <span>semilla ${res.seed} · ${res.durationSec} s</span>
    </div>
    <div class="exp-grid">
      <div class="exp-block">
        <div class="exp-title">ESTÍMULO <em>PHYSICAL</em></div>
        <div class="exp-line">Oído izquierdo <b>${fmt(res.stimulus.left, 1)} Hz</b></div>
        <div class="exp-line">Oído derecho <b>${fmt(res.stimulus.right, 1)} Hz</b></div>
        <div class="exp-line">Δf (latido físico) <b>${fmt(res.stimulus.difference, 2)} Hz</b></div>
        <div class="exp-line">Dominante simulada <b>${fmt(f.neural.dominantFreq, 1)} Hz</b></div>
      </div>
      <div class="exp-block">
        <div class="exp-title">BANDAS <em>SIMULADO</em></div>
        ${bands}
      </div>
      <div class="exp-block">
        <div class="exp-title">COGNITIVO <em>ESTIMADO</em></div>
        ${cog}
      </div>
      <div class="exp-block">
        <div class="exp-title">VISUAL <em>METÁFORA</em></div>
        <div class="exp-line">Coherencia <b>${fmt(f.visual.coherence)}</b></div>
        <div class="exp-line">Complejidad <b>${fmt(f.visual.complexity)}</b></div>
        <div class="exp-line">Movimiento <b>${fmt(f.visual.velocity)}</b></div>
        <div class="exp-line">PSD θ <b>${fmt(res.psdBands.theta, 3)}</b></div>
      </div>
    </div>
    <canvas id="exp-psd" class="exp-psd" width="640" height="180" aria-label="Espectro de potencia estimado"></canvas>
    <p class="exp-note">Espectro: reconstrucción sintética del EEG final (FFT 2048 @ 128 Hz). No es una medición fisiológica.</p>
  `;
  drawExpPsd(res.psd);
  expExport.classList.remove('hidden');
  // Lleva los resultados al viewport dentro del modal (están bajo el pliegue).
  const card = experimentModal ? experimentModal.querySelector('.modal-card') : null;
  if (card) card.scrollTo({ top: card.scrollHeight, behavior: 'smooth' });
}

function drawExpPsd(psd) {
  const cv = document.getElementById('exp-psd');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const FMAX = 50;
  const data = psd.filter((p) => p.freq <= FMAX);
  let maxP = 1e-9;
  for (const p of data) maxP = Math.max(maxP, p.power);
  ctx.strokeStyle = 'rgba(167,139,250,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  data.forEach((p, i) => {
    const x = (i / Math.max(1, data.length - 1)) * W;
    const y = H - 8 - (p.power / maxP) * (H - 20);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px sans-serif';
  ctx.fillText('0', 2, H - 2);
  ctx.fillText('50 Hz', W - 34, H - 2);
}

if (expRun) {
  expRun.addEventListener('click', () => {
    try {
      const carrier = parseFloat(expCarrier.value) || 220;
      const beat = parseFloat(expBeat.value) || 10;
      const durationSec = parseInt(expDuration.value, 10) || 300;
      const seedRaw = (expSeed.value || '').trim();
      const seed = seedRaw === '' ? null : parseInt(seedRaw, 10) || null;
      const config = new SimulationConfig({
        carrier,
        beat,
        waveform: 'sine',
        condition: expCondition,
        durationSec,
        modelParams: null,
      });
      const runner = new ExperimentRunner({ config, seed });
      const results = runner.run({ durationSec, dt: 0.1 });
      expLast = { runner, results };
      renderExperiment(results);
    } catch (err) {
      expResults.innerHTML = `<p class="exp-error">Error en la simulación: ${err.message}</p>`;
      expExport.classList.add('hidden');
    }
  });
}

if (expExport) {
  expExport.addEventListener('click', () => {
    if (!expLast) return;
    const rec = expLast.runner.record(expLast.results);
    const blob = new Blob([experimentToJson(rec)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vyneural-experimento-${expLast.results.condition}-${expLast.results.seed}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
}

// ---------------------------------------------------------------- Permisos de la web
// Acceso directo para activar/desactivar los permisos que usa la app
// (notificaciones + Wake Lock). Al desactivar, la app deja de pedirlos y los
// recordatorios solo suenan en primer plano; el permiso de notificaciones del
// sistema solo puede revocarse en los ajustes del navegador (se explica en el modal).
const permissionsModal = document.getElementById('permissions-modal');
const permNotif = document.getElementById('perm-notif');
const permWakelock = document.getElementById('perm-wakelock');
const permEnabled = document.getElementById('perm-enabled');
const permNote = document.getElementById('perm-note');

function openPermissions() {
  renderPermissionState();
  if (permissionsModal) permissionsModal.classList.remove('hidden');
  // Permisos reales: si aún no se decidió y no están desactivados, se piden
  // en este mismo gesto (el clic en el menú ⋯ es válido). En Android el
  // navegador muestra el diálogo del sistema; en iOS requiere la PWA.
  if (!permsDisabled() && notificationSupported() && Notification.permission === 'default') {
    requestAllPermissions().then(() => renderPermissionState());
  }
}
function closePermissions() {
  if (permissionsModal) permissionsModal.classList.add('hidden');
}
// Acceso directo desde el navbar de cualquier página (⋯ → Permisos, ver
// src/ui/auth.js): si ya estamos acá, llama esto in situ; si no, auth.js
// navega a /#permisos y el bloque de abajo lo abre solo al cargar.
window.__vyneural.openPermissions = openPermissions;

function permissionStateText() {
  return notifStateText({
    notificationSupported: notificationSupported(),
    notifPermission: notificationSupported() ? Notification.permission : null,
    iosNeedsInstall: iosNeedsInstall(),
  });
}

function renderPermissionState() {
  if (!permNotif) return;
  // P0: la UI lee la matriz fusionada (web + bridge nativo si la APK existe).
  const caps = mergedCapabilities();
  const notifPerm = caps.notifications.permission;
  const isNative = caps.native;
  permNotif.textContent = caps.notifications.label;
  permNotif.className = 'perm-state' + (notifPerm === 'granted' ? ' ok' : ' warn');
  const wakeActive = caps.wakeLock.active;
  permWakelock.textContent = caps.wakeLock.label;
  permWakelock.className = 'perm-state' + (wakeActive ? ' ok' : ' warn');
  // Fila Media Session: no es un permiso; es una capacidad del navegador.
  const permMs = document.getElementById('perm-mediasession');
  if (permMs) {
    permMs.textContent = caps.mediaSession.label;
    permMs.className = 'perm-state' + (caps.mediaSession.active ? ' ok' : ' warn');
  }
  // Fila plataforma: solo visible cuando corre dentro de la APK Android.
  const permPlatformRow = document.getElementById('perm-platform-row');
  const permPlatform = document.getElementById('perm-platform');
  if (permPlatformRow && permPlatform) {
    permPlatformRow.style.display = isNative ? '' : 'none';
    permPlatform.textContent = isNative ? `Android (bridge v${nativeBridge.getState().version || '?'})` : 'Web / PWA';
    permPlatform.className = 'perm-state ok';
  }
  // Diferencias de plataforma en el cuadro informativo.
  const pdbAudio = document.getElementById('pdb-audio');
  const pdbAlarms = document.getElementById('pdb-alarms');
  const pdbNotif = document.getElementById('pdb-notif');
  if (pdbAudio) {
    pdbAudio.innerHTML = isNative
      ? 'APK: Foreground Service ✓<br>Audio estable en background'
      : 'Web: Limitado<br>Requiere pestaña abierta';
  }
  if (pdbAlarms) {
    pdbAlarms.innerHTML = isNative
      ? 'APK: Scheduler del SO ✓<br>Funcionan con la app cerrada'
      : 'Web: Solo app abierta<br>Respaldo: Calendario';
  }
  if (pdbNotif) {
    pdbNotif.innerHTML = isNative
      ? 'APK: Locales nativas ✓<br>Sin necesidad de servidor'
      : caps.push.configured
        ? 'Web: Web Push ✓<br>Con sesión, avisa con la app cerrada'
        : 'Web: Web Push<br>Requiere backend (inactivo)';
  }

  // Fila Push: refleja el estado REAL del backend (consultado en el arranque).
  const permPush = document.getElementById('perm-push');
  if (permPush) {
    permPush.textContent = caps.push.label;
    permPush.className = 'perm-state ' + (caps.push.configured ? 'ok' : 'warn');
  }
  const permTest = document.getElementById('perm-test');
  if (permTest) {
    permTest.classList.toggle('hidden', !isNative);
  }
  // Botones nativos contextuales: solo cuando la APK existe y el estado real
  // del sistema lo amerita (denegado para siempre / no autorizado).
  const btnNotifSettings = document.getElementById('perm-notif-settings');
  if (btnNotifSettings) {
    btnNotifSettings.classList.toggle('hidden', !(isNative && notifPerm !== 'granted'));
  }
  const btnExactSettings = document.getElementById('perm-exact-settings');
  if (btnExactSettings) {
    btnExactSettings.classList.toggle(
      'hidden',
      !(isNative && caps.exactAlarms.supported && !caps.exactAlarms.granted),
    );
  }

  const disabled = permsDisabled();
  permEnabled.textContent = enabledStateText(disabled);
  permEnabled.className = 'perm-state' + (disabled ? ' bad' : ' ok');
  permNote.textContent = disabled
    ? 'Permisos desactivados: la app no volverá a pedirlos y los recordatorios solo sonarán en primer plano. Reactívalos cuando quieras.'
    : iosNeedsInstall()
      ? 'En iOS las notificaciones y el control del reproductor requieren la app instalada: Compartir → Añadir a pantalla de inicio. En Android se piden al tocar “Activar permisos” o al pulsar play.'
      : 'Las notificaciones del sistema solo pueden revocarse en los ajustes del navegador; aquí solo se desactiva su uso en Vyneural (incluye liberar el Wake Lock).';
}

if (permissionsModal) {
  const permClose = document.getElementById('permissions-close');
  if (permClose) permClose.addEventListener('click', closePermissions);
  permissionsModal.addEventListener('click', (e) => {
    if (e.target === permissionsModal) closePermissions();
  });
  document.getElementById('perm-on').addEventListener('click', async () => {
    lsSet(LS_PERM_DISABLED, false);
    // Gesto de usuario: puede mostrar el diálogo de notificaciones del sistema.
    await requestAllPermissions();
    renderPermissionState();
  });
  document.getElementById('perm-off').addEventListener('click', async () => {
    await releaseWakeLock();
    lsSet(LS_PERM_DISABLED, true);
    renderPermissionState();
  });
  const btnTest = document.getElementById('perm-test');
  if (btnTest) {
    btnTest.addEventListener('click', () => {
      const b = nativeAudio();
      if (b && b.testNotification) b.testNotification();
    });
  }
  // Ajustes reales de la APK (P1.5 Fase 9/10): notificaciones denegadas →
  // botón directo a los ajustes del SO; alarmas exactas sin autorizar →
  // botón al diálogo de autorización. Nunca se fingen permisos concedidos.
  const btnNotifSettings = document.getElementById('perm-notif-settings');
  if (btnNotifSettings) {
    btnNotifSettings.addEventListener('click', () => {
      const b = nativeAudio();
      if (b && b.openNotificationSettings) b.openNotificationSettings();
    });
  }
  const btnExactSettings = document.getElementById('perm-exact-settings');
  if (btnExactSettings) {
    btnExactSettings.addEventListener('click', () => {
      const b = nativeAudio();
      if (b && b.requestExactAlarmPermission) b.requestExactAlarmPermission();
    });
  }
}

// Pantalla táctil (móvil/tableta): el visualizador limita su resolución y
// cadencia para no saturar el hilo principal. El audio comparte ese hilo:
// la interferencia al moverse por la app viene de la contención con el
// render (un teléfono con dpr 3 pinta 9× los píxeles de un dpr 1).
const IS_TOUCH =
  typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

function resizeCanvas() {
  // En táctil el dpr se topa en 2: a dpr 3 el canvas pinta 2,25× más píxeles
  // por el mismo tamaño visual (el suavizado es imperceptible a esa escala).
  const dpr = IS_TOUCH ? Math.min(devicePixelRatio || 1, 2) : devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

let waveLeft = null;
let waveRight = null;
let waveBrainB = null;
let waveBrainP = null;
let waveBrainA = null;
let wavePoolR = 0;
let lastBeatPhase = 0;
// Momento del último impulso de cada cuenca (índice: 0=L, 1=R, 2=B, 3=P).
let impactTimes = [0, 0, 0, 0];
let brainCanvas = null;
let brainCtx = null;
let brainImg = null;
let brainSize = 0;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// (LANE_LEFT_COLOR_RGB, LANE_RIGHT_COLOR_RGB y ACCENT_RGB se declaran arriba,
// junto al estado de la app, para que el arranque las use.)

// Crea (o recrea si cambió el tamaño) las cuencas de agua. Si ya existían
// campos con ondas en marcha, redimensiona transfiriendo el estado (u y
// prev) en vez de reiniciar: al cambiar de tamaño (p. ej. al entrar en
// pantalla completa) el agua continúa exactamente donde estaba, solo que
// a otra resolución.
function transferField(oldField, newSize, opts) {
  const nf = new WaveField(newSize, opts);
  nf.setCircle(newSize / 2, newSize / 2, newSize / 2 - 1.5);
  if (oldField) {
    const os = oldField.size;
    const ns = newSize;
    const scale = os / ns;
    for (let y = 0; y < ns; y++) {
      for (let x = 0; x < ns; x++) {
        const ox = Math.round((x - ns / 2) * scale + os / 2);
        const oy = Math.round((y - ns / 2) * scale + os / 2);
        if (ox < 0 || oy < 0 || ox >= os || oy >= os) continue;
        const oi = oy * os + ox;
        const ni = y * ns + x;
        nf.u[ni] = oldField.u[oi];
        nf.prev[ni] = oldField.prev[oi];
      }
    }
  }
  return nf;
}

function ensureFields(poolR) {
  if (wavePoolR && Math.abs(wavePoolR - poolR) < 2) return;
  wavePoolR = poolR;
  const size = Math.max(48, Math.ceil(poolR) + 2);
  // c más lento y más amortiguación: anillos limpios y definidos que se
  // expanden y se apagan, sin acumularse en un revoltijo caótico.
  const opts = { c: 0.45, damp: 0.992 };
  waveLeft = transferField(waveLeft, size, opts);
  waveRight = transferField(waveRight, size, opts);
  waveBrainB = transferField(waveBrainB, size, opts);
  waveBrainP = transferField(waveBrainP, size, opts);
  waveBrainA = transferField(waveBrainA, size, opts);
  if (brainSize !== size) {
    brainSize = size;
    brainCanvas = document.createElement('canvas');
    brainCanvas.width = size;
    brainCanvas.height = size;
    brainCtx = brainCanvas.getContext('2d');
    brainImg = brainCtx.createImageData(size, size);
  }
}

// La gota del cerebro: la unión de las tres frecuencias con un color limpio.
// El agua se tiñe con un degradado azul → acento → rosa (de izquierda a
// derecha) y la superficie es la superposición física de las tres ondas
// (vb + vp + va): las crestas brillan hacia blanco y los valles se oscurecen,
// como la luz reflejándose en agua real. La interferencia se ve en el
// brillo, no en colores que chocan.
function renderBrain() {
  const size = waveBrainB.size;
  const n = waveBrainB.n;
  const mask = waveBrainB.mask;
  const soft = waveBrainB.soft;
  const ub = waveBrainB.u;
  const up = waveBrainP.u;
  const ua = waveBrainA.u;
  const d = brainImg.data;
  const rb = LANE_LEFT_COLOR_RGB[0];
  const gb = LANE_LEFT_COLOR_RGB[1];
  const bb = LANE_LEFT_COLOR_RGB[2];
  const rp = LANE_RIGHT_COLOR_RGB[0];
  const gp = LANE_RIGHT_COLOR_RGB[1];
  const bp = LANE_RIGHT_COLOR_RGB[2];
  const ra = ACCENT_RGB[0];
  const ga = ACCENT_RGB[1];
  const ba = ACCENT_RGB[2];
  const s = size / 2;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (!mask[i]) {
      d[o] = 0;
      d[o + 1] = 0;
      d[o + 2] = 0;
      d[o + 3] = 0;
      continue;
    }
    // Color por posición: izquierda azul, centro acento, derecha rosa.
    const tx = (i % size - s) / (s - 1);
    let cr;
    let cg;
    let cb;
    if (tx <= 0) {
      const k = -tx;
      cr = rb + (ra - rb) * k;
      cg = gb + (ga - gb) * k;
      cb = bb + (ba - bb) * k;
    } else {
      const k = tx;
      cr = ra + (rp - ra) * k;
      cg = ga + (gp - ga) * k;
      cb = ba + (bp - ba) * k;
    }
    // Superficie del agua: suma física de las tres ondas, con ganancia visual.
    const v = (ub[i] + up[i] + ua[i]) * 2.6;
    let bri = 0.32 + v * 0.5;
    if (bri < 0.15) bri = 0.15;
    if (bri > 1.25) bri = 1.25;
    cr *= bri;
    cg *= bri;
    cb *= bri;
    if (v > 0.35) {
      const w = Math.min(1, (v - 0.35) * 0.9);
      cr += (255 - cr) * w;
      cg += (255 - cg) * w;
      cb += (255 - cb) * w;
    }
    d[o] = cr > 255 ? 255 : cr;
    d[o + 1] = cg > 255 ? 255 : cg;
    d[o + 2] = cb > 255 ? 255 : cb;
    d[o + 3] = soft ? Math.round(255 * soft[i]) : 255;
  }
  brainCtx.putImageData(brainImg, 0, 0);
}

// Pinta una cuenca en el lienzo principal, recortada al círculo de la gota.
function drawField(field, rgb, cx, cy, r, composite, alpha = 1) {
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
  ctx2d.clip();
  if (composite) ctx2d.globalCompositeOperation = composite;
  ctx2d.globalAlpha = alpha;
  ctx2d.drawImage(field.render(rgb), cx - r, cy - r, r * 2, r * 2);
  ctx2d.restore();
}

// Cadencia adaptativa del visualizador en táctil: en sesión se pintan 3 de
// cada 4 frames (~45 fps) y en pausa 2 de cada 4 (~30 fps). El latido y los
// impulsos se anclan al reloj del AudioContext (fase 0 = pulso), así que la
// sincronía visual con el audio no cambia; lo que baja es la contención del
// hilo principal (la causa de la interferencia al interactuar en el móvil).
let vizFrame = 0;
// Frecuencias visuales suavizadas (τ = 1,5 s, el mismo ramp que el audio):
// cuando la portadora o el latido cambian, el agua y la placa se afinan
// gradualmente — el cambio de frecuencia SE VE poco a poco, sin saltos de
// ritmo ni reencuadres bruscos. El pulso de luz sigue anclado al reloj real
// del AudioContext (getBeatPhase), así que la sincronía con el latido no
// cambia: solo morfa el ritmo de las ondas y la afinación de la placa.
let visBase = 220;
let visBeat = 6;
let lastVizT = 0;
let vizWarm = false;
// Cache de los gradientes esféricos de las gotas: se recrean solo cuando
// cambia el tamaño de las cuencas o el color de acento (antes se creaban
// 6 gradientes por frame).
let shadeCache = null;
let shadeCacheKey = '';

function drawVisual() {
  requestAnimationFrame(drawVisual);
  // Segundo plano: no hay nada que renderizar. La simulación visual se
  // congela (P21) y, al volver, la fase se reconstruye desde el reloj de
  // audio (AudioClock) — no se repiten frames perdidos ni se quema CPU.
  if (document.hidden) return;
  perfTick();
  if (IS_TOUCH && vizFrame++ % 4 > (playing ? 2 : 1)) return;
  const dpr = devicePixelRatio;
  const w = canvas.width;
  const h = canvas.height;
  ctx2d.clearRect(0, 0, w, h);

  const now = performance.now();
  const t = now / 1000;
  const p = currentParams();
  // Suavizado de la frecuencia visual: EMA con τ = 1,5 s hacia la frecuencia
  // REAL (la del motor). Protección NaN/Infinity por si el input personalizado
  // quedó vacío. El primer frame inicializa sin glide (evita un barrido de
  // arranque al cargar).
  const dts = lastVizT ? Math.min(0.1, (now - lastVizT) / 1000) : 0.016;
  lastVizT = now;
  const tb = isFinite(p.base) ? p.base : visBase;
  const tbt = isFinite(p.beat) ? p.beat : visBeat;
  if (!vizWarm) {
    vizWarm = true;
    visBase = tb;
    visBeat = tbt;
  } else {
    const kS = 1 - Math.exp(-dts / 1.5);
    visBase += (tb - visBase) * kS;
    visBeat += (tbt - visBeat) * kS;
  }
  const beat = Math.max(0.5, visBeat);

  // ----- Condición experimental → física visual ---------------------------
  // La condición elegida (Fase 16) cambia CÓMO se excita el agua y la placa,
  // no solo el audio: tono puro → patrón estacionario simétrico de un solo
  // tono; AM → la placa respira con la envolvente; ruido → régimen turbulento
  // sin estructura tonal; silencio → agua en calma. Las condiciones sin
  // batido real (tono puro, ruido, silencio) respiran a ritmo natural en
  // lugar de pulsar con el latido (el motor de audio devuelve fase nula).
  const cond = expCondition;
  const rhythmic = cond === 'binaural' || cond === 'amplitude-modulation';
  const isPure = cond === 'pure-tone';
  const isNoise = cond === 'noise';
  const isSilence = cond === 'none';

  // ----- Simulación alternativa: cimática ---------------------------------
  // Si el usuario eligió Cimática se dibuja la placa de Faraday en lugar de
  // las tres gotas de ondas. Sincronizada con el latido real del
  // AudioContext: la fase 0 (el pulso) hace brillar el aro LED y las gotas.
  if (vizMode === 'cimatica') {
    const periodMs = Math.max(80, 1000 / beat);
    let phase;
    if (playing && simulation.audio.isPlaying && rhythmic) {
      const ph = simulation.audio.getBeatPhase();
      phase = ph != null ? ph : Math.min(1, (now - lastPulse) / periodMs);
    } else {
      phase = (now % 4000) / 4000;
    }
    const eased = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
    cymatics.render(ctx2d, w, h, {
      // Frecuencias ya suavizadas: la placa se afina gradualmente y sus
      // modos dominantes se reorganizan poco a poco al cambiar el tono.
      base: visBase,
      beat,
      playing,
      pulse: eased,
      condition: cond,
      // Misma paleta que las gotas: izquierda azul, centro morado (acento
      // del estado), derecha rosa.
      colors: [LANE_LEFT_COLOR_RGB, ACCENT_RGB, LANE_RIGHT_COLOR_RGB],
    });
    return;
  }

  // Tres gotas en fila: frecuencia 1 | cerebro | frecuencia 2. En pantalla
  // completa en el teléfono la fila se agranda un poco (ocupa casi todo el
  // ancho) para que las gotas sean las protagonistas de la pantalla. La
  // condición coincide con el CSS: todo dispositivo táctil, no solo estrecho
  // (un teléfono apaisado mide hasta ~932px de ancho).
  const mobileImmersive =
    document.body.classList.contains('immersive') &&
    (window.innerWidth <= 900 || matchMedia('(hover: none) and (pointer: coarse)').matches);
  const poolR = Math.min(h, w / 3) * (mobileImmersive ? 0.45 : 0.4);
  const cxs = [w / 6, w / 2, (5 * w) / 6];
  const cys = [h / 2, h / 2, h / 2];
  const cy = h / 2;

  // Fase del latido real, tomada del reloj del AudioContext para que las
  // ondas brillen exactamente cuando suena el latido (fase 0 = pulso).
  // En pausa, respiración suave.
  const periodMs = Math.max(80, 1000 / beat);
  let phase;
  if (playing && simulation.audio.isPlaying && rhythmic) {
    const ph = simulation.audio.getBeatPhase();
    phase = ph != null ? ph : Math.min(1, (now - lastPulse) / periodMs);
  } else {
    phase = (now % 4000) / 4000;
  }
  // Respiración suave y continua: máximo justo en el latido (phase 0),
  // sin "flash" duro que dé sensación de reinicio.
  const eased = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
  const beatBright = 0.62 + 0.38 * eased; // las tres gotas brillan al unísono

  // ----- Física: las fuentes excitan directamente el agua ------------------
  // No hay gotas que caigan: las tres frecuencias inyectan su impulso en la
  // cuenca (ondas que se propagan, rebotan en el borde y chocan entre sí) y
  // el latido añade su pulso exacto en la fase 0 del reloj del AudioContext.
  ensureFields(poolR);
  const size = waveLeft.size;
  const s = size / 2;
  const off = size * 0.1; // separación de las fuentes en la unión

  // Intervalo visual de excitación de cada cuenca: proporcional a 1/f de su
  // portadora real (más frecuencia → más ondas por segundo, como el agua
  // real). La constante K_VIS lleva la escala: a 220 Hz el período visual
  // queda en ~1,5 s, y al subir/bajar la frecuencia los pulsos se aceleran
  // o espacian exactamente en esa proporción.
  const K_VIS = 330;
  // Frecuencia visual suavizada: las gotas aceleran/desaceleran su ritmo de
  // ondas gradualmente con el cambio de tono real (sin salto de T1/T2).
  const f1v = Math.max(1, visBase);
  const f2v = f1v + beat;
  const T1 = K_VIS / f1v;
  const T2 = K_VIS / f2v;
  const Tpause = K_VIS * 2.2 / f1v; // en pausa, ~2,2× más espaciado
  if (playing) {
    if (isNoise) {
      // Ruido: excitación turbulenta e irregular. Los intervalos y las
      // intensidades son pseudoaleatorios (hash del reloj visual) y las
      // fuentes se desplazan del centro: el agua se agita sin estructura
      // tonal, como el estímulo NOISE real.
      const hsh = (x) => {
        const v = Math.sin(x * 12.9898) * 43758.5453;
        return v - Math.floor(v);
      };
      const n1 = hsh(Math.floor(t * 3.7));
      const n2 = hsh(Math.floor(t * 3.7) + 1);
      if (t - impactTimes[0] >= 0.25 + n1 * 0.9) {
        waveLeft.pokeDisc(s + (n2 - 0.5) * size * 0.3, s + (n1 - 0.5) * size * 0.3, 0.5 + n1 * 1.1);
        impactTimes[0] = t;
      }
      if (t - impactTimes[1] >= 0.25 + n2 * 0.9) {
        waveRight.pokeDisc(s + (n1 - 0.5) * size * 0.3, s + (n2 - 0.5) * size * 0.3, 0.5 + n2 * 1.1);
        impactTimes[1] = t;
      }
      if (t - impactTimes[2] >= 0.3 + n1 * 1.1) {
        waveBrainB.pokeDisc(s - off + (n2 - 0.5) * size * 0.2, s + (n1 - 0.5) * size * 0.2, 0.6 + n2 * 0.9);
        impactTimes[2] = t;
      }
      if (t - impactTimes[3] >= 0.3 + n2 * 1.1) {
        waveBrainP.pokeDisc(s + off + (n1 - 0.5) * size * 0.2, s + (n2 - 0.5) * size * 0.2, 0.6 + n1 * 0.9);
        impactTimes[3] = t;
      }
    } else if (isSilence) {
      // Silencio: el control SILENCE no excita el agua con tono alguno —
      // solo impulsos suaves y muy espaciados, agua en calma.
      if (t - impactTimes[0] >= Tpause) {
        waveLeft.pokeDisc(s, s, 0.6);
        impactTimes[0] = t;
      }
      if (t - impactTimes[1] >= Tpause) {
        waveRight.pokeDisc(s, s, 0.6);
        impactTimes[1] = t;
      }
      if (t - impactTimes[2] >= Tpause) {
        waveBrainB.pokeDisc(s - off, s, 0.5);
        impactTimes[2] = t;
      }
      if (t - impactTimes[3] >= Tpause) {
        waveBrainP.pokeDisc(s + off, s, 0.5);
        impactTimes[3] = t;
      }
    } else if (isPure) {
      // Tono puro: una única frecuencia excita todas las cuencas al mismo
      // ritmo — patrón estacionario simétrico, sin batido entre dos tonos
      // (las dos gotas laterales vibran en fase, no desfasadas).
      if (t - impactTimes[0] >= T1) {
        waveLeft.pokeDisc(s, s, 1.5);
        waveRight.pokeDisc(s, s, 1.5);
        waveBrainB.pokeDisc(s - off, s, 1.3);
        waveBrainP.pokeDisc(s + off, s, 1.3);
        impactTimes[0] = t;
        impactTimes[1] = t;
        impactTimes[2] = t;
        impactTimes[3] = t;
      }
    } else {
      // Binaural / AM: las dos frecuencias, una fuente por cuenca (los
      // laterales en el centro, la unión con azul y rosa desfasadas que
      // chocan al cruzarse). Cada cuenca late a su propia frecuencia: f1 y
      // f2 a ritmos distintos que producen el batido real entre las dos
      // gotas. En AM la fuerza de cada impulso respira con la envolvente
      // de amplitud (el pulso real), como la portadora modulada que suena.
      const amStr = cond === 'amplitude-modulation' ? 0.7 + 1.0 * eased : 1.5;
      const amStrB = cond === 'amplitude-modulation' ? 0.6 + 0.9 * eased : 1.3;
      if (t - impactTimes[0] >= T1) {
        waveLeft.pokeDisc(s, s, amStr);
        impactTimes[0] = t;
      }
      if (t - impactTimes[1] >= T2) {
        waveRight.pokeDisc(s, s, amStr);
        impactTimes[1] = t;
      }
      if (t - impactTimes[2] >= T1) {
        waveBrainB.pokeDisc(s - off, s, amStrB);
        impactTimes[2] = t;
      }
      if (t - impactTimes[3] >= T2) {
        waveBrainP.pokeDisc(s + off, s, amStrB);
        impactTimes[3] = t;
      }
    }
  } else {
    // En pausa: impulsos espaciados y suaves, el agua sigue viva pero
    // tranquila (la excitación ambiental, no la portadora).
    if (t - impactTimes[0] >= Tpause) {
      waveLeft.pokeDisc(s, s, 0.6);
      impactTimes[0] = t;
    }
    if (t - impactTimes[1] >= Tpause) {
      waveRight.pokeDisc(s, s, 0.6);
      impactTimes[1] = t;
    }
    if (t - impactTimes[2] >= Tpause) {
      waveBrainB.pokeDisc(s - off, s, 0.5);
      impactTimes[2] = t;
    }
    if (t - impactTimes[3] >= Tpause) {
      waveBrainP.pokeDisc(s + off, s, 0.5);
      impactTimes[3] = t;
    }
  }
  // Latido: una gota de luz exacta en cada pulso real (fase 0). Solo las
  // condiciones con batido real (binaural/AM) pulsan el centro; el resto
  // (tono puro, ruido, silencio) no tiene pulso que marcar.
  if (playing && rhythmic && phase != null) {
    const wrapped = lastBeatPhase > phase && lastBeatPhase - phase > 0.5;
    if (wrapped) waveBrainA.pokeDisc(s, s, 1.8);
  }
  lastBeatPhase = phase;

  waveLeft.step();
  waveRight.step();
  waveBrainB.step();
  waveBrainP.step();
  waveBrainA.step();

  // ----- Render: pintar cada cuenca sobre su gota --------------------------
  const rgbL = LANE_LEFT_COLOR_RGB;
  const rgbR = LANE_RIGHT_COLOR_RGB;
  const rgbA = ACCENT_RGB;

  drawField(waveLeft, rgbL, cxs[0], cys[0], poolR, null, 1);
  drawField(waveRight, rgbR, cxs[2], cys[2], poolR, null, 1);
  // La gota del cerebro combina las tres frecuencias por dominancia local.
  renderBrain();
  drawField({ render: () => brainCanvas }, null, cxs[1], cys[1], poolR, null, 1);

  const pools = [
    { x: cxs[0], y: cys[0], color: LANE_LEFT_COLOR },
    { x: cxs[1], y: cys[1], color: accentColor },
    { x: cxs[2], y: cys[2], color: LANE_RIGHT_COLOR },
  ];

  // Gradientes esféricos cacheados: la clave incluye el tamaño de las
  // cuencas y el color de acento (cambian con el layout y el estado).
  const shadeKey = `${Math.round(poolR * 10)}|${accentColor}`;
  if (shadeCacheKey !== shadeKey) {
    shadeCacheKey = shadeKey;
    shadeCache = pools.map((pool) => {
      const shade = ctx2d.createRadialGradient(
        pool.x - poolR * 0.25,
        pool.y - poolR * 0.25,
        poolR * 0.15,
        pool.x,
        pool.y,
        poolR,
      );
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(0.7, 'rgba(0,0,0,0.05)');
      shade.addColorStop(1, 'rgba(0,0,0,0.3)');
      const hx = pool.x - poolR * 0.32;
      const hy = pool.y - poolR * 0.38;
      const hg = ctx2d.createRadialGradient(hx, hy, 0, hx, hy, poolR * 0.45);
      hg.addColorStop(0, 'rgba(255,255,255,0.3)');
      hg.addColorStop(0.3, 'rgba(255,255,255,0.07)');
      hg.addColorStop(1, 'rgba(255,255,255,0)');
      const gl = ctx2d.createRadialGradient(hx, hy, 0, hx, hy, poolR * 0.13);
      gl.addColorStop(0, 'rgba(255,255,255,0.9)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      return { shade, hg, gl, hx, hy };
    });
  }
  pools.forEach((pool, i) => {
    const g = shadeCache[i];
    if (!g) return;
    ctx2d.fillStyle = g.shade;
    ctx2d.beginPath();
    ctx2d.arc(pool.x, pool.y, poolR, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = g.hg;
    ctx2d.beginPath();
    ctx2d.arc(pool.x, pool.y, poolR, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = g.gl;
    ctx2d.beginPath();
    ctx2d.ellipse(g.hx, g.hy, poolR * 0.17, poolR * 0.12, -0.5, 0, Math.PI * 2);
    ctx2d.fill();
  });

  // Núcleo de la gota central: el cerebro, pulsa suave con el latido real.
  const brain = pools[1];
  const coreR = poolR * 0.17 * (0.85 + eased * 0.4);
  const glow = ctx2d.createRadialGradient(brain.x, brain.y, 0, brain.x, brain.y, coreR * 3.2);
  glow.addColorStop(0, hexToRgba(accentColor, 0.5 + eased * 0.3));
  glow.addColorStop(1, hexToRgba(accentColor, 0));
  ctx2d.fillStyle = glow;
  ctx2d.beginPath();
  ctx2d.arc(brain.x, brain.y, coreR * 3.2, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.beginPath();
  ctx2d.arc(brain.x, brain.y, coreR, 0, Math.PI * 2);
  ctx2d.fillStyle = hexToRgba('#ffffff', 0.4 + eased * 0.4);
  ctx2d.fill();
}
drawVisual();

// Restaura la sesión guardada: volumen, ambientes, volúmenes por capa y
// temporizador (el estado lo elige el deep link o el guardado).
function restoreSession(saved) {
  if (!saved) return;
  // P3 — validación de corrupción: los valores se aceptan solo si son finitos
  // y están en rango. Un localStorage corrupto (NaN, fuera de rango) no debe
  // romper la UI ni dejar el volumen/sesión en un estado imposible.
  if (typeof saved.volume === 'number' && Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 1) {
    volumeLevel = saved.volume;
    volume.value = String(saved.volume);
    if (volumeLabel) volumeLabel.textContent = `${Math.round(saved.volume * 100)}%`;
    simulation.setVolume(volumeLevel);
  }
  if (Array.isArray(saved.ambient)) {
    ambientTypes = new Set(
      saved.ambient.filter((t) => ['lluvia', 'rio', 'bosque', 'pajaros', 'oceano', 'fuego'].includes(t)),
    );
  }
  if (typeof saved.ambientVolume === 'number' && Number.isFinite(saved.ambientVolume) && saved.ambientVolume >= 0 && saved.ambientVolume <= 1) {
    ambientVolumeLevel = saved.ambientVolume;
    ambientVolume.value = String(saved.ambientVolume);
    ambientVolumeLabel.textContent = `${Math.round(saved.ambientVolume * 100)}%`;
    ambient.setVolume(ambientVolumeLevel);
  }
  if (saved.layerVolumes && typeof saved.layerVolumes === 'object') {
    document.querySelectorAll('#ambient-volumes input').forEach((inp) => {
      const v = saved.layerVolumes[inp.dataset.type];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
        inp.value = String(v);
        const label = inp.closest('.av').querySelector('b');
        label.textContent = `${Math.round(v * 100)}%`;
        ambient.setLayerVolume(inp.dataset.type, v);
      }
    });
  }
  if (typeof saved.timer === 'number' && Number.isFinite(saved.timer) && saved.timer >= 0) {
    timerMinutes = saved.timer;
    timerOptions.querySelectorAll('.timer-btn').forEach((b) =>
      b.classList.toggle('active', parseInt(b.dataset.minutes, 10) === saved.timer),
    );
  }
  if (WAVES.some((w) => w.id === saved.wave)) {
    selectedWave = saved.wave;
  }
  // Valores del panel personalizado (base y ritmo). Solo se restauran si no
  // vienen valores explícitos por deep link (?f1=… / ?freq=…), que tienen
  // prioridad para que los enlaces compartidos sigan funcionando.
  const deepFreqActive = isFinite(deepFreq) && deepFreq > 0;
  const deepF1Active = isFinite(deepF1) && deepF1 > 0 && carrier === 'personalizado';
  if (saved.custom && !deepFreqActive && !deepF1Active) {
    if (typeof saved.custom.base === 'number' && isFinite(saved.custom.base) && saved.custom.base > 0) {
      customBase.value = String(saved.custom.base);
    }
    if (typeof saved.custom.beat === 'number' && isFinite(saved.custom.beat) && saved.custom.beat > 0) {
      customBeat.value = String(saved.custom.beat);
    }
  }
}

// ---------------------------------------------------------------- Recordatorio de sesión
const alarmBtn = document.getElementById('alarm-btn');
const alarmModal = document.getElementById('alarm-modal');
const alarmTime = document.getElementById('alarm-time');
const alarmState = document.getElementById('alarm-state');
const alarmCustom = document.getElementById('alarm-custom');
const alarmBase = document.getElementById('alarm-base');
const alarmBeat = document.getElementById('alarm-beat');
const alarmWave = document.getElementById('alarm-wave');
const alarmMinutes = document.getElementById('alarm-minutes');
const alarmPerm = document.getElementById('alarm-perm');
const alarmSave = document.getElementById('alarm-save');
const alarmGcal = document.getElementById('alarm-gcal');
const alarmIcs = document.getElementById('alarm-ics');
const alarmListWrap = document.getElementById('alarm-list-wrap');
const alarmList = document.getElementById('alarm-list');
const alarmView = document.getElementById('alarms-view');
const alarmViewList = document.getElementById('alarms-view-list');
const alarmViewAdd = document.getElementById('alarms-view-add');
const alarmBadge = document.getElementById('alarm-badge');

// Selector de estados: presets + personalizado.
STATES.forEach((s) => {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.custom ? 'Personalizado (a tu medida)' : `${s.name} · ${s.band}`;
  alarmState.appendChild(opt);
});

function alarmPreset() {
  return STATES.find((s) => s.id === alarmState.value) || STATES[0];
}

function defaultAlarmTime() {
  const d = new Date(Date.now() + 15 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function refreshAlarmPerm() {
  const settingsBtn = document.getElementById('alarm-perm-settings');
  if (settingsBtn) settingsBtn.classList.add('hidden');
  // Estado real de las alarmas exactas (P5): Android 14+ no concede
  // SCHEDULE_EXACT_ALARM por defecto → alarma aproximada ±60 s. Se muestra
  // siempre el estado verdadero y se ofrece el diálogo del sistema.
  const exactP = document.getElementById('alarm-exact');
  const exactBtn = document.getElementById('alarm-exact-settings');
  const nativeNote = document.getElementById('alarm-native-note');
  // APK: el permiso de notificaciones REAL es el de Android (POST_NOTIFICATIONS),
  // lo consulta el bridge (nunca inventa estado). Si está denegado, la
  // notificación nativa se omite en silencio: se avisa y se ofrece abrir los
  // ajustes del sistema (P4 — permiso denegado ≠ alarma silenciosa).
  const b = nativeAudio();
  if (b) {
    const info = b.getState ? b.getState().info : null;
    const np = info ? info.notificationPermission : null;
    if (nativeNote) nativeNote.classList.remove('hidden');
    const exact = info ? info.exactAlarmsGranted : null;
    if (exactP) {
      if (exact === false) {
        exactP.textContent =
          '⏰ Alarma aproximada (±1 min): Android bloqueó las alarmas exactas para esta app. Tocá el botón para activarlas.';
        if (exactBtn) exactBtn.classList.remove('hidden');
      } else {
        exactP.textContent = '⏰ Alarma exacta: dispara a la hora indicada aunque la app esté cerrada.';
        if (exactBtn) exactBtn.classList.add('hidden');
      }
    }
    if (np === 'DENIED' || np === 'DENIED_PERMANENTLY') {
      alarmPerm.textContent =
        np === 'DENIED_PERMANENTLY'
          ? '🚫 Notificaciones bloqueadas de forma permanente en Android: la alarma se guardará pero no podrá avisarte. Activá el permiso en los ajustes del sistema.'
          : '⚠️ Notificaciones bloqueadas en Android: la alarma se guardará pero no podrá avisarte. Activá el permiso en los ajustes.';
      if (settingsBtn) settingsBtn.classList.remove('hidden');
      return;
    }
    if (np === 'GRANTED') {
      alarmPerm.textContent = '✅ Notificaciones de Android activadas: la alarma avisa aunque la app esté cerrada.';
      return;
    }
    alarmPerm.textContent = '🔔 Al guardar, te pediremos permiso de notificaciones en Android.';
    return;
  }
  if (nativeNote) nativeNote.classList.add('hidden');
  if (exactP) exactP.textContent = '';
  if (exactBtn) exactBtn.classList.add('hidden');
  if (!notificationSupported()) {
    alarmPerm.textContent = 'Tu navegador no soporta notificaciones: usá el respaldo de calendario.';
    return;
  }
  const p = Notification.permission;
  if (p === 'granted') alarmPerm.textContent = '✅ Notificaciones activadas: te avisaremos a la hora elegida.';
  else if (p === 'denied') alarmPerm.textContent = '⚠️ Notificaciones bloqueadas: activalas en el navegador o usá el respaldo de calendario.';
  else alarmPerm.textContent = '🔔 Al guardar, te pediremos permiso para notificarte.';
  if (iosNeedsInstall()) {
    alarmPerm.textContent += ' En iPhone, instala Vyneural (Compartir → Añadir a pantalla de inicio) para recibir notificaciones.';
  }
  refreshAlarmHonestNote();
}

// Texto honesto del modal, DINÁMICO según el estado REAL del backend de push:
// si hay sesión y el backend tiene VAPID configurado, el aviso con la app
// cerrada SÍ es posible (web push) — no debe decirse "aún no está configurado".
function refreshAlarmHonestNote() {
  const note = document.querySelector('.alarm-honest-note');
  if (!note) return;
  const push = getCachedPushStatus();
  if (push && push.configured && getAccessToken()) {
    note.innerHTML =
      '✅ <strong>Web Push configurado:</strong> con la app cerrada, la notificación llega ' +
      'por el servidor (el respaldo de calendario sigue disponible como refuerzo). ' +
      'Con la pestaña abierta, la notificación local es inmediata.';
    return;
  }
  note.innerHTML =
    '⚠️ Con la app cerrada o congelada, la notificación local no puede dispararse ' +
    '(límite del navegador). El respaldo del calendario sí avisa a la hora exacta. ' +
    'Las notificaciones con la app cerrada (Web Push) requieren sesión y servidor ' +
    'configurado: activalas desde tu cuenta.';
}

// ── Gating por sesión: campana + notificaciones ────────────────────────────
// Sin sesión no hay backend al que sincronizar el recordatorio (y el Web Push
// con la app cerrada requiere sesión): la campana queda bloqueada y las
// notificaciones no se activan hasta iniciar sesión. Igual en web y APK (el
// bundle es el mismo). Se re-evalúa al iniciar/cerrar sesión y antes de abrir.
function updateAlarmGating() {
  const logged = !!getAccessToken();
  alarmBtn.classList.toggle('locked', !logged);
  alarmBtn.setAttribute('aria-disabled', String(!logged));
  alarmBtn.setAttribute('title', logged ? 'Recordatorio de sesión' : 'Iniciá sesión para programar recordatorios y notificaciones');
  alarmBtn.setAttribute('aria-label', logged ? 'Recordatorio de sesión' : 'Iniciá sesión para programar recordatorios');
  // La vista en la página y el badge solo tienen sentido con sesión.
  if (alarmView) alarmView.classList.toggle('hidden', !logged || getAlarms().length === 0);
  if (alarmBadge) alarmBadge.classList.toggle('hidden', !logged || getAlarms().length === 0);
}

function openAlarmModal() {
  if (!getAccessToken()) {
    showToast('🔒 Iniciá sesión para activar notificaciones y recordatorios');
    return;
  }
  updateAlarmGating();
  if (!alarmTime.value) alarmTime.value = defaultAlarmTime();
  refreshAlarmPerm();
  refreshAlarmHonestNote();
  renderAlarms();
  alarmModal.classList.remove('hidden');
}

function closeAlarmModal() {
  alarmModal.classList.add('hidden');
}

alarmBtn.addEventListener('click', openAlarmModal);
// Re-evaluar el bloqueo cuando cambia la sesión (login/logout/register).
document.addEventListener('vyneural:auth', updateAlarmGating);
document.getElementById('alarm-close').addEventListener('click', closeAlarmModal);
alarmModal.addEventListener('click', (e) => {
  if (e.target === alarmModal) closeAlarmModal();
});

alarmState.addEventListener('change', () => {
  const custom = !!alarmPreset().custom;
  alarmCustom.classList.toggle('hidden', !custom);
  if (!custom) {
    alarmBase.value = String(alarmPreset().base);
    alarmBeat.value = String(alarmPreset().beat);
    alarmWave.value = 'sine';
  }
});

// ── P5 — rutina: selector de días de repetición (vacío = una sola vez) ──────
const alarmDaysEl = document.getElementById('alarm-days');
const DAY_LETTERS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
function alarmDaysSelected() {
  if (!alarmDaysEl) return [];
  return [...alarmDaysEl.querySelectorAll('.alarm-day[aria-pressed="true"]')]
    .map((b) => parseInt(b.dataset.day, 10))
    .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
}
if (alarmDaysEl) {
  alarmDaysEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.alarm-day');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!on));
  });
}
/** Próxima fecha ≥ fromMs cuyo día (getDay: 0=domingo…6=sábado) esté en days. */
function nextOccurrenceAt(hh, mm, days, fromMs = Date.now()) {
  if (!days || days.length === 0) return null;
  for (let i = 0; i < 9; i++) {
    const d = new Date(fromMs);
    d.setDate(d.getDate() + i);
    if (days.includes(d.getDay())) {
      const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
      if (cand.getTime() >= fromMs) return cand.getTime();
    }
  }
  return null;
}
function daysLabelFor(days) {
  if (!days || days.length === 0) return '';
  if (days.length === 7) return ' · Todos los días';
  return ' · ' + days.map((d) => DAY_LETTERS[d]).join(' · ');
}

// Tira semanal (L M X J V S D) con los días marcados de la rutina. Solo
// existe en la APK (la web no guarda días): muestra de un vistazo qué días
// se repite el recordatorio.
function weekStripEl(days) {
  const wrap = document.createElement('span');
  wrap.className = 'week-strip';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', 'Días de la rutina');
  DAY_LETTERS.forEach((letter, i) => {
    const cell = document.createElement('span');
    cell.className = 'ws-cell' + (days.includes(i) ? ' on' : '');
    cell.textContent = letter;
    wrap.appendChild(cell);
  });
  return wrap;
}

// La rutina (repetición por días) es EXCLUSIVA de la APK: solo el reloj del
// sistema puede reprogramar alarmas con la app cerrada. En web/PWA los días
// siempre se ignoran (recordatorio de una sola vez).
function isNativeAlarmOwner() {
  const b = nativeAudio();
  return alarmOwnerForPlatform(mergedCapabilities().platformKind, !!(b && b.scheduleAlarm)) === 'native';
}

function alarmConfig() {
  const st = alarmPreset();
  const minutes = parseInt(alarmMinutes.value, 10) || 0;
  const days = isNativeAlarmOwner() ? alarmDaysSelected() : [];
  if (st.custom) {
    return {
      name: 'Personalizado',
      freq: parseFloat(alarmBase.value) || 220,
      beat: parseFloat(alarmBeat.value) || 10,
      wave: alarmWave.value || 'sine',
      minutes,
      days,
    };
  }
  return { name: st.name, freq: st.base, beat: st.beat, wave: 'sine', minutes, days };
}

// P2 — propietario único de alarmas por plataforma (I6): en la APK la alarma
// la dispara el AlarmManager NATIVO del SO (sobrevive app cerrada, pantalla
// bloqueada y reboot vía BootReceiver); el scheduler web solo la conserva
// para la lista de la UI, marcada `external` para que NUNCA dispare en
// paralelo (no hay doble alarma ni doble notificación). En Web/PWA el
// scheduler web es el único dueño.
function scheduleNativeAlarm(alarm) {
  const b = nativeAudio();
  // P2 — decisión PURA del dueño (I6): solo el APK con bridge real es dueño
  // nativo; Web/PWA usan el scheduler web. Nunca ambos (un solo disparador).
  if (alarmOwnerForPlatform(mergedCapabilities().platformKind, !!(b && b.scheduleAlarm)) !== 'native') {
    return false;
  }
  const r = b.scheduleAlarm({
    alarmId: alarm.id,
    title: `Sesión ${Math.round(alarm.freq)} Hz`,
    body: `${alarm.name} · ${Math.round(alarm.freq)} Hz · ${alarm.beat} Hz`,
    atMs: alarm.nextAt,
    days: alarm.days && alarm.days.length ? alarm.days : undefined,
    // Deep link: al tocar la notificación, la app abre esta frecuencia exacta
    // en vez de la pantalla por defecto (paridad con las alarmas sincronizadas
    // desde la cuenta — ver AndroidBridge.kt SCHEDULE_ALARM).
    freq: alarm.freq,
    beat: alarm.beat,
    wave: alarm.wave || 'sine',
  });
  return !!(r && r.ok);
}
function cancelNativeAlarm(alarmId) {
  const b = nativeAudio();
  if (b && b.cancelAlarm) b.cancelAlarm(alarmId);
}
function cancelAlarmBoth(alarmId) {
  // P6-FEAT-001 — borrar también la copia en la nube (best-effort).
  const stored = getAlarms().find((a) => a.id === alarmId);
  if (stored && stored.cloudId && getAccessToken()) {
    deleteAlarm(stored.cloudId).catch(() => {});
  }
  cancelNativeAlarm(alarmId);
  alarmManager.cancel(alarmId);
}

alarmSave.addEventListener('click', async () => {
  const time = alarmTime.value || defaultAlarmTime();
  const cfg = alarmConfig();
  const days = cfg.days && cfg.days.length ? cfg.days : [];
  const [hh, mm] = time.split(':').map(Number);
  const nextAt = days.length
    ? nextOccurrenceAt(hh, mm, days) || nextAlarmAt(time).getTime()
    : nextAlarmAt(time).getTime();
  const alarm = {
    id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    time,
    ...cfg,
    days,
    nextAt,
  };
  // APK: el dueño real es el AlarmManager nativo; el web queda como espejo
  // de la UI (external → nunca dispara). Web/PWA: dueño web.
  const nativeOwned = scheduleNativeAlarm(alarm);
  if (nativeOwned) alarm.external = true;
  await alarmManager.create(alarm);
  // P6-FEAT-001 — sincronizar al backend con sesión: el recordatorio vive en
  // la nube y el scheduler server-side envía el Web Push a la hora exacta
  // aunque la app esté cerrada. Best-effort (nunca rompe la alarma local).
  if (getAccessToken()) {
    let timezone = 'UTC';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_) {
      /* sin zona del navegador */
    }
    createAlarm({
      name: alarm.name || 'Recordatorio',
      enabled: true,
      scheduled_at: new Date(alarm.nextAt).toISOString(),
      timezone,
      config: {
        freq: alarm.freq,
        beat: alarm.beat,
        wave: alarm.wave || 'sine',
        minutes: alarm.minutes || 0,
        // El id LOCAL identifica la notificación: el push del backend usa el
        // mismo tag que la notificación local → el navegador la REEMPLAZA y
        // no se muestran dos avisos cuando la app está abierta.
        localId: alarm.id,
      },
      repeat_rule: days.length ? rruleFor(days) : null,
      notification_enabled: true,
    })
      .then((created) => {
        // Recordar el id del backend en la copia local para poder borrarla.
        if (created && created.id) {
          alarm.cloudId = created.id;
          saveAlarms(getAlarms().map((a) => (a.id === alarm.id ? alarm : a)));
        }
      })
      .catch(() => {
        /* sin sesión válida / sin red: la alarma sigue local */
      });
  }
  renderAlarms();
  showToast(
    days.length
      ? `Rutina guardada: ${time}${daysLabelFor(days)}`
      : `Recordatorio guardado para las ${time}`,
  );
  const perm = await requestPermission();
  if (perm !== 'granted' && perm !== 'unsupported') {
    showToast('Activá las notificaciones o usá el respaldo de calendario');
  }
  refreshAlarmPerm();
});

function renderAlarms() {
  const alarms = getAlarms().slice().sort((a, b) => a.nextAt - b.nextAt);
  alarmListWrap.classList.toggle('hidden', alarms.length === 0);
  alarmList.innerHTML = '';
  const today = new Date().toDateString();
  alarms.forEach((a) => {
    const li = document.createElement('li');
    li.className = 'alarm-item';
    const when = new Date(a.nextAt);
    const extra = when.toDateString() === today ? '' : ` · ${when.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`;
    const info = document.createElement('span');
    info.className = 'alarm-item-info';
    const b = document.createElement('b');
    b.textContent = a.name;
    const small = document.createElement('small');
    small.textContent = `${a.time}${daysLabelFor(a.days)}${extra} · ${Math.round(a.freq)} Hz · ${a.beat} Hz`;
    info.append(b, small);
    if (a.days && a.days.length) info.appendChild(weekStripEl(a.days));
    const del = document.createElement('button');
    del.className = 'alarm-del';
    del.setAttribute('aria-label', 'Eliminar recordatorio');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      cancelAlarmBoth(a.id);
      renderAlarms();
    });
    li.append(info, del);
    alarmList.appendChild(li);
  });
  // Vista en la página: lista visible + botón para agregar + badge de la campana.
  // Sin sesión la campana está bloqueada: la vista no se muestra (gating).
  if (alarmView && alarmViewList) {
    alarmView.classList.toggle('hidden', alarms.length === 0 || !getAccessToken());
    alarmViewList.innerHTML = '';
    alarms.forEach((a) => {
      const li = document.createElement('li');
      li.className = 'alarm-view-item';
      const info = document.createElement('span');
      info.className = 'alarm-view-info';
      const b = document.createElement('b');
      b.textContent = a.name;
      const small = document.createElement('small');
      small.textContent = `${a.time} · ${Math.round(a.freq)} Hz · ${a.beat} Hz`;
      info.append(b, small);
      if (a.days && a.days.length) info.appendChild(weekStripEl(a.days));
      const del = document.createElement('button');
      del.className = 'alarm-del';
      del.setAttribute('aria-label', 'Eliminar recordatorio');
      del.textContent = '✕';
      del.addEventListener('click', () => {
        cancelAlarmBoth(a.id);
        renderAlarms();
      });
      li.append(info, del);
      alarmViewList.appendChild(li);
    });
  }
  if (alarmBadge) {
    alarmBadge.textContent = String(alarms.length);
    alarmBadge.classList.toggle('hidden', alarms.length === 0 || !getAccessToken());
  }
  syncAppBadge(alarms.length);
  updateAlarmGating();
}

// Insignia en el icono de la app instalada (como una app nativa): muestra la
// cantidad de recordatorios pendientes. Solo aplica a la PWA instalada y a
// los navegadores que la soportan.
function syncAppBadge(count) {
  try {
    if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count).catch(() => {});
    else if (count === 0 && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch (_) {
    /* sin insignias en este navegador */
  }
}

// La vista en la página abre el modal para agregar o editar recordatorios.
if (alarmViewAdd) alarmViewAdd.addEventListener('click', openAlarmModal);

// Estado inicial del bloqueo por sesión (la campana arranca bloqueada si no
// hay sesión guardada; renderAlarms() la re-evalúa en cada render).
updateAlarmGating();

// P4 — permiso denegado en Android: abre los ajustes de notificaciones de la
// app (OPEN_NOTIFICATION_SETTINGS, whitelisted). En web no aplica (el botón
// solo se muestra con el bridge presente y el permiso nativo denegado).
const alarmPermSettings = document.getElementById('alarm-perm-settings');
if (alarmPermSettings) {
  alarmPermSettings.addEventListener('click', () => {
    const b = nativeAudio();
    if (b && b.openNotificationSettings) {
      b.openNotificationSettings();
      showToast('Abriendo los ajustes de notificaciones…');
    }
  });
}

// P5 — alarmas exactas denegadas por Android 14+: abre el diálogo del sistema
// (REQUEST_EXACT_ALARM_PERMISSION, whitelisted). Sin este permiso la alarma
// es aproximada (±1 min); con él, exacta.
const alarmExactSettings = document.getElementById('alarm-exact-settings');
if (alarmExactSettings) {
  alarmExactSettings.addEventListener('click', () => {
    const b = nativeAudio();
    if (b && b.requestExactAlarmPermission) {
      b.requestExactAlarmPermission();
      showToast('Abriendo el ajuste de alarmas exactas…');
    }
  });
}

// Respaldo de calendario: aplican a la configuración actual del modal. En una
// rutina (con días) se calcula la próxima ocurrencia real y el evento repite
// en el calendario (RRULE en .ics / recur en Google Calendar).
function calendarConfig() {
  const cfg = alarmConfig();
  const time = alarmTime.value || defaultAlarmTime();
  const [hh, mm] = time.split(':').map(Number);
  const days = cfg.days && cfg.days.length ? cfg.days : [];
  const nextAt = days.length
    ? nextOccurrenceAt(hh, mm, days) || nextAlarmAt(time).getTime()
    : nextAlarmAt(time).getTime();
  return { ...cfg, time, days, nextAt };
}
alarmGcal.addEventListener('click', (e) => {
  const cfg = calendarConfig();
  e.currentTarget.href = buildGoogleCalendarUrl(cfg);
});
alarmIcs.addEventListener('click', () => {
  downloadIcs(calendarConfig());
});

// ── Sistema de recordatorios (P0: AlarmManager + NotificationManager) ────────
// AlarmManager es la ÚNICA autoridad: scheduler único, persistencia durable
// (IndexedDB + espejo localStorage), multi-tab (Web Locks / BroadcastChannel)
// y estados que impiden disparos duplicados. NotificationManager elige el
// provider real (Service Worker → Local → respaldo de calendario); Push está
// desactivado (sin backend) y la UI lo declara honestamente.
const notificationManager = createNotificationManager({
  notificationSupported,
  permissionsDisabled,
  swReady,
  permissionState: () =>
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  showSwNotification,
  showLocalNotification,
  // Estado real del backend de push (consultado en initBackendIfConfigured).
  pushConfigured: !!(getCachedPushStatus() && getCachedPushStatus().configured),
});

const alarmManager = new AlarmManager({
  onFire: (alarm) => {
    // La alarma SIEMPRE intenta una notificación real del sistema, en primer
    // plano o en segundo plano: una alarma que solo suena sin nada visible no
    // es una alarma (el chime es el complemento audible, no el aviso). En
    // segundo plano la notificación es el aviso (y puede sonar/vibrar según
    // la plataforma); en primer plano se muestra igual en la sombra del
    // sistema y el chime refuerza. Si la notificación no se pudo mostrar
    // (permiso denegado / sin soporte), el chime queda como respaldo.
    // NUNCA arranca una sesión: una notificación no crea audio (Fase 21).
    const res = notificationManager.notify(alarm);
    const shown = !!(res && res.shown);
    if (document.hidden) {
      if (!shown) playChime();
      return;
    }
    // Primer plano: notificación real (arriba) + chime audible + estado
    // CONFIGURADO con la frecuencia exacta (P5.6 B1: la alarma avisa, nunca
    // arranca el reproductor).
    playChime();
    showToast(`¡Hora de tu sesión de ${Math.round(alarm.freq)} Hz!`);
    const custom = STATES.find((s) => s.custom);
    customBase.value = String(Math.round(alarm.freq * 10) / 10);
    customBeat.value = String(alarm.beat);
    selectedWave = alarm.wave || 'sine';
    selectState(custom);
    updateCustomLabels();
    syncWaveButtons();
    updateCustomPanel();
    updateCarrierWarning();
    updateStatus();
    if (alarm.minutes > 0) {
      timerMinutes = alarm.minutes;
      timerOptions.querySelectorAll('.timer-btn').forEach((btn) =>
        btn.classList.toggle('active', parseInt(btn.dataset.minutes, 10) === alarm.minutes),
      );
    }
    // P5.6 (B1) — la alarma AVISA pero NO arranca el reproductor: se eliminó
    // el start() automático (violaba la regla de oro: el disparo de una
    // alarma no es una causa de PLAY). El estado queda configurado con la
    // frecuencia exacta; el usuario toca play.
    if (!playing) showToast('Tu sesión está lista — toca play para comenzar 🎧');
    // P5 — rutina en Web/PWA: si la alarma tiene días de repetición, se
    // reprograma la siguiente ocurrencia (mientras la página esté viva;
    // con la pestaña cerrada no puede sonar: límite honesto del navegador).
    if (alarm.days && alarm.days.length) {
      const [h, m] = String(alarm.time || '').split(':').map(Number);
      const nextAt = nextOccurrenceAt(h, m, alarm.days);
      if (nextAt) {
        alarmManager.create({ ...alarm, id: alarm.id, nextAt }).catch(() => {});
      }
    }
  },
  onSync: renderAlarms,
  channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vyneural-alarms') : null,
  locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
});
window.__alarmManager = alarmManager;
window.__notificationManager = notificationManager;

// Persistencia durable sin bloquear el arranque: el scheduler ya corre con el
// espejo localStorage; al abrir IndexedDB se migra y se re-sincroniza.
createDurableStore()
  .then((store) => {
    alarmManager.store = store;
    return alarmManager.init();
  })
  .then(renderAlarms)
  .catch(() => {});

// Diagnóstico honesto de notificaciones (Fase 24): expone el estado REAL de
// cada capacidad, no etiquetas. Depurable en window.__notificationDiagnostics().
window.__notificationDiagnostics = async () => {
  const caps = detectNotificationCapabilities({
    pushConfigured: !!(getCachedPushStatus() && getCachedPushStatus().configured),
  });
  const am = window.__alarmManager;
  const reg = typeof navigator !== 'undefined' && navigator.serviceWorker
    ? await navigator.serviceWorker.getRegistration().catch(() => null)
    : null;
  return {
    permission: caps.notifications.permission,
    notificationSupport: caps.notifications.supported,
    notificationActions: caps.notifications.actions,
    serviceWorker: caps.serviceWorker.supported,
    swRegistered: !!reg,
    pushSupport: caps.push.supported,
    pushConfigured: caps.push.configured,
    calendarSupport: caps.calendar,
    backgroundScheduling: caps.backgroundScheduling,
    alarmCount: am ? am.list().length : 0,
    activeScheduler: am ? am.activeScheduler : 'none',
    lastAlarm: am ? am.lastAlarm : null,
    lastNotification: am ? am.lastNotification : null,
    lastError: am ? am.lastError : null,
    providerStatus: window.__notificationManager ? window.__notificationManager.status() : null,
    summary: capabilitySummary(caps),
  };
};

// Sonda de plataforma para la matriz de compatibilidad en dispositivo real
// (docs/compatibility-matrix.md). Recoge TODO lo que la matriz necesita desde
// el propio dispositivo: abrir la consola, correr `await window.__platformProbe()`
// y pegar el JSON como evidencia de cada celda de la fila del dispositivo.
window.__platformProbe = async () => {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = nav ? nav.userAgent : null;
  const uaData = nav && nav.userAgentData
    ? {
        platform: nav.userAgentData.platform,
        mobile: nav.userAgentData.mobile,
        brands: nav.userAgentData.brands ? nav.userAgentData.brands.map((b) => `${b.brand} ${b.version}`) : null,
      }
    : null;
  let displayMode = 'browser';
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) displayMode = 'standalone';
    else if (window.matchMedia('(display-mode: fullscreen)').matches) displayMode = 'fullscreen';
    else if (window.matchMedia('(display-mode: minimal-ui)').matches) displayMode = 'minimal-ui';
  } catch {
    /* sin matchMedia */
  }
  const caps = detectNotificationCapabilities({
    pushConfigured: !!(getCachedPushStatus() && getCachedPushStatus().configured),
  });
  const probe = typeof window.__audioProbe === 'function' ? window.__audioProbe() : null;
  const stats = probe && probe.stats;
  const transport = probe && probe.transport;
  const swReg = nav && nav.serviceWorker ? await nav.serviceWorker.getRegistration().catch(() => null) : null;
  const am = window.__alarmManager;
  return {
    capturedAt: new Date().toISOString(),
    device: {
      ua,
      platform: uaData ? uaData.platform : null,
      mobile: uaData ? uaData.mobile : null,
      isIOS: isIos(),
      isAndroid: /Android/i.test(ua || ''),
      touch: nav ? nav.maxTouchPoints > 0 : false,
      displayMode,
      standalone: displayMode === 'standalone' || nav.standalone === true,
    },
    audio: stats
      ? {
          ctxState: stats.ctxState,
          sampleRate: stats.sampleRate,
          rms: stats.rms,
          gain: stats.gain,
          oscillatorCount: stats.oscillatorCount,
          transportMode: transport ? transport.mode : null,
          fallbackApplied: transport ? transport.fallbackApplied : null,
          elementPaused: transport ? transport.elementPaused : null,
          elementCurrentTime: transport ? transport.elementCurrentTime : null,
          elementError: transport ? transport.elementError : null,
          hasMediaStreamDestination: transport ? transport.hasMediaStreamDestination : null,
        }
      : null,
    mediaSession: {
      supported: caps.mediaSession.supported,
      playbackState: nav && nav.mediaSession ? nav.mediaSession.playbackState : null,
    },
    wakeLock: {
      supported: !!(nav && 'wakeLock' in nav),
      active: !!(_wakeLock && !_wakeLock.released),
    },
    notifications: {
      permission: caps.notifications.permission,
      actions: caps.notifications.actions,
    },
    serviceWorker: { registered: !!swReg, scope: swReg ? swReg.scope : null },
    push: { supported: caps.push.supported, configured: caps.push.configured },
    badges: { setAppBadge: !!(nav && nav.setAppBadge) },
    alarms: am ? { count: am.list().length, scheduler: am.activeScheduler } : null,
    visual: {
      // Frecuencia suavizada con la que dibujan las ondas y la placa (τ=1,5 s)
      // vs. la frecuencia real del motor: durante una transición se ven
      // valores intermedios; en reposo coinciden.
      smoothedBase: Math.round(visBase * 10) / 10,
      smoothedBeat: Math.round(visBeat * 10) / 10,
      targetBase: Math.round((isFinite(currentParams().base) ? currentParams().base : visBase) * 10) / 10,
      targetBeat: Math.round((isFinite(currentParams().beat) ? currentParams().beat : visBeat) * 10) / 10,
    },
    // P0 — Bridge nativo (APK): presente solo cuando el shell Android inyectó
    // window.AndroidBridge. Sin APK, la web sigue siendo el único proveedor.
    platform: {
      runtime: nativeBridge.platform, // 'web' | 'android'
      kind: mergedCapabilities().platformKind, // desktop|android-browser|android-native|ios|unknown
      bridge: nativeBridge.getState(),
    },
    capabilities: {
      notifications: mergedCapabilities().notifications,
      backgroundAudio: mergedCapabilities().backgroundAudio,
      exactAlarms: mergedCapabilities().exactAlarms,
      mediaSession: mergedCapabilities().mediaSession,
    },
  };
};

// Vista inicial: sincroniza la lista y el badge con las alarmas guardadas
// (el primer tick del manager descarta las vencidas).
renderAlarms();

// ---------------------------------------------------------------- Arranque
// Deep link: ?state=meditacion abre directamente ese estado (tiene prioridad
// sobre la sesión guardada para que compartir funcione).
const deepParams = new URLSearchParams(location.search);
const deepState = deepParams.get('state');
// Deep link de portadora: ?carrier=solfeggio/ancestral/schumann/personalizado
// marca la familia directamente. Por compatibilidad con enlaces antiguos,
// ?f1=528 / ?f1=136.1 / ?f1=194.7 se interpretan como esas familias, y
// cualquier otro f1 como portadora personalizada.
const deepCarrier = deepParams.get('carrier');
const deepF1 = parseFloat(deepParams.get('f1'));
if (deepCarrier && deepCarrier in CARRIER_BASE && deepCarrier !== 'estandar') {
  carrier = deepCarrier;
  // En la portadora personalizada el f1 viaja en la URL; las familias
  // fijas (Solfeggio/Ancestral) derivan la base del estado al cargar.
  if (deepCarrier === 'personalizado' && isFinite(deepF1) && deepF1 > 0) {
    customBase.value = String(Math.round(deepF1));
    customBaseLabel.textContent = `Portada: ${Math.round(deepF1)} Hz`;
  }
} else if (deepF1 === 528) carrier = 'solfeggio';
else if (deepF1 === 963) carrier = 'solfeggio963';
else if (deepF1 === 136.1) carrier = 'ancestral';
else if (deepF1 === 194.7) carrier = 'schumann';
else if (isFinite(deepF1) && deepF1 > 0) {
  carrier = 'personalizado';
  customBase.value = String(Math.round(deepF1));
  customBaseLabel.textContent = `Portada: ${Math.round(deepF1)} Hz`;
}
// P3 — la sesión se sanitiza ANTES de restaurar: un localStorage corrupto
// (NaN, fuera de rango) nunca rompe la restauración ni deja la UI en un
// estado imposible.
const savedSession = sanitizeSession(lsGet(LS_SESSION, null));
// Deep link de alarma: ?freq={base}&beat={ritmo}&wave={onda}&autostart=true
// configura el estado personalizado con la frecuencia exacta del recordatorio.
const deepFreq = parseFloat(deepParams.get('freq'));
const deepBeat = parseFloat(deepParams.get('beat'));
const deepWave = deepParams.get('wave');
const deepAutostart = deepParams.get('autostart') === 'true';
// Ambiente elegido al personalizar la frecuencia en /rutina (ver
// freqAmbient en rutina.js) — mismos ids que el mezclador de acá.
const AMBIENT_IDS = ['lluvia', 'rio', 'bosque', 'pajaros', 'oceano', 'fuego'];
const deepAmbient = (deepParams.get('ambient') || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => AMBIENT_IDS.includes(s));
// Deep link de itinerario (rutina unificada): ?seq={json} — {name, steps}.
// Cada paso trae base/beat/wave/dur. Se sanitiza TODO (viene de la URL);
// nunca autoplay: la secuencia queda en pausa esperando el play del usuario.
const deepSeqRaw = deepParams.get('seq');
let deepSeq = null;
if (deepSeqRaw) {
  try {
    const d = JSON.parse(deepSeqRaw);
    const steps = (Array.isArray(d.steps) ? d.steps : [])
      .slice(0, 60)
      .map((s) => ({
        name: typeof s.n === 'string' ? s.n.slice(0, 60) : '',
        base: isFinite(s.base) && s.base > 0 && s.base <= 1000 ? +s.base : 220,
        beat: isFinite(s.beat) && s.beat >= 0 && s.beat <= 499 ? +s.beat : 10,
        wave: ['sine', 'triangle', 'square', 'sawtooth'].includes(s.wave) ? s.wave : 'sine',
        dur: isFinite(s.dur) && s.dur > 0 ? +s.dur : 0,
      }))
      .filter((s) => s.dur > 0);
    if (steps.length) {
      deepSeq = {
        name: typeof d.name === 'string' && d.name ? d.name.slice(0, 80) : 'Rutina',
        steps,
      };
    }
  } catch (_) {
    deepSeq = null;
  }
}
const customState = STATES.find((s) => s.custom);
let wantId = deepState || (savedSession && savedSession.state);
if (isFinite(deepFreq) && deepFreq > 0) {
  customBase.value = String(Math.round(deepFreq * 10) / 10);
  customBeat.value = String(deepBeat > 0 ? Math.round(deepBeat * 10) / 10 : 10);
  selectedWave = deepWave || 'sine';
  wantId = customState ? customState.id : wantId;
}
const initial = STATES.find((s) => s.id === wantId) || STATES[0];
restoreSession(savedSession);
// Ambiente del deep link: DESPUÉS de restoreSession (que si no, lo pisa con
// lo guardado localmente — un array vacío en la sesión guardada es igual de
// válido que uno con datos para Array.isArray, así que el orden importa).
// Solo pisa el ambiente local si el enlace trae uno propio: una frecuencia
// personalizada SIN ambiente no debe silenciar el que ya tenías puesto acá.
if (isFinite(deepFreq) && deepFreq > 0 && deepAmbient.length) {
  ambientTypes = new Set(deepAmbient);
}
selectState(initial);
// El filtro arranca en la vista curada 'Destacados' (los más populares), o en
// el filtro que el usuario dejó guardado. Si el enlace profundo o la sesión
// abren otro estado, seguir a su objetivo.
const savedGoal = savedSession && savedSession.goal;
const validGoals = [...goalFilter.querySelectorAll('.band-chip')].map((c) => c.dataset.goal);
// Solo cuenta como deep link explícito si viene de una alarma (?freq=…), de
// una portadora con f1 fija, o de un estado distinto al de la sesión guardada
// (los enlaces que la propia app reescribe en la URL al recargar no deben
// descartar el filtro guardado).
const deepLinked =
  isFinite(deepF1) ||
  isFinite(deepFreq) ||
  Boolean(deepAutostart) ||
  (Boolean(deepState) && (!savedSession || deepState !== savedSession.state));
const initialGoal =
  !deepLinked && validGoals.includes(savedGoal)
    ? savedGoal
    : initial.featured
      ? 'destacados'
      : goalOf(initial).id;
const goalChips = [...goalFilter.querySelectorAll('.band-chip')];
goalChips.forEach((c) => c.classList.toggle('active', c.dataset.goal === initialGoal));
applyGoalFilter(initialGoal);
updateCustomLabels();
syncWaveButtons();
// Marca la portadora activa (fila principal y modo girado) y muestra el panel.
syncCarrierChips();
// Rutina secuencial desde la vista Tu rutina: configura el primer paso y
// muestra la barra EN PAUSA — el audio nace solo con un play del usuario.
if (deepSeq) {
  seq = deepSeq;
  applySeqStep(0);
}
updateCustomPanel();
updateCarrierWarning();
updateAmbientButtons();
updateHistory();

// Inicio rápido: solo en la primera visita, sin deep link ni sesión guardada.
// (savedSession se leyó antes de selectState(), que sí guarda una sesión).
if (!(deepState || deepF1 || deepCarrier || isFinite(deepFreq)) && !savedSession && !lsGet(LS_QUICK, null)) {
  showQuickstart();
}

// Recordatorio pendiente: si abrís la web/APK SIN tocar la notificación (la
// cerraste, no llegó, el permiso estaba apagado, etc.) y ya había una alarma
// vencida, dejarla lista para reproducir en vez de silencio — mismo criterio
// que un deep link de notificación (freq/beat/wave), nunca autoplay. Si ya
// venís de un deep link explícito (?freq=… o ?seq=…), esa alarma YA es la
// que abriste: no hay nada "pendiente" que buscar además.
async function checkPendingReminder() {
  const now = Date.now();
  const local = getAlarms()
    .filter((a) => a.nextAt && a.nextAt <= now && a.freq > 0)
    .sort((a, b) => a.nextAt - b.nextAt)[0];
  let pending = local
    ? { name: local.name, freq: local.freq, beat: local.beat, wave: local.wave }
    : null;
  if (!pending && getAccessToken()) {
    try {
      const serverAlarms = await listServerAlarms();
      // Render free duerme el proceso con inactividad: send_due_reminders()
      // corre recién cuando algo lo despierta, y en ese mismo tick YA
      // reprograma scheduled_at al próximo turno (haya llegado el push o
      // no) — para cuando abrís la app, "vencida" (scheduled_at <= now) ya
      // no es cierto aunque nunca hayas visto el aviso. last_fired_at (el
      // momento real del último intento) es la única pista que queda; se le
      // da una ventana de gracia generosa porque el dyno puede tardar horas
      // en despertar si estuvo mucho tiempo inactivo.
      const GRACE_MS = 24 * 60 * 60 * 1000;
      const dueAt = (a) => {
        const sch = a.scheduled_at ? new Date(a.scheduled_at).getTime() : null;
        if (sch !== null && sch <= now) return sch;
        const fired = a.last_fired_at ? new Date(a.last_fired_at).getTime() : null;
        return fired !== null && now - fired <= GRACE_MS ? fired : null;
      };
      const due = (serverAlarms || [])
        .filter((a) => a.enabled && dueAt(a) !== null)
        .sort((a, b) => dueAt(a) - dueAt(b))[0];
      if (due && due.config && due.config.freq > 0) {
        pending = { name: due.name, freq: due.config.freq, beat: due.config.beat, wave: due.config.wave };
      }
    } catch (_) {
      /* sin red: no bloquea la carga normal, se reintenta la próxima visita */
    }
  }
  if (!pending) return;
  customBase.value = String(Math.round(pending.freq * 10) / 10);
  customBeat.value = String(pending.beat > 0 ? Math.round(pending.beat * 10) / 10 : 10);
  selectedWave = pending.wave || 'sine';
  const customState = STATES.find((s) => s.custom);
  if (customState) selectState(customState);
  updateCustomLabels();
  syncWaveButtons();
  updateCustomPanel();
  syncCarrierChips();
  showToast(`⏰ Tenías pendiente: ${pending.name || 'un recordatorio'} — tocá play cuando quieras`);
}
if (!isFinite(deepFreq) && !deepSeq) {
  checkPendingReminder();
}

// Permisos: acceso directo desde el navbar de otra página (⋯ → Permisos, ver
// src/ui/auth.js) — llega acá con #permisos y se abre el mismo modal que el
// menú ⋯ del reproductor, en vez de un destino separado.
if (location.hash === '#permisos') {
  history.replaceState(null, '', location.pathname + location.search);
  openPermissions();
}

// Deep link de alarma (?autostart=true): P5.6 (C1) — NO arranca audio en la
// carga de página (violaba la regla de oro: page load no es una causa de
// PLAY). Solo deja el estado configurado con la frecuencia de la alarma; el
// play queda en manos del usuario (no se depende de que el navegador bloquee
// el autoplay).
if (deepAutostart && isFinite(deepFreq) && deepFreq > 0 && !playing) {
  showToast('Tu sesión está lista — toca play para comenzar 🎧');
}

// P4-B — re-sincronización con la sesión nativa al cargar la página: navegar
// dentro de la APK recarga el JS sin detener el audio. Si el servicio nativo
// sigue sonando, la UI se alinea (nunca inventa estado ni re-arranca la
// sesión). Se omite con autostart (start() configura la sesión de la alarma).
if (!deepAutostart) {
  syncUiWithNativeSession();
}

// Registro del service worker para la PWA (solo en producción y solo sobre http/https:
// dentro de la APK la página vive en file://, donde no hay service worker).
if (
  'serviceWorker' in navigator &&
  /^https?:$/.test(location.protocol) &&
  location.hostname !== 'localhost'
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Solo para el arranque: un cold start de Render (20-50s) hacía que el
// ÚNICO intento de initBackendIfConfigured() (push + sync de favoritos/
// frecuencias/alarmas/itinerarios) fallara con un error de red — sin
// reintentos, la sincronización quedaba rota hasta el próximo reload,
// aunque el backend respondiera segundos después. Mismo bug y mismo fix
// que refreshProfileOnBoot() (ui/auth.js), loadCommentsOnBoot()
// (comments.js), loadAllOnBoot() (cuenta.js) y loadItinerariesOnBoot()
// (rutina.js). Sin backend configurado (modo 100% offline),
// initBackendIfConfigured() ya devuelve false al instante sin tocar la red
// (ver backendEnabled() en api/integration.js) — reintentarlo unas veces
// más ahí es inofensivo (solo llamadas síncronas, sin fetch de más).
async function initBackendOnBoot() {
  const RETRY_DELAYS_MS = [3000, 6000, 12000, 20000]; // ~41s de cobertura
  for (let attempt = 0; ; attempt++) {
    const ok = await initBackendIfConfigured().catch(() => false);
    if (ok || attempt >= RETRY_DELAYS_MS.length) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}
window.addEventListener('load', () => {
  initBackendOnBoot()
    .then(() => {
      // La consulta real de push puede terminar después de abrir el modal:
      // actualizar el texto honesto y las capacidades cuando llegue.
      refreshAlarmPerm();
    })
    .catch(() => {});
});

// Loader animado: se desvanece cuando la página terminó de cargar, con un
// mínimo de 2.2 s para que se disfruten las animaciones.
const loader = document.getElementById('loader');
const loadStart = performance.now();
const LOADER_MIN_MS = 2200;

// Partículas flotantes del fondo del loader.
if (loader) {
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('span');
    p.className = 'fp';
    const s = 2 + Math.random() * 4;
    p.style.width = p.style.height = `${s}px`;
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${4 + Math.random() * 7}s`;
    p.style.animationDelay = `${Math.random() * 6}s`;
    loader.appendChild(p);
  }
}

// Fondo animado del loader: estrellas que viajan hacia el espectador con
// parpadeo — movimiento garantizado mientras carga.
const loaderStars = document.getElementById('loader-stars');
if (loaderStars) {
  const lctx = loaderStars.getContext('2d');
  let lsw = 0;
  let lsh = 0;
  const lstars = [];
  function lsResize() {
    lsw = loaderStars.width = window.innerWidth;
    lsh = loaderStars.height = window.innerHeight;
    lstars.length = 0;
    for (let i = 0; i < 110; i++) {
      lstars.push({
        x: Math.random() * lsw,
        y: Math.random() * lsh,
        z: Math.random(),
        s: Math.random() * 2.2 + 0.5,
        a: Math.random() * 0.5 + 0.3,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }
  lsResize();
  window.addEventListener('resize', lsResize);
  function lsFrame() {
    if (!document.getElementById('loader')) return;
    lctx.clearRect(0, 0, lsw, lsh);
    for (const st of lstars) {
      st.z += 0.006;
      if (st.z > 1) st.z = 0;
      st.tw += 0.06;
      const scale = 1 + st.z * 2.2;
      const x = st.x + (st.x - lsw / 2) * (scale - 1) * 0.05;
      const y = st.y + (st.y - lsh / 2) * (scale - 1) * 0.05;
      const alpha = st.a * (1 - st.z * 0.55) * (0.6 + 0.4 * Math.sin(st.tw));
      lctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      lctx.beginPath();
      lctx.arc(x, y, st.s * (0.5 + st.z), 0, Math.PI * 2);
      lctx.fill();
    }
    requestAnimationFrame(lsFrame);
  }
  requestAnimationFrame(lsFrame);
}

// Barra de progreso sincronizada con la duración mínima del loader.
const loaderFill = document.getElementById('loader-fill');
const loaderPct = document.getElementById('loader-pct');
if (loaderFill) {
  const progTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - loadStart) / LOADER_MIN_MS);
    const pct = Math.round(k * 100);
    loaderFill.style.width = `${pct}%`;
    if (loaderPct) loaderPct.textContent = `${pct}%`;
    if (k >= 1) clearInterval(progTimer);
  }, 33);
}

function hideLoader() {
  if (!loader || loader.classList.contains('done')) return;
  const remain = Math.max(0, LOADER_MIN_MS - (performance.now() - loadStart));
  setTimeout(() => {
    loader.classList.add('done');
    setTimeout(() => loader.remove(), 900);
  }, remain);
}

// ── HUD en vivo (tecla D / menú ⋯ → Rendimiento y FPS) ────────────────────
// Panel flotante con FPS, estado del motor de audio, proveedor único, wake
// lock, lifecycle y el registro de interferencias en tiempo real. Se abre con
// la tecla D o desde el menú ⋯ (sin botón flotante — P1.5 Fase 15); el estado
// de apertura persiste en localStorage.
const LS_HUD = 'vyneural_hud_v1';
let hudEl = null;
function byId(id) {
  return document.getElementById(id);
}
function buildHud() {
  if (hudEl || !document.body) return;
  const wrap = document.createElement('div');
  wrap.id = 'hud';
  wrap.className = 'hud' + (lsGet(LS_HUD, false) ? '' : ' collapsed');
  wrap.innerHTML = `
    <button class="hud-close" aria-label="Cerrar HUD">✕</button>
    <div class="hud-title">HUD · <span id="hud-lifecycle">…</span></div>
    <div class="hud-grid">
      <span>FPS</span><b id="hud-fps">—</b>
      <span>Frame</span><b id="hud-frame">—</b>
      <span>Mem JS</span><b id="hud-mem">—</b>
      <span>Audio</span><b id="hud-ctx">—</b>
      <span>Osc</span><b id="hud-osc">—</b>
      <span>RMS</span><b id="hud-rms">—</b>
      <span>Transport</span><b id="hud-transport">—</b>
      <span>Provider</span><b id="hud-provider">—</b>
      <span>WakeLock</span><b id="hud-wakelock">—</b>
      <span>Estado</span><b id="hud-state">—</b>
    </div>
    <ol class="hud-log" id="hud-log"></ol>
  `;
  document.body.appendChild(wrap);
  wrap.querySelector('.hud-close').addEventListener('click', () => {
    wrap.classList.add('collapsed');
    lsSet(LS_HUD, false);
  });
  hudEl = wrap;
  // Actualiza el HUD solo mientras está abierto (500 ms).
  setInterval(() => {
    if (!hudEl || hudEl.classList.contains('collapsed')) return;
    const probe = typeof window.__audioProbe === 'function' ? window.__audioProbe() : null;
    const st = probe && probe.stats;
    const tr = probe && probe.transport;
    byId('hud-fps').textContent = Math.round(__perf.fps);
    byId('hud-frame').textContent = __perf.emaFrameMs ? __perf.emaFrameMs.toFixed(1) + ' ms' : '—';
    byId('hud-mem').textContent = __perf.memoryMB ? __perf.memoryMB + ' MB' : '—';
    byId('hud-ctx').textContent = st ? st.ctxState : '—';
    byId('hud-osc').textContent = st ? String(st.oscillatorCount) : '—';
    byId('hud-rms').textContent = st ? (+st.rms).toFixed(4) : '—';
    byId('hud-transport').textContent = tr ? tr.mode : '—';
    byId('hud-provider').textContent = providerLabel(audioProvider);
    byId('hud-wakelock').textContent = _wakeLock && !_wakeLock.released ? 'activo' : '—';
    byId('hud-state').textContent = audioState.state;
    byId('hud-lifecycle').textContent = lifecycle.state;
    const log = byId('hud-log');
    log.innerHTML = __interferenceLog
      .slice(-8)
      .reverse()
      .map((e) => {
        const d = new Date(e.at);
        const p = (n) => String(n).padStart(2, '0');
        return `<li><span class="hud-log-t">${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}</span><span class="hud-log-k">${e.kind}</span><span class="hud-log-d">${e.detail}</span></li>`;
      })
      .join('');
  }, 500);
}
buildHud();

// Secret testing shortcut: press 'E' to toggle Simulated EEG, 'M' to toggle
// Scientific Mode, 'D' para abrir/cerrar el HUD.
document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    // No robar la tecla mientras se escribe en un campo.
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (hudEl) {
      hudEl.classList.toggle('collapsed');
      lsSet(LS_HUD, !hudEl.classList.contains('collapsed'));
    }
    return;
  }
  if (e.key === 'e' || e.key === 'E') {
    if (simulation && simulation.eeg) simulation.eeg.toggle();
  }
  if (e.key === 'm' || e.key === 'M') {
    if (simulation) simulation.toggleScientificMode();
  }
});

updatePlatformUI();
// Re-check after a bit in case the bridge was injected late (onPageFinished).
setTimeout(updatePlatformUI, 1000);
setTimeout(updatePlatformUI, 3000);

if (document.readyState === 'complete') hideLoader();
else window.addEventListener('load', hideLoader);
setTimeout(hideLoader, LOADER_MIN_MS + 2500); // seguridad: nunca quedarse colgado

// Animación de aparición al deslizar: cada componente aparece con una
// cascada suave al entrar en pantalla (secciones, tarjetas, botones…).
// Detección por scroll con fallback, funciona en cualquier navegador.
const revealables = [
  ...document.querySelectorAll(
    '.hero, .panel, .controls, .info, .card, .legend-item, .status, .timer-btn, .ambient-btn, .mixer-btn, .volume-row',
  ),
];
revealables.forEach((el, i) => {
  el.classList.add('reveal');
  el.dataset.rev = String(i % 6); // posición en la cascada
});
function checkReveal() {
  const vh = window.innerHeight;
  revealables.forEach((el) => {
    if (!el.classList.contains('revealed') && el.getBoundingClientRect().top < vh * 0.94) {
      // Cascada: los componentes del mismo grupo entran con un pequeño retardo.
      el.style.transitionDelay = `${Number(el.dataset.rev) * 70}ms`;
      el.classList.add('revealed');
    }
  });
}
window.addEventListener('scroll', checkReveal, { passive: true });
window.addEventListener('resize', checkReveal);
checkReveal();
// Fallback: si algo falla, nunca dejar el contenido oculto.
setTimeout(() => {
  revealables.forEach((el) => el.classList.add('revealed'));
}, 6000);

// Banda técnica de un estado (delta, theta, alfa, beta, gamma, schumann…).
function bandKeyOf(state) {
  if (state.custom) return 'personalizado';
  const key = state.band.toLowerCase().split(' ')[0];
  // 'Alpha · 10 Hz' se escribe con 'ph' en algunos presets: normalizar.
  return key === 'alpha' ? 'alfa' : key;
}
// Filtro por objetivo (dormir, meditar, concentrarse…) o por favoritos.
function applyGoalFilter(goal) {
  cards.forEach((card) => {
    const s = STATES.find((st) => st.id === card.dataset.id);
    let show;
    if (goal === 'favs') show = favorites.has(s.id);
    else if (goal === 'destacados') show = !!s.featured;
    else show = goalOf(s).id === goal;
    card.classList.toggle('filtered-out', !show);
  });
  // Ocultar los grupos que se quedaron sin estados visibles.
  groups.forEach(({ section, sub }) => {
    const empty = ![...sub.children].some((c) => !c.classList.contains('filtered-out'));
    section.classList.toggle('empty', empty);
  });
  // Si el estado elegido quedó oculto, elegir el primero visible.
  const hidden =
    goal === 'favs'
      ? !favorites.has(selected.id)
      : goal === 'destacados'
        ? !selected.featured
        : goal && goalOf(selected).id !== goal;
  if (hidden) {
    const firstVisible = cards.find((c) => !c.classList.contains('filtered-out'));
    if (firstVisible) {
      selectState(STATES.find((st) => st.id === firstVisible.dataset.id));
    }
  }
}
goalFilter.addEventListener('click', (e) => {
  const chip = e.target.closest('.band-chip');
  if (!chip) return;
  goalFilter.querySelectorAll('.band-chip').forEach((c) => c.classList.toggle('active', c === chip));
  applyGoalFilter(chip.dataset.goal);
  // El filtro elegido también se guarda para la próxima visita.
  saveSession();
});

// Persistir el estado abierto/cerrado de "¿Cómo funciona?": que no se
// resetee a cerrado en cada visita si el usuario ya lo abrió una vez.
const comoFunciona = document.getElementById('como-funciona');
if (comoFunciona) {
  const LS_COMO_FUNCIONA = 'vyneural_como_funciona_open';
  try {
    if (localStorage.getItem(LS_COMO_FUNCIONA) === 'true') comoFunciona.open = true;
  } catch {
    /* sin almacenamiento: siempre arranca cerrado */
  }
  comoFunciona.addEventListener('toggle', () => {
    try {
      localStorage.setItem(LS_COMO_FUNCIONA, String(comoFunciona.open));
    } catch {
      /* sin almacenamiento */
    }
  });
}
