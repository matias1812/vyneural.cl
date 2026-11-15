// src/ui/hud.js
// Scientific HUD overlay (Phase 14 / Fase 16–17).
//
// DOMAINS ARE NEVER MIXED (Fase 16):
//   STIMULUS   — PHYSICAL parameters of the audio engine
//   PHYSICS    — DERIVED quantities from the physical model (Cymatics modes)
//   NEURAL     — SIMULATED reduced-order neurophysiological variables
//   COGNITIVE  — ESTIMATED phenomenological variables (value + confidence)
//   HYPOTHESIS — HEURISTIC: what the selected profile claims, with evidence level
//   EEG        — SIMULATED synthetic measurement (never presented as real EEG)
//   VISUAL     — HEURISTIC visual metaphors (never presented as neural data)
//
// HONESTY LABELS (Fase 17) — every variable carries one of:
//   MEASURED | SIMULATED | DERIVED | ESTIMATED | HEURISTIC

import { MODEL_VERSION } from '../core/reproducibility.js';

const fmt = (x, d = 2) => (typeof x === 'number' && isFinite(x) ? x.toFixed(d) : '--');

export class ScientificHUD {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = containerId;
      this.container.className = 'scientific-hud';
      document.body.appendChild(this.container);
    }

    this.container.innerHTML = `
      <div class="hud-header" id="hud-toggle" title="Clic para plegar/desplegar">
        BINEURAL ENGINE · v${MODEL_VERSION}
        <span class="hud-collapse">−</span>
      </div>
      <div class="hud-body">

        <div class="hud-section">
          <div class="hud-title">STIMULUS <span class="hud-prov">PHYSICAL</span></div>
          <div class="hud-row"><span>Carrier L</span><span id="hud-car-l">-- Hz</span></div>
          <div class="hud-row"><span>Carrier R</span><span id="hud-car-r">-- Hz</span></div>
          <div class="hud-row"><span>Beat Δf</span><span id="hud-beat">-- Hz</span></div>
          <div class="hud-row"><span>Waveform</span><span id="hud-wave">--</span></div>
          <div class="hud-row"><span>Amplitude</span><span id="hud-amp">--</span></div>
        </div>

        <div class="hud-section">
          <div class="hud-title">PHYSICS <span class="hud-prov">DERIVED</span></div>
          <div class="hud-row"><span>Mode (m,n)</span><span id="hud-mode">--</span></div>
          <div class="hud-row"><span>ω_res</span><span id="hud-omega">-- rad/s</span></div>
          <div class="hud-row"><span>δ detuning</span><span id="hud-delta">-- rad/s</span></div>
          <div class="hidden" id="hud-response-row">
            <div class="hud-row"><span>Relative modal amplitude</span><span id="hud-response">--</span></div>
            <div class="hud-row"><span>Pattern scale</span><span>Normalized</span></div>
          </div>
          <div class="hud-row"><span>Energy</span><span id="hud-energy">--</span></div>
          <div class="hud-row"><span>Q factor</span><span id="hud-q">--</span></div>
        </div>

        <div class="hud-section">
          <div class="hud-title">NEURAL MODEL <span class="hud-prov">SIMULATED</span></div>
          <div class="hud-row"><span>Delta</span><span id="hud-n-delta">0.00</span></div>
          <div class="hud-row"><span>Theta</span><span id="hud-n-theta">0.00</span></div>
          <div class="hud-row"><span>Alpha</span><span id="hud-n-alpha">0.00</span></div>
          <div class="hud-row"><span>Beta</span><span id="hud-n-beta">0.00</span></div>
          <div class="hud-row"><span>Gamma</span><span id="hud-n-gamma">0.00</span></div>
          <div class="hud-row"><span>Aperiodic 1/f</span><span id="hud-n-ape">--</span></div>
          <div class="hud-row"><span>Dominant freq</span><span id="hud-n-df">-- Hz</span></div>
        </div>

        <div class="hud-section">
          <div class="hud-title">COGNITIVE <span class="hud-prov">ESTIMATED</span></div>
          <div class="hud-row"><span>Arousal</span><span id="hud-c-arousal">0.00 <i>c--</i></span></div>
          <div class="hud-row"><span>Attention</span><span id="hud-c-attention">0.00 <i>c--</i></span></div>
          <div class="hud-row"><span>Relaxation</span><span id="hud-c-relaxation">0.00 <i>c--</i></span></div>
          <div class="hud-row"><span>Fatigue</span><span id="hud-c-fatigue">0.00</span></div>
          <div class="hud-row"><span>Flow (emergent)</span><span id="hud-c-flow">0.00 <i>c--</i></span></div>
        </div>

        <div class="hud-section">
          <div class="hud-title">HYPOTHESIS <span class="hud-prov">HEURISTIC</span></div>
          <div class="hud-row"><span>Target band</span><span id="hud-band">--</span></div>
          <div class="hud-row"><span>Expected</span><span id="hud-effects">--</span></div>
          <div class="hud-row"><span>Evidence</span><span id="hud-evidence">--</span></div>
        </div>

        <div class="hud-section">
          <div class="hud-title">EEG <span class="hud-prov" id="hud-eeg-prov">SIMULATED</span></div>
          <div id="hud-eeg-container">
            <div class="hud-row"><span>Stream</span><span class="hud-warning" id="hud-eeg-status">NOT CONNECTED</span></div>
          </div>
        </div>

        <div class="hud-section">
          <div class="hud-title">VISUAL <span class="hud-prov">HEURISTIC · metaphor</span></div>
          <div class="hud-row"><span>Coherence</span><span id="hud-v-coherence">0.00</span></div>
          <div class="hud-row"><span>Complexity</span><span id="hud-v-complexity">0.00</span></div>
          <div class="hud-row"><span>Motion</span><span id="hud-v-velocity">0.00</span></div>
          <div class="hud-row"><span>Basis</span><span id="hud-v-basis">--</span></div>
        </div>

      </div>
    `;

    this.els = {
      header: document.getElementById('hud-toggle'),
      body: this.container.querySelector('.hud-body'),
      carL: document.getElementById('hud-car-l'),
      carR: document.getElementById('hud-car-r'),
      beat: document.getElementById('hud-beat'),
      wave: document.getElementById('hud-wave'),
      amp: document.getElementById('hud-amp'),
      mode: document.getElementById('hud-mode'),
      omega: document.getElementById('hud-omega'),
      delta: document.getElementById('hud-delta'),
      responseRow: document.getElementById('hud-response-row'),
      response: document.getElementById('hud-response'),
      energy: document.getElementById('hud-energy'),
      q: document.getElementById('hud-q'),
      nDelta: document.getElementById('hud-n-delta'),
      nTheta: document.getElementById('hud-n-theta'),
      nAlpha: document.getElementById('hud-n-alpha'),
      nBeta: document.getElementById('hud-n-beta'),
      nGamma: document.getElementById('hud-n-gamma'),
      nApe: document.getElementById('hud-n-ape'),
      nDf: document.getElementById('hud-n-df'),
      cArousal: document.getElementById('hud-c-arousal'),
      cAttention: document.getElementById('hud-c-attention'),
      cRelaxation: document.getElementById('hud-c-relaxation'),
      cFatigue: document.getElementById('hud-c-fatigue'),
      cFlow: document.getElementById('hud-c-flow'),
      band: document.getElementById('hud-band'),
      effects: document.getElementById('hud-effects'),
      evidence: document.getElementById('hud-evidence'),
      eegContainer: document.getElementById('hud-eeg-container'),
      eegStatus: document.getElementById('hud-eeg-status'),
      eegProv: document.getElementById('hud-eeg-prov'),
      vCoherence: document.getElementById('hud-v-coherence'),
      vComplexity: document.getElementById('hud-v-complexity'),
      vVelocity: document.getElementById('hud-v-velocity'),
      vBasis: document.getElementById('hud-v-basis'),
      eeg: null,
    };

    this.eegActive = false;
    this.els.header.addEventListener('click', () => this.toggle());

    // Hidden by default: the scientific panel is opt-in. A dedicated button
    // (hud-btn) calls toggleVisible(). While hidden, updates keep running
    // cheaply so opening it always shows fresh values.
    this.container.classList.add('hidden');
  }

  /** Collapse/expand the HUD body (keeps the header visible). */
  toggle() {
    this.container.classList.toggle('collapsed');
  }

  /** Show/hide the whole panel. Returns the new visibility state. */
  setVisible(on) {
    this.container.classList.toggle('hidden', !on);
    if (typeof this.onVisibilityChange === 'function') this.onVisibilityChange(!!on);
    return !!on;
  }

  /** Toggle panel visibility. Returns the new state (true = visible). */
  toggleVisible() {
    const visible = this.container.classList.contains('hidden');
    return this.setVisible(visible);
  }

  _updateEEG(eeg) {
    if (eeg) {
      if (!this.eegActive) {
        this.eegActive = true;
        this.els.eegStatus.style.display = 'none';
        this.els.eegContainer.innerHTML = `
          <div class="hud-row"><span>δ θ α β γ</span><span id="hud-eeg-bands"></span></div>
          <div class="hud-row"><span>Coherence</span><span id="hud-eeg-coherence">--</span></div>
          <div class="hud-row"><span>Asymmetry</span><span id="hud-eeg-asymmetry">--</span></div>
        `;
        this.els.eeg = {
          bands: document.getElementById('hud-eeg-bands'),
          coherence: document.getElementById('hud-eeg-coherence'),
          asymmetry: document.getElementById('hud-eeg-asymmetry'),
        };
      }
      this.els.eeg.bands.innerText =
        `${fmt(eeg.delta)} ${fmt(eeg.theta)} ${fmt(eeg.alpha)} ${fmt(eeg.beta)} ${fmt(eeg.gamma)}`;
      this.els.eeg.coherence.innerText = fmt(eeg.coherence);
      this.els.eeg.asymmetry.innerText = fmt(eeg.asymmetry, 3);
    } else if (this.eegActive) {
      this.eegActive = false;
      this.els.eegContainer.innerHTML =
        `<div class="hud-row"><span>Stream</span><span class="hud-warning" id="hud-eeg-status">NOT CONNECTED</span></div>`;
      this.els.eegStatus = document.getElementById('hud-eeg-status');
      this.els.eeg = null;
    }
  }

  /**
   * @param {object} d
   * @param {object} [d.stimulus]   { base, beat, waveform, amplitude }
   * @param {object} [d.neural]     NeuralState
   * @param {object} [d.cognitive]  CognitiveState
   * @param {object} [d.hypothesis] { targetBands, expectedEffects, evidenceLevel }
   * @param {object} [d.eeg]        EEGState
   * @param {object} [d.dominantMode] { m, n, omega, detuning, response }
   * @param {object} [d.visual]     VisualState
   */
  update({ stimulus, neural, cognitive, hypothesis, eeg, dominantMode, visual } = {}) {
    if (stimulus) {
      this.els.carL.innerText = `${fmt(stimulus.base, 1)} Hz`;
      this.els.carR.innerText = `${fmt(stimulus.base + stimulus.beat, 1)} Hz`;
      this.els.beat.innerText = `${fmt(stimulus.beat)} Hz`;
      this.els.wave.innerText = stimulus.waveform || '--';
      this.els.amp.innerText = fmt(stimulus.amplitude);
    }

    if (dominantMode) {
      this.els.mode.innerText = `(${dominantMode.m}, ${dominantMode.n})`;
      this.els.omega.innerText = `${fmt(dominantMode.omega, 1)} rad/s`;
      const sign = dominantMode.detuning >= 0 ? '+' : '';
      this.els.delta.innerText = `${sign}${fmt(dominantMode.detuning, 1)} rad/s`;
    }
    const response = dominantMode?.response;
    this.els.responseRow.classList.toggle('hidden', response == null);
    if (response != null) this.els.response.innerText = `${fmt(100 * response, 1)} %`;
    if (dominantMode?.energy != null) this.els.energy.innerText = fmt(dominantMode.energy, 3);
    if (dominantMode?.q != null) this.els.q.innerText = fmt(dominantMode.q, 1);

    if (neural) {
      this.els.nDelta.innerText = fmt(neural.delta);
      this.els.nTheta.innerText = fmt(neural.theta);
      this.els.nAlpha.innerText = fmt(neural.alpha);
      this.els.nBeta.innerText = fmt(neural.beta);
      this.els.nGamma.innerText = fmt(neural.gamma);
      this.els.nApe.innerText = neural.aperiodic1f ? fmt(neural.aperiodic1f) : 'pink (on)';
      this.els.nDf.innerText = `${fmt(neural.dominantFreq, 1)} Hz`;
    }

    if (cognitive) {
      const c = (obj) => (obj ? `${fmt(obj.value)} <i>c${fmt(obj.confidence)}</i>` : '--');
      this.els.cArousal.innerHTML = c(cognitive.arousal);
      this.els.cAttention.innerHTML = c(cognitive.attention);
      this.els.cRelaxation.innerHTML = c(cognitive.relaxation);
      this.els.cFatigue.innerText = fmt(cognitive.fatigue ?? neural?.fatigue);
      this.els.cFlow.innerHTML = c(cognitive.flow);
    }

    if (hypothesis) {
      this.els.band.innerText = (hypothesis.targetBands || []).join(', ') || '--';
      this.els.effects.innerText = (hypothesis.expectedEffects || []).join(', ') || '--';
      this.els.evidence.innerText = hypothesis.evidenceLevel || '--';
    }

    this._updateEEG(eeg);

    if (visual) {
      this.els.vCoherence.innerText = fmt(visual.coherence);
      this.els.vComplexity.innerText = fmt(visual.complexity);
      this.els.vVelocity.innerText = fmt(visual.velocity);
      const bases = Object.values(visual.provenance || {})
        .map((p) => p.basis)
        .filter(Boolean);
      this.els.vBasis.innerText = bases.length ? bases.join(' · ') : 'visual metaphor';
    }
  }
}
