// ════════════════════════════════════════════════════════════════════════════
// Burbuja flotante de chat de soporte 1:1 con el admin (todas las páginas).
// ─────────────────────────────────────────────────────────────────────────────
// Reemplaza a la antigua burbuja "Reportar un problema" (ver git history /
// docs/FEEDBACK_TOOLS.md para el mecanismo viejo basado en FormSubmit, ya
// retirado): en vez de un formulario a un tercero sin backend, esto habla
// directo con el backend REAL de Vyneural (otro repo, ya deployado — ver
// api/support.js), que ya requiere sesión.
//
// Shell FAB+modal calcado de report-bug.js (mismo patrón build()/open()/
// close(), mismo guard de módulo, misma API window.__bugReport — se
// mantiene ese nombre a propósito: es el único punto de integración externo
// real (el menú ⋯ del generador, ver main.js action==='bug') y renombrarlo
// no aporta nada, solo un riesgo de romper esa llamada si algo se olvida).
//
// Estado del chat (mensajes, id de conversación, "visto hasta cuándo") vive
// en variables de módulo + un espejo liviano en localStorage, así una
// conversación abierta sobrevive a un reload de página sin tener que
// reabrir el modal para saber que sigue ahí.
//
// TRADE-OFF DE DISEÑO — polling de fondo vs. depender solo del push:
// El contrato de backend dado NO incluye ningún push al USUARIO cuando el
// ADMIN responde (solo se menciona notificación al admin cuando el usuario
// escribe). Sin un canal de push confirmado en esa dirección, depender
// "100% del push" para avisar de una respuesta nueva significaría que el
// aviso proactivo (el banner de "mensaje nuevo") nunca se dispararía en la
// práctica — el usuario tendría que adivinar que debe reabrir el chat.  Por
// eso se implementa un polling de fondo, pero ACOTADO para no ser un costo
// permanente:
//   · Solo corre si YA existe una conversación conocida (localStorage) —
//     nunca crea una conversación ni gasta requests para alguien que nunca
//     usó el chat.
//   · Espaciado (45 s, no los 4 s del polling en foreground) y se pausa por
//     completo con la pestaña oculta (visibilitychange), igual criterio que
//     degraded-alarm-banner.js.
//   · Se apaga solo si el servidor confirma que la conversación ya no existe
//     (404, p. ej. calificada desde otro dispositivo) o la sesión no sirve
//     (401) — no insiste indefinidamente contra un recurso muerto.
// Si en el futuro el backend agrega push real para respuestas del admin,
// este polling de fondo puede espaciarse aún más o quitarse del todo; hoy es
// la única señal disponible para el banner mientras el chat está cerrado.
// ════════════════════════════════════════════════════════════════════════════

import { getOrCreateConversation, sendMessage, getMessages, rateConversation, reportBug } from './api/support.js';
import { ApiError } from './api/client.js';
import { openSupportSocket } from './api/support-ws-client.js';
import { isPremiumUser } from './ui/premium-gate.js';

const LS_CONV_ID = 'vyneural_support_conversation_id';
const LS_LAST_SEEN = 'vyneural_support_last_seen_at';

// 4-6 respuestas rápidas sugeridas para cerrar sin escribir (tal cual pedido).
const CANNED_MESSAGES = ['Rápido y claro', 'Buena atención', 'No se resolvió mi problema', 'Tardó mucho', 'Otro'];

const FOREGROUND_POLL_MS = 4000; // chat abierto: casi en vivo
const BACKGROUND_POLL_MS = 45000; // chat cerrado: solo para el banner, más barato

function lsGet(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function lsSet(key, val) {
  try {
    if (val) localStorage.setItem(key, val);
    else localStorage.removeItem(key);
  } catch {
    /* sin almacenamiento disponible: el chat sigue funcionando en memoria */
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isLoggedIn() {
  return !!(window.__vyneuralAuth && window.__vyneuralAuth.isLoggedIn());
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Clave de "día calendario" local (no UTC) para agrupar mensajes por fecha
 * — mismo criterio que admin.js::chatDayKey, duplicado acá porque este
 * archivo no comparte módulo con el panel de admin. */
function chatDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Texto del separador de fecha: "Hoy" / "Ayer" / fecha corta ("24 sep"). */
function fmtChatDaySeparator(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (chatDayKey(iso) === chatDayKey(today)) return 'Hoy';
  if (chatDayKey(iso) === chatDayKey(yesterday)) return 'Ayer';
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

// ─────────────────────────────────────────────────────────── Construcción UI
function build() {
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'support-fab';
  fab.className = 'support-fab';
  fab.setAttribute('aria-label', 'Chat de soporte');
  fab.setAttribute('title', 'Chat de soporte');
  fab.innerHTML = `
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
    <span class="support-fab-pulse" aria-hidden="true"></span>
    <span class="support-fab-label">Chat de soporte</span>
  `;

  const modal = document.createElement('div');
  modal.id = 'support-modal';
  modal.className = 'support-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="support-modal-card" role="dialog" aria-modal="true" aria-labelledby="support-modal-title">
      <div class="support-modal-head">
        <h3 id="support-modal-title">💬 Chat de soporte<span class="support-conn-dot" id="support-conn-dot" title="Sincronizando…" aria-hidden="true"></span></h3>
        <button type="button" id="support-close" class="support-close" aria-label="Cerrar">✕</button>
      </div>

      <div id="support-chat-view">
        <p class="support-sub">
          Hablá en vivo con el equipo de Vyneural. Te contestamos apenas podamos —
          quedate tranquilo, tu conversación sigue acá si cerrás y volvés más tarde.
        </p>
        <div id="support-messages" class="support-messages" role="log" aria-live="polite"></div>
        <p id="support-status" class="support-status hidden"></p>
        <form id="support-form" class="support-form" novalidate>
          <input
            type="text"
            id="support-input"
            name="mensaje"
            maxlength="2000"
            placeholder="Escribí tu mensaje…"
            autocomplete="off"
          />
          <button type="submit" id="support-send" class="support-send">Enviar</button>
        </form>
        <button type="button" id="support-rate-open" class="support-rate-link">Cerrar y calificar</button>
      </div>

      <div id="support-rate-view" hidden>
        <p class="support-sub">¿Cómo fue la atención? Tu conversación se cierra al calificar.</p>
        <div class="support-star-input" id="support-star-input" role="radiogroup" aria-label="Valoración en estrellas">
          <button type="button" class="c-star" data-r="1" aria-label="1 estrella" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="2" aria-label="2 estrellas" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="3" aria-label="3 estrellas" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="4" aria-label="4 estrellas" aria-pressed="false">★</button>
          <button type="button" class="c-star" data-r="5" aria-label="5 estrellas" aria-pressed="false">★</button>
        </div>
        <p id="support-rate-error" class="support-status support-status-error hidden"></p>
        <div class="support-canned-list" id="support-canned-list">
          ${CANNED_MESSAGES.map((m) => `<button type="button" class="support-canned-btn" data-msg="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('')}
        </div>
        <button type="button" id="support-rate-skip" class="support-rate-link">Finalizar sin comentario</button>
        <button type="button" id="support-rate-back" class="support-rate-link">Volver al chat</button>
      </div>

      <div id="support-report-view" hidden>
        <p class="support-sub">
          El chat en vivo es para cuentas Premium. Contanos qué pasó y te
          respondemos por correo apenas podamos.
        </p>
        <form id="support-report-form" class="support-form-stack" novalidate>
          <textarea
            id="support-report-input"
            name="mensaje"
            maxlength="2000"
            rows="4"
            placeholder="Contanos qué problema encontraste…"
            required
          ></textarea>
          <button type="submit" id="support-report-send" class="support-send">Enviar reporte</button>
        </form>
        <p id="support-report-status" class="support-status hidden"></p>
      </div>
    </div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(modal);
  return { fab, modal };
}

// Banner de "mensaje nuevo" con el chat cerrado — mismo patrón inject-once +
// render()-togglea-.hidden que degraded-alarm-banner.js, adaptado: acá el
// "issue" es un booleano simple (hay mensaje de admin sin ver), no una
// cascada de causas.
const BANNER_HTML = `
<div id="support-new-message-banner" class="support-new-message-banner hidden" role="status">
  <span class="support-new-message-text" id="support-new-message-text">💬 Tenés un mensaje nuevo de soporte.</span>
  <button type="button" id="support-banner-open" class="support-banner-open">Ver</button>
  <button type="button" id="support-banner-dismiss" class="support-banner-dismiss" aria-label="Ahora no">✕</button>
</div>`;

let bannerInjected = false;
function ensureBanner(onOpen) {
  if (bannerInjected) return;
  bannerInjected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = BANNER_HTML.trim();
  const el = wrap.firstElementChild;
  document.body.insertBefore(el, document.body.firstChild);
  document.getElementById('support-banner-open').addEventListener('click', () => {
    hideBanner();
    onOpen();
  });
  document.getElementById('support-banner-dismiss').addEventListener('click', hideBanner);
}
function showBanner() {
  const el = document.getElementById('support-new-message-banner');
  if (el) el.classList.remove('hidden');
}
function hideBanner() {
  const el = document.getElementById('support-new-message-banner');
  if (el) el.classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────── Comportamiento
let __api = null;

export function initSupportChat() {
  // Doble inicialización (p. ej. si main.js llegara a importar el módulo):
  // la burbuja/modal solo se construyen UNA vez por página.
  if (__api) return __api;
  const { fab, modal } = build();
  const chatView = modal.querySelector('#support-chat-view');
  const rateView = modal.querySelector('#support-rate-view');
  const reportView = modal.querySelector('#support-report-view');
  const messagesEl = modal.querySelector('#support-messages');
  const statusEl = modal.querySelector('#support-status');
  const form = modal.querySelector('#support-form');
  const input = modal.querySelector('#support-input');
  const sendBtn = modal.querySelector('#support-send');
  const closeBtn = modal.querySelector('#support-close');
  const rateOpenBtn = modal.querySelector('#support-rate-open');
  const rateBackBtn = modal.querySelector('#support-rate-back');
  const rateSkipBtn = modal.querySelector('#support-rate-skip');
  const rateErrorEl = modal.querySelector('#support-rate-error');
  const cannedListEl = modal.querySelector('#support-canned-list');
  const starInputEl = modal.querySelector('#support-star-input');
  const connDotEl = modal.querySelector('#support-conn-dot');
  const reportForm = modal.querySelector('#support-report-form');
  const reportInput = modal.querySelector('#support-report-input');
  const reportSendBtn = modal.querySelector('#support-report-send');
  const reportStatusEl = modal.querySelector('#support-report-status');

  let conversationId = lsGet(LS_CONV_ID) || null;
  let lastSeenAt = lsGet(LS_LAST_SEEN) || null;
  let foregroundTimer = null;
  let backgroundTimer = null;
  let rating = 0;
  // Dedup por id: WebSocket y polling pueden entregar el MISMO mensaje (el
  // socket es instantáneo, un poll ya en vuelo con un `since` viejo puede
  // devolver de nuevo lo que el socket ya entregó momentos antes) — sin
  // esto, ese mensaje se pintaría dos veces en el chat.
  let seenMessageIds = new Set();
  let wsHandle = null;
  // Estado de agrupación del hilo (mismo criterio que admin.js): recuerda el
  // remitente/día del último mensaje pintado para suprimir la etiqueta de
  // remitente repetida e insertar separadores de fecha, persistiendo entre
  // llamadas a appendMessages (polling/socket van agregando de a uno).
  // Se resetea junto con el resto del estado del chat (ver ensureConversation
  // y resetLocalState, donde messagesEl.innerHTML ya se limpia).
  let lastRenderedSender = null;
  let lastRenderedDay = null;

  function setConnStatus(status) {
    if (!connDotEl) return;
    connDotEl.classList.remove('is-open', 'is-connecting', 'is-down');
    if (status === 'open') {
      connDotEl.classList.add('is-open');
      connDotEl.title = 'En vivo';
    } else if (status === 'connecting') {
      connDotEl.classList.add('is-connecting');
      connDotEl.title = 'Conectando…';
    } else {
      connDotEl.classList.add('is-down');
      connDotEl.title = 'Sincronizando (sin conexión en vivo)';
    }
  }

  function stopSocket() {
    if (wsHandle) {
      wsHandle.close();
      wsHandle = null;
    }
    setConnStatus('down');
  }

  function startSocket() {
    if (!conversationId || wsHandle) return;
    wsHandle = openSupportSocket(conversationId, {
      onMessage: (m) => appendMessages([m]),
      onStatusChange: setConnStatus,
    });
  }

  // `el` es opcional (default: el status del chat en vivo) — el formulario
  // de reporte reusa exactamente el mismo patrón contra su propio <p>.
  function showStatus(text, isError, el = statusEl) {
    el.textContent = text;
    el.classList.toggle('support-status-error', !!isError);
    el.classList.remove('hidden');
  }
  function clearStatus(el = statusEl) {
    el.classList.add('hidden');
    el.textContent = '';
  }

  function persist() {
    lsSet(LS_CONV_ID, conversationId || '');
    lsSet(LS_LAST_SEEN, lastSeenAt || '');
  }

  // Tras calificar (o si el servidor confirma que la conversación ya no
  // existe): limpiar TODO el estado local, no solo el del servidor — si no,
  // la próxima apertura seguiría intentando pollear/mandar mensajes a un id
  // borrado, o el banner de fondo insistiría contra un 404 para siempre.
  function resetLocalState() {
    stopSocket();
    conversationId = null;
    lastSeenAt = null;
    rating = 0;
    seenMessageIds = new Set();
    lastRenderedSender = null;
    lastRenderedDay = null;
    lsSet(LS_CONV_ID, '');
    lsSet(LS_LAST_SEEN, '');
    messagesEl.innerHTML = '';
    hideBanner();
  }

  function appendMessages(list) {
    let appended = false;
    (list || []).forEach((m) => {
      if (m.id) {
        if (seenMessageIds.has(m.id)) return;
        seenMessageIds.add(m.id);
      }
      appended = true;
      const day = chatDayKey(m.created_at);
      if (day !== lastRenderedDay) {
        const sep = document.createElement('div');
        sep.className = 'support-date-separator';
        sep.textContent = fmtChatDaySeparator(m.created_at);
        messagesEl.appendChild(sep);
      }
      const showSender = day !== lastRenderedDay || m.sender !== lastRenderedSender;
      lastRenderedDay = day;
      lastRenderedSender = m.sender;
      const div = document.createElement('div');
      div.className = `support-msg support-msg-${m.sender === 'admin' ? 'admin' : 'user'}`;
      if (showSender) {
        const sender = document.createElement('span');
        sender.className = 'support-msg-sender';
        sender.textContent = m.sender === 'admin' ? 'Soporte' : 'Tú';
        div.appendChild(sender);
      }
      const p = document.createElement('p');
      p.className = 'support-msg-text';
      p.textContent = m.content;
      const time = document.createElement('span');
      time.className = 'support-msg-time';
      time.textContent = fmtTime(m.created_at);
      div.appendChild(p);
      div.appendChild(time);
      messagesEl.appendChild(div);
      if (m.created_at && (!lastSeenAt || m.created_at > lastSeenAt)) lastSeenAt = m.created_at;
    });
    if (appended) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Mismos 3-4 pasos que el click de "Cerrar y calificar" (rateOpenBtn más
  // abajo) — factorizado para poder llamarlo también desde ensureConversation
  // cuando el admin ya marcó la conversación como resuelta (ver
  // admin_marked_resolved más abajo), sin duplicar la lógica de reseteo de
  // estrellas/errores.
  function showRateView() {
    chatView.hidden = true;
    rateView.hidden = false;
    rating = 0;
    paintStars();
    rateErrorEl.classList.add('hidden');
  }

  async function ensureConversation() {
    if (!isLoggedIn()) {
      showStatus('Necesitás iniciar sesión para usar el chat de soporte.', true);
      if (window.__vyneuralAuth && typeof window.__vyneuralAuth.open === 'function') {
        window.__vyneuralAuth.open('login');
      }
      return false;
    }
    try {
      const conv = await getOrCreateConversation();
      conversationId = conv.id;
      messagesEl.innerHTML = '';
      lastSeenAt = null;
      seenMessageIds = new Set();
      lastRenderedSender = null;
      lastRenderedDay = null;
      appendMessages(conv.messages);
      persist();
      hideBanner();
      clearStatus();
      // El admin ya marcó esta conversación como resuelta (ver
      // routers/support.py::admin_mark_resolved) — en vez de la vista normal
      // de chat, mandar directo a calificar: es la señal para que el usuario
      // la cierre (rate_conversation sigue siendo lo único que la cierra
      // realmente del lado servidor).
      if (conv.admin_marked_resolved) {
        showRateView();
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        showStatus('Estás enviando demasiadas solicitudes — esperá un momento.', true);
      } else {
        showStatus((err && err.detail) || 'No se pudo conectar con soporte. Probá de nuevo en un momento.', true);
      }
      return false;
    }
  }

  function stopForegroundPoll() {
    if (foregroundTimer) {
      clearInterval(foregroundTimer);
      foregroundTimer = null;
    }
  }
  function startForegroundPoll() {
    stopForegroundPoll();
    foregroundTimer = setInterval(async () => {
      if (!conversationId) return;
      try {
        const fresh = await getMessages(conversationId, lastSeenAt);
        if (fresh && fresh.length) appendMessages(fresh);
      } catch {
        // Silencioso a propósito: es un tick de polling, no una acción del
        // usuario — no tiene sentido mostrar un error por cada intento
        // fallido cada 4s; el próximo tick reintenta solo.
      }
    }, FOREGROUND_POLL_MS);
  }

  function stopBackgroundPoll() {
    if (backgroundTimer) {
      clearInterval(backgroundTimer);
      backgroundTimer = null;
    }
  }
  async function backgroundCheck() {
    if (!modal.hidden) return; // el poll en foreground ya cubre esto
    if (!conversationId || document.hidden) return;
    try {
      const fresh = await getMessages(conversationId, lastSeenAt);
      if (fresh && fresh.length) {
        const hasAdmin = fresh.some((m) => m.sender === 'admin');
        fresh.forEach((m) => {
          if (m.created_at && (!lastSeenAt || m.created_at > lastSeenAt)) lastSeenAt = m.created_at;
        });
        persist();
        if (hasAdmin) {
          ensureBanner(open);
          showBanner();
        }
      }
    } catch (err) {
      // Conversación borrada del lado servidor (p. ej. calificada desde otro
      // dispositivo) o sesión inválida: dejar de insistir contra un recurso
      // muerto por el resto de esta carga de página.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
        resetLocalState();
        stopBackgroundPoll();
      }
    }
  }
  function startBackgroundPoll() {
    stopBackgroundPoll();
    backgroundTimer = setInterval(backgroundCheck, BACKGROUND_POLL_MS);
  }

  // Premium gatea el chat en vivo (ver cabecera del módulo): un usuario
  // logueado pero no-Premium ve el formulario de reporte simple en vez del
  // chat, y nunca llega a abrir una conversación ni a pollear/conectar el
  // socket. isPremiumUser() se llama recién ACÁ (al hacer click en el FAB),
  // nunca de entrada al cargar el módulo — así ningún visitante paga el
  // round-trip de red solo por tener la burbuja montada en la página.
  async function open() {
    modal.hidden = false;
    document.body.classList.add('support-modal-open');
    hideBanner();
    stopBackgroundPoll();

    if (!isLoggedIn()) {
      // Sin sesión: comportamiento intacto — se deja que ensureConversation()
      // (que ya chequea isLoggedIn() primero) muestre el gate de "iniciá
      // sesión" de siempre sobre la vista de chat. Nunca se llega a chequear
      // premium ni se muestra el formulario de reporte a un anónimo.
      chatView.hidden = false;
      reportView.hidden = true;
      rateView.hidden = true;
      window.setTimeout(() => input && input.focus(), 30);
      ensureConversation();
      return;
    }

    const premium = await isPremiumUser();
    chatView.hidden = !premium;
    reportView.hidden = premium;
    rateView.hidden = true;

    if (premium) {
      window.setTimeout(() => input && input.focus(), 30);
      ensureConversation().then((ok) => {
        if (ok) {
          startForegroundPoll();
          startSocket();
        }
      });
    } else {
      window.setTimeout(() => reportInput && reportInput.focus(), 30);
    }
  }
  function close() {
    modal.hidden = true;
    document.body.classList.remove('support-modal-open');
    stopForegroundPoll();
    stopSocket();
    persist();
    // Solo con una conversación real y sin calificar todavía tiene sentido
    // seguir mirando de fondo si el admin contesta.
    if (conversationId) startBackgroundPoll();
    fab.focus();
  }

  // Exponer la API (open/close) para el menú ⋯ y para integraciones. Se
  // mantiene el nombre histórico window.__bugReport (ver cabecera del
  // archivo): es el único integrador externo real y no vale la pena el
  // riesgo de renombrarlo.
  __api = { open, close, fab };
  window.__bugReport = __api;

  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = (input.value || '').trim();
    if (!content) return;
    if (!conversationId) {
      showStatus('Todavía no se pudo abrir el chat — probá de nuevo en un momento.', true);
      return;
    }
    sendBtn.disabled = true;
    input.disabled = true;
    try {
      const msg = await sendMessage(conversationId, content);
      appendMessages([msg]);
      persist();
      input.value = '';
      clearStatus();
    } catch (err) {
      // Rate-limit / errores de red: mensaje legible, SIN reintento
      // automático (pedido explícito) — el usuario decide si reintenta.
      if (err instanceof ApiError && err.status === 429) {
        showStatus('Estás enviando mensajes muy rápido — esperá un momento antes de reintentar.', true);
      } else {
        showStatus((err && err.detail) || 'No se pudo enviar el mensaje.', true);
      }
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  });

  // Reporte simple (no-Premium): un solo POST, sin conversación ni id — nada
  // que persistir en localStorage ni que pollear después de esto.
  reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = (reportInput.value || '').trim();
    if (!message) return;
    reportSendBtn.disabled = true;
    reportInput.disabled = true;
    try {
      await reportBug(message, window.location.pathname);
      reportInput.value = '';
      showStatus('Listo, recibimos tu reporte — te respondemos por correo apenas podamos.', false, reportStatusEl);
    } catch (err) {
      // Mismo criterio que el envío del chat: mensaje legible, sin reintento
      // automático.
      if (err instanceof ApiError && err.status === 429) {
        showStatus('Estás enviando demasiadas solicitudes — esperá un momento.', true, reportStatusEl);
      } else {
        showStatus((err && err.detail) || 'No se pudo enviar el reporte.', true, reportStatusEl);
      }
    } finally {
      reportSendBtn.disabled = false;
      reportInput.disabled = false;
    }
  });

  // ── Calificación (plantilla exacta de comments.js: starsHTML/paintStars) ─
  function paintStars() {
    starInputEl.querySelectorAll('.c-star').forEach((b) => {
      const r = Number(b.dataset.r);
      const on = r <= rating;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  starInputEl.addEventListener('click', (e) => {
    const star = e.target.closest('.c-star');
    if (!star) return;
    rating = Number(star.dataset.r);
    paintStars();
    rateErrorEl.classList.add('hidden');
  });

  rateOpenBtn.addEventListener('click', showRateView);
  rateBackBtn.addEventListener('click', () => {
    rateView.hidden = true;
    chatView.hidden = false;
  });

  async function finalizeRating(cannedMessage) {
    if (!rating) {
      rateErrorEl.textContent = 'Elegí una valoración de 1 a 5 estrellas.';
      rateErrorEl.classList.remove('hidden');
      return;
    }
    if (!conversationId) {
      // Nada que calificar del lado servidor (nunca se abrió una
      // conversación real) — solo cerrar.
      close();
      return;
    }
    try {
      await rateConversation(conversationId, rating, cannedMessage || undefined);
      resetLocalState();
      close();
    } catch (err) {
      rateErrorEl.textContent = (err && err.detail) || 'No se pudo enviar la calificación. Probá de nuevo.';
      rateErrorEl.classList.remove('hidden');
    }
  }
  // Click en un mensaje predeterminado: envía directo (mensaje predeterminado
  // opcional en el sentido de que "Finalizar sin comentario" existe como
  // alternativa, pero elegir estrellas SÍ es obligatorio en ambos caminos —
  // igual criterio que comments.js, que tampoco deja calificar sin estrellas).
  cannedListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.support-canned-btn');
    if (!btn) return;
    finalizeRating(btn.dataset.msg);
  });
  rateSkipBtn.addEventListener('click', () => finalizeRating(null));

  // Reanudar el chequeo de fondo al volver a foreground (misma idea que
  // degraded-alarm-banner.js): evita esperar hasta 45s tras volver a la
  // pestaña si ya había una respuesta esperando.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && modal.hidden && conversationId) backgroundCheck();
  });

  // Al cargar la página: si ya había una conversación de una sesión
  // anterior (localStorage), arrancar el polling de fondo espaciado — ver
  // el trade-off documentado en la cabecera del archivo.
  if (conversationId) startBackgroundPoll();

  return __api;
}

// Auto-inicialización (páginas estáticas que cargan este módulo vía site.js).
if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  initSupportChat();
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initSupportChat);
}
