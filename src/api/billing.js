// src/api/billing.js
// Plan Premium — pagos Webpay Plus (Transbank), SOLO web (Android usa
// Google Play Billing aparte, no este código). Aditivo: sin backend/sesión
// simplemente no se puede comprar, el resto de la app sigue igual.

import { get, post, del } from './client.js';

/** Precios reales — SIEMPRE del backend (app/billing/plans.py), nunca
 * hardcodeados acá: evita que el precio mostrado se desincronice del que
 * de verdad se cobra. Público, no requiere sesión. */
export async function listPlans() {
  return get('/api/v1/payments/plans');
}

/** Arma la transacción en el backend. Devuelve { url, token } — el llamador
 * arma un form-POST hacia `url` con `token_ws=token` (Transbank exige un
 * POST real del navegador, no un simple redirect ni un fetch). */
export async function createPayment(plan) {
  return post('/api/v1/payments/create', { plan });
}

export async function premiumStatus() {
  return get('/api/v1/payments/status');
}

export async function paymentHistory() {
  return get('/api/v1/payments');
}

// ── Oneclick Mall: auto-renovación opcional, activada desde /cuenta ────────
// (De por vida nunca aplica: no vence, no tiene nada que auto-renovar.)

/** Igual patrón que createPayment: { url, token } para un form-POST real
 * hacia Transbank (esta vez a la página de inscripción de tarjeta) — salvo
 * que ya haya una tarjeta activa y `forceNewCard` sea false: ahí devuelve
 * { switched: true } sin url/token (cambió de plan sin pedir nada nuevo,
 * ver premium.js::buyPlan). `forceNewCard` fuerza pedir una tarjeta nueva
 * aunque ya haya una activa para el mismo plan (ver cuenta.js →
 * "Actualizar tarjeta"). */
export async function inscribeOneclick(plan, forceNewCard = false) {
  return post('/api/v1/payments/oneclick/inscribe', { plan, force_new_card: forceNewCard });
}

export async function oneclickStatus() {
  return get('/api/v1/payments/oneclick/status');
}

/** Esto es "cancelar la suscripción": borra la tarjeta guardada en
 * Transbank y de nuestro lado — el plan ya pagado sigue activo hasta que
 * corresponda, solo se corta el PRÓXIMO cobro automático. */
export async function cancelOneclick() {
  return del('/api/v1/payments/oneclick');
}
