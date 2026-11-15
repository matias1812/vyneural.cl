import { me } from '../api/auth.js';
import { premiumStatus } from '../api/billing.js';
import { getAccessToken } from '../api/client.js';
import { openPremiumRequired } from './premium-gate.js';

const OPTIONS = new Map([
  ['default', { name: 'Original', color: null }],
  ['cyan', { name: 'Hielo', color: [114, 213, 255] }],
  ['violet', { name: 'Violeta', color: [188, 151, 255] }],
  ['rose', { name: 'Rosa', color: [255, 135, 191] }],
  ['amber', { name: 'Ámbar', color: [255, 193, 104] }],
  ['mint', { name: 'Menta', color: [118, 243, 193] }],
]);
const STORAGE_KEY = 'vyneural_lamp_color_v1';
const MOTION_KEY = 'vyneural_lamp_motion_v1';
const ENTITLEMENT_TTL_MS = 30_000;

function readMotion() {
  try {
    const value = localStorage.getItem(MOTION_KEY);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch (_) { return null; }
}

export function initLampColor({ onChange, onMotionChange, onError }) {
  const button = document.getElementById('lamp-color-btn');
  const dialog = document.getElementById('lamp-color-dialog');
  const swatches = dialog.querySelector('.lamp-swatches');
  const motion = dialog.querySelector('.lamp-motion-switch');
  const motionState = motion.querySelector('[data-lamp-motion-state]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motionChoice = readMotion();
  let account = null;
  let request = null;
  let selectedChoice = 'default';
  let intent = 0;

  function syncMotion() {
    const moving = motionChoice ?? !reducedMotion.matches;
    motion.setAttribute('aria-checked', String(moving));
    motionState.textContent = moving ? 'En movimiento' : 'Estática';
    onMotionChange(moving);
  }

  motion.addEventListener('click', () => {
    motionChoice = motion.getAttribute('aria-checked') !== 'true';
    try { localStorage.setItem(MOTION_KEY, String(motionChoice)); }
    catch (_) { /* conserva el ajuste durante esta visita */ }
    syncMotion();
  });
  reducedMotion.addEventListener?.('change', syncMotion);
  window.addEventListener('storage', event => {
    if (event.key !== MOTION_KEY && event.key !== null) return;
    motionChoice = readMotion();
    syncMotion();
  });
  syncMotion();

  function sync(choice = 'default') {
    selectedChoice = choice;
    const { color } = OPTIONS.get(choice);
    button.style.setProperty('--lamp-preview', color ? 'rgb(' + color.join(',') + ')' : '');
    for (const swatch of swatches.children) {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.lamp === choice));
    }
    onChange(color);
  }

  async function checkAccount() {
    const token = getAccessToken();
    if (!token) return null;
    if (account?.token === token && Date.now() < account.expires) return account;
    if (request?.token === token) return request.promise;
    const current = { token };
    current.promise = Promise.all([premiumStatus(), me()]).then(([status, user]) => {
      if (request !== current || !getAccessToken() || user?.id == null) return null;
      account = { token: getAccessToken(), id: user.id, premium: status.is_premium === true, expires: Date.now() + ENTITLEMENT_TTL_MS };
      return account;
    }).finally(() => {
      if (request === current) request = null;
    });
    request = current;
    return current.promise;
  }

  function loadSaved(user) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.accountId === user.id && OPTIONS.has(saved.choice)) return saved.choice;
    } catch (_) { /* preferencia inexistente o inválida */ }
    return 'default';
  }

  for (const [id, option] of OPTIONS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'lamp-swatch';
    swatch.dataset.lamp = id;
    swatch.style.setProperty('--swatch', 'rgb(' + (option.color ?? [198, 232, 255]).join(',') + ')');
    swatch.setAttribute('aria-pressed', String(id === 'default'));
    swatch.textContent = option.name;
    swatches.append(swatch);
  }

  button.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });

  swatches.addEventListener('click', async (event) => {
    const choice = event.target.closest('button')?.dataset.lamp;
    if (!OPTIONS.has(choice)) return;
    const interaction = ++intent;
    try {
      const user = await checkAccount();
      if (interaction !== intent || !dialog.open) return;
      if (!user?.premium) {
        dialog.close();
        sync();
        openPremiumRequired('Cambiar el color de la luz de la cimática es parte de Vyneural Premium.');
        return;
      }
      sync(choice);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ accountId: user.id, choice })); }
      catch (_) { /* conserva el color durante esta visita */ }
      dialog.close();
    } catch (_) {
      if (interaction === intent) onError('No se pudo comprobar tu plan. Intenta de nuevo.');
    }
  });

  dialog.querySelector('[data-lamp-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => ++intent);

  async function restore() {
    const interaction = intent;
    try {
      const user = await checkAccount();
      if (interaction === intent && user?.premium) sync(loadSaved(user));
    } catch (_) { /* se conserva la configuración de la sesión */ }
  }

  function reset() {
    ++intent;
    account = null;
    request = null;
    if (dialog.open) dialog.close();
    sync();
    restoreIfSaved();
  }

  document.addEventListener('vyneural:auth', event => {
    if (event.detail?.type === 'login' || event.detail?.type === 'logout') reset();
  });
  window.addEventListener('focus', () => {
    if (selectedChoice === 'default') return;
    const interaction = intent;
    checkAccount().then(user => {
      if (interaction === intent && !user?.premium) sync();
    }).catch(() => {});
  });
  function restoreIfSaved() {
    try {
      if (getAccessToken() && localStorage.getItem(STORAGE_KEY)) void restore();
    } catch (_) { /* almacenamiento no disponible */ }
  }
  restoreIfSaved();
}
