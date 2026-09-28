// src/api/admin.js
// Panel de admin — Ventas, Usuarios y Soporte (además de Cupones, que ya
// vive en billing.js). SOLO llamado desde cuenta.js cuando
// profile.email === settings.admin_email — eso es únicamente UX, la
// seguridad real es require_admin_user en cada endpoint del backend
// (backend/app/deps.py), sin importar lo que haga o deje de hacer el
// frontend. Mismo patrón que billing.js: funciones finas sobre
// get/post de client.js, sin lógica de UI acá.

import { get, post, getText, API_BASE } from './client.js';

// ── Ventas (backend/app/routers/admin_sales.py) ─────────────────────────────

function dateQuery(fromDate, toDate) {
  const params = new URLSearchParams();
  if (fromDate) params.set('from_date', fromDate);
  if (toDate) params.set('to_date', toDate);
  return params.toString();
}

export async function getSalesSummary(fromDate, toDate) {
  const qs = dateQuery(fromDate, toDate);
  return get(`/api/v1/admin/sales/summary${qs ? `?${qs}` : ''}`);
}

/** Path relativo (sin API_BASE) del CSV de ventas. Separado de
 * getSalesExportUrl porque la descarga real pasa por getText() (headers de
 * auth) — ver downloadSalesCsv más abajo. */
export function getSalesExportPath(fromDate, toDate) {
  const qs = dateQuery(fromDate, toDate);
  return `/api/v1/admin/sales/export.csv${qs ? `?${qs}` : ''}`;
}

/** URL absoluta del CSV — el backend exige `Authorization: Bearer` (sin
 * cookie ni token por query string, ver deps.py::get_current_user), así que
 * esto NO sirve como href de descarga directa: un <a href> plano no manda
 * ese header y el navegador recibiría un 401 en vez de un archivo. Se
 * expone igual (referencia/debug); la descarga real en cuenta.js usa
 * downloadSalesCsv(), que sí pasa por la cañería autenticada. */
export function getSalesExportUrl(fromDate, toDate) {
  return `${API_BASE}${getSalesExportPath(fromDate, toDate)}`;
}

/** Descarga autenticada del CSV (texto crudo, no JSON) — cuenta.js lo vuelca
 * a un Blob y dispara la descarga con el mismo patrón que
 * main.js::downloadBackup. */
export async function downloadSalesCsv(fromDate, toDate) {
  return getText(getSalesExportPath(fromDate, toDate));
}

// ── Contabilidad mensual / F29 (backend/app/routers/admin_accounting.py) ───

export async function getMonthlyAccounting(year, month) {
  return get(`/api/v1/admin/accounting/monthly?year=${year}&month=${month}`);
}

/** Path relativo del CSV — mismo motivo que getSalesExportPath: el backend
 * exige Authorization: Bearer, así que un <a href> plano no sirve para
 * descargar directo (ver downloadMonthlyAccountingCsv más abajo). */
export function getMonthlyAccountingCsvPath(year, month) {
  return `/api/v1/admin/accounting/monthly/export.csv?year=${year}&month=${month}`;
}

/** Descarga autenticada del CSV (texto crudo) — mismo patrón que
 * downloadSalesCsv: admin.js lo vuelca a un Blob para disparar la descarga. */
export async function downloadMonthlyAccountingCsv(year, month) {
  return getText(getMonthlyAccountingCsvPath(year, month));
}

// ── Usuarios (backend/app/routers/admin_users.py) ───────────────────────────

export async function listAdminUsers(search, page = 1, perPage = 10) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  return get(`/api/v1/admin/users?${params.toString()}`);
}

export async function getUserPayments(userId) {
  return get(`/api/v1/admin/users/${encodeURIComponent(userId)}/payments`);
}

export async function grantUserPremium(userId, body) {
  return post(`/api/v1/admin/users/${encodeURIComponent(userId)}/premium/grant`, body);
}

export async function revokeUserPremium(userId, body) {
  return post(`/api/v1/admin/users/${encodeURIComponent(userId)}/premium/revoke`, body);
}

export async function refundUserPayment(userId, paymentId) {
  return post(`/api/v1/admin/users/${encodeURIComponent(userId)}/payments/${encodeURIComponent(paymentId)}/refund`, {});
}

// ── Analítica de uso (backend/app/routers/admin_analytics.py) ──────────────

export async function getUsageAnalytics(days = 30) {
  return get(`/api/v1/admin/analytics/usage?days=${encodeURIComponent(days)}`);
}

// ── Soporte (backend/app/routers/support.py::admin_router) ─────────────────

export async function listAdminSupportConversations(status = 'open') {
  return get(`/api/v1/admin/support/conversations?status=${encodeURIComponent(status)}`);
}

export async function getAdminSupportStats(fromDate, toDate) {
  const params = new URLSearchParams();
  if (fromDate) params.set('from_date', fromDate);
  if (toDate) params.set('to_date', toDate);
  const qs = params.toString();
  return get(`/api/v1/admin/support/stats${qs ? `?${qs}` : ''}`);
}

export async function getAdminSupportMessages(conversationId, since) {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  return get(`/api/v1/admin/support/conversations/${encodeURIComponent(conversationId)}/messages${qs}`);
}

export async function sendAdminSupportMessage(conversationId, content) {
  return post(`/api/v1/admin/support/conversations/${encodeURIComponent(conversationId)}/messages`, { content });
}

// Marca una conversación PENDIENTE como resuelta sin cerrarla — el cierre
// real (status="closed", purga de mensajes) sigue siendo exclusivo del
// usuario al calificar (rateConversation, ver api/support.js). Esto solo
// deja una marca para que el widget del usuario lo mande directo a
// calificar la próxima vez que abra el chat (ver support-chat.js).
export async function resolveSupportConversation(conversationId) {
  return post(`/api/v1/admin/support/conversations/${encodeURIComponent(conversationId)}/resolve`, {});
}

// ── Códigos de Google Play (backend/app/routers/admin_google_play_codes.py) ──

export async function getGooglePlayCodesAvailable() {
  return get('/api/v1/admin/google-play-codes/available');
}

export async function importGooglePlayCodes(plan, csvContent) {
  return post('/api/v1/admin/google-play-codes/import', {
    plan,
    csv_content: csvContent,
  });
}
