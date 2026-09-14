// src/ui/confirm-modal.js
// Modal de confirmación/aviso propio del sitio — reemplaza confirm()/alert()
// nativos del navegador en el flujo de pagos (ver premium.js::buyPlan,
// cuenta.js::wireOneclickButtons). Mismo patrón de inyección perezosa que
// ui/premium-gate.js::openPremiumRequired, y mismas clases CSS que ya usa
// ese modal y el de desactivar cuenta (cuenta.html) — cero CSS nuevo.

function modalHTML() {
  return `
  <div class="auth-modal hidden" id="confirm-modal" role="dialog" aria-modal="true">
    <div class="auth-card">
      <button type="button" class="auth-close" id="confirm-modal-close" aria-label="Cerrar">✕</button>
      <h3 id="confirm-modal-title"></h3>
      <p id="confirm-modal-text" class="rutina-hint"></p>
      <button type="button" class="auth-submit" id="confirm-modal-ok"></button>
    </div>
  </div>`;
}

let injected = false;
let resolveCurrent = null;

function inject() {
  if (injected) return;
  injected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = modalHTML();
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.getElementById('confirm-modal');
  const finish = (result) => {
    modal.classList.add('hidden');
    if (resolveCurrent) {
      const resolve = resolveCurrent;
      resolveCurrent = null;
      resolve(result);
    }
  };
  modal.querySelector('#confirm-modal-close').addEventListener('click', () => finish(false));
  modal.querySelector('#confirm-modal-ok').addEventListener('click', () => finish(true));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) finish(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) finish(false);
  });
}

function show({ title, text, confirmLabel, danger }) {
  inject();
  if (resolveCurrent) {
    // Ya había un modal de este tipo esperando resolución (no debería pasar
    // en el uso normal, siempre un botón a la vez) — se resuelve en falso
    // antes de reemplazarlo, para no dejar la promesa anterior colgada.
    const prev = resolveCurrent;
    resolveCurrent = null;
    prev(false);
  }
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-text').textContent = text;
  const ok = document.getElementById('confirm-modal-ok');
  ok.textContent = confirmLabel;
  ok.classList.toggle('cuenta-btn-danger', !!danger);
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    resolveCurrent = resolve;
  });
}

/** Reemplaza confirm(): true si se tocó el botón de acción, false si se
 * cerró con la X, un click afuera o Escape. */
export function confirmModal({ title, text, confirmLabel = 'Confirmar', danger = false }) {
  return show({ title, text, confirmLabel, danger });
}

/** Reemplaza alert(): un solo botón, no hay decisión que tomar — el valor
 * de retorno no importa, se puede ignorar (`await notifyModal(...)`). */
export function notifyModal({ title, text, confirmLabel = 'Entendido' }) {
  return show({ title, text, confirmLabel, danger: false });
}
