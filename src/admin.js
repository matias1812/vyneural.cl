// src/admin.js
// Página /admin — panel de administración (Cupones, Ventas, Usuarios,
// Soporte), movido acá desde #cuenta-admin-card en cuenta.js/cuenta.html
// (ese panel vivía dentro de /cuenta, mezclado con la vista de usuario
// normal). Standalone: SOLO se monta si la sesión logueada es la cuenta de
// admin — esto es únicamente UX para no mostrar un flash de contenido a
// quien no corresponde; la seguridad real es require_admin_user en cada
// endpoint del backend (backend/app/deps.py), sin importar lo que haga o
// deje de hacer este archivo.

import './site.css';
import { me } from './api/auth.js';
import {
  listCoupons, createCoupon, updateCoupon,
} from './api/billing.js';
import {
  getSalesSummary, downloadSalesCsv,
  listAdminUsers, getUserPayments, grantUserPremium, revokeUserPremium,
  listAdminSupportConversations, getAdminSupportMessages, sendAdminSupportMessage,
} from './api/admin.js';
import { openSupportSocket } from './api/support-ws-client.js';

const $ = (id) => document.getElementById(id);

// Mismo email que backend/app/config.py::admin_email por default — esto es
// solo el gate visual, el backend vuelve a chequear settings.admin_email en
// cada request sin importar este literal.
const ADMIN_EMAIL = 'matias.torres1812@gmail.com';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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

async function loadAdminCoupons() {
  const list = $('admin-coupon-list');
  if (!list) return;
  try {
    const coupons = await listCoupons();
    renderAdminCouponList(coupons);
  } catch (_) {
    list.innerHTML = '<li>No se pudo cargar la lista de cupones.</li>';
  }
}

function renderAdminCouponList(coupons) {
  const list = $('admin-coupon-list');
  if (!list) return;
  if (!coupons || !coupons.length) {
    list.innerHTML = '<li>Todavía no hay cupones creados.</li>';
    return;
  }
  list.innerHTML = coupons
    .map((c) => {
      const limit = c.max_redemptions != null ? `${c.times_redeemed}/${c.max_redemptions}` : `${c.times_redeemed}`;
      const label = c.label ? ` — ${escapeHtml(c.label)}` : '';
      return `<li>
        <code>${escapeHtml(c.code)}</code>${label} · ${c.trial_days}d · usado ${limit}
        <button type="button" class="cuenta-btn admin-coupon-toggle" data-code="${escapeHtml(c.code)}" data-active="${c.active}">
          ${c.active ? 'Desactivar' : 'Activar'}
        </button>
      </li>`;
    })
    .join('');
  list.querySelectorAll('.admin-coupon-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.code;
      const active = btn.dataset.active === 'true';
      btn.disabled = true;
      try {
        await updateCoupon(code, { active: !active });
        await loadAdminCoupons();
      } catch (_) {
        btn.disabled = false;
      }
    });
  });
}

function wireAdminCouponForm() {
  const form = $('admin-coupon-form');
  const errorEl = $('admin-coupon-error');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.classList.add('hidden');
    const code = $('admin-coupon-code').value.trim();
    const label = $('admin-coupon-label').value.trim() || null;
    const days = parseInt($('admin-coupon-days').value, 10) || 30;
    const maxRaw = $('admin-coupon-max').value.trim();
    const max = maxRaw ? parseInt(maxRaw, 10) : null;
    if (!code) return;
    const btn = $('admin-coupon-create');
    btn.disabled = true;
    try {
      await createCoupon({ code, label, trial_days: days, max_redemptions: max });
      form.reset();
      $('admin-coupon-days').value = '30';
      await loadAdminCoupons();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = (err && err.detail) || 'No se pudo crear el cupón.';
        errorEl.classList.remove('hidden');
      }
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Admin: Ventas ────────────────────────────────────────────────────────
// Mismo criterio de admin que Cupones arriba: solo UX, el backend vuelve a
// chequear require_admin_user en cada request (admin_sales.py).

const ADMIN_CHANNEL_LABELS = { webpay_plus: 'Webpay Plus', oneclick: 'Oneclick', google_play: 'Google Play' };
const ADMIN_PLAN_LABELS = { monthly: 'Mensual', annual: 'Anual', lifetime: 'De por vida' };

function fmtMoney(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;
}

function fmtDateOrDash(iso) {
  return iso ? fmtDate(iso) : '—';
}

function renderAdminSalesSummary(summary) {
  const el = $('admin-sales-summary');
  if (!el) return;
  if (!summary) {
    el.innerHTML = '<p class="cuenta-empty">No se pudo cargar el resumen de ventas.</p>';
    return;
  }
  const channelRows = Object.entries(summary.by_channel || {})
    .map(([k, v]) => `<li>${escapeHtml(ADMIN_CHANNEL_LABELS[k] || k)} — ${fmtMoney(v.revenue)} (${v.count})</li>`)
    .join('');
  const planRows = Object.entries(summary.by_plan || {})
    .map(([k, v]) => `<li>${escapeHtml(ADMIN_PLAN_LABELS[k] || k)} — ${fmtMoney(v.revenue)} (${v.count})</li>`)
    .join('');
  el.innerHTML = `
    <div class="admin-stat-row">
      <div class="admin-stat"><strong>${fmtMoney(summary.total_revenue)}</strong><span>Total recaudado</span></div>
      <div class="admin-stat"><strong>${summary.payment_count ?? 0}</strong><span>Pagos autorizados</span></div>
    </div>
    <div class="admin-stat-breakdown">
      <h4>Por canal</h4>
      <ul class="cuenta-list">${channelRows || '<li>Sin datos.</li>'}</ul>
    </div>
    <div class="admin-stat-breakdown">
      <h4>Por plan</h4>
      <ul class="cuenta-list">${planRows || '<li>Sin datos.</li>'}</ul>
    </div>`;
}

async function loadAdminSalesSummary() {
  const el = $('admin-sales-summary');
  const from = $('admin-sales-from').value || undefined;
  const to = $('admin-sales-to').value || undefined;
  if (el) el.innerHTML = '<p class="cuenta-empty">Cargando…</p>';
  try {
    const summary = await getSalesSummary(from, to);
    renderAdminSalesSummary(summary);
  } catch (_) {
    renderAdminSalesSummary(null);
  }
}

function wireAdminSalesForm() {
  const form = $('admin-sales-form');
  const csvBtn = $('admin-sales-csv');
  const errorEl = $('admin-sales-error');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadAdminSalesSummary();
  });
  if (csvBtn) {
    // Descarga autenticada (ver api/admin.js::downloadSalesCsv) — el backend
    // exige Authorization: Bearer, así que esto NO puede ser un <a href>
    // plano (el navegador no le manda ese header a una descarga directa).
    // Mismo patrón blob que main.js::downloadBackup.
    csvBtn.addEventListener('click', async () => {
      if (errorEl) errorEl.classList.add('hidden');
      const from = $('admin-sales-from').value || undefined;
      const to = $('admin-sales-to').value || undefined;
      csvBtn.disabled = true;
      try {
        const csvText = await downloadSalesCsv(from, to);
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `vyneural-ventas-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = (err && err.detail) || 'No se pudo descargar el CSV.';
          errorEl.classList.remove('hidden');
        }
      } finally {
        csvBtn.disabled = false;
      }
    });
  }
  loadAdminSalesSummary();
}

// ── Admin: Usuarios ──────────────────────────────────────────────────────

let adminUsersPage = 1;
let adminUsersSearchTerm = '';

function renderAdminUserRow(u) {
  const premiumLine = u.premium_lifetime
    ? 'Premium de por vida'
    : u.is_premium
      ? `Premium ${escapeHtml(ADMIN_PLAN_LABELS[u.current_plan] || u.current_plan || '')} vía ${escapeHtml(u.active_channel || '?')} · vence ${fmtDateOrDash(u.premium_until)}`
      : 'Sin premium';
  return `<li class="cuenta-item admin-user-row" data-user-id="${escapeHtml(u.id)}">
    <div class="cuenta-item-body">
      <b>${escapeHtml(u.email)}</b>
      <small>${escapeHtml(u.display_name || u.username || '')}</small>
      <small>${premiumLine}</small>
      <small>Alta ${fmtDateOrDash(u.created_at)} · último login ${fmtDateOrDash(u.last_login_at)}${u.last_seen_platform ? ` · ${escapeHtml(u.last_seen_platform)}` : ''}</small>
    </div>
    <details class="cuenta-create">
      <summary>Ver pagos</summary>
      <ul class="cuenta-list admin-user-payments-list"><li>Cargando…</li></ul>
    </details>
    <details class="cuenta-create">
      <summary>Otorgar / revocar Premium</summary>
      <div class="cuenta-form">
        <div class="cuenta-form-row">
          <label>Plan
            <select class="admin-user-plan">
              <option value="monthly">Mensual</option>
              <option value="annual">Anual</option>
              <option value="lifetime">De por vida</option>
            </select>
          </label>
          <label>Días (opcional)<em> — vacío usa el default del plan</em>
            <input type="number" min="1" class="admin-user-days" />
          </label>
        </div>
        <div class="admin-inline-row">
          <button type="button" class="cuenta-btn admin-user-grant">Otorgar</button>
          <button type="button" class="cuenta-btn cuenta-btn-danger admin-user-revoke">Revocar</button>
        </div>
        <div class="auth-error hidden admin-user-premium-error" role="alert"></div>
      </div>
    </details>
  </li>`;
}

function wireAdminUserRows(list) {
  list.querySelectorAll('.admin-user-row').forEach((row) => {
    const userId = row.dataset.userId;
    const paymentsDetails = row.querySelector('details');
    if (paymentsDetails) {
      paymentsDetails.addEventListener('toggle', async () => {
        if (!paymentsDetails.open || paymentsDetails.dataset.loaded === '1') return;
        paymentsDetails.dataset.loaded = '1';
        const ul = paymentsDetails.querySelector('.admin-user-payments-list');
        try {
          const payments = await getUserPayments(userId);
          ul.innerHTML = payments.length
            ? payments
                .map((p) => `<li>${fmtDateOrDash(p.authorized_at || p.created_at)} · ${escapeHtml(ADMIN_PLAN_LABELS[p.plan] || p.plan)} · ${fmtMoney(p.amount)} ${escapeHtml(p.currency)} · ${escapeHtml(p.status)}</li>`)
                .join('')
            : '<li>Sin pagos registrados.</li>';
        } catch (_) {
          ul.innerHTML = '<li>No se pudo cargar el historial de pagos.</li>';
          paymentsDetails.dataset.loaded = '0';
        }
      });
    }
    const grantBtn = row.querySelector('.admin-user-grant');
    const revokeBtn = row.querySelector('.admin-user-revoke');
    const planSel = row.querySelector('.admin-user-plan');
    const daysInput = row.querySelector('.admin-user-days');
    const errorEl = row.querySelector('.admin-user-premium-error');
    if (grantBtn) {
      grantBtn.addEventListener('click', async () => {
        if (errorEl) errorEl.classList.add('hidden');
        const plan = planSel.value;
        const daysRaw = daysInput.value.trim();
        const body = plan === 'lifetime'
          ? { plan, lifetime: true }
          : { plan, days: daysRaw ? parseInt(daysRaw, 10) : undefined };
        grantBtn.disabled = true;
        try {
          await grantUserPremium(userId, body);
          await loadAdminUsers();
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = (err && err.detail) || 'No se pudo otorgar Premium.';
            errorEl.classList.remove('hidden');
          }
        } finally {
          grantBtn.disabled = false;
        }
      });
    }
    if (revokeBtn) {
      revokeBtn.addEventListener('click', async () => {
        if (errorEl) errorEl.classList.add('hidden');
        const plan = planSel.value;
        revokeBtn.disabled = true;
        try {
          await revokeUserPremium(userId, { plan });
          await loadAdminUsers();
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = (err && err.detail) || 'No se pudo revocar Premium.';
            errorEl.classList.remove('hidden');
          }
        } finally {
          revokeBtn.disabled = false;
        }
      });
    }
  });
}

function renderAdminUsersList(data) {
  const list = $('admin-users-list');
  const empty = $('admin-users-empty');
  const prevBtn = $('admin-users-prev');
  const nextBtn = $('admin-users-next');
  const label = $('admin-users-page-label');
  if (!list) return;
  const items = (data && data.items) || [];
  if (!items.length) {
    list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
  } else {
    if (empty) empty.classList.add('hidden');
    list.innerHTML = items.map(renderAdminUserRow).join('');
    wireAdminUserRows(list);
  }
  if (label) label.textContent = `Página ${adminUsersPage}`;
  if (prevBtn) prevBtn.disabled = adminUsersPage <= 1;
  if (nextBtn) nextBtn.disabled = !(data && data.has_more);
}

async function loadAdminUsers() {
  const list = $('admin-users-list');
  if (!list) return;
  try {
    const data = await listAdminUsers(adminUsersSearchTerm, adminUsersPage, 20);
    renderAdminUsersList(data);
  } catch (_) {
    list.innerHTML = '<li>No se pudo cargar la lista de usuarios.</li>';
  }
}

function wireAdminUsersForm() {
  const form = $('admin-users-search-form');
  const prevBtn = $('admin-users-prev');
  const nextBtn = $('admin-users-next');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      adminUsersSearchTerm = $('admin-users-search').value.trim();
      adminUsersPage = 1;
      loadAdminUsers();
    });
  }
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (adminUsersPage <= 1) return;
      adminUsersPage -= 1;
      loadAdminUsers();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      adminUsersPage += 1;
      loadAdminUsers();
    });
  }
}

// ── Admin: Soporte ───────────────────────────────────────────────────────
// Polling manual mientras UNA conversación está expandida — se frena al
// colapsarla o abrir otra (ver stopAdminSupportPolling), nunca corren dos
// intervals en simultáneo. (T6 le agrega WebSocket como transporte primario
// sin sacar este polling, que queda como red de seguridad.)

let adminSupportOpenId = null;
let adminSupportPollTimer = null;
let adminSupportLastSeenAt = null;
// Dedup por id: WebSocket y polling pueden entregar el MISMO mensaje (el
// socket es instantáneo, un poll ya en vuelo con un `since` viejo puede
// devolver de nuevo lo que el socket ya entregó momentos antes) — sin esto
// se pintaría dos veces en el chat del admin.
let adminSeenMessageIds = new Set();
let adminSocketHandle = null;

function stopAdminSupportPolling() {
  if (adminSupportPollTimer) {
    clearInterval(adminSupportPollTimer);
    adminSupportPollTimer = null;
  }
}

function stopAdminSupportSocket() {
  if (adminSocketHandle) {
    adminSocketHandle.close();
    adminSocketHandle = null;
  }
}

function setAdminConnStatus(li, status) {
  const dot = li && li.querySelector('.admin-conn-dot');
  if (!dot) return;
  dot.classList.remove('is-open', 'is-connecting', 'is-down');
  if (status === 'open') {
    dot.classList.add('is-open');
    dot.title = 'En vivo';
  } else if (status === 'connecting') {
    dot.classList.add('is-connecting');
    dot.title = 'Conectando…';
  } else {
    dot.classList.add('is-down');
    dot.title = 'Sincronizando (sin conexión en vivo)';
  }
}

/** Filtra mensajes ya vistos (por id) — WebSocket y polling comparten este
 * filtro antes de pintar, así ninguno de los dos duplica lo que el otro ya
 * entregó. */
function admitNewAdminMessages(list) {
  const fresh = [];
  (list || []).forEach((m) => {
    if (m.id) {
      if (adminSeenMessageIds.has(m.id)) return;
      adminSeenMessageIds.add(m.id);
    }
    fresh.push(m);
  });
  return fresh;
}

function renderAdminChatMessages(container, messages, { append = false } = {}) {
  const html = messages
    .map(
      (m) => `<div class="admin-chat-msg${m.sender === 'admin' ? ' admin-chat-msg-admin' : ''}">
        ${escapeHtml(m.content)}
        <small>${m.sender === 'admin' ? 'Admin' : 'Usuario'} · ${fmtDate(m.created_at)}</small>
      </div>`,
    )
    .join('');
  if (append) container.insertAdjacentHTML('beforeend', html);
  else container.innerHTML = html || '<p class="cuenta-empty">Sin mensajes todavía.</p>';
  container.scrollTop = container.scrollHeight;
}

async function pollAdminSupportMessages(conversationId, container) {
  // Si mientras tanto se cerró/cambió de conversación, este tick es de una
  // conversación que ya no está abierta — no pisar el chat de otra.
  if (adminSupportOpenId !== conversationId) return;
  try {
    const data = await getAdminSupportMessages(conversationId, adminSupportLastSeenAt || undefined);
    const fresh = admitNewAdminMessages((data && data.messages) || []);
    if (fresh.length && adminSupportOpenId === conversationId) {
      renderAdminChatMessages(container, fresh, { append: true });
      adminSupportLastSeenAt = fresh[fresh.length - 1].created_at;
    }
  } catch (_) {
    /* silencioso: reintenta en el próximo tick, no interrumpe la conversación abierta */
  }
}

async function openAdminSupportConversation(conversationId, li) {
  if (adminSupportOpenId && adminSupportOpenId !== conversationId) {
    const prevLi = document.querySelector(`.admin-support-row[data-conversation-id="${adminSupportOpenId}"]`);
    if (prevLi) prevLi.querySelector('.admin-panel').classList.add('hidden');
  }
  stopAdminSupportPolling();
  stopAdminSupportSocket();
  adminSupportOpenId = conversationId;
  adminSupportLastSeenAt = null;
  adminSeenMessageIds = new Set();

  const panel = li.querySelector('.admin-panel');
  panel.classList.remove('hidden');
  const chatEl = panel.querySelector('.admin-chat');
  chatEl.innerHTML = '<p class="cuenta-empty">Cargando…</p>';
  try {
    const data = await getAdminSupportMessages(conversationId);
    const messages = admitNewAdminMessages((data && data.messages) || []);
    renderAdminChatMessages(chatEl, messages);
    if (messages.length) adminSupportLastSeenAt = messages[messages.length - 1].created_at;
  } catch (_) {
    chatEl.innerHTML = '<p class="cuenta-empty">No se pudieron cargar los mensajes.</p>';
  }
  // Solo arranca el polling/socket si seguimos siendo la conversación
  // abierta (un error/latencia en el fetch de arriba no debería revivir
  // nada de una conversación que el admin ya cerró mientras esperaba).
  if (adminSupportOpenId === conversationId) {
    adminSupportPollTimer = setInterval(() => pollAdminSupportMessages(conversationId, chatEl), 4000);
    adminSocketHandle = openSupportSocket(conversationId, {
      onMessage: (m) => {
        const fresh = admitNewAdminMessages([m]);
        if (fresh.length) {
          renderAdminChatMessages(chatEl, fresh, { append: true });
          adminSupportLastSeenAt = fresh[0].created_at;
        }
      },
      onStatusChange: (status) => setAdminConnStatus(li, status),
    });
  }
}

function closeAdminSupportConversation(li) {
  const panel = li.querySelector('.admin-panel');
  if (panel) panel.classList.add('hidden');
  stopAdminSupportPolling();
  stopAdminSupportSocket();
  adminSupportOpenId = null;
}

function renderAdminSupportRow(c) {
  const preview = c.last_message_preview ? escapeHtml(c.last_message_preview) : '';
  return `<li class="cuenta-item admin-support-row" data-conversation-id="${escapeHtml(c.id)}">
    <button type="button" class="cuenta-item-body admin-support-summary">
      <b>${escapeHtml(c.user_email || '')}</b>
      <small>${c.message_count ?? 0} mensajes · último ${fmtDateOrDash(c.last_message_at)}</small>
      ${preview ? `<small>"${preview}"</small>` : ''}
    </button>
    <div class="admin-panel hidden">
      <div class="admin-panel-head">
        <span>Conversación</span>
        <span class="admin-conn-dot is-down" title="Sincronizando (sin conexión en vivo)" aria-hidden="true"></span>
      </div>
      <div class="admin-chat"></div>
      <form class="cuenta-form admin-support-reply-form">
        <div class="admin-inline-row">
          <input type="text" class="admin-support-reply-input" placeholder="Responder…" maxlength="2000" required />
          <button type="submit" class="cuenta-btn">Enviar</button>
        </div>
        <div class="auth-error hidden admin-support-reply-error" role="alert"></div>
      </form>
    </div>
  </li>`;
}

function wireAdminSupportRows(list) {
  list.querySelectorAll('.admin-support-row').forEach((li) => {
    const conversationId = li.dataset.conversationId;
    const summaryBtn = li.querySelector('.admin-support-summary');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', () => {
        if (adminSupportOpenId === conversationId) closeAdminSupportConversation(li);
        else openAdminSupportConversation(conversationId, li);
      });
    }
    const replyForm = li.querySelector('.admin-support-reply-form');
    if (replyForm) {
      replyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = replyForm.querySelector('.admin-support-reply-input');
        const errorEl = replyForm.querySelector('.admin-support-reply-error');
        const content = input.value.trim();
        if (!content) return;
        if (errorEl) errorEl.classList.add('hidden');
        const submitBtn = replyForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          const sent = await sendAdminSupportMessage(conversationId, content);
          input.value = '';
          const chatEl = li.querySelector('.admin-chat');
          if (chatEl && sent) {
            renderAdminChatMessages(chatEl, [sent], { append: true });
            adminSupportLastSeenAt = sent.created_at;
          }
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = (err && err.detail) || 'No se pudo enviar la respuesta.';
            errorEl.classList.remove('hidden');
          }
        } finally {
          submitBtn.disabled = false;
        }
      });
    }
  });
}

async function loadAdminSupportConversations() {
  const list = $('admin-support-list');
  const empty = $('admin-support-empty');
  if (!list) return;
  try {
    const conversations = await listAdminSupportConversations();
    const items = conversations && conversations.items ? conversations.items : conversations || [];
    if (!items.length) {
      list.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    list.innerHTML = items.map(renderAdminSupportRow).join('');
    wireAdminSupportRows(list);
  } catch (_) {
    list.innerHTML = '<li>No se pudo cargar la lista de conversaciones.</li>';
  }
}

// ── Arranque de la página ────────────────────────────────────────────────
// A diferencia de renderAdminCard() en /cuenta (que solo ocultaba una card
// dentro de una página de usuario normal), acá TODA la página es el panel
// de admin: sin sesión o sin ser la cuenta de admin, se muestra el estado
// "No autorizado" y nunca se montan las 4 secciones — me() lanza (ApiError)
// si no hay sesión válida, así que el chequeo va en el catch, no en un
// valor nulo.
async function init() {
  const unauthorized = $('admin-unauthorized');
  const content = $('admin-content');
  let profile = null;
  try {
    profile = await me();
  } catch (_) {
    profile = null;
  }
  const isAdmin = !!(profile && profile.email === ADMIN_EMAIL);
  if (!isAdmin) {
    if (unauthorized) unauthorized.classList.remove('hidden');
    if (content) content.classList.add('hidden');
    return;
  }
  if (unauthorized) unauthorized.classList.add('hidden');
  if (content) content.classList.remove('hidden');

  loadAdminCoupons();
  wireAdminCouponForm();
  wireAdminSalesForm();
  loadAdminUsers();
  wireAdminUsersForm();
  loadAdminSupportConversations();
}

init();
