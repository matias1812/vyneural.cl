// src/ui/premium-gate.js
// Bloqueo compartido para funciones Premium del lado del cliente — hoy: el
// modo "Personalizado" del generador (main.js) y el modal de guardar
// frecuencia de /cuenta (freq-modal.js). Aditivo: sin sesión no cambia nada
// (el gesto de login existente sigue primero), y una falla de red nunca
// bloquea a quien ya pagó (ver isPremiumUser).

import { getAccessToken } from '../api/client.js';
import { premiumStatus } from '../api/billing.js';

let cache = null; // { value, at }
const CACHE_TTL_MS = 30000;

export async function isPremiumUser() {
  if (!getAccessToken()) return false;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const status = await premiumStatus();
    const value = !!(status && status.is_premium);
    cache = { value, at: now };
    return value;
  } catch (_) {
    // Sin conexión o el backend no respondió: no es lo mismo que "no sos
    // premium". Bloquear acá castigaría a alguien que ya pagó por una red
    // caída, para una función que además no le cuesta nada al servidor.
    return true;
  }
}

const GEM_ICON =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>';

function modalHTML() {
  return `
  <div class="auth-modal hidden" id="premium-required-modal" role="dialog" aria-modal="true" aria-label="Función Premium">
    <div class="auth-card">
      <div class="auth-head">
        <span class="auth-logo">${GEM_ICON}</span>
        <div class="auth-title-wrap">
          <h3>Esto es Premium</h3>
          <p id="premium-required-text"></p>
        </div>
        <button type="button" class="auth-close" id="premium-required-close" aria-label="Cerrar">✕</button>
      </div>
      <a href="/premium" class="auth-submit" id="premium-required-cta" style="display:block;text-align:center;text-decoration:none;">Ver planes</a>
    </div>
  </div>`;
}

let injected = false;

function inject() {
  if (injected) return;
  injected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = modalHTML();
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('premium-required-modal');
  const close = () => modal.classList.add('hidden');
  modal.querySelector('#premium-required-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
}

export function openPremiumRequired(message) {
  inject();
  const modal = document.getElementById('premium-required-modal');
  document.getElementById('premium-required-text').textContent = message;
  modal.classList.remove('hidden');
}
