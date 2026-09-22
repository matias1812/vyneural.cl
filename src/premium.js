// src/premium.js
// Página /premium — planes pagos (Webpay/Transbank, SOLO web). Los presets
// del generador siguen gratis sin cuenta; esto es aditivo y requiere sesión
// (el plan se ata a un usuario). Ver backvyneural/backend/app/routers/
// payments.py para el flujo completo del lado del servidor.

import './style.css';
import { getAccessToken } from './api/client.js';
import {
  listPlans,
  createPayment,
  inscribeOneclick,
  premiumStatus,
  oneclickStatus,
  verifyGooglePlayPurchase,
  GOOGLE_PLAY_PRODUCT_IDS,
} from './api/billing.js';
import { detectNativeBridge, startPlayPurchase } from './platform/native-bridge.js';
import { initStarfield } from './starfield.js';
import { confirmModal, notifyModal } from './ui/confirm-modal.js';

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

// Mensual/Anual se renuevan solos por default desde el primer pago (Oneclick
// Mall, tarjeta guardada) — ya no es un paso aparte que se activa "después"
// desde /cuenta. Se cancela cuando quieras, desde ahí mismo, sin perder lo
// que ya está pagado (ver buyPlan()).
const REASSURANCE = {
  monthly: 'Se renueva solo cada 30 días — cancelás cuando quieras desde tu cuenta.',
  annual: 'Se renueva solo cada año — cancelás cuando quieras desde tu cuenta.',
  lifetime: 'Un pago único. No se renueva porque no vence nunca.',
};

const PLAN_ORDER = ['monthly', 'annual', 'lifetime'];

// Ítems cortos a propósito (una sola línea) — el resto ya está explicado en
// el copy del hero de la página.
const FEATURES = ['Frecuencias personalizadas', 'Alarmas ilimitadas', 'Itinerarios completos', 'Presets especiales (Schumann, 963 Hz · Divino)'];

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

// Un cold start de Render (free tier) puede tardar minutos, no solo los
// ~20-50s "típicos" — se reusa para cualquier llamada que no pueda darse el
// lujo de fallar al primer intento: cargar la página (loadContentOnBoot) y,
// más crítico todavía, confirmar una compra de Google Play que YA se hizo
// del lado de Google (ver buyPlan → verifyGooglePlayPurchase) — si esa
// verificación se rinde después de un solo intento, la compra queda
// "comprada pero nunca confirmada" hasta que Google la revierte sola por
// falta de acknowledge (bug real visto en vivo probando la APK).
const RETRY_DELAYS_MS = [
  3000, 6000, 12000, 20000, // ~41s — cold start "típico"
  30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, // +270s — cold start largo
]; // ~5m11s de cobertura total

// Compra de Google Play completada pero todavía no confirmada con nuestro
// backend — sobrevive un reload/relogin de la página (sessionStorage, no
// memoria) para que resumePendingGooglePlayPurchase() la retome sola en vez
// de perderla si el usuario cierra el modal de error o recarga. Es el camino
// rápido/interactivo; la reconciliación server-side por RTDN (ver
// routers/payments.py::google_play_rtdn) es la red de seguridad de fondo si
// ni esto alcanza (app cerrada del todo, sessionStorage perdido, etc.).
const PENDING_GP_PURCHASE_KEY = 'vyneural_pending_google_play_purchase';

function savePendingGooglePlayPurchase(purchaseToken, productId) {
  try {
    sessionStorage.setItem(PENDING_GP_PURCHASE_KEY, JSON.stringify({ purchaseToken, productId }));
  } catch (_) {
    /* sin sessionStorage: no hay dónde guardar el pendiente, se pierde el camino rápido (queda RTDN) */
  }
}

function loadPendingGooglePlayPurchase() {
  try {
    const raw = sessionStorage.getItem(PENDING_GP_PURCHASE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearPendingGooglePlayPurchase() {
  try {
    sessionStorage.removeItem(PENDING_GP_PURCHASE_KEY);
  } catch (_) {
    /* sin sessionStorage */
  }
}

// Reintenta verifyGooglePlayPurchase con el mismo backoff que loadContentOnBoot
// (RETRY_DELAYS_MS) — PERO a diferencia de un cold start (transitorio, vale
// la pena esperar), un 401 que sobrevive el refresh automático de client.js
// significa sesión REALMENTE muerta: reintentar el mismo request no cambia
// nada, solo quema los ~5 minutos de presupuesto mostrando "confirmando…"
// mientras la ventana real que tiene Google antes de auto-cancelar la compra
// por falta de acknowledge (confirmado en vivo: minutos, no los 3 días
// documentados) se cierra sola. Por eso corta apenas detecta UNAUTHORIZED en
// vez de agotar el loop — y guarda el pendiente para reintentar apenas haya
// sesión de nuevo (ver resumePendingGooglePlayPurchase).
async function verifyGooglePlayPurchaseWithRetry(purchaseToken, productId, onAttempt) {
  for (let attempt = 0; ; attempt++) {
    if (onAttempt) onAttempt(attempt);
    try {
      await verifyGooglePlayPurchase(purchaseToken, productId);
      clearPendingGooglePlayPurchase();
      return { ok: true };
    } catch (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        savePendingGooglePlayPurchase(purchaseToken, productId);
        return { ok: false, sessionExpired: true };
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        savePendingGooglePlayPurchase(purchaseToken, productId);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return { ok: false, sessionExpired: false };
    }
  }
}

// Se llama al cargar /premium con sesión, y de nuevo apenas se loguea (ver
// init()) — retoma sola una compra que quedó pendiente sin que el usuario
// tenga que volver a tocar "Comprar" (que además, sin recuperación de compra
// huérfana del lado Kotlin en este build, podría ni abrir el diálogo de Play
// de nuevo). Silenciosa mientras reintenta (no hay botón que actualizar acá);
// solo se anuncia el resultado final.
let resumingPendingPurchase = false;
async function resumePendingGooglePlayPurchase() {
  if (resumingPendingPurchase || !getAccessToken()) return;
  const pending = loadPendingGooglePlayPurchase();
  if (!pending) return;
  resumingPendingPurchase = true;
  try {
    const result = await verifyGooglePlayPurchaseWithRetry(pending.purchaseToken, pending.productId);
    if (result.ok) {
      await loadContent();
      await notifyModal({ title: '¡Listo!', text: 'Tu compra se confirmó — ya tenés Premium.' });
    } else if (!result.sessionExpired) {
      showError('Tu compra en Google Play se realizó pero no pudimos confirmarla todavía — volvé a intentarlo en un rato, se recupera sola.');
    }
    // sessionExpired de nuevo: ya se guardó el pendiente otra vez, se
    // reintenta en el próximo login — no hace falta abrir el modal de auth
    // acá (este código corre justo DESPUÉS de un login, sería confuso pedir
    // loguearse de nuevo en el instante siguiente).
  } finally {
    resumingPendingPurchase = false;
  }
}

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

function renderPlans(plans, status, oneclick) {
  const wrap = $('premium-plans');
  if (!wrap) return;
  wrap.innerHTML = '';
  // De por vida no vence: no hay plan al que "renovar" ni nada que comprar
  // de nuevo (el backend también lo rechaza — ver POST /payments/create —
  // esto es solo para no ofrecer un botón que sabemos que va a fallar).
  const lifetimeActive = !!(status && status.premium_lifetime);
  // La tarjeta del plan que YA está auto-renovando queda sin botón
  // clickeable — nada de volver a llamar inscribeOneclick() para un plan
  // que no cambió. Antes esto se podía disparar con un click de más (o una
  // recarga reintentando el POST) y borraba la auto-renovación que ya
  // funcionaba, dejando una inscripción "pending" huérfana (bug real visto
  // en vivo: ver también el 409 espejo en payments.py::oneclick_inscribe).
  const activePlanKey = oneclick && oneclick.active ? oneclick.plan : null;
  let rendered = 0;
  for (const key of PLAN_ORDER) {
    const plan = plans[key];
    if (!plan) continue;
    rendered++;
    const info = PLAN_LABELS[key];
    const pitch = pricingPitch(key, plans);
    const featured = key === FEATURED_PLAN;
    const isActiveAutoRenew = key === activePlanKey;
    const card = document.createElement('div');
    card.className = `page-card premium-plan premium-plan-${key}${featured ? ' premium-plan-featured' : ''}`;
    const priceLine = plan.days
      ? `${clp.format(plan.amount)} <span class="cuenta-meta">/ ${plan.days === 365 ? 'año' : plan.days + ' días'}</span>`
      : `${clp.format(plan.amount)} <span class="cuenta-meta">pago único</span>`;
    const cardLabel = oneclick && oneclick.card_type && oneclick.card_last_digits
      ? `${oneclick.card_type} •••• ${oneclick.card_last_digits}`
      : 'tarjeta guardada';
    let buttonHTML;
    if (lifetimeActive) {
      buttonHTML = `
        <button type="button" class="cuenta-btn" disabled>Ya la tenés</button>
        <p class="premium-reassurance">${REASSURANCE[key]}</p>
      `;
    } else if (isActiveAutoRenew) {
      buttonHTML = `
        <button type="button" class="cuenta-btn" disabled>${ICONS.checkCircle} Auto-renovación activa</button>
        <p class="premium-reassurance">${cardLabel} — <a href="/cuenta">gestionar o cancelar</a></p>
      `;
    } else {
      buttonHTML = `
        <button type="button" class="cuenta-btn" data-plan="${key}">
          ${status && status.is_premium ? 'Renovar' : 'Comprar'}
        </button>
        <p class="premium-reassurance">${REASSURANCE[key]}</p>
      `;
    }
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
      ${buttonHTML}
    `;
    wrap.appendChild(card);
  }
  // Defensivo: si el backend alguna vez devuelve un shape que no calza con
  // ningún key de PLAN_ORDER, la grilla no debe quedar en blanco sin
  // explicación — mismo mensaje que el catch de loadContent().
  if (rendered === 0) {
    wrap.innerHTML = '<p class="cuenta-empty">No pudimos cargar los planes ahora. Reintentá en unos segundos.</p>';
    return;
  }
  wrap.querySelectorAll('button[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => buyPlan(btn.dataset.plan, btn, activePlanKey));
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

async function buyPlan(plan, btn, activePlanKey) {
  // Los planes se ven sin sesión (marketing/SEO), pero comprar sí la
  // requiere: el plan se ata a un usuario. En vez de dejar que el POST al
  // backend falle con 401, abrimos el login acá mismo, antes de tocar la red.
  if (!getAccessToken()) {
    openAuth('login');
    return;
  }
  // Ya hay otro plan auto-renovando (ej. Mensual) y se está por pisar con
  // este (ej. Anual) — a diferencia de re-elegir el MISMO plan (esa tarjeta
  // ni siquiera tiene botón clickeable, ver renderPlans), esto sí cambia el
  // plan de verdad, así que se confirma antes de tocar la red (mismo
  // criterio que cancelOneclick() en /cuenta). Con la tarjeta ya guardada
  // esto NO vuelve a pedirla — ver inscribeOneclick() más abajo.
  if (activePlanKey && activePlanKey !== plan && plan !== 'lifetime') {
    const fromLabel = PLAN_LABELS[activePlanKey]?.title || activePlanKey;
    const toLabel = PLAN_LABELS[plan]?.title || plan;
    const ok = await confirmModal({
      title: 'Cambiar de plan',
      text: `Esto va a cambiar tu auto-renovación de ${fromLabel} a ${toLabel} — se usa la misma tarjeta guardada, no hace falta ingresarla de nuevo.`,
      confirmLabel: 'Cambiar plan',
    });
    if (!ok) return;
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
    // Android: Play exige su propio medio de pago para contenido digital
    // dentro de la app (Webpay/Oneclick quedan 100% web) — ver
    // platform/native-bridge.js::startPlayPurchase y billing/google_play.py
    // del lado backend. Reemplaza TODO el flujo de abajo, nunca lo mezcla.
    if (detectNativeBridge()?.platform === 'android') {
      const productId = GOOGLE_PLAY_PRODUCT_IDS[plan];
      const purchase = await startPlayPurchase(productId, plan !== 'lifetime');
      if (purchase.cancelled) {
        // El usuario cerró el flujo de Play sin comprar — no es un error,
        // simplemente vuelve a como estaba (mismo criterio que cerrar el
        // formulario de Webpay sin pagar).
        clearTimeout(timer);
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      if (purchase.error) throw new Error(purchase.error);
      // El backend es quien de verdad otorga Premium, recién después de
      // verificar ESE purchaseToken contra Google (nunca se confía en que
      // Play "dijo que sí" del lado cliente). A esta altura la compra YA
      // pasó en Google (hay purchaseToken real) — si esta llamada falla al
      // primer intento (típicamente un cold start de Render) NO hay que
      // rendirse: la compra queda "hecha pero no confirmada" hasta que
      // Google la revierte sola por falta de acknowledge (bug real visto en
      // vivo probando la APK — dos compras de prueba canceladas así).
      clearTimeout(timer);
      const verifyResult = await verifyGooglePlayPurchaseWithRetry(
        purchase.purchaseToken,
        purchase.productId,
        (attempt) => {
          btn.textContent =
            attempt === 0
              ? 'Confirmando tu compra…'
              : 'Confirmando tu compra con Google… puede tardar unos minutos';
        },
      );
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (verifyResult.sessionExpired) {
        // La compra en Google Play YA se hizo — lo que murió es la sesión.
        // Reintentar el mismo request no lo arregla (client.js ya intentó
        // refrescar el token solo y no pudo) — hay que loguearse de nuevo
        // YA: Google puede auto-cancelar la compra en unos minutos si no la
        // confirmamos (confirmado en vivo, no son los 3 días documentados).
        // El purchaseToken ya quedó guardado (verifyGooglePlayPurchaseWithRetry)
        // — al loguear de nuevo, resumePendingGooglePlayPurchase() la retoma
        // sola, sin que haga falta tocar "Comprar" otra vez.
        showError('Tu compra en Google Play se realizó pero tu sesión expiró. Iniciá sesión de nuevo AHORA — Google puede cancelar la compra en unos minutos si no la confirmamos.');
        openAuth('login');
        return;
      }
      if (!verifyResult.ok) {
        // Se agotaron los reintentos (~5 minutos) — a esta altura NO hay que
        // mostrar el error genérico de "no pudimos iniciar el pago": sería
        // mentira, la compra en Google Play ya se hizo de verdad. El
        // purchaseToken quedó guardado — el próximo load de /premium
        // (resumePendingGooglePlayPurchase) o un nuevo Comprar() (recupera
        // la huérfana, ver PlayBillingManager.kt) la retoman solos.
        showError('Tu compra en Google Play se realizó pero no pudimos confirmarla todavía — volvé a intentarlo en un rato, se recupera sola.');
        return;
      }
      await loadContent(); // refresca el estado (banner de Premium activo) in-place
      await notifyModal({
        title: '¡Listo!',
        text: 'Tu compra se confirmó — ya tenés Premium.',
      });
      return;
    }
    // De por vida es pago único (Webpay Plus, nada que auto-renovar).
    // Mensual/Anual entran directo por Oneclick Mall: la auto-renovación es
    // el default desde el primer pago, no un paso aparte que se activa
    // "después" desde /cuenta (ver oneclick_finish, que cobra el primer
    // período de una si el usuario no tiene Premium vigente todavía).
    if (plan === 'lifetime') {
      const { url, token } = await createPayment(plan);
      // Transbank exige un POST real del navegador con token_ws — no un
      // fetch ni un simple location.href (ver docs del flujo Webpay Plus).
      const form = $('webpay-form');
      form.action = url;
      $('webpay-token').value = token;
      form.submit();
    } else {
      const result = await inscribeOneclick(plan);
      if (result.switched) {
        // Ya había una tarjeta activa — el backend cambió el plan directo,
        // sin pedir nada nuevo a Transbank (ver payments.py::
        // oneclick_inscribe). No hay redirect real: se simula el mismo
        // destino que usa el flujo normal, para reusar una sola pantalla de
        // resultado en vez de inventar un estado de éxito aparte acá.
        window.location.href = '/oneclick-retorno?status=plan_switched';
        return;
      }
      const form = $('oneclick-form');
      form.action = result.url;
      $('oneclick-token').value = result.token;
      form.submit();
    }
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

// Devuelve true si vale la pena reintentar (ver loadContentOnBoot): solo
// para fallas transitorias (red caída / backend dormido, status 0 o 5xx),
// no para errores reales del servidor. status/oneclick ya tienen su propio
// .catch(() => null) — solo listPlans() puede tirar acá, y es la única
// pieza que de verdad bloquea la página (sin precios no hay nada que
// mostrar; sin status/oneclick igual se puede comprar).
async function loadContent() {
  // status/oneclick son endpoints autenticados — sin token ni siquiera se
  // piden (null directamente, mismo resultado que su .catch de abajo). Antes
  // se llamaban siempre, sesión o no: para alguien sin cuenta, el 401
  // dispara el flujo de refresh de client.js, que al fallar (no hay sesión
  // que refrescar) despacha 'vyneural:auth' (logout) — y ese evento está
  // escuchado acá mismo (ver init()) para volver a llamar loadContent(),
  // que vuelve a pedir status/oneclick sin token, 401 de nuevo, nuevo
  // despacho... un loop infinito en caliente (bug real visto en vivo: los
  // planes "aparecían y desaparecían" sin parar para cualquier visitante
  // sin sesión, la página más importante para conversión).
  const hasSession = !!getAccessToken();
  const [plansResult, status, oneclick] = await Promise.all([
    listPlans()
      .then((r) => ({ ok: true, plans: r.plans }))
      .catch((err) => ({ ok: false, err })),
    hasSession ? premiumStatus().catch(() => null) : Promise.resolve(null),
    hasSession ? oneclickStatus().catch(() => null) : Promise.resolve(null),
  ]);
  if (status) renderActiveBanner(status);
  if (plansResult.ok) {
    renderPlans(plansResult.plans, status, oneclick);
    return false;
  }
  const wrap = $('premium-plans');
  if (wrap) wrap.innerHTML = '<p class="cuenta-empty">No pudimos cargar los planes ahora. Reintentá en unos segundos.</p>';
  const err = plansResult.err;
  return !!(err && (err.status === 0 || err.status >= 500));
}

// Mismo patrón que src/cuenta.js::loadAllOnBoot() (y src/ui/auth.js): sin
// reintento automático, la página quedaba con el mensaje de error hasta que
// el usuario recargara a mano.
async function loadContentOnBoot() {
  for (let attempt = 0; ; attempt++) {
    const needsRetry = await loadContent();
    if (!needsRetry || attempt >= RETRY_DELAYS_MS.length) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

function renderGate({ retryOnBoot = false } = {}) {
  // Los planes son la mejor vidriera de Premium: se muestran siempre, con o
  // sin sesión (antes quedaban ocultos detrás de un login-wall, lo que le
  // restaba conversión y SEO a la página que más vende). Lo único que de
  // verdad requiere cuenta es la compra en sí — eso se resuelve en
  // buyPlan(), no acá.
  const gate = $('premium-gate');
  const loggedIn = !!getAccessToken();
  if (gate) gate.classList.toggle('hidden', loggedIn);
  if (retryOnBoot) loadContentOnBoot();
  else loadContent();
}

function init() {
  renderGate({ retryOnBoot: true });
  resumePendingGooglePlayPurchase();
  const loginBtn = $('premium-login-btn');
  const regBtn = $('premium-register-btn');
  if (loginBtn) loginBtn.addEventListener('click', () => openAuth('login'));
  if (regBtn) regBtn.addEventListener('click', () => openAuth('register'));
  document.addEventListener('vyneural:auth', (e) => {
    renderGate();
    if (e.detail && e.detail.type === 'login') resumePendingGooglePlayPurchase();
  });
}

document.addEventListener('DOMContentLoaded', init, { once: true });
