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
  listCoupons, createCoupon, updateCoupon, deleteCoupon, getAdminCouponSales,
} from './api/billing.js';
import {
  getSalesSummary, downloadSalesCsv,
  getMonthlyAccounting, downloadMonthlyAccountingCsv,
  listAdminUsers, getUserPayments, grantUserPremium, revokeUserPremium, refundUserPayment,
  listAdminSupportConversations, getAdminSupportMessages, sendAdminSupportMessage, getAdminSupportStats,
  resolveSupportConversation,
} from './api/admin.js';
import { openSupportSocket } from './api/support-ws-client.js';
import { confirmModal, notifyModal } from './ui/confirm-modal.js';
import {
  CONTRACT_TEMPLATES, fillClauses, defaultClausesFor,
} from './ui/contract-templates.js';

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

/** Comprueba si un valor está vacío después de eliminar caracteres Unicode
 * invisibles (Format Cf y Control Cc) — más robusto que solo `.trim()` que
 * no elimina U+200B, U+200C, U+200D, U+FEFF, U+2060, etc. */
function isBlank(value) {
  return value.replace(/[\p{Cf}\p{Cc}]/gu, '').length === 0;
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
      return `<li class="admin-coupon-row${inactiveCls}${hiddenCls}" data-code="${escapeHtml(c.code)}">
        <div class="admin-coupon-row-top">
          <div class="admin-coupon-row-main">
            <code class="admin-coupon-code">${escapeHtml(c.code)}</code>
            <small class="admin-coupon-meta">${label} · ${c.trial_days}d · usado ${limit} · ${c.commission_rate}% comisión</small>
          </div>
          <div class="admin-coupon-row-actions">
            <button type="button" class="cuenta-btn cuenta-btn-ghost admin-coupon-edit-toggle">✏️ Editar</button>
            <button type="button" class="cuenta-btn admin-coupon-toggle" data-code="${escapeHtml(c.code)}" data-active="${c.active}">
              ${c.active ? 'Desactivar' : 'Activar'}
            </button>
            <button type="button" class="cuenta-btn cuenta-btn-danger admin-coupon-delete">🗑 Eliminar</button>
          </div>
        </div>
        <div class="admin-coupon-edit-form cuenta-form hidden">
          <div class="cuenta-form-row">
            <label>Etiqueta
              <input type="text" class="admin-coupon-edit-label" maxlength="120" value="${escapeHtml(c.label || '')}" />
            </label>
            <label>Días de trial
              <input type="number" min="1" class="admin-coupon-edit-days" value="${c.trial_days}" />
            </label>
          </div>
          <div class="cuenta-form-row">
            <label>Límite de usos
              <input type="number" min="1" class="admin-coupon-edit-max" value="${c.max_redemptions ?? ''}" />
            </label>
            <label>Comisión (%)
              <input type="number" min="0" max="100" step="0.5" class="admin-coupon-edit-commission" value="${c.commission_rate}" />
            </label>
          </div>
          <button type="button" class="cuenta-btn admin-coupon-edit-save">Guardar cambios</button>
          <div class="auth-error hidden admin-coupon-edit-error" role="alert"></div>
        </div>
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
  list.querySelectorAll('.admin-coupon-row').forEach((li) => {
    const code = li.dataset.code;
    const editToggleBtn = li.querySelector('.admin-coupon-edit-toggle');
    const editForm = li.querySelector('.admin-coupon-edit-form');
    if (editToggleBtn && editForm) {
      editToggleBtn.addEventListener('click', () => {
        editForm.classList.toggle('hidden');
      });
    }
    const saveBtn = li.querySelector('.admin-coupon-edit-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const errorEl = li.querySelector('.admin-coupon-edit-error');
        if (errorEl) errorEl.classList.add('hidden');
        const label = li.querySelector('.admin-coupon-edit-label').value.trim();
        const days = parseInt(li.querySelector('.admin-coupon-edit-days').value, 10);
        const maxRaw = li.querySelector('.admin-coupon-edit-max').value.trim();
        const commission = parseFloat(li.querySelector('.admin-coupon-edit-commission').value);
        const body = {
          label: label || null,
          trial_days: days,
          max_redemptions: maxRaw ? parseInt(maxRaw, 10) : null,
          commission_rate: commission,
        };
        saveBtn.disabled = true;
        try {
          await updateCoupon(code, body);
          await loadAdminCoupons();
        } catch (err) {
          saveBtn.disabled = false;
          if (errorEl) {
            errorEl.textContent = (err && err.detail) || 'No se pudo guardar los cambios.';
            errorEl.classList.remove('hidden');
          }
        }
      });
    }
    const deleteBtn = li.querySelector('.admin-coupon-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: 'Eliminar cupón',
          text: `¿Eliminar el cupón ${code}? Esto no se puede deshacer.`,
          confirmLabel: 'Eliminar',
          danger: true,
        });
        if (!ok) return;
        deleteBtn.disabled = true;
        try {
          await deleteCoupon(code);
          await loadAdminCoupons();
        } catch (err) {
          deleteBtn.disabled = false;
          await notifyModal({
            title: 'No se pudo eliminar',
            text: (err && err.detail) || 'Reintentá en unos segundos.',
          });
        }
      });
    }
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
    const commissionRaw = $('admin-coupon-commission').value.trim();
    const commission_rate = commissionRaw ? parseFloat(commissionRaw) : undefined;
    if (!code) return;
    const btn = $('admin-coupon-create');
    btn.disabled = true;
    try {
      await createCoupon({
        code, label, trial_days: days, max_redemptions: max, commission_rate,
      });
      form.reset();
      $('admin-coupon-days').value = '30';
      $('admin-coupon-commission').value = '15';
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

// ── Admin: Ventas por cupón (comisiones de referidos) ───────────────────────
// Complemento de Cupones arriba: no gestiona cupones, solo muestra cuánto
// vendió cada uno y cuánto se le debe de comisión al referido (mismo
// criterio de admin: solo UX, el backend vuelve a chequear require_admin_user
// en /api/v1/admin/coupons/sales).

const ADMIN_COUPON_SALES_EMPTY_TEXT = 'Todavía no hay cupones creados.';

function renderAdminCouponSales(rows) {
  const el = $('admin-coupon-sales-summary');
  if (!el) return;
  if (!rows) {
    el.innerHTML = '<p class="cuenta-empty">No se pudo cargar el resumen de ventas por cupón.</p>';
    return;
  }
  if (!rows.length) {
    el.innerHTML = `<p class="cuenta-empty">${ADMIN_COUPON_SALES_EMPTY_TEXT}</p>`;
    return;
  }
  el.innerHTML = `<ul class="cuenta-list">${rows
    .map(
      (r) => `<li class="cuenta-item">
        <div class="cuenta-item-body">
          <b>${escapeHtml(r.code)}</b>${r.label ? ` — ${escapeHtml(r.label)}` : ''}
          <small>${r.commission_rate}% comisión · ${r.payment_count} pago${r.payment_count === 1 ? '' : 's'} · ${fmtMoney(r.total_sales)} vendido</small>
        </div>
        <strong class="admin-coupon-sales-owed">${fmtMoney(r.commission_owed)}</strong>
      </li>`,
    )
    .join('')}</ul>`;
}

async function loadAdminCouponSales() {
  const el = $('admin-coupon-sales-summary');
  const from = $('admin-coupon-sales-from').value || undefined;
  const to = $('admin-coupon-sales-to').value || undefined;
  if (el) el.innerHTML = '<p class="cuenta-empty">Cargando…</p>';
  try {
    const rows = await getAdminCouponSales(from, to);
    renderAdminCouponSales(rows);
  } catch (_) {
    renderAdminCouponSales(null);
  }
}

function wireAdminCouponSalesForm() {
  const form = $('admin-coupon-sales-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadAdminCouponSales();
  });
  loadAdminCouponSales();
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
      <small>Alta ${fmtDateOrDash(u.created_at)} · último login ${fmtDateOrDash(u.last_login_at)} · última conexión ${fmtDateOrDash(u.last_seen_at)}${u.last_seen_platform ? ` · ${escapeHtml(u.last_seen_platform)}` : ''}</small>
    </div>
    <details class="cuenta-create admin-user-payments-details">
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
    const paymentsDetails = row.querySelector('.admin-user-payments-details');
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
  const resolveBtnClosed = $('admin-support-resolve-btn');
  if (resolveBtnClosed) resolveBtnClosed.classList.add('hidden');
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
  const resolveBtnOpen = $('admin-support-resolve-btn');
  if (resolveBtnOpen) resolveBtnOpen.classList.remove('hidden');
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
    if (isBlank(content)) return;
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

  // Wire back button para cerrar la conversación activa
  const backBtn = $('admin-support-chat-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      closeAdminSupportConversation();
      $('admin-support-chat-empty').classList.remove('hidden');
      $('admin-support-chat-active').classList.add('hidden');
      renderAdminSupportList();
    });
  }
}

/** Botón "Marcar resuelta" del header del chat, wireado UNA sola vez (igual
 * criterio que wireAdminSupportReplyForm) — manda al conversationId
 * actualmente abierto (adminSupportOpenId). El backend rechaza con 404 si
 * la conversación ya no está "open" (ver admin_mark_resolved), pero el
 * botón solo es visible/clickeable mientras se está viendo una conversación
 * PENDIENTE en vivo (ver openAdminSupportConversation/showResolvedConversation,
 * que lo muestran/ocultan igual que admin-support-reply-form). */
function wireAdminSupportResolveButton() {
  const btn = $('admin-support-resolve-btn');
  if (!btn) return;
  const defaultLabel = btn.textContent;
  btn.addEventListener('click', async () => {
    if (!adminSupportOpenId) return;
    const resolvedId = adminSupportOpenId;
    btn.disabled = true;
    try {
      await resolveSupportConversation(resolvedId);
      await loadAdminSupportPending();
      // Sin mensajes: el backend la cierra directo en vez de solo flagearla
      // (ver admin_mark_resolved) -- ya no aparece en Pendientes. Refrescar
      // Resueltos y volver el panel a la vista vacía, mismo criterio que el
      // botón "volver" (closeAdminSupportConversation + chat-empty).
      const stillPending = adminSupportPendingItems.some((c) => c.id === resolvedId);
      if (!stillPending) {
        loadAdminSupportResolved();
        closeAdminSupportConversation();
        $('admin-support-chat-empty').classList.remove('hidden');
        $('admin-support-chat-active').classList.add('hidden');
        renderAdminSupportList();
        btn.textContent = defaultLabel;
        btn.disabled = false;
        return;
      }
      btn.textContent = 'Resuelta ✓';
      window.setTimeout(() => {
        btn.textContent = defaultLabel;
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      btn.disabled = false;
      await notifyModal({
        title: 'No se pudo marcar como resuelta',
        text: (err && err.detail) || 'Reintentá en unos segundos.',
      });
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

// ── Admin: Contabilidad Mensual / F29 ────────────────────────────────────
// Vista mensual de ventas con el desglose neto/IVA/comisión que exige el
// SII para el Formulario 29 de Vyneural SpA (RUT 78.505.157-2, Afecto a
// IVA) — ver backend/app/routers/admin_accounting.py, que ya hace todo el
// cálculo (neto = bruto/1.19, iva = bruto-neto, comisión sobre el neto).
// Este archivo solo pinta lo que el backend devuelve, redondeado a pesos.

// Vocabulario nuevo (no existe en ADMIN_* de arriba): estado real del
// Payment (ver backend/app/models/payment.py::STATUS_VALUES), traducido
// para la columna "Estado" de la tabla.
const ADMIN_ACCOUNTING_STATUS_LABELS = {
  authorized: 'Pagado',
  refunded: 'Reembolsado',
  created: 'Creado',
  failed: 'Fallido',
  rejected: 'Rechazado',
};

function renderMonthlyAccounting(data) {
  const summaryEl = $('admin-accounting-summary');
  const f29El = $('admin-accounting-f29-body');
  const table = $('admin-accounting-table');
  const tbody = $('admin-accounting-table-body');
  const emptyEl = $('admin-accounting-empty');
  if (!summaryEl || !tbody) return;

  if (!data) {
    summaryEl.innerHTML = '<p class="cuenta-empty">No se pudo cargar la contabilidad del mes.</p>';
    if (f29El) f29El.innerHTML = '';
    tbody.innerHTML = '';
    if (table) table.classList.add('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
    return;
  }

  const { summary, f29, sales } = data;
  summaryEl.innerHTML = `
    <div class="admin-stat-row">
      <div class="admin-stat"><strong>${fmtMoney(summary.total_gross)}</strong><span>Bruto</span></div>
      <div class="admin-stat"><strong>${fmtMoney(summary.total_net)}</strong><span>Neto</span></div>
      <div class="admin-stat"><strong>${fmtMoney(summary.total_iva)}</strong><span>IVA débito</span></div>
      <div class="admin-stat"><strong>${fmtMoney(summary.total_commission)}</strong><span>Comisiones</span></div>
      <div class="admin-stat"><strong>${fmtMoney(summary.total_company_net)}</strong><span>Margen neto</span></div>
    </div>`;

  if (f29El) {
    f29El.innerHTML = `
      <p>Código [538] Ventas Afectas a IVA (Neto): <strong>${fmtMoney(f29.code_538_net_sales)}</strong></p>
      <p>Código [504] Débito Fiscal (IVA 19%): <strong>${fmtMoney(f29.code_504_iva_debit)}</strong></p>
      <p>Total Comisiones a Terceros: <strong>${fmtMoney(f29.total_referral_commissions)}</strong></p>`;
  }

  // Empty state explícito pedido por el dueño del producto — ver
  // renderAdminCouponSales para el mismo criterio en otra sección.
  if (!sales || !sales.length) {
    if (table) table.classList.add('hidden');
    if (emptyEl) emptyEl.classList.remove('hidden');
    tbody.innerHTML = '';
    return;
  }
  if (table) table.classList.remove('hidden');
  if (emptyEl) emptyEl.classList.add('hidden');
  tbody.innerHTML = sales
    .map(
      (r) => `<tr>
        <td>${fmtDateOrDash(r.date)}</td>
        <td>${escapeHtml(r.client_email)}</td>
        <td>${escapeHtml(ADMIN_PLAN_LABELS[r.plan] || r.plan)}</td>
        <td>${escapeHtml(r.referral_code || '—')}</td>
        <td>${fmtMoney(r.gross)}</td>
        <td>${fmtMoney(r.net)}</td>
        <td>${fmtMoney(r.iva)}</td>
        <td>${fmtMoney(r.commission)}</td>
        <td>${fmtMoney(r.company_net)}</td>
        <td>${escapeHtml(ADMIN_ACCOUNTING_STATUS_LABELS[r.status] || r.status)}</td>
      </tr>`,
    )
    .join('');
}

async function loadMonthlyAccounting() {
  const summaryEl = $('admin-accounting-summary');
  const monthSel = $('admin-accounting-month');
  const yearInput = $('admin-accounting-year');
  if (!monthSel || !yearInput) return;
  const month = parseInt(monthSel.value, 10);
  const year = parseInt(yearInput.value, 10);
  if (summaryEl) summaryEl.innerHTML = '<p class="cuenta-empty">Cargando…</p>';
  try {
    const data = await getMonthlyAccounting(year, month);
    renderMonthlyAccounting(data);
  } catch (_) {
    renderMonthlyAccounting(null);
  }
}

// Informe F29 en PDF, 100% client-side — mismo header (logo + razón social
// + fecha) y misma cañería jsPDF/autoTable que downloadSalesPdf más arriba,
// solo con las columnas propias de esta sección.
async function downloadMonthlyAccountingPdf() {
  const monthSel = $('admin-accounting-month');
  const yearInput = $('admin-accounting-year');
  const month = parseInt(monthSel.value, 10);
  const year = parseInt(yearInput.value, 10);
  const monthLabel = monthSel.options[monthSel.selectedIndex]?.text || String(month);
  const data = await getMonthlyAccounting(year, month);
  const { summary, f29, sales } = data;

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
      textX = 14;
    }
  }

  doc.setFont(undefined, 'bold');
  doc.setFontSize(16);
  doc.text('Vyneural SpA', textX, headTop + 4);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.text('RUT 78.505.157-2', textX, headTop + 10);

  doc.text(`Período: ${monthLabel} ${year}`, pageWidth - 14, headTop + 4, { align: 'right' });
  doc.text(`Generado: ${new Date().toLocaleString('es-CL')}`, pageWidth - 14, headTop + 10, { align: 'right' });

  let cursorY = headTop + 20;
  doc.setDrawColor(200);
  doc.line(14, cursorY, pageWidth - 14, cursorY);
  cursorY += 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'normal');
  doc.text(`Bruto: ${fmtMoney(summary.total_gross)}`, 14, cursorY);
  cursorY += 6;
  doc.text(`Neto: ${fmtMoney(summary.total_net)}`, 14, cursorY);
  cursorY += 6;
  doc.text(`IVA débito: ${fmtMoney(summary.total_iva)}`, 14, cursorY);
  cursorY += 6;
  doc.text(`Comisiones: ${fmtMoney(summary.total_commission)}`, 14, cursorY);
  cursorY += 6;
  doc.text(`Margen neto: ${fmtMoney(summary.total_company_net)}`, 14, cursorY);
  cursorY += 10;

  const body = (sales || []).map((r) => [
    fmtDateOrDash(r.date),
    r.client_email,
    ADMIN_PLAN_LABELS[r.plan] || r.plan,
    r.referral_code || '—',
    fmtMoney(r.gross),
    fmtMoney(r.net),
    fmtMoney(r.iva),
    fmtMoney(r.commission),
    fmtMoney(r.company_net),
  ]);
  doc.autoTable({
    startY: cursorY,
    head: [['Fecha', 'Cliente', 'Plan', 'Referido', 'Bruto', 'Neto', 'IVA', 'Comisión', 'Ingreso Neto']],
    body: body.length ? body : [['Sin ventas.', '-', '-', '-', '-', '-', '-', '-', '-']],
    theme: 'grid',
    styles: { fontSize: 8 },
    headStyles: { fillColor: [60, 60, 60] },
  });
  cursorY = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Resumen para Formulario 29 (SII)', 14, cursorY);
  cursorY += 7;
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.text(`Código [538] Ventas Afectas a IVA (Neto): ${fmtMoney(f29.code_538_net_sales)}`, 14, cursorY);
  cursorY += 6;
  doc.text(`Código [504] Débito Fiscal (IVA 19%): ${fmtMoney(f29.code_504_iva_debit)}`, 14, cursorY);
  cursorY += 6;
  doc.text(`Total Comisiones a Terceros: ${fmtMoney(f29.total_referral_commissions)}`, 14, cursorY);

  // Pie de página en todas las páginas — mismo patrón que downloadSalesPdf.
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

  doc.save(`contabilidad-${year}-${String(month).padStart(2, '0')}.pdf`);
}

function wireMonthlyAccounting() {
  const form = $('admin-accounting-form');
  const csvBtn = $('admin-accounting-csv');
  const pdfBtn = $('admin-accounting-pdf');
  const errorEl = $('admin-accounting-error');
  const monthSel = $('admin-accounting-month');
  const yearInput = $('admin-accounting-year');
  if (!form || !monthSel || !yearInput) return;

  // Mes actual por default — así la card no aparece vacía la primera vez
  // que se abre (pedido explícito, no un rango arbitrario).
  const now = new Date();
  monthSel.value = String(now.getMonth() + 1);
  yearInput.value = String(now.getFullYear());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadMonthlyAccounting();
  });

  if (csvBtn) {
    // Descarga autenticada — mismo patrón blob que wireAdminSalesForm/csvBtn
    // más arriba (el backend exige Authorization: Bearer, un <a href> plano
    // no sirve).
    csvBtn.addEventListener('click', async () => {
      if (errorEl) errorEl.classList.add('hidden');
      const month = parseInt(monthSel.value, 10);
      const year = parseInt(yearInput.value, 10);
      csvBtn.disabled = true;
      try {
        const csvText = await downloadMonthlyAccountingCsv(year, month);
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `contabilidad-${year}-${String(month).padStart(2, '0')}.csv`;
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
    pdfBtn.addEventListener('click', async () => {
      if (errorEl) errorEl.classList.add('hidden');
      pdfBtn.disabled = true;
      try {
        await downloadMonthlyAccountingPdf();
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

  loadMonthlyAccounting();
}

// ── Admin: Generador de contratos ────────────────────────────────────────
// Sección 100% client-side (mismo patrón que downloadSalesPdf más arriba):
// el admin elige un tipo de contrato, llena un formulario generado desde
// CONTRACT_TEMPLATES (src/ui/contract-templates.js), ve una vista previa en
// vivo del texto ya sustituido, y puede descargar un PDF con líneas de
// firma — opcionalmente con firmas dibujadas a mano en un <canvas>. Ningún
// dato de esta sección toca el backend.

// Trackea si cada canvas de firma tiene trazo dibujado (se resetea al
// limpiar) — así downloadContractPdf() sabe si debe insertar la firma como
// imagen o caer a una línea en blanco.
const adminContractSigHasContent = { a: false, b: false };

// Cláusulas del contrato actualmente en edición — parte de las cláusulas
// por defecto del template elegido (defaultClausesFor) pero el admin puede
// agregar, editar o borrar libremente en memoria antes de exportar. Se
// resetea cada vez que cambia el TIPO de contrato (ver renderContractFields).
let adminContractClauses = [];

// Pista de qué cláusulas están expandidas en el acordeón.
let expandedClauseIndices = new Set();

function renderContractClauses() {
  const container = $('admin-contract-clauses');
  if (!container) return;
  container.innerHTML = adminContractClauses
    .map(
      (c, i) => {
        const isExpanded = expandedClauseIndices.has(i);
        // Generar label: usar título si existe, sino "Cláusula N" (1-indexed).
        const label = c.title || `Cláusula ${i + 1}`;
        // Preview: primeros ~50 caracteres del body, con ellipsis si es más largo.
        const preview = c.body.length > 50 ? c.body.substring(0, 50) + '…' : c.body;
        return `<div class="admin-contract-clause" data-index="${i}">
          <div class="admin-contract-clause-header" data-index="${i}">
            <div class="admin-contract-clause-header-content">
              <span class="admin-contract-clause-label">${escapeHtml(label)}</span>
              <span class="admin-contract-clause-preview">${escapeHtml(preview)}</span>
            </div>
            <span class="admin-contract-clause-chevron${isExpanded ? ' expanded' : ''}">›</span>
          </div>
          <div class="admin-contract-clause-body-wrapper${isExpanded ? '' : ' hidden'}">
            <input type="text" class="admin-contract-clause-title" placeholder="Título de la cláusula (opcional)" value="${escapeHtml(c.title)}" />
            <textarea class="admin-contract-clause-body" placeholder="Texto de la cláusula">${escapeHtml(c.body)}</textarea>
            <button type="button" class="cuenta-btn cuenta-btn-ghost admin-contract-clause-remove">🗑 Eliminar</button>
          </div>
        </div>`;
      },
    )
    .join('');

  // Event listeners para los headers (toggle expanded).
  container.querySelectorAll('.admin-contract-clause-header').forEach((headerEl) => {
    const index = Number(headerEl.dataset.index);
    headerEl.addEventListener('click', () => {
      if (expandedClauseIndices.has(index)) {
        expandedClauseIndices.delete(index);
      } else {
        expandedClauseIndices.add(index);
      }
      renderContractClauses();
    });
  });

  // Event listeners para los inputs y delete buttons.
  container.querySelectorAll('.admin-contract-clause').forEach((el) => {
    const index = Number(el.dataset.index);
    const titleInput = el.querySelector('.admin-contract-clause-title');
    const bodyInput = el.querySelector('.admin-contract-clause-body');
    const removeBtn = el.querySelector('.admin-contract-clause-remove');
    titleInput.addEventListener('input', () => {
      adminContractClauses[index].title = titleInput.value;
      updateContractPreview();
    });
    bodyInput.addEventListener('input', () => {
      adminContractClauses[index].body = bodyInput.value;
      updateContractPreview();
    });
    removeBtn.addEventListener('click', () => {
      // Actualizar el Set de expanded indices: remover el eliminado y shiftar los posteriores.
      const newExpanded = new Set();
      expandedClauseIndices.forEach((idx) => {
        if (idx === index) {
          // No agregar el índice eliminado.
        } else if (idx > index) {
          // Shiftar hacia abajo los índices posteriores al eliminado.
          newExpanded.add(idx - 1);
        } else {
          newExpanded.add(idx);
        }
      });
      expandedClauseIndices = newExpanded;
      adminContractClauses.splice(index, 1);
      renderContractClauses();
      updateContractPreview();
    });
  });
}

function addContractClause() {
  const newIndex = adminContractClauses.length;
  adminContractClauses.push({ title: '', body: '' });
  // Marcar la nueva cláusula como expandida para que el admin pueda empezar a escribir de inmediato.
  expandedClauseIndices.add(newIndex);
  renderContractClauses();
  updateContractPreview();
}

// `options.foreignChecked` sólo aplica al template 'affiliate': cuando es
// true se agregan los `foreignFields` del template al listado y se relabela
// AFILIADO_RUT con `foreignRutLabel` (ver checkbox AFILIADO_EXTRANJERO más
// abajo). `options.resetClauses` (default true) controla si se reinician
// `adminContractClauses` a las por defecto del template — se pone en false
// cuando esta función se re-invoca a sí misma sólo para refrescar el panel
// de campos tras tildar/destildar ese checkbox, para no descartar ediciones
// en curso sobre las OTRAS cláusulas (la cláusula TERCERA se reemplaza aparte,
// puntualmente, por el listener del checkbox).
function renderContractFields(templateId, options = {}) {
  const { foreignChecked = false, resetClauses = true } = options;
  const container = $('admin-contract-fields');
  const template = CONTRACT_TEMPLATES[templateId];
  if (!container || !template) return;
  const isForeign = templateId === 'affiliate' && !!foreignChecked;
  const fields = (isForeign && template.foreignFields)
    ? [...template.fields, ...template.foreignFields]
    : template.fields;
  container.innerHTML = fields
    .map((f) => {
      const id = `admin-contract-field-${f.key}`;
      const defaultVal = f.default !== undefined ? f.default : '';
      const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
      const required = f.required ? ' required' : '';
      const label = (isForeign && f.key === 'AFILIADO_RUT' && template.foreignRutLabel)
        ? template.foreignRutLabel
        : f.label;
      if (f.type === 'checkbox') {
        const checked = f.key === 'AFILIADO_EXTRANJERO' && isForeign ? ' checked' : '';
        return `<label class="admin-contract-checkbox-field">
          <input id="${id}" type="checkbox" data-key="${f.key}"${checked} /> ${escapeHtml(label)}
        </label>`;
      }
      if (f.type === 'select') {
        const optionsHtml = (f.options || [])
          .map((opt) => `<option value="${escapeHtml(opt)}"${opt === f.default ? ' selected' : ''}>${escapeHtml(opt)}</option>`)
          .join('');
        return `<label>${escapeHtml(label)}
          <select id="${id}" data-key="${f.key}">${optionsHtml}</select>
        </label>`;
      }
      if (f.type === 'textarea') {
        return `<label>${escapeHtml(label)}
          <textarea id="${id}" data-key="${f.key}"${placeholder}${required}>${escapeHtml(defaultVal)}</textarea>
        </label>`;
      }
      const extra = f.type === 'number'
        ? `${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}`
        : '';
      return `<label>${escapeHtml(label)}
        <input id="${id}" type="${f.type}" data-key="${f.key}" value="${escapeHtml(defaultVal)}"${placeholder}${required}${extra} />
      </label>`;
    })
    .join('');
  container.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('input', updateContractPreview);
    el.addEventListener('change', updateContractPreview);
  });

  // Checkbox "¿Afiliado Extranjero?" (sólo existe en el template 'affiliate'):
  // además del listener genérico de arriba (que ya refresca la vista previa),
  // necesita re-renderizar el panel de campos completo (para mostrar/ocultar
  // foreignFields y relabelar AFILIADO_RUT) y reemplazar la cláusula TERCERA
  // por su versión extranjera/doméstica en el editor de cláusulas.
  const foreignCheckbox = container.querySelector('[data-key="AFILIADO_EXTRANJERO"]');
  if (foreignCheckbox) {
    foreignCheckbox.addEventListener('change', () => {
      const checked = foreignCheckbox.checked;
      renderContractFields(templateId, { foreignChecked: checked, resetClauses: false });
      if (template.foreignClause && template.domesticClauseIndex !== undefined) {
        adminContractClauses[template.domesticClauseIndex] = checked
          ? { ...template.foreignClause }
          : { ...template.clauses[template.domesticClauseIndex] };
      }
      renderContractClauses();
      updateContractPreview();
    });
  }

  const [sigA, sigB] = template.signatures;
  const labelA = $('admin-contract-sig-label-a');
  const labelB = $('admin-contract-sig-label-b');
  if (labelA && sigA) labelA.textContent = `${sigA.partyLabel} — ${sigA.name || ''}`;
  if (labelB && sigB) labelB.textContent = sigB.partyLabel;

  // Cambiar el TIPO de contrato resetea las cláusulas a las por defecto de
  // ese template, descartando cualquier edición en curso sobre el tipo
  // anterior — comportamiento simple y aceptado, no se intenta preservar.
  if (resetClauses) {
    adminContractClauses = defaultClausesFor(templateId);
    renderContractClauses();
  }
}

function readContractFormValues(templateId) {
  const container = $('admin-contract-fields');
  const values = {};
  if (!container) return values;
  container.querySelectorAll('[data-key]').forEach((el) => {
    // Checkboxes (p.ej. AFILIADO_EXTRANJERO) son un toggle de UI, no un
    // token del documento — se lee `.checked` en vez de `.value` por si
    // algún día se necesita, aunque hoy no se sustituye en ninguna cláusula.
    // <select> ya expone `.value` igual que un input de texto, sin cambios.
    values[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return values;
}

function updateContractPreview() {
  const templateId = $('admin-contract-type')?.value;
  if (!templateId) return;
  const values = readContractFormValues(templateId);
  const preview = $('admin-contract-preview');
  if (!preview) return;
  const filled = fillClauses(adminContractClauses, values);
  preview.innerHTML = filled
    .map((c) => {
      const titleHtml = c.title ? `<p class="admin-contracts-preview-clause-title">${escapeHtml(c.title)}</p>` : '';
      return `${titleHtml}<p>${escapeHtml(c.body)}</p>`;
    })
    .join('');

  // La etiqueta de la firma B es dinámica (depende del cliente/afiliado
  // ingresado) — se refresca acá junto con el resto de la vista previa.
  const template = CONTRACT_TEMPLATES[templateId];
  const sigB = template && template.signatures[1];
  const labelB = $('admin-contract-sig-label-b');
  if (labelB && sigB) {
    const name = values[sigB.nameKey];
    const rut = values[sigB.rutKey];
    const namePart = name && name.trim() ? name : `[${sigB.nameKey}]`;
    const rutPart = rut && rut.trim() ? rut : `[${sigB.rutKey}]`;
    labelB.textContent = `${sigB.partyLabel} — ${namePart} (RUT ${rutPart})`;
  }
}

// Dibujo básico mouse+touch sobre un <canvas> para capturar una firma a
// mano. sigKey identifica la entrada correspondiente en
// adminContractSigHasContent ('a' | 'b').
function wireSignaturePad(canvasId, clearBtnId, sigKey) {
  const canvas = $(canvasId);
  const clearBtn = $(clearBtnId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#eef0ff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  let drawing = false;

  const posFromEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    const { x, y } = posFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const { x, y } = posFromEvent(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    adminContractSigHasContent[sigKey] = true;
  });
  const endStroke = () => { drawing = false; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointerleave', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      adminContractSigHasContent[sigKey] = false;
    });
  }
}

async function downloadContractPdf() {
  const templateId = $('admin-contract-type').value;
  const values = readContractFormValues(templateId);
  const template = CONTRACT_TEMPLATES[templateId];
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 20;
  const maxWidth = pageWidth - marginX * 2;
  const headTop = 15;

  // Mismo header (logo + razón social + fecha) que downloadSalesPdf.
  const logoDataUrl = await rasterizeLogoToPngDataUrl();
  let textX = 14;
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, 'PNG', 14, headTop - 4, 16, 16);
      textX = 34;
    } catch (_) {
      textX = 14;
    }
  }
  doc.setFont(undefined, 'bold');
  doc.setFontSize(16);
  doc.text('Vyneural SpA', textX, headTop + 4);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.text('RUT 78.505.157-2', textX, headTop + 10);
  doc.text(`Generado: ${new Date().toLocaleString('es-CL')}`, pageWidth - 14, headTop + 4, { align: 'right' });

  let y = headTop + 24;
  doc.setDrawColor(200);
  doc.line(14, y - 6, pageWidth - 14, y - 6);

  doc.setFontSize(13);
  doc.setFont(undefined, 'bold');
  const titleLines = doc.splitTextToSize(template.title, maxWidth);
  doc.text(titleLines, pageWidth / 2, y, { align: 'center' });
  y += titleLines.length * 6 + 8;

  doc.setFontSize(10.5);
  const filledClauses = fillClauses(adminContractClauses, values);
  for (const clause of filledClauses) {
    if (clause.title) {
      doc.setFont(undefined, 'bold');
      const titleLines = doc.splitTextToSize(clause.title, maxWidth);
      for (const line of titleLines) {
        if (y > pageHeight - 40) { doc.addPage(); y = 20; }
        doc.text(line, marginX, y);
        y += 5.5;
      }
    }
    doc.setFont(undefined, 'normal');
    const bodyLines = doc.splitTextToSize(clause.body, maxWidth);
    for (const line of bodyLines) {
      if (y > pageHeight - 40) { doc.addPage(); y = 20; }
      doc.text(line, marginX, y);
      y += 5.5;
    }
    y += 4; // espacio entre cláusulas
  }

  // Bloque de firmas — fuerza una página nueva si no queda espacio decente.
  if (y > pageHeight - 70) { doc.addPage(); y = 20; }
  y += 15;
  const colWidth = (maxWidth - 20) / 2;
  const colX = [marginX, marginX + colWidth + 20];
  const sigCanvases = [$('admin-contract-sig-canvas-a'), $('admin-contract-sig-canvas-b')];
  const sigKeys = ['a', 'b'];

  template.signatures.forEach((sig, i) => {
    const x = colX[i];
    doc.setFont(undefined, 'bold');
    doc.setFontSize(10);
    doc.text(sig.partyLabel, x, y);

    const canvas = sigCanvases[i];
    const hasSig = canvas && adminContractSigHasContent[sigKeys[i]];
    if (hasSig) {
      try {
        doc.addImage(canvas.toDataURL('image/png'), 'PNG', x, y + 4, 50, 20);
      } catch (_) {
        doc.text('________________________', x, y + 19);
      }
    } else {
      doc.text('________________________', x, y + 19);
    }

    const printedName = sig.dynamic ? (values[sig.nameKey] || `[${sig.nameKey}]`) : sig.name;
    const printedRut = sig.dynamic ? (values[sig.rutKey] || `[${sig.rutKey}]`) : sig.rut;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.text(printedName, x, y + 28);
    doc.text(`RUT ${printedRut}`, x, y + 33);
  });

  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('Documento generado automáticamente — Vyneural SpA', 14, pageHeight - 10);
    doc.text(`Página ${i} de ${totalPages}`, pageWidth - 14, pageHeight - 10, { align: 'right' });
    doc.setTextColor(0);
  }

  doc.save(`contrato-${templateId}-${new Date().toISOString().slice(0, 10)}.pdf`);
}

function wireAdminContracts() {
  const typeSel = $('admin-contract-type');
  const downloadBtn = $('admin-contract-download');
  if (!typeSel) return;
  typeSel.addEventListener('change', () => {
    renderContractFields(typeSel.value);
    updateContractPreview();
  });
  renderContractFields(typeSel.value);
  updateContractPreview();
  wireSignaturePad('admin-contract-sig-canvas-a', 'admin-contract-sig-clear-a', 'a');
  wireSignaturePad('admin-contract-sig-canvas-b', 'admin-contract-sig-clear-b', 'b');
  const addClauseBtn = $('admin-contract-add-clause');
  if (addClauseBtn) addClauseBtn.addEventListener('click', addContractClause);
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      try {
        await downloadContractPdf();
      } catch (err) {
        await notifyModal({
          title: 'No se pudo generar el PDF',
          text: (err && err.detail) || 'reintentá en unos segundos',
        });
      } finally {
        downloadBtn.disabled = false;
      }
    });
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
  wireAdminCouponSalesForm();
  wireAdminSalesForm();
  wireMonthlyAccounting();
  loadAdminUsers();
  wireAdminUsersForm();
  wireAdminContracts();
  wireAdminSupportShowMoreButtons();
  wireAdminSupportTabs();
  wireAdminSupportReplyForm();
  wireAdminSupportResolveButton();
  loadAdminSupport();
}

init();
