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
