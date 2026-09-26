// src/api/devices.js
// Dispositivos del usuario: cada plataforma (APK / web / PWA) reporta su
// estado REAL de notificaciones y /cuenta lo lista. Aditivo: si el backend
// o el endpoint fallan, la app sigue funcionando igual (nunca rompe la UI).

import { get, put, del } from './client.js';
import { isStandalone } from '../notifications.js';

export const listDevices = () => get('/api/v1/devices');
export const forgetDevice = (deviceId) => del(`/api/v1/devices/${deviceId}`);

// ID estable del dispositivo: en la APK el nativo lo persiste (mismo ID que
// usa el worker en segundo plano); en web/PWA se guarda en localStorage.
export function deviceId() {
  try {
    const b = bridge();
    if (b && b.getPlatformInfo) {
      const info = b.getPlatformInfo();
      if (info && info.deviceId) return info.deviceId;
    }
  } catch (_) { /* sin bridge */ }
  try {
    let id = localStorage.getItem('vyneural_device_id');
    if (!id) {
      id =
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
      localStorage.setItem('vyneural_device_id', id);
    }
    return id;
  } catch (_) {
    return `web-${Date.now().toString(36)}`;
  }
}

function bridge() {
  if (typeof window === 'undefined') return null;
  const w = window.AndroidBridge;
  if (w && typeof w.postMessage === 'function') return w;
  return typeof window.AndroidBridgeNative !== 'undefined' ? window.AndroidBridgeNative : null;
}

// Estado real de este dispositivo (sin adivinar): la APK reporta el permiso
// nativo vía bridge; la web, Notification.permission + suscripción push.
export function collectDeviceInfo() {
  let platform = 'web';
  let appVersion = null;
  let permission = 'not_requested';
  let pushEnabled = false;
  try {
    if (isStandalone()) platform = 'pwa';
  } catch (_) { /* display-mode no disponible */ }
  const b = bridge();
  if (b) {
    platform = 'apk';
    let info = null;
    try {
      info = b.getPlatformInfo ? b.getPlatformInfo() : null;
      if (typeof info === 'string') info = JSON.parse(info);
    } catch (_) { info = null; }
    appVersion = (info && info.appVersion) || null;
    // El bridge nativo expone PermissionManager.notificationState() en
    // MAYÚSCULAS ("GRANTED"/"DENIED"/...) — el backend solo acepta minúsculas
    // (ver devices.py, pattern del schema) y rechazaba este PUT con 422 en
    // silencio (esta función está pensada para nunca romper la UI si el
    // backend falla), así que el estado de permiso nunca se actualizaba acá.
    permission = ((info && info.notificationPermission) || 'unavailable').toLowerCase();
    pushEnabled = permission === 'granted';
  } else {
    try {
      permission = typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';
    } catch (_) { permission = 'unavailable'; }
    pushEnabled = permission === 'granted';
  }
  return {
    device_id: deviceId(),
    platform,
    app_version: appVersion,
    notification_permission: permission,
    push_enabled: pushEnabled,
    user_agent: (typeof navigator !== 'undefined' ? navigator.userAgent : '').slice(0, 500),
  };
}

// Reporta este dispositivo al backend. Nunca lanza: si falla, se ignora.
export async function reportDevice() {
  try {
    await put('/api/v1/devices/me', collectDeviceInfo());
  } catch (_) { /* aditivo: sin backend no pasa nada */ }
}
