// src/api/push.js
// Web Push VAPID: suscripción del dispositivo contra el backend.
//
// REGLA DE ORO: una notificación Push NUNCA reproduce audio. El SW solo
// muestra la notificación; el usuario decide con un gesto.

import { cachedGet, post, del } from './client.js';
import { detectNativeBridge } from '../platform/native-bridge.js';

// ── Estado real del backend de push (compartido) ───────────────────────────
// La UI del generador, /diagnostico y el manager de notificaciones necesitan
// saber si el backend tiene Web Push configurado SIN re-consultar cada vez.
// Se cachea en memoria: `null` = aún sin consultar; tras la primera consulta
// queda el último estado conocido ({ supported, configured, public_key,
// subscription_count }). NUNCA se guardan claves privadas.
let cachedStatus = null;

export function setCachedPushStatus(status) {
  cachedStatus = status || null;
}

export function getCachedPushStatus() {
  return cachedStatus;
}

export async function pushStatus() {
  const s = await cachedGet('/api/v1/push/status');
  setCachedPushStatus(s);
  return s;
}

// Registra el Service Worker y suscribe el dispositivo si el backend está
// configurado. Devuelve { configured, subscribed } — nunca lanza si falta
// HTTPS, permisos o SW (la PWA sigue funcionando igual).
export async function subscribeToPush() {
  // Dentro de la APK, FCM ya cubre este dispositivo (push nativo, ver
  // backend/app/push/fcm.py::send_to_user / VyneuralMessagingService.kt) —
  // la WebView de Chromium SÍ soporta PushManager, así que sin este guard un
  // usuario APK terminaba con una PushSubscription (Web Push) VIVA además de
  // su Device.fcm_token, pudiendo disparar una notificación duplicada si el
  // fallback de Web Push en reminders.py::_send_one_reminder se activaba con
  // esa suscripción vieja todavía activa. Mismo helper de detección que ya
  // usa premium.js — no se inventa un tercer método.
  if (detectNativeBridge()?.platform === 'android') {
    // Limpieza de instalaciones previas a este fix: si ya había una
    // PushSubscription viva de antes, se da de baja acá para no dejar dos
    // canales activos en paralelo en el próximo tick.
    await unsubscribeFromPush().catch(() => {});
    return { configured: false, subscribed: false, reason: 'native-push-covers-apk' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { configured: false, subscribed: false, reason: 'unsupported' };
  }
  let status;
  try {
    status = await pushStatus();
  } catch (_) {
    setCachedPushStatus({ supported: true, configured: false });
    return { configured: false, subscribed: false, reason: 'backend-offline' };
  }
  if (!status.configured || !status.public_key) {
    setCachedPushStatus(status);
    return { configured: false, subscribed: false, reason: 'backend-not-configured' };
  }
  try {
    // getRegistration() resuelve al instante; serviceWorker.ready colgaría
    // si no hay service worker registrado (p. ej. en dev/localhost).
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      // Entrar directo a /cuenta sin pasar por la home podía dejar la página
      // sin SW. site.js ya lo registra en todas las páginas; acá además se
      // registra en el acto como red de seguridad.
      try {
        reg = await navigator.serviceWorker.register('sw.js');
      } catch (_) {
        /* sin registro: motivo honesto abajo */
      }
    }
    if (!reg) {
      return { configured: true, subscribed: false, reason: 'no-service-worker' };
    }
    const applicationServerKey = urlBase64ToUint8Array(status.public_key);
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
    await post('/api/v1/push/subscribe', {
      endpoint: subscription.endpoint,
      p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))),
      auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')))),
      user_agent: navigator.userAgent.slice(0, 500),
    });
    setCachedPushStatus({ ...status, subscription_count: 1 });
    return { configured: true, subscribed: true };
  } catch (err) {
    const message = String((err && err.message) || err);
    // Chromium tira este mensaje genérico cuando el registro contra el
    // servicio push de Google (FCM) es rechazado por el propio navegador —
    // el caso típico es Brave, que por privacidad desactiva "servicios de
    // Google para mensajería push" salvo que el usuario lo habilite a mano.
    // Es un bloqueo del navegador, no un error nuestro ni del backend.
    const reason = /push service error/i.test(message) ? 'browser-blocked-push-service' : message;
    return { configured: true, subscribed: false, reason };
  }
}

export async function unsubscribeFromPush() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    // getRegistration() en vez de ready: si nunca hubo SW, ready colgaría
    // para siempre; con getRegistration() simplemente no hay nada que dar de
    // baja y se devuelve false.
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return false;
    await del('/api/v1/push/subscribe', {
      endpoint: subscription.endpoint,
      p256dh: '',
      auth: '',
    }).catch(() => {});
    await subscription.unsubscribe();
    setCachedPushStatus(null);
    return true;
  } catch (_) {
    return false;
  }
}

// Base64url (VAPID public key) → Uint8Array para PushManager.subscribe.
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
