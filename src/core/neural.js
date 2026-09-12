// src/core/neural.js
// Neural State Model: simulates reduced-order neurophysiological variables.
// Phase 6: Entrainment Model - simulates inertia and resonance.

import { NeuralState } from './states.js';
import { assertBounds } from '../validation/assert.js';

export class NeuralStateModel {
  constructor() {
    this.state = new NeuralState();
    this.params = null;
    
    // Baseline resting brain frequency (e.g., low Beta / high Alpha)
    this.baselineFreq = 12.0; 
    
    // The current dominant frequency of the brain model
    this.currentEntrainmentFreq = this.baselineFreq; 
  }

  setProfile(profileParams) {
    this.params = profileParams;
    this.state.adaptation = 1.0;
  }

  // A Gaussian curve to distribute a single frequency into standard EEG bands
  _calculateBandPower(centerFreq, bandTarget, width) {
    const dist = centerFreq - bandTarget;
    return Math.exp(-(dist * dist) / (2 * width * width));
  }

  // Update discrete EEG bands based on the continuous currentEntrainmentFreq
  _updateBands() {
    const f = this.currentEntrainmentFreq;
    this.state.delta = this._calculateBandPower(f, 2.0, 1.5);
    this.state.theta = this._calculateBandPower(f, 6.0, 2.0);
    this.state.alpha = this._calculateBandPower(f, 10.0, 2.0);
    this.state.beta  = this._calculateBandPower(f, 20.0, 6.0);
    this.state.gamma = this._calculateBandPower(f, 40.0, 15.0);
    // Publish the dominant oscillation frequency so downstream models (e.g.
    // CognitiveStateModel) can read it directly from the state object.
    this.state.dominantFreq = f;
  }

  update(dt, isPlaying, perceptualStrength = 1.0, targetBeatFreq = 0) {
    if (!this.params) return;

    if (!isPlaying || targetBeatFreq === 0) {
      // Relax towards baseline (inertia recovery)
      const distToBaseline = this.baselineFreq - this.currentEntrainmentFreq;
      this.currentEntrainmentFreq += distToBaseline * dt * 0.05;
      // FIX (auditoría 2026-09-06): antes solo la fatiga se recuperaba en
      // pausa (y en ~100s, un ciclo de 1→0 que no tiene respaldo fisiológico:
      // la fatiga metabólica no se disipa 18x más rápido de lo que se
      // acumula). La habituación (adaptation) NUNCA se recuperaba — solo
      // setProfile() la resetea a 1.0, y start() no la llama, así que tras
      // 30+ min de pausa seguía exactamente igual de "adaptada" que al
      // cortar la sesión. Está invertido respecto a la fisiología esperada:
      // la habituación a un estímulo se disipa con el reposo (τ≈10 min
      // acá, FATIGUE_TAU_REST no aplica a esto — es ADAPT_TAU_REST); la
      // fatiga metabólica es la que tarda en irse.
      const ADAPT_TAU_REST = 600; // s — heurístico, no de la literatura.
      this.state.adaptation += (1 - this.state.adaptation) * dt / ADAPT_TAU_REST;
      const FATIGUE_TAU_REST = 900; // s — antes dt*0.01 (≈100s, 1→0):
      // asimetría de 18:1 contra el tiempo de acumulación sin justificación.
      this.state.fatigue = Math.max(0, this.state.fatigue - dt / FATIGUE_TAU_REST);
      this.state.adaptation = assertBounds(this.state.adaptation, 0, 1, 'Neural Adaptation (rest)');
      this._updateBands();
      return;
    }

    // Phase 6: Dynamic Entrainment (Forced Damped Oscillator approx)
    // 1. Calculate Resonance (Lorentzian-like curve)
    // If the target frequency is very far from the current brain frequency, 
    // the entrainment force is weaker (less resonance).
    const deltaF = Math.abs(targetBeatFreq - this.currentEntrainmentFreq);
    // width factor of the resonance curve
    const resonanceWidth = 15.0; 
    const resonanceFactor = 1.0 / (1.0 + Math.pow(deltaF / resonanceWidth, 2));

    // 2. Entrainment Pull
    // How fast the frequency shifts. Depends on adaptation (diminishing returns),
    // perceptual strength (loudness/masking), and resonance.
    const entrainmentRate = 0.05; // Base speed of state change
    // FIX (auditoría 2026-09-06): adaptation = exp(-t/tau) decae a 0, y sin
    // piso el desplazamiento TOTAL de frecuencia queda acotado por la
    // integral de esa exponencial — los presets con habituationTau corto
    // (120-200s: Profundidad, Sueño) son justo los que más lejos tienen que
    // viajar desde el basal de 12 Hz, y se quedan a mitad de camino para
    // siempre (medido: Sueño profundo objetivo 2 Hz, se estanca en 3.41 Hz).
    // La habituación debería frenar la entrada al estado, no impedirla del
    // todo. ADAPT_FLOOR (heurístico) deja un mínimo de "arrastre" incluso
    // con adaptation→0.
    const ADAPT_FLOOR = 0.25;
    const pullForce =
      entrainmentRate * (ADAPT_FLOOR + (1 - ADAPT_FLOOR) * this.state.adaptation) * perceptualStrength * resonanceFactor;
    
    // 3. Apply Inertia
    const freqDiff = targetBeatFreq - this.currentEntrainmentFreq;
    this.currentEntrainmentFreq += freqDiff * pullForce * dt;

    // Update derived bands
    this._updateBands();

    // REGRESIÓN (revisión externa 2026-09-06, sobre el fix de auditoría del
    // mismo día): esto era `adaptation = exp(-timeActive/tau)`, una
    // asignación de LAZO ABIERTO — adaptation no era estado, era una función
    // de timeActive. timeActive nunca se decrementaba en pausa, así que todo
    // lo recuperado por la rama de reposo (arriba) se pisaba en el primer
    // frame de reanudación (medido: 30min pausa → adaptation 0.952, 1 frame
    // de resume → 0.027 otra vez). Forma diferencial: matemáticamente
    // idéntica a exp(-t/tau) mientras se toca sin pausas (es su ODE:
    // dA/dt = -A/tau), pero ahora es estado real que la rama de reposo puede
    // modificar sin que se sobrescriba al reanudar. timeActive quedó sin uso
    // y se eliminó.
    this.state.adaptation += -this.state.adaptation * dt / this.params.habituationTau;

    // Fatigue grows based on the profile's cognitive load.
    // FIX (auditoría 2026-09-06): crecimiento lineal sin techo — una vez
    // fatigue > 1, assertBounds lo recorta a 1 CADA FRAME y emite
    // console.warn en cada uno (medido: 22.000+ warnings en 40 min), el
    // mismo patrón de "constant drain que excede el techo" ya identificado
    // y arreglado en cognitive.js pero no replicado acá. Ecuación saturante
    // (nunca cruza 1, se acerca asintóticamente) + disipación leve durante
    // la propia sesión (FATIGUE_TAU_ACTIVE, heurístico) para que sesiones
    // largas no queden clavadas en el techo.
    const FATIGUE_TAU_ACTIVE = 1800; // s
    this.state.fatigue +=
      (this.params.fatigueRate * (1 - this.state.fatigue) * 0.005 - this.state.fatigue / FATIGUE_TAU_ACTIVE) * dt;

    // Bounds checking
    this.state.fatigue = assertBounds(this.state.fatigue, 0, 1, 'Neural Fatigue');
    this.state.adaptation = assertBounds(this.state.adaptation, 0, 1, 'Neural Adaptation');
  }

  getState() {
    return this.state;
  }
}
