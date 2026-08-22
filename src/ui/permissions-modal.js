// src/ui/permissions-modal.js
// Modal de "Permisos de la web" — AUTOCONTENIDO: inyecta su propio markup y
// funciona en cualquier página, no solo el reproductor (mismo criterio que
// ui/auth.js para su modal de login). Antes, el menú ⋯ → Permisos de /cuenta
// (o cualquier página fuera de "/") no tenía dónde mostrarse ahí mismo y
// terminaba navegando a "/" — este módulo es lo que lo hace "consumible"
// desde cualquier lado.
//
// El reproductor (main.js) sigue con SU PROPIA copia de este modal, más rica
// porque liga Wake Lock/Media Session al estado REAL de reproducción — este
// módulo lo inicializa site.js SOLO en las demás páginas (ver el chequeo de
// pathname en site.js), así nunca compiten por window.__vyneural.openPermissions.
//
// Reutiliza la MISMA lógica pura que main.js (core/capabilities.js,
// core/permissions.js, platform/platform-capabilities.js) — nunca
// reimplementada a mano — así que el criterio de "qué mostrar" es idéntico
// en las dos copias. La única diferencia real es que acá no hay sesión de
// audio: mediaSessionActive/wakeLockActive reflejan el Wake Lock propio de
// ESTA página (genérico, no atado a reproducción) — probeCapabilities() ya
// da una etiqueta honesta para ese caso ("Disponible (al reproducir)").

import { probeCapabilities } from '../core/capabilities.js';
import { evaluatePermissions, notifStateText, enabledStateText } from '../core/permissions.js';
import { mergePlatformCapabilities } from '../platform/platform-capabilities.js';
import { createNativeBridgeAdapter } from '../platform/native-bridge.js';
import { notificationSupported, iosNeedsInstall } from '../notifications.js';
import { getCachedPushStatus, pushStatus } from '../api/push.js';

// MISMA clave que main.js (src/main.js::LS_PERM_DISABLED) — el interruptor
// es global: desactivarlo en una página lo desactiva en todas.
const LS_PERM_DISABLED = 'vyneural_perms_disabled';

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
function permsDisabled() {
  return lsGet(LS_PERM_DISABLED, false) === true;
}

const nativeBridge = createNativeBridgeAdapter();
function nativeAudio() {
  // Consulta en vivo (no la detección estática del adaptador): el wrapper
  // window.AndroidBridge se inyecta después de que este módulo corre.
  if (typeof window !== 'undefined' && (window.AndroidBridge || window.AndroidBridgeNative)) {
    return nativeBridge;
  }
  return null;
}

// Wake Lock propio de esta página — genérico (mantiene la pantalla activa
// mientras esta pestaña esté visible), no atado a ninguna reproducción de
// audio (acá no hay motor de audio). `_wanted` distingue "el usuario lo
// activó en esta carga de página" de "nunca lo pidió", para reafirmarlo
// correctamente al volver de segundo plano (el navegador lo libera solo al
// perder visibilidad — no es un fallo nuestro, hay que re-pedirlo).
let _wakeLock = null;
let _wakeLockWanted = false;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (_wakeLock && !_wakeLock.released) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLockWanted = true;
  } catch (_) {
    /* denegado o no soportado: no rompe nada */
  }
}
async function releaseWakeLock() {
  _wakeLockWanted = false;
  if (_wakeLock && !_wakeLock.released) {
    try {
      await _wakeLock.release();
    } catch (_) {
      /* ya liberado */
    }
    _wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && _wakeLockWanted && (!_wakeLock || _wakeLock.released)) {
    acquireWakeLock();
  }
});

function mergedCapabilities() {
  return mergePlatformCapabilities({
    web: probeCapabilities({
      notificationSupported: notificationSupported(),
      notificationPermission: notificationSupported() ? Notification.permission : null,
      mediaSessionSupported: typeof navigator !== 'undefined' && 'mediaSession' in navigator,
      mediaSessionActive: false, // esta página no reproduce audio
      wakeLockSupported: 'wakeLock' in navigator,
      wakeLockActive: !!(_wakeLock && !_wakeLock.released),
      pushSupported: 'PushManager' in window && 'serviceWorker' in navigator,
      pushConfigured: !!(getCachedPushStatus() && getCachedPushStatus().configured),
      iosNeedsInstall: iosNeedsInstall(),
    }),
    native: nativeBridge.getState(),
    env: { ua: navigator.userAgent, bridgePresent: nativeBridge.present },
  });
}

async function requestAllPermissions() {
  const decision = evaluatePermissions({
    disabled: permsDisabled(),
    notificationSupported: notificationSupported(),
    notifPermission: notificationSupported() ? Notification.permission : null,
    wakeLockSupported: 'wakeLock' in navigator,
    wakeLockHeld: !!(_wakeLock && !_wakeLock.released),
    iosNeedsInstall: iosNeedsInstall(),
  });
  if (decision.willPromptNotifications) {
    try {
      await Notification.requestPermission();
    } catch (_) {
      /* denegado o no soportado */
    }
  }
  if (decision.shouldAcquireWakeLock) await acquireWakeLock();
}

const MODAL_HTML = `
<div id="permissions-modal" class="auth-modal hidden" role="dialog" aria-modal="true" aria-label="Permisos de la web">
  <div class="auth-card perm-card">
    <div class="perm-head">
      <h3>
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
        Permisos de la web
      </h3>
      <button id="permissions-close" class="auth-close" aria-label="Cerrar permisos">✕</button>
    </div>
    <p class="perm-intro">
      Vyneural usa estos permisos para seguir sonando limpio fuera de la app
      (pantalla bloqueada o en segundo plano) y para avisarte de los recordatorios.
    </p>
    <div class="perm-diff-box" id="perm-diff-box">
      <div class="pdb-title">Diferencias de plataforma</div>
      <div class="pdb-grid">
        <div class="pdb-item"><b>Audio Background</b><span id="pdb-audio">Web: Limitado<br>APK: Foreground Service</span></div>
        <div class="pdb-item"><b>Alarmas</b><span id="pdb-alarms">Web: Solo app abierta<br>APK: Scheduler del SO</span></div>
        <div class="pdb-item"><b>Notificaciones</b><span id="pdb-notif">Web: Push (con back)<br>APK: Locales (sin back)</span></div>
      </div>
    </div>
    <div class="perm-row" id="perm-platform-row" style="display:none"><span>Plataforma</span><b id="perm-platform" class="perm-state">—</b></div>
    <div class="perm-row"><span>Notificaciones</span><b id="perm-notif" class="perm-state">—</b></div>
    <div class="perm-row"><span>Control del reproductor (Media Session)</span><b id="perm-mediasession" class="perm-state">—</b></div>
    <div class="perm-row"><span>Pantalla activa (Wake Lock)</span><b id="perm-wakelock" class="perm-state">—</b></div>
    <div class="perm-row"><span>Notificaciones push (servidor)</span><b id="perm-push" class="perm-state">—</b></div>
    <div class="perm-row"><span>Permisos habilitados en Vyneural</span><b id="perm-enabled" class="perm-state">—</b></div>
    <div class="perm-actions">
      <button id="perm-on" class="auth-submit">Activar permisos</button>
      <button id="perm-off" class="perm-off">Desactivar</button>
      <button id="perm-test" class="perm-test hidden">Probar notificación</button>
      <button id="perm-notif-settings" class="perm-test hidden">Abrir ajustes de notificación</button>
      <button id="perm-exact-settings" class="perm-test hidden">Autorizar alarmas exactas</button>
    </div>
    <p id="perm-note" class="perm-note"></p>
  </div>
</div>`;

let _wired = false;

function ensureModal() {
  if (document.getElementById('permissions-modal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = MODAL_HTML.trim();
  document.body.appendChild(wrap.firstElementChild);
}

function renderPermissionState() {
  const permNotif = document.getElementById('perm-notif');
  const permWakelock = document.getElementById('perm-wakelock');
  const permEnabled = document.getElementById('perm-enabled');
  const permNote = document.getElementById('perm-note');
  if (!permNotif) return;
  const caps = mergedCapabilities();
  const notifPerm = caps.notifications.permission;
  const isNative = caps.native;
  permNotif.textContent = caps.notifications.label;
  permNotif.className = 'perm-state' + (notifPerm === 'granted' ? ' ok' : ' warn');
  const wakeActive = caps.wakeLock.active;
  permWakelock.textContent = caps.wakeLock.label;
  permWakelock.className = 'perm-state' + (wakeActive ? ' ok' : ' warn');
  const permMs = document.getElementById('perm-mediasession');
  if (permMs) {
    permMs.textContent = caps.mediaSession.label;
    permMs.className = 'perm-state' + (caps.mediaSession.active ? ' ok' : ' warn');
  }
  const permPlatformRow = document.getElementById('perm-platform-row');
  const permPlatform = document.getElementById('perm-platform');
  if (permPlatformRow && permPlatform) {
    permPlatformRow.style.display = isNative ? '' : 'none';
    permPlatform.textContent = isNative ? `Android (bridge v${nativeBridge.getState().version || '?'})` : 'Web / PWA';
    permPlatform.className = 'perm-state ok';
  }
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
  const permPush = document.getElementById('perm-push');
  if (permPush) {
    permPush.textContent = caps.push.label;
    permPush.className = 'perm-state ' + (caps.push.configured ? 'ok' : 'warn');
  }
  const permTest = document.getElementById('perm-test');
  if (permTest) permTest.classList.toggle('hidden', !isNative);
  const btnNotifSettings = document.getElementById('perm-notif-settings');
  if (btnNotifSettings) {
    btnNotifSettings.classList.toggle('hidden', !(isNative && notifPerm !== 'granted'));
  }
  const btnExactSettings = document.getElementById('perm-exact-settings');
  if (btnExactSettings) {
    btnExactSettings.classList.toggle('hidden', !(isNative && caps.exactAlarms.supported && !caps.exactAlarms.granted));
  }
  const disabled = permsDisabled();
  permEnabled.textContent = enabledStateText(disabled);
  permEnabled.className = 'perm-state' + (disabled ? ' bad' : ' ok');
  permNote.textContent = disabled
    ? 'Permisos desactivados: la app no volverá a pedirlos y los recordatorios solo sonarán en primer plano. Reactívalos cuando quieras.'
    : iosNeedsInstall()
      ? 'En iOS las notificaciones y el control del reproductor requieren la app instalada: Compartir → Añadir a pantalla de inicio. En Android se piden al tocar "Activar permisos".'
      : 'Las notificaciones del sistema solo pueden revocarse en los ajustes del navegador; aquí solo se desactiva su uso en Vyneural (incluye liberar el Wake Lock).';
}

function wireModal() {
  if (_wired) return;
  _wired = true;
  const modal = document.getElementById('permissions-modal');
  const permClose = document.getElementById('permissions-close');
  if (permClose) permClose.addEventListener('click', closePermissions);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePermissions();
  });
  document.getElementById('perm-on').addEventListener('click', async () => {
    lsSet(LS_PERM_DISABLED, false);
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

export function openPermissions() {
  ensureModal();
  wireModal();
  renderPermissionState();
  document.getElementById('permissions-modal').classList.remove('hidden');
  // Igual criterio que main.js: si aún no se decidió y no están
  // desactivados, se piden en este mismo gesto (el clic en el menú ⋯ vale).
  if (!permsDisabled() && notificationSupported() && Notification.permission === 'default') {
    requestAllPermissions().then(() => renderPermissionState());
  }
  // Estado de push consultado fresco (best-effort): en páginas que nunca
  // llamaron a pushStatus() antes, getCachedPushStatus() estaría vacío y la
  // fila mostraría "no configurado" por defecto (honesto pero pesimista) —
  // se corrige solo cuando llega la respuesta real.
  pushStatus().then(() => renderPermissionState()).catch(() => {});
}

export function closePermissions() {
  const modal = document.getElementById('permissions-modal');
  if (modal) modal.classList.add('hidden');
}

/** Inyecta el modal y lo registra como window.__vyneural.openPermissions —
 * MISMO nombre que usa main.js, así ui/auth.js no necesita saber cuál de
 * las dos copias hay disponible. Llamar una sola vez, y NUNCA en la página
 * del reproductor (ver el chequeo de pathname en site.js) — ahí ya existe
 * la copia más rica de main.js. */
export function initPermissionsModal() {
  if (!window.__vyneural) window.__vyneural = {};
  if (typeof window.__vyneural.openPermissions === 'function') return; // ya hay una copia (no debería pasar, ver arriba)
  window.__vyneural.openPermissions = openPermissions;
}
