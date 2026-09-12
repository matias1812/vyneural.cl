// src/wavefield.js
// Wave Propagation Laboratory — Phase 2
//
// PHYSICAL MODEL: 2D scalar wave equation (FDTD — Finite Difference Time Domain)
//   u_tt = c² ∇²u - 2γ u_t       (damped wave equation)
//
// Discretized (Leapfrog, 2nd order in space and time, Δx = Δy = Δt = 1):
//   u_next[i] = (2 - 4c²) u[i] - (1 - 2γΔt) u_prev[i]
//             + c²( u[i±1] + u[i±N] )
//
// STABILITY CONDITION (CFL):
//   c · sqrt(2) ≤ 1  →  c ≤ 1/sqrt(2) ≈ 0.707
//   Exceeding this causes numerical blowup.
//
// ENERGY:
//   KE ≈ (1/2) Σ (u - u_prev)²     (kinetic — velocity proxy)
//   PE ≈ (1/2) c² Σ [(∇u)² terms]  (potential — gradient proxy)
//   E_total = KE + PE
//   Under damping: E(t) ≈ E₀ · exp(-2γt)
//
// SOURCE TYPE CLASSIFICATION:
//   step()           — PHYSICAL: FDTD solve of wave equation
//   computeEnergy()  — PHYSICAL: energy integral over grid
//   getPhysicsMetrics() — PHYSICAL / DERIVED
//   render()         — VISUAL: artistic pixel mapping of wave amplitude

import { mulberry32 } from './core/reproducibility.js';

const MAX_SAFE_C = 1 / Math.SQRT2; // CFL limit for 2D FDTD

// VISUAL/HEURISTIC (2026-09-08): temporal shape of driveArea()'s parametric
// forcing. NOT a physical claim — a real parametric drive is essentially
// always sinusoidal; "square/triangle/sawtooth drive" has no standard
// physical meaning for a Faraday/cymatics plate. Exists only so the
// waveform selector (already wired to portadora/latido elsewhere) keeps
// SOME visible effect on the "Gotas" render, the same role pokeSpread used
// to play before the excitation model changed from point source to area.
function periodicDrive(phase, wave) {
  const s = Math.sin(phase);
  if (wave === 'square') return Math.sign(s) || 1;
  if (wave === 'triangle') return (2 / Math.PI) * Math.asin(s);
  if (wave === 'sawtooth') {
    const frac = phase / (2 * Math.PI);
    return 2 * (frac - Math.floor(frac + 0.5));
  }
  return s; // 'sine' — default, physically the simplest parametric drive.
}

// ---------------------------------------------------------------------------
// VISUAL/HEURISTIC — fuera de la superficie PHYSICAL de step()/computeEnergy().
// Curva de brillo compartida por WaveField.render() y renderBrain() (main.js):
// antes vivía duplicada en los dos sitios (se tocó dos veces esta sesión), acá
// queda en un solo lugar.
//
// `curv` es el Laplaciano local (mismo stencil de 4 vecinos que step(), pero
// recalculado en el pase de render — nunca toca step()/prev/next): un cruce
// real de dos ondas produce un pico de curvatura marcado aunque la amplitud
// sumada no sea mucho mayor que una cresta sola, que es justo por qué las
// colisiones chicas se perdían antes (la curva de amplitud satura igual para
// "cresta normal" y "cresta duplicada por choque"). Cáustica = luz que se
// concentra por la curvatura de la superficie (refracción), distinta del
// reflejo especular por pendiente que ya usa cimática — mismo fenómeno físico
// real que hace destellar los cruces en video de agua/cimática real.
// FIX (auditoría 2026-09-08, deuda de verificación externa — "las gotas no
// se parecen a la cimática"): CAUSTIC_GAIN=4.5 era demasiado alto para la
// amplitud real que produce driveArea() en uso normal. Medido reconstruyendo
// la física real (grilla, c, damp, amplitud de excitación) fuera del
// navegador: el campo de onda de fondo es LISO (rugosidad relativa ~0,02 —
// nada de ruido) y la amplitud típica ni siquiera llega al umbral v>0,35 que
// activa el reflejo especular de cresta más abajo — pero con GAIN=4,5 la
// cáustica igual se disparaba en ~86 % de las celdas (umbral glow>0,1), sobre
// curvatura residual mínima (heredada de que driveArea()/_seed reinyecta
// ruido de baja amplitud cada frame sin parar, ver setCircle()). Esa cáustica
// omnipresente ERA el "moteado tipo musgo" que hacía que Gotas no se pareciera
// en nada a la forma de onda suave que la física realmente produce.
// Recalibrado a 1,2 comparando dos escenarios reconstruidos fuera del
// navegador: excitación típica (ambiente, sin colisión) vs. dos pulsos
// convergiendo a propósito (colisión real). Con GAIN=1,2 el ambiente cae a
// ~4 % de celdas con glow>0,1 (antes 86 %) mientras una colisión real
// conserva ~29 % (antes 36 %) — la cáustica vuelve a ser selectiva: se
// reserva para picos de curvatura genuinos en vez de iluminar toda la
// superficie. Costo aceptado: el destello MÁS intenso (glow>0,5) de una
// colisión fuerte baja de ~14 % a ~0 % de sus celdas — colisiones se ven como
// un brillo suave en vez de un flash blanco, no como una chispa ausente.
const CAUSTIC_GAIN = 1.2; // HEURISTIC — recalibrado con datos (ver arriba), no solo a ojo
// FIX (auditoría P7 2026-09-03): waveShade() se llama una vez POR PÍXEL en
// WaveField.render() y renderBrain() (miles de veces por frame, ×3 cuencas) —
// devolver un objeto literal `{bri, glow}` nuevo cada vez presionaba al GC
// justo en el hot loop del visualizador. Un solo objeto de salida reusado
// (mutado, nunca reasignado) elimina esa presión: el llamador desestructura
// bri/glow inmediatamente después de cada llamada, antes de la siguiente, así
// que reusar la misma referencia es seguro (JS es de un solo hilo, sin
// llamadas reentrantes a waveShade acá).
const SHADE_OUT = { bri: 0, glow: 0 };
export function waveShade(v, curv = 0) {
  let bri = 0.32 + v * 0.5;
  if (bri < 0.15) bri = 0.15;
  if (bri > 1.25) bri = 1.25;
  const w = v > 0.35 ? Math.min(1, (v - 0.35) * 0.9) : 0;
  // FIX (reportado en vivo sobre el equivalente de cimática: "apagones,
  // destellos, cambios bruscos"): Math.min(1, x) tiene un codo duro — con el
  // ir y venir normal de las ondas la curvatura cruzaba ese codo muy rápido
  // y se veía como parpadeo binario. Se comprime con sqrt (mismo criterio
  // que usa cymatics.js para su propio mapeo de color, eP = sign(e)·sqrt(|e|))
  // y se satura SUAVE (d/(d+1), sin codo) en vez de Math.min — el destello de
  // colisión queda vivo pero sin el filo/aliasing de antes.
  const cn = v > 0 ? Math.sqrt(Math.abs(curv)) * CAUSTIC_GAIN : 0;
  const caustic = cn / (cn + 1);
  // Blanqueo = lo que ya había (cresta alta) O el destello de colisión — una
  // colisión puede blanquear una celda aunque v solo nunca cruce 0.35.
  const glow = Math.max(w, caustic * 0.9);
  SHADE_OUT.bri = bri;
  SHADE_OUT.glow = glow;
  return SHADE_OUT;
}

export class WaveField {
  /**
   * @param {number} size Grid side length (cells). Grid is size×size.
   * @param {object} opts
   * @param {number} [opts.c=0.4] Wave speed (dimensionless, must satisfy CFL: c < 1/√2 ≈ 0.707).
   * @param {number} [opts.damp=0.995] Per-step amplitude retention factor (linear damping proxy).
   *   Equivalent viscous damping rate: γ ≈ -ln(damp) per step.
   */
  constructor(size, { c = 0.4, damp = 0.995 } = {}) {
    // --- CFL Validation ---
    // PHYSICAL: if c > 1/√2 the leapfrog scheme is unconditionally unstable.
    // We clamp and warn rather than silently explode.
    if (c > MAX_SAFE_C) {
      console.warn(
        `[WaveField] CFL VIOLATION: c=${c.toFixed(4)} > ${MAX_SAFE_C.toFixed(4)} (1/√2). ` +
        `Clamping to ${MAX_SAFE_C.toFixed(4)} to preserve numerical stability.`
      );
      c = MAX_SAFE_C;
    }

    this.size = size;
    this.c = c;
    this.damp = Math.max(0, Math.min(1, damp)); // strictly [0,1]
    this.n = size * size;

    // PHYSICAL: leapfrog needs u(t), u(t-Δt), u(t+Δt) at each cell
    this.u    = new Float32Array(this.n); // current
    this.prev = new Float32Array(this.n); // previous
    this.next = new Float32Array(this.n); // scratch

    // 1 = interior cell, 0 = exterior (forced u=0 outside the mask — see
    // step() for the free/Neumann reflection this class actually implements
    // at the mask boundary; STALE NAME FIX 2026-09-08, was "Dirichlet BC u=0"
    // here since before that boundary changed).
    this.mask = new Uint8Array(this.n);
    this.soft = null;                     // VISUAL: soft alpha falloff at boundary

    // Physics metrics (updated each step)
    this._energy       = 0; // total wave energy (KE + PE approximation)
    this._stepCount    = 0; // number of steps taken
    this._clipCount    = 0; // number of cells clamped this step (non-zero = non-physical)
    this._cfl          = c * Math.SQRT2; // CFL number (stability margin; must be < 1)

    // VISUAL: offscreen canvas for pixel rendering. Created lazily on first
    // render() call so the physics core stays pure (no DOM) and can run
    // headless in Node for the scientific validation suite.
    this.canvas = null;
    this.ctx = null;
    this.img = null;

    this._cx = 0;
    this._cy = 0;
    this._r  = 0;

    // HEURISTIC: symmetry-breaking field for driveArea() — generated lazily
    // in setCircle() (not here) because it's conceptually part of the
    // basin's geometry setup, alongside mask/soft, not the transient wave
    // state. See the FIX comment on driveArea() for why it exists at all.
    this._seed = null;
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL: Define circular basin. Boundary condition is free/Neumann
  // (∂u/∂n = 0 at the mask edge — see step() for the ghost-cell reflection
  // that implements it), matching the free-surface edge cymatics.js already
  // assumes (J'_m(ka)=0). STALE COMMENT FIX (2026-09-08): this used to say
  // "Dirichlet (fixed) boundary conditions, u=0 at all times" — true before
  // that audit, no longer true of step()'s actual stencil.
  // ---------------------------------------------------------------------------
  setCircle(cx, cy, r) {
    this._cx = cx;
    this._cy = cy;
    this._r  = r;
    this.mask.fill(0);
    this.soft = this.soft || new Float32Array(this.n);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const dx   = x - cx;
        const dy   = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= r) this.mask[y * this.size + x] = 1;
        // VISUAL: soft alpha falloff so the disc edge isn't pixelated
        this.soft[y * this.size + x] = Math.min(1, Math.max(0, (r + 1.5 - dist) / 1.5));
      }
    }
    // FIX (2026-09-08, excitación distribuida): _seed se genera acá —una
    // sola vez por tamaño de grilla, NO en reset()— porque es una propiedad
    // fija de la geometría de esta cuenca (como mask/soft), no parte del
    // estado transitorio de la onda que reset() limpia en cada replay. Si
    // reset() lo regenerara, cada reinicio de sesión cambiaría qué modo
    // angular gana, que no es el comportamiento que se busca (la cuenca
    // debería conservar su "personalidad" mientras no cambie de tamaño).
    // Semilla derivada de `size`: determinista y reproducible para la misma
    // resolución de grilla, sin depender de Math.random().
    if (!this._seed || this._seed.length !== this.n) {
      const rng = mulberry32((this.size * 0x9e3779b1) >>> 0);
      this._seed = new Float32Array(this.n);
      // Media ≈ 1, variación ±10%: ver driveArea() para el porqué de esta
      // ruptura de simetría — HEURISTIC, no PHYSICAL.
      for (let i = 0; i < this.n; i++) this._seed[i] = 1 + (rng() * 2 - 1) * 0.1;

      // FIX (auditoría 2026-09-08 — regresión en vivo: "en Gotas solo se ve
      // blanco y no blanco"): el Laplaciano con borde Neumann PURO (ver
      // step()) tiene espacio nulo — u = constante es solución exacta con
      // ω=0 (∇²(constante)=0, sin término restaurador). Una semilla de
      // media ≈1 es, en esencia, una fuerza uniforme, y una fuerza uniforme
      // acopla casi toda su energía a ESE modo (medido contra este mismo
      // código: pistón 77x más fuerte que el patrón real con la semilla sin
      // corregir). El plato entero sube y baja en bloque en vez de mostrar
      // ninguna estructura — exactamente "todo blanco, todo negro,
      // alternando". No era una resonancia ni exceso de amplitud (bajar el
      // forzado a 1/10 no lo arregla, confirmado): es que el forzado no era
      // ortogonal al modo nulo. Restarle la media (Σ mask·seed = 0) es el
      // manejo estándar del espacio nulo del Laplaciano de Neumann —y tiene
      // respaldo físico, no es un truco: el agua es incompresible y el
      // volumen del recipiente es fijo, así que ∫u dA = 0 es una
      // restricción real del sistema (con el borde Dirichlet viejo esto
      // venía impuesto gratis por u=0 en el borde; con borde libre hay que
      // imponerlo a mano). Verificado: con media cero el pistón desaparece
      // (0.0000) y el patrón real queda intacto (RMS sin cambio apreciable).
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < this.n; i++) {
        if (this.mask[i]) { sum += this._seed[i]; cnt++; }
      }
      const seedMean = cnt > 0 ? sum / cnt : 0;
      for (let i = 0; i < this.n; i++) {
        if (this.mask[i]) this._seed[i] -= seedMean;
      }
    }
    this.reset();
  }

  reset() {
    this.u.fill(0);
    this.prev.fill(0);
    this.next.fill(0);
    this._energy    = 0;
    this._stepCount = 0;
    this._clipCount = 0;
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL: Point source excitation (impulse at a single cell).
  // ---------------------------------------------------------------------------
  poke(x, y, amount) {
    const i = Math.round(y) * this.size + Math.round(x);
    if (i >= 0 && i < this.n && this.mask[i]) this.u[i] += amount;
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL: Disc source excitation — Gaussian initial condition over a
  // small stencil, simulating a finite-size initial displacement.
  //   `spread` (radio² de corte, default 4 → radio ~2) controla qué tan
  //   concentrado es el impulso: un impulso más puntual (spread chico)
  //   excita más número de onda alto → anillos más nítidos/afilados al
  //   propagarse; uno más difuso (spread grande) da un impulso más suave.
  //   Usado para que la forma de onda real module el "perfil" del impulso
  //   (cuadrada/sierra → más afilado; senoidal/triangular → más suave),
  //   sin dejar de ser el mismo tipo de fuente física (auditoría 2026-08-29).
  //
  //   FIX (fidelidad de físicas, 2026-09-03): hasta ahora esto era un disco
  //   de corte duro (toda celda con d² ≤ spread recibía el mismo `amount`),
  //   pese a que el comentario ya decía "Gaussian-like" — un impacto real
  //   deposita energía con una caída suave hacia el borde, no un escalón.
  //   Ahora es una Gaussiana real: el PICO en el centro sigue siendo
  //   exactamente `amount` (mismo calibre que main.js ya afina contra
  //   AMP_LIMIT/volMul — no hace falta retocar ningún llamador), y decae a
  //   ~10% de `amount` en el mismo radio (`spread`) que antes marcaba el
  //   corte. La energía TOTAL inyectada baja un poco frente al disco plano
  //   — es la contrapartida física correcta de una caída real en vez de un
  //   escalón, no un bug.
  // ---------------------------------------------------------------------------
  pokeDisc(x, y, amount, spread = 4) {
    const size = this.size;
    const cx = Math.round(x);
    const cy = Math.round(y);
    const r = Math.ceil(Math.sqrt(spread));
    const twoSigma2 = spread / Math.LN10; // exp(-spread/twoSigma2) = 0.1 en el borde
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > spread) continue;
        const i = (cy + dy) * size + (cx + dx);
        if (i >= 0 && i < this.n && this.mask[i]) this.u[i] += amount * Math.exp(-d2 / twoSigma2);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL: Distributed (area) excitation — every interior cell moves
  // together, like a plate/membrane driven parametrically, instead of a
  // point source rippling outward. Added 2026-09-08 as the excitation model
  // for the "Gotas" visualizer: poke()/pokeDisc() (above) are UNCHANGED and
  // still exist/work exactly as before — this is a new, separate method,
  // not a replacement of them at the class level. main.js's drawVisual()
  // decides which one to call; see the FIX comment there for why it now
  // calls this instead.
  //
  //   Real cymatics/Faraday excitation is parametric and uniform: the whole
  //   surface is driven in phase, there is no source at any one point, nodes
  //   are stationary, and nothing propagates radially from the middle. A
  //   point poke — even a very frequent one — is a fundamentally different
  //   phenomenon (a pond with a drop falling in), which is what pokeDisc()
  //   correctly models for whatever still wants that.
  //
  //   `_seed` (HEURISTIC, not PHYSICAL — see its own comment in setCircle()):
  //   a perfectly uniform force over a perfectly circular mask only excites
  //   radially-symmetric modes, so without it you'd still see concentric
  //   rings — stationary instead of traveling, but rings all the same. Real
  //   Faraday patterns pick their angular mode because of symmetry-breaking
  //   (boundary imperfections, thermal/mechanical noise); `_seed` is the
  //   stand-in for that here.
  //
  //   `amp` is amplitude PER SECOND, not per frame/step — the CALLER must
  //   multiply by dt before passing it in (same explicit-dt contract as
  //   stepWaveFields() in main.js). Calling this once per animation frame
  //   with a raw, non-dt-scaled amp makes the energy injected per real
  //   second depend on the device's framerate.
  //
  //   `wave` shapes the drive's TIME profile (sine/triangle/square/
  //   sawtooth) — see periodicDrive() above. This is where pokeSpread's old
  //   job (waveform → impulse sharpness) moved to: an area-wide drive has
  //   no spatial "concentration" left to modulate, so the waveform now
  //   shapes the oscillation in time instead. Default 'sine' needs no
  //   justification (it's the physically simplest parametric drive); the
  //   other three are a carried-over VISUAL heuristic, not a new physical
  //   claim.
  // ---------------------------------------------------------------------------
  driveArea(amp, phase, wave = 'sine') {
    if (!amp) return;
    const { u, mask, n, _seed } = this;
    const v = periodicDrive(phase, wave) * amp;
    for (let i = 0; i < n; i++) {
      if (mask[i]) u[i] += v * _seed[i];
    }
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL: One FDTD leapfrog step.
  //
  //   Governing equation:  ∂²u/∂t² = c² ∇²u
  //   Leapfrog (Δx=Δy=Δt=1):  u_next = 2u - u_prev + c²·Lap(u)
  //   Damping applied as a multiplicative factor (linear dissipation):
  //     u_next *= damp
  //
  // NOTE: The damping factor `damp` is equivalent to a viscous damping term
  //   ∂u/∂t · γ where γ ≈ -ln(damp)/Δt. This is NOT a perfectly physical
  //   dissipation model (it does not arise from a boundary layer or volume
  //   absorption formulation), but it provides a stable, controllable proxy
  //   for energy decay. Classification: EMPIRICAL.
  //
  // SATURATION (fidelidad de físicas, 2026-09-03): antes esto era un corte
  //   duro (Math.min/max ±AMP_LIMIT) — no físico y, sobre todo, visible justo
  //   donde más importa: el pico de curvatura de una colisión entre ondas
  //   (la misma zona que ya lee la cáustica de curvatura, ver waveShade()).
  //   Ahora es una saturación suave tipo Stokes (AMP_LIMIT·tanh(v/AMP_LIMIT)):
  //   para |v| << AMP_LIMIT es indistinguible del régimen lineal (tanh(x)≈x),
  //   y se acerca asintóticamente al límite sin discontinuidad — más fiel a
  //   cómo satura de verdad una onda de superficie no lineal. Sigue siendo
  //   una safeguard, no un fenómeno derivado (por eso EMPIRICAL/HEURISTIC,
  //   no PHYSICAL), y sigue garantizando |u[i]| ≤ AMP_LIMIT y sin NaN/Infinity
  //   (los mismos tests de FASE 19 lo verifican). El clip counter ahora marca
  //   "cerca de saturar" (>98% del límite) en vez de "tocó el corte exacto".
  // ---------------------------------------------------------------------------
  step() {
    const { size, n, c, damp, mask, u, prev, next } = this;
    const c2       = c * c;
    const AMP_LIMIT = 5.0; // Non-physical saturation limit
    const CLIP_WATERMARK = AMP_LIMIT * 0.98;
    let   clipCount = 0;

    // FIX (auditoría 2026-09-08 — bloqueante 2D↔3D): esto era Dirichlet
    // (u=0 fuera de la máscara → autovalor Jₘ(ka)=0), incompatible con el
    // borde libre que ya usa cymatics.js (J'ₘ(ka)=0, superficie libre en
    // pared vertical — el borde correcto para agua en un recipiente de
    // paredes verticales, que es lo que la app dice simular). Con bordes
    // distintos, el mismo k y el mismo radio dan patrones con distinto
    // número de anillos: "las dos vistas coinciden" era imposible por
    // construcción.
    //
    // Reflexión de gradiente nulo (Neumann): cuando el vecino cae fuera de
    // la máscara, se usa el valor de LA PROPIA celda en vez de 0 — ese
    // término del Laplaciano se cancela exactamente (u[i]-u[i]=0), que es
    // la discretización estándar de ∂u/∂n=0 con una celda fantasma que
    // espeja el interior. No hace falta tocar cómo se guardan las celdas
    // exteriores (siguen en 0 para render()/computeEnergy(), que ya las
    // saltan) — el cambio es solo en qué ve el stencil de 4 vecinos.
    // Verificado (ver harness de esta auditoría): la resonancia fundamental
    // del FDTD pasó a corresponder al primer cero de J'₀ (3.8317), no al
    // de J₀ (2.4048).
    // --- Forward pass: compute u_next ---
    for (let y = 1; y < size - 1; y++) {
      const row = y * size;
      for (let x = 1; x < size - 1; x++) {
        const i = row + x;
        if (!mask[i]) { next[i] = 0; continue; }
        const lap =
          (mask[i - 1]    ? u[i - 1]    : u[i]) +
          (mask[i + 1]    ? u[i + 1]    : u[i]) +
          (mask[i - size] ? u[i - size] : u[i]) +
          (mask[i + size] ? u[i + size] : u[i]) -
          4 * u[i];
        next[i] = 2 * u[i] - prev[i] + c2 * lap;
      }
    }

    // --- Apply damping and rotate buffers ---
    for (let i = 0; i < n; i++) {
      if (mask[i]) {
        const raw = next[i] * damp;
        const v = AMP_LIMIT * Math.tanh(raw / AMP_LIMIT);
        if (Math.abs(raw) > CLIP_WATERMARK) clipCount++;
        prev[i] = u[i];
        u[i]    = v;
      } else {
        u[i]    = 0;
        prev[i] = 0;
        next[i] = 0;
      }
    }

    this._clipCount = clipCount;
    this._stepCount++;

    // FIX (auditoría 2026-09-08 — modo pistón): el Laplaciano con borde
    // Neumann puro tiene espacio nulo (u=constante, ω=0 — ver la nota en
    // setCircle() sobre por qué _seed necesita media cero). La semilla ya
    // corregida evita acoplar el forzado a ese modo desde el vamos, pero el
    // error de redondeo de punto flotante, acumulado paso a paso durante
    // sesiones largas, puede reintroducir una deriva lenta en la media —
    // nada que corrija el forzado (que ya es ortogonal al modo nulo) porque
    // no viene del forzado, viene del propio cálculo numérico. Restar la
    // media cada 60 pasos (~1s a la cadencia fija de stepWaveFields) la
    // mantiene en cero por las mismas razones físicas que motivan _seed sin
    // media (∫u dA = 0, volumen de agua fijo) — barato (una pasada lineal,
    // no cada frame) y aplicado a u Y prev juntos para no inventarle una
    // velocidad espuria a la corrección misma.
    if (this._stepCount % 60 === 0) {
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < n; i++) if (mask[i]) { sum += u[i]; cnt++; }
      if (cnt > 0) {
        const drift = sum / cnt;
        if (drift !== 0) {
          for (let i = 0; i < n; i++) {
            if (mask[i]) { u[i] -= drift; prev[i] -= drift; }
          }
        }
      }
    }

    // Update energy every 4 steps (performance: skip heavy inner loop each frame)
    if (this._stepCount % 4 === 0) {
      this._energy = this.computeEnergy();
    }
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL: Total wave energy estimate on the discrete grid.
  //   KE ≈ (1/2) Σ_interior (u[i] - prev[i])²    [velocity² proxy, Δt=1]
  //   PE ≈ (1/2) c² Σ_interior [(Δ_x u)² + (Δ_y u)²]  [gradient² proxy]
  //   E_total = KE + PE
  //
  // Under pure damping (no sources) this should decay as:
  //   E(t) ≈ E₀ · damp^(2t)  (since amplitude decays as damp^t)
  // ---------------------------------------------------------------------------
  computeEnergy() {
    const { size, n, c, mask, u, prev } = this;
    const c2 = c * c;
    let ke = 0;
    let pe = 0;
    for (let y = 1; y < size - 1; y++) {
      const row = y * size;
      for (let x = 1; x < size - 1; x++) {
        const i = row + x;
        if (!mask[i]) continue;
        const vel = u[i] - prev[i];  // Δu/Δt approximation
        ke += vel * vel;
        // Central difference gradient approximation
        const gx = mask[i + 1] ? (u[i + 1] - u[i - 1]) * 0.5 : 0;
        const gy = mask[i + size] ? (u[i + size] - u[i - size]) * 0.5 : 0;
        pe += gx * gx + gy * gy;
      }
    }
    return 0.5 * ke + 0.5 * c2 * pe;
  }

  // ---------------------------------------------------------------------------
  // PHYSICAL/DERIVED: Return physics metrics for external monitoring/HUD.
  // All values here are either rigorously derived (CFL) or explicitly labeled.
  // ---------------------------------------------------------------------------
  getPhysicsMetrics() {
    return {
      // PHYSICAL: CFL number. Must be < 1 for stability. 
      //   CFL = c · sqrt(2) for 2D FDTD with 4-point stencil.
      cfl: this._cfl,
      // PHYSICAL (APPROXIMATE): total wave energy on grid.
      energy: this._energy,
      // DERIVED: theoretical energy decay rate per step from the damping factor.
      //   E(t) ~ damp^(2t) so rate = -2 * ln(damp) per step.
      theoreticalDampRate: -2 * Math.log(this.damp),
      // DIAGNOSTIC: if > 0, amplitude clamping occurred this step (non-physical).
      clipCount: this._clipCount,
      // PHYSICAL: wave speed parameter
      c: this.c,
      // SIMULATION: total steps taken since last reset
      stepCount: this._stepCount,
    };
  }

  // ---------------------------------------------------------------------------
  // VISUAL: Render wave amplitude to offscreen canvas pixels.
  //   This is a purely artistic mapping: wave amplitude → pixel color/brightness.
  //   The gain (2.6×) and brightness curve are HEURISTIC choices for visual clarity.
  //   Classification: VISUAL
  // ---------------------------------------------------------------------------
  render([r, g, b]) {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width  = this.size;
      this.canvas.height = this.size;
      this.ctx = this.canvas.getContext('2d');
      this.img = this.ctx.createImageData(this.size, this.size);
    }
    const { u, mask, img, soft, size } = this;
    const d = img.data;
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      if (!mask[i]) {
        d[o] = d[o + 1] = d[o + 2] = 0;
        d[o + 3] = 0;
        continue;
      }
      // VISUAL: Amplitude → brightness mapping (heuristic gain).
      const v = u[i] * 2.6;
      // Curvatura local (mismo stencil de 4 vecinos que step(), recalculado
      // acá — nunca toca step()/prev/next): alimenta el destello de cáustica
      // en waveShade(). setCircle() garantiza margen ≥1 celda del borde de la
      // grilla para toda celda con mask=1, así que los índices ±1/±size son
      // siempre válidos sin chequeo extra.
      const lap =
        (mask[i - 1] ? u[i - 1] : 0) +
        (mask[i + 1] ? u[i + 1] : 0) +
        (mask[i - size] ? u[i - size] : 0) +
        (mask[i + size] ? u[i + size] : 0) -
        4 * u[i];
      const { bri, glow } = waveShade(v, lap);
      let cr = r * bri;
      let cg = g * bri;
      let cb = b * bri;
      if (glow > 0) {
        cr += (255 - cr) * glow;
        cg += (255 - cg) * glow;
        cb += (255 - cb) * glow;
      }
      d[o]     = cr > 255 ? 255 : cr;
      d[o + 1] = cg > 255 ? 255 : cg;
      d[o + 2] = cb > 255 ? 255 : cb;
      // VISUAL: Soft alpha falloff at circular boundary.
      d[o + 3] = soft ? Math.round(255 * soft[i]) : 255;
    }
    this.ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}
