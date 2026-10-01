// src/platform/google-play-redeem.js
// Red de seguridad para el canje de cupón vía código de Google Play (ver
// plan swirling-gliding-turing.md, tarea C3): canjear un código en la
// superficie de "Redimir código" de Play Store SIEMPRE navega fuera de la
// SPA (window.location.href = redeem_url, ver premium.js::buyPlan) y nunca
// vuelve a la app sola. Antes el único chequeo de retorno vivía adentro de
// /premium (checkForRedeemedGooglePlayCode local, one-shot, sin reintentos)
// — si el usuario volvía a /cuenta (donde activó el cupón originalmente) en
// vez de /premium, o si la caché local de Play Billing todavía no había
// sincronizado, nada reintentaba: el cupón quedaba "pendiente" de forma
// indefinida hasta un reload manual con suerte de timing (bug real
// confirmado en producción).
//
// Este módulo es la única fuente de verdad del lado cliente: persiste en
// localStorage que se emitió un código y sigue sin confirmar (sobrevive
// días, no una sola sesión/tab), y lo reintenta desde CUALQUIER página que
// cargue site.js (todas) en vez de solo /premium. El backend no puede
// resolver esto solo: el RTDN de Google no puede atribuir una suscripción
// nueva a un usuario Vyneural sin que el cliente la descubra primero
// localmente y llame a /google-play/verify (ya idempotente por
// purchase_token) — la solución es 100% client-side.
//
// Nunca un setInterval de fondo: todo corre dentro de una invocación
// disparada por un evento real (boot, visibilitychange, vyneural:resumed, o
// el botón manual de /cuenta) — ver initGooglePlayRedeemWatch().

import { getAccessToken } from '../api/client.js';
import { verifyGooglePlayPurchase, GOOGLE_PLAY_PRODUCT_IDS } from '../api/billing.js';
import { detectNativeBridge, checkPlayPurchases } from './native-bridge.js';

// Sobrevive días (no sessionStorage): el usuario puede canjear el código en
// Play Store y no volver a abrir la app hasta el día siguiente — el rastro
// de "hay algo pendiente de confirmar" tiene que seguir ahí.
const PENDING_KEY = 'vyneural_google_play_redeem_code_pending';

export function markGooglePlayRedeemCodeIssued(plan) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ plan, issuedAt: Date.now() }));
  } catch (_) {
    /* sin localStorage: no hay dónde guardar el rastro — el chequeo con
       force:true desde /cuenta sigue funcionando igual, solo se pierde el
       chequeo automático en background */
  }
}

export function clearGooglePlayRedeemCodePending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch (_) {
    /* sin localStorage */
  }
}

function hasPendingRedeemLocally() {
  try {
    return !!localStorage.getItem(PENDING_KEY);
  } catch (_) {
    return false;
  }
}

/**
 * Sincroniza el flag local contra `has_pending_coupon` de premiumStatus()
 * — sin ninguna llamada de red nueva, las páginas que la llaman ya tienen
 * ese dato de su propia carga de status. Si el backend dice que ya no hay
 * cupón pendiente (se canjeó y verificó en otro dispositivo/pestaña, o el
 * usuario lo canceló desde /cuenta) pero local todavía cree que falta
 * confirmar un código emitido, ese rastro ya quedó obsoleto: limpiarlo evita
 * reintentos de background eternos por algo que ya se resolvió solo.
 */
export function noteBackendPendingCouponStatus(hasPendingCoupon) {
  if (!hasPendingCoupon && hasPendingRedeemLocally()) {
    clearGooglePlayRedeemCodePending();
  }
}

// Reintenta verifyGooglePlayPurchase con backoff generoso — un cold start de
// Render (free tier) puede tardar minutos, no solo los ~20-50s "típicos", y
// la compra YA se hizo de verdad del lado de Google (hay purchaseToken real)
// cuando esto corre: si la verificación se rinde después de un solo intento,
// la compra queda "comprada pero nunca confirmada" hasta que Google la
// revierte sola por falta de acknowledge (bug real visto en vivo probando la
// APK). `onPersist`/`onClear` son callbacks opcionales: el pendiente de
// sessionStorage entre reintentos es específico del flujo de premium.js
// (savePendingGooglePlayPurchase/clearPendingGooglePlayPurchase), este
// módulo no lo conoce directamente.
export const RETRY_DELAYS_MS = [
  3000, 6000, 12000, 20000, // ~41s — cold start "típico"
  30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, // +270s — cold start largo
]; // ~5m11s de cobertura total

export async function verifyGooglePlayPurchaseWithRetry(purchaseToken, productId, { onAttempt, onPersist, onClear } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (onAttempt) onAttempt(attempt);
    try {
      await verifyGooglePlayPurchase(purchaseToken, productId);
      if (onClear) onClear();
      return { ok: true };
    } catch (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        // Sesión REALMENTE muerta (sobrevivió el refresh automático de
        // client.js): reintentar el mismo request no cambia nada, solo
        // quema presupuesto mientras la ventana real que tiene Google antes
        // de auto-cancelar la compra por falta de acknowledge (confirmado
        // en vivo: minutos, no los 3 días documentados) se cierra sola.
        if (onPersist) onPersist();
        return { ok: false, sessionExpired: true };
      }
      // 409: conflicto PERMANENTE — este mismo comprobante de Google ya se
      // otorgó a otra cuenta de Vyneural (routers/payments.py::
      // google_play_verify). Reintentar nunca lo resuelve.
      if (err && err.status === 409) {
        if (onClear) onClear();
        return { ok: false, sessionExpired: false, permanentError: err.detail || 'esta compra ya está registrada en otra cuenta' };
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        if (onPersist) onPersist();
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return { ok: false, sessionExpired: false };
    }
  }
}

// Mutex + cooldown: visibilitychange y vyneural:resumed pueden dispararse
// casi simultáneos al volver del task switcher — sin esto, dos chequeos en
// paralelo golpearían el bridge nativo y el backend por duplicado.
let checkInFlight = false;
let lastCheckAt = 0;
const COOLDOWN_MS = 15000;

// Reintentos CORTOS dentro de la misma invocación, para tolerar el lag de
// sincronización de la caché local de Play Billing (queryPurchasesAsync no
// siempre refleja un canje hecho hace unos segundos) — ~26s de cobertura
// total. Nada que ver con RETRY_DELAYS_MS de arriba (eso es backoff de red
// contra NUESTRO backend, esto es esperar a que Play Billing se entere).
const PURCHASE_CACHE_RETRY_DELAYS_MS = [0, 3000, 8000, 15000];

/**
 * Busca una suscripción recién canjeada en la caché local de Play Billing y,
 * si la encuentra, la corre por el mismo pipeline de verify que una compra
 * normal. Pensado para correr sin gesto de usuario (boot, visibilitychange,
 * vyneural:resumed) Y con gesto (botón manual de /cuenta, `force: true`).
 * Nunca lanza, nunca muestra UI propia — devuelve un resultado que el
 * llamador decide cómo mostrar (ver cuenta.js::wireManualGooglePlayVerify).
 */
export async function checkForRedeemedGooglePlayCode({ force = false } = {}) {
  if (detectNativeBridge()?.platform !== 'android') return { skipped: 'not_android' };
  if (!getAccessToken()) return { skipped: 'no_session' };
  // Gate de costo cero ANTES de tocar el bridge nativo: sin force y sin
  // nada pendiente localmente, no hay nada que confirmar.
  if (!force && !hasPendingRedeemLocally()) return { skipped: 'nothing_pending' };
  if (checkInFlight) return { skipped: 'in_flight' };
  if (!force && Date.now() - lastCheckAt < COOLDOWN_MS) return { skipped: 'cooldown' };
  checkInFlight = true;
  lastCheckAt = Date.now();
  try {
    for (let attempt = 0; attempt < PURCHASE_CACHE_RETRY_DELAYS_MS.length; attempt++) {
      if (PURCHASE_CACHE_RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, PURCHASE_CACHE_RETRY_DELAYS_MS[attempt]));
      }
      const result = await checkPlayPurchases([GOOGLE_PLAY_PRODUCT_IDS.monthly, GOOGLE_PLAY_PRODUCT_IDS.annual]);
      if (result && result.purchaseToken) {
        const verifyResult = await verifyGooglePlayPurchaseWithRetry(result.purchaseToken, result.productId, {
          onClear: clearGooglePlayRedeemCodePending,
        });
        return { ok: !!verifyResult.ok, found: true, verifyResult };
      }
    }
    // Agotados los reintentos sin encontrar nada: silencioso a propósito
    // cuando no es forzado (se reintenta solo en el próximo evento real);
    // el caller con force:true (botón manual) sí muestra algo con esto.
    return { ok: false, found: false };
  } finally {
    checkInFlight = false;
  }
}

let wired = false;

function announce(result) {
  if (result && result.ok) {
    // Solo despacha el evento de datos — nunca un modal propio acá: una
    // página con audio en curso no debe verse interrumpida por una UI que
    // este módulo no pidió mostrar. Cada página decide (ver premium.js y
    // cuenta.js, listener de 'vyneural:premium-granted').
    document.dispatchEvent(new CustomEvent('vyneural:premium-granted'));
  }
}

/**
 * Se llama UNA vez (idempotente) desde site.js, que ya se carga en todas
 * las páginas — así el canje se detecta sin importar a qué página haya
 * vuelto el usuario tras canjear en Play Store.
 */
export function initGooglePlayRedeemWatch() {
  if (wired) return;
  wired = true;
  checkForRedeemedGooglePlayCode().then(announce);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForRedeemedGooglePlayCode().then(announce);
  });
  // Señal nativa explícita (MainActivity.onResume()): visibilitychange no
  // dispara de forma confiable en esta WebView con launchMode="singleTask"
  // (reabrir desde el ícono trae la Activity ya existente a onResume() sin
  // recargar la página).
  document.addEventListener('vyneural:resumed', () => {
    checkForRedeemedGooglePlayCode().then(announce);
  });
}
