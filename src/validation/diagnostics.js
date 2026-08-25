// src/validation/diagnostics.js
// Scientific validation suite for Bineural V2 (Phase 11).
// Run headless:  npm test   (node scripts/run-diagnostics.mjs)
// Run in browser: window.runBineuralDiagnostics() in the console.
// Documentación: docs/validation.md

import { NeuralStateModel } from '../core/neural.js';
import { CognitiveStateModel } from '../core/cognitive.js';
import { EegInterface } from '../core/eeg.js';
import { NeuralToVisualMapper } from '../core/visual.js';
import { evaluateAudioHealth } from '../core/audio-health.js';
import { ExperimentRunner, conditionProfile } from '../core/experiments.js';
import { assertValidState, assertValidNeuralState, assertValidCognitiveState, assertPhysicalFrequency } from './assert.js';
import { getProfileById, PROFILES } from '../models/profiles.js';
import { SimulationConfig, SimulationSeed, buildExperimentRecord, MODEL_VERSION, mulberry32 } from '../core/reproducibility.js';
import { WaveField } from '../wavefield.js';
import { buildSilentWav, ANCHOR_SECONDS } from '../core/media-anchor.js';
import {
  evaluatePermissions,
  notifStateText,
  wakeStateText,
  enabledStateText,
} from '../core/permissions.js';
import { AudioClock } from '../core/audio-clock.js';
import { AppLifecycle, LIFECYCLE_STATES } from '../core/lifecycle.js';
import { ExperimentEventLog } from '../core/experiment-events.js';
import { probeCapabilities } from '../core/capabilities.js';
import { AudioTransport } from '../core/audio-transport.js';
import { planRecovery, RECOVERY } from '../core/audio-health.js';
import { AlarmManager, inMemoryAlarmStore, alarmStateOnTick, alarmOwnerForPlatform } from '../core/alarm-manager.js';
// P2 — endurecimiento UNKNOWN: contrato puro de la política de audio focus
// (held = operacional, Diagnostics = observabilidad; DUCK mantiene el foco).
import { focusPolicy, shouldRequestFocus, FOCUS_STATES } from '../core/audio-focus-policy.js';
// P3 — sanitización de datos persistidos (crash recovery / corrupción).
import { sanitizeSession, sanitizeFavorites, sanitizeHistory } from '../core/session-store.js';
import { detectNotificationCapabilities, capabilitySummary } from '../core/notification-capabilities.js';
// P4 — contrato de plataforma: parseo del bridge (string crudo vs wrapper) y
// dueño único por perfil (Web/PWA = runtime web · APK = runtime Android).
import { parseBridgeResponse } from '../platform/native-bridge.js';
// P0 — Separación Core / Platform (plan APK): bridge nativo y fusión de
// capacidades. Se testean con bridge inyectado y sin él (la web debe seguir
// funcionando idéntica cuando no hay APK).
import { detectNativeBridge, validateCommand, createNativeBridgeAdapter, BRIDGE_COMMANDS } from '../platform/native-bridge.js';
import { mergePlatformCapabilities, detectPlatformKind } from '../platform/platform-capabilities.js';
// P1.5 Fase 5 — proveedor único de audio (WEB | NATIVE | NONE).
import { selectAudioProvider, assertSingleAudioProvider, providerLabel } from '../core/audio-provider.js';
// P2 Fase 1 — máquina de estados central del audio.
import { AudioStateMachine, AUDIO_STATES, AUDIO_EVENTS } from '../core/audio-state.js';
import { createNotificationManager } from '../core/notification-manager.js';
// P1 — forense de duplicación de audio: motor real con contexto fake, gate de
// restore y política de cancelación de automation.
import { BinauralEngine } from '../audio.js';
import { RestoreGate } from '../core/restore-gate.js';
import { to24h, from24h } from '../ui/apk-time-picker.js';
import { muteMasterGain, restoreMasterGain, setParamValueCancelingAutomation } from '../core/audio-automation.js';
// P5.4 — anillo causal puro (responder "¿qué emitió el primer PLAY?").
import { createCausalLog } from '../core/causal-log.js';
// P5.2 — contrato del protocolo ÚNICO Web→Nativo (PLAY/PAUSE/STOP simétricos).
import {
  nativePlayCommand,
  nativePauseCommand,
  nativeStopCommand,
  NativeCommandCoalescer,
} from '../core/native-protocol.js';

export async function runBineuralDiagnostics() {
  console.group('%c BINEURAL V2 DIAGNOSTICS ', 'background: #222; color: #bada55');
  console.log('Running Scientific Validation Suite...');
  
  let passed = 0;
  let failed = 0;
  const pending = [];

  // Soportar tests síncronos y asíncronos: los asíncronos (p. ej. AlarmManager
  // con IndexedDB/memoria) resuelven después; el resumen espera a todos.
  async function runTest(name, testFn) {
    const p = (async () => {
      try {
        await testFn();
        console.log(`%c[PASS] %c${name}`, 'color: #4ade80', 'color: inherit');
        passed++;
      } catch (err) {
        console.error(`%c[FAIL] %c${name}`, 'color: #f87171', 'color: inherit', err.message);
        failed++;
      }
    })();
    pending.push(p);
    return p;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // NEURAL MODEL TESTS
  // ──────────────────────────────────────────────────────────────────────────

  runTest('NeuralStateModel: Bounds are strictly enforced under high fatigue', () => {
    const model = new NeuralStateModel();
    const profile = getProfileById('concentracion');
    model.setProfile(profile.modelParams);
    model.state.fatigue = 0.99; // Phase 1: state is a NeuralState object
    for (let i = 0; i < 36000; i++) {
      model.update(1.0, true);
    }
    const state = model.getState();
    if (state.fatigue < 0 || state.fatigue > 1) {
      throw new Error(`fatigue out of bounds: ${state.fatigue}`);
    }
    if (state.adaptation < 0 || state.adaptation > 1) {
      throw new Error(`adaptation out of bounds: ${state.adaptation}`);
    }
  });

  runTest('NeuralStateModel: Adaptation converges to near-zero (habituation)', () => {
    const model = new NeuralStateModel();
    const profile = getProfileById('meditacion');
    model.setProfile(profile.modelParams);
    // Entrainment branch (isPlaying=true, target beat=6 Hz) with realistic dt.
    // Adaptation H(t)=exp(-t/tau); tau=300s → need t ≈ 1400s for H < 0.01.
    for (let i = 0; i < 20000; i++) {
      model.update(0.1, true, 1.0, 6);
    }
    const state = model.getState();
    if (state.adaptation > 0.01) {
      throw new Error(`Adaptation failed to converge near zero. Value: ${state.adaptation}`);
    }
  });

  runTest('NeuralStateModel: deterministic under identical params and dt sequence', () => {
    const profile = getProfileById('sueno');
    const a = new NeuralStateModel();
    const b = new NeuralStateModel();
    a.setProfile(profile.modelParams);
    b.setProfile(profile.modelParams);
    for (let i = 0; i < 2000; i++) {
      a.update(0.016, true, 0.9, 2);
      b.update(0.016, true, 0.9, 2);
    }
    const sa = a.getState();
    const sb = b.getState();
    for (const k of ['delta', 'theta', 'alpha', 'beta', 'gamma', 'fatigue', 'adaptation', 'dominantFreq']) {
      if (sa[k] !== sb[k]) {
        throw new Error(`Neural model not deterministic on field ${k}: ${sa[k]} vs ${sb[k]}`);
      }
    }
  });

  runTest('NeuralStateModel: dominantFreq is published and bounded (4–40 Hz)', () => {
    const model = new NeuralStateModel();
    model.setProfile(getProfileById('meditacion').modelParams);
    for (let i = 0; i < 5000; i++) model.update(0.016, true, 1.0, 6);
    const f = model.getState().dominantFreq;
    if (!isFinite(f) || f < 4 || f > 40) {
      throw new Error(`dominantFreq out of plausible range: ${f}`);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AUDIO / STIMULUS TESTS
  // ──────────────────────────────────────────────────────────────────────────

  runTest('Audio Physics: Carrier and Beat frequencies are strictly positive', () => {
    const profile = getProfileById('sueno');
    assertPhysicalFrequency(profile.stimulus.carrierBase, 'Carrier Base');
    assertPhysicalFrequency(profile.stimulus.beat, 'Beat Frequency');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // WAVEFIELD PHYSICS TESTS (Phase 2)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('WaveField: CFL number is < 1 (numerically stable)', () => {
    const wf = new WaveField(64, { c: 0.4 });
    const { cfl } = wf.getPhysicsMetrics();
    if (cfl >= 1) {
      throw new Error(`CFL = ${cfl.toFixed(4)} ≥ 1. Grid is numerically UNSTABLE.`);
    }
  });

  runTest('WaveField: CFL clamping fires when c > 1/√2', () => {
    // Pass an unsafe c — constructor should clamp it to the stability limit.
    const wf = new WaveField(64, { c: 0.9 });
    if (wf.c !== 1 / Math.SQRT2) {
      throw new Error(`Constructor did not clamp c. Got c=${wf.c}`);
    }
    const { cfl } = wf.getPhysicsMetrics();
    // At the exact boundary cfl == 1 mathematically; allow float precision.
    if (cfl > 1 + 1e-12) {
      throw new Error(`CFL = ${cfl.toFixed(6)} > 1 even after clamping. Bug in constructor.`);
    }
  });

  runTest('WaveField: Energy is zero in a quiescent grid', () => {
    const wf = new WaveField(64, { c: 0.4 });
    wf.setCircle(32, 32, 28);
    const E = wf.computeEnergy();
    if (E !== 0) {
      throw new Error(`Expected E=0 in quiescent grid, got E=${E}`);
    }
  });

  runTest('WaveField: Impulse creates positive energy', () => {
    const wf = new WaveField(64, { c: 0.4 });
    wf.setCircle(32, 32, 28);
    wf.pokeDisc(32, 32, 1.0);
    const E = wf.computeEnergy();
    if (E <= 0) {
      throw new Error(`Expected E > 0 after impulse, got E=${E}`);
    }
  });

  runTest('WaveField: Energy decays monotonically under damping (no sources)', () => {
    const wf = new WaveField(64, { c: 0.4, damp: 0.99 });
    wf.setCircle(32, 32, 28);
    wf.pokeDisc(32, 32, 1.0);

    const samples = [];
    // Run 200 steps and sample energy every 20 steps
    for (let s = 0; s < 200; s++) {
      wf.step();
      if (s % 20 === 0) samples.push(wf.computeEnergy());
    }

    // Energy must be monotonically non-increasing (allow tiny float noise)
    for (let i = 1; i < samples.length; i++) {
      if (samples[i] > samples[i - 1] * 1.02) { // 2% tolerance for numerical noise
        throw new Error(
          `Energy increased from ${samples[i-1].toFixed(6)} to ${samples[i].toFixed(6)} ` +
          `at sample ${i}. Damping is not working correctly.`
        );
      }
    }
  });

  runTest('WaveField: No NaN or Infinity in field after 300 steps', () => {
    const wf = new WaveField(64, { c: 0.4, damp: 0.995 });
    wf.setCircle(32, 32, 28);
    wf.pokeDisc(20, 20, 2.0);
    wf.pokeDisc(44, 44, 1.5);
    for (let s = 0; s < 300; s++) wf.step();
    for (let i = 0; i < wf.n; i++) {
      if (!isFinite(wf.u[i])) {
        throw new Error(`NaN or Infinity found at cell ${i} after 300 steps.`);
      }
    }
  });

  runTest('WaveField: Amplitude stays within clamping limits after strong pulse', () => {
    const AMP_LIMIT = 5.0;
    const wf = new WaveField(64, { c: 0.4, damp: 0.995 });
    wf.setCircle(32, 32, 28);
    wf.pokeDisc(32, 32, 100.0); // Extreme pulse
    for (let s = 0; s < 50; s++) wf.step();
    for (let i = 0; i < wf.n; i++) {
      if (Math.abs(wf.u[i]) > AMP_LIMIT + 1e-6) {
        throw new Error(`Amplitude ${wf.u[i]} exceeds clamp limit at cell ${i}.`);
      }
    }
  });

  runTest('WaveField: Dirichlet BC — boundary cells remain zero', () => {
    const SIZE = 64;
    const wf = new WaveField(SIZE, { c: 0.4, damp: 0.995 });
    wf.setCircle(32, 32, 28);
    wf.pokeDisc(32, 32, 1.0);
    for (let s = 0; s < 100; s++) wf.step();
    // Cells at grid edge (row 0, row N-1, col 0, col N-1) must be 0
    for (let x = 0; x < SIZE; x++) {
      if (wf.u[x] !== 0)           throw new Error(`Top edge cell (${x},0) is non-zero.`);
      if (wf.u[(SIZE - 1) * SIZE + x] !== 0) throw new Error(`Bottom edge cell (${x},N-1) is non-zero.`);
    }
    for (let y = 0; y < SIZE; y++) {
      if (wf.u[y * SIZE] !== 0)          throw new Error(`Left edge cell (0,${y}) is non-zero.`);
      if (wf.u[y * SIZE + SIZE - 1] !== 0) throw new Error(`Right edge cell (N-1,${y}) is non-zero.`);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AUDIO / STIMULUS DERIVATION (Phase 4)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('Audio Physics: ear frequencies derive correctly (L=carrier, R=carrier+beat, Δf=beat)', () => {
    const cfg = new SimulationConfig({ carrier: 220, beat: 6 });
    const ears = cfg.earFrequencies();
    if (ears.left !== 220) throw new Error(`left ear: ${ears.left} ≠ 220`);
    if (ears.right !== 226) throw new Error(`right ear: ${ears.right} ≠ 226`);
    if (ears.difference !== 6) throw new Error(`Δf: ${ears.difference} ≠ 6`);
  });

  runTest('Audio Physics: all profiles carry physically valid carrier/beat', () => {
    for (const p of PROFILES) {
      assertPhysicalFrequency(p.stimulus.carrierBase, `Profile "${p.id}" carrier`);
      assertPhysicalFrequency(p.stimulus.beat, `Profile "${p.id}" beat`);
      if (p.modelParams) {
        for (const k of ['targetArousal', 'targetAttention', 'targetRelaxation']) {
          const v = p.modelParams[k];
          if (typeof v !== 'number' || v < 0 || v > 1) {
            throw new Error(`Profile "${p.id}" modelParams.${k} out of [0,1]: ${v}`);
          }
        }
        if (!(p.modelParams.habituationTau > 0)) {
          throw new Error(`Profile "${p.id}" habituationTau must be > 0`);
        }
      }
      if (p.visualMetaphor) {
        for (const k of ['complexity', 'coherence', 'velocityScale']) {
          const v = p.visualMetaphor[k];
          if (typeof v !== 'number' || v < 0 || v > 1) {
            throw new Error(`Profile "${p.id}" visualMetaphor.${k} out of [0,1]: ${v}`);
          }
        }
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // REPRODUCIBILITY (Phase 12)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('SimulationConfig: rejects out-of-range parameters', () => {
    let threw = false;
    try { new SimulationConfig({ beat: 0.05 }); } catch { threw = true; }
    if (!threw) throw new Error('beat=0.05 should be rejected');
    threw = false;
    try { new SimulationConfig({ waveform: 'superharsh' }); } catch { threw = true; }
    if (!threw) throw new Error('unknown waveform should be rejected');
  });

  runTest('SimulationConfig: canonical JSON is stable regardless of key order', () => {
    const a = new SimulationConfig({ carrier: 220, beat: 6, waveform: 'triangle' });
    const b = new SimulationConfig({ waveform: 'triangle', beat: 6, carrier: 220 });
    if (JSON.stringify(a.canonical()) !== JSON.stringify(b.canonical())) {
      throw new Error('Canonical configs differ despite identical params');
    }
  });

  runTest('mulberry32: deterministic and well-distributed', () => {
    const r1 = mulberry32(12345);
    const r2 = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const a = r1();
      if (a !== r2()) throw new Error('same seed diverged');
      if (a < 0 || a >= 1) throw new Error('PRNG out of [0,1)');
    }
    const r3 = mulberry32(999);
    if (r1() === r3()) throw new Error('different seeds produced same first draw');
  });

  runTest('Reproducibility: EEG streams identical under the same seed', () => {
    const neural = { delta: 0.3, theta: 0.2, alpha: 0.5, beta: 0.2, gamma: 0.1, fatigue: 0.1, adaptation: 0.9 };
    const a = new EegInterface({ seed: 42 });
    const b = new EegInterface({ seed: 42 });
    for (let i = 0; i < 1000; i++) {
      const sa = a.update(0.016, neural);
      const sb = b.update(0.016, neural);
      for (const k of ['delta', 'theta', 'alpha', 'beta', 'gamma', 'coherence', 'asymmetry']) {
        if (sa[k] !== sb[k]) {
          throw new Error(`EEG diverged on ${k} at step ${i}: ${sa[k]} vs ${sb[k]}`);
        }
      }
    }
  });

  runTest('Reproducibility: EEG streams differ under different seeds', () => {
    const neural = { delta: 0.3, theta: 0.2, alpha: 0.5, beta: 0.2, gamma: 0.1, fatigue: 0.1, adaptation: 0.9 };
    const a = new EegInterface({ seed: 1 });
    const b = new EegInterface({ seed: 2 });
    let differed = false;
    for (let i = 0; i < 500; i++) {
      const sa = a.update(0.016, neural);
      const sb = b.update(0.016, neural);
      if (sa.theta !== sb.theta) { differed = true; break; }
    }
    if (!differed) throw new Error('different seeds produced identical streams');
  });

  runTest('ExperimentRecord: JSON includes modelVersion, seed and canonical config', () => {
    const cfg = new SimulationConfig({ carrier: 220, beat: 6 });
    const seed = new SimulationSeed(12345);
    const rec = buildExperimentRecord({ config: cfg, seed, results: { neural: { alpha: 0.4 } } });
    const json = JSON.parse(JSON.stringify(rec));
    if (json.modelVersion !== MODEL_VERSION) throw new Error('missing modelVersion');
    if (json.seed !== 12345) throw new Error('missing seed');
    if (json.config.carrier !== 220 || json.config.beat !== 6) throw new Error('missing canonical config');
    if (json.results.neural.alpha !== 0.4) throw new Error('missing results');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SYNTHETIC EEG VALIDITY (Phase 7)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('SyntheticEEG: band power stays finite and within [0,1] over 2000 steps', () => {
    const eeg = new EegInterface();
    const neural = { delta: 0.3, theta: 0.2, alpha: 0.5, beta: 0.2, gamma: 0.1, fatigue: 0.3, adaptation: 0.5 };
    for (let i = 0; i < 2000; i++) {
      const s = eeg.update(0.016, neural);
      for (const k of ['delta', 'theta', 'alpha', 'beta', 'gamma', 'coherence']) {
        if (!isFinite(s[k]) || s[k] < 0 || s[k] > 1) {
          throw new Error(`EEG ${k} out of [0,1]: ${s[k]} at step ${i}`);
        }
      }
    }
  });

  runTest('SyntheticEEG: 1/f background produces non-trivial fluctuation (no dead channels)', () => {
    // Seeded for determinism. Zero neural drive: any fluctuation must come
    // from the pink/white noise floor. Measured std ≈ 0.007 with seed 7.
    const eeg = new EegInterface({ seed: 7 });
    const neural = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, fatigue: 0, adaptation: 0 };
    const samples = [];
    for (let i = 0; i < 500; i++) {
      samples.push(eeg.update(0.016, neural).alpha);
    }
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const std = Math.sqrt(samples.reduce((s, v) => s + (v - mean) * (v - mean), 0) / samples.length);
    if (!isFinite(std) || std < 0.004) {
      throw new Error(`Expected pink-noise fluctuation (std ≥ 0.004), got std=${std.toFixed(5)}`);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // COGNITIVE MODEL (Phase 8)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('CognitiveStateModel: values and confidence stay in [0,1]', () => {
    const m = new CognitiveStateModel();
    m.setProfile(getProfileById('concentracion').modelParams);
    const neural = { delta: 0.1, theta: 0.3, alpha: 0.4, beta: 0.8, gamma: 0.3, fatigue: 0.2, adaptation: 0.8, dominantFreq: 16 };
    for (let i = 0; i < 6000; i++) {
      m.update(0.016, true, neural);
      const s = m.getState();
      assertValidCognitiveState(s);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NEURAL → VISUAL MAPPING (Phase 9)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('VisualMapper: deterministic and provenance-tagged', () => {
    const mapper = new NeuralToVisualMapper();
    const neural = { fatigue: 0.2, theta: 0.4 };
    const cognitive = { arousal: { value: 0.7 }, relaxation: { value: 0.6 } };
    const vm = { complexity: 0.5, velocityScale: 0.6 };
    const a = mapper.map({ neural, cognitive, baseFrequency: 220, visualMetaphor: vm });
    const b = mapper.map({ neural, cognitive, baseFrequency: 220, visualMetaphor: vm });
    if (a.coherence !== b.coherence || a.velocity !== b.velocity || a.complexity !== b.complexity) {
      throw new Error('VisualMapper is not deterministic');
    }
    if (!a.provenance.coherence || a.provenance.coherence.tag !== 'visual metaphor') {
      throw new Error('VisualState missing provenance tags');
    }
    assertValidNeuralState({ fatigue: 0.2, adaptation: 1 });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AUDIO WATCHDOG (pure decision logic — src/core/audio-health.js)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('AudioWatchdog: contexto suspendido → resume al tercer chequeo', () => {
    let health = 0;
    let action = 'none';
    for (let i = 0; i < 5; i++) {
      const r = evaluateAudioHealth({ isPlaying: true, ctxState: 'suspended', gain: 0.5, rms: 0.4, prevHealth: health });
      health = r.health;
      action = r.action;
      if (action === 'resume') break;
    }
    if (action !== 'resume') throw new Error('No resume tras 5 muestras suspendidas');
    if (health !== 0) throw new Error('health no se resetea tras actuar');
  });

  runTest('AudioWatchdog: señal nula con ganancia → refade al tercer chequeo', () => {
    let health = 0;
    let action = 'none';
    for (let i = 0; i < 5; i++) {
      const r = evaluateAudioHealth({ isPlaying: true, ctxState: 'running', gain: 0.5, rms: 0.001, prevHealth: health });
      health = r.health;
      action = r.action;
      if (action === 'refade') break;
    }
    if (action !== 'refade') throw new Error('No refade tras 5 muestras silenciosas');
  });

  runTest('AudioWatchdog: señal presente → nunca actúa y resetea contador', () => {
    for (let i = 0; i < 10; i++) {
      const r = evaluateAudioHealth({ isPlaying: true, ctxState: 'running', gain: 0.5, rms: 0.2, prevHealth: 2 });
      if (r.action !== 'none' || r.health !== 0) {
        throw new Error('Falsa alarma con señal presente');
      }
    }
  });

  runTest('AudioWatchdog: volumen del usuario a 0 → nunca actúa', () => {
    for (let i = 0; i < 10; i++) {
      const r = evaluateAudioHealth({ isPlaying: true, ctxState: 'running', gain: 0.0001, rms: 0, prevHealth: 2 });
      if (r.action !== 'none' || r.health !== 0) {
        throw new Error('El watchdog no debe pelear con el volumen a 0');
      }
    }
  });

  runTest('AudioWatchdog: sin sesión activa → nunca actúa', () => {
    const r = evaluateAudioHealth({ isPlaying: false, ctxState: 'suspended', gain: 0.5, rms: 0 });
    if (r.action !== 'none' || r.health !== 0) throw new Error('Actuó sin sesión activa');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // EXPERIMENTAL MODE (Phase 10)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('Experiments: determinista bajo la misma semilla y config', () => {
    const cfg = new SimulationConfig({ carrier: 220, beat: 6, condition: 'binaural', durationSec: 300 });
    const a = new ExperimentRunner({ config: cfg, seed: 1234 }).run();
    const b = new ExperimentRunner({ config: cfg, seed: 1234 }).run();
    if (JSON.stringify(a.final) !== JSON.stringify(b.final)) {
      throw new Error('Resultados finales no deterministas bajo la misma semilla');
    }
    if (JSON.stringify(a.psdBands) !== JSON.stringify(b.psdBands)) {
      throw new Error('PSD no determinista bajo la misma semilla');
    }
  });

  runTest('Experiments: binaural entraña hacia Δf; sin estímulo se relaja a línea base', () => {
    const bin = new ExperimentRunner({
      config: new SimulationConfig({ carrier: 220, beat: 6, condition: 'binaural' }),
      seed: 7,
    }).run();
    const none = new ExperimentRunner({
      config: new SimulationConfig({ carrier: 220, beat: 6, condition: 'none' }),
      seed: 7,
    }).run();
    const fBin = bin.final.neural.dominantFreq;
    const fNone = none.final.neural.dominantFreq;
    if (!(Math.abs(fBin - 6) < Math.abs(fNone - 6))) {
      throw new Error(`binaural debería acercar la dominante a 6 Hz (${fBin.toFixed(2)}) más que none (${fNone.toFixed(2)})`);
    }
  });

  runTest('Experiments: PSD válida (finita y no negativa) y bandas integradas', () => {
    const res = new ExperimentRunner({
      config: new SimulationConfig({ carrier: 220, beat: 6, condition: 'binaural' }),
      seed: 42,
    }).run();
    for (const p of res.psd) {
      if (!isFinite(p.power) || p.power < 0) throw new Error('PSD inválida');
    }
    for (const v of Object.values(res.psdBands)) {
      if (!isFinite(v) || v < 0) throw new Error('Band power PSD inválida');
    }
  });

  runTest('Experiments: todas las condiciones producen estados finitos', () => {
    for (const cond of ['binaural', 'pure-tone', 'noise', 'amplitude-modulation', 'none']) {
      const res = new ExperimentRunner({
        config: new SimulationConfig({ carrier: 220, beat: 8, condition: cond }),
        seed: 5,
      }).run({ durationSec: 60 });
      for (const v of Object.values(res.final.neural)) if (!isFinite(v)) throw new Error(`neural NaN en ${cond}`);
      for (const v of Object.values(res.final.eeg)) if (!isFinite(v)) throw new Error(`eeg NaN en ${cond}`);
    }
  });

  runTest('Experiments: exporta registro JSON reproductible', () => {
    const cfg = new SimulationConfig({ carrier: 220, beat: 10, condition: 'noise', durationSec: 60 });
    const runner = new ExperimentRunner({ config: cfg, seed: 99 });
    const results = runner.run({ durationSec: 60 });
    const rec = runner.record(results);
    if (rec.seed !== 99) throw new Error('seed no persistida');
    if (rec.config.condition !== 'noise') throw new Error('config no persistida');
    if (rec.results.psdBands.alpha === undefined) throw new Error('resultados ausentes');
  });

  runTest('Experiments: conditionProfile rechaza condiciones desconocidas', () => {
    let threw = false;
    try {
      conditionProfile('klingon', new SimulationConfig({}));
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('Condición desconocida no rechazada');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // MEDIA ANCHOR TESTS (silent WAV used to register Media Session on mobile)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('Media anchor: WAV silencioso con cabecera válida (RIFF/WAVE/fmt/data)', () => {
    const wav = buildSilentWav(1);
    const v = new DataView(wav);
    const str = (off, n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(off + i));
      return s;
    };
    if (str(0, 4) !== 'RIFF') throw new Error('sin marcador RIFF');
    if (str(8, 4) !== 'WAVE') throw new Error('sin marcador WAVE');
    if (str(12, 4) !== 'fmt ') throw new Error('sin chunk fmt');
    if (str(36, 4) !== 'data') throw new Error('sin chunk data');
    if (v.getUint16(22, true) !== 1) throw new Error('no es mono');
    if (v.getUint32(24, true) !== 8000) throw new Error('sample rate != 8000');
    if (v.getUint16(34, true) !== 16) throw new Error('no es 16-bit');
  });

  runTest('Media anchor: las muestras son silencio real (todo a cero)', () => {
    const wav = buildSilentWav(0.5);
    const v = new DataView(wav);
    for (let i = 44; i < wav.byteLength; i += 2) {
      if (v.getInt16(i, true) !== 0) throw new Error(`muestra no nula en offset ${i}`);
    }
  });

  runTest('Media anchor: la pista por defecto es larga (≥ 6 s) para un reloj de medios estable', () => {
    const wav = buildSilentWav();
    // 44 bytes de cabecera + 2 bytes por muestra a 8000 Hz.
    const seconds = (wav.byteLength - 44) / 2 / 8000;
    if (seconds < 6) throw new Error(`pista demasiado corta: ${seconds.toFixed(2)} s`);
    if (seconds !== ANCHOR_SECONDS) throw new Error(`ANCHOR_SECONDS (${ANCHOR_SECONDS}) no coincide con buildSilentWav()`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PERMISSIONS TESTS (lógica pura: decisiones reales, no adornos)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('Permisos: sin decidir y activados → se pide el diálogo y se adquiere Wake Lock', () => {
    const d = evaluatePermissions({
      notificationSupported: true,
      notifPermission: 'default',
      wakeLockSupported: true,
      wakeLockHeld: false,
    });
    if (!d.shouldRequestNotifications) throw new Error('debería querer pedir notificaciones');
    if (!d.willPromptNotifications) throw new Error('debería mostrar el diálogo (no iOS)');
    if (!d.shouldAcquireWakeLock) throw new Error('debería adquirir Wake Lock');
  });

  runTest('Permisos: ya concedido → nunca se vuelve a pedir', () => {
    const d = evaluatePermissions({ notificationSupported: true, notifPermission: 'granted' });
    if (d.shouldRequestNotifications) throw new Error('no se debe re-pedir un permiso concedido');
    if (d.willPromptNotifications) throw new Error('no debe mostrar diálogo');
  });

  runTest('Permisos: denegado → no se vuelve a molestar', () => {
    const d = evaluatePermissions({ notificationSupported: true, notifPermission: 'denied' });
    if (d.shouldRequestNotifications) throw new Error('no se debe re-pedir un permiso denegado');
  });

  runTest('Permisos: desactivados manualmente → no se pide nada (gate real)', () => {
    const d = evaluatePermissions({
      disabled: true,
      notificationSupported: true,
      notifPermission: 'default',
      wakeLockSupported: true,
      wakeLockHeld: false,
    });
    if (d.shouldRequestNotifications || d.willPromptNotifications || d.shouldAcquireWakeLock) {
      throw new Error('con permisos desactivados no se debe pedir ni adquirir nada');
    }
  });

  runTest('Permisos: iOS sin PWA instalada → no se llama a un diálogo inexistente', () => {
    const d = evaluatePermissions({
      notificationSupported: true,
      notifPermission: 'default',
      iosNeedsInstall: true,
    });
    if (!d.shouldRequestNotifications) throw new Error('quiere notificaciones...');
    if (d.willPromptNotifications) throw new Error('...pero no debe llamar al diálogo (iOS sin PWA)');
  });

  runTest('Permisos: Wake Lock ya activo → no se re-adquiere', () => {
    const d = evaluatePermissions({ wakeLockSupported: true, wakeLockHeld: true });
    if (d.shouldAcquireWakeLock) throw new Error('Wake Lock ya activo no se re-adquiere');
  });

  runTest('Permisos: sin soporte de Wake Lock → se omite sin error', () => {
    const d = evaluatePermissions({ wakeLockSupported: false, wakeLockHeld: false });
    if (d.shouldAcquireWakeLock) throw new Error('sin soporte no se adquiere');
  });

  runTest('Permisos: textos de estado honestos por plataforma', () => {
    if (notifStateText({ notificationSupported: false }) !== 'No soportado en este navegador') throw new Error('unsupported');
    if (notifStateText({ notificationSupported: true, notifPermission: 'granted' }) !== 'Concedido ✓') throw new Error('granted');
    if (notifStateText({ notificationSupported: true, notifPermission: 'denied' }) !== 'Denegado en el navegador') throw new Error('denied');
    if (notifStateText({ notificationSupported: true, notifPermission: 'default', iosNeedsInstall: true }) !== 'Requiere instalar la app (iOS)') throw new Error('ios');
    if (wakeStateText({ wakeLockSupported: true, wakeLockHeld: true }) !== 'Activo ✓') throw new Error('wake on');
    if (wakeStateText({ wakeLockSupported: false }) !== 'No soportado') throw new Error('wake unsupported');
    if (enabledStateText(true) !== 'Desactivados' || enabledStateText(false) !== 'Activados') throw new Error('enabled toggle');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM ROBUSTNESS TESTS (P4/P5/P19/P20/P10)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('AudioClock: la fase del latido deriva del reloj de audio sin drift (20 min)', () => {
    let t = 0;
    const clock = new AudioClock(() => t);
    clock.setEpoch(10); // arranca en t=10 s
    t = 10 + 1000; // 1000 s simuladas
    const phase = clock.beatPhase(6);
    if (phase == null || phase < 0 || phase >= 1) throw new Error(`fase fuera de rango: ${phase}`);
    // La fase esperada se calcula directamente: ((t - epoch) mod period)/period
    const period = 1 / 6;
    const expected = (((t - 10) % period) + period) % period / period;
    if (Math.abs(phase - expected) > 1e-9) throw new Error(`fase incorrecta: ${phase} vs ${expected}`);
    // 20 minutos a 10 Hz: la fase en t=epoch+1200 debe ser ~0 (justo el
    // latido). Tolerancia de punto flotante: 0.1 s no es exacto en binario.
    clock.setEpoch(5);
    t = 5 + 1200;
    const ph = clock.beatPhase(10);
    if (ph == null) throw new Error('sin fase');
    const toBeat = Math.min(ph, 1 - ph);
    if (toBeat > 1e-3) throw new Error(`tras 20 min exactos la fase debe ser 0, fue ${ph}`);
  });

  runTest('AudioClock: nextBeatAt programa el próximo latido sin timers', () => {
    let t = 0;
    const clock = new AudioClock(() => t);
    clock.setEpoch(0);
    t = 0.1;
    const next = clock.nextBeatAt(6); // periodo 1/6 s
    const expected = 0.1 + (1 / 6 - ((0.1 % (1 / 6))));
    if (Math.abs(next - expected) > 1e-9) throw new Error(`nextBeatAt incorrecto: ${next}`);
    if (clock.beatPhase(0) != null) throw new Error('beat 0 → sin fase');
  });

  runTest('AppLifecycle: secuencia real FOREGROUND → BACKGROUND-audio → suspendido → RETURNING → FOREGROUND', () => {
    const lc = new AppLifecycle();
    // Estado inicial tras play: FOREGROUND ('start' solo aplica desde STOPPED).
    if (lc.state !== 'FOREGROUND') throw new Error('estado inicial');
    let r = { ok: true, to: 'FOREGROUND' };
    // Ocultar con audio corriendo (Android con ancla): sigue sonando.
    r = lc.transition('visibility', { visible: false, ctxState: 'running', playing: true });
    if (r.to !== 'AUDIO_RUNNING_BACKGROUND') throw new Error(`esperaba AUDIO_RUNNING_BACKGROUND, ${r.to}`);
    // El SO suspende el contexto estando oculto (iOS):
    r = lc.transition('ctx', { ctxState: 'suspended' });
    if (r.to !== 'AUDIO_SUSPENDED') throw new Error(`esperaba AUDIO_SUSPENDED, ${r.to}`);
    // Volver visible: pasamos por RETURNING y completamos al recuperar running.
    r = lc.transition('visibility', { visible: true, ctxState: 'suspended', playing: true });
    if (r.to !== 'RETURNING') throw new Error(`esperaba RETURNING, ${r.to}`);
    r = lc.transition('resume', { resumeOk: true });
    if (r.to !== 'FOREGROUND') throw new Error(`esperaba FOREGROUND, ${r.to}`);
  });

  runTest('AppLifecycle: transiciones imposibles se rechazan (no se fuerza el estado)', () => {
    const lc = new AppLifecycle();
    // Un evento de contexto en FOREGROUND no es válido: no debe cambiar nada.
    const r = lc.transition('ctx', { ctxState: 'suspended' });
    if (r.ok) throw new Error('ctx en FOREGROUND no es una transición válida');
    if (lc.state !== 'FOREGROUND') throw new Error('el estado no debe cambiar');
    // Ocultar sin reproducir → BACKGROUND; volver → FOREGROUND.
    lc.transition('visibility', { visible: false, ctxState: null, playing: false });
    if (lc.state !== 'BACKGROUND') throw new Error('esperaba BACKGROUND');
    lc.transition('visibility', { visible: true });
    if (lc.state !== 'FOREGROUND') throw new Error('esperaba FOREGROUND');
    // Stop desde cualquier estado → STOPPED; start lo reanima.
    lc.transition('visibility', { visible: false, ctxState: 'running', playing: true });
    lc.transition('stop');
    if (lc.state !== 'STOPPED') throw new Error('esperaba STOPPED');
    if (!lc.transition('start').ok) throw new Error('start desde STOPPED debe ser válido');
    if (lc.state !== 'FOREGROUND') throw new Error('esperaba FOREGROUND tras start');
  });

  runTest('ExperimentEventLog: la integridad refleja las interrupciones reales del SO', () => {
    let wall = 0;
    let audio = 0;
    const log = new ExperimentEventLog({ wallNow: () => wall, audioTime: () => audio });
    log.start({ condition: 'BINAURAL' });
    wall = 10000; audio = 10000; // 10 s sonando
    log.suspend({ reason: 'ctx-suspended' }); // el SO interrumpe
    wall = 12000; // 2 s de interrupción
    log.recover({ reason: 'ctx-running' });
    wall = 20000; audio = 20000; // 8 s más
    const r = log.compute();
    // Exposición 18 s; esperada 20 s → integridad 0.9.
    if (Math.abs(r.integrity - 0.9) > 1e-9) throw new Error(`integridad ${r.integrity}`);
    if (r.interruptions.length !== 1 || r.interruptions[0].durationMs !== 2000) throw new Error('interrupción mal registrada');
    if (r.events.some((e) => !['experimentStarted', 'audioSuspended', 'audioRecovered', 'experimentCompleted'].includes(e.type))) {
      throw new Error('evento inesperado en el registro');
    }
    const txt = log.integrityText();
    if (!/90%/.test(txt) || !/Interrupción/.test(txt)) throw new Error(`texto de integridad: ${txt}`);
  });

  runTest('ExperimentEventLog: la pausa voluntaria no se cuenta como interrupción', () => {
    let wall = 0;
    const log = new ExperimentEventLog({ wallNow: () => wall });
    log.start();
    wall = 5000;
    log.pause({ source: 'lock-screen' }); // pausa voluntaria desde el control del SO
    wall = 20000; // 15 s de pausa voluntaria
    log.resume();
    wall = 25000; // 5 s más
    const r = log.compute();
    if (r.integrity !== 1) throw new Error(`integridad ${r.integrity} (pausa voluntaria no debe bajar la integridad)`);
    if (r.pausedMs !== 15000) throw new Error(`pausedMs ${r.pausedMs}`);
    if (r.interruptions.length !== 0) throw new Error('no hay interrupciones');
  });

  runTest('PlatformCapabilities: cada capacidad se muestra con su función real', () => {
    const caps = probeCapabilities({
      notificationSupported: true,
      notificationPermission: 'granted',
      mediaSessionSupported: true,
      mediaSessionActive: true,
      wakeLockSupported: true,
      wakeLockActive: true,
      pushSupported: true,
      pushConfigured: false,
    });
    if (caps.notifications.label !== 'Concedido ✓') throw new Error('notif label');
    if (caps.mediaSession.label !== 'Controles activos') throw new Error('media session no depende de Notification');
    if (caps.push.label !== 'No configurado — requiere servidor') throw new Error('push honesto sin backend');
    if (!caps.wakeLock.label.toLowerCase().includes('pantalla')) throw new Error('wake lock = pantalla, no garantía de audio');
    const noMs = probeCapabilities({});
    if (noMs.mediaSession.label !== 'No soportado') throw new Error('media session unsupported');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AUDIO TRANSPORT TESTS (P0.5 — pipeline único)
  // ──────────────────────────────────────────────────────────────────────────

  function fakeCtx() {
    const destination = { connected: false };
    const streamDest = { stream: {} };
    return {
      destination,
      streamDest,
      createGain: () => ({
        targets: [],
        connect(n) { this.targets.push(n); if (n === destination) destination.connected = true; },
        disconnect(n) { this.targets = this.targets.filter((t) => t !== n); },
      }),
      createMediaStreamDestination: () => streamDest,
    };
  }

  function fakeElement() {
    return {
      srcObject: null,
      paused: true,
      currentTime: 0,
      readyState: 0,
      error: null,
      onerror: null,
      attrs: {},
      playCalls: 0,
      pauseCalls: 0,
      setAttribute(k, v) { this.attrs[k] = v; },
      play() { this.paused = false; this.playCalls++; return Promise.resolve(); },
      pause() { this.paused = true; this.pauseCalls++; },
    };
  }

  runTest('AudioTransport: iOS usa salida directa (sin MediaStream a <audio>)', () => {
    const ctx = fakeCtx();
    const t = new AudioTransport({ isIos: true, createElement: fakeElement });
    const mode = t.attach(ctx, { connect: () => {} });
    if (mode !== 'direct') throw new Error(`iOS debería ser direct, fue ${mode}`);
    if (!ctx.destination.connected) throw new Error('debe conectar a ctx.destination');
  });

  runTest('AudioTransport: el audio REAL viaja por un único <audio> (modo element)', () => {
    const ctx = fakeCtx();
    const el = fakeElement();
    const t = new AudioTransport({ isIos: false, createElement: () => el });
    const mode = t.attach(ctx, { connect: () => {} });
    if (mode !== 'element') throw new Error(`esperaba element, fue ${mode}`);
    if (el.srcObject == null) throw new Error('el elemento debe recibir el stream real');
    t.play();
    if (el.paused || el.playCalls !== 1) throw new Error('play() debe arrancar el elemento');
    t.pause();
    if (!el.paused || el.pauseCalls !== 1) throw new Error('pause() debe pausar el elemento');
    // reaffirm: si el SO lo pausó, vuelve a reproducir UNA vez.
    el.paused = true;
    if (!t.reaffirm()) throw new Error('reaffirm debe re-producir el elemento pausado');
    if (t.reaffirm()) throw new Error('reaffirm no debe re-producir un elemento activo');
  });

  runTest('AudioTransport: si el <audio> falla, se degrada UNA vez a salida directa', () => {
    const ctx = fakeCtx();
    const el = fakeElement();
    let fallback = 0;
    const t = new AudioTransport({ isIos: false, createElement: () => el, onFallback: () => fallback++ });
    t.attach(ctx, { connect: () => {} });
    if (t.mode !== 'element') throw new Error('esperaba element');
    el.onerror();
    if (t.mode !== 'direct' || !t.fallbackApplied) throw new Error('fallback a direct no aplicado');
    if (fallback !== 1) throw new Error('onFallback debe llamarse una vez');
    if (!ctx.destination.connected) throw new Error('debe conectar a destination tras el fallback');
    // Segundo error: el transporte anula onerror tras el fallback (no debe
    // volver a intentar); si aún estuviera asignado, tampoco debe re-fallback.
    if (typeof el.onerror === 'function') el.onerror();
    if (fallback !== 1) throw new Error('no debe volver a hacer fallback');
  });

  runTest('PlanRecovery: decide UNA recuperación según el estado real (P0.5.9)', () => {
    const r1 = planRecovery({ wasSuspended: true, ctxState: 'suspended' });
    if (r1.action !== 'recover' || r1.state !== RECOVERY.REQUIRED) throw new Error('suspendido → recover');
    const r2 = planRecovery({ wasSuspended: true, ctxState: 'running' });
    if (r2.action !== 'none' || r2.state !== RECOVERY.SUCCESS) throw new Error('ya corriendo → success');
    const r3 = planRecovery({ wasSuspended: false, transportMode: 'element', elementPaused: true });
    if (r3.action !== 'reaffirm-element' || r3.state !== RECOVERY.RUNNING) throw new Error('elemento pausado → reaffirm');
    const r4 = planRecovery({ wasSuspended: false });
    if (r4.action !== 'none' || r4.state !== RECOVERY.NONE) throw new Error('nada que recuperar');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NOTIFICATION SYSTEM TESTS (P0 — AlarmManager / NotificationManager)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('AlarmManager: alarmStateOnTick decide wait/fire/miss/skip (estados reales)', async () => {
    const now = 1_000_000;
    if (alarmStateOnTick({ id: 'a', nextAt: now + 1000 }, now) !== 'wait') throw new Error('futuro → wait');
    if (alarmStateOnTick({ id: 'a', nextAt: now - 1000 }, now) !== 'fire') throw new Error('dentro de la gracia → fire');
    if (alarmStateOnTick({ id: 'a', nextAt: now - 10 * 60 * 1000 }, now) !== 'miss') throw new Error('pasó la gracia → miss');
    if (alarmStateOnTick({ id: 'a', nextAt: now - 1000, state: 'CANCELLED' }, now) !== 'skip') throw new Error('cancelada → skip');
    if (alarmStateOnTick({ id: 'a', nextAt: now - 1000, state: 'TRIGGERED' }, now) !== 'skip') throw new Error('disparada → skip');
    if (alarmStateOnTick({ id: 'a' }, now) !== 'skip') throw new Error('sin nextAt → skip');
  });

  runTest('AlarmManager: dispara UNA vez y nunca duplica (one-shot + store durable)', async () => {
    let fired = 0;
    const store = inMemoryAlarmStore();
    const am = new AlarmManager({ store, now: () => 1000, tickMs: 60000, onFire: () => fired++ });
    await am.init();
    await am.create({ id: 'al-1', nextAt: 1000 });
    if (am.list().length !== 1) throw new Error('debe listar la alarma');
    await am.tick();
    if (fired !== 1) throw new Error('debe disparar exactamente una vez');
    if (am.list().length !== 0) throw new Error('one-shot: fuera de la lista');
    const stored = await store.getAll();
    if (stored.length !== 0) throw new Error('one-shot: fuera del store durable');
    await am.tick(); // segundo tick: no debe volver a disparar
    if (fired !== 1) throw new Error('no debe duplicar');
    am.dispose();
  });

  runTest('AlarmManager: cancelada nunca se ejecuta', async () => {
    let fired = 0;
    const am = new AlarmManager({ store: inMemoryAlarmStore(), now: () => 5000, tickMs: 60000, onFire: () => fired++ });
    await am.init();
    const a = await am.create({ id: 'al-x', nextAt: 5000 });
    await am.cancel(a.id);
    if (am.list().length !== 0) throw new Error('cancelada fuera de la lista');
    await am.tick();
    if (fired !== 0) throw new Error('cancelada no debe disparar');
    am.dispose();
  });

  runTest('P2 I6: alarma external (nativa) NUNCA dispara el scheduler web (dueño único)', () => {
    const now = 1_700_000_000_000;
    const external = { id: 'al-native-1', nextAt: now - 1000, state: 'SCHEDULED', external: true };
    const web = { id: 'al-web-1', nextAt: now - 1000, state: 'SCHEDULED' };
    if (alarmStateOnTick(external, now) !== 'skip') {
      throw new Error('la alarma external no debe disparar el scheduler web (la dispara el SO nativo)');
    }
    if (alarmStateOnTick(web, now) !== 'fire') {
      throw new Error('la alarma web vencida debe disparar (owner web)');
    }
  });

  runTest('AlarmManager: alarma vencida se marca MISSED, no se ejecuta tarde', async () => {
    let fired = 0;
    const am = new AlarmManager({
      store: inMemoryAlarmStore(),
      now: () => 1_000_000,
      graceMs: 5 * 60 * 1000,
      onFire: () => fired++,
      onSync: () => {},
    });
    await am.init();
    await am.create({ id: 'al-old', nextAt: 1_000_000 - 30 * 60 * 1000 }); // 30 min atrás
    await am.tick();
    if (fired !== 0) throw new Error('no debe ejecutar una alarma vieja');
    if (!am.lastNotification || am.lastNotification.state !== 'MISSED') throw new Error('debe marcarse MISSED');
    if (am.list().length !== 0) throw new Error('la vencida no queda pendiente');
    am.dispose();
  });

  runTest('AlarmManager: recarga recupera la alarma desde el store durable (Fase 5)', async () => {
    const store = inMemoryAlarmStore();
    const a1 = new AlarmManager({ store, now: () => 1000, tickMs: 60000 });
    await a1.init();
    await a1.create({ id: 'al-reload', nextAt: 999_999_999 });
    const a2 = new AlarmManager({ store, now: () => 2000, tickMs: 60000 });
    await a2.init();
    const list = a2.list();
    if (list.length !== 1 || list[0].id !== 'al-reload') throw new Error('debe restaurarse desde el store');
    a1.dispose();
    a2.dispose();
  });

  runTest('AlarmManager: al arrancar descarta (EXPIRED) lo que venció hace mucho', async () => {
    const store = inMemoryAlarmStore();
    await store.put({ id: 'al-exp', nextAt: 1000 });
    let fired = 0;
    const am = new AlarmManager({ store, now: () => 999_999_999, tickMs: 60000, onFire: () => fired++ });
    await am.init();
    if (am.list().length !== 0) throw new Error('la vencida debe descartarse al arrancar');
    if (fired !== 0) throw new Error('no debe ejecutarse');
    am.dispose();
  });

  runTest('AlarmManager: solo la pestaña PRIMARIA dispara (Web Locks, Fase 15)', async () => {
    // Secundaria: el lock no se concede → no dispara jamás.
    const denied = new AlarmManager({
      store: inMemoryAlarmStore(),
      now: () => 1000,
      tickMs: 60000,
      onFire: () => {
        throw new Error('secundaria no debe disparar');
      },
      locks: { request: (_n, _o, cb) => cb(null) },
    });
    await denied.init();
    await denied.create({ id: 'al-2', nextAt: 1000 });
    await denied.tick();
    if (denied.fires !== 0) throw new Error('secundaria no dispara');
    denied.dispose();
    // Primaria: el lock se concede → dispara una vez.
    let fired = 0;
    const primary = new AlarmManager({
      store: inMemoryAlarmStore(),
      now: () => 1000,
      tickMs: 60000,
      onFire: () => fired++,
      locks: { request: (_n, _o, cb) => cb({}) },
    });
    await primary.init();
    await primary.create({ id: 'al-3', nextAt: 1000 });
    await primary.tick();
    if (fired !== 1) throw new Error('primaria debe disparar');
    primary.dispose();
  });

  runTest('AlarmManager: sin Web Locks, el BroadcastChannel elige UNA primaria', async () => {
    const bus = {
      subs: [],
      // Entrega asíncrona, como BroadcastChannel real (si fuera síncrona, la
      // respuesta llegaría antes de registrar el handler de la segunda pestaña).
      postMessage(msg) {
        queueMicrotask(() => this.subs.forEach((fn) => fn({ data: msg })));
      },
      set onmessage(fn) {
        this.subs.push(fn);
      },
      get onmessage() {
        return null;
      },
    };
    const store = inMemoryAlarmStore();
    let firedA = 0;
    let firedB = 0;
    const amA = new AlarmManager({
      store,
      now: () => 1000,
      tickMs: 60000,
      channel: bus,
      instanceId: '00000000000001aaaa',
      onFire: () => firedA++,
    });
    const amB = new AlarmManager({
      store,
      now: () => 1000,
      tickMs: 60000,
      channel: bus,
      instanceId: '00000000000002bbbb',
      onFire: () => firedB++,
    });
    await amA.init();
    await amB.init();
    if (amA._primary !== true || amB._primary !== false) {
      throw new Error(`elección incorrecta: A=${amA._primary} B=${amB._primary}`);
    }
    await amA.create({ id: 'al-mt', nextAt: 1000 });
    await amA.tick();
    await amB.tick();
    if (firedA !== 1 || firedB !== 0) throw new Error('solo la primaria dispara (sin duplicados)');
    amA.dispose();
    amB.dispose();
  });

  runTest('NotificationManager: el provider SW tiene prioridad; sin SW cae al local', () => {
    let swShown = 0;
    let localShown = 0;
    const nm = createNotificationManager({
      notificationSupported: () => true,
      permissionState: () => 'granted',
      swReady: () => true,
      showSwNotification: () => {
        swShown++;
        return true;
      },
      showLocalNotification: () => {
        localShown++;
        return true;
      },
    });
    const r = nm.notify({ id: 'n1', freq: 220 });
    if (r.provider !== 'serviceWorker' || !r.shown) throw new Error('debe elegir el provider SW');
    if (swShown !== 1 || localShown !== 0) throw new Error('SW primero, local no');
    const nm2 = createNotificationManager({
      notificationSupported: () => true,
      permissionState: () => 'granted',
      swReady: () => false,
      showSwNotification: () => {
        swShown++;
        return true;
      },
      showLocalNotification: () => {
        localShown++;
        return true;
      },
    });
    const r2 = nm2.notify({ id: 'n2', freq: 220 });
    if (r2.provider !== 'local' || !r2.shown) throw new Error('sin SW → local');
    if (localShown !== 1) throw new Error('local debe usarse una vez');
  });

  runTest('NotificationManager: sin permiso no muestra y no finge (denegado → null)', () => {
    const nm = createNotificationManager({
      notificationSupported: () => true,
      permissionState: () => 'denied',
      swReady: () => true,
      showSwNotification: () => true,
      showLocalNotification: () => true,
    });
    const r = nm.notify({ id: 'n3', freq: 220 });
    if (r.provider !== null || r.shown !== false) throw new Error('denegado → no mostrar, no fingir');
  });

  runTest('NotificationManager: Push desactivado y Calendar manual (honestidad, Fase 13)', () => {
    const nm = createNotificationManager({
      notificationSupported: () => true,
      permissionState: () => 'granted',
    });
    const st = nm.status();
    const push = st.providers.find((p) => p.name === 'push');
    const cal = st.providers.find((p) => p.name === 'calendar');
    if (!push || push.enabled !== false || push.configured !== false) throw new Error('Push desactivado sin backend');
    if (!cal || cal.manual !== true) throw new Error('Calendar es manual, nunca automático');
  });

  runTest('NotificationCapabilities: detección honesta (API disponible ≠ garantizado, Fase 12)', () => {
    const caps = detectNotificationCapabilities({});
    if (caps.backgroundScheduling !== 'NOT_GUARANTEED') throw new Error('no existe scheduler persistente sin Push');
    if (caps.calendar !== 'AVAILABLE') throw new Error('calendario disponible como respaldo');
    if (caps.push.configured !== false) throw new Error('push sin backend no está configurado');
    const granted = detectNotificationCapabilities({
      window: { PushManager: {}, mediaSession: {} },
      navigator: { serviceWorker: {} },
      Notification: { permission: 'granted', prototype: { actions: true } },
      pushConfigured: false,
      swRegistered: true,
    });
    if (!granted.notifications.supported || granted.notifications.permission !== 'granted') throw new Error('permiso concedido');
    if (!granted.notifications.actions) throw new Error('acciones soportadas en esta plataforma');
    if (!granted.push.supported || granted.push.configured) throw new Error('push: soportado pero NO configurado');
    if (!granted.mediaSession.supported) throw new Error('media session detectada');
    const rows = capabilitySummary(granted);
    const pushRow = rows.find((r) => r.key === 'push');
    if (!pushRow || !/requiere servidor/i.test(pushRow.status)) throw new Error('fila push honesta');
  });

  runTest('CalendarProvider: el .ics y Google Calendar son eventos reales (Fase 10)', async () => {
    // El origen se pasa explícito (funciona en Node y en el navegador: ahí
    // `location` no se puede reemplazar, así que nunca se asigna globalThis.location).
    const { buildIcs, buildGoogleCalendarUrl } = await import('../notifications.js');
    const alarm = { id: 'al-test-1', nextAt: Date.UTC(2026, 7, 14, 10, 0), minutes: 30, freq: 220, beat: 6, time: '10:00' };
    const ics = buildIcs(alarm, 'https://vyneural.test');
    for (const needle of ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:al-test-1@vyneural.cl', 'DTSTART:', 'DTEND:', 'SUMMARY:']) {
      if (!ics.includes(needle)) throw new Error(`.ics sin ${needle}`);
    }
    const gcal = buildGoogleCalendarUrl(alarm, 'https://vyneural.test');
    if (!gcal.startsWith('https://calendar.google.com/calendar/render?')) throw new Error('url de Google Calendar');
  });

  runTest('P2 ICS FASE 10: UID estable, LOCATION/SEQUENCE, sin evento duplicado', async () => {
    const { buildIcs } = await import('../notifications.js');
    const alarm = { id: 'al-uid-stable', nextAt: Date.UTC(2026, 7, 14, 10, 0), minutes: 30, freq: 220, beat: 6, time: '10:00' };
    const a = buildIcs(alarm, 'https://vyneural.test');
    const b = buildIcs(alarm, 'https://vyneural.test');
    // Mismo evento re-generado → mismo UID (los calendarios deduplican).
    const uidA = a.match(/^UID:(.*)$/m)?.[1];
    const uidB = b.match(/^UID:(.*)$/m)?.[1];
    if (!uidA || uidA !== uidB) throw new Error(`UID debe ser estable, ${uidA} vs ${uidB}`);
    for (const needle of ['DTSTAMP:', 'LOCATION:https://vyneural.test', 'SEQUENCE:0']) {
      if (!a.includes(needle)) throw new Error(`.ics sin ${needle}`);
    }
    // Un solo evento por sesión: nunca dos BEGIN:VEVENT para la misma alarma.
    const vevents = a.split('BEGIN:VEVENT').length - 1;
    if (vevents !== 1) throw new Error(`debe haber 1 evento, hay ${vevents}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P0 — CORE / PLATFORM (plan Bineural → APK Android)
  // ──────────────────────────────────────────────────────────────────────────

  runTest('NativeBridge: sin bridge la web sigue intacta (todo NOT_SUPPORTED)', () => {
    const bridge = detectNativeBridge({});
    if (bridge !== null) throw new Error('detectNativeBridge sin bridge debe ser null');
    const adapter = createNativeBridgeAdapter({});
    if (adapter.present !== false || adapter.platform !== 'web') throw new Error('adaptador debe reportar web');
    const r = adapter.startBackgroundAudio();
    if (r.ok !== false || r.error !== 'NOT_SUPPORTED') throw new Error('sin bridge: NOT_SUPPORTED');
    if (adapter.scheduleAlarm({ id: 'x' }).ok) throw new Error('scheduleAlarm sin bridge debe fallar');
    const st = adapter.getState();
    for (const k of ['backgroundAudio', 'exactAlarms', 'nativeAudio', 'notifications']) {
      if (st.supported[k] !== false) throw new Error(`supported.${k} debe ser false sin APK`);
    }
  });

  runTest('NativeBridge: detección con bridge inyectado (contrato P1)', () => {
    const fake = {
      version: '1.0.0',
      postMessage: () => ({ received: true }),
      getPlatformInfo: () => ({
        nativeAudio: true,
        notifications: true,
        exactAlarms: true,
        backgroundService: true,
        backgroundServiceActive: false,
        notificationPermission: 'granted',
        mediaSession: true,
        mediaSessionActive: false,
      }),
    };
    const info = detectNativeBridge({ bridge: fake });
    if (!info || info.platform !== 'android' || info.version !== '1.0.0') throw new Error('detección fallida');
    const adapter = createNativeBridgeAdapter({ bridge: fake });
    if (adapter.present !== true || adapter.platform !== 'android') throw new Error('adaptador debe reportar android');
    const st = adapter.getState();
    if (!st.supported.backgroundAudio || !st.supported.exactAlarms || !st.supported.notifications) {
      throw new Error('capacidades nativas del bridge no propagadas');
    }
    const r = adapter.startBackgroundAudio();
    if (!r.ok || r.platform !== 'android') throw new Error('comando nativo debe entregarse');
  });

  runTest('NativeBridge: whitelist de comandos y validación de payload (Fase 24)', () => {
    if (!BRIDGE_COMMANDS.includes('GET_PLATFORM_CAPABILITIES')) throw new Error('whitelist sin handshake');
    if (!BRIDGE_COMMANDS.includes('REQUEST_EXACT_ALARM_PERMISSION') || !BRIDGE_COMMANDS.includes('OPEN_SETTINGS')) {
      throw new Error('whitelist incompleta');
    }
    if (!BRIDGE_COMMANDS.includes('GET_AUDIO_STATE') || !BRIDGE_COMMANDS.includes('GET_MEDIA_SESSION_STATE')) {
      throw new Error('whitelist P1.5 sin comandos de estado');
    }
    if (!BRIDGE_COMMANDS.includes('OPEN_NOTIFICATION_SETTINGS')) throw new Error('whitelist P1.5 sin ajustes de notificación');
    if (!BRIDGE_COMMANDS.includes('SESSION_END')) throw new Error('whitelist M1 sin fin de sesión nativo');
    const ok = validateCommand('SCHEDULE_ALARM', { alarmId: 'a' });
    if (!ok.ok) throw new Error('comando whitelisted rechazado');
    if (validateCommand('EXEC_SHELL', {}).error !== 'DENIED') throw new Error('comando arbitrario debe ser DENIED');
    if (validateCommand('START_BACKGROUND_AUDIO', 'nope').error !== 'INVALID') throw new Error('payload string debe ser INVALID');
    if (validateCommand('START_BACKGROUND_AUDIO', ['a']).error !== 'INVALID') throw new Error('payload array debe ser INVALID');
    if (validateCommand('SCHEDULE_ALARM', { 'evil key': 1 }).error !== 'INVALID') throw new Error('clave rara debe ser INVALID');
  });

  runTest('NativeBridge: handshake — sin bridge UNAVAILABLE; con respuesta CONNECTED (§9)', async () => {
    const noBridge = createNativeBridgeAdapter({});
    const hs0 = await noBridge.handshake({ timeoutMs: 10 });
    if (hs0.status !== 'UNAVAILABLE' || hs0.platform !== 'web') throw new Error('sin bridge el handshake debe ser UNAVAILABLE');
    // Bridge con getPlatformInfo síncrono → CONNECTED inmediato.
    const fake = {
      version: '1.0.0',
      postMessage: () => null,
      getPlatformInfo: () => ({ nativeAudio: true, notifications: true }),
    };
    const ok = createNativeBridgeAdapter({ bridge: fake });
    const hs1 = await ok.handshake({ timeoutMs: 10 });
    if (hs1.status !== 'CONNECTED' || hs1.platform !== 'android') throw new Error('handshake con info síncrona debe conectar');
    if (ok.getState().bridgeStatus !== 'CONNECTED') throw new Error('bridgeStatus debe quedar CONNECTED');
    // Bridge SIN getPlatformInfo que no responde → UNAVAILABLE (sin falso positivo).
    const silent = createNativeBridgeAdapter({ bridge: { version: 'x', postMessage: () => null } });
    const hs2 = await silent.handshake({ timeoutMs: 10 });
    if (hs2.status !== 'UNAVAILABLE') throw new Error('bridge mudo debe reportar UNAVAILABLE, no capacidades');
    if (silent.getState().supported.notifications !== false) throw new Error('bridge sin respuesta NO puede marcar capacidades');
  });

  runTest('NativeBridge: aislamiento de fallos — un bridge roto no rompe la web (§10)', () => {
    const broken = createNativeBridgeAdapter({
      bridge: {
        version: '1.0.0',
        postMessage: () => {
          throw new Error('bridge roto');
        },
        getPlatformInfo: () => {
          throw new Error('info rota');
        },
      },
    });
    const r = broken.startBackgroundAudio();
    if (r.ok !== false || r.error !== 'BRIDGE_ERROR') throw new Error('el error del bridge debe aislarse en BRIDGE_ERROR');
    if (broken.getState().bridgeStatus !== 'ERROR') throw new Error('bridgeStatus debe reflejar el error');
    // El adaptador nunca lanza: todo lo demás sigue funcionando como web.
    let threw = false;
    try {
      broken.scheduleAlarm({ id: 'x' });
      broken.cancelAlarm('x');
      broken.requestNotificationPermission();
      broken.openExperiment('e1');
    } catch {
      threw = true;
    }
    if (threw) throw new Error('el adaptador nunca debe lanzar');
  });

  runTest('PlatformCapabilities: entorno real — Chrome Android ≠ nativo (§2/§8)', () => {
    const uaAndroid = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile';
    const uaIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)';
    if (detectPlatformKind({ ua: uaAndroid, bridgePresent: false }) !== 'android-browser') {
      throw new Error('Chrome Android sin bridge debe ser android-browser, NO nativo');
    }
    if (detectPlatformKind({ ua: uaAndroid, bridgePresent: true }) !== 'android-native') {
      throw new Error('bridge presente en Android debe ser android-native');
    }
    if (detectPlatformKind({ ua: uaIos, bridgePresent: false }) !== 'ios') throw new Error('iPhone debe ser ios');
    if (detectPlatformKind({ ua: '', bridgePresent: false }) !== 'unknown') throw new Error('sin UA debe ser unknown');
    if (detectPlatformKind({ ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', bridgePresent: false }) !== 'desktop') {
      throw new Error('escritorio debe ser desktop');
    }
    // La fusión refleja el entorno: Android sin bridge NO concede nativo.
    const web = probeCapabilities({ notificationSupported: true, notificationPermission: 'default' });
    const solo = mergePlatformCapabilities({ web, native: null, env: { ua: uaAndroid, bridgePresent: false } });
    if (solo.platformKind !== 'android-browser' || solo.platform !== 'web') throw new Error('UA Android sin bridge no es nativo');
    if (solo.backgroundAudio.supported !== false) throw new Error('sin bridge no hay background nativo');
  });

  runTest('PlatformCapabilities: fusión honesta web + nativo (supported ≠ granted ≠ active)', () => {
    const web = probeCapabilities({
      notificationSupported: true,
      notificationPermission: 'default',
      mediaSessionSupported: true,
      mediaSessionActive: false,
      wakeLockSupported: true,
      wakeLockActive: false,
      pushSupported: true,
      pushConfigured: false,
    });
    // Solo web: proveedor web, background limitado, alarmas no garantizadas.
    const soloWeb = mergePlatformCapabilities({ web, native: null });
    if (soloWeb.platform !== 'web' || soloWeb.notifications.provider !== 'web') throw new Error('sin APK debe ser web');
    if (soloWeb.backgroundAudio.supported !== false) throw new Error('background web no debe prometer soporte');
    if (soloWeb.exactAlarms.supported !== false) throw new Error('alarmas web no deben prometer exactitud');
    // Con APK: nativo provee lo que la web no puede.
    const native = createNativeBridgeAdapter({
      bridge: {
        version: '1.0.0',
        postMessage: () => null,
        getPlatformInfo: () => ({
          nativeAudio: true,
          notifications: true,
          exactAlarms: true,
          exactAlarmsGranted: false, // el SO aún no la autorizó
          backgroundService: true,
          backgroundServiceActive: false,
          notificationPermission: 'default',
          mediaSession: true,
          mediaSessionActive: false,
        }),
      },
    });
    const apk = mergePlatformCapabilities({ web, native: native.getState() });
    if (apk.platform !== 'android' || apk.notifications.provider !== 'native') throw new Error('con APK debe ser nativo');
    if (apk.backgroundAudio.supported !== true) throw new Error('APK debe soportar background audio');
    if (apk.exactAlarms.supported !== true) throw new Error('APK debe soportar alarmas exactas');
    if (apk.exactAlarms.granted !== false) throw new Error('granted ≠ supported: el SO aún no la autorizó');
    if (!/configuración del sistema/i.test(apk.exactAlarms.label)) throw new Error('label debe ser honesto sobre la autorización');
  });

  runTest('AudioState: máquina central — la UI no puede detener el audio (P2 Fase 1)', () => {
    const m = new AudioStateMachine();
    if (m.state !== 'IDLE') throw new Error('estado inicial IDLE');
    // Eventos de UI/visuales NO son transiciones válidas de audio.
    if (m.transition('scroll').ok) throw new Error('scroll no puede transicionar el audio');
    if (m.transition('open_menu').ok) throw new Error('abrir menú no puede transicionar');
    if (m.transition('open_hud').ok) throw new Error('abrir HUD no puede transicionar');
    if (!AUDIO_STATES.includes('INTERRUPTED') || !AUDIO_STATES.includes('DUCKED')) throw new Error('estados P2 faltantes');
    // Ciclo completo del usuario.
    m.transition('user_play');
    if (m.state !== 'INITIALIZING') throw new Error('user_play → INITIALIZING');
    m.transition('started');
    if (m.state !== 'PLAYING') throw new Error('started → PLAYING');
    m.transition('user_pause');
    if (m.state !== 'PAUSED') throw new Error('user_pause → PAUSED');
    m.transition('user_play');
    if (m.state !== 'PLAYING') throw new Error('resume → PLAYING');
    m.transition('user_stop');
    if (m.state !== 'STOPPED') throw new Error('user_stop → STOPPED');
    // Interrupción del sistema (otra app, llamada) ≠ pause del usuario.
    m.transition('user_play');
    m.transition('started');
    m.transition('focus_loss');
    if (m.state !== 'INTERRUPTED') throw new Error('focus_loss → INTERRUPTED');
    m.transition('focus_gain');
    if (m.state !== 'PLAYING') throw new Error('focus_gain → PLAYING');
    // Duck baja el volumen pero NO corta el audio.
    m.transition('focus_duck');
    if (m.state !== 'DUCKED') throw new Error('focus_duck → DUCKED');
    if (!m.isAudible) throw new Error('DUCKED sigue audible');
    m.transition('focus_gain');
    if (m.state !== 'PLAYING') throw new Error('duck → gain vuelve a PLAYING');
    // Background no detiene la sesión.
    m.transition('app_background');
    if (m.state !== 'BACKGROUND') throw new Error('app_background → BACKGROUND');
    if (!m.isAudible) throw new Error('BACKGROUND sigue audible');
    m.transition('app_foreground');
    if (m.state !== 'PLAYING') throw new Error('app_foreground → PLAYING');
    // El historial registra fuente y timestamp (integridad experimental).
    const last = m.history[m.history.length - 1];
    if (!last || last.source !== 'app_foreground' || !last.ts || last.from !== 'BACKGROUND') {
      throw new Error('historial con fuente, desde/hacia y timestamp');
    }
    // Un evento estale se ignora: el estado nunca se corrompe.
    m.transition('focus_duck');
    m.transition('user_stop');
    const st = m.transition('focus_duck');
    if (st.ok || m.state !== 'STOPPED') throw new Error('evento inválido debe ignorarse');
    if (!AUDIO_EVENTS.includes('system_pause') || !AUDIO_EVENTS.includes('call_ended')) {
      throw new Error('fuentes P2 faltantes');
    }
  });

  runTest('NativeBridge: la info cruda (string) del objeto nativo se normaliza (P2 emulador)', () => {
    // El objeto real (addJavascriptInterface) devuelve JSON string; el adapter
    // debe normalizarlo a objeto o capabilities quedan falsas y el retune cae
    // al fallback con re-solicitud de audio focus (bug encontrado en emulador).
    const rawString = JSON.stringify({
      nativeAudio: true,
      notifications: true,
      backgroundService: true,
      mediaSession: true,
      mediaSessionActive: false,
      retuneNative: true,
      exactAlarms: true,
    });
    const adapter = createNativeBridgeAdapter({
      bridge: { version: '1.0.0', postMessage: () => null, getPlatformInfo: () => rawString },
    });
    const st = adapter.getState();
    if (!st.info || typeof st.info === 'string') throw new Error('info debe normalizarse a objeto');
    if (st.supported.retuneNative !== true) throw new Error('retuneNative debe propagarse desde el string');
    if (st.supported.backgroundAudio !== true || st.supported.notifications !== true) {
      throw new Error('capabilities deben propagarse desde el string');
    }
    if (st.bridgeStatus !== 'CONNECTED') throw new Error('bridge CONNECTED con info válida');
  });

  runTest('AudioProvider: proveedor ÚNICO — nativo activo ⇒ web muda (P1.5 Fase 5)', () => {
    if (selectAudioProvider({ bridgePresent: true, nativeActive: true, playing: true }) !== 'native') {
      throw new Error('APK reproduciendo debe ser NATIVE');
    }
    if (selectAudioProvider({ bridgePresent: false, playing: true }) !== 'web') {
      throw new Error('web reproduciendo sin APK debe ser WEB');
    }
    if (selectAudioProvider({ bridgePresent: true, nativeActive: false, playing: false }) !== 'none') {
      throw new Error('sin reproducción debe ser NONE');
    }
    // Invariante estricto: native ⇒ la ganancia del motor web es 0.
    if (!assertSingleAudioProvider({ provider: 'native', webGain: 0 })) {
      throw new Error('native con web muda debe cumplir el invariante');
    }
    if (assertSingleAudioProvider({ provider: 'native', webGain: 0.5 })) {
      throw new Error('¡doble motor! native + web con ganancia > 0 DEBE fallar el invariante');
    }
    if (!assertSingleAudioProvider({ provider: 'web', webGain: 0.5 })) {
      throw new Error('el motor web solo no está restringido por el invariante');
    }
    if (providerLabel('native') !== 'NATIVE' || providerLabel('none') !== 'NONE') throw new Error('labels');
  });

  runTest('NativeBridge: MediaSession honesta — supported/active/playbackState reales (P1.5 Fase 14)', () => {
    const web = probeCapabilities({ mediaSessionSupported: true, mediaSessionActive: false });
    // Bridge que declara soporte pero NO reproducción: la fusión NO puede
    // mostrar la sesión como activa (false positive prohibido).
    const idle = createNativeBridgeAdapter({
      bridge: {
        version: '1.0.0',
        postMessage: () => null,
        getPlatformInfo: () => ({
          nativeAudio: true,
          notifications: true,
          exactAlarms: true,
          backgroundService: true,
          backgroundServiceActive: false,
          notificationPermission: 'granted',
          mediaSession: true,
          mediaSessionActive: false,
          mediaSessionPlaybackState: 'stopped',
          mediaSessionControls: ['play', 'pause', 'stop'],
        }),
      },
    });
    const m1 = mergePlatformCapabilities({ web, native: idle.getState() });
    if (m1.mediaSession.supported !== true) throw new Error('MediaSession soportada en la APK');
    if (m1.mediaSession.active !== false) throw new Error('no debe reportar activa sin reproducción real');
    if (m1.mediaSession.playbackState !== 'stopped') throw new Error('playbackState debe reflejar el estado real');
    if (!m1.mediaSession.controls.includes('pause') || !m1.mediaSession.controls.includes('stop')) {
      throw new Error('controles play/pause/stop esperados');
    }
    // Bridge que reporta reproducción real: la sesión aparece activa.
    const playing = createNativeBridgeAdapter({
      bridge: {
        version: '1.0.0',
        postMessage: () => null,
        getPlatformInfo: () => ({
          nativeAudio: true,
          notifications: true,
          exactAlarms: true,
          backgroundService: true,
          backgroundServiceActive: true,
          notificationPermission: 'granted',
          mediaSession: true,
          mediaSessionActive: true,
          mediaSessionPlaybackState: 'playing',
          mediaSessionControls: ['play', 'pause', 'stop'],
        }),
      },
    });
    const m2 = mergePlatformCapabilities({ web, native: playing.getState() });
    if (m2.mediaSession.active !== true || m2.mediaSession.playbackState !== 'playing') {
      throw new Error('debe reflejar la reproducción real del servicio');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P1 — AUDIO DUPLICATION FORENSIC (lock/unlock, doble start, restore)
  // ──────────────────────────────────────────────────────────────────────────
  // Harness mínimo de Web Audio para ejercitar BinauralEngine headless.
  class FakeAudioParam {
    constructor(value = 0) {
      this.value = value;
      this.cancelCount = 0;
      this.setValueCount = 0;
    }
    cancelScheduledValues() { this.cancelCount += 1; }
    setValueAtTime(v) { this.setValueCount += 1; this.value = v; }
    linearRampToValueAtTime(v) { this.value = v; }
    exponentialRampToValueAtTime(v) { this.value = v; }
    setTargetAtTime(v) { this.value = v; }
  }
  class FakeNode {
    constructor() {
      this.gain = new FakeAudioParam(1);
      this.frequency = new FakeAudioParam(0);
      this.pan = new FakeAudioParam(0);
      this.type = 'sine';
      this.connectedTo = [];
      this.stopped = false;
      this.disconnected = false;
    }
    connect(n) { this.connectedTo.push(n); return n; }
    disconnect() { this.disconnected = true; }
    start() {}
    stop() { this.stopped = true; }
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.onstatechange = null;
      this.destination = new FakeNode();
      this.createdOscillators = 0;
    }
    createGain() { return new FakeNode(); }
    createOscillator() { this.createdOscillators += 1; return new FakeNode(); }
    createStereoPanner() { return new FakeNode(); }
    createDynamicsCompressor() {
      const n = new FakeNode();
      n.threshold = new FakeAudioParam(-18);
      n.knee = new FakeAudioParam(20);
      n.ratio = new FakeAudioParam(4);
      n.attack = new FakeAudioParam(0.005);
      n.release = new FakeAudioParam(0.25);
      return n;
    }
    createAnalyser() {
      const n = new FakeNode();
      n.fftSize = 2048;
      n.smoothingTimeConstant = 0.8;
      n.getByteTimeDomainData = (buf) => buf.fill(128);
      return n;
    }
    resume() { this.state = 'running'; }
  }
  // El motor usa window.AudioContext en ensure(); se inyecta el fake y se
  // restaura al terminar. En Node globalThis.window no existe → se crea un
  // objeto ventana fake. En el navegador window es real y su propiedad
  // .window es de solo lectura (no se puede reemplazar): se parchea
  // window.AudioContext directamente y se restaura al terminar.
  const withFakeWindow = (fn) => {
    if (typeof globalThis.window === 'undefined') {
      globalThis.window = { AudioContext: FakeAudioContext };
      try {
        return fn();
      } finally {
        delete globalThis.window;
      }
    }
    const saved = globalThis.window.AudioContext;
    globalThis.window.AudioContext = FakeAudioContext;
    try {
      return fn();
    } finally {
      globalThis.window.AudioContext = saved;
    }
  };

  runTest('P1: start() duplicado → 1 pipeline, 1 set de fuentes (doble start §3)', () =>
    withFakeWindow(() => {
      const engine = new BinauralEngine();
      const ctx = engine.ensure();
      const p = { base: 200, beat: 6, volume: 0.5 };
      const r1 = engine.start(p);
      const r2 = engine.start(p);
      const r3 = engine.start(p);
      const live = engine.getAudioStats();
      if (ctx.createdOscillators !== 2) {
        throw new Error(`start x3 debe crear 2 osciladores (una sesión binaural), creó ${ctx.createdOscillators}`);
      }
      if (!r2.idempotent || !r3.idempotent) throw new Error('start duplicado con mismos parámetros debe ser idempotente');
      if (live.sessionId !== 1) throw new Error(`sessionId debe ser 1 (una sesión), es ${live.sessionId}`);
      if (live.liveSourceIds.length !== 2) throw new Error(`fuentes vivas deben ser 2, son ${live.liveSourceIds.length}`);
      if (live.oscillatorCount !== 2) throw new Error(`oscillatorCount debe ser 2, es ${live.oscillatorCount}`);
      if (live.pendingTeardown !== 0) throw new Error('no debe haber teardown pendiente');
    }),
  );

  runTest('P1: lock/unlock ×3 → start() nunca duplica (lock_unlock_no_duplicate_pipeline §8)', () =>
    withFakeWindow(() => {
      const engine = new BinauralEngine();
      const ctx = engine.ensure();
      // p coincide con los defaults del motor (200 / 10 / sine): así el
      // re-start sin parámetros (que en la realidad llega con los mismos
      // valores de sesión) es idempotente y nunca crea un segundo set.
      const p = { base: 200, beat: 10, volume: 0.5 };
      // START → LOCK → UNLOCK repetido: en el unlock la web re-afirma con los
      // mismos parámetros (o sin ellos) y NUNCA debe crear un segundo set.
      for (let i = 0; i < 3; i++) {
        engine.start(p); // START
        engine.start(p); // LOCK → UNLOCK (re-start idempotente)
        engine.start(); // unlock sin parámetros: defaults = sesión activa
      }
      const live = engine.getAudioStats();
      if (ctx.createdOscillators !== 2) {
        throw new Error(`9 starts con mismos parámetros deben crear 2 osciladores, creó ${ctx.createdOscillators}`);
      }
      if (live.sessionId !== 1) throw new Error('una sola sesión de pipeline');
      if (live.liveSourceIds.length !== 2 || live.pendingTeardown !== 0) {
        throw new Error('deben quedar exactamente 2 fuentes vivas y 0 teardown pendiente');
      }
    }),
  );

  runTest('P1: stop→start inmediato → teardown SÍNCRONO, sin ventana de doble pipeline (§5)', () =>
    withFakeWindow(() => {
      const engine = new BinauralEngine();
      engine.start({ base: 200, beat: 6 });
      const oldLeft = engine.leftOsc;
      const oldRight = engine.rightOsc;
      engine.stop(true); // fade: el teardown de nodos queda diferido
      const afterStop = engine.getAudioStats();
      if (afterStop.oscillatorCount !== 0) throw new Error('tras stop no debe haber fuentes vivas');
      if (afterStop.pendingTeardown !== 2) {
        throw new Error(`stop(fade) debe diferir 2 nodos (para terminar el fade), difirió ${afterStop.pendingTeardown}`);
      }
      // start() con otros parámetros ANTES de que dispare el timer del fade:
      // debe ejecutar el teardown pendiente de forma síncrona.
      engine.start({ base: 240, beat: 8 });
      const afterStart = engine.getAudioStats();
      if (afterStart.pendingTeardown !== 0) {
        throw new Error('el start debe flushear el teardown pendiente de forma síncrona');
      }
      if (afterStart.liveSourceIds.length !== 2) throw new Error('el pipeline nuevo debe tener 2 fuentes');
      if (afterStart.sessionId !== 2) throw new Error('debe ser una sesión nueva (sessionId 2)');
      if (!oldLeft.stopped || !oldRight.stopped) throw new Error('los nodos viejos deben estar DETENIDOS antes de crear los nuevos');
      if (!oldLeft.disconnected || !oldRight.disconnected) throw new Error('los nodos viejos deben estar DESCONECTADOS antes de crear los nuevos');
      if (afterStart.liveSourceIds.length > 0 && afterStart.liveSourceIds[0] === 1) {
        throw new Error('la fuente viva no puede ser la del pipeline viejo');
      }
    }),
  );

  runTest('P1: stop(false) libera completamente tras el teardown diferido (§10)', () =>
    withFakeWindow(
      () =>
        new Promise((resolve, reject) => {
          const engine = new BinauralEngine();
          engine.start({ base: 200, beat: 6 });
          engine.stop(false); // teardown diferido 80 ms
          const s0 = engine.getAudioStats();
          if (s0.pendingTeardown !== 2) {
            reject(new Error(`stop(false) debe diferir 2 nodos, difirió ${s0.pendingTeardown}`));
            return;
          }
          setTimeout(() => {
            try {
              const s1 = engine.getAudioStats();
              if (s1.pendingTeardown !== 0) throw new Error('el timer del teardown debe liberar los nodos');
              if (s1.liveSourceIds.length !== 0) throw new Error('sin fuentes vivas tras el stop completo');
              if (engine.isPlaying) throw new Error('el motor no debe estar en play tras el stop');
              resolve();
            } catch (e) {
              reject(e);
            }
          }, 150);
        }),
    ),
  );

  runTest('P1: start() con parámetros distintos reconstruye SIN solape (§3)', () =>
    withFakeWindow(() => {
      const engine = new BinauralEngine();
      const ctx = engine.ensure();
      engine.start({ base: 200, beat: 6 });
      const r = engine.start({ base: 240, beat: 8 }); // retune distinto → reconstruye
      if (r && r.idempotent) throw new Error('parámetros distintos NO deben ser idempotentes');
      const live = engine.getAudioStats();
      if (ctx.createdOscillators !== 4) throw new Error('dos builds → 4 osciladores totales');
      if (live.liveSourceIds.length !== 2) throw new Error('solo 2 fuentes vivas (las nuevas)');
      if (live.sessionId !== 2) throw new Error('segunda sesión de pipeline');
      if (live.pendingTeardown !== 0) throw new Error('sin teardown pendiente');
    }),
  );

  runTest('P1: RestoreGate — burst de unlock deduplica a 1 restore; force atraviesa (§4)', () => {
    let now = 1000;
    const gate = new RestoreGate({ settleMs: 1500, now: () => now });
    const r1 = gate.request();
    if (r1.action !== 'run') throw new Error('primer trigger debe ejecutar');
    gate.complete(); // → SETTLED
    const r2 = gate.request();
    const r3 = gate.request();
    if (r2.action !== 'skip' || r3.action !== 'skip') {
      throw new Error('triggers dentro de la ventana de settle deben deduplicarse (skip)');
    }
    // Un toque posterior con el contexto aún suspendido (iOS) debe reintentar.
    const forced = gate.request({ force: true });
    if (forced.action !== 'run') throw new Error('force debe atravesar la ventana de settle');
    if (gate.state !== 'RESTORING') throw new Error('estado debe ser RESTORING tras el force');
    gate.complete();
    // Fuera de la ventana: vuelve a ejecutar.
    now += 2000;
    const after = gate.request();
    if (after.action !== 'run') throw new Error('fuera de la ventana debe volver a ejecutar');
    // Coalesce durante RESTORING (restore async).
    const g2 = new RestoreGate({ settleMs: 1500, now: () => now });
    g2.request();
    const coalesced = g2.request();
    if (coalesced.action !== 'coalesce') throw new Error('request durante RESTORING debe coalescer');
    const done = g2.complete();
    if (done.action !== 'rerun-pending') throw new Error('debe quedar pendiente un segundo restore');
  });

  runTest('P1: muteMasterGain cancela automation antes de fijar 0 (M1 §6)', () => {
    const gain = new FakeAudioParam(0.5);
    gain.linearRampToValueAtTime(0.6, 100); // rampa residual del motor
    muteMasterGain({ gain }, 10);
    if (gain.value !== 0) throw new Error('el gain debe quedar en 0, quedó ' + gain.value);
    if (gain.cancelCount < 1) throw new Error('debe cancelar scheduled values antes de fijar el 0');
    if (gain.setValueCount < 1) throw new Error('el 0 debe fijarse con setValueAtTime (sin rampa residual)');
    // El caso asimétrico del audit: assign value = X sin cancelar deja la rampa
    // programada; la política P1 lo impide por contrato.
    const g2 = new FakeAudioParam(0.2);
    g2.linearRampToValueAtTime(0.9, 50);
    restoreMasterGain({ gain: g2 }, 0.7, 0);
    if (g2.value !== 0.7 || g2.cancelCount < 1) throw new Error('restoreMasterGain debe cancelar y fijar el nivel');
    // setParamValueCancelingAutomation con null no lanza (aislamiento).
    setParamValueCancelingAutomation(null, 0, 0);
    setParamValueCancelingAutomation(undefined, 0, 0);
  });

  // ── P2 — endurecimiento UNKNOWN + política de focus (dictamen §1/§2) ───────

  runTest('P2 focus: UNKNOWN es estado explícito y recuperable (NO pérdida genérica)', () => {
    const p = focusPolicy(FOCUS_STATES.UNKNOWN);
    if (p.held !== false) throw new Error('UNKNOWN: held debe ser false (el foco no está garantizado)');
    if (p.action !== 'pause') throw new Error('UNKNOWN: pausa defensiva esperada, acción=' + p.action);
    if (p.watch !== true) throw new Error('UNKNOWN: debe programar watchdog (recuperación), watch=' + p.watch);
    if (p.critical !== true) throw new Error('UNKNOWN: debe quedar visible como CRITICAL, critical=' + p.critical);
    // No debe confundirse con LOSS genérico: la firma lo distingue.
    const loss = focusPolicy(FOCUS_STATES.LOSS);
    if (loss.critical !== false) throw new Error('LOSS no es CRITICAL; solo UNKNOWN lo es');
    if (p.critical === loss.critical && p.watch === loss.watch && p.action === loss.action && p.held === loss.held) {
      throw new Error('UNKNOWN no puede ser idéntico a LOSS: la firma debe diferenciarlos');
    }
  });

  runTest('P2 focus: DUCK mantiene held=true (el foco NO se pierde al duplicar)', () => {
    const p = focusPolicy(FOCUS_STATES.DUCK);
    if (p.held !== true) throw new Error('DUCK: held debe ser true (foco poseído, solo baja volumen)');
    if (p.action !== 'duck') throw new Error('DUCK: acción duck esperada, acción=' + p.action);
    if (p.watch !== false) throw new Error('DUCK: no debe programar watchdog (ya tenemos el foco)');
    if (p.critical !== false) throw new Error('DUCK: no es CRITICAL');
  });

  runTest('P2 focus: held es la autoridad del watchdog, NO la observabilidad', () => {
    // El caso del emulador: el SO concede (request devuelve GRANTED) pero el
    // callback no llega → Diagnostics podría decir otra cosa. Si held=false,
    // hay que re-solicitar SIEMPRE, aunque el estado observado diga GAIN.
    if (shouldRequestFocus(false, FOCUS_STATES.GAIN) !== true) {
      throw new Error('held=false + focusState=GAIN debe re-solicitar (callback perdido)');
    }
    if (shouldRequestFocus(false, FOCUS_STATES.LOSS) !== true) {
      throw new Error('held=false + LOSS debe re-solicitar');
    }
    if (shouldRequestFocus(true, FOCUS_STATES.LOSS) !== false) {
      throw new Error('held=true nunca re-solicita (tenemos el foco, p. ej. en DUCK)');
    }
    // Defensa: UNKNOWN observado fuerza la re-solicitud aunque held diga lo
    // contrario (estado incoherente → reintentar).
    if (shouldRequestFocus(true, FOCUS_STATES.UNKNOWN) !== true) {
      throw new Error('UNKNOWN observado debe forzar re-solicitud (estado incoherente)');
    }
  });

  runTest('P2 I6: dueño de alarma por plataforma — APK nativo vs Web/PWA (un solo disparador)', () => {
    if (alarmOwnerForPlatform('android-native', true) !== 'native') {
      throw new Error('APK con bridge real → dueño nativo (AlarmManager del SO)');
    }
    if (alarmOwnerForPlatform('android-native', false) !== 'web') {
      throw new Error('APK sin bridge real → dueño web (fallback honesto)');
    }
    if (alarmOwnerForPlatform('android-browser', true) !== 'web') {
      throw new Error('Chrome Android ≠ APK: nunca dueño nativo (P16-3)');
    }
    if (alarmOwnerForPlatform('desktop', false) !== 'web') {
      throw new Error('Web/PWA → dueño web');
    }
    if (alarmOwnerForPlatform('ios', false) !== 'web') {
      throw new Error('iOS → dueño web');
    }
  });

  // ── P3 — persistencia / crash recovery (tolerancia a corrupción) ──────────

  runTest('P3: sesión corrupta (NaN/fuera de rango) se descarta, no rompe la restauración', () => {
    // NaN es typeof number: sin validación rompería el volumen de la UI.
    const s = sanitizeSession({
      state: 'meditacion',
      volume: NaN,
      ambientVolume: 1.7, // fuera de rango
      ambient: ['lluvia', 'hack', 42], // tipo inválido + desconocido
      timer: -5,
      wave: 'sine',
      custom: { base: 528, beat: NaN },
      goal: 'dormir',
    });
    if (!s || s.state !== 'meditacion') throw new Error('state válido debe pasar');
    if ('volume' in s) throw new Error('volume NaN debe descartarse');
    if ('ambientVolume' in s) throw new Error('ambientVolume fuera de rango debe descartarse');
    if (s.ambient && s.ambient.length !== 1) throw new Error('solo lluvia debe sobrevivir al filtro de tipos');
    if ('timer' in s) throw new Error('timer negativo debe descartarse');
    if (!s.custom || s.custom.base !== 528 || 'beat' in s.custom) {
      throw new Error('custom: base válida pasa, beat NaN se descarta');
    }
    if (s.goal !== 'dormir') throw new Error('goal string pasa (la app lo valida contra los chips)');
  });

  runTest('P3: sesión completamente inválida → null (nada que restaurar)', () => {
    if (sanitizeSession(null) !== null) throw new Error('null → null');
    if (sanitizeSession('cadena') !== null) throw new Error('string → null');
    if (sanitizeSession([]) !== null) throw new Error('array → null');
    if (sanitizeSession({ volume: NaN }) !== null) throw new Error('solo campos corruptos → null');
  });

  runTest('P3: favoritos corruptos se filtran (solo ids string, acotados)', () => {
    const f = sanitizeFavorites(['meditacion', 42, null, '', 'concentracion']);
    if (f.length !== 2 || f[0] !== 'meditacion' || f[1] !== 'concentracion') {
      throw new Error('favoritos: solo strings no vacíos, got ' + JSON.stringify(f));
    }
    if (sanitizeFavorites('no-array').length !== 0) throw new Error('no-array → []');
  });

  runTest('P3: historial corrupto se filtra y acota a 50 registros', () => {
    const h = sanitizeHistory([
      { id: 'alpha', min: 12, ts: Date.now() },
      { id: 'bad', min: NaN, ts: Date.now() },
      { id: 'no-ts', min: 5 },
      null,
      { id: 'no-min', ts: Date.now() },
    ]);
    if (h.length !== 1 || h[0].id !== 'alpha') {
      throw new Error('solo registros con forma válida, got ' + JSON.stringify(h));
    }
    if (h[0].min !== 12) throw new Error('min se conserva');
    const many = sanitizeHistory(
      Array.from({ length: 70 }, (_, i) => ({ id: 's' + i, min: 1, ts: i })),
    );
    if (many.length !== 50) throw new Error('historial acotado a 50, got ' + many.length);
    if (sanitizeHistory('x').length !== 0) throw new Error('no-array → []');
  });

  runTest('P3: alarma corrupta (nextAt inválido) nunca dispara (skip seguro)', () => {
    const now = Date.now();
    const corrupt = { id: 'al-x', nextAt: NaN, state: 'SCHEDULED' };
    if (alarmStateOnTick(corrupt, now) !== 'skip') {
      throw new Error('nextAt NaN debe ser skip (nunca fire/miss)');
    }
    const noNext = { id: 'al-y', state: 'SCHEDULED' };
    if (alarmStateOnTick(noNext, now) !== 'skip') throw new Error('sin nextAt → skip');
    const expired = { id: 'al-z', nextAt: now - 400000, state: 'SCHEDULED' }; // > gracia 5 min
    if (alarmStateOnTick(expired, now) !== 'miss') {
      throw new Error('vencida → miss (no se ejecuta una alarma vieja)');
    }
  });

  runTest('P3: store durable corrupto (basura en IndexedDB) no rompe la carga ni dispara', async () => {
    const now = 2_000_000_000_000;
    const corruptStore = {
      async getAll() {
        // Lo que puede devolver un IndexedDB corrupto/migrado mal:
        // (la vencida dentro de gracia dispara NORMALMENTE — probado en otros
        // tests; aquí se aísla la corrupción: nada debe romper ni disparar).
        return [
          null,
          'basura',
          42,
          { id: 'ok', nextAt: now + 60000 },
          { id: 'bad-nextat', nextAt: NaN },
          { id: 'no-nextat', state: 'SCHEDULED' },
        ];
      },
      async put() {},
      async remove() {},
      async clear() {},
    };
    let fired = 0;
    const am = new AlarmManager({ store: corruptStore, now: () => now, tickMs: 60000, onFire: () => fired++ });
    await am.init();
    const list = am.list();
    if (list.length !== 1 || list[0].id !== 'ok') {
      throw new Error('solo la alarma válida debe sobrevivir, got ' + JSON.stringify(list.map((a) => a.id)));
    }
    if (fired !== 0) throw new Error('un store corrupto no debe disparar nada al cargar');
    // 'bad-nextat'/'no-nextat' jamás fire/miss: el tick inicial las descarta
    // sin ejecutarlas.
    await am.tick();
    if (fired !== 0) throw new Error('los registros corruptos jamás se disparan');
    am.dispose();
  });

  runTest('P3: carrera multi-tab — dos schedulers con el MISMO store disparan UNA sola vez', async () => {
    const now = 2_000_000_000_000;
    const store = inMemoryAlarmStore();
    const fireA = [];
    const fireB = [];
    const amA = new AlarmManager({ store, now: () => now, tickMs: 60000, onFire: (a) => fireA.push(a.id) });
    const amB = new AlarmManager({ store, now: () => now, tickMs: 60000, onFire: (a) => fireB.push(a.id) });
    await amA.init();
    await amB.init();
    await amA.create({ id: 'race-1', nextAt: now - 1000 });
    // Ambos schedulers tienen la alarma en memoria; el tick de A dispara y la
    // remueve del store durable; el tick de B confirma en el store antes de
    // disparar y la descarta (cierra la carrera sin Web Locks).
    await amA.tick();
    await amB.tick();
    if (fireA.length !== 1) throw new Error('A debe disparar exactamente 1, got ' + fireA.length);
    if (fireB.length !== 0) {
      throw new Error('B NO debe disparar (confirmación en el store), got ' + JSON.stringify(fireB));
    }
    amA.dispose();
    amB.dispose();
  });

  runTest('P4: parseBridgeResponse — string crudo, wrapper Kotlin y error aislado', () => {
    // addJavascriptInterface crudo: respuesta como STRING JSON.
    const fromString = parseBridgeResponse({ ok: true, response: '{"status":"OK","command":"GET_AUDIO_STATE","data":{"serviceRunning":true,"playbackState":"playing","base":210,"beat":6}}' });
    if (!fromString || fromString.playbackState !== 'playing' || fromString.base !== 210) {
      throw new Error('debe parsear el string crudo del bridge, got ' + JSON.stringify(fromString));
    }
    // Wrapper Kotlin: objeto ya parseado.
    const fromObject = parseBridgeResponse({ ok: true, response: { status: 'OK', data: { serviceRunning: false, playbackState: 'stopped' } } });
    if (!fromObject || fromObject.playbackState !== 'stopped') {
      throw new Error('debe aceptar el objeto del wrapper, got ' + JSON.stringify(fromObject));
    }
    // Aislamiento de fallos: respuesta inválida / comando fallido → null (la
    // UI web sigue funcionando; nunca lanza).
    if (parseBridgeResponse(null) !== null) throw new Error('null → null');
    if (parseBridgeResponse({ ok: false, error: 'DENIED' }) !== null) throw new Error('comando denegado → null');
    if (parseBridgeResponse({ ok: true, response: 'not json' }) !== null) throw new Error('json inválido → null');
    if (parseBridgeResponse({ ok: true, response: { status: 'OK' } }) !== null) throw new Error('sin data → null');
  });

  runTest('P4: perfiles de plataforma — alarma/audio/notificación con dueño único por runtime', () => {
    // La decisión pura del dueño de alarma (I6) ya distingue runtime:
    // APK con bridge → dueño nativo; Web/PWA/Chrome-Android → dueño web.
    const web = alarmOwnerForPlatform('web', null);
    const pwa = alarmOwnerForPlatform('pwa', null);
    const chromeAndroid = alarmOwnerForPlatform('android-browser', null);
    const apkNoBridge = alarmOwnerForPlatform('android-native', null);
    const apkBridge = alarmOwnerForPlatform('android-native', { scheduleAlarm: () => ({}) });
    if (web !== 'web' || pwa !== 'web' || chromeAndroid !== 'web') {
      throw new Error('Web/PWA/Chrome Android jamás son dueño nativo: ' + web + '/' + pwa + '/' + chromeAndroid);
    }
    if (apkNoBridge !== 'web') throw new Error('APK sin bridge real cae al dueño web (fallback honesto)');
    if (apkBridge !== 'native') throw new Error('APK con bridge real es dueño nativo');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // P5.2/P5.4/P5.5 — DEPURACIÓN POR CAUSALIDAD (kill-switch, protocolo único,
  // instrumentación y stress) — plan: "NINGÚN AUDIO NACE SIN CAUSA AUDITABLE"
  // ──────────────────────────────────────────────────────────────────────────

  runTest('P5.2: protocolo simétrico Web→Nativo — cada acción emite exactamente 1 comando', () => {
    // PLAY con servicio muerto (sesión nueva) → 1 START (única vía de crear audio).
    if (nativePlayCommand({ resume: false, source: 'ui-play', serviceRunning: false }) !== 'start') {
      throw new Error('PLAY con servicio muerto debe ser START');
    }
    // RESUME tras pausa con el servicio vivo → 1 RESUME (nunca START duplicado
    // con re-solicitud de audio focus).
    if (nativePlayCommand({ resume: true, source: 'ui-play', serviceRunning: true }) !== 'resume') {
      throw new Error('RESUME con servicio vivo debe ser RESUME');
    }
    // RESUME ya aplicada por el nativo (lock screen) → 0 comandos (solo mute).
    if (nativePlayCommand({ resume: true, source: 'lock-screen', serviceRunning: true }) !== 'mute-only') {
      throw new Error('el resume del lock screen no debe emitir comandos');
    }
    // PAUSE: UI/teclado/API → 1 PAUSE; lock screen → 0 (el nativo ya pausó).
    if (nativePauseCommand({ source: 'ui' }) !== 'pause') throw new Error('pausa UI debe enviar PAUSE');
    if (nativePauseCommand({ source: 'keyboard' }) !== 'pause') throw new Error('pausa teclado debe enviar PAUSE');
    if (nativePauseCommand({ source: 'api' }) !== 'pause') throw new Error('pausa API debe enviar PAUSE');
    if (nativePauseCommand({ source: 'lock-screen' }) !== 'none') {
      throw new Error('la pausa del lock screen no debe reenviar PAUSE');
    }
    // STOP: servicio vivo → 1 STOP; muerto → no-op (no se crea audio para
    // detenerlo: un shouldPlay persistido jamás se convierte en engine.start).
    if (nativeStopCommand({ serviceRunning: true }) !== 'stop') throw new Error('STOP vivo debe enviar STOP');
    if (nativeStopCommand({ serviceRunning: false }) !== 'none') throw new Error('STOP muerto no debe emitir');
    // CONFIG nunca crea reproducción: no existe ninguna combinación de
    // configuración que devuelva start/resume (el guard vive en el lado
    // nativo: retune/wave/volumen solo se entregan si el servicio está vivo).
  });

  runTest('R2: coalescer de config nativa — ráfaga = 1 comando, último valor gana', async () => {
    const c = new NativeCommandCoalescer({ windowMs: 8 });
    const sent = [];
    // Ráfaga de 5 volúmenes en la misma ventana → 1 solo envío con el último.
    for (let i = 1; i <= 5; i++) c.schedule('level', () => sent.push({ level: i }));
    if (c.pending() !== 1) throw new Error('la ráfaga debe dejar 1 comando pendiente');
    if (c.sent('level') !== 0) throw new Error('aún no debe haberse enviado nada');
    await new Promise((r) => setTimeout(r, 30));
    if (sent.length !== 1) throw new Error(`ráfaga de 5 → 1 envío, llegaron ${sent.length}`);
    if (sent[0].level !== 5) throw new Error('debe ganar el ÚLTIMO valor de la ráfaga');
    if (c.sent('level') !== 1) throw new Error('el contador de envíos debe ser 1');
    // Tipos distintos son independientes.
    const w = [];
    c.schedule('wave', () => w.push('wave'));
    c.schedule('retune', () => w.push('retune'));
    if (c.pending() !== 2) throw new Error('tipos distintos deben estar pendientes por separado');
    await new Promise((r) => setTimeout(r, 30));
    if (w.length !== 2 || w[0] !== 'wave' || w[1] !== 'retune') {
      throw new Error('cada tipo debe enviarse una vez: ' + JSON.stringify(w));
    }
    // cancelAll() descarta los pendientes (stop/unload).
    const z = [];
    c.schedule('level', () => z.push(1));
    c.cancelAll();
    await new Promise((r) => setTimeout(r, 30));
    if (z.length !== 0) throw new Error('cancelAll() debe descartar los pendientes');
  });

  runTest('P5.4: causal-log — anillo con timestamp/source/estados y tope', () => {
    let t = 1000;
    const log = createCausalLog({ max: 5, now: () => (t += 1) });
    log.push({ action: 'PLAY', source: 'ui', from: 'STOPPED', to: 'INITIALIZING', playing: true, native: true });
    log.push({ action: 'PAUSE', source: 'lock-screen', from: 'PLAYING', to: 'PAUSED', playing: false, native: true });
    log.push({ action: 'RESTORE', source: 'background', from: 'PLAYING', to: 'PLAYING', playing: true, native: true });
    log.push({ action: 'STOP', source: 'user-stop', from: 'PLAYING', to: 'STOPPED', playing: false, native: true });
    log.push({ action: 'PLAY', source: 'ui', from: 'STOPPED', to: 'INITIALIZING', playing: true, native: true });
    log.push({ action: 'NATIVE_FOCUS_EVENT', source: 'GAIN', from: 'INTERRUPTED', to: 'PLAYING', playing: true, native: true });
    if (log.length !== 5) throw new Error(`el anillo debe topar en 5, tiene ${log.length}`);
    const list = log.list();
    // 6 push con max 5 → el PLAY más viejo salió; queda PAUSE…NATIVE_FOCUS_EVENT.
    if (list[0].action !== 'PAUSE') throw new Error('el más viejo debe salir del anillo: ' + list[0].action);
    if (list[list.length - 1].action !== 'NATIVE_FOCUS_EVENT') {
      throw new Error('el más nuevo debe ser el último: ' + list[list.length - 1].action);
    }
    if (!list.every((e) => typeof e.ts === 'number' && e.action && e.source)) {
      throw new Error('cada entrada debe tener ts/action/source');
    }
    list.pop(); // list() devuelve una copia
    if (log.length !== 5) throw new Error('list() debe devolver una copia, no el anillo');
  });

  runTest('P5.5: stress — 200 ciclos play/pausa/reanuda/stop no corrompen la máquina', () => {
    const m = new AudioStateMachine('STOPPED');
    for (let i = 0; i < 200; i++) {
      const r = m.transition('user_play', { reason: 'stress' });
      if (!r.ok && m.state !== 'PLAYING') throw new Error(`user_play falló en ${m.state} (ciclo ${i})`);
      m.transition('started', { reason: 'stress' }); // INITIALIZING→PLAYING; en PLAYING se ignora
      m.transition('focus_gain', { reason: 'stress' }); // idempotente en PLAYING
      m.transition('user_pause', { reason: 'stress' }); // → PAUSED
      m.transition('user_play', { reason: 'stress' }); // → PLAYING
      m.transition('user_stop', { reason: 'stress' }); // → STOPPED
      if (!AUDIO_STATES.includes(m.state)) throw new Error(`estado inválido ${m.state} (ciclo ${i})`);
      if (m.history.length > 200) throw new Error('el historial debe estar acotado');
    }
    if (m.state !== 'STOPPED') throw new Error('tras 200 ciclos debe quedar STOPPED, quedó ' + m.state);
    // Interrupción real: PLAYING → focus_loss → INTERRUPTED → GAIN → PLAYING.
    const m2 = new AudioStateMachine('STOPPED');
    m2.transition('user_play');
    m2.transition('started');
    if (m2.state !== 'PLAYING') throw new Error('debe estar PLAYING tras started');
    m2.transition('focus_loss', { reason: 'call_started' });
    if (m2.state !== 'INTERRUPTED') throw new Error('focus_loss debe llevar a INTERRUPTED');
    m2.transition('focus_gain', { reason: 'audio-focus' });
    if (m2.state !== 'PLAYING') throw new Error('focus_gain debe recuperar a PLAYING (nunca arrancar)');
    // GAIN NUNCA arranca audio desde STOPPED/IDLE (regla P5.1: solo
    // USER_PLAY / USER_RESUME / MEDIA_SESSION_PLAY entran a PLAYING).
    const m3 = new AudioStateMachine('STOPPED');
    if (m3.transition('focus_gain').ok) throw new Error('GAIN no puede arrancar audio desde STOPPED');
  });

  runTest('⋯ menú: compartir/historial/reportar accesibles también en fullscreen', async () => {
    // Node-only (lee el disco): en el navegador esta verificación se hace en
    // vivo en /diagnostico; aquí el caso pasa sin costo para mantener 104/104.
    if (typeof process === 'undefined') return;
    const fsSpec = 'node:fs';
    const fs = await import(/* @vite-ignore */ fsSpec);
    // npm test corre desde la raíz del proyecto (process.cwd()); en el
    // navegador este bloque nunca se ejecuta (guard de arriba).
    const root = process.cwd();
    const html = fs.readFileSync(root + '/index.html', 'utf8');
    const js = fs.readFileSync(root + '/src/main.js', 'utf8');
    const menu = (html.match(/id="more-menu"[\s\S]*?<\/div>/) || [''])[0];
    const actions = [...menu.matchAll(/data-action="([^"]+)"/g)].map((mm) => mm[1]);
    for (const expected of ['fps', 'hud', 'experiment', 'permissions', 'share', 'history', 'bug']) {
      if (!actions.includes(expected)) {
        throw new Error(`el menú ⋯ debe tener "${expected}", tiene: ${actions.join(', ')}`);
      }
    }
    for (const expected of ['share', 'history', 'bug']) {
      if (!js.includes(`action === '${expected}'`)) {
        throw new Error(`main.js debe cablear la acción "${expected}" del menú ⋯`);
      }
    }
    if (!js.includes('shareLink()')) throw new Error('la acción share debe llamar a shareLink()');
    if (!js.includes('openHistory()')) throw new Error('la acción history debe llamar a openHistory()');
  });

  runTest('P5.5/F14: 100 ciclos PLAY-LOCK-UNLOCK-PAUSE-STOP → 100 START, 0 espontáneos', () => {
    // Ejercicio puro del protocolo único (native-protocol.js) sobre las dos
    // máquinas de estado (AudioStateMachine + AppLifecycle): cada acción de
    // usuario debe traducirse EXACTAMENTE en 1 comando nativo (o 0 si el
    // nativo ya la aplicó), y NINGÚN evento de ciclo de vida puede producir
    // un START.
    const audio = new AudioStateMachine('STOPPED');
    const lc = new AppLifecycle('STOPPED');
    let plays = 0;
    let nativeStarts = 0;
    let nativeResumes = 0;
    let nativePauses = 0;
    let nativeStops = 0;
    let serviceRunning = false;

    const play = (source) => {
      const cmd = nativePlayCommand({ resume: true, source, serviceRunning });
      if (cmd === 'start') {
        nativeStarts++;
        serviceRunning = true; // START crea el servicio
      } else if (cmd === 'resume') {
        nativeResumes++;
      }
      // 'mute-only' (lock screen): el nativo ya reanudó, 0 comandos.
      const r = audio.transition('user_play', { reason: source });
      if (!r.ok) throw new Error(`user_play falló en ${audio.state}`);
      audio.transition('started', { reason: 'engine-running' });
      lc.transition('start');
      plays++;
    };
    const pause = (source) => {
      if (nativePauseCommand({ source }) === 'pause') nativePauses++;
      audio.transition('system_pause', { reason: source });
    };
    const stop = () => {
      if (nativeStopCommand({ serviceRunning }) === 'stop') {
        nativeStops++;
        serviceRunning = false;
      }
      audio.transition('user_stop', { reason: 'cycle' });
      lc.transition('stop');
    };
    const lock = () => {
      audio.transition('app_background', { reason: 'lock' });
      lc.transition('visibility', { visible: false, ctxState: 'running', playing: true });
    };
    const unlock = () => {
      audio.transition('app_foreground', { reason: 'unlock' });
      lc.transition('visibility', { visible: true, ctxState: 'running', playing: true });
    };

    for (let i = 0; i < 100; i++) {
      play('ui'); // STOPPED → START
      lock();
      unlock();
      pause('ui'); // PAUSE
      play('ui'); // servicio vivo → RESUME
      pause('lock-screen'); // el nativo ya pausó → 0 comandos
      play('lock-screen'); // el nativo ya reanudó → 0 comandos
      lock();
      unlock();
      stop(); // STOP
      if (!AUDIO_STATES.includes(audio.state)) {
        throw new Error(`audioState inválido ${audio.state} (ciclo ${i})`);
      }
      if (!LIFECYCLE_STATES.includes(lc.state)) {
        throw new Error(`lifecycle inválido ${lc.state} (ciclo ${i})`);
      }
    }
    if (plays !== 300) throw new Error(`300 plays esperados, ${plays}`);
    // 100 START (solo desde STOPPED) + 100 RESUME (reanudaciones UI) = 200
    // comandos de reproducción; 100 PAUSE (UI) + 100 STOP. Los plays de lock
    // screen (200) nunca emiten comando (el nativo ya actuó).
    if (nativeStarts !== 100) throw new Error(`100 PLAY→1 START, got ${nativeStarts}`);
    if (nativeResumes !== 100) throw new Error(`100 resume UI→1 RESUME, got ${nativeResumes}`);
    if (nativePauses !== 100) throw new Error(`100 pause UI→1 PAUSE, got ${nativePauses}`);
    if (nativeStops !== 100) throw new Error(`100 STOP→1 STOP, got ${nativeStops}`);
    if (audio.state !== 'STOPPED') throw new Error('tras 100 ciclos debe quedar STOPPED, quedó ' + audio.state);
    if (lc.state !== 'STOPPED') throw new Error('lifecycle debe quedar STOPPED, quedó ' + lc.state);
    // Invariante central: el número de START equivale exactamente al de plays
    // desde detenido; los lock/unlock (200 eventos) no generaron NINGÚN comando.
    if (nativeStarts + nativeResumes !== 200) {
      throw new Error('cada play de usuario = exactamente 1 comando de reproducción');
    }
  });

  runTest('P5.6: en APK el motor web es PERMANENTEMENTE inaudible (frontera estructural)', () =>
    withFakeWindow(() => {
      const engine = new BinauralEngine();
      engine.setPlatformMuted(true); // APK: native = único owner
      engine.start({ base: 200, beat: 6, volume: 0.5 });
      // C2 — el fade-in del start NO debe elevar la ganancia.
      if (engine.masterGain.gain.value > 0.02) {
        throw new Error('start() en modo APK no debe subir la ganancia');
      }
      // C2 — setCondition en vivo: el crossfade baja pero jamás sube.
      engine.setCondition('amplitude-modulation');
      if (engine.masterGain.gain.value > 0.02) {
        throw new Error('setCondition() en APK no debe subir la ganancia');
      }
      // setVolume / recoverFade / fadeTo: ninguna sube en APK.
      engine.setVolume(0.8);
      if (engine.masterGain.gain.value > 0.02) throw new Error('setVolume() en APK no debe subir');
      engine.recoverFade(0.6, 0.8);
      if (engine.masterGain.gain.value > 0.02) throw new Error('recoverFade() en APK no debe subir');
      engine.fadeTo(0.5, 0.4);
      if (engine.masterGain.gain.value > 0.02) throw new Error('fadeTo() en APK no debe subir');
      // Con la política OFF (Web/PWA) el MISMO motor sí rampea al volumen.
      const web = new BinauralEngine();
      web.start({ base: 200, beat: 6, volume: 0.5 });
      if (web.masterGain.gain.value < 0.3) {
        throw new Error(`en web el start debe rampear al volumen de sesión, quedó ${web.masterGain.gain.value}`);
      }
    }),
  );

  runTest('P5.6: jerarquía de comandos — alarma, autostart y RETUNE jamás generan PLAY (main.js)', async () => {
    // Node-only (lee el disco): invariante automatizada de la jerarquía de
    // comandos. En el navegador pasa sin costo (verificación en vivo aparte).
    if (typeof process === 'undefined') return;
    const fsSpec = 'node:fs';
    const fs = await import(/* @vite-ignore */ fsSpec);
    const root = process.cwd();
    const js = fs.readFileSync(root + '/src/main.js', 'utf8');
    // B1 — el handler de alarma (onFire) no debe arrancar la sesión.
    const onFireIdx = js.indexOf('onFire: (alarm) => {');
    const onFireEnd = js.indexOf('onSync: renderAlarms');
    if (onFireIdx < 0 || onFireEnd < 0 || onFireEnd < onFireIdx) {
      throw new Error('no se encontró el bloque onFire del AlarmManager');
    }
    const onFireBlock = js.slice(onFireIdx, onFireEnd);
    if (onFireBlock.includes('start();')) throw new Error('B1: la alarma no debe llamar start()');
    // C1 — el bloque deepAutostart no debe llamar start().
    const autoIdx = js.indexOf('if (deepAutostart &&');
    const autoEnd = js.indexOf('// P4-B', autoIdx);
    if (autoIdx < 0 || autoEnd < 0 || autoEnd < autoIdx) {
      throw new Error('no se encontró el bloque deepAutostart');
    }
    const autoBlock = js.slice(autoIdx, autoEnd);
    if (autoBlock.includes('start();')) throw new Error('C1: el autostart no debe llamar start()');
    // H3 — RETUNE nunca significa START.
    const retuneIdx = js.indexOf('function syncNativeAudioRetune');
    const retuneEnd = js.indexOf('function syncNativeAudioStop');
    if (retuneIdx < 0 || retuneEnd < 0 || retuneEnd < retuneIdx) {
      throw new Error('no se encontró syncNativeAudioRetune');
    }
    const retuneBlock = js.slice(retuneIdx, retuneEnd);
    if (retuneBlock.includes('startBackgroundAudio')) {
      throw new Error('H3: RETUNE no puede emitir START (startBackgroundAudio prohibido)');
    }
    // R2 — los comandos de config nativos pasan por el coalescer (una ráfaga
    // de volumen/onda/retune = 1 comando; el startId no debe inflarse).
    if (!retuneBlock.includes('nativeCmdCoalescer.schedule')) {
      throw new Error('R2: syncNativeAudioRetune debe coalescerse (nativeCmdCoalescer.schedule)');
    }
    // R1 — tras el resync con sesión nativa activa, la máquina debe llegar a
    // PLAYING (transición 'started' tras 'system_play' en syncUiWithNativeSession).
    const syncIdx = js.indexOf('function syncUiWithNativeSession');
    const syncEnd = js.indexOf('// Capacidades fusionadas', syncIdx);
    if (syncIdx < 0 || syncEnd < 0 || syncEnd < syncIdx) {
      throw new Error('no se encontró syncUiWithNativeSession');
    }
    const syncBlock = js.slice(syncIdx, syncEnd);
    if (!syncBlock.includes("audioState.transition('started'")) {
      throw new Error('R1: el resync debe transicionar a PLAYING (falta \'started\' tras system_play)');
    }
    // F2 — seleccionar ambiente SIN sesión no puede arrancar el reproductor.
    const ambientIdx = js.indexOf('ambientOptions.addEventListener');
    const ambientEnd = js.indexOf('// ---------------------------------------------------------------- Personalizado', ambientIdx);
    if (ambientIdx < 0 || ambientEnd < 0 || ambientEnd < ambientIdx) {
      throw new Error('no se encontró el handler del mixer de ambiente');
    }
    const ambientBlock = js.slice(ambientIdx, ambientEnd);
    if (ambientBlock.includes('start();')) {
      throw new Error('F2: el mixer de ambiente no debe llamar start() sin sesión');
    }
  });

  runTest('fullscreen: la burbuja de bugs se oculta en :fullscreen y .immersive', async () => {
    if (typeof process === 'undefined') return;
    const fsSpec = 'node:fs';
    const fs = await import(/* @vite-ignore */ fsSpec);
    const root = process.cwd();
    const css = fs.readFileSync(root + '/src/site.css', 'utf8');
    for (const sel of ['html:fullscreen .bug-fab', 'html:-webkit-full-screen .bug-fab', 'body.immersive .bug-fab']) {
      if (!css.includes(sel)) throw new Error(`site.css debe ocultar la burbuja con "${sel}"`);
    }
    const ruleIdx = css.indexOf('html:fullscreen .bug-fab');
    if (ruleIdx < 0 || !css.slice(ruleIdx, ruleIdx + 260).includes('display: none')) {
      throw new Error('la regla de fullscreen debe ocultar la burbuja con display:none');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // APK TIME PICKER — reemplazo del <input type="time"> nativo (P6): bug real
  // confirmado en producción, el TimePickerDialog del WebView de Android
  // guardó "12:56" (mediodía) como "00:56" (medianoche) — un desfasaje de
  // 12 h en el límite AM/PM del mediodía. Estos tests cubren exactamente ese
  // límite y sus vecinos, para que un futuro cambio no lo reintroduzca.
  // ──────────────────────────────────────────────────────────────────────────

  runTest('ApkTimePicker: mediodía (12 PM) y medianoche (12 AM) no se confunden', () => {
    // El bug real: 12 con PM debe dar 12:xx (mediodía), NUNCA 00:xx.
    if (to24h(12, '56', 'PM') !== '12:56') throw new Error('12 PM debe ser 12:56, no medianoche');
    if (to24h(12, '00', 'AM') !== '00:00') throw new Error('12 AM debe ser medianoche (00:00)');
    if (to24h(12, '00', 'PM') !== '12:00') throw new Error('12 PM en punto debe ser mediodía (12:00)');
  });

  runTest('ApkTimePicker: to24h — horas comunes AM/PM', () => {
    if (to24h(1, '05', 'AM') !== '01:05') throw new Error('1:05 AM');
    if (to24h(11, '30', 'AM') !== '11:30') throw new Error('11:30 AM');
    if (to24h(1, '05', 'PM') !== '13:05') throw new Error('1:05 PM debe ser 13:05');
    if (to24h(11, '30', 'PM') !== '23:30') throw new Error('11:30 PM debe ser 23:30');
  });

  runTest('ApkTimePicker: from24h es el inverso exacto de to24h (round-trip)', () => {
    const cases = [
      [12, '56', 'PM'],
      [12, '00', 'AM'],
      [1, '05', 'AM'],
      [11, '30', 'PM'],
    ];
    for (const [h12, minute, ampm] of cases) {
      const packed = to24h(h12, minute, ampm);
      const unpacked = from24h(packed);
      if (unpacked.h12 !== h12 || unpacked.minute !== minute || unpacked.ampm !== ampm) {
        throw new Error(`round-trip roto para ${h12}:${minute} ${ampm} → "${packed}" → ${JSON.stringify(unpacked)}`);
      }
    }
  });

  runTest('ApkTimePicker: from24h de un valor vacío/inválido cae a un default seguro', () => {
    const empty = from24h('');
    if (empty.h12 !== 12 || empty.minute !== '00' || empty.ampm !== 'PM') {
      throw new Error('valor vacío debe caer a 12:00 PM, no a un estado indefinido');
    }
    const garbage = from24h('no-es-una-hora');
    if (garbage.h12 !== 12 || garbage.ampm !== 'PM') throw new Error('valor basura debe caer al mismo default seguro');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────

  await Promise.all(pending);
  console.log(`\n%cResults: ${passed} Passed, ${failed} Failed`, failed > 0 ? 'color: #f87171' : 'color: #4ade80');
  console.groupEnd();
  
  return { passed, failed };
}
