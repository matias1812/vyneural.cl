// src/api/auth.js
// Autenticación contra el backend Vyneural. Aditivo: sin backend la app
// funciona igual (todo local).

import { post, cachedGet, clearSession, storeSession } from './client.js';

export async function register({ email, password, username, display_name }) {
  const session = await post('/api/v1/auth/register', {
    email,
    password,
    username,
    display_name,
  });
  storeSession(session);
  return session;
}

export async function login({ email, password }) {
  const session = await post('/api/v1/auth/login', { email, password });
  storeSession(session);
  return session;
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

// Desactiva la cuenta (backend: User.is_active=False — bloquea login y
// cualquier request autenticado de ahí en más). No borra datos ni es
// reversible por el propio usuario. Limpia la sesión local al confirmar: el
// access token vigente ya no serviría para nada de todos modos.
export async function deactivateAccount(password) {
  const result = await post('/api/v1/users/me/deactivate', { password });
  clearSession();
  return result;
}
