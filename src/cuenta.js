// src/cuenta.js
// Página /cuenta — vista de usuario consumiendo los endpoints del backend:
// perfil (auth/me), favoritos, frecuencias, alarmas y push. La gestión de
// itinerarios (crear/pausar/eliminar/personalizar pasos) vive SOLO en
// /rutina — antes había una segunda copia completa acá, que ya divergió de
// la de /rutina más de una vez (le faltaba ambiente, no podía cargar una
// guardada para editarla). Una sola implementación real, no dos para
// mantener sincronizadas a mano. Acá solo queda listItineraries(), porque
// "Mis alarmas" necesita saber qué alarmas están vinculadas a un itinerario
// (para no ofrecer borrarlas sueltas, ver renderAlarms).
// Aditiva: si no hay sesión muestra la puerta de entrada; sin backend la
// app sigue funcionando igual.

import { me, changePassword, resendVerification, deactivateAccount } from './api/auth.js';
import { getAccessToken, notifyNativeAlarmsChanged } from './api/client.js';
import { listFavorites, removeFavorite } from './api/favorites.js';
import {
  listFrequencies,
  deleteFrequency,
} from './api/frequencies.js';
import { listAlarms, deleteAlarm } from './api/alarms.js';
import { listItineraries } from './api/itineraries.js';
import { pushStatus, subscribeToPush, unsubscribeFromPush } from './api/push.js';
import { getStatus, onStatusChange, STATUS } from './api/status.js';
import { openFreqModal } from './ui/freq-modal.js';
import { freqCoverSVG } from './ui/freq-cover.js';
import { requestPermission } from './notifications.js';
import { listDevices, forgetDevice, reportDevice } from './api/devices.js';

const $ = (id) => document.getElementById(id);

let pushState = { supported: false, configured: false, public_key: null };
// Motivo del último intento fallido de suscripción, para que renderPush()
// lo muestre en vez del mensaje genérico de "Inactivo" (ver wirePushButtons).
let lastPushError = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function openAuth(mode) {
  const auth = window.__vyneuralAuth;
  if (auth && typeof auth.open === 'function') auth.open(mode);
}

// ── Estado de sesión / puerta ───────────────────────────────────────────────

function renderGate({ retryOnBoot = false } = {}) {
  const gate = $('cuenta-gate');
  const content = $('cuenta-content');
  const loggedIn = !!getAccessToken();
  if (gate) gate.classList.toggle('hidden', loggedIn);
  if (content) content.classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    if (retryOnBoot) loadAllOnBoot();
    else loadAll();
  }
}

// ── Perfil ──────────────────────────────────────────────────────────────────

function renderProfile(p) {
  const name = p?.display_name || p?.username || (p?.email || '').split('@')[0] || 'Usuario';
  $('cuenta-name').textContent = name;
  $('cuenta-email').textContent = p?.email || '';
  $('cuenta-avatar').textContent = (name[0] || '?').toUpperCase();
  const since = $('cuenta-since');
  if (p?.created_at) {
    try {
      const d = new Date(p.created_at);
      since.textContent = `Miembro desde ${d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}`;
    } catch (_) {
      since.textContent = '';
    }
  } else {
    since.textContent = '';
  }
  renderVerify(p);
}

// ── Verificación de correo ─────────────────────────────────────────────────

function renderVerify(p) {
  const wrap = $('cuenta-verify-wrap');
  const badge = $('cuenta-verify-badge');
  const resend = $('cuenta-verify-resend');
  if (!wrap || !badge) return;
  const verified = !!p?.email_verified;
  badge.textContent = verified ? 'Correo verificado ✓' : 'Correo sin verificar';
  badge.title = verified
    ? 'Tu correo está confirmado: podés recuperar la cuenta y recibir avisos.'
    : 'Confirmá tu correo: sin eso no podés recuperar la cuenta si olvidás la contraseña.';
  badge.classList.toggle('rs-live', verified);
  badge.classList.toggle('rs-warn', !verified);
  if (resend) resend.classList.toggle('hidden', verified);
  if (wrap) wrap.classList.toggle('hidden', verified);
}

async function wireVerify() {
  const resend = $('cuenta-verify-resend');
  if (!resend) return;
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    const original = resend.textContent;
    resend.textContent = 'Enviando…';
    try {
      const result = await resendVerification();
      // El backend responde 200 aunque el SMTP haya fallado: `email_sent`
      // distingue "aceptado" de "entregado" para no mentir al usuario.
      resend.textContent = result && result.email_sent === false
        ? 'El correo no se pudo enviar (problema con el servidor de correo)'
        : 'Correo enviado ✓ (revisá spam)';
      setTimeout(() => {
        resend.textContent = original;
        resend.disabled = false;
      }, 5000);
    } catch (err) {
      const status = err && err.status;
      resend.textContent = status === 0
        ? 'Sin conexión con el servidor. Intentá más tarde.'
        : status === 404 || status >= 500
          ? 'El servidor de cuentas no está disponible ahora. Intentá más tarde.'
          : 'No se pudo reenviar. Intentá en unos minutos.';
      setTimeout(() => {
        resend.textContent = original;
        resend.disabled = false;
      }, 5000);
    }
  });
}

// ── Listas ──────────────────────────────────────────────────────────────────

function renderList(id, emptyId, items, renderItem, emptyText) {
  const ul = $(id);
  const empty = $(emptyId);
  if (!ul) return;
  ul.innerHTML = '';
  const has = items && items.length > 0;
  ul.classList.toggle('hidden', !has);
  if (empty) {
    empty.classList.toggle('hidden', has);
    if (!has && emptyText) empty.textContent = emptyText;
  }
  (items || []).forEach((item) => {
    const li = document.createElement('li');
    li.className = 'cuenta-item';
    li.innerHTML = renderItem(item);
    ul.appendChild(li);
  });
}

function renderFavorites(favs) {
  renderList(
    'cuenta-favs',
    'cuenta-favs-empty',
    favs,
    (fav) => {
      const f = fav.frequency || {};
      const left = f.left_frequency != null ? f.left_frequency : f.carrier_frequency;
      const right = f.right_frequency != null ? f.right_frequency : (f.carrier_frequency ?? 0) + (f.beat_frequency ?? 0);
      return `${freqCoverSVG(f, 40)}
        <div class="cuenta-item-body">
          <b>${escapeHtml(f.name || 'Frecuencia')}</b>
          <small>${formatHz(left)} · ${formatHz(right)} · ritmo ${formatHz(f.beat_frequency)}</small>
        </div>
        <button type="button" class="cuenta-item-del" data-act="unfav" data-id="${escapeHtml(fav.id)}" aria-label="Quitar favorito">✕</button>`;
    },
  );
}

function renderFrequencies(freqs) {
  renderList(
    'cuenta-freqs',
    'cuenta-freqs-empty',
    freqs,
    (f) => {
      const left = f.left_frequency != null ? f.left_frequency : f.carrier_frequency;
      const right = f.right_frequency != null ? f.right_frequency : (f.carrier_frequency ?? 0) + (f.beat_frequency ?? 0);
      return `${freqCoverSVG(f, 40)}
        <div class="cuenta-item-body">
          <b>${escapeHtml(f.name)}</b>
          <small>${formatHz(left)} · ${formatHz(right)} · ritmo ${formatHz(f.beat_frequency)} · ${escapeHtml(f.waveform || 'sine')}</small>
        </div>
        <button type="button" class="cuenta-item-del" data-act="delfreq" data-id="${escapeHtml(f.id)}" aria-label="Eliminar frecuencia">✕</button>`;
    },
  );
}

function renderAlarms(alarms, its) {
  // Las alarmas que genera un paso de itinerario (ItineraryItem.alarm_id) no
  // se pueden borrar acá directo (el backend lo rechaza con 409, ver
  // routers/alarms.py): borrarla dejaba el paso con su horario intacto en
  // la grilla pero sin alarma real detrás. Se editan/borran desde su
  // itinerario en /rutina, no desde esta lista.
  const linkedIds = new Set();
  (its || []).forEach((it) => (it.items || []).forEach((item) => {
    if (item.alarm_id) linkedIds.add(item.alarm_id);
  }));
  renderList(
    'cuenta-alarms',
    'cuenta-alarms-empty',
    alarms,
    (a) => {
      const when = a.scheduled_at
        ? fmtDate(a.scheduled_at)
        : 'sin horario fijo';
      const rep = a.repeat_rule ? ` · ${escapeHtml(a.repeat_rule)}` : '';
      const linked = linkedIds.has(a.id);
      const del = linked
        ? `<small class="cuenta-item-note">🔗 Parte de un itinerario — editalo en /rutina</small>`
        : `<button type="button" class="cuenta-item-del" data-act="delalarm" data-id="${escapeHtml(a.id)}" aria-label="Eliminar alarma">✕</button>`;
      return `<div class="cuenta-item-body">
          <b>${escapeHtml(a.name || 'Recordatorio')} ${a.enabled ? '' : '<em>(desactivada)</em>'}</b>
          <small>${escapeHtml(when)} · ${escapeHtml(a.timezone || 'UTC')}${rep}</small>
        </div>
        ${del}`;
    },
  );
}


function renderDevices(items) {
  const permLabel = {
    granted: 'Notificaciones activadas',
    denied: 'Notificaciones bloqueadas',
    denied_permanently: 'Notificaciones bloqueadas (permanente)',
    not_requested: 'Sin pedir todavía',
    unavailable: 'Estado no disponible',
  };
  renderList(
    'cuenta-devices',
    'cuenta-devices-empty',
    items,
    (d) => {
      const ok = d.notification_permission === 'granted';
      const plat = { apk: 'APK Android', web: 'Web', pwa: 'PWA instalada' }[d.platform] || d.platform;
      const seen = d.last_seen_at ? fmtDate(d.last_seen_at) : '—';
      return `<div class="cuenta-item-body">
          <b>${escapeHtml(plat)}${d.app_version ? ` <small>· v${escapeHtml(d.app_version)}</small>` : ''}</b>
          <small class="${ok ? 'rs-live' : 'rs-warn'}">${escapeHtml(permLabel[d.notification_permission] || d.notification_permission)}${d.push_enabled ? ' · push activo' : ' · sin push'} · visto ${escapeHtml(seen)}</small>
        </div>
        <button type="button" class="cuenta-item-del" data-act="forgetdev" data-id="${escapeHtml(d.device_id)}" aria-label="Olvidar dispositivo">✕</button>`;
    },
    'Todavía no hay dispositivos registrados: entrá a la app desde otro dispositivo para verlo acá.',
  );
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return iso;
  }
}

function formatHz(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 10) / 10} Hz`;
}

// ── Push ────────────────────────────────────────────────────────────────────

let deviceSubscribed = null; // null = sin dato todavía, true/false = estado real

// Dentro de la APK no existe Web Push (file:// no es secure context y no hay
// service worker): los recordatorios los entrega el SISTEMA (AlarmManager +
// NotificationManager nativos). La tarjeta sigue siendo útil: "Activar" pide
// el permiso real de notificaciones de Android (POST_NOTIFICATIONS, Android
// 13+), que es lo que deja que las alarmas avisen con la app cerrada.
let nativeNotifState = 'NOT_REQUESTED'; // GRANTED|DENIED|DENIED_PERMANENTLY|NOT_REQUESTED|UNAVAILABLE

// Detección de APK en el arranque: `AndroidBridgeNative` (addJavascriptInterface)
// existe ANTES de cargar la página; el wrapper `window.AndroidBridge` recién lo
// crea Kotlin en onPageFinished. El badge de site.js usa el mismo criterio.
function isApk() {
  return (
    typeof window !== 'undefined' &&
    (typeof window.AndroidBridgeNative !== 'undefined' ||
      (window.AndroidBridge && typeof window.AndroidBridge.postMessage === 'function'))
  );
}

// Bridge nativo preferido: el wrapper (si ya existe) o el raw de arranque.
function nativeBridge() {
  const b =
    window.AndroidBridge && typeof window.AndroidBridge.postMessage === 'function'
      ? window.AndroidBridge
      : window.AndroidBridgeNative;
  return b || null;
}

async function readNativeNotificationState() {
  if (!isApk()) return;
  try {
    const b = nativeBridge();
    let info = b && b.getPlatformInfo ? b.getPlatformInfo() : null;
    if (typeof info === 'string') {
      try { info = JSON.parse(info); } catch (_) { info = null; }
    }
    nativeNotifState = (info && info.notificationPermission) || 'UNAVAILABLE';
  } catch (_) {
    nativeNotifState = 'UNAVAILABLE';
  }
}

async function readDeviceSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    deviceSubscribed = false;
    return;
  }
  try {
    // getRegistration() resuelve al instante (undefined si no hay service
    // worker); serviceWorker.ready colgaría para siempre en dev.
    const reg = await navigator.serviceWorker.getRegistration();
    deviceSubscribed = reg ? !!(await reg.pushManager.getSubscription()) : false;
  } catch (_) {
    deviceSubscribed = false;
  }
}

function secureContext() {
  return typeof window !== 'undefined' && window.isSecureContext;
}

// Antes el único indicador era una frase de texto gris perdida entre otras
// (misma clase .rutina-hint que cualquier aclaración) — nunca quedaba claro
// de un vistazo si estaba activo o no. Esta pastilla (mismo patrón visual de
// .roadmap-status que ya usa el resto del sitio) es el estado real en una
// palabra: Activo / Inactivo / Bloqueado, sin tener que leer el párrafo.
function setPushStatus(label, cls) {
  const badge = $('cuenta-push-status');
  if (!badge) return;
  badge.textContent = label;
  badge.className = `roadmap-status ${cls}`;
}

function renderPush() {
  const text = $('cuenta-push-text');
  const sub = $('cuenta-push-subscribe');
  const unsub = $('cuenta-push-unsubscribe');
  if (!text) return;

  // APK nativa: el permiso que importa es el del sistema (POST_NOTIFICATIONS),
  // no la suscripción Web Push. El estado se lee del bridge, siempre honesto.
  if (isApk()) {
    switch (nativeNotifState) {
      case 'GRANTED':
        setPushStatus('Activo', 'rs-live');
        text.textContent =
          '✅ Notificaciones activadas: tus recordatorios avisan en el teléfono incluso con la app cerrada.';
        if (sub) sub.disabled = true;
        if (unsub) unsub.disabled = false;
        return;
      case 'DENIED_PERMANENTLY':
        setPushStatus('Bloqueado', 'rs-bad');
        text.textContent =
          'Las notificaciones están apagadas en los Ajustes del sistema. Tocá "Desactivar" para abrirlas y habilitarlas.';
        if (sub) sub.disabled = true;
        if (unsub) unsub.disabled = false;
        return;
      case 'DENIED':
        setPushStatus('Rechazado', 'rs-bad');
        text.textContent =
          'Notificaciones rechazadas. Tocá "Activar" para volver a pedir el permiso del sistema.';
        if (sub) sub.disabled = false;
        if (unsub) unsub.disabled = false;
        return;
      default: // NOT_REQUESTED / UNAVAILABLE
        setPushStatus('Inactivo', 'rs-warn');
        text.textContent =
          'El servidor está listo (VAPID). Activá las notificaciones para recibir avisos de tus recordatorios.';
        if (sub) sub.disabled = false;
        if (unsub) unsub.disabled = true;
        return;
    }
  }

  if (!secureContext()) {
    setPushStatus('No disponible', 'rs-bad');
    text.textContent =
      'Este navegador no permite push sin HTTPS (solo localhost). En producción es automático.';
    if (sub) sub.disabled = true;
    if (unsub) unsub.disabled = true;
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setPushStatus('No disponible', 'rs-bad');
    text.textContent = 'Este navegador no soporta notificaciones push.';
    if (sub) sub.disabled = true;
    if (unsub) unsub.disabled = true;
    return;
  }
  if (!pushState.configured) {
    setPushStatus('No disponible', 'rs-bad');
    text.textContent = pushState.supported
      ? 'El servidor de notificaciones no está configurado todavía.'
      : 'El backend no está disponible: no se pueden activar las notificaciones ahora.';
    if (sub) sub.disabled = true;
    if (unsub) unsub.disabled = true;
    return;
  }
  if (deviceSubscribed === true) {
    setPushStatus('Activo', 'rs-live');
    text.textContent =
      '✅ Este dispositivo ya está suscrito: las notificaciones llegan incluso con la pestaña cerrada (web/PWA).';
    if (sub) sub.disabled = true;
    if (unsub) unsub.disabled = false;
    return;
  }
  // "denied" es permanente para JS: Notification.requestPermission() ya no
  // vuelve a mostrar el diálogo. Tocar "Activar" acá fallaría en silencio sin
  // esto — la única salida es reactivarlo a mano en los ajustes del sitio.
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    setPushStatus('Bloqueado', 'rs-bad');
    text.textContent =
      'Bloqueaste las notificaciones en este navegador. Para activarlas: tocá el candado 🔒 (o ⓘ) junto a la dirección del sitio → Permisos → Notificaciones → Permitir, y recargá la página.';
    if (sub) sub.disabled = true;
    if (unsub) unsub.disabled = true;
    return;
  }
  setPushStatus('Inactivo', 'rs-warn');
  if (lastPushError === 'browser-blocked-push-service') {
    // Brave (y otros navegadores centrados en privacidad) rechazan el
    // registro de push contra los servidores de Google salvo que el usuario
    // lo habilite a mano — no hay forma de detectarlo de antemano ni de
    // abrir esa pantalla de ajustes desde la web, solo explicarlo.
    text.textContent =
      'Tu navegador bloqueó el registro de notificaciones push (común en Brave y otros navegadores de privacidad). En Brave: Configuración → Privacidad y seguridad → activá "Usar servicios de Google para mensajería push", reiniciá el navegador y volvé a intentar.';
  } else {
    text.textContent = lastPushError
      ? `No se pudieron activar: ${lastPushError}.`
      : 'El servidor está listo (VAPID). Activá las notificaciones para recibir avisos de tus recordatorios.';
  }
  if (sub) sub.disabled = false;
  if (unsub) unsub.disabled = true;
}

async function refreshPush() {
  try {
    pushState = await pushStatus();
  } catch (_) {
    pushState = { supported: false, configured: false };
  }
  if (isApk()) {
    await readNativeNotificationState();
  } else {
    await readDeviceSubscription();
  }
  renderPush();
}

// ── Carga principal ─────────────────────────────────────────────────────────

let loadSeq = 0;

async function loadAll() {
  const seq = ++loadSeq;
  const syncEl = $('cuenta-sync-status');
  if (syncEl) {
    syncEl.textContent = 'Sincronizando…';
    syncEl.title = 'Consultando el backend';
  }

  const results = await Promise.allSettled([
    me(),
    listFavorites(),
    listFrequencies(),
    listAlarms(),
    listItineraries(),
    pushStatus(),
    listDevices(),
  ]);
  if (seq !== loadSeq) return;

  const [profile, favs, freqs, alarms, its, push, devices] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : null,
  );

  // Este dispositivo reporta su estado real (APK nativo / web / PWA).
  reportDevice();

  if (profile) {
    hideSessionRecovery();
    renderProfile(profile);
  } else {
    // Distinguir el motivo: si es un problema de red la sesión sigue válida
    // (mensaje honesto + reintentar); si el servidor devolvió 401 la sesión
    // venció (botón para iniciar sesión acá mismo y chip de la nav al día).
    const meErr = results[0] && results[0].reason;
    const isNetwork = meErr && meErr.status === 0;
    const isExpired = meErr && meErr.status === 401;
    $('cuenta-name').textContent = isNetwork
      ? 'Sin conexión con el servidor'
      : isExpired
        ? 'Sesión expirada'
        : 'Sesión no disponible';
    $('cuenta-email').textContent = isNetwork
      ? 'Tu sesión sigue guardada; reintentá cuando vuelva la conexión.'
      : isExpired
        ? 'Tu sesión venció: iniciá sesión para volver a sincronizar.'
        : 'Reiniciá sesión para seguir sincronizando.';
    renderVerify(null);
    showSessionRecovery(isNetwork);
    // Sesión realmente inválida: sincronizar el chip de la nav (evita el
    // estado "logueado" fantasma) sin tocar las demás pestañas.
    if (isExpired && window.__vyneuralAuth && typeof window.__vyneuralAuth.expireSession === 'function') {
      window.__vyneuralAuth.expireSession();
    }
  }

  renderFavorites(favs || []);
  renderFrequencies(freqs || []);
  renderAlarms(alarms || [], its || []);
  renderDevices(devices || []);
  if (push) pushState = push;
  if (isApk()) {
    await readNativeNotificationState();
  } else {
    await readDeviceSubscription();
  }
  renderPush();

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (syncEl) {
    if (failed === 0) {
      syncEl.textContent = 'Sincronizado ✓';
      syncEl.title = 'Todo lo que ves está respaldado en la nube';
    } else {
      syncEl.textContent = 'Parcial';
      syncEl.title = `${failed} recurso(s) sin conexión. Lo local sigue funcionando.`;
    }
  }
  const hint = $('cuenta-sync-hint');
  if (hint) hint.textContent = failed === 0
    ? 'Todo sincronizado: perfil, favoritos, frecuencias, alarmas y push viven en la nube y en este dispositivo.'
    : 'La sincronización es aditiva: si el servidor no está disponible, todo sigue guardado en este dispositivo.';

  // Señal para loadAllOnBoot(): ¿alguno de los 7 pedidos falló por un
  // motivo transitorio (red/servidor caído, típico de un cold start de
  // Render) en vez de un error real (401, 404, etc.)? Si es así, vale la
  // pena reintentar todo el lote — casi seguro fallaron todos por la MISMA
  // razón (el backend estaba dormido), no por 7 causas distintas.
  return results.some((r) => r.status === 'rejected' && r.reason && (r.reason.status === 0 || r.reason.status >= 500));
}

// Solo para el arranque (init()): un cold start de Render (20-50s) hacía
// que el ÚNICO intento de loadAll() de la carga de página fallara para los
// 7 recursos a la vez con un error de red — transitorio, no "no hay
// datos". Sin reintentos, la tarjeta de perfil quedaba en "Sin conexión con
// el servidor" (con un botón "Reintentar" manual) y favoritos/frecuencias/
// alarmas/itinerarios vacíos hasta que el usuario tocara ese botón — mismo
// bug y mismo fix que refreshProfileOnBoot() (ui/auth.js) y
// loadCommentsOnBoot() (comments.js). El botón "Reintentar" sigue andando
// igual (showSessionRecovery) para quien no quiera esperar.
async function loadAllOnBoot() {
  const RETRY_DELAYS_MS = [3000, 6000, 12000, 20000]; // ~41s de cobertura
  for (let attempt = 0; ; attempt++) {
    const needsRetry = await loadAll();
    if (!needsRetry || attempt >= RETRY_DELAYS_MS.length) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

// Recuperación de sesión: botones en la tarjeta de perfil cuando /me falla.
function showSessionRecovery(networkOnly) {
  const wrap = $('cuenta-session-recovery');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  const login = $('cuenta-recover-login');
  const retry = $('cuenta-recover-retry');
  if (login) login.classList.toggle('hidden', networkOnly);
  if (retry) retry.classList.toggle('hidden', !networkOnly);
}

function hideSessionRecovery() {
  const wrap = $('cuenta-session-recovery');
  if (wrap) wrap.classList.add('hidden');
}

// ── Acciones ────────────────────────────────────────────────────────────────

async function handleAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === 'unfav') {
    await removeFavorite(id).catch(() => {});
  } else if (act === 'delfreq') {
    await deleteFrequency(id).catch(() => {});
  } else if (act === 'delalarm') {
    await deleteAlarm(id).catch(() => {});
    notifyNativeAlarmsChanged();
  } else if (act === 'forgetdev') {
    await forgetDevice(id).catch(() => {});
  }
  loadAll();
}

function wireForms() {
  // Guardar frecuencias: modal compartido con el generador (misma UX).
  const freqBtn = $('cuenta-create-freq-btn');
  if (freqBtn) {
    freqBtn.addEventListener('click', () => {
      const ok = openFreqModal({ source: 'cuenta' });
      if (ok) freqBtn.blur();
    });
  }
  // Tras guardar desde el modal, la lista se refresca sola.
  document.addEventListener('vyneural:freq-saved', async () => {
    await loadAll();
  });
}

function wirePushButtons() {
  const sub = $('cuenta-push-subscribe');
  const unsub = $('cuenta-push-unsubscribe');
  if (sub) {
    sub.addEventListener('click', async () => {
      sub.disabled = true;
      if (isApk()) {
        // Pide el permiso REAL de Android (POST_NOTIFICATIONS) vía bridge; el
        // resultado se re-lee al volver (visibilitychange).
        await requestPermission();
        await readNativeNotificationState();
        renderPush();
        return;
      }
      const r = await subscribeToPush();
      if (r.subscribed) {
        deviceSubscribed = true;
        lastPushError = null;
      } else {
        lastPushError = r.reason || 'desconocido';
      }
      renderPush();
    });
  }
  if (unsub) {
    unsub.addEventListener('click', async () => {
      unsub.disabled = true;
      if (isApk()) {
        // "Desactivar" en la APK = abrir los Ajustes de notificaciones del
        // sistema (donde el usuario puede apagar/habilitar la app).
        try {
          const b = nativeBridge();
          if (b && b.postMessage) b.postMessage(JSON.stringify({ command: 'OPEN_NOTIFICATION_SETTINGS' }));
        } catch (_) { /* bridge ocupado: la UI sigue siendo honesta */ }
        renderPush();
        return;
      }
      const ok = await unsubscribeFromPush();
      if (ok) deviceSubscribed = false;
      const text = $('cuenta-push-text');
      if (text && !ok) text.textContent = 'No había suscripción activa.';
      renderPush();
    });
  }
}

// ── Cambio de contraseña ───────────────────────────────────────────────────

function validatePasswordStrength(pw) {
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'La contraseña debe tener letras y números.';
  return '';
}

function wirePasswordForm() {
  const form = $('password-form');
  if (!form) return;
  const errEl = $('pw-error');
  const btn = $('pw-submit');
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errEl.classList.add('hidden');
    const current = $('pw-current').value;
    const next = $('pw-new').value;
    const confirm = $('pw-confirm').value;
    const err = validatePasswordStrength(next);
    if (err) return showErr(err);
    if (next !== confirm) return showErr('Las contraseñas nuevas no coinciden.');
    if (next === current) return showErr('La contraseña nueva debe ser distinta de la actual.');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      await changePassword(current, next);
      form.reset();
      errEl.classList.remove('auth-error');
      errEl.classList.add('auth-ok');
      showErr('Contraseña actualizada ✓. Cerramos las demás sesiones: iniciá sesión de nuevo en tus otros dispositivos.');
    } catch (e2) {
      showErr((e2 && e2.detail) || 'No se pudo cambiar la contraseña. Verificá la contraseña actual.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Actualizar contraseña';
    }
  });
}

// ── Desactivar cuenta ───────────────────────────────────────────────────────

function wireDeactivateAccount() {
  const openBtn = $('deactivate-open');
  const modal = $('deactivate-modal');
  const closeBtn = $('deactivate-close');
  const form = $('deactivate-form');
  if (!openBtn || !modal || !form) return;
  const errEl = $('deactivate-error');
  const pwEl = $('deactivate-password');
  const submitBtn = $('deactivate-submit');
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  };
  const close = () => {
    modal.classList.add('hidden');
    form.reset();
    errEl.classList.add('hidden');
  };
  openBtn.addEventListener('click', () => {
    modal.classList.remove('hidden');
    if (pwEl) pwEl.focus();
  });
  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Desactivando…';
    try {
      await deactivateAccount(pwEl.value);
      // Misma señal que un logout real: la nav y el resto de la app deben
      // verse igual de "sin sesión" que si el usuario hubiera cerrado sesión
      // a mano — la cuenta quedó bloqueada, no hay nada más que sincronizar.
      document.dispatchEvent(new CustomEvent('vyneural:auth', { detail: { type: 'logout' } }));
      close();
      renderGate();
    } catch (err) {
      showErr((err && err.detail) || 'No se pudo desactivar la cuenta. Verificá la contraseña.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sí, desactivar mi cuenta';
    }
  });
}

// ── Arranque ────────────────────────────────────────────────────────────────

function init() {
  renderGate({ retryOnBoot: true });

  const recoverLogin = $('cuenta-recover-login');
  if (recoverLogin) {
    recoverLogin.addEventListener('click', () => {
      hideSessionRecovery();
      openAuth('login');
    });
  }
  const recoverRetry = $('cuenta-recover-retry');
  if (recoverRetry) {
    recoverRetry.addEventListener('click', () => {
      hideSessionRecovery();
      loadAll();
    });
  }

  const loginBtn = $('cuenta-login-btn');
  const regBtn = $('cuenta-register-btn');
  if (loginBtn) loginBtn.addEventListener('click', () => openAuth('login'));
  if (regBtn) regBtn.addEventListener('click', () => openAuth('register'));

  const logoutBtn = $('cuenta-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const auth = window.__vyneuralAuth;
      if (auth && typeof auth.logout === 'function') {
        await auth.logout();
      } else {
        // Sin auth.js (carga rara): limpiar la sesión local.
        const { clearSession } = await import('./api/client.js');
        clearSession();
        renderGate();
      }
    });
  }

  document.addEventListener('click', handleAction);
  wireForms();
  wirePushButtons();

  // Tras el diálogo nativo de permisos (o volver de Ajustes) el WebView
  // reaparece: re-leer el estado real del permiso y repintar la tarjeta.
  if (isApk()) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        readNativeNotificationState().then(renderPush);
      }
    });
  }
  wireVerify();
  wirePasswordForm();
  wireDeactivateAccount();

  // Estado de sincronización en vivo.
  const syncEl = $('cuenta-sync-status');
  if (syncEl) {
    const labels = {
      [STATUS.OFFLINE]: 'Offline',
      [STATUS.ONLINE]: 'En línea',
      [STATUS.SYNCING]: 'Sincronizando…',
      [STATUS.SYNCED]: 'Sincronizado ✓',
      [STATUS.ERROR]: 'Error de conexión',
    };
    const paint = (s) => {
      if (getAccessToken()) return; // loadAll() pinta el estado real.
      syncEl.textContent = labels[s] || s;
    };
    paint(getStatus());
    onStatusChange(paint);
  }

  // Refrescar al autenticarse / cerrar sesión desde cualquier parte.
  document.addEventListener('vyneural:auth', () => {
    renderGate();
    if (getAccessToken()) loadAll();
  });
}

document.addEventListener('DOMContentLoaded', init, { once: true });
