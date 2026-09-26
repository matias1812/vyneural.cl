// src/api/billing.js
// Plan Premium — pagos Webpay Plus (Transbank) para la web, y verificación
// de compras de Google Play para la APK (ver premium.js::buyPlan, que
// branchea por plataforma). Aditivo: sin backend/sesión simplemente no se
// puede comprar, el resto de la app sigue igual.

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

/** Get-or-create el código de referido propio (ver /cuenta → "Tu código de
 * referido"): quien se registre con este código activa 1 mes de Premium
 * gratis al elegir un plan Mensual o Anual. Siempre el mismo código una vez
 * creado. */
export async function getReferralCode() {
  return get('/api/v1/payments/referral/code');
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

// ── Google Play Billing: compras hechas en la APK ───────────────────────────
// Contraparte de Webpay/Oneclick de arriba, SOLO APK (Play exige su propio
// medio de pago para contenido digital dentro de la app). El purchaseToken
// sale de startPlayPurchase (platform/native-bridge.js) DESPUÉS de una
// compra real en Play — el backend es quien de verdad la verifica contra
// Google y recién ahí otorga Premium (ver routers/payments.py::
// google_play_verify); esto nunca se confía del lado cliente.
export async function verifyGooglePlayPurchase(purchaseToken, productId) {
  return post('/api/v1/payments/google-play/verify', { purchase_token: purchaseToken, product_id: productId });
}

// IDs de producto/suscripción tal como se crean en Play Console — mismo
// mapeo que el backend (app/billing/plans.py::GOOGLE_PLAY_PRODUCT_IDS) y
// que android/app/build.gradle::applicationId. Actualizar los tres juntos
// si cambian. Compartido entre premium.js (comprar) y cuenta.js (armar el
// link de "cancelar en Google Play").
export const GOOGLE_PLAY_PRODUCT_IDS = { monthly: 'premium_monthly', annual: 'premium_annual', lifetime: 'premium_lifetime' };
export const ANDROID_PACKAGE_ID = 'com.vyneural.bineural';
