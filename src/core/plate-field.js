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
  24.1449, 27.3101, 30.4703, 33.6269,
];
const ZP4 = [
  5.3176, 9.2824, 12.6819, 15.9641, 19.196, 22.401,
  25.5898, 28.7678, 31.9385, 35.1039,
];
const ZP5 = [
  6.4156, 10.5199, 13.9872, 17.3128, 20.5755, 23.8036,
  27.0103, 30.2028, 33.3854, 36.5608,
];
const ZP6 = [
  7.5013, 11.7349, 15.2682, 18.6374, 21.9317, 25.1839,
  28.4098, 31.6179, 34.8134, 37.9996,
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

// Término LÍDER de la expansión de McMahon para j'_{m,n}:
//   j'_{m,1} ≈ m + 0,80862·m^(1/3), separación entre ceros consecutivos → π.
//
// ESTADO (auditoría 2026-11-06, cierre de la deuda que esta misma función
// documentaba como "SIGUE ABIERTO"): **ya NO está en la ruta de producción.**
// `zeroFor()` más abajo resuelve los ceros numéricamente a precisión de
// máquina. Esto se conserva exportado solo como (a) sujeto del test de
// cordura asintótica de diagnostics.js ("monotonically increasing with ~π
// spacing" — espaciado EXACTAMENTE π por construcción, propiedad que el
// orden líder sí garantiza y que los órdenes superiores no) y (b) registro
// histórico de la aproximación que estuvo en producción hasta esta auditoría.
// NO usarla como fuente de ceros: medido contra una referencia de 80 dígitos
// (serie de potencias A&S 9.1.10 en punto fijo BigInt + bisección, ver abajo),
// su error relativo llega a **11,1 %** en la grilla alcanzable m∈[0,16],
// n∈[1,24] (peor celda m=0,n=11: 31,416 vs 35,332 real) con 5,3 % de media;
// en la banda m∈[4,6], n∈[11,24] que el comentario viejo señalaba, 5,6 %
// peor caso / 3,5 % media. La consecuencia real medida era mucho peor de lo
// que decía el comentario anterior ("mueve qué modo gana cuando dos quedan
// cerca"): barriendo 60-1000 Hz (el rango visual real tras el clamp de
// `clampVisualFreq` en main.js) el (m,n) elegido por selectModeWithFallback
// difería del que elige la física exacta en **53,0 % de las frecuencias**
// (1995/3761), y el número de pétalos m difería en todas ellas — media
// literal de "se dibuja la flor equivocada". El desafine real contra el
// espectro verdadero promediaba 62,5 rad/s con Γ(f) ∈ [7,4; 16,9] rad/s,
// o sea ~4-8 anchos de línea fuera de resonancia (con ceros exactos:
// 15,7 rad/s, ~1-2 anchos).
export function zPrimeApprox(m, n) {
  return m + 0.80862 * Math.cbrt(m) + (n - 1) * Math.PI;
}

// Expansión asintótica de McMahon de ORDEN SUPERIOR para j'_{m,n}
// (DLMF §10.21(viii), ec. 10.21.20 — la expansión de los ceros de J'_ν, que
// NO es la de A&S 9.5 / DLMF 10.21.19: esa es para los ceros de J_ν y usa
// a=(n+ν/2−1/4)π con numeradores distintos; confundirlas es el error fácil):
//
//   μ = 4m² ,  b = (n + m/2 − 3/4)·π
//   j'_{m,n} ~ b − (μ+3)/(8b)
//                − 4(7μ² + 82μ − 9) / (3·(8b)³)
//                − 32(83μ³ + 2075μ² − 3039μ + 3537) / (15·(8b)⁵)
//
// Los tres coeficientes se VERIFICARON empíricamente contra la referencia de
// 80 dígitos en vez de confiar en la transcripción (el mismo audit encontró
// que unas constantes "de alta precisión" escritas de memoria estaban mal en
// los últimos dígitos): pelando los términos uno a uno de los ceros reales y
// extrapolando el residuo escalado a b→∞ para m ∈ {0,1,2,3,4,5,6,8,12,16},
// los límites caen sobre las tres formas cerradas con error relativo
// ≤6,3e-5 (término 1/b), ≤1,6e-4 (1/b³) y ≤2,4e-4 (1/b⁵) — diez valores de μ
// distintos contra polinomios de coeficientes enteros fijos, que no sobreviven
// a una constante mal tipeada. El pelado del tercer término HAY que hacerlo en
// aritmética exacta: en float64 cancela ~145 hasta ~3,6e-12 y el "fallo" que
// aparenta (21 % en m=0) es cancelación catastrófica, no un coeficiente malo.
//
// CONVENCIÓN DE ÍNDICE: para m=0, x=0 es él mismo un cero de J'_0 y DLMF lo
// cuenta como j'_{0,1}, mientras que ZP0 acá arranca en el primer cero
// POSITIVO (3,8317). De ahí el corrimiento n→n+1 solo en m=0 (verificado:
// con n=1 sin corrimiento da 0,308; con corrimiento da 3,8315).
//
// Precisión medida en el régimen asintótico donde se la usa (n ≥ 11, m ≤ 6):
// 1,3e-5 % peor caso. Fuera de él NO sirve sola (n ≤ 4 con m ≥ 7: hasta
// 7,1 % de error) — por eso es el plan B para n por encima del tope del
// resolvedor, no la ruta principal.
export function mcmahonZeroJPrime(m, n) {
  const nn = m === 0 ? n + 1 : n;
  const b = (nn + m / 2 - 0.75) * Math.PI;
  const mu = 4 * m * m;
  const b8 = 8 * b;
  return (
    b -
    (mu + 3) / b8 -
    (4 * (7 * mu * mu + 82 * mu - 9)) / (3 * b8 * b8 * b8) -
    (32 * (83 * mu * mu * mu + 2075 * mu * mu - 3039 * mu + 3537)) / (15 * b8 * b8 * b8 * b8 * b8)
  );
}

// --------------------------------------------------------------------------
// Ceros de J'_m EXACTOS (a precisión de máquina) — barrido con bracketing +
// Newton resguardado, memorizado por columna m.
//
// Por qué así y no de otra forma (auditoría 2026-11-06, se midieron las tres
// vías contra la referencia de 80 dígitos antes de elegir):
//
//   (a) Solo McMahon de orden superior (mcmahonZeroJPrime arriba): excelente
//       en n ≥ 11 (1,3e-5 % con m ≤ 6) pero 7,1 % de error en n ≤ 4 con
//       m ≥ 7 — y esas celdas SÍ se usan: las capas de filigrana 2m/3m/4m
//       llegan a m=16 con el MISMO n chico del modo dominante (ver mD1..mD3
//       en cymatics.js). Insuficiente sola.
//   (b) Newton sembrado con zPrimeApprox (el camino "obvio", reusa lo ya
//       validado): FALLA, y fuerte. Con el sesgo de hasta 11 % del orden
//       líder la semilla cae a más de media separación (π/2) del cero que
//       debería encontrar, así que Newton converge a OTRO cero: medido,
//       318/408 celdas aterrizan en un cero que no es j'_{m,n} y la
//       monotonía en n se rompe 49 veces. Descartada por medición, no por
//       intuición. (Sembrado con McMahon de orden 3 sí da 0/408 — pero eso
//       ya es esta misma ruta con un paso extra de fe en la asintótica.)
//   (c) Barrido secuencial con bracketing + Newton resguardado (esto): el
//       ÍNDICE del cero es correcto por construcción —se cuentan los cambios
//       de signo en orden desde x≈0, no se "adivina" dónde cae el n-ésimo—
//       así que la monotonía estricta en n es estructural, no medida, y no
//       depende de la precisión de ninguna fórmula asintótica. Medido:
//       1,2e-13 % peor caso en toda la grilla m∈[0,16], n∈[1,24].
//
// Además esto corrigió un segundo problema que el audit encontró de paso y
// que zPrimeApprox no explicaba: la propia tabla ZP_BY_M, escrita a mano,
// tenía error REAL en su cola — 9 celdas por encima de su propia precisión
// de 4 decimales (peor caso m=6,n=10: 37,9737 tabulado vs 37,999641 real,
// 2,6e-2 absoluto), en m=3 n=10, m=4 n=9-10, m=5 n=6 y n=10, y m=6 n=7-10.
// Todas caían DENTRO del rango de búsqueda primario (m∈[2,6], n≤24), o sea
// alcanzables en uso real. Se arbitró por residuo en aritmética exacta:
// |J'_m(tabulado)| coincidía con |J''_m · (tabulado − real)| en 3-4 cifras
// en esas celdas, la firma inequívoca de estar corridas por ese delta. El
// test existente de A&S 9.5 en diagnostics.js nunca lo vio porque solo
// compara n=1..3, justo donde la tabla sí es buena. **Corregido** (auditoría
// 2026-11-07): las 9 celdas se re-tabularon contra zeroFor(), redondeadas a
// la misma precisión de 4 decimales que el resto de la tabla — confirmado
// `grep`-eable que ningún valor de ZP_BY_M difiere hoy de zeroFor() en más
// de 5e-5. ZP_BY_M queda SOLO como (i) ancla de calibración de PHYS_A y
// (ii) fixture del test contra A&S — ya NO es fuente de ceros para nadie;
// no volver a indexarla para eso.
//
// Y un tercer defecto que salió al escribir los tests: el empalme
// tabla→aproximación ni siquiera daba un espectro MONÓTONO. zeroFor(0,10)
// devolvía 32,1897 (tabla) y zeroFor(0,11) devolvía 31,4159 (McMahon de orden
// líder) — el cero n=11 quedaba POR DEBAJO del n=10. selectNearestMode()
// recorre ese espectro asumiéndolo ordenado, y modeStepToward() se apoya
// directamente en que ω crece con n. Con el resolvedor numérico la monotonía
// estricta es estructural (el índice sale de contar cambios de signo en
// orden), y hay un test que la verifica hasta n=90, cruzando el tope del
// resolvedor hacia el plan B de McMahon.
// --------------------------------------------------------------------------

// Paso del barrido. Debe ser menor que la separación mínima entre ceros
// consecutivos, medida sobre la referencia exacta en toda la grilla real:
// 3,141804 (la separación DECRECE monótonamente hacia π desde arriba, propiedad
// que la referencia cumple en las 17 columnas). 0,2 deja ~15× de margen.
const ZERO_SCAN_STEP = 0.2;
// Tope del resolvedor. Por encima se usa McMahon de orden 3, que justamente
// en n grande es asintóticamente exacto — cada método donde es mejor. El tope
// también acota el costo: el barrido llega hasta x ≈ (n + m/2)·π.
const ZERO_SOLVER_M_CAP = 64;
const ZERO_SOLVER_N_CAP = 64;

// Buffer compartido para J_0..J_m (igual criterio que _millerScratch: esto
// corre en el armado de columnas, no por píxel, pero no hay razón para
// asignar por llamada).
let _jpScratch = new Float64Array(72);

// Devuelve [J'_m(x), J''_m(x)].
//   J'_m(x)  = J_{m-1}(x) − (m/x)·J_m(x)        [DLMF 10.6.2]; J'_0 = −J_1
//   J''_m(x) = −(1/x)·J'_m(x) − (1 − m²/x²)·J_m(x)   [ecuación de Bessel]
// Ambas identidades se verificaron contra la referencia de 80 dígitos (las
// tres formas equivalentes de J'_m concuerdan entre sí y con una diferencia
// finita central a 1e-22) antes de usarlas acá.
function _jPrimePair(m, x) {
  const maxM = m < 1 ? 1 : m;
  if (_jpScratch.length < maxM + 2) {
    _jpScratch = new Float64Array(Math.max(maxM + 2, _jpScratch.length * 2));
  }
  const buf = _jpScratch;
  besselJArray(maxM, x, buf);
  const jm = buf[m];
  const jp = m === 0 ? -buf[1] : buf[m - 1] - (m / x) * buf[m];
  const jpp = -jp / x - (1 - (m * m) / (x * x)) * jm;
  return [jp, jpp];
}

// Newton resguardado DENTRO de un bracket [lo, hi] con cambio de signo: si el
// paso de Newton se sale del bracket (o la derivada se anula), cae a bisección.
// Así hereda la convergencia cuadrática de Newton sin poder escaparse del
// intervalo que ya se sabe que contiene exactamente este cero — que es lo que
// hace que el índice no se pueda perder.
function _refineZero(m, lo, hi, fLo) {
  let a = lo;
  let b = hi;
  let fa = fLo;
  let x = 0.5 * (a + b);
  for (let i = 0; i < 60; i++) {
    const [f, d] = _jPrimePair(m, x);
    if (f === 0) return x;
    if ((fa < 0) !== (f < 0)) b = x;
    else { a = x; fa = f; }
    let nx = d !== 0 ? x - f / d : NaN;
    if (!(nx > a && nx < b)) nx = 0.5 * (a + b);
    if (Math.abs(nx - x) <= 1e-15 * x) return nx;
    x = nx;
  }
  return x;
}

// Columnas memorizadas: _zeroCols[m] = { z: Float64Array, count }. Se arman
// una sola vez por m (coste medido: ~1 ms la columna m=6 con 24 ceros, ~15 ms
// la grilla entera de 17 columnas — una vez en la vida del módulo, nunca por
// fotograma) y se rearman solo si alguien pide un n mayor al ya calculado.
const _zeroCols = [];

function _zeroColumn(m, count) {
  const cached = _zeroCols[m];
  if (cached && cached.count >= count) return cached.z;
  const want = Math.max(count, MAX_RADIAL_MODE);
  const z = new Float64Array(want);
  let found = 0;
  // Arranca apenas por encima de 0: para m ≥ 1, J'_m(x) ~ m·x^(m-1)/(2^m·m!)
  // > 0 cerca de 0, y para m = 0, J'_0 = −J_1 < 0 — en ningún caso hay un
  // cero en (0, 0.02), así que el primer cambio de signo detectado ES n=1.
  let xa = 0.02;
  let fa = _jPrimePair(m, xa)[0];
  let guard = 0;
  while (found < want) {
    if (++guard > 100000) break; // red de seguridad; inalcanzable con los topes
    const xb = xa + ZERO_SCAN_STEP;
    const fb = _jPrimePair(m, xb)[0];
    // El test de signo es `(f < 0)`, que manda el 0 exacto al lado POSITIVO,
    // y eso es deliberado: si se descartaran los brackets con un extremo
    // exactamente en 0 (`fa !== 0 && fb !== 0`), un cero que cayera justo
    // sobre un punto del barrido se perdería y TODOS los n siguientes
    // quedarían corridos en uno — justo la garantía de índice por la que se
    // eligió este método. Con sign(0)=+ hay exactamente UNA detección en los
    // dos casos: si el cruce es −→+ con f(xa)=0 se detecta en [xa−paso, xa];
    // si es +→− se detecta en [xa, xb]; y no hay doble conteo porque los
    // ceros de J'_m son todos simples (no hay raíces dobles que toquen el 0
    // y vuelvan).
    if ((fa < 0) !== (fb < 0)) {
      z[found++] = _refineZero(m, xa, xb, fa);
    }
    xa = xb;
    fa = fb;
  }
  if (found < want) return null; // no debería pasar; el llamador cae a McMahon
  _zeroCols[m] = { z, count: want };
  return z;
}

// Cero j'_{m,n} — el n-ésimo cero positivo de J'_m. Resuelto numéricamente
// (precisión de máquina) dentro de los topes del resolvedor; McMahon de orden
// 3 fuera de ellos, donde además es asintóticamente exacto. Nunca devuelve
// `undefined` ni NaN para un (m,n) razonable: el antecesor de esta función
// indexaba ZP_BY_M directo y devolvía `undefined` → modeOmega NaN para
// m ≤ 6 con n > 10 (ver MAX_RADIAL_MODE arriba); ese contrato se mantiene.
// Entradas basura se CLAMPEAN al dominio válido en vez de devolver NaN: esto
// alimenta modeOmega() en la ruta de render, y un NaN acá se propaga a todos
// los cosenos de la tabla radial y deja la gota entera sin dibujar (ese fallo
// exacto ya pasó una vez por el `undefined` de la tabla — ver el comentario de
// zeroFor en cymatics.js:2051). Un cero plausible degrada; un NaN rompe.
export function zeroFor(m, n) {
  let mi = Math.round(m);
  let ni = Math.round(n);
  if (!isFinite(mi) || mi < 0) mi = 0;
  if (!isFinite(ni) || ni < 1) ni = 1;
  if (mi <= ZERO_SOLVER_M_CAP && ni <= ZERO_SOLVER_N_CAP) {
    const col = _zeroColumn(mi, ni);
    if (col) {
      const v = col[ni - 1];
      if (isFinite(v) && v > 0) return v;
    }
  }
  return mcmahonZeroJPrime(mi, ni);
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
// aparecen en cimática real cuando la excitación cae en un HUECO entre dos
// resonancias m≥2 consecutivas.
//
// CORRECCIÓN (auditoría 2026-11-09): este comentario decía antes que el
// fallback aparece "a frecuencias de excitación muy bajas". Es falso y al
// revés. Medido sobre la llamada real de cymatics.js (targetOmega = π·f,
// PHYS_A, m∈[2,6]×n∈[1,24]) barriendo 60-1000 Hz cada 0,1 Hz (9401
// muestras): la compuerta |δ_primario| > 2·Γ(f) se abre en 39,05% de las
// muestras y el fallback efectivamente GANA (devuelve m≤1) en 21,85% —
// casi un cuarto del rango que usa la app, repartido entre m=0 (1030
// muestras) y m=1 (1024). Y no ocurre abajo: la primera frecuencia donde
// gana es 225,4 Hz, y de ahí hasta 1000 Hz forma 23 bandas contiguas
// (225,4-227,9 / 249,4-252,3 / 278,6-282,9 / ... / 997-1000) cada vez más
// anchas. Por debajo de ~225 Hz NUNCA gana. La razón es geométrica: la
// separación entre autovalores ω(m,n) consecutivos CRECE con la frecuencia
// mientras Γ(f) se ANGOSTA (ver gammaAt arriba), así que los huecos sin
// cobertura m≥2 se abren hacia ARRIBA del rango, no hacia abajo. O sea: no
// es una rama rara de régimen extremo, es una rama caliente y normal del
// selector en el rango medio-alto de portadoras.
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
// (x ≥ 8); J_m para m ≥ 2 vive en besselJArray() (recurrencia descendente
// de Miller), que ya no splicea estas dos funciones.
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

// Orden de arranque de la recurrencia DESCENDENTE (algoritmo de Miller,
// Numerical Recipes §6.5, constante ACC=40 estandar): hace falta margen por
// encima TANTO del orden pedido (maxM) COMO del propio argumento x - si
// x > maxM, J_maxM(x) todavia esta en zona oscilante en maxM y necesita
// margen sobre x, no solo sobre maxM - para que la recurrencia 'olvide' la
// semilla arbitraria antes de llegar a los ordenes que si importan.
// Validado numericamente contra una referencia de margen mucho mayor y
// contra la serie de potencias independiente (A&S 9.1.10) en toda la
// grilla real de uso (maxM 0..24, x 0..120): error absoluto max. ~3e-9.
function millerStartOrder(maxM, x) {
  const base = Math.max(maxM, Math.ceil(x));
  let M = base + Math.ceil(Math.sqrt(40 * base));
  if (M % 2 !== 0) M++; // arranque par: convencion estandar, no imprescindible
  return M;
}

// Miller's algorithm scratch buffer - reused across calls para no asignar
// por pixel (ver nota de `out` mas abajo: este es el hot loop de
// fillRadTableRows() en cymatics.js). Crece (nunca se achica) la primera
// vez que hace falta un M mayor al visto hasta ahora.
let _millerScratch = new Float64Array(64);
function _millerBuf(size) {
  if (_millerScratch.length < size) {
    _millerScratch = new Float64Array(Math.max(size, _millerScratch.length * 2));
  }
  return _millerScratch;
}

// Llena `out[0..maxM]` con J_0(x)..J_{maxM}(x). `out` lo provee el
// llamador (no se asigna aca) porque esto corre en el hot loop de
// fillRadTableRows() de cymatics.js (miles de llamadas por reconstruccion
// de tabla) - asignar un array nuevo por pixel presionaria al GC justo ahi.
//
// FIX: la recurrencia ASCENDENTE que usaba esto antes (J_m = (2(m-1)/x)*J_{m-1} - J_{m-2},
// sembrada en besselJ0/besselJ1) es inestable para m alto relativo a x
// bajo - exactamente el caso del centro del plato (dist->0) con modos de
// detalle mandala activos (mD1..mD3 llegan a m=16). No era un error de
// unos pocos % : medido, besselJArray(24, 0.1, out) daba out[24]~=-1.1e+35
// (el valor real es ~=9.6e-56) - basura de magnitud astronomica, no una
// imprecision. Reemplazado por recurrencia DESCENDENTE (algoritmo de
// Miller): arranca en un orden M bastante por encima de maxM Y de x
// (millerStartOrder arriba) con una semilla arbitraria, recurre hacia
// abajo (estable en esa direccion independientemente de la relacion m/x)
// y normaliza con la regla de suma J_0(x) + 2*sum_{k>=1} J_{2k}(x) = 1. Un
// solo algoritmo para TODO el array (incluido m=0,1) - ya no hay empalme
// entre una semilla por serie/asintotica y una recurrencia por separado.
// besselJ0()/besselJ1() siguen EXISTIENDO sin cambios (otros llamadores y
// el validador los usan directo); aca simplemente ya no se splicean en
// out[0]/out[1] - Miller los reproduce con acuerdo de ~1e-9 a 1e-12, muy
// por debajo de cualquier tolerancia visual o de test existente.
export function besselJArray(maxM, x, out) {
  x = Math.abs(x);
  if (x < 1e-3) {
    out[0] = 1;
    for (let m = 1; m <= maxM; m++) out[m] = 0;
    return out;
  }
  const M = millerStartOrder(maxM, x);
  const tmp = _millerBuf(M + 1);
  tmp[M] = 0;
  tmp[M - 1] = 1e-30; // semilla arbitraria - se cancela en la normalizacion
  for (let m = M - 1; m >= 1; m--) {
    tmp[m - 1] = ((2 * m) / x) * tmp[m] - tmp[m + 1];
  }
  let sum = tmp[0];
  for (let k = 2; k <= M; k += 2) sum += 2 * tmp[k];
  const norm = 1 / sum;
  for (let m = 0; m <= maxM; m++) out[m] = tmp[m] * norm;
  return out;
}
