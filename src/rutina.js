// ── Página "Tu rutina" ───────────────────────────────────────────────────────
// Muestra los recordatorios/rituales guardados (los mismos que el generador
// persiste en localStorage bajo vyneural_alarms) con su repetición semanal,
// frecuencia y próxima ocurrencia. Permite eliminar; dentro de la APK también
// cancela la alarma nativa del AlarmManager (CANCEL_ALARM vía bridge).
//
// Desde 1.2, la rutina UNIFICA recordatorios + itinerarios: un itinerario ES
// una rutina de pasos (frecuencias en secuencia con su duración). Los
// itinerarios viven en la nube (cuenta opcional); sin cuenta o sin backend,
// la página sigue funcionando con los recordatorios locales y un aviso.
//
// REGLA DE ORO (APK): "Iniciar" un itinerario NUNCA autoplaya. El enlace
// lleva al generador configurado (freq/beat/wave) SIN autostart: el audio
// nace solo con un gesto explícito del usuario (P5.1/P5.6).

import { getAccessToken, notifyNativeAlarmsChanged } from './api/client.js';
import { listItineraries, createItinerary, updateItinerary, deleteItinerary, reorderItineraryItems } from './api/itineraries.js';
import { listFrequencies, createFrequency } from './api/frequencies.js';
import { createAlarm } from './api/alarms.js';
import { freqCoverSVG } from './ui/freq-cover.js';
import { AlarmManager, createDurableStore } from './core/alarm-manager.js';
import { getAlarms, saveAlarms, fireAlarm, rruleFor, nextAlarmAt, requestPermission } from './notifications.js';
import { createNativeBridgeAdapter } from './platform/native-bridge.js';
import { PROFILES } from './models/profiles.js';
import { carrierBaseFor } from './core/carrier.js';

// Sanitización: los nombres de frecuencias/itinerarios vienen del usuario
// (backend), nunca se inyectan sin escapar.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DAY_LETTERS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const DAY_NAMES = [
  'domingo', 'lunes', 'martes', 'miércoles',
  'jueves', 'viernes', 'sábado',
];

// Mismo adaptador que usa el generador (src/main.js) para el bridge nativo:
// getAlarms/saveAlarms (arriba) ya vienen de notifications.js, así que la
// rutina y el generador leen/escriben exactamente el mismo espejo.
const nativeBridge = createNativeBridgeAdapter();

function cancelNativeAlarm(alarmId) {
  if (nativeBridge.present) nativeBridge.cancelAlarm(alarmId);
}

function daysLabel(days) {
  if (!days || days.length === 0) return 'Solo una vez';
  if (days.length === 7) return 'Todos los días';
  const ordered = [...days].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
  return ordered.map((d) => DAY_LETTERS[d]).join(' · ');
}

function daysNames(days) {
  if (!days || days.length === 0) return 'Solo una vez';
  if (days.length === 7) return 'todos los días';
  const ordered = [...days].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
  return ordered.map((d) => DAY_NAMES[d]).join(', ');
}

function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString();
  if (d.toDateString() === today) return 'hoy';
  const tomorrow = new Date(Date.now() + 86400000).toDateString();
  if (d.toDateString() === tomorrow) return 'mañana';
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
}

// La rutina (repetición por días, página incluida) es EXCLUSIVA de la APK de
// Android: solo el reloj del sistema puede reprogramar alarmas con la app
// cerrada. En web/PWA la página muestra un aviso honesto en lugar de la lista.
// `?apk=1` fuerza la vista APK en el navegador SOLO para desarrollo/pruebas
// (simula el bridge): en producción el check real es AndroidBridgeNative.
const IN_APK =
  typeof window !== 'undefined' &&
  (typeof window.AndroidBridgeNative !== 'undefined' ||
    location.protocol === 'file:' ||
    new URLSearchParams(location.search).has('apk'));

const listEl = document.getElementById('rutina-list');
const emptyEl = document.getElementById('rutina-empty');
const countEl = document.getElementById('rutina-count');
const itListEl = document.getElementById('rutina-it-list');
const itEmptyEl = document.getElementById('rutina-it-empty');
const itCountEl = document.getElementById('rutina-it-count');
const itSyncEl = document.getElementById('rutina-it-sync');

// ── Itinerarios (la rutina de pasos, unificada) ─────────────────────────────

// El ambiente (lluvia/río/etc.) que se haya elegido al personalizar la
// frecuencia (ver wireItCustomPanel > it-custom-save) viaja en su config —
// a diferencia de "condition", esto SÍ suena distinto, así que "Iniciar"
// desde el itinerario tiene que reproducir el mismo paisaje sonoro.
function freqAmbient(freq) {
  const amb = freq && freq.config && Array.isArray(freq.config.ambient) ? freq.config.ambient : [];
  return amb.filter((a) => typeof a === 'string' && a);
}

function freqUrlParams(freq) {
  const base = freq ? (freq.left_frequency != null ? freq.left_frequency : freq.carrier_frequency) : 220;
  const beat = freq ? freq.beat_frequency : 10;
  const wave = freq ? freq.waveform : 'sine';
  const q = new URLSearchParams();
  if (base != null) q.set('freq', String(base));
  if (beat != null) q.set('beat', String(beat));
  q.set('wave', wave || 'sine');
  const ambient = freqAmbient(freq);
  if (ambient.length) q.set('ambient', ambient.join(','));
  // Sin autostart: el usuario toca play (nunca audio espontáneo).
  return q.toString();
}

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  if (s === 0) return 'sin duración';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function stepLabel(item) {
  const f = savedFreqsMap.get(item.frequency_id);
  const base = f ? (f.left_frequency != null ? f.left_frequency : f.carrier_frequency) : null;
  return {
    name: f ? f.name : 'Frecuencia',
    base,
    beat: f ? (f.beat_frequency != null ? f.beat_frequency : 10) : 10,
    wave: f && f.waveform ? f.waveform : 'sine',
    dur: item.duration || 0,
    freq: f || null,
  };
}

// Lunes → domingo (0=domingo, se muestra al final).
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Horario real del paso (hora de reloj), a diferencia del offset acumulado
// que ya calcula la línea de tiempo. Si tiene horario, el paso tiene una
// alarma de recordatorio (Web Push) sincronizada en el backend — la
// repetición semanal (o "una vez") la calcula el backend según el día del
// ITINERARIO (item.repeat_rule ya viene derivado, no se elige por paso).
function scheduleLabel(item) {
  if (!item.time_of_day) return '';
  const when = item.repeat_rule ? `${item.time_of_day} · se repite` : `${item.time_of_day} · una vez`;
  return ` · 🔔 ${when}`;
}

// Enlace de reproducción secuencial: el generador recibe la secuencia completa
// (?seq=…) además de la primera frecuencia. NUNCA autoplay: la barra llega en
// pausa y el countdown corre solo con el play del usuario.
function seqUrlParams(items, name) {
  const steps = items
    .map((item) => {
      const s = stepLabel(item);
      return {
        n: s.name,
        base: s.base != null ? Math.round(s.base * 10) / 10 : 220,
        beat: s.beat != null ? Math.round(s.beat * 10) / 10 : 10,
        wave: s.wave || 'sine',
        dur: Math.max(0, Math.round(s.dur || 0)),
      };
    })
    .filter((s) => s.dur > 0);
  if (!steps.length) return '';
  return `&seq=${encodeURIComponent(JSON.stringify({ name, steps }))}`;
}

// Los pasos de UN itinerario, en orden, con reordenamiento manual (↑/↓): el
// día ya no vive acá (es de todo el itinerario, ver dayBlockHTML/renderItineraries),
// así que todos los pasos son simplemente su secuencia interna.
function itineraryStepsHTML(items, itId) {
  let cursor = 0;
  const rows = items.map((item, i) => {
    const s = stepLabel(item);
    const start = cursor;
    cursor += s.dur;
    const durLabel = s.dur > 0 ? fmtDuration(s.dur) : 'sin duración';
    const clock = s.dur > 0 ? ` · ${fmtClock(start)} → ${fmtClock(cursor)}` : '';
    const hz = s.base != null ? ` · ${Math.round(s.base)} Hz` : '';
    const schedule = scheduleLabel(item);
    const canUp = i > 0;
    const canDown = i < items.length - 1;
    return `<div class="rutina-step">
        <span class="rutina-step-n">${i + 1}</span>
        ${freqCoverSVG(s.freq || { waveform: s.wave }, 28)}
        <span class="rutina-step-body">
          <b>${escapeHtml(s.name)}</b>
          <small>${durLabel}${clock}${hz}${schedule}</small>
        </span>
        <span class="rutina-step-reorder">
          <button type="button" class="reorder-btn" data-reorder="up" data-it="${escapeHtml(itId)}" data-step="${escapeHtml(item.id)}"${canUp ? '' : ' disabled'} aria-label="Subir el paso ${i + 1}">↑</button>
          <button type="button" class="reorder-btn" data-reorder="down" data-it="${escapeHtml(itId)}" data-step="${escapeHtml(item.id)}"${canDown ? '' : ' disabled'} aria-label="Bajar el paso ${i + 1}">↓</button>
        </span>
      </div>`;
  }).join('');
  return rows || '<p class="rutina-empty-inline">Sin pasos: funciona como aviso de horario.</p>';
}

// Cabecera + pasos de UN itinerario, reutilizada tanto en su bloque del día
// (semana) como en la lista de itinerarios sueltos (sin día).
function itineraryCardHTML(it, { compact } = {}) {
  const items = (it.items || []).slice().sort((a, b) => a.position - b.position);
  const startHref = items.length
    ? `/?${freqUrlParams(firstFrequency(items))}${seqUrlParams(items, it.name || 'Rutina')}`
    : '/#states-grid';
  const paused = it.is_active === false ? ' <em>(en pausa)</em>' : '';
  const meta = compact
    ? ''
    : `<div class="rutina-meta">${[
        it.is_active === false ? 'en pausa' : 'activo',
        items.length ? fmtDuration(items.reduce((acc, x) => acc + (x.duration || 0), 0)) : 'sin duración fija',
        it.timezone || 'UTC',
      ].join(' · ')}</div>`;
  return `<div class="rutina-card-head">
      <span class="rutina-card-name">${escapeHtml(it.name || 'Itinerario')}${paused}</span>
      <span class="rutina-card-actions">
        <button type="button" class="rutina-edit-btn" data-edit="${escapeHtml(it.id)}" aria-label="Editar ${escapeHtml(it.name || 'itinerario')}">✎</button>
        <button type="button" class="rutina-edit-btn" data-del-it="${escapeHtml(it.id)}" aria-label="Eliminar ${escapeHtml(it.name || 'itinerario')}">✕</button>
        <a class="rutina-start${compact ? ' rutina-start-sm' : ''}" href="${escapeHtml(startHref)}">Iniciar</a>
      </span>
    </div>
    ${meta}
    <div class="rutina-timeline" data-it="${escapeHtml(it.id)}">${itineraryStepsHTML(items, it.id)}</div>`;
}

// Rango de horas a mostrar: siempre cubre 6→23 (toda la tarde/noche) como
// guía mínima, y se extiende si hay pasos agendados fuera de esa ventana
// (p. ej. algo de madrugada). Antes el margen era de solo 1 h sobre el
// último paso agendado, así que un paso a las 21 h cortaba la grilla en
// las 22:00 y escondía el resto de la noche.
function computeHourRange(byDay) {
  let minH = 6;
  let maxH = 23;
  byDay.forEach((it) => {
    (it.items || []).forEach((item) => {
      if (!item.time_of_day) return;
      const h = parseInt(item.time_of_day.slice(0, 2), 10);
      if (Number.isFinite(h)) {
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    });
  });
  return { start: Math.max(0, minH), end: Math.min(23, maxH) };
}

// Horario real: columnas = días (L→D), filas = horas, cada sesión ubicada en
// su horario. Los pasos sin horario no tienen dónde ir en esta grilla — se
// cuentan en la cabecera del día ("+N sin horario"); se editan/ven completos
// desde "Editar" (misma lista de pasos que ya mostraba /cuenta).
function weekGridHTML(byDay) {
  const { start, end } = computeHourRange(byDay);
  const hours = [];
  for (let h = start; h <= end; h++) hours.push(h);

  const headerCells = WEEK_ORDER.map((day) => {
    const it = byDay.get(day);
    if (!it) {
      return `<div class="wg-day-head wg-day-head-empty">
          <span class="wg-day-name">${DAY_NAMES[day].slice(0, 3)}</span>
          <button type="button" class="wg-icon-btn" data-add-day="${day}" aria-label="Crear itinerario para ${DAY_NAMES[day]}">＋</button>
        </div>`;
    }
    const items = (it.items || []).slice().sort((a, b) => a.position - b.position);
    const startHref = items.length
      ? `/?${freqUrlParams(firstFrequency(items))}${seqUrlParams(items, it.name || 'Rutina')}`
      : null;
    const noTimeCount = items.filter((i) => !i.time_of_day).length;
    return `<div class="wg-day-head">
        <span class="wg-day-name">${DAY_NAMES[day].slice(0, 3)}</span>
        <span class="wg-day-title" title="${escapeHtml(it.name || '')}">${escapeHtml(it.name || '')}</span>
        <span class="wg-day-actions">
          <button type="button" class="wg-icon-btn" data-edit="${escapeHtml(it.id)}" aria-label="Editar ${escapeHtml(it.name || '')}">✎</button>
          <button type="button" class="wg-icon-btn" data-del-it="${escapeHtml(it.id)}" aria-label="Eliminar ${escapeHtml(it.name || '')}">✕</button>
          ${startHref ? `<a class="wg-icon-btn" href="${escapeHtml(startHref)}" aria-label="Iniciar ${escapeHtml(it.name || '')}">▶</a>` : ''}
        </span>
        ${noTimeCount ? `<small class="wg-day-note">+${noTimeCount} sin horario</small>` : ''}
      </div>`;
  }).join('');

  const rows = hours.map((h) => {
    const hourLabel = `${String(h).padStart(2, '0')}:00`;
    const cells = WEEK_ORDER.map((day) => {
      const it = byDay.get(day);
      if (!it) return '<div class="wg-cell"></div>';
      const items = (it.items || []).filter(
        (item) => item.time_of_day && parseInt(item.time_of_day.slice(0, 2), 10) === h,
      );
      if (!items.length) return '<div class="wg-cell"></div>';
      const chips = items.map((item) => {
        const s = stepLabel(item);
        return `<button type="button" class="wg-session" data-edit="${escapeHtml(it.id)}">
            <b>${escapeHtml(item.time_of_day)}</b> ${escapeHtml(s.name)}
          </button>`;
      }).join('');
      return `<div class="wg-cell">${chips}</div>`;
    }).join('');
    return `<div class="wg-hour-label">${hourLabel}</div>${cells}`;
  }).join('');

  // Botones ‹ › además del gesto de deslizar: en desktop se ocultan por CSS
  // (min-width:700px), pero en mobile/APK son la forma confiable de llegar a
  // sábado/domingo sin depender de que el swipe horizontal se reconozca bien
  // dentro de una página que también scrollea verticalmente.
  return `<div class="week-grid-wrap">
      <button type="button" class="wg-nav-btn wg-nav-prev" data-wg-scroll="-1" aria-label="Ver días anteriores">‹</button>
      <div class="week-grid-scroll" id="wg-scroll">
        <div class="week-grid">
          <div class="wg-corner"></div>${headerCells}
          ${rows}
        </div>
      </div>
      <button type="button" class="wg-nav-btn wg-nav-next" data-wg-scroll="1" aria-label="Ver días siguientes">›</button>
    </div>`;
}

function renderItineraries(list) {
  if (!itListEl || !itEmptyEl) return;
  itListEl.innerHTML = '';
  const has = list.length > 0;
  itListEl.classList.toggle('hidden', !has);
  itEmptyEl.classList.toggle('hidden', has);
  if (itCountEl) itCountEl.textContent = String(list.length);
  if (!has) return;

  // Un itinerario ES un día (a lo sumo uno por día, no se repite — ver
  // backend). El horario semanal se muestra siempre, lunes→domingo, aunque
  // algún día quede sin itinerario todavía: sirve de guía para programarlo.
  const byDay = new Map();
  const loose = [];
  list.forEach((it) => {
    if (it.day_of_week != null) byDay.set(it.day_of_week, it);
    else loose.push(it);
  });

  const weekLi = document.createElement('li');
  weekLi.className = 'rutina-week-card';
  weekLi.innerHTML = weekGridHTML(byDay);
  itListEl.appendChild(weekLi);

  // Itinerarios sin día: secuencias sueltas, reutilizables cuando quieras
  // (no forman parte de la rotación semanal).
  loose.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'rutina-item rutina-item-it';
    li.innerHTML = itineraryCardHTML(it);
    itListEl.appendChild(li);
  });
}

function firstFrequency(items) {
  const first = items[0];
  if (!first) return null;
  return savedFreqsMap.get(first.frequency_id) || null;
}

let savedFreqsMap = new Map();
let itinerariesLoaded = false;
let currentIts = [];

// ── Crear y editar itinerario directo desde /rutina (mismo formulario que
// /cuenta, sin mandar a otra página) ────────────────────────────────────────
let itSteps = []; // pasos del itinerario en construcción (crear o editar)
let editingItineraryId = null;
// true mientras el sub-formulario de paso tiene datos de un paso YA
// existente que se sacó de itSteps para editarlo (ver el handler de ✎ más
// abajo) y todavía no se repuso con "＋ Añadir paso". Si el submit del
// itinerario encuentra esto en true, repone ese paso él mismo — si no, un
// simple "Guardar cambios" sin tocar nada más lo borraba en silencio.
let pendingStepEdit = false;

function formatHzShort(hz) {
  if (hz == null) return '';
  const r = Math.round(hz * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} Hz`;
}

// El select combina las predefinidas (siempre disponibles) con las que el
// usuario ya guardó en su cuenta. "p:<id>" = predefinida, "f:<uuid>" = guardada.
function populateStepFreqs() {
  const sel = document.getElementById('it-step-freq');
  if (!sel) return;
  // savedFreqsMap se termina de cargar async (loadItineraries) DESPUÉS de
  // este primer poblado — se vuelve a llamar cuando llega, y sin conservar
  // el value un usuario que ya venía eligiendo algo lo perdía sin avisar.
  const prevValue = sel.value;
  const predefined = PROFILES
    .map((p) => `<option value="p:${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${formatHzShort(p.stimulus.carrierBase)}</option>`)
    .join('');
  const saved = [...savedFreqsMap.values()]
    .map((f) => `<option value="f:${escapeHtml(f.id)}">${escapeHtml(f.name || 'Frecuencia')} · ${formatHzShort(f.carrier_frequency ?? f.left_frequency)}</option>`)
    .join('');
  sel.innerHTML = `<optgroup label="Predefinidas">${predefined}</optgroup>`
    + (saved ? `<optgroup label="Mis frecuencias">${saved}</optgroup>` : '');
  sel.disabled = false;
  if (prevValue && [...sel.options].some((o) => o.value === prevValue)) sel.value = prevValue;
}

function findMatchingSavedFreq(profile) {
  return [...savedFreqsMap.values()].find(
    (f) =>
      Math.abs((f.carrier_frequency ?? 0) - profile.stimulus.carrierBase) < 0.05 &&
      Math.abs((f.beat_frequency ?? 0) - profile.stimulus.beat) < 0.05 &&
      (f.waveform || 'sine') === (profile.stimulus.modulation || 'sine'),
  );
}

// Resuelve el value del select ("p:<id>" | "f:<uuid>") a una frecuencia real:
// las predefinidas se guardan en la cuenta la primera vez que se usan.
async function resolveStepFrequency(value) {
  if (value.startsWith('f:')) {
    return savedFreqsMap.get(value.slice(2)) || null;
  }
  if (value.startsWith('p:')) {
    const profile = PROFILES.find((p) => p.id === value.slice(2));
    if (!profile) return null;
    const existing = findMatchingSavedFreq(profile);
    if (existing) return existing;
    const created = await createFrequency({
      name: profile.name,
      carrier_frequency: profile.stimulus.carrierBase,
      beat_frequency: profile.stimulus.beat,
      waveform: profile.stimulus.modulation || 'sine',
      condition: 'binaural',
      config: { source: 'itinerary-preset', profile_id: profile.id },
    });
    savedFreqsMap.set(created.id, created);
    return created;
  }
  return null;
}

function renderItSteps() {
  const ul = document.getElementById('it-steps');
  const empty = document.getElementById('it-steps-empty');
  if (!ul) return;
  ul.innerHTML = '';
  const has = itSteps.length > 0;
  ul.classList.toggle('hidden', !has);
  if (empty) empty.classList.toggle('hidden', has);
  itSteps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'cuenta-item';
    const bell = step.notification_enabled === false ? '🔕' : '🔔';
    const schedule = step.time_of_day ? `${step.time_of_day} · ${bell}` : '';
    li.innerHTML = `<div class="cuenta-item-body">
        <b>${i + 1}. ${escapeHtml(step.name)}</b>
        <small>${step.duration} min${schedule ? ` · ${escapeHtml(schedule)}` : ''}</small>
      </div>
      <button type="button" class="cuenta-item-edit" data-step-edit="${i}" aria-label="Editar paso">✎</button>
      <button type="button" class="cuenta-item-del" data-step="${i}" aria-label="Quitar paso">✕</button>`;
    ul.appendChild(li);
  });
}

function toggleStepNotifyWrap() {
  const wrap = document.getElementById('it-step-notify-wrap');
  const timeEl = document.getElementById('it-step-time');
  if (wrap) wrap.classList.toggle('hidden', !(timeEl && timeEl.value));
}

// Deshabilita los días ya ocupados por OTRO itinerario (no se puede repetir);
// el propio día del itinerario en edición queda habilitado para no bloquearlo.
function populateItineraryDaySelect() {
  const sel = document.getElementById('itinerary-day');
  if (!sel) return;
  const taken = new Set(
    currentIts
      .filter((it) => it.day_of_week != null && it.id !== editingItineraryId)
      .map((it) => it.day_of_week),
  );
  Array.from(sel.options).forEach((opt) => {
    if (opt.value === '') return;
    opt.disabled = taken.has(Number(opt.value));
  });
}

// ── Panel "Personalizar" de un paso: mismos ajustes que el generador
// (portada/ritmo con sliders + forma de onda + condición experimental).
// Vocabulario: "portada" = la frecuencia base (preset o libre, en Hz);
// "portadoras" = los tonos de afinación fijos (solfeggios/estándares —
// 432/528/963/136.1/194.7 Hz), que solo fijan un valor concreto de portada.
const IT_CUSTOM_WAVES = [
  { id: 'sine', label: 'Senoidal' },
  { id: 'triangle', label: 'Triangular' },
  { id: 'square', label: 'Cuadrada' },
  { id: 'sawtooth', label: 'Diente de sierra' },
];
let itCustomWave = 'sine';

// La portadora es ORTOGONAL a la portada: el paso (preset o guardada) define
// su propia base ("portada"), y la portadora elegida ACÁ la afina — la
// escala proporcionalmente a una familia (Solfeggio, Ancestral...) o la fija
// a un valor literal (Schumann, 220 Hz) — igual que el generador principal
// (carrierBaseFor, core/carrier.js: misma tabla, mismo escalado). Ya no hay
// forma de tocar la portada a mano: solo se elige entre estas familias fijas.
const IT_CUSTOM_CARRIERS = [
  { mode: 'estandar', label: '432 Hz · Estándar' },
  { mode: 'estandar220', label: '220 Hz · Estándar impuesto' },
  { mode: 'solfeggio', label: '528 Hz · Solfeggio' },
  { mode: 'solfeggio963', label: '963 Hz · Solfeggio divino' },
  { mode: 'ancestral', label: '136.1 Hz · Ancestral' },
  { mode: 'schumann', label: '194.7 Hz · Schumann' },
];
let itCustomCarrierMode = 'estandar';
// La base propia del preset o de la frecuencia guardada elegida en el
// select — el ancla sobre la que escalan las familias de portadora.
let itCustomNominalBase = 220;
// Resultado final (Hz reales) — lo que de verdad se guarda como
// carrier_frequency. Se recalcula con recomputeItCustomCarrier().
let itCustomCarrierHz = 220;

// Recalcula itCustomCarrierHz desde el modo de portadora + itCustomNominalBase
// (carrierBaseFor hace el mismo escalado que el generador).
function recomputeItCustomCarrier() {
  const hz = carrierBaseFor(itCustomCarrierMode, itCustomNominalBase);
  itCustomCarrierHz = Math.round(hz * 10) / 10;
  updateItCustomLabels();
}

function syncItCustomCarrierButtons() {
  document.querySelectorAll('#it-custom-carrier-options .wave-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === itCustomCarrierMode);
  });
}

// Cambia de modo de portadora (botón de afinación).
function setItCustomCarrierMode(mode) {
  itCustomCarrierMode = mode;
  syncItCustomCarrierButtons();
  recomputeItCustomCarrier();
}

const IT_CUSTOM_CONDITIONS = [
  { id: 'binaural', label: 'Binaural' },
  { id: 'pure-tone', label: 'Tono puro' },
  { id: 'noise', label: 'Ruido' },
  { id: 'amplitude-modulation', label: 'AM' },
  { id: 'none', label: 'Sin estímulo' },
];
let itCustomCondition = 'binaural';

// La condición experimental NO se agrega acá a propósito: el generador
// todavía no la usa para nada en la reproducción (ver audio-provider.js) —
// guardarla sería un dato muerto. Ambiente y portada SÍ se escuchan de
// verdad, por eso se guardan y viajan con la frecuencia.
const IT_CUSTOM_AMBIENTS = [
  { id: 'lluvia', label: '🌧️ Lluvia' },
  { id: 'rio', label: '🏞️ Río' },
  { id: 'bosque', label: '🌲 Bosque' },
  { id: 'pajaros', label: '🐦 Pájaros' },
  { id: 'oceano', label: '🌊 Océano' },
  { id: 'fuego', label: '🔥 Fuego' },
];
let itCustomAmbient = new Set();

function populateItCustomWaveOptions() {
  const wrap = document.getElementById('it-custom-wave-options');
  if (!wrap) return;
  wrap.innerHTML = IT_CUSTOM_WAVES.map(
    (w) => `<button type="button" class="wave-btn${w.id === itCustomWave ? ' active' : ''}" data-wave="${w.id}">${escapeHtml(w.label)}</button>`,
  ).join('');
}

function syncItCustomWaveButtons() {
  document.querySelectorAll('#it-custom-wave-options .wave-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.wave === itCustomWave);
  });
}

function populateItCustomCarrierOptions() {
  const wrap = document.getElementById('it-custom-carrier-options');
  if (!wrap) return;
  wrap.innerHTML = IT_CUSTOM_CARRIERS.map(
    (c) => `<button type="button" class="wave-btn${c.mode === itCustomCarrierMode ? ' active' : ''}" data-mode="${c.mode}">${escapeHtml(c.label)}</button>`,
  ).join('');
}

function populateItCustomCondOptions() {
  const wrap = document.getElementById('it-custom-cond-options');
  if (!wrap) return;
  wrap.innerHTML = IT_CUSTOM_CONDITIONS.map(
    (c) => `<button type="button" class="wave-btn${c.id === itCustomCondition ? ' active' : ''}" data-cond="${c.id}">${escapeHtml(c.label)}</button>`,
  ).join('');
}

function syncItCustomCondButtons() {
  document.querySelectorAll('#it-custom-cond-options .wave-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cond === itCustomCondition);
  });
}

function populateItCustomAmbientOptions() {
  const wrap = document.getElementById('it-custom-ambient-options');
  if (!wrap) return;
  wrap.innerHTML = IT_CUSTOM_AMBIENTS.map(
    (a) => `<button type="button" class="wave-btn${itCustomAmbient.has(a.id) ? ' active' : ''}" data-ambient="${a.id}">${escapeHtml(a.label)}</button>`,
  ).join('');
}

function syncItCustomAmbientButtons() {
  document.querySelectorAll('#it-custom-ambient-options .wave-btn').forEach((btn) => {
    btn.classList.toggle('active', itCustomAmbient.has(btn.dataset.ambient));
  });
}

function updateItCustomLabels() {
  const beat = document.getElementById('it-custom-beat');
  const baseLabel = document.getElementById('it-custom-base-label');
  const beatLabel = document.getElementById('it-custom-beat-label');
  if (baseLabel) baseLabel.textContent = `Portada: ${formatHzShort(itCustomCarrierHz)}`;
  if (beat && beatLabel) beatLabel.textContent = `Ritmo binaural: ${beat.value} Hz`;
}

function setItCustomNote(msg, isError) {
  const noteEl = document.getElementById('it-custom-save-note');
  if (!noteEl) return;
  noteEl.textContent = msg;
  noteEl.classList.toggle('hidden', !msg);
  noteEl.classList.toggle('custom-save-note-error', !!isError);
}

// Antes de abrir "Personalizar", carga la personalización con lo que YA
// está elegido en el select (en vez de arrancar siempre desde los defaults
// del HTML: 220 Hz / 10 Hz / senoidal / sin ambiente). Dos casos:
//  - "p:<id>" (predefinida): la portada arranca en el valor propio del
//    preset (uno de los predeterminados con sentido, no un default genérico)
//    — el ritmo/beat es lo que en general se ajusta para afinar la sesión.
//  - "f:<uuid>" (ya guardada): carga TODO lo suyo — portada, ritmo, onda,
//    condición, ambiente y nombre — para editar/afinar sobre lo guardado,
//    no perderlo y volver a empezar de cero.
function prefillItCustomFromSelection() {
  const sel = document.getElementById('it-step-freq');
  const beatEl = document.getElementById('it-custom-beat');
  const nameEl = document.getElementById('it-custom-save-name');
  if (!sel || !sel.value) return;
  let carrier = null;
  let beat = null;
  let wave = null;
  let condition = null;
  let ambient = null;
  let name = null;
  if (sel.value.startsWith('p:')) {
    const profile = PROFILES.find((p) => p.id === sel.value.slice(2));
    if (profile) {
      carrier = profile.stimulus.carrierBase;
      beat = profile.stimulus.beat;
      wave = profile.stimulus.modulation || 'sine';
      name = profile.name;
    }
  } else if (sel.value.startsWith('f:')) {
    const freq = savedFreqsMap.get(sel.value.slice(2));
    if (freq) {
      carrier = freq.carrier_frequency ?? freq.left_frequency;
      beat = freq.beat_frequency;
      wave = freq.waveform || 'sine';
      condition = freq.condition || 'binaural';
      ambient = freqAmbient(freq);
      name = freq.name;
    }
  }
  if (carrier != null) {
    // Arranca siempre en modo 'estandar': muestra la base propia del preset
    // o de la guardada, sin escalar — desde ahí se puede afinar con una
    // portadora o pasar a "Personalizado" para tocarla a mano.
    itCustomNominalBase = carrier;
    itCustomCarrierMode = 'estandar';
    syncItCustomCarrierButtons();
    recomputeItCustomCarrier();
  }
  if (beat != null && beatEl) beatEl.value = String(Math.round(beat * 10) / 10);
  if (wave) {
    itCustomWave = wave;
    syncItCustomWaveButtons();
  }
  itCustomCondition = condition || 'binaural';
  syncItCustomCondButtons();
  itCustomAmbient = new Set(ambient || []);
  syncItCustomAmbientButtons();
  if (nameEl && name) nameEl.value = name;
}

function wireItCustomPanel() {
  const toggle = document.getElementById('it-step-custom');
  const panel = document.getElementById('it-custom-panel');
  if (!toggle || !panel) return;
  populateItCustomWaveOptions();
  populateItCustomCarrierOptions();
  populateItCustomCondOptions();
  populateItCustomAmbientOptions();
  const beatEl = document.getElementById('it-custom-beat');
  syncItCustomCarrierButtons();
  if (beatEl) beatEl.addEventListener('input', updateItCustomLabels);
  const waveWrap = document.getElementById('it-custom-wave-options');
  if (waveWrap) {
    waveWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.wave-btn');
      if (!btn) return;
      itCustomWave = btn.dataset.wave;
      syncItCustomWaveButtons();
    });
  }
  const carrierWrap = document.getElementById('it-custom-carrier-options');
  if (carrierWrap) {
    carrierWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.wave-btn');
      if (!btn) return;
      setItCustomCarrierMode(btn.dataset.mode);
    });
  }
  const condWrap = document.getElementById('it-custom-cond-options');
  if (condWrap) {
    condWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.wave-btn');
      if (!btn) return;
      itCustomCondition = btn.dataset.cond;
      syncItCustomCondButtons();
    });
  }
  const ambientWrap = document.getElementById('it-custom-ambient-options');
  if (ambientWrap) {
    ambientWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.wave-btn');
      if (!btn) return;
      const id = btn.dataset.ambient;
      if (itCustomAmbient.has(id)) itCustomAmbient.delete(id);
      else itCustomAmbient.add(id);
      syncItCustomAmbientButtons();
    });
  }
  toggle.addEventListener('click', () => {
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    toggle.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      prefillItCustomFromSelection();
      updateItCustomLabels();
    }
  });
  const saveBtn = document.getElementById('it-custom-save');
  const nameEl = document.getElementById('it-custom-save-name');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      // Mismo motivo que en "＋ Añadir paso": esto crea la frecuencia en el
      // servidor antes de poder agregarla como paso — sin bloquear Guardar,
      // un click rápido podía mandar el itinerario sin esta personalizada.
      const submitBtn = document.getElementById('itinerary-submit');
      if (submitBtn) submitBtn.disabled = true;
      setItCustomNote('Guardando…');
      try {
        const carrier = itCustomCarrierHz || 220;
        const beat = (beatEl && parseFloat(beatEl.value)) || 10;
        const name = (nameEl && nameEl.value.trim()) || 'Personalizada';
        const frequency = await createFrequency({
          name: name.slice(0, 120),
          carrier_frequency: Math.round(carrier * 10) / 10,
          beat_frequency: Math.round(beat * 10) / 10,
          waveform: itCustomWave,
          condition: itCustomCondition,
          // Ambiente SÍ viaja con la frecuencia (a diferencia de condition,
          // que hoy no afecta nada de lo que suena): así "Iniciar" desde el
          // itinerario reproduce el mismo paisaje sonoro que el usuario
          // eligió al personalizarla, no solo freq/ritmo/onda.
          config: { source: 'itinerary', ambient: [...itCustomAmbient] },
        });
        savedFreqsMap.set(frequency.id, frequency);
        populateStepFreqs();
        const sel = document.getElementById('it-step-freq');
        if (sel) sel.value = `f:${frequency.id}`;
        if (nameEl) nameEl.value = '';
        setItCustomNote('✅ Lista — seleccionada para este paso.');
        panel.classList.add('hidden');
        toggle.setAttribute('aria-expanded', 'false');
      } catch (err) {
        setItCustomNote((err && err.detail) || 'No se pudo guardar. Intentá de nuevo.', true);
      } finally {
        saveBtn.disabled = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

function openItineraryModal() {
  const modal = document.getElementById('itinerary-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeItineraryModal() {
  const modal = document.getElementById('itinerary-modal');
  if (modal) modal.classList.add('hidden');
}

function startEditItinerary(it) {
  editingItineraryId = it.id;
  pendingStepEdit = false;
  const summary = document.getElementById('itinerary-form-summary');
  if (summary) summary.textContent = `✏️ Editando: ${it.name || 'itinerario'}`;
  document.getElementById('itinerary-name').value = it.name || '';
  document.getElementById('itinerary-desc').value = it.description || '';
  const dayEl = document.getElementById('itinerary-day');
  itSteps = (it.items || []).slice().sort((a, b) => a.position - b.position).map((item) => {
    const f = savedFreqsMap.get(item.frequency_id);
    return {
      frequency_id: item.frequency_id,
      name: f ? f.name : 'Frecuencia',
      duration: Math.max(1, Math.round((item.duration || 0) / 60)),
      time_of_day: item.time_of_day || null,
      notification_enabled: item.configuration ? item.configuration.notification_enabled !== false : true,
    };
  });
  renderItSteps();
  if (dayEl) dayEl.value = it.day_of_week != null ? String(it.day_of_week) : '';
  populateItineraryDaySelect();
  const submitBtn = document.getElementById('itinerary-submit');
  if (submitBtn) submitBtn.textContent = 'Guardar cambios';
  const cancelBtn = document.getElementById('itinerary-cancel-edit');
  if (cancelBtn) cancelBtn.classList.remove('hidden');
  openItineraryModal();
}

function cancelEditItinerary() {
  editingItineraryId = null;
  pendingStepEdit = false;
  itSteps = [];
  renderItSteps();
  const summary = document.getElementById('itinerary-form-summary');
  if (summary) summary.textContent = '＋ Crear itinerario';
  const submitBtn = document.getElementById('itinerary-submit');
  if (submitBtn) submitBtn.textContent = 'Crear itinerario';
  const cancelBtn = document.getElementById('itinerary-cancel-edit');
  if (cancelBtn) cancelBtn.classList.add('hidden');
  const itForm = document.getElementById('itinerary-form');
  if (itForm) itForm.reset();
  populateItineraryDaySelect();
}

function wireItineraryForm() {
  const openBtn = document.getElementById('itinerary-open-btn');
  const modal = document.getElementById('itinerary-modal');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      cancelEditItinerary();
      openItineraryModal();
    });
  }
  const modalClose = document.getElementById('itinerary-modal-close');
  if (modalClose) {
    modalClose.addEventListener('click', () => {
      cancelEditItinerary();
      closeItineraryModal();
    });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        cancelEditItinerary();
        closeItineraryModal();
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      cancelEditItinerary();
      closeItineraryModal();
    }
  });

  const add = document.getElementById('it-step-add');
  const timeEl = document.getElementById('it-step-time');
  if (timeEl) timeEl.addEventListener('input', toggleStepNotifyWrap);
  wireItCustomPanel();
  populateStepFreqs();

  // Empuja el paso configurado en el sub-formulario (frecuencia/duración/
  // horario) a itSteps. Usada tanto por "＋ Añadir paso" como, si quedó un
  // horario cargado sin tocar ese botón, por el submit del itinerario (ver
  // más abajo) — así un horario tipeado no se pierde en silencio solo por
  // olvidarse del click intermedio.
  async function addPendingStep() {
    const sel = document.getElementById('it-step-freq');
    const dur = document.getElementById('it-step-duration');
    const notifyEl = document.getElementById('it-step-notify');
    if (!sel.value) return false;
    if (!timeEl || !timeEl.value) {
      alert('Elegí un horario para este paso.');
      if (timeEl) timeEl.focus();
      return false;
    }
    add.disabled = true;
    // resolveStepFrequency() puede pegarle a la red (createFrequency para
    // un preset/personalizado sin resolver todavía) — sin bloquear Guardar
    // acá, un click rápido en "Crear itinerario" mandaba el itinerario con
    // ESTE paso todavía sin empujar a itSteps: el paso desaparecía en
    // silencio, sin error, exactamente el bug reportado en vivo (2 pasos
    // agregados, 1 solo guardado).
    const submitBtn = document.getElementById('itinerary-submit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const freq = await resolveStepFrequency(sel.value);
      if (!freq) return false;
      const duration = Math.max(1, Math.min(1440, parseInt(dur.value, 10) || 10));
      const time_of_day = timeEl && timeEl.value ? timeEl.value : null;
      itSteps.push({
        frequency_id: freq.id,
        name: freq.name || 'Frecuencia',
        duration,
        time_of_day,
        notification_enabled: notifyEl ? notifyEl.checked : true,
      });
      renderItSteps();
      if (timeEl) timeEl.value = '';
      if (notifyEl) notifyEl.checked = true;
      toggleStepNotifyWrap();
      pendingStepEdit = false;
      return true;
    } catch (err) {
      alert(`No se pudo preparar la frecuencia: ${(err && err.detail) || 'error'}`);
      return false;
    } finally {
      add.disabled = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  if (add) {
    add.addEventListener('click', addPendingStep);
  }

  document.addEventListener('click', (e) => {
    const del = e.target.closest('#it-steps [data-step]');
    if (!del) return;
    const i = parseInt(del.dataset.step, 10);
    if (Number.isFinite(i) && itSteps[i]) {
      itSteps.splice(i, 1);
      renderItSteps();
    }
  });

  // Editar un paso YA guardado: no hay forma de tocar su horario in situ —
  // el paso vuelve al formulario de arriba (mismo patrón que editar el
  // itinerario entero) y se saca de la lista; "＋ Añadir paso" lo repone
  // con los valores nuevos. Sin esto, la única forma de cambiar SOLO la
  // hora de un paso era borrarlo y recrearlo a mano — nada en la UI lo
  // explicaba, así que "actualizar la hora" en el mismo paso simplemente
  // no hacía nada (se reenviaba el itinerario con el horario viejo, que si
  // ya pasó, el backend lo reprograma en silencio para la semana próxima).
  document.addEventListener('click', (e) => {
    const editBtn = e.target.closest('#it-steps [data-step-edit]');
    if (!editBtn) return;
    const i = parseInt(editBtn.dataset.stepEdit, 10);
    const step = itSteps[i];
    if (!Number.isFinite(i) || !step) return;
    const sel = document.getElementById('it-step-freq');
    const dur = document.getElementById('it-step-duration');
    const timeEl = document.getElementById('it-step-time');
    const notifyEl = document.getElementById('it-step-notify');
    // El <select> solo se puebla con "Mis frecuencias" una vez, al abrir el
    // formulario — si este paso usa una frecuencia creada DESPUÉS de eso
    // (ej. un preset recién guardado en este mismo formulario), su opción
    // todavía no existe y el sel.value de abajo quedaría sin efecto.
    populateStepFreqs();
    if (sel) sel.value = `f:${step.frequency_id}`;
    if (dur) dur.value = String(step.duration);
    if (timeEl) timeEl.value = step.time_of_day || '';
    if (notifyEl) notifyEl.checked = step.notification_enabled !== false;
    toggleStepNotifyWrap();
    itSteps.splice(i, 1);
    pendingStepEdit = true;
    renderItSteps();
    if (timeEl) timeEl.focus();
  });

  const cancelBtn = document.getElementById('itinerary-cancel-edit');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cancelEditItinerary();
      closeItineraryModal();
    });
  }

  const itForm = document.getElementById('itinerary-form');
  if (itForm) {
    itForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const dayEl = document.getElementById('itinerary-day');
      const day_of_week = dayEl && dayEl.value !== '' ? Number(dayEl.value) : undefined;
      // El nombre es opcional: lo importante es el día. Sin nombre propio,
      // usamos el nombre del día ("Lunes") — o "Itinerario" para una
      // secuencia suelta sin día — en vez de bloquear el guardado.
      const typedName = document.getElementById('itinerary-name').value.trim();
      const dayName = day_of_week != null ? DAY_NAMES[day_of_week] : null;
      const name = typedName || (dayName ? dayName[0].toUpperCase() + dayName.slice(1) : 'Itinerario');
      const desc = document.getElementById('itinerary-desc').value.trim() || undefined;
      let tz = 'UTC';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch (_) { /* default */ }
      // Si queda un paso sin agregar (uno editado con ✎ que no se repuso, o
      // uno nuevo con horario cargado pero sin tocar "＋ Añadir paso"), lo
      // sumamos acá antes de guardar — si no, se pierde en silencio. Si no
      // se puede resolver (p. ej. le falta el horario ahora obligatorio),
      // no seguimos con el guardado: mejor eso que perder el paso.
      if (pendingStepEdit || timeEl.value) {
        const added = await addPendingStep();
        if (!added) return;
      }
      const items = itSteps.map((s, i) => ({
        frequency_id: s.frequency_id,
        position: i,
        duration: s.duration * 60,
        configuration: s.time_of_day ? { notification_enabled: s.notification_enabled !== false } : {},
        time_of_day: s.time_of_day || undefined,
      }));
      const submitBtn = document.getElementById('itinerary-submit');
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (editingItineraryId) {
          await updateItinerary(editingItineraryId, { name: name.slice(0, 120), description: desc, day_of_week, items });
        } else {
          await createItinerary({ name: name.slice(0, 120), description: desc, timezone: tz, day_of_week, items });
        }
        cancelEditItinerary();
        closeItineraryModal();
        loadItineraries();
        // En la APK, sin esto el recordatorio recién guardado esperaba el
        // próximo ciclo de sync nativo (~5 min) para programarse en el
        // reloj del sistema — si el horario elegido caía antes, nunca
        // llegaba a sonar (ver notifyNativeAlarmsChanged en api/client.js).
        notifyNativeAlarmsChanged();
      } catch (err) {
        alert(`No se pudo guardar el itinerario: ${(err && err.detail) || 'error'}`);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

// ── Crear recordatorio directo desde /rutina (sin pasar por el generador) ──
// Mismo AlarmManager que src/main.js (misma clase, mismo store durable +
// espejo localStorage): así un recordatorio creado acá lo ve el generador
// tal cual, y viceversa — un solo dueño de los datos, dos puntos de entrada.
const alarmManagerInstance = new AlarmManager({
  // La rutina no tiene reproductor: al disparar, solo notifica (nunca arranca
  // audio — REGLA DE ORO). Sin la pestaña de /rutina abierta tampoco dispara
  // acá; es la misma limitación honesta que ya documenta esta página.
  onFire: (alarm) => fireAlarm(alarm),
  onSync: render,
  channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vyneural-alarms') : null,
  locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
});

function reminderPreset() {
  const sel = document.getElementById('reminder-state');
  return PROFILES.find((p) => p.id === (sel && sel.value)) || PROFILES[0];
}

function populateReminderPresets() {
  const sel = document.getElementById('reminder-state');
  if (!sel) return;
  sel.innerHTML = '';
  PROFILES.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.custom ? 'Personalizado (a tu medida)' : `${p.name} · ${p.band}`;
    sel.appendChild(opt);
  });
}

// Próxima fecha ≥ ahora cuyo día (getDay: 0=domingo…6=sábado) esté en `days`
// — mismo cálculo que el generador (src/main.js:nextOccurrenceAt).
function nextOccurrenceAt(hh, mm, days, fromMs = Date.now()) {
  if (!days || days.length === 0) return null;
  for (let i = 0; i < 9; i++) {
    const d = new Date(fromMs);
    d.setDate(d.getDate() + i);
    if (days.includes(d.getDay())) {
      const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
      if (cand.getTime() >= fromMs) return cand.getTime();
    }
  }
  return null;
}

function reminderDaysSelected() {
  const wrap = document.getElementById('reminder-days');
  if (!wrap) return [];
  return [...wrap.querySelectorAll('.day-chip[aria-pressed="true"]')]
    .map((b) => parseInt(b.dataset.day, 10));
}

function scheduleNativeReminder(alarm) {
  // La repetición semanal (días) es exclusiva de la APK — el AlarmManager
  // nativo del SO es el único que puede reprogramarse con la app cerrada.
  if (!nativeBridge.present) return false;
  const r = nativeBridge.scheduleAlarm({
    alarmId: alarm.id,
    title: `Sesión ${Math.round(alarm.freq)} Hz`,
    body: `${alarm.name} · ${Math.round(alarm.freq)} Hz · ${alarm.beat} Hz`,
    atMs: alarm.nextAt,
    days: alarm.days && alarm.days.length ? alarm.days : undefined,
    freq: alarm.freq,
    beat: alarm.beat,
    wave: alarm.wave || 'sine',
  });
  return !!(r && r.ok);
}

function wireReminderForm() {
  const form = document.getElementById('reminder-form');
  const stateSel = document.getElementById('reminder-state');
  const customRow = document.getElementById('reminder-custom-row');
  const daysWrap = document.getElementById('reminder-days-wrap');
  const timeEl = document.getElementById('reminder-time');
  if (!form || !stateSel) return;

  populateReminderPresets();
  // Los días de repetición son exclusivos de la APK (ver nota de la página):
  // en web/PWA el selector ni se muestra, para no prometer algo que no cumple.
  if (daysWrap) daysWrap.classList.toggle('hidden', !IN_APK);

  stateSel.addEventListener('change', () => {
    const p = reminderPreset();
    if (customRow) customRow.classList.toggle('hidden', !p.custom);
  });

  const daysEl = document.getElementById('reminder-days');
  if (daysEl) {
    daysEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.day-chip');
      if (!btn) return;
      const on = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!on));
      btn.classList.toggle('active', !on);
    });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const p = reminderPreset();
      const base = document.getElementById('reminder-base');
      const beat = document.getElementById('reminder-beat');
      const minutesEl = document.getElementById('reminder-minutes');
      const time = timeEl.value || '08:00';
      const days = IN_APK ? reminderDaysSelected() : [];
      const [hh, mm] = time.split(':').map(Number);
      const nextAt = days.length ? nextOccurrenceAt(hh, mm, days) || nextAlarmAt(time).getTime() : nextAlarmAt(time).getTime();
      const alarm = {
        id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        time,
        name: p.custom ? 'Personalizado' : p.name,
        freq: p.custom ? (parseFloat(base.value) || 220) : p.base,
        beat: p.custom ? (parseFloat(beat.value) || 10) : p.beat,
        wave: 'sine',
        minutes: parseInt(minutesEl.value, 10) || 0,
        days,
        nextAt,
      };
      const nativeOwned = scheduleNativeReminder(alarm);
      if (nativeOwned) alarm.external = true;
      await alarmManagerInstance.create(alarm);
      // Sincronizar a la nube (best-effort): con sesión, el backend manda el
      // Web Push a la hora exacta aunque la app esté cerrada.
      if (getAccessToken()) {
        let timezone = 'UTC';
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch (_) { /* sin zona del navegador */ }
        createAlarm({
          name: alarm.name || 'Recordatorio',
          enabled: true,
          scheduled_at: new Date(alarm.nextAt).toISOString(),
          timezone,
          config: { freq: alarm.freq, beat: alarm.beat, wave: alarm.wave, minutes: alarm.minutes, localId: alarm.id },
          repeat_rule: days.length ? rruleFor(days) : null,
          notification_enabled: true,
        })
          .then((created) => {
            if (created && created.id) {
              alarm.cloudId = created.id;
              alarmManagerInstance.create(alarm).catch(() => {});
            }
          })
          .catch(() => {});
      }
      const perm = await requestPermission();
      showReminderNote(
        perm !== 'granted' && perm !== 'unsupported'
          ? 'Recordatorio guardado — activá las notificaciones para que te avise.'
          : 'Recordatorio guardado ✓',
      );
      form.reset();
      if (customRow) customRow.classList.add('hidden');
      document.querySelectorAll('#reminder-days .day-chip').forEach((b) => {
        b.setAttribute('aria-pressed', 'false');
        b.classList.remove('active');
      });
      const details = form.closest('details');
      if (details) details.open = false;
      render();
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function showReminderNote(msg) {
  const hint = document.getElementById('reminder-hint');
  if (!hint) return;
  hint.textContent = msg;
  window.setTimeout(() => {
    hint.textContent = 'Sin días marcados, el recordatorio es de una sola vez.';
  }, 4000);
}

// Reordenar pasos desde la rutina (↑/↓): optimista — re-render al momento y
// se persiste al backend; si falla, se recarga el estado real de la nube.
itListEl.addEventListener('click', async (e) => {
  const scrollBtn = e.target.closest('[data-wg-scroll]');
  if (scrollBtn) {
    const track = document.getElementById('wg-scroll');
    if (track) {
      // Un "día" de ancho (columna + gap) — mismo valor que minmax(112px,…)
      // en site.css; si la grilla cambia de ancho de columna, ajustar ahí.
      track.scrollBy({ left: 113 * Number(scrollBtn.dataset.wgScroll), behavior: 'smooth' });
    }
    return;
  }
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) {
    const it = currentIts.find((x) => x.id === editBtn.dataset.edit);
    if (it) startEditItinerary(it);
    return;
  }
  const delBtn = e.target.closest('[data-del-it]');
  if (delBtn) {
    const it = currentIts.find((x) => x.id === delBtn.dataset.delIt);
    const label = it && it.name ? `"${it.name}"` : 'este itinerario';
    if (!confirm(`¿Eliminar ${label}? Esta acción no se puede deshacer.`)) return;
    delBtn.disabled = true;
    try {
      await deleteItinerary(delBtn.dataset.delIt);
      notifyNativeAlarmsChanged();
      loadItineraries();
    } catch (err) {
      alert(`No se pudo eliminar: ${(err && err.detail) || 'error'}`);
      delBtn.disabled = false;
    }
    return;
  }
  const addDayBtn = e.target.closest('[data-add-day]');
  if (addDayBtn) {
    cancelEditItinerary();
    const dayEl = document.getElementById('itinerary-day');
    if (dayEl) dayEl.value = addDayBtn.dataset.addDay;
    openItineraryModal();
    return;
  }
  const btn = e.target.closest('[data-reorder]');
  if (!btn || btn.disabled) return;
  const itId = btn.dataset.it;
  const stepId = btn.dataset.step;
  const dir = btn.dataset.reorder;
  const it = currentIts.find((x) => x.id === itId);
  if (!it) return;
  const items = (it.items || []).slice().sort((a, b) => a.position - b.position);
  const idx = items.findIndex((x) => x.id === stepId);
  const target = dir === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || target < 0 || target >= items.length) return;
  [items[idx], items[target]] = [items[target], items[idx]];
  // UI optimista: aplicar el nuevo orden al momento.
  it.items = items.map((x, i) => ({ ...x, position: i }));
  renderItineraries(currentIts);
  try {
    await reorderItineraryItems(itId, items.map((x) => x.id));
  } catch (_) {
    // Honestidad: si la nube no aceptó, volvemos al orden real del backend.
    if (itSyncEl) {
      itSyncEl.textContent = 'No se pudo guardar el nuevo orden — revisá tu conexión. Se restauró el orden de la nube.';
      itSyncEl.classList.remove('hidden');
    }
    loadItineraries();
  }
});

// ── Resumen diario (práctica de hoy + próximo recordatorio) ────────────────
// Los minutos reales viven en ob-history-v1 (el mismo historial del generador):
// cada sesión terminada queda registrada con su duración. El resumen es un
// espejo honesto de ese dato local, no una estimación.
const LS_HISTORY = 'ob-history-v1';

function todayPractice() {
  try {
    const h = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
    if (!Array.isArray(h)) return { mins: 0, sessions: 0 };
    const today = h.filter((r) => new Date(r.ts).toDateString() === new Date().toDateString());
    return {
      mins: today.reduce((acc, r) => acc + (Number(r.min) || 0), 0),
      sessions: today.length,
    };
  } catch {
    return { mins: 0, sessions: 0 };
  }
}

// Próxima sesión de itinerario (día fijo + horario de paso) — el mismo
// cálculo que el horario semanal usa para ubicar cada paso, pero buscando
// la ocurrencia más cercana entre TODOS los itinerarios con día asignado.
// Sin esto, "próximo recordatorio" solo miraba getAlarms() (recordatorios
// LOCALES de este dispositivo) y un itinerario recién creado — que sí tiene
// alarma real, solo que la maneja el backend vía Web Push, no el
// AlarmManager local — nunca aparecía acá aunque estuviera guardado y
// alineado correctamente en la grilla semanal.
// Todas las próximas ocurrencias de itinerario (no solo la más cercana):
// "Próximas sesiones" necesita el horario completo, no un solo resumen.
function allItineraryOccurrences(its, fromMs = Date.now()) {
  const out = [];
  (its || []).forEach((it) => {
    if (it.day_of_week == null || it.is_active === false) return;
    (it.items || []).forEach((item) => {
      if (!item.time_of_day) return;
      const [hh, mm] = item.time_of_day.split(':').map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
      const at = nextOccurrenceAt(hh, mm, [it.day_of_week], fromMs);
      if (at == null) return;
      const s = stepLabel(item);
      out.push({
        at,
        time: item.time_of_day,
        name: `${it.name || 'Rutina'} · ${s.name}`,
        freq: s.base,
        beat: s.beat,
        dur: Math.round((item.duration || 0) / 60),
        days: [it.day_of_week],
        kind: 'itinerary',
        itId: it.id,
      });
    });
  });
  return out.sort((a, b) => a.at - b.at);
}

function nextItineraryOccurrence(its, fromMs = Date.now()) {
  return allItineraryOccurrences(its, fromMs)[0] || null;
}

function renderDaily() {
  const el = document.getElementById('rutina-daily');
  if (!el) return;
  const { mins, sessions } = todayPractice();
  const alarms = getAlarms().slice().sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
  const localNext = alarms[0] ? { at: alarms[0].nextAt, time: alarms[0].time, name: alarms[0].name || 'Sesión' } : null;
  const itNext = nextItineraryOccurrence(currentIts);
  const next = [localNext, itNext].filter(Boolean).sort((a, b) => a.at - b.at)[0];
  const stat = (b, label) => `<div class="daily-stat"><b>${b}</b><span>${label}</span></div>`;
  const parts = [stat(String(mins), 'min de práctica hoy'), stat(String(sessions), `${sessions === 1 ? 'sesión' : 'sesiones'} hoy`)];
  if (next) {
    const when = next.at ? `${next.time || ''} · ${fmtWhen(next.at)}` : next.time || '';
    parts.push(stat(escapeHtml(when), `próximo recordatorio · ${escapeHtml(next.name || 'Sesión')}`));
  } else {
    parts.push(stat('—', 'sin recordatorios próximos'));
  }
  el.innerHTML = `<div class="daily-grid">${parts.join('')}</div>`;
}

async function loadItineraries() {
  const sync = itSyncEl;
  try {
    // Sin sesión: los itinerarios viven en la nube; se avisa y no se rompe nada.
    if (!getAccessToken()) {
      if (sync) {
        sync.textContent = 'Sin sesión: los itinerarios se sincronizan con tu cuenta (opcional). Los recordatorios locales siguen acá.';
        sync.classList.remove('hidden');
      }
      currentIts = [];
      renderItineraries([]);
      itinerariesLoaded = true;
      return;
    }
    if (sync) {
      sync.textContent = 'Sincronizando itinerarios…';
      sync.classList.remove('hidden');
    }
    // Antes, un 401 (sesión vencida) quedaba atrapado por el .catch(() => [])
    // de abajo: la lista se veía vacía con el cartel "sincronizado ✓" — el
    // usuario creía haber perdido sus itinerarios en vez de ver que la
    // sesión venció. Ahora se detecta el motivo real igual que en /cuenta.
    let itErr = null;
    let freqErr = null;
    const [its, freqs] = await Promise.all([
      listItineraries().catch((err) => {
        itErr = err;
        return [];
      }),
      listFrequencies().catch((err) => {
        freqErr = err;
        return [];
      }),
    ]);
    savedFreqsMap = new Map((freqs || []).map((f) => [f.id, f]));
    currentIts = its || [];
    renderItineraries(currentIts);
    const authErr = itErr || freqErr;
    const isExpired = authErr && authErr.status === 401;
    const isNetwork = authErr && authErr.status === 0;
    // Señal para loadItinerariesOnBoot(): un fallo de red/servidor (no una
    // sesión vencida) casi siempre es el mismo cold start de Render — vale
    // la pena reintentar en vez de dejarlo así hasta el próximo reload.
    const needsRetry = !!authErr && !isExpired && (authErr.status === 0 || authErr.status >= 500);
    if (isExpired) {
      // Sesión realmente inválida: sincronizar el chip de la nav (evita el
      // estado "logueado" fantasma), igual que /cuenta.
      if (window.__vyneuralAuth && typeof window.__vyneuralAuth.expireSession === 'function') {
        window.__vyneuralAuth.expireSession();
      }
      if (sync) {
        sync.textContent = 'Tu sesión venció: iniciá sesión de nuevo para ver tus itinerarios en la nube.';
        sync.classList.remove('hidden');
      }
    } else if (authErr) {
      if (sync) {
        sync.textContent = isNetwork
          ? 'Sin conexión con el servidor: tu sesión sigue guardada, reintentá cuando vuelva.'
          : 'El backend no está disponible: los itinerarios de la nube no se pudieron cargar.';
        sync.classList.remove('hidden');
      }
    } else if (sync) {
      sync.textContent = 'Itinerarios sincronizados con tu cuenta ✓';
      sync.classList.remove('hidden');
    }
    return needsRetry;
  } catch (_) {
    if (sync) {
      sync.textContent = 'El backend no está disponible: los itinerarios de la nube no se pudieron cargar. Los recordatorios locales siguen funcionando.';
      sync.classList.remove('hidden');
    }
    renderItineraries([]);
    return true; // error inesperado: puede ser el mismo cold start, vale la pena reintentar
  } finally {
    itinerariesLoaded = true;
    // "Próximas sesiones" (y el resumen que arma) se pinta ANTES de que
    // esto termine (refreshState() llama render() y recién después
    // loadItineraries(), sin esperarlo) — sin este segundo pintado, la
    // lista quedaba SIEMPRE calculada con currentIts=[] y jamás se
    // refrescaba con los itinerarios reales.
    render();
    // El <select> de "＋ Añadir paso" se pobló UNA vez al abrir el
    // formulario, antes de que savedFreqsMap tuviera datos reales (esto se
    // resuelve async, arriba) — sin repoblarlo acá, "Mis frecuencias" nunca
    // mostraba nada guardado en sesiones anteriores, aunque existiera.
    populateStepFreqs();
  }
}

// Solo para el arranque (refreshState(), llamada una única vez al cargar la
// página): un cold start de Render (20-50s) hacía que el ÚNICO intento de
// loadItineraries() fallara con un error de red — transitorio, no "no hay
// itinerarios". Sin reintentos, la lista quedaba vacía con el aviso "sin
// conexión" hasta el próximo reload manual — mismo bug y mismo fix que
// refreshProfileOnBoot() (ui/auth.js), loadCommentsOnBoot() (comments.js) y
// loadAllOnBoot() (cuenta.js). Los demás llamadores de loadItineraries()
// (tras crear/editar/borrar algo, o el evento vyneural:auth) siguen con un
// solo intento: ahí el backend acaba de responder, así que un cold start a
// mitad de flujo es mucho menos probable.
async function loadItinerariesOnBoot() {
  const RETRY_DELAYS_MS = [3000, 6000, 12000, 20000]; // ~41s de cobertura
  for (let attempt = 0; ; attempt++) {
    const needsRetry = await loadItineraries();
    if (!needsRetry || attempt >= RETRY_DELAYS_MS.length) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

// "Próximas sesiones": horario unificado, no solo recordatorios locales —
// une los recordatorios de este dispositivo con las próximas ocurrencias de
// itinerario (que ya viven en la grilla semanal, pero acá se ven en orden
// cronológico real con fecha/hora, todos juntos).
function render() {
  renderDaily();
  if (!listEl || !emptyEl) return;
  const localSessions = getAlarms().map((a) => ({
    at: a.nextAt,
    time: a.time,
    name: a.name || 'Sesión personalizada',
    freq: a.freq,
    beat: a.beat,
    dur: a.minutes,
    days: a.days,
    kind: 'local',
    id: a.id,
  }));
  const sessions = [...localSessions, ...allItineraryOccurrences(currentIts)].sort(
    (a, b) => (a.at || 0) - (b.at || 0),
  );

  listEl.innerHTML = '';
  const has = sessions.length > 0;
  listEl.classList.toggle('hidden', !has);
  emptyEl.classList.toggle('hidden', has);
  if (countEl) {
    countEl.textContent = String(sessions.length);
  }

  sessions.forEach((a) => {
    const li = document.createElement('li');
    li.className = 'rutina-item';

    const badge = document.createElement('span');
    badge.className = 'rutina-day-badge';
    badge.textContent = daysLabel(a.days);

    const body = document.createElement('div');
    body.className = 'rutina-body';

    const time = document.createElement('div');
    time.className = 'rutina-time';
    time.textContent = `${a.time || '08:00'} · ${fmtWhen(a.at)}`;

    const name = document.createElement('div');
    name.className = 'rutina-name';
    name.textContent = a.name || 'Sesión personalizada';

    const meta = document.createElement('div');
    meta.className = 'rutina-meta';
    const parts = [];
    if (a.freq != null) parts.push(`${Math.round(a.freq)} Hz · ${Math.round(a.beat || 0)} Hz de ritmo`);
    if (a.dur > 0) parts.push(`${a.dur} min`);
    meta.textContent = parts.join(' · ');

    const rep = document.createElement('div');
    rep.className = 'rutina-repeat';
    rep.textContent = a.days && a.days.length ? `Se repite ${daysNames(a.days)}` : 'Una sola vez';

    body.append(time, name, meta, rep);

    const action = document.createElement('button');
    if (a.kind === 'local') {
      action.className = 'rutina-del';
      action.setAttribute('aria-label', 'Eliminar de la rutina');
      action.textContent = '✕';
      action.addEventListener('click', () => {
        cancelNativeAlarm(a.id);
        // Vía el AlarmManager (no un localStorage.setItem crudo): así también
        // se borra del store durable (IndexedDB), no solo del espejo — si no,
        // el generador podía seguir viéndola viva la próxima vez que abriera.
        alarmManagerInstance.cancel(a.id).then(render);
      });
    } else {
      // Una sesión de itinerario se edita/borra desde su itinerario (mismo
      // criterio que ya aplica en /cuenta: borrar solo el paso desde acá
      // dejaría la grilla semanal desincronizada).
      action.className = 'rutina-edit-btn';
      action.setAttribute('aria-label', 'Editar itinerario');
      action.textContent = '✎';
      action.addEventListener('click', () => {
        const it = currentIts.find((x) => x.id === a.itId);
        if (it) startEditItinerary(it);
      });
    }

    li.append(badge, body, action);
    listEl.appendChild(li);
  });
}

// Los recordatorios de dispositivo viven en localStorage (una sola vez en
// web/PWA; con repetición y alarma real en la APK vía AlarmManager). Los
// itinerarios, en cambio, siempre se cargan si hay sesión: su recordatorio
// llega por Web Push desde el servidor, sin depender de la plataforma.
function refreshState() {
  const gate = document.getElementById('rutina-apk-gate');
  if (gate) gate.classList.toggle('hidden', IN_APK);
  render();
  loadItinerariesOnBoot();
  const note = document.getElementById('rutina-platform-note');
  if (note) {
    note.textContent = IN_APK
      ? 'En la APK estas alarmas las programa el reloj del sistema de Android: siguen sonando con la app cerrada y con pantalla bloqueada (con vibración).'
      : 'En la web/PWA estos recordatorios suenan mientras la pestaña está abierta. Para repetición semanal con alarma real y vibración, instalá la APK.';
    note.classList.remove('hidden');
  }
}

// Toda la rutina (recordatorios + itinerarios) es de cuenta: sin sesión se
// muestra el gate de login en vez de #rutina-content. `getAccessToken()`
// solo comprueba que HAY un token guardado (no que siga siendo válido) —
// igual criterio que el resto de la app; una sesión realmente vencida la
// detecta loadItineraries() (401) y dispara 'vyneural:auth' vía
// expireSession(), que re-ejecuta esto y muestra el gate.
function updateAuthGate() {
  const gateEl = document.getElementById('rutina-auth-gate');
  const contentEl = document.getElementById('rutina-content');
  const loggedIn = !!getAccessToken();
  if (gateEl) gateEl.hidden = loggedIn;
  if (contentEl) contentEl.hidden = !loggedIn;
}

document.addEventListener('DOMContentLoaded', () => {
  updateAuthGate();
  const gateLoginBtn = document.getElementById('rutina-auth-gate-login');
  if (gateLoginBtn) {
    gateLoginBtn.addEventListener('click', () => {
      if (window.__vyneuralAuth) window.__vyneuralAuth.open('login');
    });
  }
  wireReminderForm();
  wireItineraryForm();
  // Persistencia durable sin bloquear el arranque (mismo patrón que
  // src/main.js): el espejo localStorage ya deja ver algo mientras tanto.
  refreshState();
  createDurableStore()
    .then((store) => {
      alarmManagerInstance.store = store;
      return alarmManagerInstance.init();
    })
    .then(render)
    .catch(() => {});
  window.addEventListener('storage', render);
  // Autenticarse / cerrar sesión / que la sesión venza: refrescar el gate y
  // (si corresponde) los itinerarios.
  document.addEventListener('vyneural:auth', () => {
    updateAuthGate();
    loadItineraries();
  });
  const go = document.getElementById('rutina-go');
  if (go) go.addEventListener('click', () => (location.href = '/#alarms-view'));
});
