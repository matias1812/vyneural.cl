// src/ui/onboarding-modal.js
// Onboarding progresivo — capa de UI. UNA pregunta a la vez, en el modal
// genérico .page-modal (el de "Crear itinerario" en rutina.html), no en
// .auth-modal: esa clase está atada a login/registro por comentario
// explícito en site.css, y el propio comentario de .page-modal dice que es
// el patrón para "formularios largos" / contenido de otra semántica.
//
// Dos entradas:
//   showMilestoneStep(step, { profile, onResolved })  ← hitos por sesiones
//                                                       (src/onboarding-flow.js)
//   showEditFlow(initialStep)                         ← botón "Editar
//                                                       preferencias" de /cuenta
//
// Mismo patrón de inyección perezosa que ui/confirm-modal.js y
// ui/premium-gate.js: un único nodo singleton en <body> detrás del guard
// `injected`, cierre por ✕ / click en el backdrop / Escape, listeners
// registrados una sola vez.
//
// Este módulo se carga SIEMPRE por import() dinámico (ver
// onboarding-flow.js::evaluateOnboarding), así que sus CSS viajan en el
// chunk perezoso y no pesan en el bundle de ninguna página.
import '../marketing.css'; // .marketing-topic-grid — solo /cuenta la importa
                           // estáticamente, y este modal aparece en todas las
                           // páginas (site.js), así que el chunk se la trae.
import '../onboarding.css';

import { ONBOARDING_MILESTONES } from '../core/session-milestones.js';
import {
  MARKETING_CONTENT_PREFERENCES,
  MARKETING_GOALS,
  marketingGoalLabel,
  marketingProfileUpdatePayload,
} from '../marketing-ui.js';
import {
  getMarketingProfile,
  submitMarketingSurvey,
  updateMarketingProfile,
} from '../api/marketing.js';
import { celebrateBurst, prefersReducedMotion } from './celebrate.js';
import { loadState, saveState } from '../onboarding-flow.js';

// Orden y nombres de los pasos: se derivan de ONBOARDING_MILESTONES (misma
// fuente que usa la lógica de hitos) para no tener dos listas que puedan
// desincronizarse — el orden está fijado por tests en validation/diagnostics.js.
const STEPS = Object.freeze(ONBOARDING_MILESTONES.map((m) => m.step));

// ── Copia y opciones ───────────────────────────────────────────────────────
// Los VALORES de goal/content_preferences vienen de los enums compartidos de
// marketing-ui.js (que a su vez espejan los Literal[...] del backend en
// routers/marketing.py). Acá abajo vive solo el texto visible que todavía no
// estaba exportado desde ningún módulo JS; en todos los casos es la copia
// EXACTA que ya muestra el formulario estático de cuenta.html, para que las
// dos superficies digan lo mismo.

// cuenta.html → fieldset.marketing-preference-set (inputs name="marketing-content").
const CONTENT_LABELS = Object.freeze({
  guides_exercises: 'Guías y ejercicios',
  product_updates: 'Novedades del producto',
  educational_content: 'Contenido educativo',
  offers: 'Ofertas',
  community: 'Comunidad',
});

// cuenta.html → #marketing-discovery-form (inputs name="topic"). Esta encuesta
// no tiene lista de opciones en marketing-ui.js: su única fuente previa era
// ese markup + el enum `selected_topics` del backend. Mismo orden, mismo texto.
const DISCOVERY_TOPICS = Object.freeze([
  ['premium', 'Planes y funciones Premium'],
  ['alarms', 'Alarmas y recordatorios'],
  ['itineraries', 'Rutinas e itinerarios'],
  ['new_content', 'Contenido nuevo'],
  ['pricing', 'Precios y formas de pago'],
  ['onboarding', 'Ayuda para comenzar'],
  ['other', 'Otros temas del producto'],
]);

// cuenta.html → <select id="marketing-rating">.
const RATING_LABELS = Object.freeze({
  1: 'Poco satisfecho',
  2: 'Algo insatisfecho',
  3: 'Ni satisfecho ni insatisfecho',
  4: 'Satisfecho',
  5: 'Muy satisfecho',
});

const MAX_CONTENT_PREFERENCES = 5; // backend: Field(max_length=5)

const STEP_META = Object.freeze({
  goal: {
    title: '¿Qué te gustaría lograr con Vyneural?',
    hint: 'Elige lo que más se acerque. Puedes cambiarlo cuando quieras desde tu cuenta.',
    cta: 'Guardar',
  },
  content_preferences: {
    title: '¿Qué contenido te gustaría ver?',
    hint: `Puedes elegir hasta ${MAX_CONTENT_PREFERENCES} temas.`,
    cta: 'Guardar',
  },
  discovery: {
    title: '¿Qué te interesa encontrar?',
    hint: 'Marca los temas que te servirían. Responder esto no activa correos.',
    cta: 'Enviar',
  },
  satisfaction: {
    title: '¿Qué tan satisfecho estás con Vyneural?',
    hint: '1 = poco, 5 = mucho. Nos sirve para decidir qué mejorar.',
    cta: 'Enviar',
  },
});

// ── Shell del modal ────────────────────────────────────────────────────────

function shellHTML() {
  return `
  <div class="page-modal hidden" id="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-modal-title">
    <div class="page-modal-card ob-card">
      <div class="page-modal-head">
        <h3 id="onboarding-modal-title"></h3>
        <button type="button" class="page-modal-close" id="onboarding-modal-close" aria-label="Cerrar">✕</button>
      </div>
      <div class="ob-steps hidden" id="onboarding-modal-steps">
        <span class="ob-steps-label" id="onboarding-modal-progress" aria-live="polite"></span>
        <span class="ob-dots" id="onboarding-modal-dots" aria-hidden="true"></span>
      </div>
      <div class="ob-body" id="onboarding-modal-body"></div>
      <div class="auth-error hidden" id="onboarding-modal-error" role="alert"></div>
      <div class="ob-actions">
        <button type="button" class="cuenta-btn cuenta-btn-ghost ob-secondary" id="onboarding-modal-secondary"></button>
        <button type="button" class="cuenta-btn ob-primary" id="onboarding-modal-primary"></button>
      </div>
    </div>
  </div>`;
}

const el = (id) => document.getElementById(id);

let injected = false;

// Sesión abierta. null = modal cerrado.
// { mode: 'milestone' | 'edit', phase: 'step' | 'loading' | 'error',
//   steps: string[], index: number, step: string, profile: object | null,
//   onResolved: fn | null, control: object | null, busy: boolean,
//   direction: 'forward' | 'back', celebrated: boolean }
let current = null;

function inject() {
  if (injected) return;
  injected = true;
  const wrap = document.createElement('div');
  wrap.innerHTML = shellHTML();
  document.body.appendChild(wrap.firstElementChild);

  el('onboarding-modal-close').addEventListener('click', () => dismiss());
  const modal = el('onboarding-modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) dismiss();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current && !current.busy) dismiss();
  });
  el('onboarding-modal-primary').addEventListener('click', onPrimary);
  el('onboarding-modal-secondary').addEventListener('click', onSecondary);
  // Un solo listener delegado para todo el cuerpo: los renderers crean sus
  // inputs y se van, no hay que desuscribir nada al cambiar de paso.
  el('onboarding-modal-body').addEventListener('change', syncPrimary);
}

function showError(text) {
  const box = el('onboarding-modal-error');
  if (!box) return;
  box.textContent = text;
  box.classList.toggle('hidden', !text);
}

function clearError() {
  showError('');
}

/** Cierra el modal. `result` solo importa en modo hito: es lo que recibe
 *  onResolved ('answered' | 'skipped'). Se invoca UNA sola vez por sesión
 *  (current se anula antes de llamar al callback). */
function closeModal(result) {
  const session = current;
  current = null;
  const modal = el('onboarding-modal');
  if (modal) modal.classList.add('hidden');
  const body = el('onboarding-modal-body');
  if (body) body.replaceChildren();
  clearError();
  if (session && typeof session.onResolved === 'function') {
    try {
      session.onResolved(result === 'answered' ? 'answered' : 'skipped');
    } catch (_) {
      /* el callback es del orquestador (persistir estado local): que falle
         no debe dejar el modal a medio cerrar */
    }
  }
}

/** ✕ / backdrop / Escape: en un hito cuenta como "Ahora no". */
function dismiss() {
  if (!current || current.busy) return;
  closeModal('skipped');
}

// ── Renderers de pasos ─────────────────────────────────────────────────────
// Cada uno devuelve un "control" con la misma interfaz:
//   getValue()  → el valor a enviar
//   isEmpty()   → true si el usuario no eligió nada
//   isDirty()   → true si cambió respecto a lo que se mostró al abrir
//   focus()     → foco inicial del paso

function applyStagger(container) {
  // Entrada escalonada de las opciones: puro adorno, así que se omite con
  // prefers-reduced-motion (el fadeUp del paso completo sí se queda: es una
  // transición funcional breve, igual que el authFade de .page-modal).
  if (!prefersReducedMotion()) container.classList.add('ob-stagger');
}

function renderGoal(host, profile) {
  const initial = typeof profile?.goal === 'string' ? profile.goal : null;
  const pills = document.createElement('div');
  pills.className = 'ob-pills';
  pills.setAttribute('role', 'radiogroup');
  pills.setAttribute('aria-label', STEP_META.goal.title);
  MARKETING_GOALS.forEach((value, i) => {
    const label = document.createElement('label');
    label.className = 'ob-pill';
    label.style.setProperty('--ob-i', String(i));
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'ob-goal';
    input.value = value;
    input.checked = value === initial;
    const text = document.createElement('span');
    text.textContent = marketingGoalLabel(value) || value;
    label.append(input, text);
    pills.appendChild(label);
  });
  applyStagger(pills);
  host.appendChild(pills);

  const read = () => pills.querySelector('input:checked')?.value || null;
  return {
    getValue: read,
    isEmpty: () => !read(),
    isDirty: () => read() !== initial,
    focus: () => (pills.querySelector('input:checked') || pills.querySelector('input'))?.focus(),
  };
}

function renderChecklist(host, { options, initial, max, name, hintEl, baseHint }) {
  const initialSet = new Set(Array.isArray(initial) ? initial : []);
  const grid = document.createElement('div');
  grid.className = 'marketing-topic-grid ob-grid';
  options.forEach(([value, text], i) => {
    const label = document.createElement('label');
    label.style.setProperty('--ob-i', String(i));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = value;
    input.checked = initialSet.has(value);
    label.append(input, document.createTextNode(` ${text}`));
    grid.appendChild(label);
  });
  applyStagger(grid);
  host.appendChild(grid);

  const inputs = () => [...grid.querySelectorAll('input[type="checkbox"]')];
  const read = () => inputs().filter((i) => i.checked).map((i) => i.value);
  const key = (list) => [...list].sort().join(',');

  const enforceMax = () => {
    if (!max) return;
    const atMax = read().length >= max;
    // Tope del backend (max_length): se bloquea en el cliente para que el
    // usuario no descubra el límite recién con un 422.
    inputs().forEach((input) => {
      input.disabled = atMax && !input.checked;
    });
    if (hintEl) {
      hintEl.textContent = atMax
        ? `Llegaste al máximo de ${max} temas. Desmarca uno para cambiarlo.`
        : baseHint;
      hintEl.classList.toggle('ob-hint-warn', atMax);
    }
  };
  grid.addEventListener('change', enforceMax);
  enforceMax();

  return {
    getValue: read,
    isEmpty: () => read().length === 0,
    isDirty: () => key(read()) !== key(initialSet),
    focus: () => inputs()[0]?.focus(),
  };
}

function renderRating(host) {
  let value = null;
  const row = document.createElement('div');
  row.className = 'ob-rating';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', STEP_META.satisfaction.title);
  const caption = document.createElement('p');
  caption.className = 'rutina-hint ob-rating-caption';
  caption.setAttribute('aria-live', 'polite');
  caption.textContent = 'Sin calificación todavía.';

  const buttons = [];
  const paint = () => {
    buttons.forEach((btn, i) => {
      const on = value !== null && i < value;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(value === i + 1));
    });
    caption.textContent = value === null
      ? 'Sin calificación todavía.'
      : `${value} — ${RATING_LABELS[value]}`;
  };

  for (let n = 1; n <= 5; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ob-rating-btn';
    btn.style.setProperty('--ob-i', String(n - 1));
    btn.textContent = '★';
    btn.setAttribute('aria-label', `${n} — ${RATING_LABELS[n]}`);
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      value = n;
      paint();
      syncPrimary();
    });
    buttons.push(btn);
    row.appendChild(btn);
  }
  applyStagger(row);
  host.append(row, caption);
  paint();

  return {
    getValue: () => value,
    isEmpty: () => value === null,
    isDirty: () => value !== null,
    focus: () => buttons[0]?.focus(),
  };
}

function renderStepBody(step, profile) {
  const body = el('onboarding-modal-body');
  body.replaceChildren();
  const meta = STEP_META[step];

  // Nodo nuevo en cada render: la animación de entrada corre sola al
  // montarse, sin tener que forzar un reflow para reiniciarla.
  const wrap = document.createElement('div');
  wrap.className = current?.direction === 'back' ? 'ob-step ob-enter-back' : 'ob-step ob-enter';

  const hint = document.createElement('p');
  hint.className = 'rutina-hint ob-hint';
  hint.textContent = meta.hint;
  wrap.appendChild(hint);

  let control;
  if (step === 'goal') {
    control = renderGoal(wrap, profile);
  } else if (step === 'content_preferences') {
    control = renderChecklist(wrap, {
      options: MARKETING_CONTENT_PREFERENCES.map((v) => [v, CONTENT_LABELS[v] || v]),
      initial: Array.isArray(profile?.content_preferences) ? profile.content_preferences : [],
      max: MAX_CONTENT_PREFERENCES,
      name: 'ob-content',
      hintEl: hint,
      baseHint: meta.hint,
    });
  } else if (step === 'discovery') {
    control = renderChecklist(wrap, {
      options: DISCOVERY_TOPICS,
      initial: [],
      max: null,
      name: 'ob-topic',
      hintEl: hint,
      baseHint: meta.hint,
    });
  } else {
    control = renderRating(wrap);
  }

  body.appendChild(wrap);
  return control;
}

// ── Guardado ───────────────────────────────────────────────────────────────

/** Arma el body del PATCH /marketing/profile.
 *
 *  CRÍTICO (backend: routers/marketing.py::update_marketing_profile, el
 *  `if field == "content_preferences" or field in body.model_fields_set`):
 *  `content_preferences` se sobreescribe en TODAS las llamadas, esté o no en
 *  el request — omitirlo o mandar [] borra lo que el usuario ya tenía
 *  guardado. Por eso el paso "goal" manda igual el array ACTUAL completo,
 *  aunque la pregunta que se está respondiendo no sea esa. NO "simplificar"
 *  esto a `{ goal }`: sería una pérdida de datos silenciosa.
 *
 *  `goal`, en cambio, solo se sobreescribe si viene en el request. Si no
 *  conocemos el valor actual (perfil que no se pudo leer) se OMITE la clave:
 *  mandar `goal: null` ahí borraría un objetivo ya elegido. */
function profilePatchPayload(goal, contentPreferences) {
  const payload = marketingProfileUpdatePayload(goal, contentPreferences);
  if (payload.goal === null && (goal === null || goal === undefined)) delete payload.goal;
  return payload;
}

async function persistProfileStep(session, step, value) {
  let profile = session.profile && typeof session.profile === 'object' ? session.profile : null;
  if (!profile) {
    if (step === 'goal') {
      // Obligatorio: sin el content_preferences actual no se puede guardar el
      // objetivo sin borrar los temas (ver profilePatchPayload). Si esta
      // lectura falla, el error se propaga y NO se hace el PATCH.
      profile = await getMarketingProfile();
    } else {
      // Acá el array lo aporta el usuario; el perfil solo sirve para no
      // perder el `goal`, y su ausencia ya se maneja omitiendo la clave.
      try {
        profile = await getMarketingProfile();
      } catch (_) {
        profile = null;
      }
    }
    session.profile = profile;
  }
  const currentPrefs = Array.isArray(profile?.content_preferences) ? profile.content_preferences : [];
  const currentGoal = typeof profile?.goal === 'string' ? profile.goal : null;
  const goal = step === 'goal' ? value : currentGoal;
  const prefs = step === 'content_preferences' ? value : currentPrefs;

  const saved = await updateMarketingProfile(profilePatchPayload(goal, prefs));
  // Estado en memoria al día: los pasos siguientes de showEditFlow arman su
  // payload desde acá, nunca desde el snapshot inicial.
  session.profile = saved && typeof saved === 'object'
    ? saved
    : { ...(profile || {}), goal, content_preferences: prefs };
}

async function persistStep(session, step, value) {
  if (step === 'goal' || step === 'content_preferences') {
    await persistProfileStep(session, step, value);
    return;
  }
  if (step === 'discovery') {
    await submitMarketingSurvey({
      survey_type: 'discovery',
      selected_topics: value,
      source: 'account',
    });
    return;
  }
  await submitMarketingSurvey({ survey_type: 'satisfaction', rating: value, source: 'account' });
}

/** Mismo criterio que cuenta.js (`err?.detail || '<mensaje propio>'`): el
 *  backend manda `detail` como string presentable en los errores que escribe
 *  a mano, y api/client.js solo expone .detail cuando ES un string.
 *  El 429 se distingue porque es el único "no fue un error tuyo, vuelve
 *  después": /marketing/surveys corta a 3 encuestas por día CONTANDO los dos
 *  tipos juntos, así que se puede llegar al tope sin haber respondido nunca
 *  esta pregunta. */
function errorMessage(err, fallback) {
  if (err && err.status === 429) {
    const base = err.detail || 'Alcanzaste el límite diario de encuestas';
    return `${base}. Puedes responder esto mañana; no perdiste nada.`;
  }
  return (err && err.detail) || fallback;
}

const SAVE_FALLBACK = Object.freeze({
  goal: 'No se pudo guardar tu objetivo. Inténtalo otra vez.',
  content_preferences: 'No se pudieron guardar tus preferencias. Inténtalo otra vez.',
  discovery: 'No se pudieron enviar tus temas. Inténtalo otra vez.',
  satisfaction: 'No se pudo enviar tu opinión. Inténtalo otra vez.',
});

// ── Botonera / render de paso ──────────────────────────────────────────────

function setBusy(busy) {
  if (!current) return;
  current.busy = busy;
  const primary = el('onboarding-modal-primary');
  const secondary = el('onboarding-modal-secondary');
  const close = el('onboarding-modal-close');
  if (close) close.disabled = busy;
  if (secondary) secondary.disabled = busy || secondary.dataset.offDisabled === '1';
  if (primary) {
    primary.disabled = busy;
    if (busy) {
      primary.dataset.label = primary.textContent;
      primary.textContent = 'Guardando…';
    } else if (primary.dataset.label) {
      primary.textContent = primary.dataset.label;
      delete primary.dataset.label;
    }
  }
  if (!busy) syncPrimary();
}

/** En un hito la acción principal no tiene sentido sin respuesta (para eso
 *  está "Ahora no"); en el editor nunca se bloquea: avanzar sin contestar un
 *  paso es válido. */
function syncPrimary() {
  if (!current || current.busy || current.phase !== 'step') return;
  const primary = el('onboarding-modal-primary');
  if (!primary) return;
  primary.disabled = current.mode === 'milestone' && !!current.control?.isEmpty();
}

function renderSteps() {
  const wrap = el('onboarding-modal-steps');
  const dots = el('onboarding-modal-dots');
  const progress = el('onboarding-modal-progress');
  const multi = current.mode === 'edit' && current.steps.length > 1;
  wrap.classList.toggle('hidden', !multi);
  if (!multi) return;
  progress.textContent = `Paso ${current.index + 1} de ${current.steps.length}`;
  dots.replaceChildren();
  current.steps.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'ob-dot';
    if (i === current.index) dot.classList.add('is-active');
    else if (i < current.index) dot.classList.add('is-done');
    dots.appendChild(dot);
  });
}

function renderStep() {
  if (!current) return;
  current.phase = 'step';
  current.step = current.steps[current.index];
  clearError();
  el('onboarding-modal-title').textContent = STEP_META[current.step].title;
  renderSteps();
  current.control = renderStepBody(current.step, current.profile);

  const primary = el('onboarding-modal-primary');
  const secondary = el('onboarding-modal-secondary');
  const last = current.index === current.steps.length - 1;
  if (current.mode === 'edit') {
    primary.textContent = last ? 'Listo' : 'Siguiente';
    secondary.textContent = 'Atrás';
    secondary.dataset.offDisabled = current.index === 0 ? '1' : '0';
  } else {
    primary.textContent = STEP_META[current.step].cta;
    secondary.textContent = 'Ahora no';
    secondary.dataset.offDisabled = '0';
  }
  secondary.disabled = secondary.dataset.offDisabled === '1';
  syncPrimary();
  current.control?.focus();
}

function renderMessage({ title, text, primaryLabel, secondaryLabel, phase }) {
  current.phase = phase;
  current.control = null;
  clearError();
  el('onboarding-modal-title').textContent = title;
  el('onboarding-modal-steps').classList.add('hidden');
  const body = el('onboarding-modal-body');
  body.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'ob-step ob-enter';
  const p = document.createElement('p');
  p.className = 'rutina-hint ob-hint';
  p.textContent = text;
  wrap.appendChild(p);
  body.appendChild(wrap);
  const primary = el('onboarding-modal-primary');
  const secondary = el('onboarding-modal-secondary');
  primary.textContent = primaryLabel;
  primary.disabled = phase === 'loading';
  secondary.textContent = secondaryLabel;
  secondary.dataset.offDisabled = '0';
  secondary.disabled = false;
}

function openShell() {
  el('onboarding-modal').classList.remove('hidden');
}

// ── Acciones ───────────────────────────────────────────────────────────────

async function onPrimary() {
  if (!current || current.busy) return;
  if (current.phase === 'loading') return;
  if (current.phase === 'error') {
    loadEditProfile(current);
    return;
  }
  const session = current;
  const { step, control } = session;
  if (!control) return;

  if (session.mode === 'milestone') {
    if (control.isEmpty()) return;
    clearError();
    setBusy(true);
    try {
      await persistStep(session, step, control.getValue());
    } catch (err) {
      if (current === session) {
        setBusy(false);
        showError(errorMessage(err, SAVE_FALLBACK[step]));
      }
      return;
    }
    if (current !== session) return;
    setBusy(false);
    // Un solo momento de celebración: el hito es UNA pregunta y esta es su
    // única confirmación visible antes de cerrarse. En showEditFlow el burst
    // se reserva para el "Listo" final (ver abajo), para no festejar cuatro
    // veces seguidas.
    celebrateBurst(el('onboarding-modal-primary'));
    closeModal('answered');
    return;
  }

  // Editor: cada paso guarda lo suyo al avanzar (no se batchea al final).
  // Si no hubo cambios, no se gasta una llamada. Un valor vacío solo se
  // manda para content_preferences, donde "ninguno" es una elección real
  // (quitar todos los temas); en goal no hay forma de desmarcar, y las
  // encuestas rechazan un envío vacío del lado del backend.
  const dirty = control.isDirty();
  const sendEmpty = step === 'content_preferences';
  if (dirty && (!control.isEmpty() || sendEmpty)) {
    clearError();
    setBusy(true);
    try {
      await persistStep(session, step, control.getValue());
    } catch (err) {
      if (current === session) {
        setBusy(false);
        showError(errorMessage(err, SAVE_FALLBACK[step]));
      }
      return;
    }
    if (current !== session) return;
    setBusy(false);
    if (step === 'discovery' || step === 'satisfaction') {
      // showEditFlow no pasa por handleResolved() (eso solo corre para
      // showMilestoneStep, vía onResolved) — sin esto, cuenta.js sigue
      // mostrando "Sin responder todavía" para estas dos encuestas aunque el
      // submitMarketingSurvey de arriba ya haya tenido éxito contra el
      // backend (no hay endpoint de lectura para encuestas pasadas).
      const localState = loadState();
      localState.answered = localState.answered || {};
      localState.answered[step] = true;
      saveState(localState);
    }
  }

  if (session.index >= session.steps.length - 1) {
    celebrateBurst(el('onboarding-modal-primary'));
    closeModal(null);
    return;
  }
  session.index += 1;
  session.direction = 'forward';
  renderStep();
}

function onSecondary() {
  if (!current || current.busy) return;
  if (current.phase !== 'step' || current.mode === 'milestone') {
    closeModal('skipped');
    return;
  }
  if (current.index === 0) return;
  current.index -= 1;
  current.direction = 'back';
  renderStep();
}

// ── Entradas públicas ──────────────────────────────────────────────────────

/**
 * Muestra UN paso de onboarding (un hito por cantidad de sesiones).
 *
 * @param {'goal'|'content_preferences'|'discovery'|'satisfaction'} step
 * @param {{ profile?: object|null, onResolved?: (result: 'answered'|'skipped') => void }} opts
 *   `profile` es el perfil de marketing YA leído por el orquestador (puede
 *   venir null: la lectura es best-effort allá, y los pasos de encuesta no lo
 *   necesitan). onResolved recibe 'answered' tras un guardado exitoso, o
 *   'skipped' si se usó "Ahora no" / se cerró el modal sin responder.
 */
export function showMilestoneStep(step, { profile = null, onResolved = null } = {}) {
  if (!STEPS.includes(step)) return; // paso desconocido: no-op silencioso
  inject();
  // No dejar colgado el callback de una sesión anterior (mismo criterio que
  // confirm-modal.js cuando lo reemplazan con uno abierto).
  if (current) closeModal('skipped');
  current = {
    mode: 'milestone',
    phase: 'step',
    steps: [step],
    index: 0,
    step,
    profile: profile && typeof profile === 'object' ? profile : null,
    onResolved: typeof onResolved === 'function' ? onResolved : null,
    control: null,
    busy: false,
    direction: 'forward',
  };
  openShell();
  renderStep();
}

function loadEditProfile(session) {
  renderMessage({
    phase: 'loading',
    title: 'Tus preferencias',
    text: 'Cargando lo que tienes guardado…',
    primaryLabel: 'Siguiente',
    secondaryLabel: 'Cerrar',
  });
  return getMarketingProfile()
    .then((profile) => {
      if (current !== session) return; // se cerró mientras cargaba
      session.profile = profile && typeof profile === 'object' ? profile : {};
      session.index = initialIndex(session.requestedStep, session.profile);
      session.direction = 'forward';
      renderStep();
    })
    .catch((err) => {
      if (current !== session) return;
      // Sin el perfil actual NO se puede hacer el PATCH sin arriesgar borrar
      // content_preferences (ver profilePatchPayload), así que el editor no
      // arranca: se ofrece reintentar en vez de guardar a ciegas.
      renderMessage({
        phase: 'error',
        title: 'Tus preferencias',
        text: errorMessage(err, 'No pudimos cargar tus preferencias actuales. Inténtalo otra vez.'),
        primaryLabel: 'Reintentar',
        secondaryLabel: 'Cerrar',
      });
    });
}

function initialIndex(requestedStep, profile) {
  const requested = STEPS.indexOf(requestedStep);
  if (requested >= 0) return requested;
  // "Primer paso sin responder": del perfil solo se puede deducir goal y
  // content_preferences (las encuestas son histórico aparte, no estado), así
  // que si esos dos ya están se arranca por el principio.
  if (!profile?.goal) return STEPS.indexOf('goal');
  const prefs = profile?.content_preferences;
  if (!Array.isArray(prefs) || prefs.length === 0) return STEPS.indexOf('content_preferences');
  return 0;
}

/**
 * Editor completo: los 4 pasos en un stepper ("Atrás" / "Siguiente", "Listo"
 * en el último), cada respuesta guardada con su propia llamada al avanzar.
 * Pensado para el botón "Editar preferencias" de /cuenta: no reporta nada al
 * cerrarse, el llamador simplemente vuelve a leer su propio estado.
 *
 * @param {'goal'|'content_preferences'|'discovery'|'satisfaction'=} initialStep
 *   Paso inicial. Si no se pasa (o no es válido), arranca en el primero sin
 *   responder según el perfil, o en 'goal'.
 */
export function showEditFlow(initialStep) {
  inject();
  if (current) closeModal('skipped');
  const session = {
    mode: 'edit',
    phase: 'loading',
    steps: [...STEPS],
    index: 0,
    step: STEPS[0],
    requestedStep: initialStep,
    profile: null,
    onResolved: null,
    control: null,
    busy: false,
    direction: 'forward',
  };
  current = session;
  openShell();
  return loadEditProfile(session);
}
