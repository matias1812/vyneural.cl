// src/core/plate-field.js
// Fuente ÚNICA del estado modal del plato de Faraday — Parte A de la
// auditoría 2026-09-08 ("una sola cimática, dos cámaras").
//
// Hasta esta auditoría, src/cymatics.js definía toda esta física para su
// propio uso (vista 2D). La decisión de arquitectura de esta tanda es que
// NINGÚN renderer recalcule modos por su cuenta: acá vive el radio del
// plato, las tablas de ceros de Bessel, la búsqueda de modo, el ancho de
// resonancia y las funciones de Bessel en sí — tanto la vista 2D
// (cymatics.js) como la futura vista 3D (Parte D) y el validador cruzado
// FDTD↔modal (Parte E, src/validation/diagnostics.js) importan de acá.
//
// Todo lo de este archivo es PHYSICAL o DERIVED (dispersión real, borde
// libre real, geometría real del plato) salvo donde se marca HEURISTIC
// explícitamente (haberlo movido de cymatics.js no cambia esa clasificación
// — ver el vocabulario de procedencia ya establecido ahí).

import { G, SIGMA_RHO, faradayWavenumber } from './wave-physics.js';

export const TWO_PI = Math.PI * 2;

// --------------------------------------------------------------------------
// Ceros de J'_m (m = 0 … 6): modos radiales de una cuenca circular con
// pared vertical (condición de borde libre de la superficie: J'_m(k a) = 0).
// Los modos angulares (m ≥ 2) son los que producen los patrones florales y
// la deriva/rotación real de la cimática de Faraday.
// --------------------------------------------------------------------------
const ZP0 = [
  3.8317, 7.0156, 10.1735, 13.3237, 16.4706, 19.6159,
  22.7601, 25.9037, 29.0468, 32.1897,
];
const ZP1 = [
  1.8412, 5.3314, 8.5363, 11.706, 14.8636, 18.0155,
  21.1644, 24.3113, 27.4571, 30.6019,
];
const ZP2 = [
  3.0542, 6.7061, 9.9695, 13.1704, 16.3475, 19.5129,
  22.6716, 25.826, 28.9777, 32.1273,
];
const ZP3 = [
  4.2012, 8.0152, 11.3459, 14.5858, 17.7887, 20.9725,
  24.1449, 27.3101, 30.4703, 33.6267,
];
const ZP4 = [
  5.3176, 9.2824, 12.6819, 15.9641, 19.196, 22.401,
  25.5898, 28.7678, 31.9372, 35.0995,
];
const ZP5 = [
  6.4156, 10.5199, 13.9872, 17.3128, 20.5755, 23.8038,
  27.0103, 30.2028, 33.3854, 36.5607,
];
const ZP6 = [
  7.5013, 11.7349, 15.2682, 18.6374, 21.9317, 25.1839,
  28.4065, 31.6089, 34.7967, 37.9737,
];
// Exportado para validación numérica en Node (FASE 20 / Parte E de esta
// auditoría, src/validation/diagnostics.js) sin arrastrar renderer alguno
// — son funciones y tablas puras.
export const ZP_BY_M = [ZP0, ZP1, ZP2, ZP3, ZP4, ZP5, ZP6];

// FIX (2026-09-08): tope real de las búsquedas de modo radial de más abajo.
// Antes era 10 a secas (el largo de las columnas ZP_BY_M) — calibrado
// alrededor de REF_F=220 Hz, nunca revisado cuando el slider de portadora
// personalizada llegó a 1000 Hz ni cuando se agregó el preset "963 Hz ·
// Divino". Por encima de ~650 Hz NINGÚN modo (m≤6, n≤10) cae remotamente
// cerca de ω_s=π·f, y como Γ(f) se angosta a propósito con la frecuencia
// (más abajo, gammaAt), el desafiño resultante hunde la amplitud de
// Lorentz a ~10⁻⁵ — la gota queda invisible tras el asentado del modo, NO
// un glitch de un frame (medido: 963 Hz con la tabla vieja → amplitud
// 0,00004; con este tope → 0,15, usando el modo m=2,n=17 que ahora SÍ
// entra en el rango de búsqueda gracias a zeroFor() de abajo). 24 deja
// margen sobre ese n=17 sin explorar un rango absurdo (el costo es
// O(5·MAX_RADIAL_MODE) por re-anclaje de modo, no por frame).
export const MAX_RADIAL_MODE = 24;

// Ceros de J'_m para m > 6, o m ≤ 6 con n > 10 (aproximación de McMahon,
// suficiente para el matiz de resonancia de los modos de detalle 2m/3m, que
// no están en las tablas): j'_{m,1} ≈ m + 0,80862·m^(1/3) y la separación
// entre ceros consecutivos tiende a π.
//
// ERROR MEDIDO (auditoría 2026-09-08, deuda de verificación externa — dos
// críticas independientes estimaron ~4% de error en m=6,n=17): se verificó
// numéricamente con un buscador de ceros propio sobre la recurrencia real
// de Bessel (validado primero contra ZP_BY_M, la tabla publicada). El orden
// de magnitud es correcto — el error CRECE con m y DECRECE con n dentro de
// cada m, alcanzando varios % (un puñado, no decenas) en la zona m∈[4,6],
// n∈[11,24] que SÍ es alcanzable en uso real (ver el comentario de
// MAX_RADIAL_MODE arriba, caso 963 Hz). NO se fija acá un número exacto de
// error: al intentar construir una tabla de reemplazo de alta precisión
// para confirmarlo con más decimales, se encontró que la MISMA recurrencia
// ascendente de besselJArray() (usada como árbitro) acumula su propio error
// creciente para m≥4 en n>~8 — ~2,6e-2 absoluto medido en m=6,n=10, ya del
// orden del error que se buscaba medir. Arreglar eso bien pide recurrencia
// descendente (algoritmo de Miller), una tarea numérica aparte; ver el test
// "zPrimeApprox is monotonically increasing with ~π spacing" en
// diagnostics.js para lo que SÍ se garantiza sin ese trabajo adicional.
// Impacto real: un modo (m,n) en este rango puede desafinarse por un
// puñado de % en su ω de resonancia — suficiente para mover qué modo gana
// selectNearestMode() cuando dos quedan cerca, pero no una falla catastrófica.
export function zPrimeApprox(m, n) {
  return m + 0.80862 * Math.cbrt(m) + (n - 1) * Math.PI;
}

// Cero j'_{m,n} — tabla exacta cuando existe, aproximación de McMahon fuera
// de ella (antes solo se usaba zPrimeApprox para m > 6; para m ≤ 6 con
// n > 10 el acceso a la tabla devolvía `undefined` y modeOmega daba NaN —
// una trampa esperando a que alguien subiera el límite de búsqueda sin
// tocar esto, ver MAX_RADIAL_MODE arriba).
export function zeroFor(m, n) {
  const table = ZP_BY_M[m];
  if (table && n <= table.length) return table[n - 1];
  return zPrimeApprox(m, n);
}

// Frecuencia de resonancia (rad/s) del modo (m, n) de la cuenca de radio a:
//   ω² = g·k + (σ/ρ)·k³,  k = j'_{m,n}/a
// Es la dispersión real; la diferencia δ = ω_res − ω_s con la excitación es
// el batido que produce la rotación/deriva observada en cimática real.
export function modeOmega(m, n, a) {
  const k = zeroFor(m, n) / a;
  return Math.sqrt(G * k + SIGMA_RHO * k * k * k);
}

// --------------------------------------------------------------------------
// Radio físico del plato — LA fuente de `a` para todo el sistema (2D, 3D y
// el validador FDTD). Se elige para que a 220 Hz (la portadora de
// referencia) quepan exactamente REF_RINGS anillos con el borde libre:
//   a = j'_{0,6} / k(220 Hz)  ≈ 10,5 mm  (una cuenca real de ~2 cm,
//   mostrada ampliada).
// --------------------------------------------------------------------------
export const REF_F = 220;
export const REF_RINGS = 6;
export const PHYS_A = ZP0[REF_RINGS - 1] / faradayWavenumber(REF_F);

// Anillos visibles para una frecuencia dada: número de longitudes de onda
// (π·k·a) que caben en el plato, redondeado al modo radial más cercano.
export function ringsFor(f) {
  const r = Math.round((faradayWavenumber(f) * PHYS_A) / Math.PI);
  return Math.max(1, Math.min(ZP0.length, r));
}

// --------------------------------------------------------------------------
// Ancho de resonancia — el ÚNICO modelo de amortiguación del sistema desde
// esta auditoría (antes wavefield.js tenía el suyo propio, independiente;
// ver Parte E: wavefield.js pasa a validador, no a motor de render, así que
// ya no necesita un modelo de amortiguación propio para la ruta visible).
//
// PHASE 8 (preexistente): Frequency-dependent resonance width Γ(ω_s). En
// cimática real la banda de resonancia se angosta a mayor frecuencia (el
// factor de calidad Q = ω_s/Γ crece con la frecuencia porque las ondas
// capilares tienen menos amortiguación que las de gravedad). A ω_s baja
// (pocos Hz) la amortiguación es ancha (Γ ≈ 25 rad/s); a ω_s alta (>300 Hz)
// se angosta hacia Γ_min. Modelo: Γ(f) = Γ_max / (1 + f/f_half).
// --------------------------------------------------------------------------
export const GAMMA_MAX = 25; // rad/s — régimen de baja frecuencia (ondas de gravedad)
export const GAMMA_MIN = 6; // rad/s — piso de alta frecuencia (régimen capilar)
export const GAMMA_HALF = 80; // Hz — frecuencia de cruce
export function gammaAt(f) {
  return GAMMA_MIN + (GAMMA_MAX - GAMMA_MIN) / (1 + f / GAMMA_HALF);
}

// Amplitud resonante (tipo Lorentz) de un modo angular desafinado en δ: un
// modo lejos de la resonancia aporta poco al patrón, como en el agua real.
export function lorentz(delta, f) {
  const g = gammaAt(f != null ? f : 100);
  return 1 / (1 + (delta / g) * (delta / g));
}

// --------------------------------------------------------------------------
// Búsqueda de modo — generaliza los 3+ bucles idénticos que existían
// dispersos en cymatics.js (búsqueda primaria m∈[2,6], fallback m∈[0,1],
// y el mapeo beat→autovalor de FIX P1): dado un ω objetivo, devuelve el
// modo (m, n) —dentro del rango [mMin, mMax]×[1, MAX_RADIAL_MODE]— cuya
// resonancia cae más cerca.
// --------------------------------------------------------------------------
export function selectNearestMode(targetOmega, a, { mMin = 2, mMax = 6, nMax = MAX_RADIAL_MODE } = {}) {
  let bestM = mMin;
  let bestN = 1;
  let bestOmega = modeOmega(mMin, 1, a);
  let bestDelta = Math.abs(bestOmega - targetOmega);
  for (let m = mMin; m <= mMax; m++) {
    for (let n = 1; n <= nMax; n++) {
      const omega = modeOmega(m, n, a);
      const delta = Math.abs(omega - targetOmega);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestM = m;
        bestN = n;
        bestOmega = omega;
      }
    }
  }
  return { m: bestM, n: bestN, omega: bestOmega, delta: bestOmega - targetOmega };
}

// Igual que selectNearestMode, pero con el fallback a m=0 (anillos
// concéntricos) / m=1 (espiral de un brazo) cuando el mejor modo m≥2 queda
// desafinado por más de 2·Γ(f) — modos de Bessel físicos reales que
// aparecen en cimática real a frecuencias de excitación muy bajas donde
// ningún modo m≥2 está cerca de resonancia.
export function selectModeWithFallback(targetOmega, a, f, opts = {}) {
  const primary = selectNearestMode(targetOmega, a, { mMin: 2, mMax: 6, ...opts });
  const twoGamma = 2 * gammaAt(f);
  if (Math.abs(primary.delta) <= twoGamma) return primary;
  const fallback = selectNearestMode(targetOmega, a, { mMin: 0, mMax: 1, ...opts });
  return Math.abs(fallback.delta) < Math.abs(primary.delta) ? fallback : primary;
}

// PARTE A (fix "sigue dando saltos", 2026-09-03 — preexistente en
// cymatics.js, movido acá tal cual): saltar directo al modo (m,n) más
// cercano a la frecuencia objetivo hacía que el fundido cruzado fuera un
// cross-dissolve entre dos flores que podían ser muy distintas. Devuelve la
// resonancia INMEDIATA siguiente hacia el objetivo — el candidato con ω más
// cercana a la ω ACTUAL, estrictamente entre la actual y la del objetivo —
// nunca el objetivo mismo si hay algo más cerca en el camino.
// CONFIRMADO (2026-09-08, "no es estable" / colisionador de frecuencias):
// esta predicción se cumplió. cymatics.js seguía llamando a esto una vez
// por CICLO de transición (no por fotograma) para dar "un solo paso" hacia
// el objetivo real — con el candado de modo sirviendo un paso por fundido
// completo, un objetivo a muchos pasos de distancia (ej. df=963 Hz necesita
// n≈17 desde n≈6) encadenaba 10-30 transiciones sucesivas sin converger en
// minutos, en vez de una sola. Quitado de cymatics.js: con la relajación
// física independiente de Parte B (oldW/newW ya no complementarios), saltar
// directo al objetivo no reintroduce el "corte brusco entre dos flores muy
// distintas" que esto evitaba originalmente bajo el fundido cruzado
// anterior. Ya SIN consumidores reales — se conserva exportada por si un
// futuro renderer (Parte D, 3D) la necesita, pero no debe usarse para
// limitar cuántos pasos de modo puede dar una transición del fundido de
// Parte B.
export function modeStepToward(curM, curN, tgtM, tgtN, mMin, a = PHYS_A) {
  if (curM === tgtM && curN === tgtN) return { m: tgtM, n: tgtN };
  const curW = modeOmega(curM, curN, a);
  const tgtW = modeOmega(tgtM, tgtN, a);
  if (tgtW === curW) return { m: tgtM, n: tgtN };
  const dir = tgtW > curW ? 1 : -1;
  let bestM = tgtM;
  let bestN = tgtN;
  let bestGap = Math.abs(tgtW - curW);
  for (let mm = mMin; mm <= 6; mm++) {
    for (let n2 = 1; n2 <= MAX_RADIAL_MODE; n2++) {
      if (mm === curM && n2 === curN) continue;
      const ww = modeOmega(mm, n2, a);
      const gap = (ww - curW) * dir;
      if (gap > 1e-6 && gap < bestGap) {
        bestGap = gap;
        bestM = mm;
        bestN = n2;
      }
    }
  }
  return { m: bestM, n: bestN };
}

// --------------------------------------------------------------------------
// Mapeo beat → autovalor físico (antes "FIX P1: Decouple center drop from
// binaural beat" en cymatics.js). El latido binaural (Δf) es el ESTÍMULO;
// el sistema visual lo mapea al autovalor físico más cercano de la MISMA
// cuenca (misma relación de dispersión que las otras gotas/vértices). La
// gota/vértice central visualiza la resonancia física más cercana al
// latido, no el latido en sí — una metáfora modal, no una afirmación
// causal directa.
// --------------------------------------------------------------------------
export function resonantModeForBeat(beatOrCarrier, a = PHYS_A) {
  const wsBeat = Math.PI * Math.max(1, beatOrCarrier); // subarmónico de Faraday
  const mode = selectNearestMode(wsBeat, a, { mMin: 2, mMax: 6, nMax: 6 });
  return {
    m: mode.m,
    n: mode.n,
    omega: mode.omega,
    detuning: mode.omega - wsBeat,
    fCenter: mode.omega / Math.PI, // frecuencia resonante (Hz) del modo
  };
}

// --------------------------------------------------------------------------
// Funciones de Bessel (modos radiales de la cuenca) — evaluador compartido
// del campo. J0/J1 por serie de potencias (x < 8) y forma asintótica
// (x ≥ 8); J_m para m ≥ 2 por la recurrencia estándar
// J_m(x) = (2(m-1)/x)·J_{m-1}(x) − J_{m-2}(x).
//
// FIX (auditoría 2026-09-08, deuda de verificación externa — hallazgo
// independiente, no reportado por ninguna de las dos críticas externas que
// motivaron esta auditoría): las dos ramas no coincidían en el borde x=8,
// por DOS bugs distintos que se enmascaraban entre sí:
//   1. La rama asintótica (x≥8) SOLO tenía el término de orden líder
//      (A&S 9.2.5 con P≈1, Q≈0), sin la corrección O(1/x) estándar.
//   2. La serie de potencias (x<8) cortaba en 10 términos — insuficiente
//      para converger cerca de x=8 (con 10 términos, J0(7,99) da 0,1836;
//      el valor real es 0,17399, ~5,5% de error ahí mismo).
// Ambos se detectaron al intentar generar una tabla de ceros de referencia
// de alta precisión (ver docs/validation-report.md, FASE 20) y notar que
// ni las dos ramas del propio código coincidían entre sí en su frontera.
// Con el término Q añadido (A&S 9.2.5, ν=0 y ν=1) y la serie subida a 16
// términos, el artefacto residual de frontera baja a ~2-4e-5 (medido con
// h→0 para aislarlo de la pendiente natural de J0/J1 en x=8, que por sí
// sola ya produce un cambio real de varios e-3 con una h "normal" como
// 0,01 — ver el comentario del test de continuidad en diagnostics.js para
// el detalle de por qué eso importa al medir esto).
// --------------------------------------------------------------------------
export function besselJ0(x) {
  x = Math.abs(x);
  if (x < 1e-4) return 1;
  if (x < 8) {
    const xx = x * x;
    let s = 1;
    let term = 1;
    for (let k = 1; k <= 16; k++) {
      term *= -xx / (4 * k * k);
      s += term;
    }
    return s;
  }
  const w = x - Math.PI / 4;
  return Math.sqrt(2 / (Math.PI * x)) * (Math.cos(w) * (1 - 9 / (128 * x * x)) + Math.sin(w) / (8 * x));
}

export function besselJ1(x) {
  x = Math.abs(x);
  if (x < 1e-4) return 0;
  if (x < 8) {
    const half = x / 2;
    const xx = x * x;
    let s = half;
    let term = half;
    for (let k = 1; k <= 16; k++) {
      term *= -xx / (4 * k * (k + 1));
      s += term;
    }
    return s;
  }
  const w = x - (3 * Math.PI) / 4;
  return Math.sqrt(2 / (Math.PI * x)) * (Math.cos(w) * (1 + 15 / (128 * x * x)) - (3 * Math.sin(w)) / (8 * x));
}

// --------------------------------------------------------------------------
// Cámara lenta compartida (VISUAL, no física) — Parte B de "una sola
// cimática, dos cámaras" (auditoría 2026-09-08). El subarmónico de Faraday
// de cualquier portadora audible oscila muy por encima de los 60 FPS
// visibles (ver la nota de cymatics.js sobre por qué hoy solo se pinta el
// envolvente), así que toda vista temporal necesita desacelerar su reloj
// por el MISMO factor: si cada vista eligiera el suyo, la misma frecuencia
// real oscilaría a un ritmo distinto según la vista, rompiendo la premisa
// de "un solo campo, dos cámaras". Heredado tal cual del K_VIS que ya usaba
// Gotas (src/main.js) antes de esta auditoría — no se recalibra, se nombra
// y se comparte para que Parte B (τ de transición) y Parte D (oscilación
// real de Cimática) usen el mismo reloj sin poder desincronizarse.
//
// (Parte D — oscilación real de Cimática — es el único uso real de este
// factor; ver cymatics.js para dónde envuelve una oscilación visible).
export const SLOWMO_K = 330;

// --------------------------------------------------------------------------
// Duración del fundido cruzado al cambiar de modo (Parte B, cymatics.js) —
// τ_fundido(f) = MORPH_BLEND_K / gammaAt(f). Un valor DISTINTO de SLOWMO_K a
// propósito: SLOWMO_K existe para que la envolvente de un modo acompañe SU
// PROPIA oscilación ya mostrada en cámara lenta (sin romper su Q, ver el
// mismo criterio documentado junto al suavizado de volumen en cymatics.js:
// "el factor SLOWMO_K existe para que la envolvente de un modo acompañe su
// propia oscilación... el volumen no envuelve ninguna oscilación visible, es
// un multiplicador escalar puro, así que su inercia es en tiempo REAL"). Un
// fundido cruzado entre dos flores tampoco envuelve una oscilación visible —
// es, por esa misma regla ya establecida en el código, un caso de tiempo
// REAL, no de cámara lenta. Reusar SLOWMO_K ahí (auditoría 2026-09-08, bug
// real, no una decisión de diseño) estiraba cada transición a
// SLOWMO_K/GAMMA_MIN·4 ≈ 220s en el peor caso (963 Hz: ~177s medido) — el
// modo queda con su búsqueda BLOQUEADA (ver lockSrc en cymatics.js) durante
// toda esa ventana, así que cualquier cambio de frecuencia real que llegue
// mientras tanto queda sin efecto visible hasta que por fin se libera — el
// patrón se ve congelado y después salta de golpe, exactamente el reporte
// de "colisionador de frecuencias" / transiciones erráticas. MORPH_BLEND_K
// se eligió para que el peor caso natural (4τ, GAMMA_MIN) quede cerca del
// fundido fijo ~7 s que tenía el sistema ANTES de la Parte B (ver el
// comentario de `alreadyMorphing` en cymatics.js) — real (1,7–5,4 s en el
// rango de portadoras usado por la app), no un salto duro ni un
// bloqueo de minutos.
export const MORPH_BLEND_K = 10;

// Llena `out[0..maxM]` con J_0(x)..J_{maxM}(x). `out` lo provee el
// llamador (no se asigna acá) porque esto corre en el hot loop de
// fillRadTableRows() de cymatics.js (miles de llamadas por reconstrucción
// de tabla) — asignar un array nuevo por píxel presionaría al GC justo ahí.
export function besselJArray(maxM, x, out) {
  out[0] = besselJ0(x);
  if (maxM < 1) return out;
  if (x < 1e-3) {
    for (let m = 1; m <= maxM; m++) out[m] = 0;
    return out;
  }
  out[1] = besselJ1(x);
  for (let m = 2; m <= maxM; m++) {
    out[m] = ((2 * (m - 1)) / x) * out[m - 1] - out[m - 2];
  }
  return out;
}
