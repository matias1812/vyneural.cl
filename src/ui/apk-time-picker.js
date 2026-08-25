// Reemplazo del <input type="time"> nativo, SOLO dentro de la APK.
//
// Por qué: el WebView de Android muestra su propio TimePickerDialog nativo
// para <input type="time"> (fuera de nuestro control — no hay ningún
// WebChromeClient propio en MainActivity.kt que lo intercepte). Confirmado
// en producción con evidencia directa del backend: un recordatorio guardado
// para "12:56" (mediodía) quedó agendado para las 00:56 (medianoche) — un
// desfasaje exacto de 12 h, clásico bug de conversión 12h→24h al tocar "12"
// con AM/PM en PM en el widget nativo del propio WebView. No hay forma de
// detectar esto después de leer `.value`: el navegador entrega un string
// sintácticamente válido ("00:56"), solo que MAL.
//
// La solución: no delegar la conversión a NINGÚN widget nativo. Reemplaza el
// input (mismo nodo DOM, mismo id — todo el código existente que hace
// getElementById(id).value sigue funcionando sin cambios) por tres <select>
// (hora 1-12, minuto, AM/PM) que calculan el HH:MM de 24 h en JS puro,
// auditable y determinista.
//
// Uso: mountApkTimePicker('alarm-time') una vez, después de que el input
// exista en el DOM. Si el código de la página asigna `elId.value = 'HH:MM'`
// programáticamente en otro momento (p. ej. un default, o precargar un valor
// al editar), hay que llamar también a resyncApkTimePicker('alarm-time')
// justo después para que los <select> visibles reflejen ese valor — si no,
// quedan mostrando lo viejo aunque el valor real ya cambió.

const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12

export function to24h(h12, minute, ampm) {
  let h = h12 % 12; // 12 -> 0
  if (ampm === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${minute}`;
}

export function from24h(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!m) return { h12: 12, minute: '00', ampm: 'PM' };
  const h24 = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const minute = m[2];
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return { h12, minute, ampm };
}

function buildSelect(className, options, labelFor) {
  const sel = document.createElement('select');
  sel.className = className;
  options.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = labelFor ? labelFor(value) : String(value);
    sel.appendChild(opt);
  });
  return sel;
}

const _mounted = new Map(); // id -> { hourSel, minSel, ampmSel }

/** Monta el picker de selects sobre un <input type="time"> existente. El
 *  input pasa a type="hidden" (MISMO nodo, mismo id) y queda como la única
 *  fuente de verdad que lee el resto del código. No-op si ya está montado o
 *  si el elemento no existe. */
export function mountApkTimePicker(inputId) {
  if (_mounted.has(inputId)) return;
  const input = document.getElementById(inputId);
  if (!input || input.type === 'hidden') return;

  input.type = 'hidden';

  const hourSel = buildSelect('apk-time-hour', HOURS_12);
  const minSel = buildSelect('apk-time-minute', MINUTES);
  const ampmSel = buildSelect('apk-time-ampm', ['AM', 'PM']);

  const sync = () => {
    const h12 = parseInt(hourSel.value, 10);
    const next = to24h(h12, minSel.value, ampmSel.value);
    if (input.value === next) return;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  hourSel.addEventListener('change', sync);
  minSel.addEventListener('change', sync);
  ampmSel.addEventListener('change', sync);

  const wrap = document.createElement('div');
  wrap.className = 'apk-time-picker';
  wrap.appendChild(hourSel);
  const sep = document.createElement('span');
  sep.className = 'apk-time-sep';
  sep.textContent = ':';
  wrap.appendChild(sep);
  wrap.appendChild(minSel);
  wrap.appendChild(ampmSel);
  input.insertAdjacentElement('afterend', wrap);

  _mounted.set(inputId, { hourSel, minSel, ampmSel });
  resyncApkTimePicker(inputId);
}

/** Alinea los <select> visibles al valor ACTUAL del input (hidden). Llamar
 *  después de cualquier asignación programática de `.value` (defaults,
 *  precarga al editar) — si no, los selects quedan mostrando un valor viejo
 *  aunque el input ya tenga el nuevo. No-op si el picker no está montado
 *  para ese id (p. ej. en web/desktop, donde nunca se monta). */
export function resyncApkTimePicker(inputId) {
  const refs = _mounted.get(inputId);
  if (!refs) return;
  const input = document.getElementById(inputId);
  if (!input) return;
  const st = from24h(input.value);
  refs.hourSel.value = String(st.h12);
  refs.minSel.value = st.minute;
  refs.ampmSel.value = st.ampm;
  if (!input.value) input.value = to24h(st.h12, st.minute, st.ampm);
}
