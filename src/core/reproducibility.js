// src/core/reproducibility.js
// Phase 12: Reproducibility
//
// Every simulation run can be fully reconstructed from the triple:
//   (SimulationSeed, SimulationConfig, ModelVersion)
//
// - SimulationSeed: a single uint32 that seeds every stochastic source
//   (EEG pink noise, asymmetry, blinks, ...).
// - SimulationConfig: the full, validated parameter set that governs the run
//   (stimulus + model parameters). Canonical JSON so two runs that differ only
//   in key order are still byte-identical.
// - ModelVersion: the version of the reduced-order model itself. Bumping this
//   invalidates old experiment records on purpose.
//
// Experiment records are plain JSON (Fase 14) and can be re-run by feeding the
// stored seed + config back into the SimulationEngine.

export const MODEL_VERSION = 'bineural-reduced-order-v2';

// mulberry32: small, fast, deterministic 32-bit PRNG.
// Same stream for the same seed on any platform (pure integer math).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WAVEFORMS = ['sine', 'triangle', 'sawtooth', 'square'];
export const CONDITIONS = ['binaural', 'pure-tone', 'noise', 'amplitude-modulation', 'none'];

export class SimulationSeed {
  constructor(seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) {
    this.seed = seed >>> 0;
  }
  rng() {
    return mulberry32(this.seed);
  }
  toJSON() {
    return { seed: this.seed, modelVersion: MODEL_VERSION };
  }
}

export class SimulationConfig {
  /**
   * @param {object} p
   * @param {number} [p.carrier=220]      Carrier frequency (Hz), 1–20000.
   * @param {number} [p.beat=10]          Binaural beat (Δf, Hz), 0–500.
   * @param {string} [p.waveform='sine']  Oscillator waveform.
   * @param {string} [p.condition='binaural']  Experimental condition label.
   * @param {number} [p.durationSec=300]  Planned session duration (seconds), >= 0.
   * @param {number} [p.volume=0.6]       Master gain, 0–1.
   * @param {object|null} [p.modelParams] Reduced-order neural model parameters.
   */
  constructor({
    carrier = 220,
    beat = 10,
    waveform = 'sine',
    condition = 'binaural',
    durationSec = 300,
    volume = 0.6,
    modelParams = null,
  } = {}) {
    this.carrier = SimulationConfig._validateNum('carrier', carrier, 1, 20000);
    this.beat = SimulationConfig._validateNum('beat', beat, 0, 500);
    if (!WAVEFORMS.includes(waveform)) {
      throw new Error(`[CONFIG] waveform "${waveform}" not in ${WAVEFORMS.join(', ')}`);
    }
    if (!CONDITIONS.includes(condition)) {
      throw new Error(`[CONFIG] condition "${condition}" not in ${CONDITIONS.join(', ')}`);
    }
    this.waveform = waveform;
    this.condition = condition;
    this.durationSec = SimulationConfig._validateNum('durationSec', durationSec, 0, 86400);
    this.volume = SimulationConfig._validateNum('volume', volume, 0, 1);
    this.modelParams = modelParams ? { ...modelParams } : null;
    Object.freeze(this);
  }

  static _validateNum(name, val, min, max) {
    if (typeof val !== 'number' || !isFinite(val)) {
      throw new Error(`[CONFIG] ${name} must be a finite number, got ${val}`);
    }
    if (val < min || val > max) {
      throw new Error(`[CONFIG] ${name} out of range [${min}, ${max}]: ${val}`);
    }
    return val;
  }

  /** Canonical plain-object form: stable key order → byte-identical JSON. */
  canonical() {
    return {
      carrier: this.carrier,
      beat: this.beat,
      waveform: this.waveform,
      condition: this.condition,
      durationSec: this.durationSec,
      volume: this.volume,
      modelParams: this.modelParams,
    };
  }

  toJSON() {
    return this.canonical();
  }

  /** Derive left/right ear frequencies (pure derivation of the stimulus). */
  earFrequencies() {
    return {
      left: this.carrier,
      right: this.carrier + this.beat,
      difference: this.beat, // PHYSICAL: Δf, not yet the perceptual beat
    };
  }
}

/**
 * Phase 14: assemble a full experiment record as plain JSON.
 * Every section is labeled by its provenance class (see docs/audit.md):
 *   stimulus  → PHYSICAL
 *   neural    → NEURAL / SIMULATED
 *   eeg       → SIMULATED
 *   cognitive → ESTIMATED (with confidence)
 *   physics   → DERIVED
 *   visual    → VISUAL (heuristic metaphor)
 *
 * @param {object} opts
 * @param {SimulationConfig} opts.config
 * @param {SimulationSeed} opts.seed
 * @param {object} [opts.results] Optional recorded end-state snapshots.
 * @returns {object} JSON-serializable experiment record.
 */
export function buildExperimentRecord({ config, seed, results = null }) {
  return {
    modelVersion: MODEL_VERSION,
    seed: seed.seed,
    config: config.canonical(),
    recordedAt: new Date().toISOString(),
    results,
  };
}

/** Serialize an experiment record to a pretty JSON string (for .json export). */
export function experimentToJson(record) {
  return JSON.stringify(record, null, 2);
}
