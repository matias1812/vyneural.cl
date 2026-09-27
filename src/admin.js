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
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { me } from './api/auth.js';
import {
  listCoupons, createCoupon, updateCoupon,
} from './api/billing.js';
import {
  getSalesSummary, downloadSalesCsv,
  listAdminUsers, getUserPayments, grantUserPremium, revokeUserPremium, refundUserPayment,
  listAdminSupportConversations, getAdminSupportMessages, sendAdminSupportMessage, getAdminSupportStats,
} from './api/admin.js';
import { openSupportSocket } from './api/support-ws-client.js';
import { confirmModal, notifyModal } from './ui/confirm-modal.js';

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

// Mismo patrón que comments.js/cuenta.js: se ven de entrada
// ADMIN_COUPON_VISIBLE_BY_DEFAULT, el resto queda en el DOM oculto por CSS
// hasta tocar "Ver todos" — nunca se vuelve a pedir la lista al backend.
const ADMIN_COUPON_VISIBLE_BY_DEFAULT = 8;
let couponsExpanded = false;

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
    renderAdminCouponShowAllButton([]);
    return;
  }
  list.innerHTML = coupons
    .map((c, i) => {
      const limit = c.max_redemptions != null ? `${c.times_redeemed}/${c.max_redemptions}` : `${c.times_redeemed}`;
      const label = c.label ? ` — ${escapeHtml(c.label)}` : '';
      const hiddenCls = !couponsExpanded && i >= ADMIN_COUPON_VISIBLE_BY_DEFAULT ? ' hidden' : '';
      const inactiveCls = c.active ? '' : ' admin-coupon-row-inactive';
      return `<li class="admin-coupon-row${inactiveCls}${hiddenCls}">
        <div class="admin-coupon-row-main">
          <code class="admin-coupon-code">${escapeHtml(c.code)}</code>
          <small class="admin-coupon-meta">${label} · ${c.trial_days}d · usado ${limit}</small>
        </div>
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
  renderAdminCouponShowAllButton(coupons);
}

function renderAdminCouponShowAllButton(coupons) {
  const btn = $('admin-coupon-show-all');
  if (!btn) return;
  const hiddenCount = coupons.length - ADMIN_COUPON_VISIBLE_BY_DEFAULT;
  if (couponsExpanded || hiddenCount <= 0) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  btn.textContent = `Ver todos (${coupons.length})`;
}

function wireAdminCouponShowAllButton() {
  const btn = $('admin-coupon-show-all');
  if (!btn) return;
  btn.addEventListener('click', () => {
    couponsExpanded = true;
    document.querySelectorAll('#admin-coupon-list .hidden').forEach((li) => li.classList.remove('hidden'));
    btn.classList.add('hidden');
  });
}

function wireAdminCouponForm() {
  wireAdminCouponShowAllButton();
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

// Rasteriza public/icon.svg a un PNG en un <canvas> offscreen para poder
// pasarlo a doc.addImage() (jsPDF no soporta SVG nativo sin un plugin
// aparte). Si algo falla en el camino, devuelve null y el PDF se genera
// igual, solo que sin el logo — nunca debe bloquear el informe completo.
async function rasterizeLogoToPngDataUrl() {
  try {
    const res = await fetch('/icon.svg');
    if (!res.ok) return null;
    const svgText = await res.text();
    const svgUrl = `data:image/svg+xml;base64,${btoa(svgText)}`;
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = svgUrl;
    });
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  } catch (_) {
    return null;
  }
}

// Informe contable en PDF, 100% client-side (sin pasar por el backend).
// Reutiliza el mismo getSalesSummary() que ya alimenta el resumen en
// pantalla — el PDF es simplemente otra vista de los mismos datos.
async function downloadSalesPdf(from, to) {
  const summary = await getSalesSummary(from, to);
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const headTop = 15;

  const logoDataUrl = await rasterizeLogoToPngDataUrl();
  let textX = 14;
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, 'PNG', 14, headTop - 4, 16, 16);
      textX = 34;
    } catch (_) {
      // Si addImage falla igual seguimos con el header solo texto.
      textX = 14;
    }
  }

  doc.setFont(undefined, 'bold');
  doc.setFontSize(16);
  doc.text('Vyneural SpA', textX, headTop + 4);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.text('RUT 78.505.157-2', textX, headTop + 10);

  const periodText = (from || to)
    ? `Período: ${from || '…'} a ${to || '…'}`
    : 'Todo el historial';
  const generatedText = `Generado: ${new Date().toLocaleString('es-CL')}`;
  doc.setFontSize(10);
  doc.text(periodText, pageWidth - 14, headTop + 4, { align: 'right' });
  doc.text(generatedText, pageWidth - 14, headTop + 10, { align: 'right' });

  let cursorY = headTop + 20;
  doc.setDrawColor(200);
  doc.line(14, cursorY, pageWidth - 14, cursorY);
  cursorY += 10;

  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.text(`Total recaudado: ${fmtMoney(summary.total_revenue)}`, 14, cursorY);
  cursorY += 7;
  doc.text(`Cantidad de pagos: ${summary.payment_count ?? 0}`, 14, cursorY);
  doc.setFont(undefined, 'normal');
  cursorY += 10;

  const channelBody = Object.entries(summary.by_channel || {})
    .map(([k, v]) => [ADMIN_CHANNEL_LABELS[k] || k, fmtMoney(v.revenue), String(v.count ?? 0)]);
  doc.autoTable({
    startY: cursorY,
    head: [['Canal', 'Ingresos', 'Pagos']],
    body: channelBody.length ? channelBody : [['Sin datos.', '-', '-']],
    theme: 'grid',
    styles: { fontSize: 10 },
    headStyles: { fillColor: [60, 60, 60] },
  });
  cursorY = doc.lastAutoTable.finalY + 10;

  const planBody = Object.entries(summary.by_plan || {})
    .map(([k, v]) => [ADMIN_PLAN_LABELS[k] || k, fmtMoney(v.revenue), String(v.count ?? 0)]);
  doc.autoTable({
    startY: cursorY,
    head: [['Plan', 'Ingresos', 'Pagos']],
    body: planBody.length ? planBody : [['Sin datos.', '-', '-']],
    theme: 'grid',
    styles: { fontSize: 10 },
    headStyles: { fillColor: [60, 60, 60] },
  });
  cursorY = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'normal');
  doc.text(
    `Reembolsos: ${summary.refunded_count ?? 0} pagos por un total de ${fmtMoney(summary.refunded_amount)}`,
    14,
    cursorY,
  );

  // Pie de página (número de página + leyenda) en todas las páginas ya
  // generadas — se hace en un segundo paso recorriendo doc.setPage() en vez
  // de depender del hook didDrawPage de autotable, que difiere entre
  // versiones del plugin.
  const totalPages = doc.internal.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= totalPages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('Documento generado automáticamente — Vyneural SpA', 14, pageHeight - 10);
    doc.text(`Página ${i} de ${totalPages}`, pageWidth - 14, pageHeight - 10, { align: 'right' });
    doc.setTextColor(0);
  }

  const stampFrom = from || 'inicio';
  const stampTo = to || 'hoy';
  doc.save(`vyneural-informe-contable-${stampFrom}_${stampTo}.pdf`);
}

function wireAdminSalesForm() {
  const form = $('admin-sales-form');
  const csvBtn = $('admin-sales-csv');
  const pdfBtn = $('admin-sales-pdf');
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
  if (pdfBtn) {
    // Mismo patrón defensivo que el botón CSV justo arriba, pero el PDF se
    // arma 100% client-side (ver downloadSalesPdf) — no hay descarga
    // autenticada acá, solo otra llamada a getSalesSummary().
    pdfBtn.addEventListener('click', async () => {
      if (errorEl) errorEl.classList.add('hidden');
      const from = $('admin-sales-from').value || undefined;
      const to = $('admin-sales-to').value || undefined;
      pdfBtn.disabled = true;
      try {
        await downloadSalesPdf(from, to);
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = (err && err.detail) || 'No se pudo generar el PDF.';
          errorEl.classList.remove('hidden');
        }
      } finally {
        pdfBtn.disabled = false;
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
          const paymentActionsHtml = (p) => {
            if (p.channel === 'google_play') {
              return '<small class="admin-payment-google-note">Gestionado por Google Play</small>';
            }
            if (p.status !== 'authorized') return '';
            const badge = p.within_refund_window === true
              ? `<span class="admin-refund-badge admin-refund-badge-ok">Dentro de ventana (${p.days_since_charge}d)</span>`
              : p.within_refund_window === false
                ? `<span class="admin-refund-badge admin-refund-badge-warn">Fuera de ventana (${p.days_since_charge}d)</span>`
                : '';
            return `${badge}<button type="button" class="cuenta-btn cuenta-btn-danger admin-payment-refund" data-payment-id="${escapeHtml(p.id)}" data-within-window="${p.within_refund_window}" data-days-since="${p.days_since_charge}">Reembolsar</button>`;
          };
          ul.innerHTML = payments.length
            ? payments
                .map((p) => `<li class="admin-payment-row" data-payment-id="${escapeHtml(p.id)}">
                  <span>${fmtDateOrDash(p.authorized_at || p.created_at)} · ${escapeHtml(ADMIN_PLAN_LABELS[p.plan] || p.plan)} · ${fmtMoney(p.amount)} ${escapeHtml(p.currency)} · ${escapeHtml(p.status)}</span>
                  ${paymentActionsHtml(p)}
                </li>`)
                .join('')
            : '<li>Sin pagos registrados.</li>';
          ul.querySelectorAll('.admin-payment-refund').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const paymentId = btn.dataset.paymentId;
              const userEmail = row.querySelector('.cuenta-item-body b')?.textContent || '';
              const outsideWindow = btn.dataset.withinWindow === 'false';
              const ok = await confirmModal({
                title: 'Reembolsar pago',
                text: outsideWindow
                  ? `Este pago tiene más de 7 días (${btn.dataset.daysSince}d) — ¿reembolsar de todos modos a ${userEmail}? Esto revierte su Premium si estaba activo por este pago.`
                  : `¿Reembolsar este pago a ${userEmail}? Esto revierte su Premium si estaba activo por este pago.`,
                confirmLabel: 'Reembolsar',
                danger: true,
              });
              if (!ok) return;
              btn.disabled = true;
              try {
                await refundUserPayment(userId, paymentId);
                paymentsDetails.dataset.loaded = '0'; // fuerza recarga de la lista de pagos al re-expandir
                paymentsDetails.open = false;
                paymentsDetails.open = true; // re-dispara el 'toggle' → recarga con el estado actualizado
                await loadAdminUsers(); // refresca también la línea de estado Premium del usuario en la fila
              } catch (err) {
                btn.disabled = false;
                await notifyModal({
                  title: 'No se pudo reembolsar',
                  text: (err && err.detail) || 'reintentá en unos segundos',
                });
              }
            });
          });
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
    const data = await listAdminUsers(adminUsersSearchTerm, adminUsersPage, 10);
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
// Estado de agrupación del hilo de chat (etiqueta de remitente suprimida en
// mensajes consecutivos del mismo lado + separador de fecha) — persiste
// ENTRE llamadas a renderAdminChatMessages (arranque + appends de polling/
// socket) porque tiene que "recordar" el último mensaje pintado aunque haya
// sido en una llamada anterior. Se resetea al abrir una conversación nueva
// (ver openAdminSupportConversation) para no arrastrar el estado de la
// conversación anterior.
let adminChatLastRenderedSender = null;
let adminChatLastRenderedDay = null;

// "Mostrar más" — mismo patrón que comments.js::VISIBLE_BY_DEFAULT/expanded:
// los items de más allá del cupo quedan en el DOM pero ocultos por CSS, y el
// botón solo los desoculta (nunca vuelve a pedir nada al backend).
const ADMIN_SUPPORT_VISIBLE_BY_DEFAULT = 5;
let adminSupportExpanded = false;

// Layout WhatsApp-style: una sola lista de conversaciones a la izquierda,
// switcheable por tab (Pendientes/Resueltos), con el chat de la conversación
// abierta fijo a la derecha. Cada tab cachea sus propios items (llenados por
// loadAdminSupportPending/Resolved) para no tener que re-pedirlos al backend
// solo por cambiar de tab.
let adminSupportActiveTab = 'open'; // 'open' | 'closed'
let adminSupportPendingItems = [];
let adminSupportResolvedItems = [];

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

function setAdminConnStatus(status) {
  const dot = $('admin-support-chat-conn-dot');
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

/** Clave de "día calendario" local (no UTC) para agrupar mensajes por fecha
 * — dos mensajes con la misma clave van bajo el mismo separador. */
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

function renderAdminChatMessages(container, messages, { append = false } = {}) {
  if (!messages.length) {
    if (!append) container.innerHTML = '<p class="cuenta-empty">Sin mensajes todavía.</p>';
    return;
  }
  const html = messages
    .map((m) => {
      const day = chatDayKey(m.created_at);
      const dateSepHtml = day !== adminChatLastRenderedDay
        ? `<div class="admin-chat-date-separator">${escapeHtml(fmtChatDaySeparator(m.created_at))}</div>`
        : '';
      const showSender = dateSepHtml !== '' || m.sender !== adminChatLastRenderedSender;
      adminChatLastRenderedDay = day;
      adminChatLastRenderedSender = m.sender;
      return `${dateSepHtml}<div class="admin-chat-msg${m.sender === 'admin' ? ' admin-chat-msg-admin' : ''}">
        ${escapeHtml(m.content)}
        ${showSender ? `<small>${m.sender === 'admin' ? 'Admin' : 'Usuario'} · ${fmtDate(m.created_at)}</small>` : `<small>${fmtDate(m.created_at)}</small>`}
      </div>`;
    })
    .join('');
  if (append) container.insertAdjacentHTML('beforeend', html);
  else container.innerHTML = html;
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

/** Muestra en el panel derecho (fijo) una conversación YA cerrada: sin chat
 * ni formulario de respuesta (el backend purga el texto de los mensajes al
 * cerrar, data-minimization), solo email + rating (★) + fecha de cierre. */
function showResolvedConversation(conversationId) {
  closeAdminSupportConversation();
  adminSupportOpenId = conversationId;
  const item = adminSupportResolvedItems.find((c) => c.id === conversationId);
  $('admin-support-chat-empty').classList.add('hidden');
  $('admin-support-chat-active').classList.remove('hidden');
  $('admin-support-chat-header-email').textContent = (item && item.user_email) || '';
  $('admin-support-chat-messages').classList.add('hidden');
  $('admin-support-reply-form').classList.add('hidden');
  const info = $('admin-support-chat-resolved-info');
  info.classList.remove('hidden');
  const rating = (item && item.rating) || 0;
  info.innerHTML = `<p class="cuenta-empty">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} · cerrado ${fmtDateOrDash(item && item.closed_at)}</p>`;
  renderAdminSupportList(); // refresca el resaltado is-active
}

async function openAdminSupportConversation(conversationId) {
  closeAdminSupportConversation();
  adminSupportOpenId = conversationId;
  const item = adminSupportPendingItems.find((c) => c.id === conversationId);
  $('admin-support-chat-empty').classList.add('hidden');
  $('admin-support-chat-active').classList.remove('hidden');
  $('admin-support-chat-header-email').textContent = (item && item.user_email) || '';
  $('admin-support-chat-resolved-info').classList.add('hidden');
  $('admin-support-chat-messages').classList.remove('hidden');
  $('admin-support-reply-form').classList.remove('hidden');
  renderAdminSupportList(); // refresca el resaltado is-active

  adminSupportLastSeenAt = null;
  adminSeenMessageIds = new Set();
  const chatEl = $('admin-support-chat-messages');
  chatEl.innerHTML = '<p class="cuenta-empty">Cargando…</p>';
  adminChatLastRenderedSender = null;
  adminChatLastRenderedDay = null;
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
      onStatusChange: (status) => setAdminConnStatus(status),
    });
  }
}

function closeAdminSupportConversation() {
  stopAdminSupportPolling();
  stopAdminSupportSocket();
  adminSupportOpenId = null;
}

function renderAdminSupportRow(c) {
  const preview = c.last_message_preview ? escapeHtml(c.last_message_preview) : '';
  const email = c.user_email || '';
  const initial = (email[0] || '?').toUpperCase();
  const awaitingReply = c.last_message_sender === 'user';
  const activeCls = c.id === adminSupportOpenId ? ' is-active' : '';
  return `<li class="cuenta-item admin-support-row${activeCls}" data-conversation-id="${escapeHtml(c.id)}">
    <button type="button" class="cuenta-item-body admin-support-summary">
      <span class="admin-support-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
      <span class="admin-support-summary-text">
        <span class="admin-support-summary-line1">
          <b>${escapeHtml(email)}</b>
          ${awaitingReply ? '<span class="admin-support-reply-dot" title="Esperando tu respuesta" aria-label="Esperando tu respuesta"></span>' : ''}
        </span>
        <small class="admin-support-preview">${preview ? `"${preview}"` : `${c.message_count ?? 0} mensajes`}</small>
      </span>
      <span class="admin-support-summary-time">${fmtDateOrDash(c.last_message_at)}</span>
    </button>
  </li>`;
}

/** Fila de una conversación YA cerrada — el backend purga el texto de los
 * mensajes al cerrar (data-minimization), así que al abrirla solo se muestra
 * email + rating (★) + fecha de cierre (ver showResolvedConversation). */
function renderAdminSupportResolvedRow(c) {
  const rating = c.rating || 0;
  const activeCls = c.id === adminSupportOpenId ? ' is-active' : '';
  return `<li class="cuenta-item admin-support-resolved-row${activeCls}" data-conversation-id="${escapeHtml(c.id)}">
    <button type="button" class="cuenta-item-body admin-support-summary">
      <span class="admin-support-summary-text">
        <b>${escapeHtml(c.user_email || '')}</b>
        <small>${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} · cerrado ${fmtDateOrDash(c.closed_at)}</small>
      </span>
    </button>
  </li>`;
}

function wireAdminSupportRows(list) {
  list.querySelectorAll('.admin-support-row').forEach((li) => {
    const conversationId = li.dataset.conversationId;
    const summaryBtn = li.querySelector('.admin-support-summary');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', () => {
        if (adminSupportOpenId !== conversationId) openAdminSupportConversation(conversationId);
      });
    }
  });
  list.querySelectorAll('.admin-support-resolved-row').forEach((li) => {
    const conversationId = li.dataset.conversationId;
    const summaryBtn = li.querySelector('.admin-support-summary');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', () => {
        if (adminSupportOpenId !== conversationId) showResolvedConversation(conversationId);
      });
    }
  });
}

/** Renderiza la lista compartida de la izquierda con lo que corresponda al
 * tab activo (Pendientes/Resueltos) — llamada tras cada fetch y cada cambio
 * de tab, nunca vuelve a pedir nada al backend por sí sola. */
function renderAdminSupportList() {
  const list = $('admin-support-list');
  const empty = $('admin-support-list-empty');
  const showAllBtn = $('admin-support-show-all');
  if (!list) return;
  const items = adminSupportActiveTab === 'open' ? adminSupportPendingItems : adminSupportResolvedItems;
  if (!items.length) {
    list.innerHTML = '';
    if (empty) {
      empty.textContent = adminSupportActiveTab === 'open' ? 'No hay conversaciones abiertas.' : 'Todavía no hay conversaciones resueltas.';
      empty.classList.remove('hidden');
    }
    if (showAllBtn) showAllBtn.classList.add('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.innerHTML = items.map(adminSupportActiveTab === 'open' ? renderAdminSupportRow : renderAdminSupportResolvedRow).join('');
  wireAdminSupportRows(list);
  applyAdminSupportShowMore(list, items, adminSupportExpanded, showAllBtn);
}

/** Tabs Pendientes/Resueltos — cambia qué cache se pinta en la lista
 * compartida, sin volver a pedir nada al backend (loadAdminSupportPending/
 * Resolved ya cachean sus items al cargar). */
function wireAdminSupportTabs() {
  document.querySelectorAll('.admin-support-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === adminSupportActiveTab) return;
      adminSupportActiveTab = tab;
      adminSupportExpanded = false;
      document.querySelectorAll('.admin-support-tab').forEach((b) => {
        const active = b.dataset.tab === tab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      renderAdminSupportList();
    });
  });
}

/** Formulario de respuesta fijo abajo del chat, wireado UNA sola vez (ya no
 * hay un formulario por fila) — manda al conversationId actualmente abierto. */
function wireAdminSupportReplyForm() {
  const form = $('admin-support-reply-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!adminSupportOpenId) return;
    const input = $('admin-support-reply-input');
    const errorEl = $('admin-support-reply-error');
    const content = input.value.trim();
    if (!content) return;
    if (errorEl) errorEl.classList.add('hidden');
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const sent = await sendAdminSupportMessage(adminSupportOpenId, content);
      input.value = '';
      const chatEl = $('admin-support-chat-messages');
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

/** Aplica el cupo "Mostrar más" (oculta por CSS más allá de
 * ADMIN_SUPPORT_VISIBLE_BY_DEFAULT, sin sacarlos del DOM) y deja el botón
 * correspondiente listo — mismo mecanismo que comments.js::renderShowAllButton,
 * pero parametrizado porque acá hay dos listas independientes. */
function applyAdminSupportShowMore(list, items, expanded, showAllBtn) {
  if (list) {
    list.querySelectorAll('li').forEach((li, i) => {
      if (!expanded && i >= ADMIN_SUPPORT_VISIBLE_BY_DEFAULT) li.classList.add('hidden');
    });
  }
  if (!showAllBtn) return;
  const hiddenCount = items.length - ADMIN_SUPPORT_VISIBLE_BY_DEFAULT;
  if (expanded || hiddenCount <= 0) {
    showAllBtn.classList.add('hidden');
    return;
  }
  showAllBtn.classList.remove('hidden');
  showAllBtn.textContent = `Mostrar más (${hiddenCount})`;
}

function wireAdminSupportShowMoreButtons() {
  const btn = $('admin-support-show-all');
  if (!btn) return;
  btn.addEventListener('click', () => {
    adminSupportExpanded = true;
    const list = $('admin-support-list');
    if (list) list.querySelectorAll('li.hidden').forEach((li) => li.classList.remove('hidden'));
    btn.classList.add('hidden');
  });
}

/** Orden "más antiguo primero" por actividad — usa last_message_at si está
 * (conversaciones abiertas casi siempre lo tienen), si no created_at. No hay
 * campo en la respuesta que diga quién mandó el último mensaje, así que esto
 * es una aproximación deliberada de "necesita atención antes" (a más tiempo
 * quieto, más urgente) en vez de distinguir "esperando al admin" con certeza. */
function sortAdminSupportPendingByActivity(items) {
  return [...items].sort((a, b) => {
    const ta = new Date(a.last_message_at || a.created_at || 0).getTime();
    const tb = new Date(b.last_message_at || b.created_at || 0).getTime();
    return ta - tb;
  });
}

async function loadAdminSupportPending() {
  try {
    const conversations = await listAdminSupportConversations('open');
    const raw = conversations && conversations.items ? conversations.items : conversations || [];
    adminSupportPendingItems = sortAdminSupportPendingByActivity(raw);
    const countEl = $('admin-support-tab-open-count');
    if (countEl) countEl.textContent = adminSupportPendingItems.length ? `(${adminSupportPendingItems.length})` : '';
    if (adminSupportActiveTab === 'open') renderAdminSupportList();
  } catch (_) {
    adminSupportPendingItems = [];
    if (adminSupportActiveTab === 'open') {
      const list = $('admin-support-list');
      if (list) list.innerHTML = '<li>No se pudo cargar la lista de conversaciones.</li>';
    }
  }
}

async function loadAdminSupportResolved() {
  try {
    const conversations = await listAdminSupportConversations('closed');
    adminSupportResolvedItems = conversations && conversations.items ? conversations.items : conversations || [];
    const countEl = $('admin-support-tab-closed-count');
    if (countEl) countEl.textContent = adminSupportResolvedItems.length ? `(${adminSupportResolvedItems.length})` : '';
    if (adminSupportActiveTab === 'closed') renderAdminSupportList();
  } catch (_) {
    adminSupportResolvedItems = [];
    if (adminSupportActiveTab === 'closed') {
      const list = $('admin-support-list');
      if (list) list.innerHTML = '<li>No se pudo cargar la lista de conversaciones resueltas.</li>';
    }
  }
}

function renderAdminSupportStats(stats) {
  const el = $('admin-support-summary-line');
  if (!el) return;
  if (!stats) {
    el.textContent = '';
    return;
  }
  const avg = stats.average_rating == null ? '—' : stats.average_rating.toFixed(1);
  el.textContent = `${stats.pending_count ?? 0} pendientes · ${stats.resolved_count ?? 0} resueltas · ★${avg} promedio`;
}

async function loadAdminSupportStats() {
  try {
    const stats = await getAdminSupportStats();
    renderAdminSupportStats(stats);
  } catch (_) {
    renderAdminSupportStats(null);
  }
}

// Las 3 llamadas son independientes — una falla no debe tapar a las otras
// (mismo criterio defensivo que loadAdminUsers/loadAdminSalesSummary: cada
// loadAdminSupport* ya atrapa su propio error).
async function loadAdminSupport() {
  await Promise.all([
    loadAdminSupportPending(),
    loadAdminSupportResolved(),
    loadAdminSupportStats(),
  ]);
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
  wireAdminSupportShowMoreButtons();
  wireAdminSupportTabs();
  wireAdminSupportReplyForm();
  loadAdminSupport();
}

init();
