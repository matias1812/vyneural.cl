// src/ui/auth.js
// UI de autenticación contra el backend Vyneural (aditiva y opcional).
//
// - Inyecta en la nav de TODAS las páginas (.site-links) un botón "Iniciar
//   sesión" o, con sesión, un chip con avatar + menú (Mi cuenta / Cerrar
//   sesión).
// - Modal con vistas: login · registro (confirmar clave + términos y
//   condiciones) · olvidé mi contraseña · "revisá tu correo" · "confirmá tu
//   correo" (login bloqueado por verificación pendiente).
// - Validación en cliente espejo del backend: email, contraseña ≥ 8 chars con
//   letras y números, username [a-zA-Z0-9_.-]{3,64}. Mensajes genéricos
//   (no revelan si el email existe), manejo de 429 y 401/403.
// - Sin backend o sin sesión la app funciona igual: este módulo solo actúa
//   cuando el usuario decide iniciar sesión.
//
// API pública:
//   window.__vyneuralAuth = { open(mode), onAuthChange(fn), isLoggedIn(), getProfile(), logout() }
//   document 'vyneural:auth' → CustomEvent { type: 'login'|'register'|'logout' }

import { login, register, logout, me, verifyEmail, resendVerification, forgotPassword } from '../api/auth.js';
import { getAccessToken, clearSession } from '../api/client.js';
import { subscribeToPush, pushStatus } from '../api/push.js';
import { initBackendIfConfigured } from '../api/integration.js';
import { pullCloudFavoritesToLocal } from '../api/fav-sync.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,64}$/;

let profile = null; // { id, email, username, display_name, email_verified, created_at }
const listeners = new Set();
let modalRoot = null;
let view = 'login'; // login | register | forgot | sent | unverified
let wakeupTimer = null; // ver setPending(): avisa cuando el backend tarda (cold start)

// El backend en Render free duerme tras inactividad: la primera request tras
// eso tarda 20-50s. Un GET liviano acá (al abrir el modal, antes de que el
// usuario termine de escribir) empieza el "despertar" más temprano, sin
// bloquear nada — best-effort, se ignora cualquier error.
//
// `/health` tiene su propio rewrite en vercel.json (mismo origen, igual que
// `/api/*`) — la CSP (`connect-src 'self'`) exige que todo fetch sea same-origin.
function prewarmBackend() {
  try {
    const configured = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || '';
    fetch(`${configured}/health`, { method: 'GET' }).catch(() => {});
  } catch (_) {
    /* sin fetch disponible: no rompe nada */
  }
}

function isLoggedIn() {
  return !!getAccessToken();
}

function getProfile() {
  return profile;
}

function notify() {
  listeners.forEach((fn) => {
    try {
      fn({ loggedIn: isLoggedIn(), profile });
    } catch (_) {
      /* listener no debe romper el flujo */
    }
  });
}

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Nav ────────────────────────────────────────────────────────────────────

function injectNavSlot() {
  const nav = document.querySelector('.site-links');
  if (!nav) return null;
  let slot = nav.querySelector('#auth-nav-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'auth-nav-slot';
    slot.className = 'auth-nav-slot';
    nav.appendChild(slot);
  }
  return slot;
}

const AVATAR_ICON = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>`;

function renderNav() {
  const slot = injectNavSlot();
  if (!slot) return;
  slot.innerHTML = '';

  if (!isLoggedIn()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auth-nav-btn';
    btn.innerHTML = `${AVATAR_ICON}<span>Iniciar sesión</span>`;
    btn.addEventListener('click', () => open('login'));
    slot.appendChild(btn);
    return;
  }

  const name = profile?.display_name || profile?.username || profile?.email?.split('@')[0] || 'Cuenta';
  // Sanitización: el avatar es una letra del nombre del usuario (dato externo).
  const initial = escapeHtml((name[0] || '?').toUpperCase());

  const wrap = document.createElement('div');
  wrap.className = 'auth-chip-wrap';

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'auth-chip';
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-haspopup', 'menu');
  chip.innerHTML = `<span class="auth-avatar" aria-hidden="true">${initial}</span><span class="auth-chip-name">${escapeHtml(name)}</span>`;

  const menu = document.createElement('div');
  menu.className = 'auth-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const who = document.createElement('div');
  who.className = 'auth-menu-who';
  who.innerHTML = `<b>${escapeHtml(name)}</b><small>${escapeHtml(profile?.email || '')}</small>`;
  menu.appendChild(who);

  const unverified = profile && profile.email_verified === false;
  if (unverified) {
    const aviso = document.createElement('button');
    aviso.type = 'button';
    aviso.className = 'auth-menu-item auth-menu-warn';
    aviso.setAttribute('role', 'menuitem');
    aviso.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><span>Confirmar mi correo</span>`;
    aviso.addEventListener('click', () => {
      closeMenu();
      open('unverified');
    });
    menu.appendChild(aviso);
  }

  const cuenta = document.createElement('button');
  cuenta.type = 'button';
  cuenta.className = 'auth-menu-item';
  cuenta.setAttribute('role', 'menuitem');
  cuenta.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>Mi cuenta</span>`;
  cuenta.addEventListener('click', () => {
    closeMenu();
    const here = window.location.pathname.replace(/\/+$/, '');
    if (here.endsWith('/cuenta')) return;
    window.location.href = '/cuenta';
  });
  menu.appendChild(cuenta);

  const permisos = document.createElement('button');
  permisos.type = 'button';
  permisos.className = 'auth-menu-item';
  permisos.setAttribute('role', 'menuitem');
  permisos.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg><span>Permisos</span>`;
  permisos.addEventListener('click', () => {
    closeMenu();
    // El modal abre in situ en CUALQUIER página: el reproductor trae su
    // propia copia (main.js, ligada al estado real de reproducción) y el
    // resto de las páginas la reciben de site.js (ui/permissions-modal.js,
    // autocontenida) — las dos se registran bajo el mismo nombre, así que
    // esto nunca necesita saber cuál hay. El navigate a #permisos queda
    // como red de seguridad si alguna página futura no cargara site.js.
    if (typeof window.__vyneural?.openPermissions === 'function') {
      window.__vyneural.openPermissions();
      return;
    }
    window.location.href = '/#permisos';
  });
  menu.appendChild(permisos);

  const faq = document.createElement('button');
  faq.type = 'button';
  faq.className = 'auth-menu-item';
  faq.setAttribute('role', 'menuitem');
  faq.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4"/><path d="M12 17h.01"/></svg><span>FAQ</span>`;
  faq.addEventListener('click', () => {
    closeMenu();
    const here = window.location.pathname.replace(/\/+$/, '');
    if (here.endsWith('/preguntas-frecuentes')) return;
    window.location.href = '/preguntas-frecuentes';
  });
  menu.appendChild(faq);

  const salir = document.createElement('button');
  salir.type = 'button';
  salir.className = 'auth-menu-item auth-menu-danger';
  salir.setAttribute('role', 'menuitem');
  salir.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg><span>Cerrar sesión</span>`;
  salir.addEventListener('click', () => {
    closeMenu();
    doLogout();
  });
  menu.appendChild(salir);

  function closeMenu() {
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    chip.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  wrap.append(chip, menu);
  slot.appendChild(wrap);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Modal ──────────────────────────────────────────────────────────────────

function modalHTML() {
  return `
  <div class="auth-modal hidden" id="auth-modal" role="dialog" aria-modal="true" aria-label="Iniciar sesión o crear cuenta">
    <div class="auth-card">
      <div class="auth-head">
        <span class="auth-logo"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></span>
        <div class="auth-title-wrap">
          <h3 id="auth-title">Iniciar sesión</h3>
          <p id="auth-sub">Tu cuenta sincroniza favoritos, frecuencias y rutinas entre dispositivos.</p>
        </div>
        <button type="button" class="auth-close" id="auth-close" aria-label="Cerrar">✕</button>
      </div>

      <!-- Vista: login / register -->
      <div id="auth-view-form">
        <div class="auth-tabs" role="tablist" aria-label="Autenticación">
          <button type="button" class="auth-tab active" data-mode="login" role="tab" aria-selected="true">Iniciar sesión</button>
          <button type="button" class="auth-tab" data-mode="register" role="tab" aria-selected="false">Crear cuenta</button>
        </div>

        <form id="auth-form" novalidate>
          <div class="auth-field">
            <label for="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" inputmode="email" autocomplete="email" required placeholder="vos@ejemplo.com" />
          </div>

          <div class="auth-field" id="auth-username-field" hidden>
            <label for="auth-username">Nombre de usuario <em>(opcional)</em></label>
            <input id="auth-username" name="username" type="text" autocomplete="username" placeholder="ej: meditador88 (letras, números, . _ -)" />
          </div>

          <div class="auth-field" id="auth-display-field" hidden>
            <label for="auth-display">Nombre para mostrar <em>(opcional)</em></label>
            <input id="auth-display" name="display_name" type="text" autocomplete="name" maxlength="128" placeholder="Cómo te llamamos" />
          </div>

          <div class="auth-field">
            <label for="auth-password">Contraseña</label>
            <div class="auth-pw">
              <input id="auth-password" name="password" type="password" autocomplete="current-password" required />
              <button type="button" class="auth-pw-toggle" id="auth-pw-toggle" aria-label="Mostrar contraseña" tabindex="-1">👁</button>
            </div>
            <small class="auth-hint hidden" id="auth-pw-hint">Mínimo 8 caracteres, con letras y números.</small>
          </div>

          <div class="auth-field" id="auth-confirm-field" hidden>
            <label for="auth-confirm">Repetir contraseña</label>
            <div class="auth-pw">
              <input id="auth-confirm" name="confirm" type="password" autocomplete="new-password" />
            </div>
          </div>

          <div class="auth-terms" id="auth-terms-field" hidden>
            <label class="auth-check">
              <input id="auth-terms" type="checkbox" />
              <span>Acepto los <a href="/terminos" target="_blank" rel="noopener noreferrer">Términos y condiciones</a> y la <a href="/privacidad" target="_blank" rel="noopener noreferrer">Política de privacidad</a>.</span>
            </label>
          </div>

          <div class="auth-error hidden" id="auth-error" role="alert"></div>

          <button type="submit" class="auth-submit" id="auth-submit">Iniciar sesión</button>
          <button type="button" class="auth-link" id="auth-forgot-link">¿Olvidaste tu contraseña?</button>
        </form>
      </div>

      <!-- Vista: olvidé mi contraseña -->
      <div id="auth-view-forgot" hidden>
        <form id="forgot-form" novalidate>
          <p class="auth-view-text">
            Ingresá el email de tu cuenta y te enviamos un enlace para
            restablecer la contraseña (válido por 30 minutos).
          </p>
          <div class="auth-field">
            <label for="forgot-email">Email</label>
            <input id="forgot-email" name="email" type="email" inputmode="email" autocomplete="email" required placeholder="vos@ejemplo.com" />
          </div>
          <div class="auth-error hidden" id="forgot-error" role="alert"></div>
          <button type="submit" class="auth-submit" id="forgot-submit">Enviar enlace</button>
          <button type="button" class="auth-link" id="forgot-back">← Volver a iniciar sesión</button>
        </form>
      </div>

      <!-- Vista: revisá tu correo (post-registro / forgot) -->
      <div id="auth-view-sent" hidden>
        <div class="auth-success">
          <span class="auth-success-ico">📬</span>
          <h3 id="sent-title">Revisá tu correo</h3>
          <p id="sent-text">Te enviamos un enlace de confirmación.</p>
          <button type="button" class="auth-link auth-link-center" id="sent-resend">¿No llegó? Reenviar</button>
          <button type="button" class="auth-submit" id="sent-done">Entendido</button>
        </div>
      </div>

      <!-- Vista: login bloqueado por verificación pendiente -->
      <div id="auth-view-unverified" hidden>
        <div class="auth-success">
          <span class="auth-success-ico">📬</span>
          <h3>Confirmá tu correo</h3>
          <p id="unverified-text">
            Para proteger tu cuenta, tenés que confirmar el correo antes de
            iniciar sesión. Te enviamos el enlace de confirmación.
          </p>
          <button type="button" class="auth-submit" id="unverified-resend">Reenviar correo</button>
          <button type="button" class="auth-link auth-link-center" id="unverified-close">Entendido</button>
        </div>
      </div>

      <p class="auth-foot">
        Sin backend configurado la app sigue funcionando igual: esta cuenta es
        opcional y solo sincroniza tus datos.
      </p>
    </div>
  </div>`;
}

function injectModal() {
  if (document.getElementById('auth-modal')) return;
  modalRoot = document.createElement('div');
  modalRoot.innerHTML = modalHTML();
  document.body.appendChild(modalRoot.firstElementChild);
  wireModal();
}

function wireModal() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;

  const close = () => modal.classList.add('hidden');

  modal.querySelector('#auth-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  modal.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.mode));
  });

  const pw = modal.querySelector('#auth-password');
  const pwToggle = modal.querySelector('#auth-pw-toggle');
  pwToggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    pwToggle.textContent = show ? '🙈' : '👁';
    pwToggle.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });

  modal.querySelector('#auth-form').addEventListener('submit', onSubmitAuth);
  modal.querySelector('#forgot-form').addEventListener('submit', onSubmitForgot);

  modal.querySelector('#auth-forgot-link').addEventListener('click', () => setView('forgot'));
  modal.querySelector('#forgot-back').addEventListener('click', () => setView('login'));
  modal.querySelector('#sent-resend').addEventListener('click', () => doResendVerification());
  modal.querySelector('#sent-done').addEventListener('click', close);
  modal.querySelector('#unverified-resend').addEventListener('click', () => doResendVerification());
  modal.querySelector('#unverified-close').addEventListener('click', close);
}

function setView(next) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  view = next === 'register' || next === 'forgot' || next === 'sent' || next === 'unverified' ? next : 'login';
  const isAuth = view === 'login' || view === 'register';

  modal.querySelector('#auth-view-form').hidden = !isAuth;
  modal.querySelector('#auth-view-forgot').hidden = view !== 'forgot';
  modal.querySelector('#auth-view-sent').hidden = view !== 'sent';
  modal.querySelector('#auth-view-unverified').hidden = view !== 'unverified';
  modal.querySelector('.auth-foot').style.display = isAuth ? '' : 'none';

  if (!isAuth) {
    setError(null);
    setForgotError(null);
    return;
  }

  // Tabs
  modal.querySelectorAll('.auth-tab').forEach((t) => {
    const on = t.dataset.mode === view;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });

  const isRegister = view === 'register';
  modal.querySelector('#auth-username-field').hidden = !isRegister;
  modal.querySelector('#auth-display-field').hidden = !isRegister;
  modal.querySelector('#auth-confirm-field').hidden = !isRegister;
  modal.querySelector('#auth-terms-field').hidden = !isRegister;
  modal.querySelector('#auth-title').textContent = isRegister ? 'Crear cuenta' : 'Iniciar sesión';
  modal.querySelector('#auth-sub').textContent = isRegister
    ? 'Creá tu cuenta gratis: confirmá tu correo y sincronizá todo entre dispositivos.'
    : 'Tu cuenta sincroniza favoritos, frecuencias y rutinas entre dispositivos.';
  modal.querySelector('#auth-submit').textContent = isRegister ? 'Crear cuenta' : 'Iniciar sesión';
  modal.querySelector('#auth-password').autocomplete = isRegister ? 'new-password' : 'current-password';
  modal.querySelector('#auth-pw-hint').classList.toggle('hidden', !isRegister);
  modal.querySelector('#auth-forgot-link').style.display = isRegister ? 'none' : '';
  setError(null);
  setForgotError(null);
}

function setError(msg) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  const err = modal.querySelector('#auth-error');
  err.textContent = msg || '';
  err.classList.toggle('hidden', !msg);
}

function setForgotError(msg) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  const err = modal.querySelector('#forgot-error');
  err.textContent = msg || '';
  err.classList.toggle('hidden', !msg);
}

// Validación espejo del backend (ver app/schemas/auth.py).
function validateAuth() {
  const modal = document.getElementById('auth-modal');
  const email = modal.querySelector('#auth-email').value.trim();
  const password = modal.querySelector('#auth-password').value;

  if (!EMAIL_RE.test(email)) return 'Ingresá un email válido.';
  if (password.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return 'La contraseña debe incluir letras y números.';
  }
  if (view === 'register') {
    const username = modal.querySelector('#auth-username').value.trim();
    if (username && !USERNAME_RE.test(username)) {
      return 'El nombre de usuario solo puede tener letras, números, puntos, guiones y guiones bajos (3 a 64 caracteres).';
    }
    const confirm = modal.querySelector('#auth-confirm').value;
    if (confirm !== password) return 'Las contraseñas no coinciden.';
    if (!modal.querySelector('#auth-terms').checked) {
      return 'Tenés que aceptar los Términos y condiciones para crear la cuenta.';
    }
  }
  return null;
}

// Espera >4s sin respuesta = probable cold start del backend (Render free):
// se avisa la verdad en vez de dejar "Ingresando…" ambiguo, que el usuario
// suele leer como "se colgó" y abandona justo antes de que responda.
const WAKEUP_HINT_MS = 4000;

function setPending(pending) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  const submit = modal.querySelector('#auth-submit');
  submit.disabled = pending;
  submit.classList.toggle('auth-pending', pending);
  submit.textContent = pending
    ? (view === 'register' ? 'Creando cuenta…' : 'Ingresando…')
    : (view === 'register' ? 'Crear cuenta' : 'Iniciar sesión');

  clearTimeout(wakeupTimer);
  wakeupTimer = null;
  if (pending) {
    wakeupTimer = setTimeout(() => {
      submit.textContent = 'Despertando el servidor… puede tardar unos segundos';
    }, WAKEUP_HINT_MS);
  }
}

async function onSubmitAuth(e) {
  e.preventDefault();
  const modal = document.getElementById('auth-modal');
  const email = modal.querySelector('#auth-email').value.trim();
  const password = modal.querySelector('#auth-password').value;

  const problem = validateAuth();
  if (problem) {
    setError(problem);
    return;
  }

  setPending(true);
  setError(null);
  try {
    if (view === 'register') {
      const username = modal.querySelector('#auth-username').value.trim() || undefined;
      const displayName = modal.querySelector('#auth-display').value.trim() || undefined;
      await register({ email, password, username, display_name: displayName });
      // Sesión creada: mostrar "revisá tu correo" con reenvío.
      await refreshProfile();
      renderNav();
      notify();
      document.dispatchEvent(new CustomEvent('vyneural:auth', { detail: { type: 'register' } }));
      afterAuth();
      showSent({
        title: 'Casi listo: revisá tu correo',
        text: `Te enviamos un enlace de confirmación a ${escapeHtml(email)}. Verificá tu bandeja (y el spam).`,
        resend: true,
      });
    } else {
      try {
        await login({ email, password });
      } catch (err) {
        if (err && err.status === 403) {
          // Login bloqueado por verificación pendiente → pantalla de confirmación.
          await refreshProfile();
          renderNav();
          notify();
          setView('unverified');
          return;
        }
        throw err;
      }
      await refreshProfile();
      modal.classList.add('hidden');
      renderNav();
      notify();
      document.dispatchEvent(new CustomEvent('vyneural:auth', { detail: { type: 'login' } }));
      afterAuth();
    }
  } catch (err) {
    setError(friendlyError(err));
  } finally {
    setPending(false);
  }
}

async function onSubmitForgot(e) {
  e.preventDefault();
  const modal = document.getElementById('auth-modal');
  const email = modal.querySelector('#forgot-email').value.trim();
  if (!EMAIL_RE.test(email)) {
    setForgotError('Ingresá un email válido.');
    return;
  }
  const submit = modal.querySelector('#forgot-submit');
  const originalLabel = submit.textContent;
  submit.disabled = true;
  setForgotError(null);
  const timer = setTimeout(() => {
    submit.textContent = 'Despertando el servidor… puede tardar unos segundos';
  }, WAKEUP_HINT_MS);
  try {
    // Respuesta genérica: no revela si el email existe.
    await forgotPassword(email);
    showSent({
      title: 'Revisá tu correo',
      text: 'Si esa cuenta existe, te enviamos un enlace para restablecer tu contraseña (válido por 30 minutos).',
      resend: false,
    });
  } catch (err) {
    setForgotError(friendlyError(err));
  } finally {
    clearTimeout(timer);
    submit.disabled = false;
    submit.textContent = originalLabel;
  }
}

function showSent({ title, text, resend }) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  setView('sent');
  modal.querySelector('#sent-title').textContent = title || 'Revisá tu correo';
  modal.querySelector('#sent-text').textContent = text || '';
  modal.querySelector('#sent-resend').style.display = resend ? '' : 'none';
}

async function doResendVerification() {
  const modal = document.getElementById('auth-modal');
  const btn = modal && modal.querySelector('#unverified-resend, #sent-resend');
  if (btn) {
    btn.disabled = true;
    btn.dataset.resendLabel = btn.textContent;
    btn.textContent = 'Enviando…';
  }
  try {
    const result = await resendVerification();
    // El backend responde 200 aunque la entrega fallara (SMTP sin configurar):
    // `email_sent` dice la verdad y la UI no debe prometer "enviado ✓".
    if (result && result.email_sent === false) {
      showResendFeedback(
        'No pudimos enviar el correo: el servidor de correo no está funcionando en este momento. ' +
        'Escribinos por Instagram (@vyneural.cl) y te ayudamos.',
        true,
      );
    } else {
      showResendFeedback('Correo reenviado. Revisá tu bandeja (y el spam).', false);
    }
  } catch (err) {
    // IMPORTANTE: el error se muestra en la vista actual. Antes se escribía en
    // #auth-error, que vive dentro de la vista de formulario (oculta acá), y el
    // usuario hacía clic en "Reenviar" sin ver absolutamente nada.
    showResendFeedback(friendlyError(err), true);
  } finally {
    if (btn) {
      btn.textContent = btn.dataset.resendLabel || btn.textContent;
      btn.disabled = false;
    }
  }
}

// Feedback del reenvío visible en la vista donde está el usuario ("Revisá tu
// correo" / "Confirmá tu correo"), no en el div oculto de la vista de login.
function showResendFeedback(msg, isError) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  const sentView = modal.querySelector('#auth-view-sent');
  const title = modal.querySelector('#sent-title');
  const text = modal.querySelector('#sent-text');
  const resendBtn = modal.querySelector('#sent-resend');
  const inSentView = !sentView.hidden;

  title.textContent = isError ? 'No se pudo reenviar' : 'Correo reenviado';
  if (text) {
    text.textContent = msg;
    text.classList.toggle('auth-resend-error', !!isError);
  }
  if (resendBtn) {
    // En error se deja visible para poder reintentar; en éxito dentro de la
    // vista "Confirmá tu correo" se oculta (ya quedó confirmado el envío).
    resendBtn.style.display = isError ? '' : (inSentView ? '' : 'none');
  }
  if (!inSentView) setView('sent');
}

function friendlyError(err) {
  const status = err && err.status;
  const detail = (err && err.detail) || '';
  if (status === 429) return 'Demasiados intentos. Esperá un momento y volvé a intentar.';
  if (status === 409) return 'Ese email o nombre de usuario ya está en uso.';
  if (status === 401) return 'Email o contraseña incorrectos.';
  if (status === 404 || status >= 500) {
    return 'El servidor de cuentas no está disponible en este momento. Intentá en unos minutos o escribinos por Instagram (@vyneural.cl).';
  }
  if (status === 403) {
    if (/confirmá tu correo/i.test(detail)) return 'Tenés que confirmar tu correo para iniciar sesión. Revisá tu bandeja.';
    return 'Tu cuenta está inactiva. Contactanos por Instagram (@vyneural.cl).';
  }
  if (status === 422) {
    if (/contraseña/i.test(detail)) return 'La contraseña debe tener al menos 8 caracteres e incluir letras y números.';
    if (/email/i.test(detail)) return 'Ingresá un email válido.';
    if (/username/i.test(detail)) return 'El nombre de usuario no es válido (letras, números, . _ -, 3 a 64 caracteres).';
    return 'Revisá los datos ingresados.';
  }
  if (status === 0) return 'No hay conexión con el servidor. Revisá tu conexión e intentá de nuevo.';
  if (detail && typeof detail === 'string') return detail.slice(0, 200);
  return 'Algo salió mal. Intentá de nuevo.';
}

async function refreshProfile() {
  if (!isLoggedIn()) {
    profile = null;
    return;
  }
  try {
    profile = await me();
  } catch (_) {
    profile = null;
  }
}

// Solo para el arranque (init()): un cold start de Render (20-50s) hace que
// el ÚNICO intento de refreshProfile() de la carga de página falle con un
// error de red — transitorio, no una sesión inválida (esa la maneja
// handleSessionExpired vía vyneural:session-expired, que ya deja
// isLoggedIn()=false antes de que volvamos acá). Sin reintentos, el chip de
// la nav quedaba trabado mostrando "Cuenta" (el nombre nunca cargó) en vez
// de resolver a logueado o deslogueado — el bug reportado en vivo: "dejo la
// sesión, vuelvo y hago reload, no sale ni logeado ni deslogeado". Los
// flujos de login/registro (onSubmitAuth) siguen llamando a refreshProfile()
// directo, sin reintentos: ahí el backend acaba de responder al login, así
// que un cold start a mitad de flujo es mucho menos probable, y bloquear el
// modal reintentando de más sería peor UX que mostrar el nombre genérico
// una vez.
//
// El presupuesto original (~41s) daba por hecho el cold start "típico"
// documentado de Render free (20-50s) — reportado en vivo un caso real de
// ~5 min con "Cuenta" trabado en la APK, bastante por encima de esa
// ventana (el free tier ocasionalmente tarda mucho más si viene de horas
// dormido, o si Render mismo está lento). Se extiende con más pasos de 30s:
// cualquier fallo mientras isLoggedIn() siga true YA está garantizado que es
// transitorio (una sesión de verdad inválida sale del loop en la próxima
// vuelta vía el chequeo de abajo), así que alargar la espera es seguro —
// el costo es un GET /auth/me liviano repetido, nunca un bloqueo de UI.
async function refreshProfileOnBoot() {
  const RETRY_DELAYS_MS = [
    3000, 6000, 12000, 20000, // ~41s — cold start "típico"
    30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, // +270s — cold start largo
  ]; // ~5m11s de cobertura total
  for (let attempt = 0; ; attempt++) {
    await refreshProfile();
    if (profile || !isLoggedIn() || attempt >= RETRY_DELAYS_MS.length) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

// Tras autenticarse: traer favoritos de la nube, arrancar la sincronización
// y ofrecer notificaciones push (nunca las activa sola, ver syncPushState).
// Todo best-effort.
function afterAuth() {
  const ok = initBackendIfConfigured().catch(() => false);
  Promise.all([
    ok,
    pullCloudFavoritesToLocal().catch(() => false),
  ]).catch(() => {});
  syncPushState();
}

// ── Notificaciones push: ofrecer, nunca sorprender ──────────────────────────
// Pedir el permiso del navegador SIN aviso previo (justo al loguearse, sin
// contexto) es un antipatrón: si el usuario lo rechaza por reflejo,
// Notification.permission queda en "denied" PARA SIEMPRE — JS ya no puede
// volver a pedirlo. Por eso acá NUNCA se llama a subscribeToPush() sin que el
// usuario haya tocado algo primero — salvo que el permiso YA esté concedido
// (de una sesión o dispositivo anterior), donde resincronizar es inofensivo:
// no dispara ningún diálogo nuevo, solo mantiene la suscripción del backend
// al día (ver también pushsubscriptionchange en sw.js).
const LS_PUSH_BANNER_DISMISSED = 'vyneural_push_banner_dismissed';

function pushBannerDismissed() {
  try {
    return localStorage.getItem(LS_PUSH_BANNER_DISMISSED) === 'true';
  } catch {
    return false;
  }
}

function dismissPushBanner() {
  try {
    localStorage.setItem(LS_PUSH_BANNER_DISMISSED, 'true');
  } catch {
    /* sin almacenamiento: el banner puede reaparecer, no rompe nada */
  }
}

function isApkContext() {
  return typeof window !== 'undefined' && !!(window.AndroidBridge || window.AndroidBridgeNative);
}

function showPushBanner() {
  if (document.getElementById('vyneural-push-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'vyneural-push-banner';
  bar.className = 'push-banner';
  bar.innerHTML = `
    <span class="push-banner-text">🔔 Activá notificaciones para que tus recordatorios avisen aunque cierres el navegador.</span>
    <span class="push-banner-actions">
      <button type="button" class="push-banner-btn" id="push-banner-accept">Activar</button>
      <button type="button" class="push-banner-btn push-banner-btn-ghost" id="push-banner-dismiss">Ahora no</button>
    </span>`;
  document.body.appendChild(bar);
  const remove = () => bar.remove();
  bar.querySelector('#push-banner-dismiss').addEventListener('click', () => {
    dismissPushBanner();
    remove();
  });
  bar.querySelector('#push-banner-accept').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Activando…';
    // Acá SÍ dispara el diálogo real del navegador — pero con el gesto del
    // usuario y el contexto del banner ya leído, no como sorpresa.
    await subscribeToPush().catch(() => {});
    // Se decidió (aceptado o el navegador lo rechazó): no insistir de nuevo.
    dismissPushBanner();
    remove();
  });
}

async function syncPushState() {
  if (isApkContext()) return; // la APK tiene su propio flujo (bridge nativo, ver cuenta.js)
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'granted') {
    subscribeToPush().catch(() => {});
    return;
  }
  if (Notification.permission !== 'default' || pushBannerDismissed()) return;
  // /cuenta ya tiene su propio panel dedicado ("🔔 Notificaciones push") con
  // el mismo botón "Activar" — mostrar el banner flotante ahí es redundante
  // (y en mobile se pisa con el FAB de reportar bug).
  if (typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/cuenta') return;
  try {
    const status = await pushStatus();
    if (!status || !status.configured) return; // backend sin VAPID: nada que ofrecer
  } catch {
    return;
  }
  showPushBanner();
}

// Sesión vencida detectada en CUALQUIER página (ver vyneural:session-expired
// en client.js): limpia el estado local, re-renderiza el chip de la nav
// ("Iniciar sesión") y notifica a los listeners — sin llamar a la API (la
// sesión ya no es válida). Misma lógica que window.__vyneuralAuth.expireSession.
function handleSessionExpired() {
  clearSession();
  profile = null;
  renderNav();
  notify();
  document.dispatchEvent(new CustomEvent('vyneural:auth', { detail: { type: 'logout' } }));
}

async function doLogout() {
  try {
    await logout();
  } catch (_) {
    clearSession();
  }
  profile = null;
  renderNav();
  notify();
  document.dispatchEvent(new CustomEvent('vyneural:auth', { detail: { type: 'logout' } }));
}

// ── API pública ─────────────────────────────────────────────────────────────

export function open(mode) {
  injectModal();
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  setView(mode || 'login');
  modal.classList.remove('hidden');
  prewarmBackend();
  setTimeout(() => {
    const f = view === 'forgot'
      ? modal.querySelector('#forgot-email')
      : modal.querySelector('#auth-email');
    if (f) f.focus();
  }, 30);
}

// ── Arranque ────────────────────────────────────────────────────────────────

function init() {
  injectNavSlot();
  renderNav();
  notify();

  if (isLoggedIn()) {
    refreshProfileOnBoot().finally(() => {
      renderNav();
      notify();
      pullCloudFavoritesToLocal().catch(() => {});
    });
    // Visita de vuelta (no un login recién hecho): resincroniza push en
    // silencio si ya estaba concedido, u ofrece el banner si nunca se decidió.
    syncPushState();
  }

  window.__vyneuralAuth = {
    open,
    onAuthChange,
    isLoggedIn,
    getProfile: () => profile,
    refresh: () => refreshProfile().then(() => { renderNav(); notify(); }),
    logout: doLogout,
    // Conservado para quien ya lo llamaba explícitamente (ver /cuenta).
    expireSession: handleSessionExpired,
  };

  // Fuente centralizada: cualquier fetch autenticado que confirme la sesión
  // vencida (client.js, tras fallar el refresh) dispara esto, sin que cada
  // página tenga que detectar el 401 y llamar expireSession() por su cuenta.
  document.addEventListener('vyneural:session-expired', handleSessionExpired);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
