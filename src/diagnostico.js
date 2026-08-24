// src/diagnostico.js — página /diagnostico (web + APK)
// Panel de refinamiento: pantalla (fullscreen/rotación), rendimiento, audio e
// interferencias, permisos, notificaciones y plataforma/lógica. Solo lee
// estados reales del sistema; nada sale del dispositivo.
import { createNativeBridgeAdapter } from './platform/native-bridge.js';
import { mergePlatformCapabilities } from './platform/platform-capabilities.js';
import { probeCapabilities } from './core/capabilities.js';
import { setFullscreen, setOrientation, screenState } from './platform/fullscreen.js';
import { notificationSupported, getAlarms, requestPermission } from './notifications.js';
import { getCachedPushStatus, setCachedPushStatus, pushStatus } from './api/push.js';
import { getAccessToken } from './api/client.js';

const $ = (id) => document.getElementById(id);
function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = v ?? '—';
}

// El bridge nativo se inyecta en onPageFinished (después del arranque del
// módulo): se re-detecta en cada uso, no se guarda una foto al cargar.
function currentBridge() {
  const raw = typeof window !== 'undefined' ? window.AndroidBridge : null;
  if (!raw || typeof raw.postMessage !== 'function') return null;
  return createNativeBridgeAdapter();
}

// ── Log local de plataforma/audio (esta página) ────────────────────────────
const audioLog = [];
function logLine(kind, detail) {
  audioLog.push(`${new Date().toLocaleTimeString('es-CL')} · ${kind} · ${detail}`);
  if (audioLog.length > 14) audioLog.shift();
  const pre = $('diag-audio-log');
  if (pre) pre.textContent = audioLog.join('\n');
}
['visibilitychange', 'fullscreenchange', 'orientationchange'].forEach((ev) => {
  window.addEventListener(ev, () => {
    logLine(ev, `${screenState().orientation || '—'} · ${document.visibilityState}`);
  });
});
// Evento nativo (APK): cambios de audio focus del shell. UNKNOWN se loguea
// como tal (nunca pérdida genérica): la política es visible en el panel.
window.addEventListener('vyneural:audiofocus', (e) => {
  const label = (e.detail && e.detail.state) || 'event';
  logLine('audiofocus', label === 'UNKNOWN' ? `${label} · política defensiva: pausa + watchdog + CRITICAL` : label);
  refreshFocus();
});

// ── Pantalla: fullscreen + rotación ────────────────────────────────────────
// El fullscreen nativo (APK) oculta las barras del sistema pero NO marca
// document.fullscreenElement: se rastrea aparte para mostrar el estado real
// y poder alternar (entrar/salir).
let nativeFs = false;
function refreshScreen() {
  const s = screenState();
  const bridge = currentBridge();
  const info = bridge ? bridge.getState().info : null;
  nativeFs = !!(info && info.fullscreen);
  setText('diag-fs-state', s.fullscreen ? 'sí (web)' : nativeFs ? 'sí (nativa)' : 'no');
  setText('diag-orientation', s.orientation || '—');
  setText('diag-viewport', `${s.inner.w} × ${s.inner.h} · dpr ${s.dpr}`);
}
setInterval(refreshScreen, 1000);

function bind(id, fn) {
  const b = $(id);
  if (b) b.addEventListener('click', fn);
}
const screenResult = (r, action) =>
  logLine('pantalla', r && r.ok ? action : `error: ${r && r.error ? r.error : 'sin respuesta'}`);

bind('btn-fs', async () => {
  const target = !(screenState().fullscreen || nativeFs);
  const r = await setFullscreen(target, currentBridge());
  screenResult(r, target ? 'fullscreen activado' : 'fullscreen desactivado');
  refreshScreen();
});
bind('btn-or-portrait', async () => screenResult(await setOrientation('portrait', currentBridge()), 'vertical bloqueada'));
bind('btn-or-landscape', async () => screenResult(await setOrientation('landscape', currentBridge()), 'horizontal bloqueada'));
bind('btn-or-sensor', async () => screenResult(await setOrientation('sensor', currentBridge()), 'orientación libre'));

// ── Rendimiento (esta página) ──────────────────────────────────────────────
const perf = { ema: 0, last: performance.now() };
function perfTick() {
  const now = performance.now();
  const dt = now - perf.last;
  perf.last = now;
  perf.ema = perf.ema ? perf.ema * 0.9 + dt * 0.1 : dt;
  setText('diag-fps', Math.round(1000 / perf.ema));
  setText('diag-frame', `${perf.ema.toFixed(1)} ms`);
  if (performance.memory) setText('diag-mem', `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB`);
  requestAnimationFrame(perfTick);
}
requestAnimationFrame(perfTick);

// ── Política de audio focus (P2): estado visible + contadores del watchdog ──
// held = estado OPERACIONAL (¿la sesión posee el foco?) · Diagnostics = solo
// observabilidad. UNKNOWN es un estado explícito y recuperable, nunca una
// pérdida genérica silenciosa.
function refreshFocus() {
  const bridge = currentBridge();
  const info = bridge ? bridge.getState().info : null;
  if (!info) {
    setText('diag-focus-state', '— (web: lo gestiona el navegador)');
    setText('diag-focus-counters', '—');
    return;
  }
  const state = info.focusState || 'NONE';
  const policy =
    state === 'GAIN'
      ? 'held=true · resume'
      : state === 'DUCK'
        ? 'held=true · duck (el foco NO se pierde)'
        : state === 'LOSS' || state === 'LOSS_TRANSIENT'
          ? 'held=false · pausa + watchdog'
          : state === 'UNKNOWN'
            ? 'held=false · CRITICAL · pausa + watchdog (visible como UNKNOWN)'
            : 'sin foco solicitado';
  setText('diag-focus-state', `${state} → ${policy}`);
  setText(
    'diag-focus-counters',
    `watchdog re-adquisiciones: ${info.focusReacquireCount ?? '—'} · callbacks UNKNOWN: ${info.focusUnknownCount ?? '—'}`,
  );
}

// ── Audio: tono de prueba + servicio nativo ────────────────────────────────
let testCtx = null;
bind('btn-beep', () => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      logLine('beep', 'sin Web Audio API');
      return;
    }
    if (!testCtx) {
      testCtx = new AC();
      testCtx.onstatechange = () => logLine('beep ctx', testCtx.state);
    }
    const osc = testCtx.createOscillator();
    const g = testCtx.createGain();
    osc.frequency.value = 432;
    const t0 = testCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1);
    osc.connect(g).connect(testCtx.destination);
    osc.start();
    osc.stop(t0 + 1.05);
    logLine('beep', 'tono 432 Hz · 1 s');
  } catch (e) {
    logLine('beep', `error: ${e.message}`);
  }
});

let bgActive = false;
bind('btn-bg', () => {
  const bridge = currentBridge();
  if (!bridge) {
    logLine('servicio', 'solo en la APK (bridge nativo)');
    return;
  }
  if (!bgActive) {
    bridge.startBackgroundAudio({ base: 432, beat: 6 });
    bgActive = true;
    $('btn-bg').textContent = '🎧 Detener servicio de audio';
    logLine('servicio', 'START_BACKGROUND_AUDIO enviado');
  } else {
    bridge.stopBackgroundAudio();
    bgActive = false;
    $('btn-bg').textContent = '🎧 Servicio de audio nativo';
    logLine('servicio', 'STOP_BACKGROUND_AUDIO enviado');
  }
});

// ── Permisos ───────────────────────────────────────────────────────────────
function refreshCaps() {
  const probe = probeCapabilities({
    notificationSupported: notificationSupported(),
    notificationPermission: notificationSupported() ? Notification.permission : null,
    mediaSessionSupported: 'mediaSession' in navigator,
    mediaSessionActive: false,
    wakeLockSupported: 'wakeLock' in navigator,
    wakeLockActive: false,
    pushSupported: 'PushManager' in window && 'serviceWorker' in navigator,
    // Estado REAL del backend (consultado abajo con sesión), no un supuesto.
    pushConfigured: !!(getCachedPushStatus() && getCachedPushStatus().configured),
    iosNeedsInstall: false,
  });
  const bridge = currentBridge();
  const native = bridge ? bridge.getState() : null;
  const merged = mergePlatformCapabilities({
    web: probe,
    native,
    env: { ua: navigator.userAgent, bridgePresent: !!bridge },
  });
  const info = native && native.info ? native.info : null;
  const rows = [
    ['Notificaciones', merged.notifications.label || merged.notifications.permission, merged.notifications.provider || 'web'],
    ['Audio 2.º plano', merged.backgroundAudio.label, merged.backgroundAudio.provider || 'web'],
    ['Alarmas exactas', merged.exactAlarms.label, merged.exactAlarms.provider || 'web'],
    ['Optimización de batería', merged.batteryUnrestricted.label, merged.batteryUnrestricted.provider || 'web'],
    ['Alarmas en el reloj del sistema', info ? `${info.alarmCount ?? 0} pendiente(s)` : '—', info ? 'android' : 'n/a'],
    ['Media Session', merged.mediaSession.label, merged.mediaSession.provider || 'web'],
    ['Wake Lock', merged.wakeLock.label, 'web'],
    ['Push', merged.push.label, 'web'],
  ];
  const tbody = document.querySelector('#diag-perms tbody');
  if (tbody) {
    tbody.innerHTML = rows
      .map(([name, label, provider]) => `<tr><td>${name}</td><td>${label ?? '—'}</td><td>${provider}</td></tr>`)
      .join('');
  }
  return merged;
}

const permNote = (msg) => {
  const n = $('diag-perm-note');
  if (n) n.textContent = msg;
};
bind('btn-perm-notif', async () => {
  const bridge = currentBridge();
  if (bridge) {
    bridge.requestNotificationPermission();
    permNote('Comando nativo enviado: REQUEST_NOTIFICATION_PERMISSION. Revisá el diálogo del sistema.');
  } else if (notificationSupported()) {
    const r = await requestPermission();
    permNote(`Resultado: ${r}`);
  } else {
    permNote('Notificaciones no soportadas en este navegador.');
  }
  refreshCaps();
});
bind('btn-perm-alarm', () => {
  const bridge = currentBridge();
  if (bridge) {
    bridge.requestExactAlarmPermission();
    permNote('Comando nativo enviado: REQUEST_EXACT_ALARM_PERMISSION.');
  } else {
    permNote('Alarmas exactas solo en la APK (requieren el sistema operativo).');
  }
});
bind('btn-perm-battery', () => {
  const bridge = currentBridge();
  if (bridge) {
    bridge.requestIgnoreBatteryOptimizations();
    permNote('Comando nativo enviado: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS.');
  } else {
    permNote('Optimización de batería solo aplica en la APK.');
  }
});
bind('btn-perm-wake', async () => {
  if ('wakeLock' in navigator) {
    try {
      const wl = await navigator.wakeLock.request('screen');
      permNote('Wake Lock adquirido. Se libera en 5 s.');
      setTimeout(() => {
        wl.release().catch(() => {});
        permNote('Wake Lock liberado.');
      }, 5000);
    } catch (e) {
      permNote(`Wake Lock denegado: ${e.message}`);
    }
  } else {
    permNote('Wake Lock no soportado en este navegador.');
  }
});

// ── Notificaciones ─────────────────────────────────────────────────────────
bind('btn-notif-test', () => {
  const bridge = currentBridge();
  if (bridge) {
    bridge.testNotification();
    permNote('Notificación nativa enviada (TEST_NOTIFICATION).');
  } else if (notificationSupported() && Notification.permission === 'granted') {
    try {
      new Notification('Vyneural · Prueba de diagnóstico', {
        body: 'Si ves esto, las notificaciones funcionan.',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'vyneural-diag-test',
      });
      permNote('Notificación web enviada.');
    } catch (e) {
      permNote(`Error: ${e.message}`);
    }
  } else {
    permNote('Permiso no concedido: pedilo en Permisos primero.');
  }
});

// ── Estado: alarmas + última sesión ────────────────────────────────────────
function refreshState() {
  try {
    const alarms = getAlarms();
    setText('diag-alarms', String(alarms.length));
  } catch (_) {
    setText('diag-alarms', '—');
  }
  let session = '—';
  try {
    const s = JSON.parse(localStorage.getItem('ob-session-v1'));
    if (s && s.state) session = s.state;
  } catch (_) {
    /* sin sesión */
  }
  setText('diag-session', session);
}

// ── Navegación de la app (P4-B): historial manual del BACK ────────────────
// GET_NAV_STATE devuelve la página actual, la pila de páginas anteriores y
// si el BACK está habilitado. Solo aplica a la APK (bridge nativo); en la
// web la navegación es del navegador y se declara como tal.
function refreshNav() {
  const bridge = currentBridge();
  const note = $('diag-nav-note');
  if (!bridge || typeof bridge.getNavState !== 'function') {
    setText('diag-nav-current', '—');
    setText('diag-nav-back', '—');
    setText('diag-nav-stack', '—');
    if (note) note.textContent = 'Solo en la APK (bridge nativo): en web/PWA la navegación es del navegador.';
    return;
  }
  const r = bridge.getNavState();
  let o = r && r.response;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch (_) {
      o = null;
    }
  }
  const d = o && o.data ? o.data : null;
  if (!d) {
    if (note) note.textContent = 'GET_NAV_STATE sin respuesta (bridge PENDING).';
    return;
  }
  setText('diag-nav-current', d.current || 'index');
  setText('diag-nav-back', d.backEnabled ? 'sí' : 'no (BACK cierra la app)');
  const stack = Array.isArray(d.stack) && d.stack.length ? d.stack.join(' ← ') : 'vacío';
  setText('diag-nav-stack', stack);
  if (note) note.textContent = 'Historial manual gestionado por MainActivity (OnBackPressedDispatcher).';
}

// ── Plataforma / lógica ────────────────────────────────────────────────────
function refreshPlatform() {
  const merged = refreshCaps();
  const bridge = currentBridge();
  const native = bridge ? bridge.getState() : null;
  setText(
    'diag-platform',
    JSON.stringify(
      {
        ua: navigator.userAgent,
        bridge: native
          ? {
              platform: native.platform,
              bridgeStatus: native.bridgeStatus,
              version: native.version,
              focusState: native.info ? native.info.focusState : null,
              focusReacquireCount: native.info ? native.info.focusReacquireCount : null,
              focusUnknownCount: native.info ? native.info.focusUnknownCount : null,
              backgroundServiceActive: native.supported && native.info ? native.info.backgroundServiceActive : null,
            }
          : null,
        platformKind: merged ? merged.platformKind : null,
        displayMode: (() => {
          try {
            if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
            if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';
          } catch (_) {
            /* sin matchMedia */
          }
          return 'browser';
        })(),
        device: (() => {
          // Estado REAL de este dispositivo (para /diagnostico y la sección
          // Dispositivos de /cuenta): la APK lo da el bridge; la web usa un
          // id local persistente. Nunca se adivina.
          let bridgeInfo = null;
          try {
            if (native) bridgeInfo = native.info || null;
          } catch (_) { bridgeInfo = null; }
          let id = (bridgeInfo && bridgeInfo.deviceId) || null;
          if (!id) {
            try {
              id = localStorage.getItem('vyneural_device_id');
            } catch (_) { id = null; }
          }
          return {
            device_id: id || null,
            platform: bridgeInfo ? 'apk' : (window.matchMedia('(display-mode: standalone)').matches ? 'pwa' : 'web'),
            app_version: (bridgeInfo && bridgeInfo.appVersion) || null,
            notification_permission: (bridgeInfo && bridgeInfo.notificationPermission) ||
              (notificationSupported() ? Notification.permission : 'unavailable'),
            push_enabled: bridgeInfo
              ? (bridgeInfo.notificationPermission === 'GRANTED')
              : (notificationSupported() && Notification.permission === 'granted'),
          };
        })(),
      },
      null,
      2,
    ),
  );
}

refreshScreen();
refreshState();
refreshPlatform();
refreshFocus();
refreshNav();
// Push: consultar el estado REAL del backend si hay sesión (el diagnóstico
// no debe afirmar "no configurado" cuando el servidor tiene VAPID activo).
if (getAccessToken()) {
  pushStatus()
    .catch(() => setCachedPushStatus({ supported: true, configured: false }))
    .finally(() => {
      refreshCaps();
      refreshPlatform();
    });
}
setInterval(refreshState, 1000);
setInterval(refreshPlatform, 2000);
setInterval(refreshFocus, 2000);
setInterval(refreshNav, 2000);

function updatePlatformUI() {
  const badge = $('platform-badge');
  if (!badge) return;
  const bridge = currentBridge();
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (bridge) {
    badge.textContent = 'APK';
    badge.classList.remove('hidden', 'pwa', 'web');
  } else if (isStandalone) {
    badge.textContent = 'PWA';
    badge.classList.remove('hidden', 'web');
    badge.classList.add('pwa');
  } else {
    badge.textContent = '.cl';
    badge.classList.remove('hidden', 'pwa');
    badge.classList.add('web');
  }
}
updatePlatformUI();
setTimeout(updatePlatformUI, 1000);
setTimeout(updatePlatformUI, 3000);
