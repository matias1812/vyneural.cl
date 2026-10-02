// src/api/auth.js
// Autenticación contra el backend Vyneural. Aditivo: sin backend la app
// funciona igual (todo local).

import { post, patch, get, cachedGet, clearSession, storeSession } from './client.js';

export async function register({ email, password, username, display_name, coupon_code }) {
  const session = await post('/api/v1/auth/register', {
    email,
    password,
    username,
    display_name,
    coupon_code,
  });
  storeSession(session);
  return session;
}

// Primer factor. El backend devuelve DOS formas posibles (ver
// backvyneural/backend/app/routers/auth.py::login):
//
//  - sin 2FA → { access_token, refresh_token, ... } → se guarda la sesión.
//  - con 2FA → { requires_totp: true, challenge_token, expires_in } → NO hay
//    sesión todavía; hay que completar con verifyTotpLogin().
//
// El chequeo de `requires_totp` es obligatorio ANTES de storeSession(): sin
// él, storeSession guardaría `undefined` en localStorage (literalmente el
// string "undefined" como refresh token), dejando la sesión en un estado
// corrupto que ningún refresh posterior puede arreglar.
export async function login({ email, password }) {
  const result = await post('/api/v1/auth/login', { email, password });
  if (result && result.requires_totp) return result;
  storeSession(result);
  return result;
}

// Segundo factor. `code` es el TOTP de 6 dígitos; alternativamente
// `recovery_code` es uno de los códigos de recuperación de un solo uso.
// Recién acá nace la sesión real.
export async function verifyTotpLogin({ challenge_token, code, recovery_code }) {
  const session = await post('/api/v1/auth/login/verify-totp', {
    challenge_token,
    code: code || undefined,
    recovery_code: recovery_code || undefined,
  });
  storeSession(session);
  return session;
}

// ── Verificación en dos pasos (2FA / TOTP), gestión desde /cuenta ───────────
// Backend: backvyneural/backend/app/routers/totp.py.

// Paso 1: genera el secreto y devuelve el otpauth:// para el QR. NO activa
// nada todavía (totp_enabled sigue en false hasta confirmar).
export async function enrollTotp() {
  return post('/api/v1/auth/2fa/enroll');
}

// Paso 2: valida un código del secreto pendiente y ACTIVA el 2FA. Devuelve
// los códigos de recuperación en texto plano — la única vez que existen.
export async function confirmTotp(code) {
  return post('/api/v1/auth/2fa/confirm', { code });
}

// Desactiva el 2FA: contraseña actual + segundo factor (código TOTP o uno de
// recuperación sin usar). Borra el secreto y todos los códigos.
export async function disableTotp({ password, code, recovery_code }) {
  return post('/api/v1/auth/2fa/disable', {
    password,
    code: code || undefined,
    recovery_code: recovery_code || undefined,
  });
}

// Set nuevo de códigos de recuperación; los viejos quedan inválidos al toque.
export async function regenerateRecoveryCodes(password) {
  return post('/api/v1/auth/2fa/recovery-codes/regenerate', { password });
}

export async function logout() {
  try {
    const refreshToken = localStorage.getItem('vyneural_refresh_token');
    if (refreshToken) await post('/api/v1/auth/logout', { refresh_token: refreshToken });
  } catch (_) {
    /* sin conexión: la sesión local se limpia igualmente */
  } finally {
    clearSession();
  }
}

export async function me() {
  return cachedGet('/api/v1/auth/me');
}

export async function verifyEmail(token) {
  return post('/api/v1/auth/verify-email', { token });
}

export async function resendVerification() {
  return post('/api/v1/auth/resend-verification');
}

export async function forgotPassword(email) {
  return post('/api/v1/auth/forgot-password', { email });
}

export async function resetPassword(token, password) {
  return post('/api/v1/auth/reset-password', { token, password });
}

export async function changePassword(currentPassword, newPassword) {
  return post('/api/v1/users/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

// Auto-edición del propio perfil (self-service, /cuenta) — display_name y/o
// email. `current_password` solo hace falta cuando `email` cambia de verdad
// (routers/users.py::update_profile exige re-auth en ese caso, igual que
// changePassword/deleteAccount); mandarla de más cuando no cambia el email
// no rompe nada del lado del backend, pero cuenta.js solo la incluye cuando
// corresponde para no pedirle la contraseña al usuario sin motivo.
export async function updateProfile({ display_name, email, current_password } = {}) {
  return patch('/api/v1/users/me', { display_name, email, current_password });
}

// Borra la cuenta y TODOS los datos asociados (backend: DELETE del User,
// cascadea alarmas/itinerarios/frecuencias/pagos/dispositivos/comentarios —
// ver routers/users.py::delete_account). Irreversible, no hay "deshacer".
// Limpia la sesión local al confirmar: el access token vigente ya no
// serviría para nada de todos modos.
export async function deleteAccount(password) {
  const result = await post('/api/v1/users/me/delete', { password });
  clearSession();
  return result;
}

// Portabilidad de datos (Ley 21.719): todo lo que el backend tiene de esta
// cuenta, en JSON. Contracara de deleteAccount — ver
// backvyneural/backend/app/routers/users.py::export_my_data.
export async function exportMyData() {
  return get('/api/v1/users/me/export');
}
