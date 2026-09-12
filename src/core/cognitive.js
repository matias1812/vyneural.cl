// src/core/cognitive.js
// Cognitive State Model — Phase 9: Continuous State Variables with Feedback
//
// Maps the Neural Entrainment State (Phase 6) to phenomenological psychological
// variables (arousal, attention, relaxation, flow) using:
//   1. Mutual inhibition: arousal and relaxation are anticorrelated via a
//      soft mutual suppression term (high arousal suppresses relaxation and
//      vice versa). NOTE (fix 2026-09-06): this used to be labeled
//      "Yerkes-Dodson constraint" — Yerkes-Dodson is the inverted-U between
//      arousal and PERFORMANCE, not an arousal↔relaxation restriction. The
//      mechanism itself (mutual inhibition) is a reasonable model; only the
//      name was wrong.
//   2. EEG band-derived updates: arousal tracks beta/gamma power; relaxation
//      tracks slow-band (delta/theta/alpha) dominance over fast (beta/gamma);
//      attention is a weighted sum of task-relevant band power (theta/alpha/
//      beta/gamma), penalized by delta. NOTE: this weighted sum is NOT
//      "cross-band coherence" in the EEG sense (a phase-synchrony measure
//      between channels) — it never was, despite the old comment; it's a
//      power-based heuristic and is labeled as such in the HUD.
//   3. Flow as an emergent attractor (NOT a controllable target):
//      Flow = high attention × moderate arousal × moderate relaxation.
//      This emerges only when the brain has been in the Theta/Alpha border for
//      sustained time without high fatigue.
//   4. Confidence intervals: grow with stimulus duration and decay with masking/fatigue.
//
// Scientific disclaimer:
//   These equations are simplified dynamical models inspired by the psychophysiology
//   literature. They are NOT validated biomarkers and should not be interpreted as
//   direct measurements of any individual's cognitive state.

import { CognitiveState } from './states.js';
import { assertBounds } from '../validation/assert.js';

export class CognitiveStateModel {
  constructor() {
    this.state = new CognitiveState();
    this.params = null;
    // Phase 9: Time-on-task (for flow emergence: requires sustained effort)
    this._timeOnTask = 0;
  }

  setProfile(profileParams) {
    this.params = profileParams;
    this._timeOnTask = 0;
    // Reset confidence on profile change (new stimulus = new uncertainty)
    this.state.arousal.confidence    = 0;
    this.state.attention.confidence  = 0;
    this.state.relaxation.confidence = 0;
    this.state.flow.confidence       = 0;
  }

  update(dt, isPlaying, neuralState) {
    if (!this.params) return;

    if (!isPlaying) {
      // Relax all variables towards baseline slowly
      const relaxRate = dt * 0.04;
      this.state.arousal.value    += (0.5 - this.state.arousal.value)    * relaxRate;
      this.state.attention.value  += (0.5 - this.state.attention.value)  * relaxRate;
      this.state.relaxation.value += (0.5 - this.state.relaxation.value) * relaxRate;
      this.state.flow.value       += (0.0 - this.state.flow.value)       * relaxRate;
      // Confidence decays when not playing
      this.state.arousal.confidence    *= (1 - dt * 0.03);
      this.state.attention.confidence  *= (1 - dt * 0.03);
      this.state.relaxation.confidence *= (1 - dt * 0.03);
      this.state.flow.confidence       *= (1 - dt * 0.03);
      this._timeOnTask = Math.max(0, this._timeOnTask - dt * 0.5);
      return;
    }

    this._timeOnTask += dt;

    // ── 1. Extract neural signals ───────────────────────────────────────────
    const adapt  = neuralState.adaptation;   // [0,1] habituation factor
    const fatigue = neuralState.fatigue;     // [0,1] metabolic cost
    // Band powers from the Phase 6 Gaussian mapping
    const delta = neuralState.delta ?? 0;
    const theta = neuralState.theta ?? 0;
    const alpha = neuralState.alpha ?? 0;
    const beta  = neuralState.beta  ?? 0;
    const gamma = neuralState.gamma ?? 0;
    // Current dominant frequency from entrainment model (published by
    // NeuralStateModel on the state object itself — no back-reference needed).
    const f = neuralState.dominantFreq ?? 10;
    this.state.dominantFreq = f;


    // ── 2. EEG-derived targets for this frame ───────────────────────────────
    // These are the instantaneous "pulls" derived from the actual neural band
    // state. They are NOT the profile targets — they are dynamically computed.
    //
    // Arousal target: driven by high-frequency activation (beta + gamma).
    // Scales with profile target but gated by actual band power.
    const tArousal = this.params.targetArousal * (0.3 + 0.7 * (beta + gamma * 0.5));

    // FIX (auditoría 2026-09-06): "relajación = alfa pura" condenaba a
    // mínima relajación a cualquier preset que NO tuviera el beat cerca de
    // 10 Hz — es decir, justo Meditación (6 Hz, Theta) y Sueño profundo
    // (2 Hz, Delta), los presets "relajantes" que más vende la app (medido:
    // Meditación reportaba target efectivo ≈0.07 con el perfil pidiendo
    // 0.8). Redefinido como dominancia de bandas lentas sobre rápidas: así
    // Theta y Delta SÍ cuentan como relajación, no solo Alfa.
    const slowPower = delta * 0.8 + theta + alpha;
    const fastPower = beta + gamma;
    const tRelaxation = this.params.targetRelaxation * (slowPower / (slowPower + fastPower + 1e-6));

    // FIX (auditoría 2026-09-06): "atención = theta+alpha" tenía el defecto
    // simétrico al de relajación — Concentración y Aprendizaje (Beta/Gamma)
    // tenían theta+alpha en ~0 y jamás podían reportar atención alta pase lo
    // que pida el perfil. Ahora participan todas las bandas de tarea
    // (Klimesch et al., 1999 — atención sostenida en Theta/Alpha border —
    // más Beta/Gamma para las tareas activas) y Delta (somnolencia) resta.
    const taskPower = theta * 0.4 + alpha * 0.3 + (beta + gamma) * 0.6;
    const tAttention = this.params.targetAttention * Math.max(0, Math.min(1, 0.3 + 0.7 * taskPower - delta * 0.4));

    // ── 3. Habituación con piso + constante de seguimiento fija ─────────────
    // FIX DE FONDO (auditoría 2026-09-06): el bug que colapsaba TODA sesión
    // larga a cero. kBase=0.025*E multiplicaba el arrastre hacia el target,
    // pero las pérdidas de más abajo (fatiga, inhibición mutua) NO escalaban
    // con E — al habituarse el estímulo (E→0 por adapt=exp(-t/tau)→0), el
    // arrastre se apagaba pero las pérdidas seguían restando indefinidamente,
    // y las tres variables convergían a 0 sin importar el preset (medido:
    // Meditación 40min → relax 0.07/target 0.8, arousal y attn en 0.00).
    //
    // Rediseño: el TARGET efectivo se desvanece hacia el basal (0.5) a
    // medida que el estímulo se habitúa — "habituarse" pasa a significar
    // "el efecto vuelve a lo basal", no "la variable se va a cero" — y el
    // seguimiento usa una constante FIJA (no depende de E), así el sistema
    // nunca se queda sin fuerza de arrastre.
    //
    // SUSTAINED_EFFECT_FRACTION evita que, pasados ~30-40 min, TODOS los
    // perfiles terminen indistinguibles en el mismo basal (el mismo bug de
    // fondo, solo que en 0.5 en vez de 0). Mide la fracción del efecto del
    // preset que sobrevive a la habituación COMPLETA (adapt→0): a mayor
    // valor, más se conserva el extremo pedido por el perfil; a menor
    // valor, MÁS se comprime hacia 0.5 (es multiplicativo sobre la
    // desviación del basal — bajarlo reduce el rango expresable, no lo
    // aumenta). Deliberadamente NO se llama ADAPT_FLOOR como el de
    // neural.js: ese limita una VELOCIDAD de convergencia (cualquier valor
    // > 0 termina llegando al objetivo, solo cambia cuándo); este fija una
    // AMPLITUD asintótica (el valor final). Incluso con el mismo nombre no
    // serían intercambiables — el choque léxico era una trampa para el
    // próximo que los lea juntos.
    //
    // 0.5 es el punto neutro ("sobrevive la mitad del efecto") y es el
    // único valor verificado de punta a punta en este archivo — no hay
    // dato empírico que prefiera otro número sobre este. Lo que SÍ lo
    // calibraría: intensidad subjetiva autorreportada al final de sesiones
    // de duración variable, comparada contra la reportada a los 5 min de
    // la misma sesión. Sin ese dato, cualquier valor es igualmente
    // defendible — de ahí que el HUD deba seguir etiquetando esto como
    // heurístico, no como validado.
    //
    // Pendiente de mayor alcance (no resuelto acá): el basal al que decae
    // TODO desvanece hacia 0.5 para TODOS los perfiles por igual. Para un
    // preset de sueño eso es cuestionable en su premisa — a los 40 min el
    // usuario probablemente está durmiendo, o sea que su arousal real bajó
    // MÁS, no volvió al centro. La habituación al estímulo y el estado real
    // del usuario apuntan en direcciones opuestas ahí. Arreglarlo bien
    // requeriría que el basal dependa del perfil, no una constante global
    // — no tocarlo sin datos para calibrar esas basales por separado.
    const SUSTAINED_EFFECT_FRACTION = 0.5;
    const K_TRACK = 1 / 50; // s⁻¹ — τ ≈ 50s

    const presence = SUSTAINED_EFFECT_FRACTION + (1 - SUSTAINED_EFFECT_FRACTION) * adapt;
    const effArousalRaw    = 0.5 + (tArousal    - 0.5) * presence;
    const effAttentionRaw  = 0.5 + (tAttention  - 0.5) * presence;
    const effRelaxationRaw = 0.5 + (tRelaxation - 0.5) * presence;

    // ── 4. Inhibición mutua (Yerkes-Dodson mal citado en el nombre original:
    // Yerkes-Dodson es la U invertida arousal↔rendimiento, no una restricción
    // arousal↔relajación — el mecanismo real implementado es inhibición
    // mutua simple, que sí es razonable como modelo) + fatiga. Aplicadas
    // como corrección MULTIPLICATIVA al target (acotada en [0,1] por
    // construcción) en vez de como resta abierta a la derivada — así no
    // pueden generar una fuga que sobreviva aunque el arrastre se apague,
    // que es exactamente el bug de arriba.
    const arousalNow = this.state.arousal.value;
    const relaxNow   = this.state.relaxation.value;
    const inhibition = 0.3;
    const effArousal    = effArousalRaw    * (1 - relaxNow   * inhibition) * (1 - fatigue * 0.3);
    const effRelaxation = effRelaxationRaw * (1 - arousalNow * inhibition);
    const effAttention  = effAttentionRaw  * (1 - fatigue * 0.5);

    // ── 5. Differential updates ─────────────────────────────────────────────
    const dArousal    = (effArousal    - arousalNow)                 * K_TRACK * dt;
    const dAttention  = (effAttention  - this.state.attention.value) * K_TRACK * dt;
    const dRelaxation = (effRelaxation - relaxNow)                   * K_TRACK * dt;

    this.state.arousal.value    = assertBounds(this.state.arousal.value    + dArousal,    0, 1, 'Cognitive Arousal');
    this.state.attention.value  = assertBounds(this.state.attention.value  + dAttention,  0, 1, 'Cognitive Attention');
    this.state.relaxation.value = assertBounds(this.state.relaxation.value + dRelaxation, 0, 1, 'Cognitive Relaxation');

    // ── 6. Flow: emergent attractor (not a target) ──────────────────────────
    // Flow requires simultaneously: high attention, moderate arousal (0.3-0.7),
    // moderate relaxation (0.3-0.7), low fatigue, sustained time on task (>60s).
    //
    // Formula: flow = attention × bell(arousal) × bell(relaxation) × timeBonus
    //   where bell(x) = exp(-((x - 0.5) / 0.25)²) peaks at x=0.5.
    const bell = (x) => Math.exp(-Math.pow((x - 0.5) / 0.25, 2));
    const timeBonus = Math.min(1.0, this._timeOnTask / 120); // full after 2 min
    const flowPotential =
      this.state.attention.value *
      bell(this.state.arousal.value) *
      bell(this.state.relaxation.value) *
      (1 - fatigue * 0.8) *
      timeBonus;

    // Flow is a slow state: it takes time to enter and time to leave.
    // Use a slow EMA (τ ≈ 30s) so it doesn't flicker.
    const kFlow = 1 - Math.exp(-dt / 30);
    this.state.flow.value = assertBounds(
      this.state.flow.value + (flowPotential - this.state.flow.value) * kFlow,
      0, 1, 'Cognitive Flow'
    );

    // ── 7. Confidence intervals ─────────────────────────────────────────────
    // Confidence grows with sustained exposure to an effective stimulus.
    // NOTA (revisión externa 2026-09-06): esto usaba la E original
    // (adapt*(1-fatigue*0.6)), que quedó huérfana cuando el acoplamiento de
    // arriba pasó a usar `presence` (con piso ADAPT_FLOOR) — con adapt→0 en
    // sesiones largas, confRate caía a 0 y la confianza quedaba congelada
    // para siempre a partir de los ~20 min. Ahora sigue `presence`, con el
    // mismo piso que ya tiene el resto del modelo: deliberado, no residual.
    const confRate = dt * 0.015 * presence;
    this.state.arousal.confidence    = Math.min(1.0, this.state.arousal.confidence    + confRate);
    this.state.attention.confidence  = Math.min(1.0, this.state.attention.confidence  + confRate * 0.8);
    this.state.relaxation.confidence = Math.min(1.0, this.state.relaxation.confidence + confRate * 0.8);
    this.state.flow.confidence       = Math.min(1.0, this.state.flow.confidence       + confRate * 0.3);
  }

  getState() {
    return this.state;
  }
}
