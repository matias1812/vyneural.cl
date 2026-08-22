import './site.css';
import './report-bug.js';
import './ui/auth.js';
import { initPermissionsModal, openPermissions } from './ui/permissions-modal.js';
import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

// Web Analytics de Vercel: métricas de visitas sin cookies ni rastreo
// entre sitios (respeta bloqueadores y el modo privado).
inject();

// Speed Insights de Vercel: métricas reales de rendimiento (Core Web Vitals)
// recogidas de los visitantes reales.
injectSpeedInsights();

// ── Dentro de la APK (WebView nativa) ───────────────────────────────────────
// La web empaquetada dentro de la app corre sobre file:// y el shell inyecta
// AndroidBridgeNative. Ahí no tiene sentido "instalar la APK": la vista de
// descarga/instalación se oculta (CSS) y la tarjeta se reemplaza por un aviso.
const IN_APP =
  typeof window !== 'undefined' &&
  (typeof window.AndroidBridgeNative !== 'undefined' || location.protocol === 'file:');
if (IN_APP) document.documentElement.classList.add('in-app');

// Dentro de la app instalada, la tarjeta de descarga se convierte en un aviso
// de que la aplicación ya está en uso (sin botón de instalar). El botón del
// hero "Descargar APK" se oculta por CSS (.in-app .hero-cta-download).
if (IN_APP) {
  const card = document.querySelector('.download-card');
  if (card) {
    card.innerHTML = `
      <h2>Ya estás usando Vyneural</h2>
      <p class="download-meta">La app está instalada en este dispositivo y funciona sin conexión.</p>
      <p>
        Esta vista es para instalar la aplicación desde el navegador. Desde acá podés
        explorar el <a href="/codigo-abierto">código abierto</a> o volver al
        <a href="/">generador</a>.
      </p>
    `;
  }
}

// ---------------------------------------------------------------- Nav móvil
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.getElementById('site-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.innerHTML = open ? '✕' : '☰';
  });
  // Cerrar el menú al pulsar un enlace.
  navLinks.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      navLinks.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
      navToggle.innerHTML = '☰';
    }
  });
}

// ---------------------------------------------------------------- Año del footer
document.querySelectorAll('[data-year]').forEach((el) => {
  el.textContent = String(new Date().getFullYear());
});

// ---------------------------------------------------------------- Service worker (PWA)
// Registro el SW en TODAS las páginas (antes solo vivía en main.js, la home):
// entrar directo a /cuenta (o cualquier página) sin pasar por la home dejaba
// el push sin service worker → "no se pudo activar". Solo en producción y
// sobre http/https (dentro de la APK la página vive en file://, sin SW).
if (
  'serviceWorker' in navigator &&
  /^https?:$/.test(location.protocol) &&
  location.hostname !== 'localhost'
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------------------------------------------------------------- Badge de plataforma
// Diferencia honesta WEB / PWA / APK en TODAS las páginas. Antes el badge
// solo lo manejaban main.js (home) y diagnostico.js, y en navegador normal
// quedaba oculto: ahora se muestra "WEB" también y corre acá, compartido.
function updatePlatformBadge() {
  const badge = document.getElementById('platform-badge');
  if (!badge) return;
  const bridge =
    typeof window !== 'undefined' &&
    (typeof window.AndroidBridge !== 'undefined' || typeof window.AndroidBridgeNative !== 'undefined');
  const standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  badge.classList.remove('hidden', 'pwa', 'web');
  if (bridge) {
    badge.textContent = 'APK';
  } else if (standalone) {
    badge.textContent = 'PWA';
    badge.classList.add('pwa');
  } else {
    badge.textContent = '.cl';
    badge.classList.add('web');
  }
}
updatePlatformBadge();
// Reintentos: el bridge nativo se inyecta en onPageFinished, después de que
// site.js corre (igual patrón que main.js / diagnostico.js).
setTimeout(updatePlatformBadge, 1000);
setTimeout(updatePlatformBadge, 3000);

// ---------------------------------------------------------------- Navegación compartida
// "Preguntas frecuentes" y "Mi cuenta" se agregan al footer de todas las
// páginas desde acá, para no duplicarlos en cada HTML. Ya NO se agregan al
// nav (.site-links): "Preguntas frecuentes"/FAQ vive solo en el menú de
// cuenta (⋯ junto al avatar, ver src/ui/auth.js) — repetirlo acá era ruido.
const sharedFaq = '<a href="/preguntas-frecuentes">Preguntas frecuentes</a>';
document.querySelectorAll('.footer-col h3').forEach((h3) => {
  const title = (h3.textContent || '').trim().toLowerCase();
  const col = h3.parentElement;
  if (title === 'sitio') {
    col.insertAdjacentHTML('afterbegin', sharedFaq + '<a href="/cuenta">Mi cuenta</a>');
  }
});

// ---------------------------------------------------------------- Resaltar la página actual
const here = window.location.pathname.replace(/\/+$/, '') || '/';
const page = here === '/' ? '/' : here.replace(/^\//, '').replace(/\.html$/, '');
document.querySelectorAll('.site-links a').forEach((a) => {
  const href = a.getAttribute('href');
  const target = href === '/' ? '/' : href.replace(/^\//, '').replace(/\.html$/, '');
  if (target === page || (page && target && target !== '/' && page.startsWith(target))) {
    a.setAttribute('aria-current', 'page');
  }
});

// ---------------------------------------------------------------- Permisos de la web
// El reproductor ("/") ya trae su propia copia más rica del modal (main.js —
// liga Wake Lock/Media Session al estado real de reproducción); en
// cualquier otra página se inyecta esta versión autocontenida, así el
// dropdown de cuenta (ver ui/auth.js) puede abrirlo ahí mismo en vez de
// navegar a "/".
if (here !== '/') {
  initPermissionsModal();
  if (location.hash === '#permisos') {
    history.replaceState(null, '', location.pathname + location.search);
    openPermissions();
  }
}

// ---------------------------------------------------------------- Scrollspy
// En la home, resalta en la nav el enlace de la sección visible
// (#estados / #como-funciona) mientras el usuario hace scroll.
const spySections = ['estados', 'como-funciona']
  .map((id) => document.getElementById(id))
  .filter(Boolean);
const spyLinks = [...document.querySelectorAll('.site-links a[href="#estados"], .site-links a[href="#como-funciona"]')];
if (spySections.length && spyLinks.length && 'IntersectionObserver' in window) {
  const spyObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id;
        spyLinks.forEach((a) => {
          const on = a.getAttribute('href') === '#' + id;
          a.classList.toggle('active', on);
          if (on) a.setAttribute('aria-current', 'true');
          else if (a.getAttribute('aria-current') === 'true') a.removeAttribute('aria-current');
        });
      });
    },
    { rootMargin: '-40% 0px -55% 0px' },
  );
  spySections.forEach((s) => spyObserver.observe(s));
}

// ---------------------------------------------------------------- Aviso de cookies
// La app no usa cookies de seguimiento: solo almacenamiento local del
// navegador (preferencias, sesiones, historial y recordatorios). Igual se
// muestra un aviso en la primera visita, se guarda la elección y se puede
// volver a abrir desde el footer ("Gestionar cookies").
const COOKIE_CONSENT_KEY = 'vyneural-cookie-consent';
const cookieBanner = document.getElementById('cookie-banner');
function showCookieBanner() {
  if (!cookieBanner) return;
  cookieBanner.classList.remove('hidden');
}
function hideCookieBanner(choice) {
  if (!cookieBanner) return;
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, choice);
  } catch {
    /* sin almacenamiento disponible */
  }
  cookieBanner.classList.add('hidden');
}
if (cookieBanner) {
  try {
    if (!localStorage.getItem(COOKIE_CONSENT_KEY)) {
      // Pequeña espera para no interrumpir el arranque de la app.
      window.setTimeout(showCookieBanner, 900);
    }
  } catch {
    /* sin almacenamiento: no mostrar el aviso */
  }
  const cookieAccept = document.getElementById('cookie-accept');
  const cookieReject = document.getElementById('cookie-reject');
  if (cookieAccept) cookieAccept.addEventListener('click', () => hideCookieBanner('accepted'));
  if (cookieReject) cookieReject.addEventListener('click', () => hideCookieBanner('rejected'));
  // "Gestionar cookies" en el footer: volver a mostrar el aviso para que el
  // usuario pueda revisar o cambiar su elección.
  const cookieManage = document.getElementById('cookie-manage');
  if (cookieManage) {
    cookieManage.addEventListener('click', (e) => {
      e.preventDefault();
      showCookieBanner();
      cookieBanner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const first = cookieBanner.querySelector('button');
      if (first) first.focus();
    });
  }
}
