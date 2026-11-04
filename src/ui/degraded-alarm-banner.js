// src/ui/degraded-alarm-banner.js
// Aviso proactivo de permisos degradados — SOLO APK (Android nativo).
//
// Empezó cubriendo un solo caso (canal de alarma con importancia degradada,
// ver permissions-modal.js/main.js::refreshAlarmPerm, confirmado en vivo en
// Honor/Magic OS — NotificationHelper.kt P8): la importancia puede caer a
// Baja INSTANTÁNEAMENTE al conceder el permiso, sin que el usuario haya
// descartado ninguna notificación. Si nadie abre el modal de permisos o el
// de alarmas del reproductor, nunca se entera de que sus alarmas quedaron
// mudas — este banner se muestra solo con abrir cualquier página de la app.
//
// Detecta permiso de notificaciones revocado, prioridad reducida del
// canal predeterminado y falta de autorización para alarmas exactas.
//
// El canal se crea al iniciar la app. Solo las alarmas futuras del
// programador nativo justifican un aviso proactivo.

import { probeCapabilities } from '../core/capabilities.js';
import { mergePlatformCapabilities } from '../platform/platform-capabilities.js';
import { createNativeBridgeAdapter } from '../platform/native-bridge.js';

const LS_DISMISSED_UNTIL = 'vyneural_alarm_banner_dismissed_until';
const DISMISS_MS = 24 * 60 * 60 * 1000; // 24h: la degradación puede repetirse, no es un opt-out permanente

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
function dismissedNow() {
  const until = lsGet(LS_DISMISSED_UNTIL, 0);
  return typeof until === 'number' && Date.now() < until;
}

const nativeBridge = createNativeBridgeAdapter();
function nativeAudio() {
  if (typeof window !== 'undefined' && (window.AndroidBridge || window.AndroidBridgeNative)) {
    return nativeBridge;
  }
  return null;
}

function mergedCaps(native) {
  return mergePlatformCapabilities({
    web: probeCapabilities({}),
    native,
    env: { ua: navigator.userAgent, bridgePresent: nativeBridge.present },
  });
}

function detectIssue() {
  const b = nativeAudio();
  if (!b) return null;
  const native = b.getState();
  if (!(native.info?.alarmCount > 0)) return null;
  const caps = mergedCaps(native);

  const notifPerm = caps.notifications.permission;
  if (notifPerm && notifPerm !== 'granted' && notifPerm !== 'not_requested') {
    return {
      text: '⚠️ Vyneural no puede avisarte: el permiso de notificaciones fue revocado.',
      fix: () => b.openNotificationSettings && b.openNotificationSettings(),
    };
  }
  // MainActivity.onRequestPermissionsResult (Kotlin) también reacciona a esta
  // MISMA señal con un diálogo nativo, a propósito y sin coordinarse con este
  // banner: ese diálogo cubre solo el instante justo tras conceder el
  // permiso; este banner cubre cualquier degradación posterior (por eso el
  // re-chequeo en visibilitychange abajo). Ver docs/NOTIFICATION_CHANNEL_HISTORY.md.
  const importanceDegraded =
    (native.info.defaultAlarmCount ?? native.info.alarmCount) > 0 &&
    caps.alarmChannel.supported &&
    typeof caps.alarmChannel.importance === 'number' &&
    caps.alarmChannel.importance < 4;
  if (importanceDegraded) {
    return {
      text: '⚠️ El canal de alarmas de Vyneural tiene prioridad reducida.',
      fix: () => b.openAlarmChannelSettings && b.openAlarmChannelSettings(),
    };
  }
  if (caps.exactAlarms.supported && !caps.exactAlarms.granted) {
    return {
      text: '⚠️ Las alarmas exactas fueron desautorizadas — pueden llegar tarde o no llegar.',
      fix: () => b.requestExactAlarmPermission && b.requestExactAlarmPermission(),
    };
  }
  // NO agregar una rama para caps.autostartGuidance acá — se probó y se
  // sacó (falso positivo confirmado en vivo en un Honor real con las
  // notificaciones funcionando bien): needsGuidance() en OemAutostart.kt es
  // una lista estática por fabricante (Build.MANUFACTURER in
  // KNOWN_MANUFACTURERS), no una lectura de si el autostart está REALMENTE
  // restringido en este dispositivo — se disparaba con el mismo ⚠️ urgente
  // que las ramas de arriba (que sí leen estado real) para CUALQUIER Honor/
  // Xiaomi/Huawei/Oppo/Vivo/OnePlus/Realme, siempre, en cada apertura. Sigue
  // vivo únicamente como fila estática/informativa en permissions-modal.js
  // (sin urgencia falsa), que es donde corresponde una recomendación no
  // verificable en vez de una alerta proactiva.
  return null;
}

const BANNER_HTML = `
<div id="alarm-degraded-banner" class="alarm-degraded-banner hidden" role="alert">
  <span class="alarm-degraded-banner-text" id="alarm-degraded-banner-text"></span>
  <button type="button" id="alarm-degraded-banner-fix" class="alarm-degraded-banner-fix">Arreglarlo</button>
  <button type="button" id="alarm-degraded-banner-dismiss" class="alarm-degraded-banner-dismiss" aria-label="Ahora no">✕</button>
</div>`;

let injected = false;
let currentFix = null;
function ensureBanner() {
  if (injected) return;
  injected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = BANNER_HTML.trim();
  const el = wrap.firstElementChild;
  document.body.insertBefore(el, document.body.firstChild);
  document.getElementById('alarm-degraded-banner-fix').addEventListener('click', () => {
    if (currentFix) currentFix();
  });
  document.getElementById('alarm-degraded-banner-dismiss').addEventListener('click', () => {
    lsSet(LS_DISMISSED_UNTIL, Date.now() + DISMISS_MS);
    render();
  });
}

function render() {
  const el = document.getElementById('alarm-degraded-banner');
  if (!el) return;
  const issue = dismissedNow() ? null : detectIssue();
  currentFix = issue ? issue.fix : null;
  const textEl = document.getElementById('alarm-degraded-banner-text');
  if (issue && textEl) textEl.textContent = issue.text;
  el.classList.toggle('hidden', !issue);
}

/** Reevalúa y muestra/oculta el banner. Llamar al iniciar la página y en
 * cada vyneural:auth no hace falta (no depende de sesión) — sí conviene
 * llamarlo de nuevo al volver de segundo plano, ver visibilitychange abajo. */
export function refreshDegradedAlarmBanner() {
  if (!nativeAudio()) return; // solo APK
  ensureBanner();
  render();
}

let wired = false;
export function initDegradedAlarmBanner() {
  if (wired) return;
  wired = true;
  refreshDegradedAlarmBanner();
  // El caso de degradación instantánea al conceder el permiso se detecta
  // recién cuando el usuario vuelve del diálogo de permisos del sistema —
  // ese regreso dispara visibilitychange, no un evento propio de la app.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDegradedAlarmBanner();
  });
  window.addEventListener('vyneural:resumed', refreshDegradedAlarmBanner);
}
