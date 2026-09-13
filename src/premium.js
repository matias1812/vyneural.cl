// src/premium.js
// Página /premium — planes pagos (Webpay/Transbank, SOLO web). Los presets
// del generador siguen gratis sin cuenta; esto es aditivo y requiere sesión
// (el plan se ata a un usuario). Ver backvyneural/backend/app/routers/
// payments.py para el flujo completo del lado del servidor.

import { getAccessToken } from './api/client.js';
import { listPlans, createPayment, premiumStatus } from './api/billing.js';
import { initStarfield } from './starfield.js';

const $ = (id) => document.getElementById(id);

// Fondo espacial: esta página vende Premium, se gana el mismo viaje cósmico
// que el generador (ver src/starfield.js) en vez del fondo estático plano
// del resto de las páginas de contenido.
const starfield = initStarfield();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Iconos de línea (mismo estilo que el resto del sitio: viewBox 24,
// stroke=currentColor, ver .ico en site.css) — nada de emojis acá, para que
// el color/tamaño responda al CSS de cada tarjeta en vez de depender del
// glifo de emoji del sistema operativo.
const ICO = (paths) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  unlock: ICO('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
  star: ICO(
    '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  ),
  gem: ICO('<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>'),
  flame: ICO(
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  ),
  sparkles: ICO(
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  ),
  rocket: ICO(
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  ),
  checkCircle: ICO('<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>'),
};

const PLAN_LABELS = {
  monthly: { icon: ICONS.unlock, title: 'Mensual', tagline: 'Para probarlo sin compromiso' },
  annual: { icon: ICONS.star, title: 'Anual', tagline: 'El más conveniente si ya lo usás seguido' },
  lifetime: { icon: ICONS.gem, title: 'De por vida', tagline: 'Pagás una vez, no vence nunca' },
};

// Plan destacado visualmente (efecto señuelo clásico: ubicado al centro,
// con badge y borde propio) — decisión de producto, no depende del precio.
const FEATURED_PLAN = 'annual';

const REASSURANCE = {
  monthly: 'Sin compromiso, vence solo (auto-renovación opcional después).',
  annual: 'Pagás vos cuándo querés — o activás auto-renovación después.',
  lifetime: 'Un pago. Nunca más renovar.',
};

const PLAN_ORDER = ['monthly', 'annual', 'lifetime'];

// Ítems cortos a propósito (una sola línea) — el resto ya está explicado en
// el copy del hero de la página.
const FEATURES = ['Frecuencias personalizadas', 'Alarmas ilimitadas', 'Itinerarios completos'];

// Precio mensual equivalente / ahorro — siempre derivado de los precios
// reales que devuelve el backend (nunca hardcodeado), para que la promesa de
// ahorro jamás quede desincronizada de lo que realmente se cobra. `badge` es
// corto a propósito (para que la píldora siga siendo una píldora y no un
// bloque de texto envuelto en 3 líneas con las puntas redondeadas raras);
// `caption` es el detalle de apoyo, en texto plano debajo; `title` es el
// dato completo, como tooltip nativo.
function pricingPitch(key, plans) {
  const monthly = plans.monthly;
  const plan = plans[key];
  if (!monthly || !plan || key === 'monthly') return null;
  if (key === 'annual' && plan.days) {
    const equivMonthly = Math.round(plan.amount / 12);
    const yearlyIfMonthly = monthly.amount * 12;
    const savingsPct = Math.round((1 - plan.amount / yearlyIfMonthly) * 100);
    if (savingsPct <= 0) return null;
    return {
      badge: `Ahorrás ${savingsPct}%`,
      caption: `Equivale a ${clp.format(equivMonthly)}/mes`,
      title: `Pagando mes a mes te saldría ${clp.format(yearlyIfMonthly)} al año.`,
    };
  }
  if (key === 'lifetime') {
    const monthsToPayItself = Math.ceil(plan.amount / monthly.amount);
    return {
      badge: 'Se paga solo',
      caption: `En ${monthsToPayItself} meses de uso`,
      title: `Después de ${monthsToPayItself} meses de plan mensual ya lo pagaste — de ahí en más, gratis para siempre.`,
    };
  }
  return null;
}

const clp = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });

// Espera >4s sin respuesta = probable cold start del backend (Render free) —
// mismo criterio y mismo umbral que src/ui/auth.js.
const WAKEUP_HINT_MS = 4000;

function openAuth(mode) {
  const auth = window.__vyneuralAuth;
  if (auth && typeof auth.open === 'function') auth.open(mode);
}

function showError(msg) {
  const el = $('premium-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function renderActiveBanner(status) {
  const banner = $('premium-active-banner');
  const text = $('premium-active-text');
  if (!banner || !text) return;
  if (status.premium_lifetime) {
    text.innerHTML = `${ICONS.gem} Ya tenés Premium de por vida — no hace falta que compres nada más.`;
    banner.classList.remove('hidden');
    return;
  }
  if (status.is_premium && status.premium_until) {
    const until = new Date(status.premium_until).toLocaleDateString('es-CL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    text.innerHTML = `${ICONS.gem} Tu plan Premium está activo hasta el ${until}. Podés renovarlo cuando quieras.`;
    banner.classList.remove('hidden');
    return;
  }
  banner.classList.add('hidden');
}

function renderPlans(plans, status) {
  const wrap = $('premium-plans');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const key of PLAN_ORDER) {
    const plan = plans[key];
    if (!plan) continue;
    const info = PLAN_LABELS[key];
    const pitch = pricingPitch(key, plans);
    const featured = key === FEATURED_PLAN;
    const card = document.createElement('div');
    card.className = `page-card premium-plan premium-plan-${key}${featured ? ' premium-plan-featured' : ''}`;
    const priceLine = plan.days
      ? `${clp.format(plan.amount)} <span class="cuenta-meta">/ ${plan.days === 365 ? 'año' : plan.days + ' días'}</span>`
      : `${clp.format(plan.amount)} <span class="cuenta-meta">pago único</span>`;
    card.innerHTML = `
      ${featured ? `<span class="premium-plan-badge">${ICONS.flame} Más elegido</span>` : ''}
      ${key === 'monthly' ? `<span class="premium-ship" aria-hidden="true">${ICONS.rocket}</span>` : ''}
      <h3>${info.icon} ${info.title}</h3>
      <p class="rutina-hint">${info.tagline}</p>
      <p class="premium-price">${priceLine}</p>
      ${pitch ? `
        <div class="premium-pitch-row" title="${pitch.title}">
          <span class="premium-pitch">${ICONS.sparkles} ${pitch.badge}</span>
          <span class="premium-pitch-caption">${pitch.caption}</span>
        </div>
      ` : ''}
      <ul class="cuenta-list">
        ${FEATURES.map((f) => `<li>✓ ${f}</li>`).join('')}
      </ul>
      <button type="button" class="cuenta-btn" data-plan="${key}">
        ${status && status.is_premium ? 'Renovar' : 'Comprar'}
      </button>
      <p class="premium-reassurance">${REASSURANCE[key]}</p>
    `;
    wrap.appendChild(card);
  }
  wrap.querySelectorAll('button[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => buyPlan(btn.dataset.plan, btn));
  });

  // Revelado festivo de los planes — una sola vez por carga, no en cada
  // re-render de renderPlans(). Se salta si el sistema pide reducir
  // movimiento (a diferencia del viaje espacial de fondo, que es una
  // decisión de identidad ya tomada — esto es nuevo y puntual, no ambiental).
  if (!reducedMotion && starfield && !renderPlans._celebrated) {
    renderPlans._celebrated = true;
    const rect = wrap.getBoundingClientRect();
    const yFrac = Math.max(0, rect.top / window.innerHeight);
    setTimeout(() => starfield.spawnFireworks(0.28, yFrac + 0.04), 200);
    setTimeout(() => starfield.spawnFireworks(0.72, yFrac + 0.02), 450);
  }
}

async function buyPlan(plan, btn) {
  // Los planes se ven sin sesión (marketing/SEO), pero comprar sí la
  // requiere: el plan se ata a un usuario. En vez de dejar que el POST al
  // backend falle con 401, abrimos el login acá mismo, antes de tocar la red.
  if (!getAccessToken()) {
    openAuth('login');
    return;
  }
  showError(null);
  // Chispa de confirmación al click — breve y disparada por el propio gesto
  // del usuario, no ambiental, así que se muestra siempre (mismo criterio
  // que las estrellas fugaces del viaje espacial).
  if (starfield) {
    const rect = btn.getBoundingClientRect();
    starfield.spawnFireworks(
      (rect.left + rect.width / 2) / window.innerWidth,
      (rect.top + rect.height / 2) / window.innerHeight,
    );
  }
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Conectando…';
  const timer = setTimeout(() => {
    btn.textContent = 'Despertando el servidor… puede tardar unos segundos';
  }, WAKEUP_HINT_MS);
  try {
    const { url, token } = await createPayment(plan);
    // Transbank exige un POST real del navegador con token_ws — no un
    // fetch ni un simple location.href (ver docs del flujo Webpay Plus).
    const form = $('webpay-form');
    form.action = url;
    $('webpay-token').value = token;
    form.submit();
  } catch (err) {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = originalLabel;
    const detail = (err && err.detail) || '';
    showError(
      typeof detail === 'string' && detail
        ? detail
        : 'No pudimos iniciar el pago. Reintentá en unos segundos.',
    );
  }
}

async function loadContent() {
  try {
    const [{ plans }, status] = await Promise.all([listPlans(), premiumStatus().catch(() => null)]);
    if (status) renderActiveBanner(status);
    renderPlans(plans, status);
  } catch (_) {
    const wrap = $('premium-plans');
    if (wrap) wrap.innerHTML = '<p class="cuenta-empty">No pudimos cargar los planes ahora. Reintentá en unos segundos.</p>';
  }
}

function renderGate() {
  // Los planes son la mejor vidriera de Premium: se muestran siempre, con o
  // sin sesión (antes quedaban ocultos detrás de un login-wall, lo que le
  // restaba conversión y SEO a la página que más vende). Lo único que de
  // verdad requiere cuenta es la compra en sí — eso se resuelve en
  // buyPlan(), no acá.
  const gate = $('premium-gate');
  const loggedIn = !!getAccessToken();
  if (gate) gate.classList.toggle('hidden', loggedIn);
  loadContent();
}

function init() {
  renderGate();
  const loginBtn = $('premium-login-btn');
  const regBtn = $('premium-register-btn');
  if (loginBtn) loginBtn.addEventListener('click', () => openAuth('login'));
  if (regBtn) regBtn.addEventListener('click', () => openAuth('register'));
  document.addEventListener('vyneural:auth', renderGate);
}

document.addEventListener('DOMContentLoaded', init, { once: true });
