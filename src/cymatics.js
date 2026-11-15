// ============================================================================
// Simulación de cimática — Vyneural
// ============================================================================
// Alternativa al visualizador de las tres gotas: una placa circular oscura
// con tres gotas de fluido alineadas (vista cenital) cuya superficie vibra
// con patrones de Faraday empíricamente correctos.
//
// Física:
//   1. Respuesta subarmónica. Una superficie de fluido excitada a f responde
//      a la MITAD de la frecuencia (faraday, 1831): ω_s = π·f.
//   2. Dispersión de ondas de gravedad-capilaridad (agua):
//        ω_s² = g·k + (σ/ρ)·k³
//      De aquí sale el número de onda k: a más frecuencia, longitud de onda
//      menor y por lo tanto más anillos en el patrón. A frecuencias bajas
//      domina la gravedad (k pequeño → la gota entera sube y baja, sin
//      anillos); a frecuencias altas domina la capilaridad (k ∝ f^(2/3)).
//   3. Modos propios de una cuenca circular con pared vertical: la superficie
//      es libre en la pared (J'_m(k a) = 0), así que los patrones son
//      superposiciones de J_m(k r)·cos(m θ). Como en un cuenco cantor real,
//      cada gota se afina al modo angular (m, n) más cercano a la
//      resonancia: el patrón muestra la flor característica de la cimática
//      (m pétalos sobre n−1 anillos concéntricos) y los pétalos cambian con
//      la frecuencia — 2, 3, 4, 5… según el tono, igual que en los cantos.
//
// Visualización: la oscilación subarmónica (f/2) ocurre a cientos de Hz,
// muy por encima de los 60 FPS, así que se renderiza el ENVOLVENTE espacial
// del patrón estacionario (lo que muestra un lapso de tiempo real de
// cimática), con el deslizamiento lento de las fases que produce el batido
// entre modos casi degenerados. El envolvente se pinta como una foto de
// larga exposición: alto contraste, líneas nodales finas y nítidas (la sal
// de Chladni asentada sobre los nodos) y temblor mínimo — definido y
// natural, no un degradado difuso. El latido real del AudioContext marca el
// pulso de amplitud y el brillo del aro LED cenital.
//
// Rendimiento: el plato se rasteriza en un lienzo oculto de resolución
// adaptativa (más resolución si el patrón tiene más anillos) y se escala
// con suavizado, manteniendo 60 FPS en móvil y escritorio.

const TWO_PI = Math.PI * 2;
const MAX_LAMP_PULSES_HZ = 2;
const DROP_RESOLUTIONS = [48, 64, 80, 100, 128, 160, 200, 256, 320];

function dropResolution(target, current, locked) {
  if (current && locked) return current;
  let index = DROP_RESOLUTIONS.indexOf(current);
  if (index < 0) return DROP_RESOLUTIONS.find((res) => res >= target) ?? 320;

  // Para cruzar un escalón, el objetivo debe superar su punto medio
  // en un 10%. Los dos umbrales evitan alternar en el mismo borde.
  while (index < DROP_RESOLUTIONS.length - 1 &&
    target > (DROP_RESOLUTIONS[index] + DROP_RESOLUTIONS[index + 1]) * .55) index++;
  while (index > 0 &&
    target < (DROP_RESOLUTIONS[index - 1] + DROP_RESOLUTIONS[index]) * .45) index--;
  return DROP_RESOLUTIONS[index];
}

// FIX (auditoría 2026-09-08, Parte A — "una sola cimática, dos cámaras"):
// toda la física modal que vivía acá (tablas de ceros de Bessel, búsqueda
// de modo, ancho de resonancia, radio del plato, funciones de Bessel) se
// extrajo a core/plate-field.js — fuente ÚNICA para esta vista 2D, la
// futura vista 3D (Parte D) y el validador cruzado FDTD↔modal (Parte E).
// Ningún renderer vuelve a definir su propia versión de esto. Ver ese
// archivo para el detalle de cada pieza (son movidas tal cual, mismo
// comportamiento — no se recalibró nada acá).
import {
  zeroFor,
  modeOmega,
  selectNearestMode,
  selectModeWithFallback,
  resonantModeForBeat,
  gammaAt,
  lorentz,
  PHYS_A,
  REF_F,
  GAMMA_MIN,
  GAMMA_MAX,
  ringsFor,
  besselJArray,
  MORPH_BLEND_K,
} from './core/plate-field.js';
import { G, SIGMA_RHO, faradayWavenumber, viscousDecayRate } from './core/wave-physics.js';

function morphRate(m, n, scientific) {
  if (!scientific) return gammaAt(modeOmega(m, n, PHYS_A) / Math.PI);
  // Acota el ritmo del fundido a los límites de la interfaz.
  const rate = viscousDecayRate(zeroFor(m, n) / PHYS_A);
  return Math.max(GAMMA_MIN, Math.min(GAMMA_MAX, rate));
}

function isMorphActive(morph, scientific) {
  return !!morph && (scientific || morph.oldW > 0.02);
}

// Amplitud relativa a la resonancia en la aproximación lineal local.
// La excitación paramétrica real también depende del umbral de inestabilidad.
function modalResponse(omega, driveOmega, wavenumber) {
  const width = viscousDecayRate(wavenumber);
  return width / Math.hypot(width, omega - driveOmega);
}

// FIX (auditoría 2026-09-08, Parte B — "una sola cimática, dos cámaras"):
// cota de seguridad para una transición de modo que por algún motivo no
// decayera (p. ej. un τ corrupto) — NUNCA debería dispararse en operación
// normal. gammaAt(f) está acotado en [GAMMA_MIN, GAMMA_MAX] para todo f, así
// que τ_fundido = MORPH_BLEND_K/gammaAt(f) está acotado en
// [MORPH_BLEND_K/GAMMA_MAX, MORPH_BLEND_K/GAMMA_MIN] siempre — el peor caso
// natural llega a oldW≈0,02 (el umbral real de abajo) en
// ~4·MORPH_BLEND_K/GAMMA_MIN. Este tope es 8× ese peor caso natural, puro
// respaldo ante un bug, no un knob de ritmo (para eso está
// MORPH_BLEND_K/GAMMA_MIN/GAMMA_MAX, ver plate-field.js).
// FIX (2026-09-08, "colisionador de frecuencias" — transiciones erráticas):
// esto usaba SLOWMO_K (330), no MORPH_BLEND_K (10) — un fundido cruzado NO
// envuelve una oscilación visible (es el mismo caso que el suavizado de
// volumen más abajo, que YA evita SLOWMO_K por esta razón), así que no debía
// llevar el factor de cámara lenta. Con SLOWMO_K el peor caso real llegaba a
// ~220s (963 Hz medido: ~177s) con el modo BLOQUEADO todo ese tiempo (ver
// lockSrc): cualquier cambio de frecuencia real durante esa ventana quedaba
// sin efecto visible hasta que por fin soltaba — el patrón se veía congelado
// y después saltaba de golpe. Ver la nota completa junto a MORPH_BLEND_K en
// plate-field.js.
// FIX (2026-09-08, "va bien y luego salta" — reportado para saltos GRANDES
// de frecuencia): el fundido ahora se alarga hasta `MORPH_DIST_SCALE_MAX`×
// cuando el cambio de modo (m, n) es grande (ver la nota junto a
// `distScale` más abajo, donde arranca cada fundido) — el techo de
// seguridad tiene que crecer con el mismo factor o dispararía ANTES de que
// termine de asentar un fundido grande legítimo.
const MORPH_DIST_SCALE_MAX = 3;
const MAX_MORPH_AGE_S = (8 * MORPH_DIST_SCALE_MAX * MORPH_BLEND_K) / GAMMA_MIN;
// FEATURE (2026-09-08, "hagamos que se interpole"): a partir de qué
// distancia de modo (|Δm|+|Δn|) se arma un camino de resonancias
// intermedias reales (`_computeModeWaypoints`) en vez de ir directo al
// objetivo. Por debajo de esto el usuario ya confirmó en vivo que "va
// bien" con un solo fundido (más largo gracias a distScale); por encima,
// un solo fundido — por más largo que sea — salta entre dos formas
// demasiado distintas para leerse como una reorganización continua.
const WAYPOINT_MODE_DIST_MIN = 5;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Construye la tabla radial estática de una gota: 13 valores por píxel —
// r, θ, las Bessel del patrón (J0, J_mDom, J_mS1, J_mS2 y los tres modos
// de detalle mandala J_mD1..J_mD3) y las dos texturas espaciales fijas de
// la gota (grano capilar y moteado de la sal). Es independiente del tiempo
// (solo rotan las fases angulares y el grano tiembla con una envolvente
// global), así que se calcula una sola vez por (resolución, modo) y por
// fotograma el bucle solo evalúa los cosenos — con esto se puede subir la
// resolución del buffer (nitidez) sin perder 60 FPS y se evita recalcular
// senos por píxel. Se usa tanto para la flor actual como para la anterior
// durante la transición entre frecuencias.
// Rellena las filas y0..y1 (sin incluir y1) de una tabla radial de 13
// columnas. Se usa tanto para construir la tabla completa de un modo como
// para construirla por tramos (pendiente) sin congelar el fotograma al
// cambiar de frecuencia.
function fillRadTableRows(
  rad,
  res,
  y0,
  y1,
  argScale,
  mDom,
  mS1,
  mS2,
  mD1,
  mD2,
  mD3,
  tex
) {
  const half = res / 2;
  const maxM = Math.max(
    mDom,
    mS1,
    mS2,
    mD1 >= 1 ? mD1 : 1,
    mD2 >= 1 ? mD2 : 1,
    mD3 >= 1 ? mD3 : 1,
    1
  );
  const js = new Array(maxM + 1);
  // Moteado del polvo en unidades relativas al búfer (orgánico a cualquier
  // resolución, sin aliasing).
  const pkScale = res / 100;
  for (let py = y0; py < y1; py++) {
    const dy = py - half + 0.5;
    for (let px = 0; px < res; px++) {
      const dx = px - half + 0.5;
      const idx = py * res + px;
      const o = idx * 13;
      const dist = Math.hypot(dx, dy);
      rad[o] = dist;
      rad[o + 1] = Math.atan2(dy, dx);
      const arg = argScale * dist;
      // FIX (auditoría 2026-09-08, Parte A): misma recurrencia de Bessel,
      // ahora en core/plate-field.js:besselJArray() (comparte implementación
      // con la vista 3D y el validador FDTD↔modal). `js` se sigue pasando
      // por referencia y reusando entre llamadas — este es el hot loop de
      // la reconstrucción de tabla radial, sin asignar arrays por píxel.
      besselJArray(maxM, arg, js);
      rad[o + 2] = js[0];
      rad[o + 3] = js[mDom];
      rad[o + 4] = js[mS1];
      rad[o + 5] = js[mS2];
      rad[o + 6] = mD1 >= 1 ? js[mD1] : 0;
      rad[o + 7] = mD2 >= 1 ? js[mD2] : 0;
      rad[o + 8] = mD3 >= 1 ? js[mD3] : 0;
      // o+9/o+10: columnas sin uso (reservadas en el stride de 13; ver
      // nota de buildRadTable más abajo). Quedan en 0 por el
      // Float32Array ya inicializado a cero — no se escriben.
      // Grano capilar espacial (el vaivén temporal se aplica después con una
      // envolvente global por fotograma: barato y sin recalcular senos).
      rad[o + 11] =
        (Math.sin(tex.gk1 * dx) * Math.sin(tex.gk2 * dy) +
          Math.sin(tex.gk3 * (dx + dy)) * Math.sin(tex.gk4 * (dx - dy))) /
        2;
      // Moteado determinista del polvo sobre las líneas nodales (estático:
      // rompe el trazo en granos sin coste por fotograma).
      rad[o + 12] =
        Math.sin(tex.pk1 * pkScale * dx + tex.pk2 * pkScale * dy) *
        Math.sin(tex.pk3 * pkScale * dy - tex.pk4 * pkScale * dx);
    }
  }
}

// Dos frentes que parten de lados distintos. Las distancias están
// normalizadas al radio; sus fases espaciales se comparten con el shader.
const WAVE_A = [-0.88, -0.49, 11.3];
const WAVE_B = [0.77, 0.64, 13.7];
const WAVE_BLEND_A = 0.65;
const WAVE_BLEND_B = 0.35;
const WAVE_DAMPING = 0.90;
const CPU_DROP_RESOLUTION_LIMIT = 128;
const WAVE_STRIDE = 4;
const LOBE_VIBRATION_GAIN = 2.1;
const IDLE_RIPPLE = 0.115;
const RIPPLE_HEIGHT = 0.28;
const STATIC_LAMP_PULSE = 0.50;
const DEFAULT_LAMP_REFLECTION = [245, 248, 255];
// La escala de tiempo visual preserva el orden de disipación viscosa.
const FINE_RIPPLE_DAMPING = (WAVE_B[2] / WAVE_A[2]) ** 2;

function lampInk(rgb, opacity, white = 0) {
  return 'rgba(' + rgb.map(channel => Math.round(channel + (255 - channel) * white)).join(',') + ',' + opacity + ')';
}
const IDLE_LAMP_HZ = 0.65;
const WATER_SLOPE_SCALE = 0.24;
// Espesor óptico ilustrativo en radios de gota. La diferencia entre el
// índice del aire y el del agua limita la desviación en la aproximación paraxial.
const REFRACTION_SCALE = 0.075 * (1 - 1 / 1.333) * WATER_SLOPE_SCALE;
const LAMP_HEIGHT = 1.55;
const LAMP_STRIP_WIDTH = 0.22;
const LAMP_STRIP_SHIFT = 0.94;
const LAMP_REFLECTANCE = 0.78;
const CAUSTIC_GAIN = 0.43;
const LAMP_HALF_LENGTH = 2.15;
const WATER_FRESNEL = 0.0204;
const RIPPLE_CURVATURE_A = WAVE_BLEND_A * WAVE_A[2] ** 2;
const RIPPLE_CURVATURE_B = WAVE_BLEND_B * WAVE_B[2] ** 2;

// Mismo reflejo cenital que en el shader. Las diferencias centradas usan
// el relieve compuesto que ya calculó el rasterizador, sin evaluar los
// modos de Bessel otra vez ni asignar memoria por fotograma.
function reflectLampInWater(pixels, heights, res, bound, rim, lampX, light, reflectedColor) {
  const half = res / 2;
  const slopeScale = 0.5 * half * WATER_SLOPE_SCALE;
  const edge2 = (bound - 1) ** 2;
  for (let y = 1; y < res - 1; y++) {
    const dy = y + 0.5 - half;
    for (let x = 1; x < res - 1; x++) {
      const dx = x + 0.5 - half;
      const distance2 = dx * dx + dy * dy;
      if (distance2 >= edge2) continue;
      const i = y * res + x;
      const gx = (heights[i + 1] - heights[i - 1]) * slopeScale;
      const gy = (heights[i + res] - heights[i - res]) * slopeScale;
      const slope2 = gx * gx + gy * gy;
      if (slope2 >= 1) continue;
      const projection = 2 * LAMP_HEIGHT / Math.max(0.24, 1 - slope2);
      const hitX = dx / half - projection * gx;
      const hitY = dy / half - projection * gy;
      const strip = (hitY + LAMP_STRIP_SHIFT - 0.09 * hitX * hitX) / LAMP_STRIP_WIDTH;
      const length = clamp01((Math.abs(hitX - lampX) - 0.55) / (LAMP_HALF_LENGTH - 0.55));
      const steep = clamp01((slope2 - 0.56) / 0.44);
      const grazing = 1 - 1 / Math.sqrt(1 + slope2);
      const fresnel = WATER_FRESNEL + (1 - WATER_FRESNEL) * grazing ** 5;
      const reflection = LAMP_REFLECTANCE * light * (fresnel / WATER_FRESNEL) / (1 + strip * strip)
        * (1 - length * length * (3 - 2 * length))
        * (1 - steep * steep * (3 - 2 * steep));
      const o = i * 4;
      const soft = Math.min(1, (bound - Math.sqrt(distance2)) / rim);
      const alpha = Math.min(1, pixels[o + 3] / (255 * soft));
      const litAlpha = alpha + (1 - alpha) * reflection;
      const lightMix = reflection / Math.max(litAlpha, 0.0001);
      pixels[o] += (reflectedColor[0] - pixels[o]) * lightMix;
      pixels[o + 1] += (reflectedColor[1] - pixels[o + 1]) * lightMix;
      pixels[o + 2] += (reflectedColor[2] - pixels[o + 2]) * lightMix;
      pixels[o + 3] = litAlpha * soft * 255;
    }
  }
}

function rippleOmega(spatialFrequency) {
  const k = spatialFrequency / PHYS_A;
  return Math.sqrt(G * k + SIGMA_RHO * k ** 3);
}
const RIPPLE_RATE_RATIO = rippleOmega(WAVE_B[2]) / rippleOmega(WAVE_A[2]);
function fillWaveRows(waves, res, y0, y1) {
  const half = res / 2;
  for (let py = y0; py < y1; py++) {
    const y = (py + 0.5) / half - 1;
    for (let px = 0; px < res; px++) {
      const x = (px + 0.5) / half - 1;
      const radiusA = Math.hypot(x - WAVE_A[0], y - WAVE_A[1]);
      const radiusB = Math.hypot(x - WAVE_B[0], y - WAVE_B[1]);
      const a = WAVE_A[2] * radiusA;
      const b = WAVE_B[2] * radiusB;
      const i = (py * res + px) * WAVE_STRIDE;
      const gainA = 1 / (1 + WAVE_DAMPING * radiusA);
      const gainB = 1 / (1 + WAVE_DAMPING * radiusB);
      waves[i] = Math.cos(a) * gainA;
      waves[i + 1] = Math.sin(a) * gainA;
      waves[i + 2] = Math.cos(b) * gainB;
      waves[i + 3] = Math.sin(b) * gainB;
    }
  }
}

// Construye la tabla radial completa de una gota (13 columnas por píxel:
// r, θ, las Bessel del patrón y las dos texturas espaciales fijas; las
// columnas 9/10 del stride quedan reservadas sin usar — ver nota de
// fillRadTableRows).
function buildRadTable(res, argScale, mDom, mS1, mS2, mD1, mD2, mD3, tex) {
  const rad = new Float32Array(res * res * 13);
  fillRadTableRows(rad, res, 0, res, argScale, mDom, mS1, mS2, mD1, mD2, mD3, tex);
  return rad;
}

// ============================================================================
// Ruta GPU (WebGL2): el mismo patrón de Chladni se rasteriza en shaders.
// Los valores espaciales estáticos (r, θ, Bessel, grano y polvo) se suben a
// texturas de coma flotante solo cuando cambia el modo; por fotograma solo
// se actualizan las fases, amplitudes y ondas (uniformes). La GPU evalúa el
// mismo sumatorio píxel a píxel, así que 60 FPS son estables a cualquier
// resolución — incluso con el fundido cruzado entre flores, que también
// vive en el shader (dos texturas por gota). Si no hay WebGL2 (o falla el
// shader), el rasterizador CPU de abajo continúa funcionando igual.
// ============================================================================

const GL_VS = `#version 300 es
precision highp float;
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const GL_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

// Texturas: A (compartida entre flores) = r, θ, J0, grano capilar.
//            B = J_mDom, J_mS1, J_mS2, J_mD1
//            C = J_mD2, J_mD3, polvo, (libre)
//            Bo/Co = las de la flor ANTERIOR durante un fundido cruzado.
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform sampler2D uTexC;
uniform sampler2D uTexBo;
uniform sampler2D uTexCo;
uniform sampler2D uTexAo; // textura A de la flor ANTERIOR (J0 vieja en un fundido cruzado)

uniform vec2 uOffset;  // origen de esta gota en el lienzo GL (px)
uniform float uRes;
uniform float uHalf;
uniform float uRim;
uniform float uWob;

// Flor actual: pesos j = amplitud·shimmer y fases φ = rotación + fase.
uniform float uJ[8];
uniform float uPh[7];
uniform float uM[6];
// Flor anterior (fundido cruzado).
uniform float uJo[8];
uniform float uPho[7];
uniform float uMo[6];
uniform float uNewW;
uniform float uOldW;

uniform float uMEnv;
uniform float uPresence;
uniform float uAmpPat;
uniform float uAmp;
uniform float uSwell;

uniform vec2 uWavePhase;
uniform vec3 uSurfaceOptics;
uniform vec3 uLampTint;
uniform vec2 uRippleGain;
uniform vec2 uLampOptics; // centro horizontal del reflejo, número de onda modal
uniform float uWaveLight;
uniform float uWaterVibration;
uniform bool uClearWater;

// Sal de Chladni y color.
uniform float uGEnv;
uniform float uPSh;
uniform float uTexPow;
uniform float uTexSalt;
uniform float uSandSig;
uniform float uGain;
uniform float uMid;
uniform vec3 uPal;
uniform vec3 uDeep;
uniform vec3 uWhite;
out vec4 outColor;

float clamp01(float v) { return clamp(v, 0.0, 1.0); }

void main() {
  // Coordenada local de esta gota (gl_FragCoord está en el lienzo GL, que
  // contiene las tres gotas); la coordenada v se invierte para que la fila 0
  // de la textura (arriba en la tabla CPU) quede arriba en el lienzo final.
  vec2 local = gl_FragCoord.xy - uOffset;
  vec2 uv = vec2(local.x / uRes, 1.0 - local.y / uRes);
  vec2 pos = uv * 2.0 - 1.0;
  vec4 A = texture(uTexA, uv);
  float dist = A.x;
  float th = A.y;
  float J0v = A.z;
  float grain = A.w;
  float bound = uHalf * uWob;

  vec4 B = texture(uTexB, uv);
  vec4 C = texture(uTexC, uv);
  float sum = 0.0;
  float secondary = 0.0;
  if (uAmp > 0.0 && uNewW > 0.02) {
    secondary = uJ[2] * B.x * cos(uM[0] * th + uPh[1]);
    sum = uJ[0] * J0v
      + uJ[1] * B.x * cos(uM[0] * th + uPh[0])
      + secondary
      + uJ[3] * B.y * cos(uM[1] * th + uPh[2])
      + uJ[4] * B.z * cos(uM[2] * th + uPh[3])
      + uJ[5] * B.w * cos(uM[3] * th + uPh[4])
      + uJ[6] * C.x * cos(uM[4] * th + uPh[5])
      + uJ[7] * C.y * cos(uM[5] * th + uPh[6]);
    sum *= uNewW;
    secondary *= uNewW;
  }
  if (uAmp > 0.0 && uOldW > 0.02) {
    vec4 Bo = texture(uTexBo, uv);
    vec4 Co = texture(uTexCo, uv);
    vec4 Ao = texture(uTexAo, uv);
    sum += uOldW * (
        uJo[0] * Ao.z
      + uJo[1] * Bo.x * cos(uMo[0] * th + uPho[0])
      + uJo[2] * Bo.x * cos(uMo[0] * th + uPho[1])
      + uJo[3] * Bo.y * cos(uMo[1] * th + uPho[2])
      + uJo[4] * Bo.z * cos(uMo[2] * th + uPho[3])
      + uJo[5] * Bo.w * cos(uMo[3] * th + uPho[4])
      + uJo[6] * Co.x * cos(uMo[4] * th + uPho[5])
      + uJo[7] * Co.y * cos(uMo[5] * th + uPho[6]));
  }

  float eBase = sum * uAmp * uSwell * uMEnv;
  vec2 fronts = vec2(0.0);
  if (uWaveLight > 0.0) {
    vec2 fromA = pos - vec2(${WAVE_A[0]}, ${WAVE_A[1]});
    vec2 fromB = pos - vec2(${WAVE_B[0]}, ${WAVE_B[1]});
    vec2 radius = vec2(length(fromA), length(fromB));
    vec2 phase = radius * vec2(${WAVE_A[2]}, ${WAVE_B[2]}) - uWavePhase;
    fronts = uRippleGain * cos(phase) / (1.0 + ${WAVE_DAMPING} * radius);
  }
  // El relieve óptico alterna crestas y valles alrededor de los mismos
  // nodos. Una onda viajera tenue mantiene movimiento al cruzar por cero.
  float ripple = ${WAVE_BLEND_A} * fronts.x + ${WAVE_BLEND_B} * fronts.y;
  float lobeScale = 1.0 + ${LOBE_VIBRATION_GAIN} * uWaterVibration * ripple;
  float opticalMix = uSurfaceOptics.x;
  float modeHeight = eBase * mix(1.0, uSurfaceOptics.y * lobeScale, opticalMix);
  modeHeight += opticalMix * secondary * uAmp * uSwell * uMEnv * (uSurfaceOptics.z - uSurfaceOptics.y * lobeScale);
  float relief = modeHeight + ${RIPPLE_HEIGHT} * uWaterVibration * ripple;
  // La normal proviene del campo ya mezclado, incluido el modo saliente.
  // Las derivadas deben evaluarse antes del descarte no uniforme del borde.
  vec2 slope = vec2(0.0);
  if (uWaveLight > 0.0) {
    slope = vec2(dFdx(relief), -dFdy(relief)) * uHalf * ${WATER_SLOPE_SCALE};
  }
  if (dist >= bound) {
    outColor = vec4(0.0);
    return;
  }
  float soft = clamp01((bound - dist) / uRim);
  float textureHeight = grain * uGEnv * (0.1 + abs(eBase)) * 0.045 * uAmp;
  float e = relief + textureHeight;

  float sand = 0.0;
  if (uAmpPat > 0.0 && abs(eBase) < 0.11) {
    float sandPowder = 1.0 - uTexPow + uTexPow * C.z * uPSh;
    float env = abs(uJ[0] * J0v) + abs(uJ[1] * B.x) + abs(uJ[2] * B.x)
      + abs(uJ[3] * B.y) + abs(uJ[4] * B.z) + abs(uJ[5] * B.w)
      + abs(uJ[6] * C.x) + abs(uJ[7] * C.y);
    float envGate = clamp01((env - 0.05) / 0.25);
    sand = exp(-(eBase * eBase) / (2.0 * uSandSig * uSandSig))
      * sandPowder * envGate * (0.75 + 0.25 * uAmpPat) * uAmpPat * uPresence
      * (uWaveLight > 0.0 ? 0.24 : 1.0);
  }

  float eP = (e < 0.0 ? -1.0 : 1.0) * sqrt(abs(e));
  float tIn = (eP * uGain + uMid - 0.5) * 5.0;
  float t2 = tIn * tIn;
  float tt = tIn < -3.0 ? -1.0 : tIn > 3.0 ? 1.0 : (tIn * (27.0 + t2)) / (27.0 + 9.0 * t2);
  float v = 0.5 + 0.5 * tt;

  vec3 col;
  if (v < 0.5) {
    float u2 = v * 2.0;
    col = uPal * u2 + uDeep * (1.0 - u2);
  } else {
    float u2 = (v - 0.5) * 2.0;
    col = uWhite * u2 + uPal * (1.0 - u2);
  }
  if (sand > 0.02) {
    float sa = sand * uTexSalt * soft;
    vec3 sandCol = mix(vec3(240.0, 245.0, 252.0), uPal, 0.22);
    col = mix(col, sandCol, sa);
  }

  float bodyAlpha = 0.26 + 0.1 * uAmpPat + 0.54 * v + 0.55 * sand * uAmpPat;
  if (uClearWater) {
    // Las crestas reflejan la luz; los valles dejan ver el plato.
    float crest = smoothstep(0.0, 0.23, relief);
    float clearWater = uWaveLight > 0.0 ? 1.0 : 0.0;
    col = mix(col, mix(uPal, uWhite, 0.8), mix(0.64, 0.30, clearWater) * crest);
    bodyAlpha = 0.125 + 0.055 * uAmpPat + mix(0.42, 0.20, clearWater) * v
      + mix(0.27, 0.10, clearWater) * crest + 0.46 * sand * uAmpPat;
  }
  float alpha = min(bodyAlpha, 1.0);
  if (uWaveLight > 0.0) {
    // Cámara cenital: el rayo reflejado por N=(-∇h,1) busca el tubo
    // curvo a una altura fija. Fresnel da más luz a pendientes oblicuas.
    float slope2 = dot(slope, slope);
    vec2 hit = pos - 2.0 * ${LAMP_HEIGHT} * slope / max(0.24, 1.0 - slope2);
    float strip = (hit.y + ${LAMP_STRIP_SHIFT} - 0.09 * hit.x * hit.x) / ${LAMP_STRIP_WIDTH};
    float lengthFade = 1.0 - smoothstep(0.55, ${LAMP_HALF_LENGTH}, abs(hit.x - uLampOptics.x));
    float grazing = 1.0 - inversesqrt(1.0 + slope2);
    float fresnel = ${WATER_FRESNEL} + (1.0 - ${WATER_FRESNEL}) * pow(grazing, 5.0);
    float reflection = ${LAMP_REFLECTANCE} * uWaveLight * (fresnel / ${WATER_FRESNEL})
      * lengthFade * (1.0 - smoothstep(0.56, 1.0, slope2)) / (1.0 + strip * strip);

    // La curvatura de los modos Bessel y los frentes aproxima la
    // convergencia de rayos refractados sobre el fondo poco profundo.
    float rippleCurvature = -dot(fronts, vec2(${RIPPLE_CURVATURE_A}, ${RIPPLE_CURVATURE_B}));
    float curvature = -uLampOptics.y * uLampOptics.y * modeHeight
      + ${RIPPLE_HEIGHT} * uWaterVibration * rippleCurvature;
    float compression = -${REFRACTION_SCALE} * curvature;
    float focus = max(0.0, compression) * abs(compression) / (0.30 + compression * compression);
    col *= 1.0 + 0.28 * uWaveLight * min(0.0, compression) / (1.0 + abs(compression));
    float transmission = ${CAUSTIC_GAIN} * uWaveLight * focus;
    alpha += (1.0 - alpha) * transmission;
    col = mix(col, mix(uPal, uLampTint, 0.66), transmission / max(alpha, 0.0001));
    alpha += (1.0 - alpha) * reflection;
    col = mix(col, uLampTint, reflection / max(alpha, 0.0001));
  }
  outColor = vec4(col / 255.0, alpha * soft);
}`;

// Versión GLSL ES 1.00 (WebGL1) derivada de la 300 es para compartir toda la
// lógica: solo cambian el encabezado, texture()→texture2D() y gl_FragColor
// en vez de out. Si la 1.00 no compila en un dispositivo, buildGLProgram
// devuelve null y el rasterizador CPU sigue funcionando igual.
function glsl100(src) {
  return src
    .replace('#version 300 es\n', '')
    .replace('precision highp sampler2D;\n', '')
    .replace('in vec2 aPos;', 'attribute vec2 aPos;')
    .replace('out vec4 outColor;\n', '')
    .replace(/texture\(/g, 'texture2D(')
    .replace(/outColor =/g, 'gl_FragColor =');
}
const GL_VS_GL1 = glsl100(GL_VS);
const GL_FS_GL1 = '#extension GL_OES_standard_derivatives : enable\n' + glsl100(GL_FS);

function compileGLShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[cimática] shader WebGL:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function buildGLProgram(gl, isGL2) {
  const vs = compileGLShader(gl, gl.VERTEX_SHADER, isGL2 ? GL_VS : GL_VS_GL1);
  const fs = compileGLShader(gl, gl.FRAGMENT_SHADER, isGL2 ? GL_FS : GL_FS_GL1);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[cimática] programa WebGL:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function initGL() {
  try {
    const canvas = document.createElement('canvas');
    const attrs = {
      preserveDrawingBuffer: false,
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      depth: false,
      stencil: false,
    };
    // WebGL2 primero; si no está disponible (navegadores o GPUs viejos), se
    // intenta WebGL1 con el mismo shader en GLSL ES 1.00. Si tampoco hay,
    // null → el rasterizador CPU sigue funcionando igual.
    let gl = canvas.getContext('webgl2', attrs);
    const isGL2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) return null;
    // En WebGL1 las tablas radiales y las normales requieren extensiones.
    if (!isGL2 && (!gl.getExtension('OES_texture_float') || !gl.getExtension('OES_standard_derivatives'))) return null;
    const prog = buildGLProgram(gl, isGL2);
    if (!prog) return null;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    // Sin VAO: el atributo se configura en el VAO por defecto, que persiste
    // entre fotogramas y funciona igual en WebGL1 y WebGL2.
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    // Textura negra de respaldo para los slots de la flor anterior vacíos.
    const blackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
    const names = [
      'uTexA', 'uTexB', 'uTexC', 'uTexBo', 'uTexCo', 'uTexAo', 'uOffset', 'uRes', 'uHalf', 'uRim', 'uWob',
      'uNewW', 'uOldW',
      'uMEnv', 'uPresence', 'uAmpPat', 'uAmp', 'uSwell',
      'uWavePhase', 'uSurfaceOptics', 'uLampOptics', 'uRippleGain', 'uLampTint', 'uWaveLight', 'uWaterVibration', 'uClearWater',
      'uGEnv', 'uPSh', 'uTexPow', 'uTexSalt', 'uSandSig', 'uGain', 'uMid', 'uPal', 'uDeep', 'uWhite',
    ];
    const u = {};
    for (const nm of names) u[nm] = gl.getUniformLocation(prog, nm);
    // Los arrays se consultan ELEMENTO A ELEMENTO: algunos drivers separan
    // los arrays de uniformes en escalares individuales y la consulta sin
    // índice ('uJ') devuelve null, dejando el array en cero (y el patrón
    // desaparece). Con 'uJ[0]'..'uJ[7]' siempre funcionan.
    const arrayEls = (base, n) => {
      const arr = [];
      for (let k = 0; k < n; k++) arr.push(gl.getUniformLocation(prog, `${base}[${k}]`));
      return arr;
    };
    u.uJ = arrayEls('uJ', 8);
    u.uPh = arrayEls('uPh', 7);
    u.uM = arrayEls('uM', 6);
    u.uJo = arrayEls('uJo', 8);
    u.uPho = arrayEls('uPho', 7);
    u.uMo = arrayEls('uMo', 6);
    // Los samplers se ENLAZAN a sus unidades de textura con uniform1i: sin
    // esto todos quedan en la unidad 0 (la textura A, r/θ/J0) y el shader
    // lee los valores equivocados donde debería leer las Bessel angulares —
    // el patrón se degrada a un resplandor radial sin mandala. uTexAo
    // (unidad 5) es la textura A de la flor ANTERIOR durante un fundido.
    gl.useProgram(prog);
    gl.uniform1i(u.uTexA, 0);
    gl.uniform1i(u.uTexB, 1);
    gl.uniform1i(u.uTexC, 2);
    gl.uniform1i(u.uTexBo, 3);
    gl.uniform1i(u.uTexCo, 4);
    gl.uniform1i(u.uTexAo, 5);
    return {
      gl,
      prog,
      isGL2,
      canvas,
      u,
      blackTex,
      scratch: {
        j: new Float32Array(8),
        ph: new Float32Array(7),
        m: new Float32Array(6),
        jo: new Float32Array(8),
        pho: new Float32Array(7),
        mo: new Float32Array(6),
      },
    };
  } catch (err) {
    console.warn('[cimática] WebGL no disponible:', err);
    return null;
  }
}

// Reempaqueta la tabla radial de 13 columnas en las tres texturas RGBA de la
// GPU: A (r, θ, J0, grano — J0 depende del modo, así que A se re-subir con
// cada modo), B (J_mDom, J_mS1, J_mS2, J_mD1) y C (J_mD2, J_mD3, polvo, 0).
function packGL(rad, res) {
  const n = res * res;
  const A = new Float32Array(n * 4);
  const B = new Float32Array(n * 4);
  const C = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 13;
    const a4 = i * 4;
    A[a4] = rad[o];
    A[a4 + 1] = rad[o + 1];
    A[a4 + 2] = rad[o + 2];
    A[a4 + 3] = rad[o + 11];
    B[a4] = rad[o + 3];
    B[a4 + 1] = rad[o + 4];
    B[a4 + 2] = rad[o + 5];
    B[a4 + 3] = rad[o + 6];
    C[a4] = rad[o + 7];
    C[a4 + 1] = rad[o + 8];
    C[a4 + 2] = rad[o + 12];
    C[a4 + 3] = 0;
  }
  return [A, B, C];
}

// Paletas (RGB 0-255): azul profundo para los valles, blanco para los picos.
// El color de cada gota llega desde main.js con la misma paleta del
// visualizador de gotas (izquierda azul, centro morado/acento, derecha rosa);
// si no se pasa ninguno se usan cian/índigo por defecto.
const C_DEEP = [9, 22, 48];
const C_CYAN = [34, 211, 238];
const C_INDIGO = [129, 140, 248];
const C_WHITE = [238, 249, 255];

// Temperatura de color de la luz de cresta, ligada a la frecuencia REAL
// (mejora de luz/variables 2026-09-02): antes C_WHITE era fijo para
// cualquier Hz — la "luz" de la placa no reflejaba de ningún modo el tono
// que se está escuchando. Grave (~40 Hz) tira a ámbar cálido; agudo
// (~900 Hz+) tira a azul-violeta frío; 220 Hz (la referencia física de todo
// el módulo, ver REF_F) es EXACTAMENTE C_WHITE, así que el aspecto por
// defecto no cambia. Heurística de percepción (no un blackbody real), en la
// misma línea que el resto de las capas "cinematic" del renderer.
const WARM_WHITE = [255, 236, 208];
const COOL_WHITE = [214, 229, 255];
function crestColorFor(f) {
  if (f <= REF_F) {
    const t = clamp01((REF_F - f) / (REF_F - 40));
    return [
      C_WHITE[0] + (WARM_WHITE[0] - C_WHITE[0]) * t,
      C_WHITE[1] + (WARM_WHITE[1] - C_WHITE[1]) * t,
      C_WHITE[2] + (WARM_WHITE[2] - C_WHITE[2]) * t,
    ];
  }
  const t = clamp01((f - REF_F) / (900 - REF_F));
  return [
    C_WHITE[0] + (COOL_WHITE[0] - C_WHITE[0]) * t,
    C_WHITE[1] + (COOL_WHITE[1] - C_WHITE[1]) * t,
    C_WHITE[2] + (COOL_WHITE[2] - C_WHITE[2]) * t,
  ];
}

// El máximo cae en el latido. La subida es breve y el brillo tarda
// más en caer, con pendiente cero al entrar y salir del destello.
function plateLampPulse(phase) {
  const cycle = phase / TWO_PI;
  const envelope = clamp01(cycle < 0.5 ? 1 - cycle / 0.44 : (cycle - 0.80) / 0.20);
  return envelope * envelope * (3 - 2 * envelope);
}

function drawPlateLamp(ctx, cx, cy, r, light, sweep, tint) {
  const radius = r * 1.04;
  const x = cx + Math.sin(sweep) * radius;
  const y = cy - Math.cos(sweep) * radius;
  const falloff = ctx.createRadialGradient(x, y, 0, x, y, r * 0.67);
  falloff.addColorStop(0, tint ? lampInk(tint, 0.64 * light, 0.5) : `rgba(255,249,228,${0.64 * light})`);
  falloff.addColorStop(0.17, tint ? lampInk(tint, 0.27 * light, 0.28) : `rgba(202,235,255,${0.27 * light})`);
  falloff.addColorStop(0.47, tint ? lampInk(tint, 0.08 * light, 0) : `rgba(96,194,251,${0.08 * light})`);
  falloff.addColorStop(1, tint ? lampInk(tint, 0) : 'rgba(96,194,251,0)');

  ctx.save();
  ctx.fillStyle = falloff;
  ctx.fillRect(x - r * 0.67, y - r * 0.67, r * 1.34, r * 1.34);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI * 0.94, -Math.PI * 0.06);
  ctx.strokeStyle = tint ? lampInk(tint, 0.27 * light, 0) : `rgba(67,192,255,${0.27 * light})`;
  ctx.lineWidth = r * 0.082;
  ctx.stroke();
  ctx.strokeStyle = tint ? lampInk(tint, 0.81 * light, 0.27) : `rgba(188,230,255,${0.81 * light})`;
  ctx.lineWidth = r * 0.028;
  ctx.stroke();

  // Un tramo de blanco cálido viaja por el tubo; el arco nunca se apaga
  // por completo entre pulsos.
  const hot = ctx.createLinearGradient(x - r * 0.62, y, x + r * 0.62, y);
  hot.addColorStop(0, tint ? lampInk(tint, 0) : 'rgba(255,250,223,0)');
  hot.addColorStop(0.5, tint ? lampInk(tint, light, 0.45) : `rgba(255,250,223,${light})`);
  hot.addColorStop(1, tint ? lampInk(tint, 0) : 'rgba(255,250,223,0)');
  ctx.strokeStyle = hot;
  ctx.lineWidth = r * 0.015;
  ctx.stroke();
  ctx.restore();
}

// Granulometría propia de cada plato: cada gota usa su propia mezcla de sal
// y su propio campo capilar — como tres experimentos de cimática montados
// con polvos distintos. Frecuencias entre sí irracionales evitan la rejilla
// visible y dan un moteado orgánico.
//   gk1..gk4 — frecuencias espaciales (px⁻¹ del buffer) del chisporroteo
//              capilar sobre la superficie
//   pk1..pk4 — frecuencias del moteado que rompe las líneas nodales en
//              granos de polvo (px⁻¹)
//   sand     — grosor base de la línea nodal (σ de la campana de sal)
//   pow      — fuerza del moteado (0 = línea lisa, 1 = grano grueso)
//   salt     — cantidad de polvo acumulado (brillo de la línea)
const GRAIN_SETS = [
  { gk1: 0.34, gk2: 0.41, gk3: 0.28, gk4: 0.47, pk1: 3.1, pk2: 1.7, pk3: 3.7, pk4: 2.3, sand: 0.02, pow: 0.14, salt: 1.0 },
  { gk1: 0.52, gk2: 0.29, gk3: 0.44, gk4: 0.33, pk1: 4.6, pk2: 2.4, pk3: 3.2, pk4: 3.9, sand: 0.024, pow: 0.18, salt: 1.0 },
  { gk1: 0.23, gk2: 0.55, gk3: 0.37, gk4: 0.25, pk1: 2.6, pk2: 3.3, pk3: 4.1, pk4: 1.9, sand: 0.018, pow: 0.11, salt: 0.95 },
];

// Versión oscura de un color de gota: el agua en calma se hunde hacia un
// azul noche casi negro, con solo un matiz del color de la gota — como el
// agua real bajo la luz cenital en una foto de cimática (los valles casi
// negros, nunca un azul brillante que difumine el patrón).
function shadeDeep(c) {
  return [
    Math.round(c[0] * 0.1 + C_DEEP[0] * 0.9),
    Math.round(c[1] * 0.08 + C_DEEP[1] * 0.92),
    Math.round(c[2] * 0.14 + C_DEEP[2] * 0.86),
  ];
}

export class CymaticsRenderer {
  get usesCpu() {
    return this._gl === null;
  }

  constructor() {
    // Un buffer por gota: se renderizan aparte (resolución alta) para que
    // los anillos salgan nítidos a cualquier tamaño de pantalla, y el plato
    // se dibuja directo con un gradiente (barato y siempre nítido).
    this._drops = [];
    for (let i = 0; i < 3; i++) {
      const c = document.createElement('canvas');
      this._drops.push({ canvas: c, ctx: c.getContext('2d'), img: null, res: 0, rad: null, radK: -1, radM: null, radN: null, pending: null });
    }
    // Transición entre frecuencias: al cambiar el modo de una gota (p. ej.
    // al pasar de un estado a otro) el patrón anterior se desvanece mientras
    // la nueva flor se despliega, en vez de saltar de golpe. _lastKey guarda
    // la clave del modo dibujado el fotograma anterior, _lastP sus
    // parámetros (modos, amplitudes, fases y escala radial) y _morph la
    // transición en curso (b: 1 → 0 durante ~3 s).
    this._lastKey = ['', '', ''];
    this._lastP = [null, null, null];
    this._morph = [null, null, null];
    // Frecuencia "retenida" por gota, específica para la BÚSQUEDA de modo y
    // sus amplitudes de detuning (auditoría P7 2026-09-03 — reportado en
    // vivo: sigue habiendo pestañeos/cambios erráticos en saltos grandes de
    // frecuencia, se pidió explícitamente que reaccione "como un líquido").
    // CAUSA raíz encontrada: el modo dominante (m,n) es un ENTERO elegido
    // por resonancia más cercana a `d.f`; la tabla radial (textura, con el
    // Bessel J real por modo) se reconstruye de a tramos en varios cuadros
    // ("por tramos... para no congelar el render"), y CUALQUIER cambio de
    // modo a mitad de esa construcción la ABORTA y arranca de cero — pero
    // uM[]/uJ[] (subidos al shader cada cuadro) siguen la BÚSQUEDA EN VIVO,
    // no la textura ya construida. En un salto grande, `d.f` (ya suavizado
    // por pBase, τ=1,5s) igual atraviesa varios límites de resonancia más
    // rápido de lo que la textura tarda en reconstruirse (~130ms) — cada
    // cruce reinicia la construcción, así que uM/uJ terminan describiendo un
    // modo que la textura todavía no tiene: ángulo y radio desincronizados,
    // que es justo la "forma errática" reportada, no un simple parpadeo.
    // FIX: una SEGUNDA capa de suavizado (más lenta, τ≈1s), aplicada nada
    // más que a la frecuencia que alimenta la búsqueda de modo/amplitudes —
    // no a pBase en sí, que sigue afinando el resto con su propio ritmo. El
    // modo no puede moverse más rápido de lo que la textura puede seguirle
    // el paso, y el resultado es continuo (EMA, no una espera-y-salta): se
    // siente como líquido asentándose, no como un interruptor.
    this._heldF = [null, null, null];
    // Modo (m, n) actualmente ASENTADO por gota (fix "sigue dando saltos",
    // 2026-09-03) — NO leer esto de `buf.radM`/`radN`: `_ensureDrop` los
    // resetea a null cada vez que cambia la resolución del búfer (`resD`, que
    // se recalcula cada fotograma vía `_resMul` y puede driftear en pleno
    // cambio de frecuencia, justo cuando construir la tabla nueva es más
    // probable que mueva el frame time). Este campo se actualiza SOLO cuando
    // una construcción termina de comprometerse (ver más abajo, junto a
    // `buf.radK = pend.key`), nunca en `_ensureDrop`, así sobrevive a
    // cambios de resolución y sigue sirviendo de punto de partida real para
    // `modeStepToward`.
    this._curMode = [null, null, null];
    // FEATURE (2026-09-08, "hagamos que se interpole" — pedido explícito
    // tras "va bien y luego salta"/"también salta al solo reproducir un
    // preset"): cuando el salto real de modo es grande, en vez de ir directo
    // del modo viejo al nuevo en un solo fundido, se pasa por 1-3 resonancias
    // REALES intermedias en el camino (ver `_computeModeWaypoints` más abajo)
    // — cada una es un modo (m,n) físico de verdad, con sus propios pétalos y
    // anillos, no una interpolación matemática inventada de la geometría.
    // Cola de espera por gota: cuando no está vacía, el siguiente ciclo de
    // fundido saca el próximo waypoint en vez de volver a buscar desde cero.
    this._waypointQueue = [[], [], []];
    // Energía de la vibración (0..1): sube cuando suena y decae cuando no,
    // modelando la constante de tiempo con que el agua real responde a la
    // excitación y se calma al cortarla. El patrón de Faraday solo emerge
    // por encima del umbral de aceleración, como en un experimento real.
    this._energy = 0;
    this._fineRipples = 0;
    this._lampTint = null;
    this._lastT = 0;
    this._liquidPhase = 0;
    this._reflectedPhase = 0;
    this._lampPhase = 0;
    this._lampPulse = STATIC_LAMP_PULSE;
    this._lampSweep = 0;
    this._lampBeatGroup = null;
    this._visualPulse = 0.5;
    this._visualAm = 0.775;
    this._motionPreference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    // Volumen suavizado (Parte B, auditoría 2026-09-08): el volumen real
    // entraba como multiplicador instantáneo de ampPattern (auditoría
    // 2026-08-29) — un salto 0%→100% se reflejaba en el mismo fotograma. Ver
    // su uso más abajo (render()): relaja con el mismo modelo de
    // amortiguación que el resto del plato (τ = 1/γ(f), tiempo REAL, sin
    // SLOWMO_K — no envuelve ninguna oscilación visible que necesite
    // acompañar la cámara lenta), no un τ inventado aparte. null hasta el
    // primer fotograma (arranca en el volumen real, sin salto desde 0).
    this._volState = null;
    // Fase de precesión integrada por modo (3 gotas × 9 modos rotables):
    // cada modo acumula su propia fase angular integrando su velocidad cada
    // fotograma — la precesión es lenta, decorrelada entre modos y puede
    // invertir el sentido, como el batido real entre modos casi degenerados.
    this._rotPhase = new Float64Array(3 * 9);
    this._rotSeeded = false;
    // Rendimiento adaptativo: se mide el tiempo real de cada fotograma y la
    // resolución de las gotas sube o baja despacio para mantener los FPS en
    // cualquier dispositivo (más nitidez si sobra tiempo, más suave si no).
    this._frameEMA = 16;
    this._resMul = 1;
    // Se inicializa en el primer render visible. null indica que el
    // navegador debe usar el rasterizador CPU.
    this._gl = undefined;
    this._glDrops = [
      { texA: null, texB: null, texC: null },
      { texA: null, texB: null, texC: null },
      { texA: null, texB: null, texC: null },
    ];
    this._glRes = 0;
    
    // Neural-physics coupling.
    // _physicsTarget: raw values from the neural model (set each frame).
    // _physicsState: smoothed version with physical inertia (EMA, τ ≈ 1.5 s).
    // Separating target from smoothed state prevents instant visual jumps when
    // the neural profile changes — fluids have inertia.
    this._physicsTarget = { coherence: 0.5, velocity: 0.5, complexity: 0.5, baseFrequency: 220 };
    this._physicsState  = { coherence: 0.5, velocity: 0.5, complexity: 0.5, baseFrequency: 220 };

    // -------------------------------------------------------------------------
    // PHASE 3: Render Mode
    // 'cinematic'  — Full artistic rendering (all layers: grain, harmonic mD,
    //                evo() modulation, rotation, ripples, shimmer, color
    //                palette). Default.
    // 'scientific' — Only physically-derived layers (Bessel eigenmodes, modal
    //                pattern with detuning). No grain, no mD harmonics, no
    //                evo() modulation, no rotation/precession (rotSpeed()
    //                returns 0), no traveling wave highlights, no shimmer (shim*). Colors are
    //                monochrome. FIX (auditoría 2026-09-08): before this
    //                fix, ampDom/ampS1/ampS2 had their own breathing sines
    //                OUTSIDE evo() that weren't gated, and rotSpeed()/rip*/
    //                shim* ran unconditionally in every mode — 'scientific'
    //                looked scientific but still moved/rippled/shimmered
    //                artistically. All of those are now gated here too, so
    //                this mode is safe to use for validating the physical
    //                model independently (a static frame is expected: real
    //                Faraday precession is far too slow to see live anyway,
    //                see rotSpeed()'s own comment).
    //                Remaining known gap: `coherence`/`velocity`/`complexity`
    //                still modulate amplitudes/lighting even in this mode —
    //                those come from the neural model, not from cymatics
    //                heuristics, and are out of scope for this fix (see
    //                NeuralToVisualMapper's own VISUAL/'visual metaphor'
    //                labeling in docs/scientific-model.md).
    // -------------------------------------------------------------------------
    this._renderMode = 'cinematic';
  }

  /**
   * Switch rendering mode.
   * @param {'cinematic'|'scientific'} mode
   */
  setRenderMode(mode) {
    if (mode !== 'cinematic' && mode !== 'scientific') {
      console.warn(`[CymaticsRenderer] Unknown renderMode "${mode}". Use "cinematic" or "scientific".`);
      return;
    }
    if (mode === this._renderMode) return;
    if (mode === 'scientific') {
      // Un fundido iniciado en modo cinematográfico conserva los pesos de
      // sus capas de detalle. Descártalo antes de mostrar modos propios.
      for (let i = 0; i < this._drops.length; i++) {
        this._releaseMorphTex(i);
        this._morph[i] = null;
        const drop = this._drops[i];
        const snapshot = this._lastP[i];
        this._lastKey[i] = drop.radK;
        this._lastP[i] = snapshot?.mDom === drop.radM && snapshot?.nDom === drop.radN
          ? { ...snapshot, amp0: 0, ampS1: 0, ampS2: 0, ampD1: 0, ampD2: 0, ampD3: 0 }
          : null;
        drop.pending = null;
      }
    }
    this._renderMode = mode;
    console.log(`[CymaticsRenderer] Render mode: ${mode.toUpperCase()}`);
  }

  getRenderMode() {
    return this._renderMode;
  }


  pulse(strength) {
    // Add energy directly based on the pulse strength
    this._energy = Math.min(1.2, this._energy + strength * 0.2);
  }

  /**
   * Called each frame by simulation.js with the neural-derived physics state.
   * Only updates the TARGET; the smoothed _physicsState is updated inside render().
   */
  updatePhysicsState(state) {
    // Write into target only — render() will EMA-smooth toward this each frame.
    this._physicsTarget.coherence     = state.coherence     ?? 0.5;
    this._physicsTarget.velocity      = state.velocity      ?? 0.5;
    this._physicsTarget.complexity    = state.complexity    ?? 0.5;
    this._physicsTarget.baseFrequency = state.baseFrequency ?? 220;
  }

  // (Re)crea el buffer de una gota si cambió su resolución, junto con la
  // tabla radial estática (r, θ y las Bessel del patrón) que se rellena
  // cuando cambia el modo. `pending` guarda la tabla en construcción del
  // nuevo modo (se llena por tramos para no congelar el fotograma).
  _ensureDrop(d, res) {
    if (d.res === res) return;
    d.res = res;
    d.canvas.width = res;
    d.canvas.height = res;
    d.img = d.ctx.createImageData(res, res);
    // 13 valores por píxel: r, θ, J0, J_mDom, J_mS1, J_mS2, J_mD1..J_mD3
    // (las columnas 9 y 10 quedan sin usar, en 0), grano capilar y moteado
    // del polvo.
    d.rad = new Float32Array(res * res * 13);
    // La ruta CPU construye la tabla de frentes una vez por resolución.
    d.waves = this._gl ? null : new Float32Array(res * res * WAVE_STRIDE);
    d.relief = this._gl ? null : new Float32Array(res * res);
    d.waveRows = 0;
    d.waveMix = 0;
    d.radK = -1;
    d.radM = null;
    d.radN = null;
    d.pending = null;
  }

  // Crea una textura RGBA de coma flotante con los datos espaciales de una
  // gota: RGBA32F en WebGL2, RGBA+FLOAT (con OES_texture_float) en WebGL1.
  _makeTex(res, data) {
    const gl = this._gl.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this._gl.isGL2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, res, res, 0, gl.RGBA, gl.FLOAT, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, res, res, 0, gl.RGBA, gl.FLOAT, data);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  _deleteTex(tex) {
    if (tex && this._gl) this._gl.gl.deleteTexture(tex);
  }

  // Sube las texturas de la gota i cuando la tabla radial del nuevo modo
  // terminó de construirse por tramos (la misma rejilla que usa la ruta
  // CPU). Si cambió la resolución, se recrea el lienzo GL compartido y
  // todas las texturas de las tres gotas.
  _uploadDropGL(i, pend) {
    const gd = this._glDrops[i];
    if (!this._gl || !gd) return;
    const res = pend.res;
    // FIX (2026-09-12, "apagón" tras varios cambios de frecuencia rápidos):
    // el lienzo GL compartido (tamaño, viewport) y la liberación de
    // fundidos en curso ahora se resuelven ANTES de este punto, una sola
    // vez por fotograma, apenas se conoce el `glResAll` de ESE fotograma
    // (ver render(), justo después de calcularlo) — no acá, atado a que
    // justo ESTA gota termine su construcción por tramos. Antes, si ninguna
    // gota llegaba a terminar antes de que `glResAll` volviera a crecer
    // (típico arrastrando el slider rápido), el lienzo real quedaba más
    // chico que el `resD` que el loop de dibujo ya estaba usando para el
    // viewport — recortando la mitad inferior de cada gota. `res` (de
    // `pend.res`, la resolución que tenía `glResAll` cuando ESTA gota
    // arrancó su construcción) puede ya no ser la MÁS reciente para cuando
    // termina — no importa: el shader arma la UV con `uRes` normalizado, así
    // que subir una textura a una resolución distinta de la actual del
    // lienzo se sigue viendo bien (ligeramente distinta densidad interna,
    // nunca corrupto).
    const packed = packGL(pend.rad, res);
    // La textura A lleva la J0 del MODO (argScale cambia con m, n), así que
    // también se re-suben por modo, no solo por resolución: antes solo se
    // creaba si no existía y, al cambiar de estado con la misma resolución,
    // los anillos de fondo quedaban los de un modo viejo para siempre.
    const morph = this._morph[i];
    if (morph && gd.texA && !morph.texAold) {
      // Transición en curso: la flor anterior sigue usando su J0 (textura
      // A vieja) hasta que termine el fundido; se guarda aquí para
      // restaurarla en el shader (uTexAo) y liberarla al final.
      morph.texAold = gd.texA;
    }
    // Solo las texturas capturadas por el fundido siguen en uso. Las de
    // reconstrucciones intermedias se liberan al reemplazarlas.
    if (gd.texA !== morph?.texAold) this._deleteTex(gd.texA);
    if (gd.texB !== morph?.texBold) this._deleteTex(gd.texB);
    if (gd.texC !== morph?.texCold) this._deleteTex(gd.texC);
    gd.texA = this._makeTex(res, packed[0]);
    gd.texB = this._makeTex(res, packed[1]);
    gd.texC = this._makeTex(res, packed[2]);
  }

  // FEATURE (2026-09-08, "hagamos que se interpole"): calcula el camino de
  // resonancias REALES entre el modo viejo y el nuevo, muestreando la
  // frecuencia resonante a pasos regulares entre fCenter(viejo) y
  // fCenter(nuevo) y buscando el modo físico más cercano en cada paso —
  // con la búsqueda acotada al rango angular de los dos extremos. Cada
  // punto del camino es un modo (m,n) real y completo — la gota lo va a
  // renderizar con SUS propios pétalos y anillos reales, no una geometría
  // interpolada a mano. Los pasos duplicados/consecutivos-iguales se
  // descartan (ver dedupe abajo) y el objetivo final siempre queda como
  // último elemento, así el camino termina exactamente donde ya terminaba
  // antes de este feature.
  _computeModeWaypoints(mOld, nOld, mNew, nNew) {
    const fOld = modeOmega(mOld, nOld, PHYS_A) / Math.PI;
    const fNew = modeOmega(mNew, nNew, PHYS_A) / Math.PI;
    // FIX (2026-09-12, "es demasiado grande el cambio" — confirmado tras el
    // fix de arriba: el camino ya no salta de pétalos al azar, pero para un
    // salto grande (ej. 190→963 Hz) igual pasaba por 3-4 paradas reales
    // distintas a lo largo de ~30s — aunque cada una progresa bien, ver
    // TANTOS cambios de forma seguidos se sigue sintiendo como "demasiado".
    // Bajado de 3 a 1 punto intermedio muestreado: como mucho una resonancia
    // real en el medio además del destino final (2 tramos en vez de hasta
    // 4), y la duración total baja de ~30s a ~18-24s en los saltos más
    // extremos — se lee como UNA reorganización grande en vez de una
    // cadena de cambios. El acotado a m∈[mOld,mNew] de arriba sigue
    // aplicando igual: un tramo más grande en n (más anillos de una vez)
    // se ve como crecimiento suave, no como cambio de forma, mientras m no
    // se salga del rango.
    const STEPS = 1; // puntos intermedios muestreados
    // FIX (2026-09-12, "cambia entre formas erráticamente" — reportado en
    // una transición real, ej. 190→963 Hz): antes cada punto intermedio
    // buscaba el modo m∈[2,6] (o el fallback m∈[0,1]) más afinado a esa
    // frecuencia SIN mirar qué tan lejos quedaba m del rango [mOld,mNew] —
    // la densidad de resonancias no es uniforme, así que el más afinado en
    // una frecuencia intermedia podía tener un m totalmente distinto al de
    // ambos extremos (medido: 190→963 Hz pasaba por m=5 y m=1 en el medio,
    // aunque el viejo y el nuevo modo eran m=3 y m=2 — la cantidad de
    // pétalos subía y bajaba de golpe en vez de progresar). Esto SIEMPRE
    // estuvo así (no es una regresión de esta sesión) — quedaba parcialmente
    // tapado mientras el fundido se cortaba antes de tiempo (ver el fix de
    // "sigue pasando en ciertos puntos de la transición" un poco más
    // arriba en el archivo); al dejar que el fundido corra completo, cada
    // parada del camino se ve entera, incluida esta. Acotar la búsqueda de
    // cada parada intermedia a m∈[mLo,mHi] (el rango que YA cubren los dos
    // extremos reales) impide que un punto intermedio "se escape" a un m
    // fuera de ese rango — el número de anillos (n) sigue variando libre
    // para cubrir la distancia real en frecuencia, que es lo que se lee
    // como progresión suave en vez de salto de pétalos.
    const mLo = Math.min(mOld, mNew);
    const mHi = Math.max(mOld, mNew);
    const waypoints = [];
    let last = { m: mOld, n: nOld };
    for (let k = 1; k <= STEPS; k++) {
      const fMid = fOld + (fNew - fOld) * (k / (STEPS + 1));
      const found = selectNearestMode(Math.PI * Math.max(1, fMid), PHYS_A, { mMin: mLo, mMax: mHi });
      if (found.m !== last.m || found.n !== last.n) {
        waypoints.push({ m: found.m, n: found.n });
        last = { m: found.m, n: found.n };
      }
    }
    if (!waypoints.length || last.m !== mNew || last.n !== nNew) {
      waypoints.push({ m: mNew, n: nNew });
    }
    return waypoints;
  }

  // Libera las texturas de la flor anterior al terminar una transición.
  _releaseMorphTex(i) {
    const m = this._morph[i];
    if (!m || !this._gl) return;
    const gd = this._glDrops[i];
    if (gd) {
      if (m.texBold && m.texBold !== gd.texB) this._gl.gl.deleteTexture(m.texBold);
      if (m.texCold && m.texCold !== gd.texC) this._gl.gl.deleteTexture(m.texCold);
      if (m.texAold && m.texAold !== gd.texA) this._gl.gl.deleteTexture(m.texAold);
    }
  }

  /**
   * Dibuja la simulación en el contexto principal.
   * @param {CanvasRenderingContext2D} ctx  contexto del lienzo visible
   * @param {number} w  ancho del lienzo en píxeles de dispositivo
   * @param {number} h  alto del lienzo en píxeles de dispositivo
   * @param {object} params { base, beat, playing, pulse }
   *   base: frecuencia portadora (f1, 220 Hz por defecto)
   *   beat: latido binaural (Δf)
   *   playing: si la sesión está sonando
   *   pulse: 0..1, fase del latido real (1 = justo en el pulso)
   */
  render(ctx, w, h, params) {
    if (this._gl === undefined) this._gl = initGL();
    if (this._gl?.gl.isContextLost()) {
      // Los buffers de WebGL ya no son válidos. Reconstruir las gotas en
      // CPU conserva su fase y hace que el reloj visual siga avanzando.
      this._gl = null;
      this._glRes = 0;
      this._glDrops.length = 0;
      this._morph.fill(null);
      this._lastP.fill(null);
      this._lastKey.fill('');
      for (const drop of this._drops) {
        drop.res = 0;
        drop.pending = null;
      }
    }
    const {
      base = 220, beat = 6, beatHz = beat, pulse = 0.5, beatSample = null, motionOverride = null,
      colors, lampColor = null, lampMoving = null, playing = true, condition = 'binaural', volume = 0.6, wave = 'sine',
    } = params;
    // Condiciones con batido real (binaural/AM): la placa respira con el
    // latido. Las demás (tono puro, ruido, silencio) respiran a ritmo natural.
    const rhythmicCond = () => condition === 'binaural' || condition === 'amplitude-modulation';

    // PHASE 3: Render Mode gate. All artistic (HEURISTIC/VISUAL) layers are
    // disabled in 'scientific' mode so only physically-derived Bessel eigenmodes
    // are rendered. This allows the physical model to be validated independently.
    const sciMode = this._renderMode === 'scientific';

    const tMs = performance.now();
    const t = tMs / 1000;

    // ----- Energía de la vibración (decaimiento real) ----------------------
    // Al arrancar, el patrón emerge en ~0,6 s; al cortar, se apaga suave
    // (el agua se calma con su amortiguación).
    if (this._lastT === 0) this._lastT = t;
    const dt = Math.max(0, Math.min(0.1, t - this._lastT));
    this._lastT = t;

    // FIX (2026-09-08, "que la transición sea real" — apagón inicial
    // reportado y grabado en vivo: el patrón aparece, casi se apaga y
    // reaparece con otra forma en los primeros ~10s, SIN que el usuario
    // haya tocado nada). Causa raíz: `_physicsState.baseFrequency` (de
    // donde sale `pBase`, que alimenta `d.f` → `_dropF` → `_heldF` → la
    // búsqueda de modo) arrancaba SIEMPRE en 220 Hz fijo en el constructor,
    // sin importar la frecuencia real seleccionada — cada carga de página
    // tenía que ATRAVESAR ese hueco (220→190, 220→963, lo que sea) a
    // través de TRES filtros EMA encadenados (baseFrequency 1,5s → _dropF
    // 1,5s → _heldF 1s), cruzando de paso 1-3 límites de resonancia reales
    // en el camino — cada cruce reconstruía el patrón desde cero, y eso es
    // el "apagón y reaparición con otra forma" grabado, no una transición
    // real. Mismo criterio que `_heldF` (que sí ya arrancaba "caliente",
    // ver su comentario en el constructor): en el primer fotograma,
    // `physicsState`/`physicsTarget`.baseFrequency arrancan directo en la
    // frecuencia REAL en vez de gatear un viaje artificial desde 220.
    if (!this._physicsWarm) {
      this._physicsWarm = true;
      this._physicsState.baseFrequency = base;
      this._physicsTarget.baseFrequency = base;
    }

    // SILENCE control: no hay estímulo → la placa no se excita (agua en
    // calma). Las demás condiciones mantienen la energía de vibración.
    const target = playing && condition !== 'none' ? 1 : 0;
    const relaxation = target ? 0.50 : 0.88;
    this._energy += (target - this._energy) * (1 - Math.exp(-dt / relaxation));
    const fineRelaxation = target ? relaxation : relaxation / FINE_RIPPLE_DAMPING;
    this._fineRipples += (target - this._fineRipples) * (1 - Math.exp(-dt / fineRelaxation));
    // Transición de color del tubo y sus reflejos sobre una misma fuente.
    const targetTint = lampColor ?? DEFAULT_LAMP_REFLECTION;
    if (!this._lampTint && lampColor) this._lampTint = DEFAULT_LAMP_REFLECTION.slice();
    if (this._lampTint) {
      const tintStep = 1 - Math.exp(-dt / 0.10);
      for (let c = 0; c < 3; c++) this._lampTint[c] += (targetTint[c] - this._lampTint[c]) * tintStep;
      if (!lampColor && this._lampTint.every((channel, i) => Math.abs(channel - targetTint[i]) < 0.5)) {
        this._lampTint = null;
      }
    }
    const lampTint = this._lampTint;
    const reflectedColor = lampTint ?? DEFAULT_LAMP_REFLECTION;

    // --- FIX P5: EMA-smooth physicsState toward physicsTarget (τ = 1.5 s) ---
    // When playing, track the neural model. When not playing, decay toward
    // a physical resting state (coherence→0.5, velocity→0.2).
    // This gives the fluid system inertia: profile changes appear gradually,
    // not as instant visual jumps.
    const TAU_PHYS = 1.5; // seconds time-constant for physics state smoothing
    const emaK = 1 - Math.exp(-dt / TAU_PHYS);
    if (playing) {
      // La condición experimental define el régimen de la placa (Fase 16):
      //   binaural           → interferencia de dos frecuencias (coherencia media)
      //   pure-tone          → patrón estacionario de UN tono (coherencia alta,
      //                        complejidad baja: la flor simétrica del plato)
      //   amplitude-mod...   → portadora con envolvente (velocidad alta)
      //   noise              → régimen turbulento (coherencia baja, complejidad
      //                        y velocidad altas: la estructura se rompe)
      //   none               → reposo (la placa no se excita)
      const CT = {
        binaural:               { coherence: 0.6, velocity: 0.5, complexity: 0.55 },
        'pure-tone':            { coherence: 0.85, velocity: 0.25, complexity: 0.25 },
        'amplitude-modulation': { coherence: 0.7, velocity: 0.65, complexity: 0.5 },
        noise:                  { coherence: 0.25, velocity: 0.85, complexity: 0.85 },
        none:                   { coherence: 0.5, velocity: 0.2, complexity: 0.3 },
      };
      const ct = CT[condition] || CT.binaural;
      // FIX (auditoría 2026-08-29): antes esto pisaba _physicsTarget con
      // CT[condition] a secas, descartando lo que updatePhysicsState() acaba
      // de escribir desde el modelo neuronal real (NeuralToVisualMapper) —
      // el "acople neuronal" documentado era código muerto mientras sonaba.
      // Ahora CT[condition] es el ANCLA de régimen (qué tan coherente/rápida/
      // compleja es la placa para ESTA condición experimental) y el modelo
      // neuronal real modula alrededor de esa ancla según cuánto se desvíe
      // del reposo neutro (0.5) — arousal/relajación/fatiga sí cambian
      // visiblemente coherencia/velocidad/complejidad en vivo, sin que dejen
      // de reconocerse las condiciones (binaural sigue siendo más ordenado
      // que ruido, etc.), porque la desviación se aplica sobre el ancla, no
      // en lugar de ella.
      const NEUTRAL = 0.5;
      const NEURAL_INFLUENCE = 0.5;
      const nCoherence  = this._physicsTarget.coherence;
      const nVelocity   = this._physicsTarget.velocity;
      const nComplexity = this._physicsTarget.complexity;
      this._physicsTarget.coherence     = clamp01(ct.coherence  + (nCoherence  - NEUTRAL) * NEURAL_INFLUENCE);
      this._physicsTarget.velocity      = clamp01(ct.velocity   + (nVelocity   - NEUTRAL) * NEURAL_INFLUENCE);
      this._physicsTarget.complexity    = clamp01(ct.complexity + (nComplexity - NEUTRAL) * NEURAL_INFLUENCE);
      this._physicsTarget.baseFrequency = base;
      this._physicsState.coherence     += (this._physicsTarget.coherence     - this._physicsState.coherence)     * emaK;
      this._physicsState.velocity      += (this._physicsTarget.velocity      - this._physicsState.velocity)      * emaK;
      this._physicsState.complexity    += (this._physicsTarget.complexity    - this._physicsState.complexity)    * emaK;
      this._physicsState.baseFrequency += (this._physicsTarget.baseFrequency - this._physicsState.baseFrequency) * emaK;
    } else {
      // FIX P2: Decay toward neutral resting state when not playing.
      // Relaxation rate is 2× slower than excitation (fluids calm gradually).
      const TAU_REST = 3.0;
      const restK = 1 - Math.exp(-dt / TAU_REST);
      this._physicsState.coherence     += (0.5 - this._physicsState.coherence)     * restK;
      this._physicsState.velocity      += (0.2 - this._physicsState.velocity)      * restK;
      this._physicsState.complexity    += (0.3 - this._physicsState.complexity)    * restK;
      // FIX (2026-09-28, "eco de cambiar de frecuencia" — reportado en vivo:
      // elegir un preset SIN reproducir y recién después apretar play mostraba
      // una transición animada de varios segundos, como si el plato viajara
      // en vivo desde el preset viejo hacia el nuevo justo al arrancar el
      // audio). CAUSA: baseFrequency usaba el MISMO restK lento de arriba
      // (τ=3s, pensado para que coherence/velocity/complexity — la
      // "vivacidad" del plato — se apaguen gradualmente al pausar una sesión
      // que SÍ estaba sonando) también para la frecuencia representada. Sin
      // reproducción no hay ningún patrón sonando del que "relajarse
      // gradualmente" — medido en vivo (harness Node determinístico), tras
      // 700ms sin play pBase apenas recorría un 13% del salto 963→190 Hz, así
      // que CUALQUIER play posterior arrancaba a mitad de un glide de varios
      // segundos más, con cambios de modo reales en pleno reproducir. El
      // resto del pipeline (main.js selectState → simulation.setProfile) ya
      // trata "sin reproducción" como "actualizar el estado/UI al instante"
      // (ver comentario Golden Rule) — pBase debe seguir ese mismo criterio:
      // sin audio sonando, el plato refleja el preset elegido de inmediato,
      // no lo persigue con inercia. (τ de coherence/velocity/complexity no
      // cambia: esas sí deben apagarse gradualmente al pausar una sesión real,
      // caso no reportado como bug.)
      this._physicsState.baseFrequency = base;
    }
    const coherence = this._physicsState.coherence;
    const velocity  = this._physicsState.velocity;
    const pBase     = this._physicsState.baseFrequency;
    const reducedMotion = motionOverride === null ? this._motionPreference?.matches : !motionOverride;
    const movingSurface = !sciMode && condition !== 'none';
    const movingLamp = movingSurface && (lampMoving ?? !reducedMotion);
    const env = clamp01(this._energy);
    const fine = clamp01(this._fineRipples);
    // El reloj visual da movimiento al agua aunque se interrumpa el latido.
    if (movingSurface) {
      if (movingLamp && target && beatSample) {
        const { cycles, hz, targetHz, epoch } = beatSample;
        const size = Math.max(1, Math.ceil(Math.max(hz, targetHz) / MAX_LAMP_PULSES_HZ));
        let group = this._lampBeatGroup;
        if (!group || group.epoch !== epoch || cycles < group.start) {
          group = { epoch, start: Math.floor(cycles / size) * size, size };
        } else if (cycles >= group.start + group.size) {
          const next = group.start + group.size;
          group = { epoch, start: next + Math.floor((cycles - next) / size) * size, size };
        }
        this._lampBeatGroup = group;
        this._lampPhase = TWO_PI * (cycles - group.start) / group.size;
      } else if (movingLamp) {
        this._lampBeatGroup = null;
        const visualHz = !target ? IDLE_LAMP_HZ : rhythmicCond()
          ? beatHz / Math.max(1, Math.ceil(beatHz / MAX_LAMP_PULSES_HZ))
          : 0.95;
        this._lampPhase = (this._lampPhase + TWO_PI * visualHz * dt) % TWO_PI;
      }
      // Los frentes mantienen su velocidad entre los destellos.
      // Cámara lenta visual. La relación de velocidades de los frentes
      // viene de la dispersión gravedad-capilaridad del agua.
      // Movimiento reducido: suaviza el agua independientemente de la lámpara.
      const liquidHz = reducedMotion ? 0.18 + 0.12 * env : 0.33 + (0.13 + 0.29 * velocity) * env;
      const liquidDelta = TWO_PI * liquidHz * dt;
      this._liquidPhase = (this._liquidPhase + liquidDelta) % TWO_PI;
      this._reflectedPhase = (this._reflectedPhase + liquidDelta * RIPPLE_RATE_RATIO) % TWO_PI;
    }
    // Mismo destello para la lámpara y las crestas; redondeado y sin cortes.
    const emittedPulse = movingLamp
      ? 0.43 + (plateLampPulse(this._lampPhase) - 0.43) * (0.35 + 0.65 * env)
      : STATIC_LAMP_PULSE;
    this._lampPulse += (emittedPulse - this._lampPulse) * (1 - Math.exp(-dt / 0.045));
    const lampPulse = this._lampPulse;
    const sweepTarget = movingLamp ? (0.17 + 0.15 * env) * Math.sin(this._liquidPhase) : 0;
    this._lampSweep += (sweepTarget - this._lampSweep) * (1 - Math.exp(-dt / 0.10));
    const lampSweep = this._lampSweep;
    const pulseTarget = target && Number.isFinite(pulse) ? clamp01(pulse) : 0.5;
    const pulseK = 1 - Math.exp(-dt / 0.14);
    this._visualPulse += (pulseTarget - this._visualPulse) * pulseK;
    const pulseEff = reducedMotion ? 0.5 : this._visualPulse;
    // Blanco de cresta templado por la frecuencia real (ver crestColorFor).
    const crestColor = crestColorFor(pBase);

    // La forma pierde amplitud desde el primer fotograma en pausa.
    let pat;
    if (env <= 0.18) pat = 0;
    else if (env >= 0.85) pat = 1;
    else pat = (env - 0.18) / 0.67;
    // El patrón de la frecuencia se disipa hasta cero. La pequeña onda
    // de reposo se suma aparte al relieve y nunca depende del modo Bessel.
    let ampPattern = movingSurface ? clamp01((env - 0.05) / 0.95) : pat * pat * (3 - 2 * pat);
    // AMPLITUDE MODULATION: la placa entera respira a la velocidad de la
    // envolvente real — el patrón crece y se retira con la modulación, no
    // solo brilla (la estructura varía con la señal, como en el agua).
    if (condition === 'amplitude-modulation') {
      const am = target ? 0.775 + 0.225 * Math.cos(TWO_PI * pulseTarget) : 0.775;
      this._visualAm += (am - this._visualAm) * pulseK;
      ampPattern *= reducedMotion ? 0.775 : this._visualAm;
    } else {
      this._visualAm = 0.775;
    }
    // Volumen real → intensidad visible del patrón (auditoría 2026-08-29):
    // antes subir/bajar el volumen no cambiaba nada en cimática. No se lleva
    // a 0 total en volumen mínimo (0.35 de piso) porque esto es una
    // visualización, no un medidor de nivel — a volumen bajo la flor sigue
    // reconocible, solo más tenue.
    // FIX (Parte B): era un multiplicador instantáneo — un salto 0%→100% de
    // volumen se reflejaba en el mismo fotograma en la amplitud del campo.
    // Relaja con τ = 1/γ(pBase): el MISMO modelo de amortiguación que el
    // resto del sistema (gammaAt), sin ningún factor de cámara lenta —
    // SLOWMO_K existe para que la envolvente de un modo acompañe su propia
    // oscilación mostrada en cámara lenta (así no se rompe su Q, ver la nota
    // de SLOWMO_K en plate-field.js); el volumen no envuelve ninguna
    // oscilación visible, es un multiplicador escalar puro, así que su
    // inercia es en tiempo REAL (~0,04-0,17 s según banda) — deja de ser un
    // salto instantáneo sin introducir un retraso perceptible de UI. Mismo
    // criterio que el fundido cruzado de modo (MORPH_BLEND_K, ver arriba y
    // la nota de "colisionador de frecuencias" junto a tauOld/tauNew): ese
    // fundido tampoco envuelve una oscilación, así que tampoco lleva SLOWMO_K.
    const volTarget = clamp01(volume);
    if (this._volState == null) this._volState = volTarget;
    else this._volState += (volTarget - this._volState) * (1 - Math.exp(-dt / (1 / gammaAt(pBase))));
    ampPattern *= 0.35 + 0.65 * this._volState;
    const alive = 0.12 + 0.88 * env * env;
    // Da más relieve a las crestas y deja oscuros los valles.
    const gain = 0.08 + (sciMode ? 0.04 : 0.057) * ampPattern;
    const mid = 0.06 + (sciMode ? 0.03 : 0.043) * ampPattern;
    // Luz visual, posterior al cálculo del modo y sus líneas nodales.
    const waveLight = movingSurface ? (0.36 + 0.54 * env) * (0.52 + 0.48 * lampPulse) : 0;
    // La onda corta se disipa primero, dejando las ondulaciones anchas.
    const rippleStrength = IDLE_RIPPLE + 0.081 * env;
    const waterVibration = movingSurface ? rippleStrength * (reducedMotion ? 0.62 : 1) : 0;
    const wideRippleGain = 0.70 + 0.30 * env;
    const fineRippleGain = 0.12 + 0.88 * fine;
    const surfaceOptics = movingSurface ? (reducedMotion ? 0.48 : 0.86) : 0;
    const lampDrive = 0.30 + 0.70 * env;
    const lampLight = sciMode ? 0 : lampDrive * (0.23 + 0.77 * lampPulse);

    // Fondo oscuro de la escena (#0b0d12).
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);

    const R = Math.min(w, h) * 0.46; // radio del plato
    const cx = w / 2;
    const cy = h / 2;

    // --- FIX P1: Decouple center drop from binaural beat -------------------
    // BEFORE (architecture violation):
    //   center drop f = beat * (0.5 + complexity)  → beat drives Faraday pattern
    //
    // AFTER (physically grounded):
    //   center drop f = resonant frequency of the dominant eigenmode
    //   for the binaural beat value, using the same dispersion relation
    //   as the other drops. This means the center drop visualizes the
    //   nearest physical resonance to the beat, not the beat itself.
    //   It is a visualization of how the physical system would respond
    //   IF excited near that frequency — a modal metaphor, not a causal claim.
    //
    // NOTE: The binaural beat (Δf) remains the STIMULUS; the visual system
    // maps it to the nearest physical eigenmode. These are distinct quantities.
    // En PURE TONE no hay batido: la gota central se afina a la resonancia
    // de la propia portadora — el plato vibra en un único modo estacionario.
    // FIX (auditoría 2026-09-08, Parte A): este mapeo beat→autovalor
    // (antes inline acá) es exactamente la misma búsqueda de modo que el
    // bucle "PHASE 8" de más abajo, solo con nMax=6 en vez de
    // MAX_RADIAL_MODE. Extraído a core/plate-field.js:resonantModeForBeat()
    // — misma fórmula, mismo resultado, una sola implementación.
    const centerDrive = Math.max(0, rhythmicCond() ? beat : base);
    const beatMode = resonantModeForBeat(centerDrive, PHYS_A);
    const m_beat = beatMode.m;
    const n_beat = beatMode.n;
    const f_center = beatMode.fCenter; // resonant frequency (Hz) of the mode

    this._centerDriveOmega = Math.PI * centerDrive;

    const dropR = R * 0.27;
    const step = dropR * 2.2;
    // PHASE 3: In Scientific Mode use neutral monochrome palette so color is
    // not confused with physical data. In Cinematic Mode use the profile colors.
    const C_SCI_WHITE = [220, 220, 240]; // near-white for scientific clarity
    const sciPals = [C_SCI_WHITE, C_SCI_WHITE, C_SCI_WHITE];
    const dropPals = sciMode ? sciPals : (colors && colors.length === 3 ? colors : [C_CYAN, C_INDIGO, C_CYAN]);
    // NOISE: la turbulencia desentona las gotas — un ligero vaivén de
    // frecuencia alrededor de la portadora rompe el patrón estacionario y
    // las flores se reorganizan continuamente (la estructura se agita).
    const nzW = (i) => 0.5 * Math.sin(t * 7.3 + i * 2.7) + 0.5 * Math.sin(t * 3.1 + i * 5.9);
    const fR = condition === 'noise' ? 1 + 0.04 * nzW(0) : 1;
    const fC = condition === 'noise' ? 1 + 0.04 * nzW(1) : 1;
    const fL = condition === 'noise' ? 1 + 0.04 * nzW(2) : 1;
    const drops = [
      { x: cx - step, f: pBase * fR,                 p0: 0.0, pal: dropPals[0], deep: shadeDeep(dropPals[0]) },
      { x: cx,        f: Math.max(1, f_center) * fC, p0: 2.1, pal: dropPals[1], deep: shadeDeep(dropPals[1]) },
      { x: cx + step, f: (rhythmicCond() ? pBase + beat : pBase) * fL, p0: 4.2, pal: dropPals[2], deep: shadeDeep(dropPals[2]) },
    ];
    // Transición de afinación: cuando cambia la portadora, el latido o la
    // condición (p. ej. binaural → tono puro, que hace f2 = f1), las gotas
    // se afinan GRADUALMENTE con la misma EMA (τ = 1,5 s) que el resto de la
    // física — los modos dominantes se reorganizan poco a poco, sin que el
    // patrón salte de golpe. El ruido conserva su vaivén sobre el valor suave.
    // FIX (2026-09-08, "que la transición sea real"): igual que
    // physicsState.baseFrequency más arriba — arrancar en `pBase` para las
    // tres gotas por igual era otro hueco artificial, en particular para la
    // gota del latido (drops[1]): su objetivo real es `f_center` (el modo
    // resonante del LATIDO, típicamente muy distinto de `pBase`, la
    // portadora), así que arrancaba con el mismo problema — un viaje falso
    // desde `pBase` hasta `f_center` cruzando modos que no son el natural
    // de esa gota. Cada gota arranca ahora en SU propio objetivo real.
    if (!this._dropF) this._dropF = [drops[0].f, drops[1].f, drops[2].f];
    for (let i = 0; i < 3; i++) {
      // FIX (2026-09-28, mismo "eco de cambiar de frecuencia" que
      // physicsState.baseFrequency más arriba): el EMA (τ=1,5s) es el
      // afinado "líquido" correcto MIENTRAS hay una sesión sonando, pero sin
      // reproducción no hay nada que suene todavía — arrastrar el afinado de
      // cada gota con esta misma inercia es lo que hacía que, al recién
      // apretar play después de cambiar de preset en frío, las gotas
      // siguieran "viajando" varios segundos hacia el preset ya elegido en
      // vez de arrancar ya afinadas en él. Sin reproducción, cada gota
      // adopta su objetivo al instante.
      if (playing) {
        this._dropF[i] += (drops[i].f - this._dropF[i]) * emaK;
      } else {
        this._dropF[i] = drops[i].f;
      }
      drops[i].f = Math.max(0.5, this._dropF[i]);
    }
    const n = drops.length;

    // Evolución lenta de los modos: cada modo intercambia peso con los demás
    // a lo largo de minutos (períodos de ~3 a 7 min, desincronizados por
    // gota), como el acoplamiento no lineal de los modos de una placa real.
    // Una segunda onda más rápida (~tens de segundos) reorganiza la forma
    // de forma perceptible: el patrón cambia de silueta y nunca se repite
    // exacto — menos estático, más cimática viva.
    // VISUALIZATION MODEL (not physical): evo() is an artistic amplitude
    // oscillation with no physical derivation. In real cymatics, modal
    // amplitudes are determined by excitation power and damping quality factor Q,
    // not arbitrary sinusoidal envelopes.
    // FIX (2026-09-08, "es inestable" — el patrón nunca quedaba quieto en
    // reposo): esto solo se apagaba en sciMode ("PHASE 3: disabled entirely
    // in Scientific Mode"); en el modo cinematográfico normal seguía
    // oscilando el peso de CADA capa armónica ±42% en ciclos de minutos MÁS
    // ±18% en ciclos de ~30s, indefinidamente, aunque la frecuencia
    // estuviera perfectamente fija — eso es lo que se leía como "sigue
    // cambiando de forma solo". El usuario pidió expresamente que el
    // patrón quede quieto salvo cuando la frecuencia/latido REAL cambian.
    // Se aplica ahora la misma rama neutral que ya usaba sciMode, siempre.
    const evo = (_period, _phase) => 1; // PHYSICAL ONLY: no artistic amplitude modulation

    // Física por gota: cada gota se afina al modo angular (m, n) cuya
    // resonancia cae más cerca de la excitación ω_s = π·f, como se afina un
    // plato cimático (o un cuenco cantor) al tono que lo hace vibrar. El
    // modo dominante produce la flor característica de la cimática real — m
    // pétalos sobre n−1 anillos concéntricos — y cambia con la frecuencia:
    // a más tono, más pétalos y más anillos. La gota central parte del
    // modo más cercano al latido. Varios latidos comparten el mismo modo.
    const mDom = new Array(n);
    const nDom = new Array(n);
    // Peso del modo radial J0 (los anillos concéntricos de fondo).
    const amp0 = new Array(n);
    // Peso y rotación del modo dominante. La rotación de un modo e^{imθ}
    // desafiinado en δ es δ/m: esa es la precesión REAL que se observa en
    // cimática — lenta, con vaivén y dirigida por el signo de δ, no un giro
    // uniforme de reloj (ver rotSpeed más abajo).
    const ampDom = new Array(n);
    const rotDom = new Array(n);
    const phaseDom = new Array(n);
    // Dos modos angulares vecinos (m±1, m±2) para dar textura: su amplitud
    // sigue la resonancia de Lorentz (aportan más cuanto más cerca están de
    // la excitación) pero con un suelo mínimo para que la textura siempre
    // se vea, como las subestructuras que excita la no linealidad real.
    const mS1 = new Array(n);
    const mS2 = new Array(n);
    const ampS1 = new Array(n);
    const ampS2 = new Array(n);
    const rotS1 = new Array(n);
    const rotS2 = new Array(n);
    const phaseS1 = new Array(n);
    const phaseS2 = new Array(n);
    // Modos de detalle mandala (patrones dentro de patrones): el doble, el
    // triple y el cuádruple de pétalos que el dominante. Siempre activos
    // (mientras quepan: 2m/3m ≤ 12, 4m ≤ 16) y con peso reducido a
    // filigrana sutil: dibujan puntas internas dentro de cada pétalo y
    // filigrana en cascada dentro de los anillos — el efecto mandala de la
    // cimática real — pero la flor dominante sigue siendo la que manda y el
    // patrón se lee limpio.
    // PERF (auditoría 2026-11-06, ronda 2): existían capas adicionales 5m/6m
    // (mD4/mD5, ampD4/ampD5, rotD4/rotD5, phaseD4/phaseD5) que se calculaban
    // por gota y por frame pero nunca se leían — ni packGL() (empaqueta solo
    // columnas 0-8,11,12 de rad[]), ni el fallback CPU (suma hasta o+8), ni
    // el shader GLSL (uJ[8]/uM[6] no tienen slot para D4/D5). Eliminadas:
    // bajaban maxM (y por tanto el orden de arranque de la recurrencia de
    // Miller en besselJArray) sin cambiar ningún píxel visible. El stride de
    // la tabla radial se mantiene en 13 columnas (o+9/o+10 quedan en 0, sin
    // usar) para no tener que tocar packGL, que indexa por *13.
    const mD1 = new Array(n);
    const mD2 = new Array(n);
    const mD3 = new Array(n);
    const ampD1 = new Array(n);
    const ampD2 = new Array(n);
    const ampD3 = new Array(n);
    const rotD1 = new Array(n);
    const rotD2 = new Array(n);
    const rotD3 = new Array(n);
    const phaseD1 = new Array(n);
    const phaseD2 = new Array(n);
    const phaseD3 = new Array(n);
    // Componente contrarrotante del modo dominante (degeneración ±m): el
    // batido entre ambos hace que los pétalos se abran y cierren suavemente
    // mientras el patrón gira, como en el agua real.
    const ampBeat = new Array(n);
    const rotBeat = new Array(n);
    const phaseBeat = new Array(n);
    // FIX (2026-09-08, "es inestable" — el patrón nunca quedaba quieto en
    // reposo): esto era una precesión continua del patrón (velocidad ∝ al
    // desafiño δ de cada gota, modulada por `beatFactor`/una heurística
    // `wander` de tres senos incommensurables) que antes solo se apagaba en
    // sciMode — en modo cinematográfico seguía girando el patrón
    // indefinidamente, sumado a evo()/las respiraciones sueltas de más
    // arriba, parte de lo reportado como "sigue cambiando solo". Ahora
    // devuelve 0 siempre — patrón sin precesión salvo que la frecuencia/
    // latido real cambien.
    const rotSpeed = () => 0;
    // Forma de onda real → peso de las capas de detalle mandala (auditoría
    // 2026-08-29): antes cambiar sine↔square no cambiaba nada visualmente.
    // Una cuadrada/sierra tiene más armónicos reales que una senoidal, así
    // que refuerza más la filigrana interna (mD1..mD3); senoidal es la base
    // (1, sin cambio de comportamiento previo).
    const WAVE_RICHNESS = { sine: 1, triangle: 1.15, square: 1.4, sawtooth: 1.45 };
    const waveRichness = WAVE_RICHNESS[wave] || 1;
    for (let i = 0; i < n; i++) {
      const d = drops[i];
      // Ver _heldF en el constructor: la búsqueda de modo y sus amplitudes
      // de detuning usan esta versión con inercia extra de d.f, NUNCA d.f
      // crudo — así el modo no puede saltar más rápido de lo que la textura
      // puede reconstruirse.
      // FIX (2026-09-28, mismo "eco de cambiar de frecuencia" que _dropF y
      // physicsState.baseFrequency): este EMA (τ=1s) corría SIEMPRE, sin
      // gate de `playing` — a diferencia de _dropF/baseFrequency (ya
      // corregidos arriba), _heldF seguía arrastrando el modo desde la
      // frecuencia vieja incluso con el resto del estado ya instantáneo, y
      // era justo lo que el harness determinístico seguía mostrando como
      // fundido espurio al apretar play tras cambiar de preset en frío (esta
      // función corre en CADA frame, aunque el plato esté en "agua en calma"
      // — el atajo barato de más abajo solo evita el rasterizado por
      // píxel). Sin reproducción, el modo se ancla al instante al `d.f` ya
      // snapshotteado, igual que el resto del pipeline.
      if (this._heldF[i] == null || !playing) this._heldF[i] = d.f;
      else this._heldF[i] += (d.f - this._heldF[i]) * (1 - Math.exp(-dt / 1.0));
      const df = this._heldF[i];
      const ws = Math.PI * df; // ω_s = π·f (respuesta subarmónica)
      let m = 2;
      let nn = 1;
      let delta = 0;
      // CANDADO de modo (fix estructural 2026-09-03 — el _heldF de arriba
      // solo retrasa la búsqueda, no la detiene: en un salto grande `df`
      // sigue cruzando varios límites de resonancia MIENTRAS la tabla
      // radial del modo anterior todavía se construye por tramos, así que
      // uM[]/uJ[] (que siguen la búsqueda EN VIVO) terminan describiendo un
      // modo que la textura ya construida no tiene — de ahí el parpadeo/
      // desaparición reportados, no un simple salto. FIX real: mientras haya
      // una construcción sin terminar (buf.pending) O un fundido cruzado en
      // curso (this._morph, ~7s) para esta gota, no perseguir un nuevo
      // objetivo — usar el MISMO modo ya construido/en construcción para
      // todo (radKey, amplitudes, uniformes). Recién cuando la tabla termina
      // Y el fundido anterior también asentó se vuelve a buscar el modo más
      // cercano al `df` de ESE momento. Así cada transición es una sola,
      // completa, en serie con la anterior, y nunca se pisan dos a la vez
      // (que era la otra fuente del mismo desajuste: un segundo objetivo
      // podía empezar a construirse mientras el fundido del primero todavía
      // no terminaba de asentarse) — el patrón se transforma de a un modo
      // por vez, como líquido, en vez de perseguir un objetivo que nunca
      // alcanza.
      const bufI = this._drops[i];
      const morphingI = isMorphActive(this._morph[i], sciMode);
      const lockSrc = bufI && (bufI.pending || (morphingI && bufI.radM != null)) ? (bufI.pending || bufI) : null;
      if (lockSrc) {
        m = lockSrc.mDom != null ? lockSrc.mDom : lockSrc.radM;
        nn = lockSrc.nDom != null ? lockSrc.nDom : lockSrc.radN;
        delta = modeOmega(m, nn, PHYS_A) - ws;
      } else if (i === 1) {
        // La gota del latido toma el modo calculado en beatMode y ajusta
        // su geometría. El latido también modula el brillo y la amplitud.
        // FIX (2026-09-08, "no es estable" / colisionador de frecuencias):
        // esto daba UN paso de ±1 en m y ±1 en nn por ciclo de transición en
        // vez de ir directo a (mTarget, nTarget) — ver la misma nota, mucho
        // más detallada, junto al fix equivalente de la rama de abajo
        // (antes con `modeStepToward`). Mismo defecto aquí: con el candado
        // de modo (lockSrc arriba) sirviendo UN paso por ciclo completo de
        // fundido (no por fotograma), un objetivo a varios pasos de
        // distancia encadenaba una transición tras otra — el patrón nunca
        // paraba de cambiar. Sin motivo para seguir troceando el salto: el
        // fundido cruzado de la Parte B ya relaja la flor vieja y la nueva
        // de forma INDEPENDIENTE (no un cross-dissolve de pesos
        // complementarios), así que ir directo al objetivo no produce el
        // "salto brusco entre dos flores muy distintas" que el paso a paso
        // evitaba originalmente (ver la nota de Parte B en
        // core/plate-field.js, junto a `modeStepToward`, que ya señalaba
        // esto como código potencialmente en desuso).
        m = sciMode ? m_beat : Math.min(5, Math.max(2, 1 + Math.floor(df / 8)));
        nn = sciMode ? n_beat : Math.min(6, ringsFor(df) + 2);
        delta = modeOmega(m, nn, PHYS_A) - ws;
      } else {
        // PHASE 8: Improved mode selection for carrier drops. Primary
        // search: angular modes m ∈ [2, 6] que producen los pétalos
        // característicos de Faraday. Fallback: si el mejor modo m≥2 queda
        // desafinado más de 2·Γ(f), extiende a m=0 (anillos concéntricos) y
        // m=1 (espiral de un brazo) — modos de Bessel físicos reales que
        // aparecen en cimática real a frecuencias muy bajas.
        // FIX (auditoría 2026-09-08, Parte A — "una sola cimática, dos
        // cámaras"): este bucle (y el de FIX P1 más abajo, y el que usaba
        // modeStepToward) reimplementaban la MISMA búsqueda de modo tres
        // veces en este archivo. Extraído a
        // core/plate-field.js:selectModeWithFallback() — una sola
        // implementación que además usarán la vista 3D (Parte D) y el
        // validador cruzado FDTD↔modal (Parte E). Comportamiento idéntico
        // (incluido el MAX_RADIAL_MODE de la auditoría anterior sobre 963 Hz
        // — ver el comentario en plate-field.js).
        const found = selectModeWithFallback(ws, PHYS_A, df, sciMode
          ? { resonanceWidth: viscousDecayRate(faradayWavenumber(df)) }
          : undefined);
        // FEATURE (2026-09-08, "hagamos que se interpole" — pedido tras "va
        // bien y luego salta"/"también salta al solo reproducir un
        // preset"): si ya hay un camino de resonancias en cola para esta
        // gota (armado la vez anterior que se detectó un salto grande), el
        // siguiente ciclo de fundido saca el PRÓXIMO waypoint en vez de
        // volver a buscar desde cero — así el patrón pasa de verdad por
        // cada resonancia real en el camino, una transición completa por
        // waypoint, en vez de un solo salto grande entre el modo viejo y el
        // final. Si la cola está vacía Y el objetivo recién encontrado está
        // lejos del modo asentado, se arma el camino ahora (ver
        // `_computeModeWaypoints`) y se consume el primer paso ya mismo.
        const curI = this._curMode[i];
        // FIX (2026-09-12, "al poner una frecuencia sola... se volvió
        // errática" — cambia de forma sola bastante después de haber
        // dejado de tocar nada): la cola de waypoints se drenaba siempre
        // que tuviera algo, SIN mirar si `found` (el objetivo real para el
        // `df` de AHORA) seguía siendo el mismo objetivo con el que se armó
        // la cola. Si el usuario cambiaba de frecuencia otra vez mientras
        // un barrido anterior todavía estaba a mitad de camino, el código
        // seguía persiguiendo el objetivo VIEJO y abandonado hasta drenar
        // toda la cola — recién ahí notaba el objetivo nuevo. Con varios
        // pasos en cola (cada uno con su propia construcción+fundido, unos
        // segundos cada uno), eso significa varios cambios de forma
        // "espontáneos" bastante después de la última interacción real,
        // persiguiendo una frecuencia que el usuario ya había dejado atrás.
        // Fix: si el último paso de la cola ya no coincide con `found`, la
        // cola quedó obsoleta — se descarta y se recalcula fresco contra
        // el objetivo real de este fotograma.
        if (this._waypointQueue[i].length) {
          const last = this._waypointQueue[i][this._waypointQueue[i].length - 1];
          if (last.m !== found.m || last.n !== found.n) {
            this._waypointQueue[i] = [];
          }
        }
        if (this._waypointQueue[i].length) {
          const wp = this._waypointQueue[i].shift();
          m = wp.m;
          nn = wp.n;
        } else if (
          curI &&
          Math.abs(curI.m - found.m) + Math.abs(curI.n - found.n) >= WAYPOINT_MODE_DIST_MIN
        ) {
          const path = this._computeModeWaypoints(curI.m, curI.n, found.m, found.n);
          const first = path.shift();
          m = first.m;
          nn = first.n;
          this._waypointQueue[i] = path;
        } else {
          m = found.m;
          nn = found.n;
        }
        delta = modeOmega(m, nn, PHYS_A) - ws;
        // FIX (2026-09-08, "no es estable" / colisionador de frecuencias):
        // esto daba UN solo paso hacia el objetivo (`modeStepToward`) en vez
        // de comprometerlo directo — con una portadora aguda (ej. 963 Hz) el
        // objetivo real puede estar a n≈17 mientras el modo asentado ronda
        // n≈6: UN paso por transición completa, con el candado de modo
        // arriba sirviendo un paso por CICLO (no por fotograma, cada ciclo
        // dura toda la construcción + el fundido), significaba encadenar
        // ~10-30 transiciones sucesivas — medido con un harness que
        // reproduce esta máquina de estados fuera del navegador: para
        // df=963 nunca convergía en 60s simulados, seguía cambiando de modo
        // cada ~4s indefinidamente. Ese es el "no es estable"/"sigue
        // cambiando solo" reportado, no un artefacto del harness. El
        // step-por-transición era un remanente del sistema de fundido
        // cruzado ANTERIOR a la Parte B (cross-dissolve de pesos
        // complementarios, donde saltar directo entre dos flores muy
        // distintas se leía como un corte) — la propia nota de Parte B junto
        // a `modeStepToward` en core/plate-field.js ya señalaba que, con la
        // relajación física independiente (oldW/newW ya no complementarios),
        // esta función podía haber quedado sin motivo real ("código
        // potencialmente muerto a revisar"). Confirmado: sin ella, el salto
        // se ve como una única recomposición (la flor vieja se apaga, la
        // nueva crece, ambas se superponen durante el fundido) en vez de una
        // cadena de saltos intermedios que nunca para.
      }
      mDom[i] = m;
      nDom[i] = nn;
      // Los patrones pequeños (pocos pétalos, como el latido de
      // concentración) ganan riqueza interna: cuanto menor es m, más peso
      // llevan las capas de detalle mandala (2m/3m/4m…) para que la flor
      // se lea definida y llena, nunca un dibujo escueto y desdibujado.
      const rich = (1 + (6 - Math.min(6, m)) * 0.15) * waveRichness;
      // La filigrana responde al latido: en cada pulso el detalle mandala
      // surge (los pétalos se llenan de subestructura) y entre latidos se
      // retira — la ESTRUCTURA varía con el sonido, no solo el brillo.
      // Modulated by coherence: high coherence -> structured pulses, low coherence -> chaotic
      // FIX (2026-09-12, "sigue titilando"): rango pico/valle bajado de 2.64x
      // a 1.67x — el detalle sigue surgiendo/retirándose con el latido real
      // (mismo pulseEff, sin tocar el timing), solo con menos contraste.
      const detailPulse = (0.75 + 0.5 * pulseEff) * (0.5 + coherence);
      // Anillos de fondo siempre presentes y con peso alto: son los que
      // definen la estructura de los patrones simples, y respiran.
      // PHASE 3 (cierre de deuda de sciMode): la respiración senoidal de
      // abajo es la misma heurística visual que evo() ya apaga en otros
      // lados — vivía suelta acá, fuera de evo(), y por eso sobrevivía en
      // modo científico. Gateada igual que el resto.
      // FIX (2026-09-08, "es inestable"): la respiración senoidal suelta de
      // acá (fuera de evo(), por eso sobrevivía a su neutralización) ya
      // estaba gateada a 1 en sciMode; ahora siempre. `coherence` se
      // conserva — responde al estado real de audio/sesión, no es
      // vagabundeo artístico inventado.
      amp0[i] = sciMode ? 0 : 0.8 * coherence;
      // La flor dominante es la protagonista: peso máximo para que el
      // patrón se lea limpio y definido. Las capas de detalle mandala
      // (2m/3m/4m…) quedan como filigrana sutil dentro de los pétalos, sin
      // recargar el conjunto. Su amplitud respira (la flor crece y se
      // encoge) y los vecinos se mueven en contrafase: la forma varía y
      // oscila continuamente, como ondas que chocan y se reorganizan.
      // La vista científica normaliza la forma para que los nodos sigan
      // visibles. La respuesta a la excitación se lee por separado en el HUD.
      ampDom[i] = evo(240, d.p0 * 1.1);
      // Precesión integrada: la fase ya incluye la evolución temporal.
      // NOISE: precesión turbulenta — las flores se agitan sin rumbo fijo
      // (heurística visual, apagada en sciMode igual que rotSpeed()).
      rotDom[i] = this._rotPhase[i * 9 + 0] + (!sciMode && condition === 'noise' ? 0.35 * Math.sin(t * 11.3 + d.p0 * 3.1) + 0.25 * Math.sin(t * 17.7 + d.p0 * 7.7) : 0);
      phaseDom[i] = d.p0 * 1.3;
      // Modos secundarios: los dos vecinos angulares más cercanos en
      // resonancia (dentro de m±2), con amplitud de Lorentz y suelo mínimo.
      const cands = [];
      for (let dm = -2; dm <= 2; dm++) {
        const mm = m + dm;
        if (dm === 0 || mm < 1 || mm > 6) continue;
        cands.push({ mm, dd: Math.abs(modeOmega(mm, nn, PHYS_A) - ws) });
      }
      cands.sort((a, b) => a.dd - b.dd);
      const s1 = cands[0];
      const s2 = cands.length > 1 ? cands[1] : cands[0];
      mS1[i] = s1.mm;
      mS2[i] = s2.mm;
      const d1 = modeOmega(s1.mm, nn, PHYS_A) - ws;
      const d2 = modeOmega(s2.mm, nn, PHYS_A) - ws;
      // Vecinos casi resonantes: con un suelo más alto, a veces la flor
      // vecina (m±1) se acerca a la dominante y la silueta gana/pieree
      // pétalos de forma gradual — como cuando el plato real cae entre dos
      // resonancias y el patrón se reorganiza.
      // PHASE 8: Pass drop frequency to lorentz() so Γ is frequency-dependent.
      // FIX (2026-09-08, "es inestable"): mismo caso que ampDom — el factor
      // de contrafase/respiración vivía fuera de evo(), ya gateado a 1 en
      // sciMode; ahora siempre.
      // Estas capas reutilizan la raíz radial del modo principal. Solo
      // ese modo satisface J'_m(z)=0 con la raíz usada en la tabla.
      ampS1[i] = sciMode ? 0 : (0.16 + 0.26 * lorentz(d1, df)) * evo(170, d.p0 * 1.6);
      ampS2[i] = sciMode ? 0 : (0.1 + 0.18 * lorentz(d2, df)) * evo(300, d.p0 * 2.2);
      rotS1[i] = this._rotPhase[i * 9 + 1];
      rotS2[i] = this._rotPhase[i * 9 + 2];
      phaseS1[i] = d.p0 * 1.7;
      phaseS2[i] = d.p0 * 2.1;
      // Modos de detalle mandala: 2m y 3m pétalos sobre los mismos anillos.
      // Cada uno integra su propia precesión (lenta y con deriva propia):
      // la filigrana interna se desliza despacio dentro de los pétalos, sin
      // girar en bloque con la flor, y su amplitud tiene suelo visible (la
      // resonancia solo la matiza).
      // VISUALIZATION MODEL (not physical): mD harmonic layers use multiples
      // of the dominant angular mode (2m, 3m, 4m, 5m, 6m). In real non-linear
      // cymatics, higher harmonics ARE excited when the system is driven beyond
      // the linear regime, but the specific multiples and their relative amplitudes
      // here are not derived from a non-linear model — they are heuristic choices
      // that produce a mandala-like visual effect. They are kept as an explicit
      // artistic layer within the physics-visualization pipeline.
      const m2 = m * 2 <= 12 ? m * 2 : -1;
      const m3 = m * 3 <= 12 ? m * 3 : -1;
      mD1[i] = m2;
      mD2[i] = m3;
      // LIMITACIÓN CONOCIDA (documentada en la auditoría 2026-11-09, NO
      // corregida acá a propósito — cambiar el comportamiento es una decisión
      // de diseño visual, no un fix numérico): con m = 0 (modo de anillos
      // concéntricos, el fallback de selectModeWithFallback en plate-field.js)
      // se tiene m2 = m3 = m4 = 0, así que este gate y los dos análogos de
      // abajo (3m, 4m) NUNCA pasan y las TRES capas de filigrana quedan en 0.
      // El resultado es un "bullseye pelado": anillos concéntricos limpios sin
      // ningún detalle de mandala encima. No es raro ni marginal: medido sobre
      // la llamada real (targetOmega = π·f, 60-1000 Hz cada 0,1 Hz), m = 0 sale
      // elegido en ~10,96% de las frecuencias del rango de la app — p. ej.
      // 530 Hz → (m=0, n=11) y 1000 Hz → (m=0, n=17). (m = 1 NO tiene el
      // problema: ahí m2/m3/m4 = 2/3/4 y la filigrana entra normal.) Si algún
      // día se decide darle filigrana al bullseye, el camino no es relajar el
      // gate a `>= 0` —eso pondría 0 pétalos, o sea nada— sino elegir
      // explícitamente un m de detalle no nulo para el caso m = 0.
      if (m2 >= 1 && !sciMode) {
        // Capa 2m (el doble de pétalos): filigrana sutil (~¼ del peso de la
        // flor) que dibuja puntas internas sin competir con la flor.
        // PHASE 8: Pass drop frequency to lorentz() for frequency-dependent Γ.
        ampD1[i] = (0.16 + 0.06 * lorentz(modeOmega(m2, nn, PHYS_A) - ws, df)) * evo(200, d.p0 * 2.7) * rich * detailPulse;
        rotD1[i] = this._rotPhase[i * 9 + 3];
        phaseD1[i] = d.p0 * 2.6 + 0.5;
      } else {
        ampD1[i] = 0;
        rotD1[i] = 0;
        phaseD1[i] = 0;
      }
      if (m3 >= 1 && !sciMode) {
        // Capa 3m (el triple de pétalos): filigrana fina de tercer nivel,
        // discreta, para no recargar la flor.
        ampD2[i] = (0.1 + 0.045 * lorentz(modeOmega(m3, nn, PHYS_A) - ws, df)) * evo(260, d.p0 * 3.3) * rich * detailPulse;
        rotD2[i] = this._rotPhase[i * 9 + 4];
        phaseD2[i] = d.p0 * 3.1 + 1.1;
      } else {
        ampD2[i] = 0;
        rotD2[i] = 0;
        phaseD2[i] = 0;
      }
      // Capa 4m (el cuádruple de pétalos): filigrana de cuarto nivel, muy
      // fina, que solo asoma en los anillos exteriores.
      const m4 = m * 4 <= 16 ? m * 4 : -1;
      mD3[i] = m4;
      if (m4 >= 1 && !sciMode) {
        ampD3[i] = (0.055 + 0.03 * lorentz(modeOmega(m4, nn, PHYS_A) - ws, df)) * evo(330, d.p0 * 3.8) * rich * detailPulse;
        rotD3[i] = this._rotPhase[i * 9 + 5];
        phaseD3[i] = d.p0 * 3.6 + 1.6;
      } else {
        ampD3[i] = 0;
        rotD3[i] = 0;
        phaseD3[i] = 0;
      }
      // Batido de la flor: componente con el mismo m que la dominante pero
      // girando en sentido opuesto (degeneración ±m): los pétalos se abren
      // y cierran de forma bien visible, con oleadas lentas — la
      // respiración crece y mengua, no es un latido constante — como el
      // batido real entre modos casi degenerados que va y viene.
      // FIX (2026-09-08, "es inestable"): mismo caso que amp0/ampDom — el
      // seno suelto (período ~14s, fuera del alcance de evo()) ya se
      // apagaba en sciMode; ahora siempre.
      ampBeat[i] = 0;
      rotBeat[i] = this._rotPhase[i * 9 + 8];
      phaseBeat[i] = d.p0 * 1.9 + 0.7;

      // ----- Integración de la precesión --------------------------------
      // Cada modo suma su propia velocidad angular (lenta, con deriva que
      // cruza por cero) a su fase acumulada; en el primer fotograma se
      // siembra cada fase con su semilla para que las tres gotas y cada
      // capa arranquen desfasadas — sin sincronía entre sí.
      const L = i * 9;
      if (!this._rotSeeded) {
        this._rotPhase[L + 0] = d.p0 * 1.3;
        this._rotPhase[L + 1] = d.p0 * 1.7;
        this._rotPhase[L + 2] = d.p0 * 2.1;
        this._rotPhase[L + 3] = d.p0 * 2.6 + 0.5;
        this._rotPhase[L + 4] = d.p0 * 3.1 + 1.1;
        this._rotPhase[L + 5] = d.p0 * 3.6 + 1.6;
        this._rotPhase[L + 6] = d.p0 * 4.1 + 2.0;
        this._rotPhase[L + 7] = d.p0 * 4.6 + 2.4;
        this._rotPhase[L + 8] = d.p0 * 1.9 + 0.7;
      }
      this._rotPhase[L + 0] += rotSpeed(delta, d.p0 * 1.3) * alive * dt;
      this._rotPhase[L + 1] += rotSpeed(d1, d.p0 * 1.7) * alive * dt;
      this._rotPhase[L + 2] += rotSpeed(d2, d.p0 * 2.1) * alive * dt;
      this._rotPhase[L + 3] += rotSpeed(delta, d.p0 * 2.6) * alive * dt;
      this._rotPhase[L + 4] += rotSpeed(delta, d.p0 * 3.1) * alive * dt;
      this._rotPhase[L + 5] += rotSpeed(delta, d.p0 * 3.6) * alive * dt;
      this._rotPhase[L + 6] += rotSpeed(delta, d.p0 * 4.1) * alive * dt;
      this._rotPhase[L + 7] += rotSpeed(delta, d.p0 * 4.6) * alive * dt;
      // La contrarrotante (±m) integra su propia fase a media velocidad:
      // los pétalos abren y cierran suavemente mientras el patrón deriva.
      this._rotPhase[L + 8] += -0.5 * rotSpeed(delta, d.p0 * 1.9) * alive * dt;
    }
    this._rotSeeded = true;
    // La línea de contacto queda fija; el relieve oscila dentro del borde.
    const waterBoundary = movingSurface ? 0.97 : 1;
    // Oscilación natural: cada modo tiembla a su propio ritmo (shimmer
    // desincronizado, como el batido real entre modos casi degenerados) y
    // las ondas radiales —estacionaria + viajera— hacen ondular los
    // anillos hacia dentro y hacia fuera de forma visible: el agua se ve
    // vibrar en lugar de un patrón fijo. En pausa todo se atenúa con alive.
    const shim0 = new Array(n);
    const shimDom = new Array(n);
    const shimS1 = new Array(n);
    const shimS2 = new Array(n);
    const shimD1 = new Array(n);
    const shimD2 = new Array(n);
    const shimD3 = new Array(n);
    const shimBeat = new Array(n);
    for (let i = 0; i < n; i++) {
      // Vibración viva: cada modo tiembla a su propio ritmo con dos
      // frecuencias desincronizadas (las líneas nodales se mueven y el
      // patrón oscila, pero siguen nítidas porque se redibujan cada
      // fotograma — el agua vibra, no se difumina).
      // FIX (2026-09-08, "es inestable" — parpadeo reportado): shim* es
      // puramente heurístico (senos con frecuencias/fases elegidas a ojo,
      // sin relación con ninguna ecuación de movimiento) y hasta este fix
      // solo se gateaba a 1 en sciMode — en cinematográfico este temblor
      // fino (períodos de ~0,8 a 3s) seguía activo siempre, contribuyendo
      // al parpadeo/destello reportado. Gateado a 1 (sin temblor) siempre,
      // igual que evo().
      shim0[i] = 1;
      shimDom[i] = 1;
      shimS1[i] = 1;
      shimS2[i] = 1;
      shimD1[i] = 1;
      shimD2[i] = 1;
      shimD3[i] = 1;
      shimBeat[i] = 1;
    }
    // Amplitud general: el patrón brilla con el latido real (pulseEff) y
    // con la energía de la vibración (umbral de Faraday). El suelo se fija
    // al 60 % para que el patrón no se apague entre latidos — las líneas
    // nodales se leen siempre nítidas, sin parpadeo difuso — y cada pulso
    // se ve como una oleada de brillo que recorre el agua; en pausa
    // (pulseEff = 0.5) la amplitud queda estable.
    const amp = (0.6 + 0.4 * pulseEff) * ampPattern;
    // FIX (2026-09-08, "es inestable"): esta oleada global de brillo
    // (período ~11s, ±16%, sin gateo de sciMode) mismo caso que evo()/
    // shim*/rip* — un vagabundeo continuo sin ligarse a ningún evento real.
    // Neutralizada.
    const swell = 1;

    // ----- Plato: gradiente oscuro + borde -------------------------------
    const dish = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R);
    dish.addColorStop(0, '#0e1a30');
    dish.addColorStop(0.7, '#0a1220');
    dish.addColorStop(1, '#05070d');
    ctx.fillStyle = dish;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TWO_PI);
    ctx.fill();
    // Luz cenital sobre el plato: un reflejo suave y amplio que le da
    // profundidad de agua bajo un foco, sin robar protagonismo al patrón.
    const sheen = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.85);
    sheen.addColorStop(0, 'rgba(125, 175, 255, 0.08)');
    sheen.addColorStop(0.45, 'rgba(125, 175, 255, 0.025)');
    sheen.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.85, 0, TWO_PI);
    ctx.fill();
    if (lampLight > 0.02) {
      const spillX = cx + Math.sin(lampSweep) * R * 0.64;
      const spillY = cy - 0.77 * R;
      const spread = ctx.createRadialGradient(spillX, spillY, 0, spillX, spillY, 1.13 * R);
      spread.addColorStop(0, lampTint ? lampInk(lampTint, 0.25 * lampLight) : `rgba(163,219,255,${0.25 * lampLight})`);
      spread.addColorStop(0.52, lampTint ? lampInk(lampTint, 0.10 * lampLight) : `rgba(105,173,251,${0.10 * lampLight})`);
      spread.addColorStop(1, 'rgba(105,173,251,0)');
      ctx.fillStyle = spread;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TWO_PI);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.1)';
    ctx.lineWidth = Math.max(1, R * 0.006);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TWO_PI);
    ctx.stroke();

    // ----- Gotas: cada una en su propio buffer de alta resolución --------
    // En la ruta GPU las tres gotas comparten un lienzo con franjas transparentes,
    // así que todas usan la misma resolución (la mayor que necesiten).
    const buildingDrop = this._drops.some((drop) => drop.pending);
    const transitioning = this._morph.some(Boolean);
    let glResAll = 0;
    let glStride = 0;
    let drewAtlas = false;
    if (this._gl) {
      let maxNeed = 0;
      for (let i = 0; i < n; i++) {
        maxNeed = Math.max(maxNeed, Math.max(nDom[i] * 16, dropR * 2));
      }
      glResAll = dropResolution(maxNeed * this._resMul, this._glRes, buildingDrop || transitioning);
      // FIX (2026-09-12, "apagón" tras varios cambios de frecuencia seguidos
      // y rápidos — ej. arrastrar el slider): `glResAll` se recalcula cada
      // fotograma a partir del `nDom` que se está BUSCANDO ahora mismo (no
      // el último confirmado), así que puede seguir creciendo fotograma a
      // fotograma mientras la búsqueda de modo todavía no se asienta —
      // típico durante un arrastre rápido, donde cada paso reinicia la
      // construcción por tramos antes de que la anterior termine (ver
      // `radKey !== buf.pending.key` más abajo). Redimensionar el lienzo GL
      // solo ocurría en `_uploadDropGL`, cuando ALGÚN drop terminaba su
      // construcción — si ninguno llega a terminar antes de que `glResAll`
      // vuelva a crecer, el `gl.viewport(i*resD, 0, resD, resD)` de más
      // abajo (que usa el `resD` FRESCO de este mismo fotograma) dibuja más
      // alto que el lienzo real todavía sin agrandar — recortando la mitad
      // inferior de cada gota (visto en vivo: un "medio círculo" que luego
      // se completa solo). Redimensionar acá, ANTES del loop de dibujo, para
      // que el lienzo real SIEMPRE tenga el tamaño que el resto del
      // fotograma va a asumir — nunca vaya por detrás.
      glStride = Math.round(glResAll * 1.1);
      if (glResAll !== this._glRes) {
        this._glRes = glResAll;
        this._gl.canvas.width = glStride * 2 + glResAll;
        this._gl.canvas.height = glResAll;

        // FIX (2026-09-12, "sigue pasando en ciertos puntos de la
        // transición" — regresión del fix anterior): al escribir el fix de
        // arriba copié del código viejo de `_uploadDropGL` la costumbre de
        // cancelar cualquier fundido en curso (`_releaseMorphTex` + null)
        // cada vez que cambia la resolución — ahí tenía sentido porque ESE
        // código a continuación BORRABA las texturas viejas de las que un
        // fundido dependía (`texAold/texBold/texCold`), y había que soltar
        // la referencia antes de borrar el objeto GL. Acá arriba NO se borra
        // ninguna textura — solo se redimensiona el lienzo compartido. Y
        // `glResAll` no cambia solo cuando cambia el modo de alguna gota:
        // `_resMul` (el escalador adaptativo de calidad, más abajo,
        // `_frameEMA`) se ajusta ±1,5%/fotograma cada vez que el fotograma
        // anterior quedó fuera de la banda de rendimiento objetivo — algo
        // que pasa seguido bajo carga (ej. justo durante una transición
        // grande, con más detalle mandala dibujándose). Cada vez que ese
        // ajuste cruzaba un entero de `Math.round(maxNeed*_resMul)`,
        // `glResAll` cambiaba en ±1 SIN que ningún modo hubiera cambiado —
        // y este bloque cancelaba el fundido en curso en cada uno de esos
        // frames, produciendo un corte duro (salta de golpe al 100% de la
        // flor nueva) exactamente "en ciertos puntos" de una transición
        // larga, no al principio ni al final. Cancelar acá ya no hace
        // falta: ninguna textura de la que dependa un fundido se toca en
        // este bloque, así que el fundido puede seguir su curso normal
        // aunque el lienzo cambie de tamaño bajo él (misma razón por la que
        // el fix de "sigue titilando" tampoco necesitó tocar texturas
        // ajenas: el shader arma la UV con `uRes` normalizado).
      }
    }
    // El silencio experimental y la vista estática pueden llegar al reposo
    // completo. Una lente quieta basta cuando ya no queda un modo visible.
    const anyMorph = this._morph.some((morph) => isMorphActive(morph, sciMode));
    if (!movingSurface && ampPattern < 0.02 && !anyMorph) {
      for (const d of drops) {
        const lg = ctx.createRadialGradient(d.x, cy, 0, d.x, cy, dropR);
        lg.addColorStop(0, `rgba(${d.deep[0]}, ${d.deep[1]}, ${d.deep[2]}, 0.3)`);
        lg.addColorStop(0.75, `rgba(${d.deep[0]}, ${d.deep[1]}, ${d.deep[2]}, 0.12)`);
        lg.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(d.x, cy, dropR, 0, TWO_PI);
        ctx.fill();
      }
      // Al volver a sonar, el primer fotograma con patrón captura la
      // instantánea actual (sin intentar fundir desde un estado antiguo).
      // FIX (2026-09-28, "eco de cambiar de frecuencia"): antes solo se
      // limpiaba _lastKey acá — _lastP (el patrón que el fundido cruzado usa
      // como "viejo") seguía apuntando al último patrón REALMENTE renderizado
      // antes de entrar en calma, que puede ser de una sesión o preset
      // totalmente distinto (repro confirmado: jugar preset A, parar, cambiar
      // a preset B en frío, volver a jugar — el primer fundido de la sesión
      // nueva arrancaba desde A, un eco real del preset viejo, en vez de
      // capturar B de una sin fundir nada). Limpiar también _lastP hace que
      // el próximo modo se capture directo — exactamente lo que este
      // comentario ya decía que debía pasar.
      for (let i = 0; i < n; i++) { this._lastKey[i] = ''; this._lastP[i] = null; }
    } else {
    if (this._gl) this._gl.gl.clear(this._gl.gl.COLOR_BUFFER_BIT);
    for (let i = 0; i < n; i++) {
      const d = drops[i];
      // Resolución de la gota: mayor que antes (≈1,4× el radio dibujado y
      // 14 px por anillo) para que las líneas nodales finas salgan nítidas
      // al escalar, sin el desenfoque del suavizado. Tope de 192 px para
      // mantener 60 FPS también en móvil.
      // Resolución del buffer: el búfer cubre TODO el diámetro de la gota
      // (se dibuja a 2·dropR), así que para escalar 1:1 necesita al menos
      // 2·dropR píxeles — antes se escalaba ~2× y las líneas nodales
      // salían difuminadas, sobre todo en los patrones pequeños. Tope 320
      // para mantener 60 FPS también en móvil.
      // Resolución del buffer con ajuste adaptativo: _resMul baja si el
      // dispositivo va lento (se mide el fotograma) y sube si sobra tiempo.
      const buf = this._drops[i];
      const resD = this._gl
        ? glResAll
        : Math.min(CPU_DROP_RESOLUTION_LIMIT,
          dropResolution(Math.max(nDom[i] * 16, dropR * 2) * this._resMul, buf.res, buf.pending || this._morph[i]));
      this._ensureDrop(buf, resD);
      // Si cambió el tamaño del búfer a mitad de una transición (p. ej. al
      // redimensionar la ventana), se descarta la transición: la tabla de la
      // flor anterior se construyó para otra resolución y no encajaría.
      if (!this._gl && this._morph[i] && this._morph[i].p.res !== resD) {
        this._releaseMorphTex(i);
        this._morph[i] = null;
      }
      // Granulometría propia del plato: mezcla de sal y grano capilar
      // (constante por gota, derivada de su índice).
      const tex = GRAIN_SETS[i % GRAIN_SETS.length];
      const ddata = buf.img.data;
      const half = resD / 2;
      const rim = half * 0.025; // borde suave y fino (gota definida)

      // Tabla radial estática por gota: r, θ y las Bessel del patrón son
      // independientes del tiempo (solo rotan las fases angulares), así que
      // se calculan una sola vez por (resolución, modo) y por fotograma el
      // bucle solo evalúa los cosenos — con esto se puede subir la
      // resolución del buffer (nitidez) sin perder 60 FPS.
      // FIX (auditoría 2026-09-08, hallado al mover esto a plate-field.js):
      // esto indexaba ZP_BY_M directo en vez de pasar por zeroFor(). La
      // tabla solo tiene 10 filas por columna; desde que MAX_RADIAL_MODE
      // subió a 24 (auditoría anterior, fix del preset 963 Hz) la búsqueda
      // de modo SÍ puede devolver n>10 para portadoras agudas (963 Hz
      // eligió m=2,n=17 — medido en esa misma auditoría), y este acceso
      // directo daba `undefined` → argScale = NaN → tabla radial entera
      // rota (NaN se propaga a todos los cosenos) para esa gota. zeroFor()
      // ya tiene el fallback de McMahon para n>10; esto simplemente no lo
      // usaba.
      const argScale = zeroFor(mDom[i], nDom[i]) / half;
      // La clave de caché incluye TODOS los modos almacenados: dos estados
      // pueden compartir el modo dominante (m, n) — y por tanto argScale —
      // pero tener vecinos o detalles distintos, y entonces la tabla radial
      // quedaría obsoleta (columnas de otro modo).
      const radKey = `${argScale}|${mDom[i]}|${mS1[i]}|${mS2[i]}|${mD1[i]}|${mD2[i]}|${mD3[i]}`;
      // Transición al cambiar de frecuencia: si la clave del modo cambió
      // respecto al fotograma anterior (p. ej. al elegir otro estado, o al
      // mover el latido), la flor anterior — que YA está renderizada en
      // buf.rad — se mueve a la transición sin recalcular nada (cero coste)
      // y el nuevo modo se construye por tramos. El cambio es gradual: la
      // flor vieja se desvanece MIENTRAS la nueva se despliega (fundido
      // cruzado), la placa se reordena con una oleada y la nueva se
      // asienta — sin saltos, sin parpadeos ni vacíos.
      if (radKey !== this._lastKey[i]) {
        const lp = this._lastP[i];
        // FIX (Parte B): "sigue en transición" ya no es `.b > 0` (duración
        // fija) — ver morphingI arriba, mismo criterio.
        const alreadyMorphing = isMorphActive(this._morph[i], sciMode);
        if (lp && lp.res === resD && !alreadyMorphing) {
          const gd = this._gl ? this._glDrops[i] : null;
          // FIX (Parte B): cada flor relaja con SU PROPIO τ, derivado de la
          // frecuencia de resonancia física de su propio modo (m, n) — no de
          // `df`/`heldF` (la excitación), que es la misma para las dos y no
          // distinguiría sus tiempos de decaimiento. τ = MORPH_BLEND_K/γ(fCentro):
          // ver la nota de MORPH_BLEND_K en plate-field.js — sin ningún factor
          // de blend, γ (6-25 rad/s, real de una onda capilar en agua) da
          // τ≈0,04-0,17s, un salto casi instantáneo en vez de una mezcla.
          // FIX (2026-09-08, "colisionador de frecuencias"): esto usaba
          // SLOWMO_K (330, el factor de CÁMARA LENTA de una oscilación
          // visible, ver Parte D) en vez de MORPH_BLEND_K (10) — un fundido
          // cruzado no envuelve ninguna oscilación, así que no le corresponde
          // ese factor (mismo criterio que ya usa el suavizado de volumen más
          // abajo). Con SLOWMO_K el peor caso llegaba a ~220s con el modo
          // BLOQUEADO todo ese tiempo (ver MAX_MORPH_AGE_S arriba) — de ahí
          // el reporte de transiciones que se sienten congeladas y después
          // saltan de golpe.
          const rateOld = morphRate(lp.mDom, lp.nDom, sciMode);
          const rateNew = morphRate(mDom[i], nDom[i], sciMode);
          // FIX (2026-09-08, "va bien y luego salta" / "se queda pegado y
          // después salta de golpe" — reportado específicamente para saltos
          // GRANDES de frecuencia): el τ de arriba solo depende de la
          // frecuencia resonante de cada modo (gammaAt), nunca de cuán
          // DISTINTOS son el modo viejo y el nuevo. Un salto grande (ej.
          // 190→963 Hz) no se resuelve en un solo paso — el candado de modo
          // sirve un paso por ciclo de fundido, y como `_heldF` (τ=1s) suele
          // llegar a su objetivo final ANTES de que el primer fundido
          // (τ hasta ~1,7s, ~6,7s para asentar del todo) termine de soltar
          // el candado, el segundo paso ya encuentra el objetivo REAL, muy
          // lejos del primer paso intermedio — un salto de m/n grande
          // (medido en vivo: n=5→n=17) que, aunque técnicamente se funde
          // igual de "suave" que cualquier otro, cambia tanto la silueta que
          // se lee como un salto en vez de una reorganización. `distScale`
          // alarga el fundido en proporción a cuánto cambia el modo (m, n)
          // — un cambio grande de forma se ve reorganizarse durante más
          // tiempo, en vez de comprimirse en la misma duración que un
          // cambio chico. Acotado a 3× para no repetir el error de
          // SLOWMO_K (un fundido sin techo real).
          const modeDist = Math.abs(lp.mDom - mDom[i]) + Math.abs(lp.nDom - nDom[i]);
          const distScale = 1 + Math.min(MORPH_DIST_SCALE_MAX - 1, modeDist * 0.15);
          this._morph[i] = {
            oldW: 1,
            newW: 0,
            tauOld: (MORPH_BLEND_K * distScale) / rateOld,
            tauNew: (MORPH_BLEND_K * distScale) / rateNew,
            age: 0,
            p: lp,
            radP: buf.rad,
            // Texturas de la flor anterior para el fundido cruzado en GPU:
            // la J0 vieja se captura AQUÍ (al arrancar el fundido), para que
            // la flor que se desvanece conserve sus anillos durante toda la
            // transición, incluso mientras la tabla nueva se construye.
            texAold: gd ? gd.texA : null,
            texBold: gd ? gd.texB : null,
            texCold: gd ? gd.texC : null,
          };
        }
        this._lastKey[i] = radKey;
      }
      // Instantánea del patrón de este fotograma: si el modo cambia en el
      // próximo, esta instantánea se convierte en la flor que se desvanece.
      // FIX (2026-09-08, "no se ve la metamorfosis"/"corte instantáneo, sin
      // mezcla" — confirmado con introspección en vivo, `_morph[i].oldW`
      // quedaba en NaN desde el primer fotograma de CADA transición): a esta
      // instantánea le faltaba `nDom` — solo se guardaba `mDom`. Más abajo,
      // `fCenterOld = modeOmega(lp.mDom, lp.nDom, PHYS_A)` recibía
      // `lp.nDom === undefined`, así que `fCenterOld` daba NaN, `tauOld`
      // (MORPH_BLEND_K/gammaAt(fCenterOld)) daba NaN, y `oldW` se corrompía a
      // NaN en la primera actualización de CADA fundido. `NaN > 0.02` es
      // siempre falso en el shader (uOldW) — la flor VIEJA dejaba de aportar
      // nada desde el instante cero, así que nunca se veía mezclada con la
      // nueva: la "flor nueva creciendo sola" se percibía como un corte
      // duro, no como el agua reorganizándose. Además `NaN > 0.02` también
      // es falso en `alreadyMorphing` (candado de modo), así que el candado
      // quedaba roto tras la PRIMERA transición de cada gota — de ahí
      // también los reinicios de fundido encadenados cada ~2s medidos en
      // vivo. Con `nDom` presente, `oldW` decae normal (1→0 en su propio τ)
      // y el candado vuelve a funcionar.
      this._lastP[i] = {
        res: resD,
        p0: d.p0,
        argScale,
        mDom: mDom[i],
        nDom: nDom[i],
        mS1: mS1[i],
        mS2: mS2[i],
        mD1: mD1[i],
        mD2: mD2[i],
        mD3: mD3[i],
        amp0: amp0[i],
        ampDom: ampDom[i],
        ampBeat: ampBeat[i],
        ampS1: ampS1[i],
        ampS2: ampS2[i],
        ampD1: ampD1[i],
        ampD2: ampD2[i],
        ampD3: ampD3[i],
        phDom: phaseDom[i],
        phBeat: phaseBeat[i],
        phS1: phaseS1[i],
        phS2: phaseS2[i],
        phD1: phaseD1[i],
        phD2: phaseD2[i],
        phD3: phaseD3[i],
      };
      // Construcción del nuevo modo por tramos (varias filas por fotograma)
      // para que el render no se congele al cambiar de frecuencia; mientras
      // tanto, la flor anterior sigue en buf.rad.
      if (buf.radK === radKey) {
        buf.pending = null;
      } else {
        if (!buf.pending || buf.pending.key !== radKey) {
          buf.pending = {
            key: radKey,
            res: resD,
            argScale,
            mDom: mDom[i],
            nDom: nDom[i],
            mS1: mS1[i],
            mS2: mS2[i],
            mD1: mD1[i],
            mD2: mD2[i],
            mD3: mD3[i],
            tex,
            rows: 0,
            rad: new Float32Array(resD * resD * 13),
          };
        }
        const pend = buf.pending;
        const chunk = Math.max(4, Math.ceil(pend.res / 8));
        const y1 = Math.min(pend.res, pend.rows + chunk);
        fillRadTableRows(
          pend.rad,
          pend.res,
          pend.rows,
          y1,
          pend.argScale,
          pend.mDom,
          pend.mS1,
          pend.mS2,
          pend.mD1,
          pend.mD2,
          pend.mD3,
          pend.tex
        );
        pend.rows = y1;
        if (pend.rows >= pend.res) {
          buf.rad = pend.rad;
          buf.radK = pend.key;
          buf.radM = pend.mDom;
          buf.radN = pend.nDom;
          // Ver _curMode en el constructor: este es el ÚNICO lugar donde se
          // actualiza — sobrevive a los resets de _ensureDrop porque vive en
          // `this`, no en `buf`.
          this._curMode[i] = { m: pend.mDom, n: pend.nDom };
          buf.pending = null;
          if (this._gl) this._uploadDropGL(i, pend);
        }
      }
      if (waveLight && buf.waves && buf.waveRows < resD) {
        const y1 = Math.min(resD, buf.waveRows + Math.ceil(resD / 8));
        fillWaveRows(buf.waves, resD, buf.waveRows, y1);
        buf.waveRows = y1;
      }
      if (buf.waveRows === resD) buf.waveMix = Math.min(1, buf.waveMix + dt * 6);
      const rad = buf.rad;
      // Fases del grano capilar (chisporroteo del agua): cada gota hierve
      // a su propio ritmo, desincronizado de las demás. El grano espacial
      // está precalculado en la tabla; aquí solo tiembla su envolvente
      // global (barato).
      const gt1 = TWO_PI * 0.8 * t + d.p0 * 5.7;
      const gt2 = TWO_PI * 0.9 * t + d.p0 * 6.3;
      const gt3 = TWO_PI * 0.7 * t + d.p0 * 7.1;
      const gt4 = TWO_PI * 1.1 * t + d.p0 * 7.7;
      const granEnv = reducedMotion ? 0.55 : 0.55 + 0.45 * Math.cos(gt1 + gt3);
      const powShimmer = reducedMotion ? 1 : 1 + 0.12 * Math.sin(gt2);

      // Transición al cambiar de frecuencia (Parte B, auditoría 2026-09-08):
      // SUPERPOSICIÓN física, no fundido cruzado — cada flor (saliente y
      // entrante) relaja de forma independiente hacia su propio objetivo con
      // SU τ propio (derivado de su modo, ver arriba), y los pesos NO suman
      // 1: mientras la saliente todavía decae y la entrante ya creció, las
      // dos contribuyen a la vez a `sum` con intensidad real — el batido
      // visible entre modos que el fundido cruzado (pesos complementarios,
      // uno solo puede estar a plena intensidad) no podía producir. La
      // amplitud combinada puede superar momentáneamente la de cada flor por
      // separado (constructiva, real) — no se compensa con una ganancia
      // artificial: es la misma curva de saturación que ya satura las
      // crestas normales (más abajo, `tIn`/`eP`), y produce un breve
      // realce en vez de un recorte duro.
      let morph = this._morph[i];
      if (morph) {
        if (!buf.pending) {
          // La tabla del nuevo modo ya está lista: recién ahí arrancan las
          // dos relajaciones — mientras se construye por tramos, la flor
          // anterior se mantiene ÍNTEGRA (oldW=1, newW=0, sin avanzar el
          // reloj), igual que garantizaba el fundido cruzado anterior.
          morph.age += dt;
          morph.newW += (1 - morph.newW) * (1 - Math.exp(-dt / morph.tauNew));
          morph.oldW += (0 - morph.oldW) * (1 - Math.exp(-dt / morph.tauOld));
        }
        // La vista normal puede responder al siguiente cambio cuando la
        // saliente ya no se ve. En la científica se asientan ambos pesos.
        const settled = morph.oldW < 0.02 && (!sciMode || morph.newW > 0.98);
        if (!buf.pending && (settled || morph.age > MAX_MORPH_AGE_S)) {
          this._releaseMorphTex(i);
          this._morph[i] = null;
          morph = null;
        }
      }
      const pM = morph ? morph.p : null;
      const radP = morph ? morph.radP : null;
      const oldW = morph ? morph.oldW : 0;
      const newW = morph ? morph.newW : 0;
      // morphEnv ya no simula a mano un hundimiento/doble brillo a mitad de
      // fundido (auditoría anterior, `dip`/`burst`): con envolventes físicas
      // independientes ese realce lo produce la propia superposición cuando
      // ambas pesan a la vez (ver el comentario de arriba), así que
      // duplicarlo a mano quedaría como un efecto sobre otro. Queda en 1
      // (identidad) para no tocar el resto del pipeline que ya lo consume.
      const morphEnv = 1;
      // FIX (2026-09-08, "es inestable" — parpadeo reportado): el temblor
      // del patrón anterior durante la transición (misma oscilación shim*
      // que la flor nueva) no tenía siquiera el gateo de sciMode que sí
      // tiene la flor nueva — ver la nota junto a shim0/shimDom más arriba.
      // Neutralizado igual, siempre en 1 (sin temblor).
      const shim0P = 1;
      const shimDomP = 1;
      const shimS1P = 1;
      const shimS2P = 1;
      const shimD1P = 1;
      const shimD2P = 1;
      const shimD3P = 1;
      const shimBeatP = 1;
      const phaseA = this._liquidPhase + d.p0 * 1.3;
      const phaseB = this._reflectedPhase + d.p0 * 1.9 + 0.45;
      // El segundo modo responde desfasado y mantiene relieve cerca del cruce por cero.
      const standingPhase = Math.cos(phaseA);
      const secondaryPhase = Math.sin(phaseA);
      const reflectedLampX = 1.8 * lampSweep - (d.x - cx) / R;
      // Acota el enfoque cuando los anillos de alta frecuencia son subpíxel.
      const opticalWaveNumber = movingSurface ? Math.min(34, zeroFor(mDom[i], nDom[i])) : 0;

      // ----- Ruta GPU (WebGL2) -------------------------------------------
      // La GPU evalúa el mismo sumatorio píxel a píxel con las texturas del
      // modo (subidas arriba, por tramos) y las fases/amplitudes como
      // uniformes; el fundido cruzado también vive en el shader con las
      // texturas de la flor anterior capturadas en la transición.
      if (this._gl) {
        const gd = this._glDrops[i];
        if (gd.texA && gd.texB && gd.texC) {
          const GL = this._gl;
          const gl = GL.gl;
          const sc = GL.scratch;
          gl.useProgram(GL.prog);
          gl.viewport(i * glStride, 0, resD, resD);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gd.texA);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, gd.texB);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, gd.texC);
          const showOld = oldW > 0.02;
          if (showOld) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, morph.texBold ?? GL.blackTex);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, morph.texCold ?? GL.blackTex);
            gl.activeTexture(gl.TEXTURE5);
            gl.bindTexture(gl.TEXTURE_2D, morph.texAold ?? GL.blackTex);
          }

          // Pesos (amplitud·shimmer) y fases (rotación + fase) por modo.
          sc.j[0] = amp0[i] * shim0[i];
          sc.j[1] = ampDom[i] * shimDom[i];
          sc.j[2] = ampBeat[i] * shimBeat[i];
          sc.j[3] = ampS1[i] * shimS1[i];
          sc.j[4] = ampS2[i] * shimS2[i];
          sc.j[5] = ampD1[i] * shimD1[i];
          sc.j[6] = ampD2[i] * shimD2[i];
          sc.j[7] = ampD3[i] * shimD3[i];
          sc.ph[0] = rotDom[i] + phaseDom[i];
          sc.ph[1] = rotBeat[i] + phaseBeat[i];
          sc.ph[2] = rotS1[i] + phaseS1[i];
          sc.ph[3] = rotS2[i] + phaseS2[i];
          sc.ph[4] = rotD1[i] + phaseD1[i];
          sc.ph[5] = rotD2[i] + phaseD2[i];
          sc.ph[6] = rotD3[i] + phaseD3[i];
          sc.m[0] = mDom[i];
          sc.m[1] = mS1[i];
          sc.m[2] = mS2[i];
          sc.m[3] = mD1[i];
          sc.m[4] = mD2[i];
          sc.m[5] = mD3[i];
          if (showOld) {
            const p = pM;
            sc.jo[0] = p.amp0 * shim0P;
            sc.jo[1] = p.ampDom * shimDomP;
            sc.jo[2] = p.ampBeat * shimBeatP;
            sc.jo[3] = p.ampS1 * shimS1P;
            sc.jo[4] = p.ampS2 * shimS2P;
            sc.jo[5] = p.ampD1 * shimD1P;
            sc.jo[6] = p.ampD2 * shimD2P;
            sc.jo[7] = p.ampD3 * shimD3P;
            sc.pho[0] = rotDom[i] + p.phDom;
            sc.pho[1] = rotBeat[i] + p.phBeat;
            sc.pho[2] = rotS1[i] + p.phS1;
            sc.pho[3] = rotS2[i] + p.phS2;
            sc.pho[4] = rotD1[i] + p.phD1;
            sc.pho[5] = rotD2[i] + p.phD2;
            sc.pho[6] = rotD3[i] + p.phD3;
            sc.mo[0] = p.mDom;
            sc.mo[1] = p.mS1;
            sc.mo[2] = p.mS2;
            sc.mo[3] = p.mD1;
            sc.mo[4] = p.mD2;
            sc.mo[5] = p.mD3;
          }

          const sandSig = tex.sand * (200 / resD) + 0.012 * ampPattern;
          const presence = morph ? Math.max(oldW, newW) : 1;

          const U = GL.u;
          gl.uniform2f(U.uOffset, i * glStride, 0);
          gl.uniform1f(U.uRes, resD);
          gl.uniform1f(U.uHalf, half);
          gl.uniform1f(U.uRim, rim);
          gl.uniform1f(U.uWob, waterBoundary);
          for (let k = 0; k < 8; k++) gl.uniform1f(U.uJ[k], sc.j[k]);
          for (let k = 0; k < 7; k++) gl.uniform1f(U.uPh[k], sc.ph[k]);
          for (let k = 0; k < 6; k++) gl.uniform1f(U.uM[k], sc.m[k]);
          if (showOld) {
            for (let k = 0; k < 8; k++) gl.uniform1f(U.uJo[k], sc.jo[k]);
            for (let k = 0; k < 7; k++) gl.uniform1f(U.uPho[k], sc.pho[k]);
            for (let k = 0; k < 6; k++) gl.uniform1f(U.uMo[k], sc.mo[k]);
          }
          // Sin transición la flor actual pesa 1 (newW solo se define dentro
          // del bloque de morph); con transición, cada flor su peso real.
          gl.uniform1f(U.uNewW, morph ? newW : 1);
          gl.uniform1f(U.uOldW, morph ? oldW : 0);
          gl.uniform1f(U.uMEnv, morphEnv);
          gl.uniform1f(U.uPresence, presence);
          gl.uniform1f(U.uAmpPat, ampPattern);
          gl.uniform1f(U.uAmp, amp);
          gl.uniform1f(U.uSwell, swell);
          gl.uniform2f(U.uWavePhase, phaseA, phaseB);
          gl.uniform3f(U.uSurfaceOptics, surfaceOptics, standingPhase, secondaryPhase);
          gl.uniform2f(U.uLampOptics, reflectedLampX, opticalWaveNumber);
          gl.uniform2f(U.uRippleGain, wideRippleGain, fineRippleGain);
          gl.uniform3fv(U.uLampTint, reflectedColor);
          gl.uniform1f(U.uWaveLight, waveLight);
          gl.uniform1f(U.uWaterVibration, waterVibration);
          gl.uniform1i(U.uClearWater, sciMode ? 0 : 1);
          // PHASE 3: Disable capillary grain overlay in Scientific Mode
          gl.uniform1f(U.uGEnv, sciMode ? 0 : granEnv);
          gl.uniform1f(U.uPSh, powShimmer);
          gl.uniform1f(U.uTexPow, tex.pow);
          gl.uniform1f(U.uTexSalt, tex.salt);
          gl.uniform1f(U.uSandSig, sandSig);
          gl.uniform1f(U.uGain, gain);
          gl.uniform1f(U.uMid, mid);
          gl.uniform3fv(U.uPal, d.pal);
          gl.uniform3fv(U.uDeep, d.deep);
          gl.uniform3fv(U.uWhite, crestColor);

          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

          drewAtlas = true;
        }
        continue; // esta gota la dibuja la GPU
      }

      // Escalares de esta gota en variables locales: el bucle interior los
      // usa en cada píxel, así que sacarlos de los arrays (y los accesos a
      // memoria) acelera el render de forma medible. Las amplitudes ya
      // llevan su shimmer (j = a·s) y las fases su rotación (φ = r + p):
      // por píxel solo queda el coseno angular de cada modo.
      const mDom0 = mDom[i];
      const mS10 = mS1[i];
      const mS20 = mS2[i];
      const mD10 = mD1[i];
      const mD20 = mD2[i];
      const mD30 = mD3[i];
      const j0 = amp0[i] * shim0[i];
      const jDom = ampDom[i] * shimDom[i];
      const jBeat = ampBeat[i] * shimBeat[i];
      const jS1 = ampS1[i] * shimS1[i];
      const jS2 = ampS2[i] * shimS2[i];
      const jD1 = ampD1[i] * shimD1[i];
      const jD2 = ampD2[i] * shimD2[i];
      const jD3 = ampD3[i] * shimD3[i];
      // Rotaciones por separado: la flor anterior (transición) las usa con
      // sus propias fases de fase.
      const rDom = rotDom[i];
      const rS1 = rotS1[i];
      const rS2 = rotS2[i];
      const rD1 = rotD1[i];
      const rD2 = rotD2[i];
      const rD3 = rotD3[i];
      const rBeat = rotBeat[i];
      const phDom = rDom + phaseDom[i];
      const phBeat = rBeat + phaseBeat[i];
      const phS1 = rS1 + phaseS1[i];
      const phS2 = rS2 + phaseS2[i];
      const phD1 = rD1 + phaseD1[i];
      const phD2 = rD2 + phaseD2[i];
      const phD3 = rD3 + phaseD3[i];
      // Fase de la transición para este fotograma: en el fundido cruzado se
      // evalúan las DOS flores (cada una con su peso); en las colas, solo
      // la que pesa.
      const useNew = morph ? newW > 0.02 : true;
      const useOld = morph ? oldW > 0.02 : false;
      const pOld = useOld ? pM : null;
      const rpOld = useOld ? radP : null;
      const mEnv = morphEnv;
      const presence = morph ? Math.max(oldW, newW) : 1;
      const cosA = Math.cos(phaseA), sinA = Math.sin(phaseA);
      const cosB = Math.cos(phaseB), sinB = Math.sin(phaseB);
      const waves = buf.waves;
      const bound = half * waterBoundary;
      // PHASE 3: Disable capillary grain overlay in Scientific Mode
      const gEnv = sciMode ? 0 : granEnv;
      const pSh = powShimmer;
      const texPow = tex.pow;
      const texSalt = tex.salt;
      const sandSig = tex.sand * (200 / resD) + 0.012 * ampPattern;
      const pal = d.pal;
      const dp = d.deep;
      const cr0 = pal[0];
      const cg0 = pal[1];
      const cb0 = pal[2];
      const dr0 = dp[0];
      const dg0 = dp[1];
      const db0 = dp[2];
      const crestR = cr0 * 0.2 + crestColor[0] * 0.8;
      const crestG = cg0 * 0.2 + crestColor[1] * 0.8;
      const crestB = cb0 * 0.2 + crestColor[2] * 0.8;
      const transmittedR = cr0 * 0.34 + reflectedColor[0] * 0.66;
      const transmittedG = cg0 * 0.34 + reflectedColor[1] * 0.66;
      const transmittedB = cb0 * 0.34 + reflectedColor[2] * 0.66;
      const waveStrength = waveLight * buf.waveMix;
      const reliefStrength = waterVibration * buf.waveMix;
      const opticalMix = surfaceOptics * buf.waveMix;
      const heights = buf.relief;

      for (let py = 0; py < resD; py++) {
        const base = py * resD;
        for (let px = 0; px < resD; px++) {
          const idx = base + px;
          const o = idx * 13; // 13 columnas: r, θ, J0, Jm, Js1, Js2, Jd1..3, grano, polvo
          const o4 = idx * 4;
          const dist = rad[o];
          if (dist >= bound) {
            ddata[o4 + 3] = 0;
            continue;
          }
          const soft = clamp01((bound - dist) / rim);
          const th = rad[o + 1];

          // Elevación: la flor actual y, durante un fundido cruzado, la
          // anterior también — cada una con su peso. Al superponerse, los
          // anillos de la flor vieja se deslizan hacia los de la nueva.
          let sum = 0;
          let secondary = 0;
          if (amp > 0 && useNew) {
            secondary = jBeat * rad[o + 3] * Math.cos(mDom0 * th + phBeat);
            sum =
              j0 * rad[o + 2] +
              jDom * rad[o + 3] * Math.cos(mDom0 * th + phDom) +
              secondary +
              jS1 * rad[o + 4] * Math.cos(mS10 * th + phS1) +
              jS2 * rad[o + 5] * Math.cos(mS20 * th + phS2) +
              jD1 * rad[o + 6] * Math.cos(mD10 * th + phD1) +
              jD2 * rad[o + 7] * Math.cos(mD20 * th + phD2) +
              jD3 * rad[o + 8] * Math.cos(mD30 * th + phD3);
            if (morph) {
              sum *= newW;
              secondary *= newW;
            }
          }
          if (amp > 0 && useOld) {
            const p = pOld;
            const rp = rpOld;
            // Las columnas Bessel de la tabla anterior son rp[o+2..o+8]
            // (J0, J_mDom, J_mS1, J_mS2, J_mD1, J_mD2, J_mD3) — el mismo
            // esquema que la flor nueva. Antes se leían rp[o..o+6] (r, θ,
            // J0…), lo que dibujaba la flor que se desvanecía con las
            // columnas equivocadas: el fundido parecía sucio y antinatural.
            sum +=
              oldW *
              (p.amp0 * shim0P * rp[o + 2] +
                (p.ampDom * shimDomP) *
                  rp[o + 3] *
                  Math.cos(p.mDom * th + rDom + p.phDom) +
                (p.ampBeat * shimBeatP) *
                  rp[o + 3] *
                  Math.cos(p.mDom * th + rBeat + p.phBeat) +
                (p.ampS1 * shimS1P) *
                  rp[o + 4] *
                  Math.cos(p.mS1 * th + rS1 + p.phS1) +
                (p.ampS2 * shimS2P) *
                  rp[o + 5] *
                  Math.cos(p.mS2 * th + rS2 + p.phS2) +
                (p.ampD1 * shimD1P) *
                  rp[o + 6] *
                  Math.cos(p.mD1 * th + rD1 + p.phD1) +
                (p.ampD2 * shimD2P) *
                  rp[o + 7] *
                  Math.cos(p.mD2 * th + rD2 + p.phD2) +
                (p.ampD3 * shimD3P) *
                  rp[o + 8] *
                  Math.cos(p.mD3 * th + rD3 + p.phD3));
          }
          // Envuelta de reafinación y grano capilar (precalculado): el
          // patrón brilla con la energía y el latido, y el chisporroteo del
          // agua tiembla con una envolvente global barata.
          const eBase = sum * amp * swell * mEnv;
          let frontA = 0, frontB = 0;
          if (waveStrength > 0) {
            const waveOffset = idx * WAVE_STRIDE;
            const spatialCosA = waves[waveOffset];
            const spatialSinA = waves[waveOffset + 1];
            const spatialCosB = waves[waveOffset + 2];
            const spatialSinB = waves[waveOffset + 3];
            frontA = wideRippleGain * (spatialCosA * cosA + spatialSinA * sinA);
            frontB = fineRippleGain * (spatialCosB * cosB + spatialSinB * sinB);
          }
          const ripple = WAVE_BLEND_A * frontA + WAVE_BLEND_B * frontB;
          const lobeScale = 1 + LOBE_VIBRATION_GAIN * reliefStrength * ripple;
          const modeHeight = eBase + opticalMix * (
            eBase * (standingPhase * lobeScale - 1) +
            secondary * amp * swell * mEnv * (secondaryPhase - standingPhase * lobeScale)
          );
          const relief = modeHeight + RIPPLE_HEIGHT * reliefStrength * ripple;
          const gran = rad[o + 11] * gEnv;
          const e = relief + gran * (0.1 + Math.abs(eBase)) * 0.045 * amp;
          // El polvo marca los nodos del modo. La campana es muy estrecha
          // (σ ≈ 0,02) y su grosor se adapta al tamaño del búfer para que
          // las líneas tengan el MISMO grosor en pantalla a cualquier
          // tamaño — así los patrones pequeños se leen definidos también en
          // pantallas chicas. El moteado del polvo está precalculado en la
          // tabla (columna 12) y tiembla con una envolvente global. La
          // gaussiana solo se evalúa donde puede ser visible (|eBase| bajo):
          // el resto de píxeles se ahorra el exp — la mayor parte del costo.
          let sand = 0;
          if (ampPattern > 0 && Math.abs(eBase) < 0.11) {
            const sandPowder = 1 - texPow + texPow * rad[o + 12] * pSh;
            // Actividad local de la onda: la sal solo se asienta donde la
            // superficie vibra de verdad (las zonas muertas cerca del borde
            // quedan sin polvo).
            const env =
              Math.abs(j0 * rad[o + 2]) +
              Math.abs(jDom * rad[o + 3]) +
              Math.abs(jBeat * rad[o + 3]) +
              Math.abs(jS1 * rad[o + 4]) +
              Math.abs(jS2 * rad[o + 5]) +
              Math.abs(jD1 * rad[o + 6]) +
              Math.abs(jD2 * rad[o + 7]) +
              Math.abs(jD3 * rad[o + 8]);
            const envGate = clamp01((env - 0.05) / 0.25);
            sand =
              Math.exp(-(eBase * eBase) / (2 * sandSig * sandSig)) *
              sandPowder *
              envGate *
              (0.75 + 0.25 * ampPattern) *
              ampPattern *
              presence *
              (waveStrength > 0 ? 1 - 0.76 * buf.waveMix : 1);
          }
          // Compresión gamma: la amplitud física decae como 1/√r (envelope
          // de Bessel); se comprime el rango con una raíz cuadrada (cámara)
          // para que los anillos exteriores también se lean. Contraste alto
          // con curva empinada: los pétalos brillan y los valles se hunden,
          // como en una foto de cimática real.
          const eP = (e < 0 ? -1 : 1) * Math.sqrt(Math.abs(e));
          // Aproximación racional de tanh (error < 2 %): la curva 5.0 casi
          // binaria cresta→valle — línea blanca sobre plato oscuro — sin el
          // costo de Math.tanh por píxel.
          const tIn = (eP * gain + mid - 0.5) * 5.0;
          const t2 = tIn * tIn;
          const tt = tIn < -3 ? -1 : tIn > 3 ? 1 : (tIn * (27 + t2)) / (27 + 9 * t2);
          const v = 0.5 + 0.5 * tt;
          let cr, cg, cb;
          if (v < 0.5) {
            const u = v * 2;
            cr = cr0 * u + dr0 * (1 - u);
            cg = cg0 * u + dg0 * (1 - u);
            cb = cb0 * u + db0 * (1 - u);
          } else {
            const u = (v - 0.5) * 2;
            cr = crestColor[0] * u + cr0 * (1 - u);
            cg = crestColor[1] * u + cg0 * (1 - u);
            cb = crestColor[2] * u + cb0 * (1 - u);
          }
          // El polvo nodal se mezcla como plata suave teñida con el color de
          // la gota: las líneas del mandala se leen nítidas, sin motas al azar.
          if (sand > 0.02) {
            // La línea nodal se pinta casi blanca (sal bajo la luz cenital),
            // teñida solo un punto con el color de la gota y con la cantidad
            // de polvo propia del plato: el trazo del mandala se lee nítido.
            const sa = sand * texSalt * soft;
            cr = cr * (1 - sa) + (240 + (pal[0] - 240) * 0.22) * sa;
            cg = cg * (1 - sa) + (245 + (pal[1] - 245) * 0.22) * sa;
            cb = cb * (1 - sa) + (252 + (pal[2] - 252) * 0.22) * sa;
          }
          let bodyAlpha = 0.26 + 0.1 * ampPattern + 0.54 * v + 0.55 * sand * ampPattern;
          if (!sciMode) {
            let crest = clamp01(relief / 0.23);
            crest = crest * crest * (3 - 2 * crest);
            const clearWater = waveStrength > 0 ? buf.waveMix : 0;
            const sheen = (0.64 - 0.34 * clearWater) * crest;
            cr += (crestR - cr) * sheen;
            cg += (crestG - cg) * sheen;
            cb += (crestB - cb) * sheen;
            bodyAlpha = 0.125 + 0.055 * ampPattern + (0.42 - 0.22 * clearWater) * v
              + (0.27 - 0.17 * clearWater) * crest + 0.46 * sand * ampPattern;
          }
          let alpha = Math.min(bodyAlpha, 1);
          if (waveStrength > 0) {
            heights[idx] = relief;
            const rippleCurvature = -RIPPLE_CURVATURE_A * frontA - RIPPLE_CURVATURE_B * frontB;
            const curvature = -(opticalWaveNumber ** 2) * modeHeight
              + RIPPLE_HEIGHT * reliefStrength * rippleCurvature;
            const compression = -REFRACTION_SCALE * curvature;
            const focus = Math.max(0, compression) * Math.abs(compression) / (0.30 + compression * compression);
            const shade = 1 + 0.28 * waveStrength * Math.min(0, compression) / (1 + Math.abs(compression));
            cr *= shade;
            cg *= shade;
            cb *= shade;
            const transmission = CAUSTIC_GAIN * waveStrength * focus;
            alpha += (1 - alpha) * transmission;
            const transmissionMix = transmission / Math.max(alpha, 0.0001);
            cr += (transmittedR - cr) * transmissionMix;
            cg += (transmittedG - cg) * transmissionMix;
            cb += (transmittedB - cb) * transmissionMix;
          }
          // Transparencia del agua: el agua es translúcida — los valles
          // dejan ver el plato oscuro a través (más transparentes) y las
          // crestas se opacan con la elevación, como el agua real bajo la
          // luz cenital: color visible y fondo visible a la vez. Sin patrón
          // (pausa) queda una lente de agua limpia y clara.
          ddata[o4] = cr > 255 ? 255 : cr;
          ddata[o4 + 1] = cg > 255 ? 255 : cg;
          ddata[o4 + 2] = cb > 255 ? 255 : cb;
          ddata[o4 + 3] = Math.round(255 * alpha * soft);
        }
      }

      if (waveStrength > 0) {
        reflectLampInWater(ddata, heights, resD, bound, rim, reflectedLampX, waveStrength, reflectedColor);
      }
      buf.ctx.putImageData(buf.img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(buf.canvas, d.x - dropR, cy - dropR, dropR * 2, dropR * 2);
    }
    // Copiar una sola vez, después de completar las tres franjas WebGL.
    if (drewAtlas) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this._gl.canvas, drops[0].x - dropR, cy - dropR, 2 * (step + dropR), 2 * dropR);
    }
    } // else: gotas con patrón

    if (lampLight > 0.02) {
      drawPlateLamp(ctx, cx, cy, R, lampLight, lampSweep, lampTint);
    }

    // Viñeta sutil para integrar el plato con el fondo oscuro.
    const vg = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // ----- Rendimiento adaptativo -----------------------------------------
    // Se mide el tiempo real del fotograma (EMA) y la resolución de las
    // gotas sube o baja despacio: si el render tarda mucho, las gotas bajan
    // un escalón (líneas algo más suaves) para mantener los FPS; si sobra
    // tiempo, vuelven a subir hasta el máximo. No se ajusta a mitad de una
    // transición para no cortarla.
    const frameMs = performance.now() - tMs;
    this._frameEMA = this._frameEMA * 0.92 + Math.min(60, frameMs) * 0.08;
    // FIX (Parte B): mismo criterio que arriba (sin final duro).
    if (!this._drops.some((drop) => drop.pending) && !this._morph.some(Boolean)) {
      if (this._frameEMA > 24 && this._resMul > 0.62) {
        this._resMul = Math.max(0.62, this._resMul * 0.985);
      } else if (this._frameEMA < 13 && this._resMul < 1) {
        this._resMul = Math.min(1, this._resMul * 1.015);
      }
    }
  }

  /**
   * Returns the central drop's last completed Bessel mode.
   * Used by simulation.js to surface physically-derived mode data to the HUD.
   * @returns {{ m: number, n: number, omega: number, detuning: number, response: number | null } | null}
   */
  getDominantMode() {
    const mode = this._curMode[1];
    if (!mode) return null;
    const { m, n } = mode;
    const omega = modeOmega(m, n, PHYS_A);
    const response = this._renderMode === 'scientific'
      ? modalResponse(omega, this._centerDriveOmega, zeroFor(m, n) / PHYS_A)
      : null;
    return { m, n, omega, detuning: omega - this._centerDriveOmega, response };
  }
}
