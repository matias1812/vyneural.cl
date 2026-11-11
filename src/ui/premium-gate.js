// src/ui/premium-gate.js
// Bloqueo compartido para funciones Premium del lado del cliente — hoy: el
// modo "Personalizado" y los presets especiales del generador (main.js),
// crear un itinerario nuevo y crear un recordatorio (rutina.js). Guardar
// una frecuencia personalizada ya no tiene una entrada propia en /cuenta:
// se crea desde el generador o desde un paso de itinerario, ambos ya
// gateados acá mismo. Aditivo: sin sesión no cambia nada (el gesto de
// login existente sigue primero), y una falla de red nunca bloquea a
// quien ya pagó (ver isPremiumUser).

import { getAccessToken } from '../api/client.js';
import { listPlans, premiumStatus } from '../api/billing.js';
import { createPremiumOrbit } from './premium-orbit.js';
import './premium-gate.css';

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

// El resultado cacheado pertenece a la sesión/cuenta que estaba activa
// cuando se pidió — un login o logout puede cambiar de cuenta dentro del
// TTL de 30s, así que hay que invalidar explícitamente en cada evento de
// auth para no arrastrar el is_premium de la cuenta anterior.
export function invalidatePremiumCache() {
  cache = null;
}

let offer;

function createOffer() {
  const modal = document.createElement('dialog');
  modal.className = 'premium-offer';
  modal.id = 'premium-required-modal';
  modal.setAttribute('aria-labelledby', 'premium-offer-title');
  modal.setAttribute('aria-describedby', 'premium-required-text');
  modal.innerHTML = `
    <div class="premium-offer-visual" aria-hidden="true"><canvas width="480" height="240" hidden></canvas></div>
    <div class="premium-offer-brand">
      <span class="premium-offer-brand-icon"><img src="${location.protocol === 'file:' ? './icon.svg' : '/icon.svg'}" alt="" width="18" height="18"></span>
      Vyneural
    </div>
    <button type="button" class="premium-offer-close" aria-label="Cerrar oferta" autofocus>✕</button>
    <div class="premium-offer-body">
      <h2 id="premium-offer-title">Tu ritmo, a tu medida.</h2>
      <p id="premium-required-text"></p>
      <p class="premium-offer-benefits">Diseña tus frecuencias, arma rutinas y programa recordatorios.</p>
      <p class="premium-offer-price" data-price hidden></p>
      <a class="premium-offer-cta" href="${location.protocol === 'file:' ? './premium.html' : '/premium'}#plan-monthly">
        Ver el plan mensual <span aria-hidden="true">↗</span>
      </a>
      <p class="premium-offer-terms">Renovación cada 30 días. Cancela cuando quieras desde tu cuenta.</p>
    </div>`;
  const canvas = modal.querySelector('canvas');
  const navbarIcon = document.querySelector('.site-nav .site-brand .brand-ico svg');
  if (navbarIcon) modal.querySelector('.premium-offer-brand-icon').replaceChildren(navbarIcon.cloneNode(true));
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame;
  let draw;

  function stop() {
    cancelAnimationFrame(frame);
    canvas.hidden = true;
  }

  function animate() {
    stop();
    if (!modal.open || motion.matches) return;
    draw ??= createPremiumOrbit(canvas);
    if (!draw || !draw(0)) return;
    canvas.hidden = false;
    const start = performance.now();
    function tick(now) {
      if (!modal.open || !draw((now - start) / 1000)) return stop();
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }

  modal.querySelector('button').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.close();
  });
  modal.addEventListener('close', stop);
  motion.addEventListener('change', animate);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    stop();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    draw = null;
    animate();
  });
  document.body.append(modal);
  return { modal, animate };
}

export function openPremiumRequired(message) {
  offer ??= createOffer();
  const { modal, animate } = offer;
  modal.querySelector('#premium-required-text').textContent = message;
  if (modal.open) return;
  modal.showModal();
  animate();
  const price = modal.querySelector('[data-price]');
  price.hidden = true;
  listPlans().then(({ plans }) => {
    const amount = plans?.monthly?.amount;
    if (!Number.isFinite(amount) || amount <= 0) return;
    const formatted = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount);
    price.textContent = `${formatted} CLP cada 30 días`;
    price.hidden = false;
  }).catch(() => {});
}
