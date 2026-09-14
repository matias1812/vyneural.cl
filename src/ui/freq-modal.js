// src/ui/freq-modal.js
// Modal compartido "Guardar frecuencia personalizada": el mismo formulario
// (nombre + portadora + ritmo + forma de onda) desde el generador y desde
// /cuenta. Aditivo: sin sesión abre el modal de login en vez de fallar.
//
// API pública:
//   window.__vyneuralFreqModal = { open(opts) }
//   document 'vyneural:freq-saved' → CustomEvent { detail: { frequency } }

import { createFrequency } from '../api/frequencies.js';
import { getAccessToken } from '../api/client.js';
import { freqCoverSVG } from './freq-cover.js';

const WAVES = [
  { id: 'sine', label: 'Senoidal (suave)' },
  { id: 'triangle', label: 'Triangular' },
  { id: 'square', label: 'Cuadrada' },
  { id: 'sawtooth', label: 'Diente de sierra' },
];

let modalRoot = null;
let openOpts = {};

function freqModalHTML() {
  return `
  <div class="auth-modal hidden" id="freq-modal" role="dialog" aria-modal="true" aria-label="Guardar frecuencia personalizada">
    <div class="auth-card">
      <div class="auth-head">
        <span class="auth-logo"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg></span>
        <div class="auth-title-wrap">
          <h3 id="freq-title">Guardar frecuencia personalizada</h3>
          <p id="freq-sub">Se guarda en tu cuenta y se sincroniza en todos tus dispositivos.</p>
        </div>
        <button type="button" class="auth-close" id="freq-close" aria-label="Cerrar">✕</button>
      </div>

      <form id="freq-form" novalidate>
        <div class="freq-cover-preview" id="freq-cover-preview" aria-hidden="true"></div>
        <div class="auth-field">
          <label for="freq-name">Nombre</label>
          <input id="freq-name" name="name" type="text" maxlength="120" autocomplete="off" required placeholder="Ej: Mi sesión de estudio" />
        </div>

        <div class="freq-row">
          <div class="auth-field">
            <label for="freq-base">Portadora (Hz)</label>
            <input id="freq-base" name="carrier" type="number" min="2" max="19999" step="0.1" required />
            <small class="auth-hint">La frecuencia base en ambos oídos.</small>
          </div>
          <div class="auth-field">
            <label for="freq-beat">Ritmo (Hz)</label>
            <input id="freq-beat" name="beat" type="number" min="0" max="499" step="0.5" required />
            <small class="auth-hint">La diferencia entre oídos (el latido).</small>
          </div>
        </div>

        <div class="auth-field">
          <label for="freq-wave">Forma de onda</label>
          <select id="freq-wave" name="waveform"></select>
        </div>

        <div class="auth-error hidden" id="freq-error" role="alert"></div>

        <button type="submit" class="auth-submit" id="freq-submit">Guardar frecuencia</button>
      </form>

      <p class="auth-foot">
        Se guarda con tu cuenta: sin sesión activa, primero te pedimos que
        inicies sesión o crees una cuenta (gratis y opcional).
      </p>
    </div>
  </div>`;
}

function injectModal() {
  if (document.getElementById('freq-modal')) return;
  modalRoot = document.createElement('div');
  modalRoot.innerHTML = freqModalHTML();
  document.body.appendChild(modalRoot.firstElementChild);
  wireModal();
}

function wireModal() {
  const modal = document.getElementById('freq-modal');
  if (!modal) return;
  const close = () => modal.classList.add('hidden');
  modal.querySelector('#freq-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  const waveSel = modal.querySelector('#freq-wave');
  waveSel.innerHTML = WAVES.map(
    (w) => `<option value="${w.id}">${w.label}</option>`,
  ).join('');

  modal.querySelector('#freq-form').addEventListener('submit', onSubmit);
  ['#freq-name', '#freq-base', '#freq-beat', '#freq-wave'].forEach((sel) => {
    modal.querySelector(sel).addEventListener('input', updateCoverPreview);
  });
}

// Portada en vivo: se redibuja con cada cambio del formulario, así el
// usuario ve la miniatura que va a representar a la frecuencia guardada.
function updateCoverPreview() {
  const modal = document.getElementById('freq-modal');
  if (!modal) return;
  const preview = modal.querySelector('#freq-cover-preview');
  if (!preview) return;
  preview.innerHTML = freqCoverSVG(
    {
      name: modal.querySelector('#freq-name').value,
      carrier_frequency: parseFloat(modal.querySelector('#freq-base').value) || 0,
      beat_frequency: parseFloat(modal.querySelector('#freq-beat').value) || 0,
      waveform: modal.querySelector('#freq-wave').value,
    },
    64,
  );
}

function setPending(pending) {
  const modal = document.getElementById('freq-modal');
  if (!modal) return;
  const btn = modal.querySelector('#freq-submit');
  btn.disabled = pending;
  btn.textContent = pending ? 'Guardando…' : 'Guardar frecuencia';
}

function setError(msg) {
  const modal = document.getElementById('freq-modal');
  if (!modal) return;
  const errEl = modal.querySelector('#freq-error');
  errEl.textContent = msg;
  errEl.classList.toggle('hidden', !msg);
}

async function onSubmit(e) {
  e.preventDefault();
  const modal = document.getElementById('freq-modal');
  const name = modal.querySelector('#freq-name').value.trim();
  const carrier = parseFloat(modal.querySelector('#freq-base').value);
  const beat = parseFloat(modal.querySelector('#freq-beat').value);
  const waveform = modal.querySelector('#freq-wave').value;

  if (!name) return setError('Poné un nombre para reconocerla después.');
  if (!Number.isFinite(carrier) || carrier < 2 || carrier > 19999) {
    return setError('La portadora debe estar entre 2 y 19999 Hz.');
  }
  if (!Number.isFinite(beat) || beat < 0 || beat > 499) {
    return setError('El ritmo debe estar entre 0 y 499 Hz.');
  }

  setPending(true);
  try {
    const frequency = await createFrequency({
      name: name.slice(0, 120),
      carrier_frequency: Math.round(carrier * 10) / 10,
      beat_frequency: Math.round(beat * 10) / 10,
      waveform,
      condition: 'binaural',
      config: { source: openOpts.source || 'generator' },
    });
    modal.classList.add('hidden');
    modal.querySelector('#freq-form').reset();
    setError('');
    document.dispatchEvent(
      new CustomEvent('vyneural:freq-saved', { detail: { frequency } }),
    );
  } catch (err) {
    const msg = (err && err.detail) || 'No se pudo guardar. Intentá de nuevo.';
    setError(String(msg).slice(0, 300));
  } finally {
    setPending(false);
  }
}

// ── API pública ────────────────────────────────────────────────────────────

export function openFreqModal(opts = {}) {
  injectModal();
  const modal = document.getElementById('freq-modal');
  openOpts = opts;

  // Guardar frecuencias requiere cuenta (viven en el backend). Sin sesión,
  // se abre el login y se explica por qué.
  if (!getAccessToken()) {
    const auth = window.__vyneuralAuth;
    if (auth && typeof auth.open === 'function') auth.open('login');
    return false;
  }

  modal.querySelector('#freq-name').value = opts.name || '';
  modal.querySelector('#freq-base').value =
    opts.carrier != null ? opts.carrier : 220;
  modal.querySelector('#freq-beat').value = opts.beat != null ? opts.beat : 10;
  const waveSel = modal.querySelector('#freq-wave');
  waveSel.value = opts.wave || 'sine';
  setError('');
  updateCoverPreview();
  modal.classList.remove('hidden');
  setTimeout(() => modal.querySelector('#freq-name').focus(), 50);
  return true;
}
