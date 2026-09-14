// src/models/profiles.js
// Multidimensional scientific profiles replacing the old hardcoded STATES array.
// UI-compatibility fields (base, beat, band, icon) are derived automatically
// from the scientific fields so the rest of main.js doesn't need re-writing yet.

const _RAW_PROFILES = [
  {
    id: 'meditacion',
    name: 'Meditación',
    desc: 'Calma mental profunda y claridad interior',
    color: '#a78bfa',
    iconKey: 'meditacion',
    featured: true,
    stimulus: { carrierBase: 210, beat: 6, modulation: 'sine' },
    neuralHypothesis: {
      targetBands: ['Theta (4-8 Hz)'],
      expectedEffects: ['arousal decrease', 'attention maintenance'],
      evidenceLevel: 'Moderate'
    },
    modelParams: { targetArousal: 0.3, targetAttention: 0.6, targetRelaxation: 0.8, fatigueRate: 0.05, habituationTau: 300 },
    visualMetaphor: { complexity: 0.4, coherence: 0.8, velocityScale: 0.4 }
  },
  {
    id: 'sueno',
    name: 'Sueño profundo',
    desc: 'Relajación total para un descanso profundo',
    color: '#60a5fa',
    iconKey: 'sueno',
    featured: true,
    stimulus: { carrierBase: 170, beat: 2, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Delta (0.5-4 Hz)'], expectedEffects: ['deep relaxation', 'sleep onset'], evidenceLevel: 'Strong' },
    modelParams: { targetArousal: 0.1, targetAttention: 0.1, targetRelaxation: 0.95, fatigueRate: 0.1, habituationTau: 150 },
    visualMetaphor: { complexity: 0.2, coherence: 0.9, velocityScale: 0.2 }
  },
  {
    id: 'relajacion',
    name: 'Relajación',
    desc: 'Reduce el estrés y la ansiedad del día',
    color: '#34d399',
    iconKey: 'relajacion',
    featured: true,
    stimulus: { carrierBase: 200, beat: 10, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Alpha (8-12 Hz)'], expectedEffects: ['stress reduction', 'calm focus'], evidenceLevel: 'Moderate' },
    modelParams: { targetArousal: 0.4, targetAttention: 0.5, targetRelaxation: 0.7, fatigueRate: 0.08, habituationTau: 250 },
    visualMetaphor: { complexity: 0.5, coherence: 0.7, velocityScale: 0.5 }
  },
  {
    id: 'concentracion',
    name: 'Concentración',
    desc: 'Atención sostenida y mayor productividad',
    color: '#fbbf24',
    iconKey: 'concentracion',
    featured: true,
    stimulus: { carrierBase: 240, beat: 16, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Beta (12-30 Hz)'], expectedEffects: ['sustained attention', 'alertness'], evidenceLevel: 'Moderate' },
    modelParams: { targetArousal: 0.7, targetAttention: 0.9, targetRelaxation: 0.3, fatigueRate: 0.12, habituationTau: 400 },
    visualMetaphor: { complexity: 0.7, coherence: 0.6, velocityScale: 0.8 }
  },
  {
    id: 'energia',
    name: 'Energía',
    desc: 'Estado de alerta, vitalidad y motivación',
    color: '#fb7185',
    iconKey: 'energia',
    featured: false,
    stimulus: { carrierBase: 260, beat: 25, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['High Beta (20-30 Hz)'], expectedEffects: ['high arousal', 'motivation'], evidenceLevel: 'Limited' },
    modelParams: { targetArousal: 0.9, targetAttention: 0.8, targetRelaxation: 0.1, fatigueRate: 0.15, habituationTau: 500 },
    visualMetaphor: { complexity: 0.8, coherence: 0.4, velocityScale: 1.0 }
  },
  {
    id: 'creatividad',
    name: 'Creatividad',
    desc: 'Flujo creativo e inspiración',
    color: '#f0abfc',
    iconKey: 'creatividad',
    featured: true,
    stimulus: { carrierBase: 220, beat: 8, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Theta/Alpha Border (7-9 Hz)'], expectedEffects: ['divergent thinking', 'flow state'], evidenceLevel: 'Limited' },
    modelParams: { targetArousal: 0.5, targetAttention: 0.4, targetRelaxation: 0.6, fatigueRate: 0.06, habituationTau: 350 },
    visualMetaphor: { complexity: 0.9, coherence: 0.5, velocityScale: 0.6 }
  },
  {
    id: 'aprendizaje',
    name: 'Aprendizaje',
    desc: 'Memoria y procesamiento profundo',
    color: '#f97316',
    iconKey: 'aprendizaje',
    featured: true,
    stimulus: { carrierBase: 280, beat: 40, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Gamma (30-100 Hz)'], expectedEffects: ['cognitive enhancement', 'memory consolidation'], evidenceLevel: 'Moderate' },
    modelParams: { targetArousal: 0.8, targetAttention: 0.95, targetRelaxation: 0.2, fatigueRate: 0.1, habituationTau: 400 },
    visualMetaphor: { complexity: 1.0, coherence: 0.8, velocityScale: 0.9 }
  },
  {
    id: 'schumann',
    name: 'Resonancia Schumann',
    desc: 'La frecuencia de la Tierra: calma y conexión',
    color: '#4ade80',
    iconKey: 'schumann',
    featured: true,
    stimulus: { carrierBase: 190, beat: 7.83, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['grounding', 'relaxation'], evidenceLevel: 'Limited' },
    modelParams: { targetArousal: 0.35, targetAttention: 0.5, targetRelaxation: 0.75, fatigueRate: 0.05, habituationTau: 300 },
    visualMetaphor: { complexity: 0.6, coherence: 0.7, velocityScale: 0.45 }
  },
  {
    id: 'sueno-ligero',
    name: 'Sueño ligero',
    desc: 'Transición suave hacia el descanso',
    color: '#818cf8',
    iconKey: 'sueno-ligero',
    featured: true,
    stimulus: { carrierBase: 180, beat: 3, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Delta (0.5-4 Hz)'], expectedEffects: ['sleep transition', 'drowsiness'], evidenceLevel: 'Strong' },
    modelParams: { targetArousal: 0.2, targetAttention: 0.2, targetRelaxation: 0.85, fatigueRate: 0.08, habituationTau: 200 },
    visualMetaphor: { complexity: 0.3, coherence: 0.85, velocityScale: 0.3 }
  },
  // --- Non-featured states (legacy preserved) ---
  { id: 'profundidad', name: 'Profundidad', desc: 'Inmersión total en el descanso', color: '#6d6ee8', iconKey: 'profundidad', stimulus: { carrierBase: 160, beat: 1, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Delta (0.5-4 Hz)'], expectedEffects: ['deep rest'], evidenceLevel: 'Strong' }, modelParams: { targetArousal: 0.05, targetAttention: 0.05, targetRelaxation: 0.98, fatigueRate: 0.12, habituationTau: 120 }, visualMetaphor: { complexity: 0.1, coherence: 0.95, velocityScale: 0.15 } },
  { id: 'calma', name: 'Calma', desc: 'Serenidad ligera para el día a día', color: '#2dd4bf', iconKey: 'calma', stimulus: { carrierBase: 195, beat: 5, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['calm', 'peace'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.25, targetAttention: 0.5, targetRelaxation: 0.78, fatigueRate: 0.05, habituationTau: 280 }, visualMetaphor: { complexity: 0.35, coherence: 0.75, velocityScale: 0.35 } },
  { id: 'intuicion', name: 'Intuición', desc: 'Conexión interior y claridad sutil', color: '#a78bfa', iconKey: 'intuicion', stimulus: { carrierBase: 205, beat: 4.5, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['intuitive thinking'], evidenceLevel: 'Limited' }, modelParams: { targetArousal: 0.3, targetAttention: 0.55, targetRelaxation: 0.75, fatigueRate: 0.05, habituationTau: 320 }, visualMetaphor: { complexity: 0.45, coherence: 0.7, velocityScale: 0.4 } },
  { id: 'lucidez', name: 'Lucidez', desc: 'Mente despejada y foco agudo', color: '#f59e0b', iconKey: 'lucidez', stimulus: { carrierBase: 250, beat: 18, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Beta (12-30 Hz)'], expectedEffects: ['mental clarity'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.65, targetAttention: 0.85, targetRelaxation: 0.35, fatigueRate: 0.1, habituationTau: 380 }, visualMetaphor: { complexity: 0.7, coherence: 0.65, velocityScale: 0.75 } },
  { id: 'alerta', name: 'Alerta', desc: 'Energía y disposición inmediata', color: '#f87171', iconKey: 'alerta', stimulus: { carrierBase: 270, beat: 22, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Beta (12-30 Hz)'], expectedEffects: ['alertness'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.85, targetAttention: 0.75, targetRelaxation: 0.15, fatigueRate: 0.13, habituationTau: 450 }, visualMetaphor: { complexity: 0.75, coherence: 0.5, velocityScale: 0.9 } },
  { id: 'memoria', name: 'Memoria', desc: 'Para acompañar el estudio y el repaso', color: '#fb923c', iconKey: 'memoria', stimulus: { carrierBase: 300, beat: 32, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Gamma (30-100 Hz)'], expectedEffects: ['memory encoding'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.75, targetAttention: 0.9, targetRelaxation: 0.25, fatigueRate: 0.1, habituationTau: 400 }, visualMetaphor: { complexity: 0.9, coherence: 0.75, velocityScale: 0.85 } },
  { id: 'armonia', name: 'Armonía', desc: 'Equilibrio emocional y bienestar', color: '#38bdf8', iconKey: 'armonia', stimulus: { carrierBase: 215, beat: 9, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Alpha (8-12 Hz)'], expectedEffects: ['emotional balance'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.45, targetAttention: 0.55, targetRelaxation: 0.65, fatigueRate: 0.07, habituationTau: 260 }, visualMetaphor: { complexity: 0.55, coherence: 0.72, velocityScale: 0.55 } },
  { id: 'despertar', name: 'Despertar', desc: 'Saliendo del sueño con suavidad', color: '#fbbf24', iconKey: 'despertar', stimulus: { carrierBase: 230, beat: 12, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Alpha (8-12 Hz)'], expectedEffects: ['alerting', 'morning readiness'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.55, targetAttention: 0.6, targetRelaxation: 0.45, fatigueRate: 0.08, habituationTau: 350 }, visualMetaphor: { complexity: 0.6, coherence: 0.62, velocityScale: 0.65 } },
  { id: 'foco', name: 'Foco profundo', desc: 'Atención sostenida sin distraerte', color: '#34d399', iconKey: 'foco', stimulus: { carrierBase: 260, beat: 14, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Beta (12-30 Hz)'], expectedEffects: ['focus', 'productivity'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.62, targetAttention: 0.88, targetRelaxation: 0.38, fatigueRate: 0.1, habituationTau: 390 }, visualMetaphor: { complexity: 0.65, coherence: 0.68, velocityScale: 0.72 } },
  { id: 'renovacion', name: 'Renovación', desc: 'Descanso reparador de la noche', color: '#4ade80', iconKey: 'renovacion', stimulus: { carrierBase: 175, beat: 2.5, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Delta (0.5-4 Hz)'], expectedEffects: ['recovery', 'sleep'], evidenceLevel: 'Strong' }, modelParams: { targetArousal: 0.15, targetAttention: 0.15, targetRelaxation: 0.9, fatigueRate: 0.09, habituationTau: 180 }, visualMetaphor: { complexity: 0.25, coherence: 0.88, velocityScale: 0.25 } },
  { id: 'silencio', name: 'Silencio interior', desc: 'Vacío mental y paz profunda', color: '#c4b5fd', iconKey: 'silencio', stimulus: { carrierBase: 200, beat: 3.5, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Delta/Theta Border (3-5 Hz)'], expectedEffects: ['mental silence', 'peace'], evidenceLevel: 'Limited' }, modelParams: { targetArousal: 0.15, targetAttention: 0.3, targetRelaxation: 0.88, fatigueRate: 0.06, habituationTau: 240 }, visualMetaphor: { complexity: 0.3, coherence: 0.82, velocityScale: 0.3 } },
  { id: 'vitalidad', name: 'Vitalidad', desc: 'Arrancar el día con energía', color: '#fde047', iconKey: 'vitalidad', stimulus: { carrierBase: 265, beat: 20, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Beta (12-30 Hz)'], expectedEffects: ['vitality', 'energy'], evidenceLevel: 'Limited' }, modelParams: { targetArousal: 0.8, targetAttention: 0.7, targetRelaxation: 0.2, fatigueRate: 0.12, habituationTau: 480 }, visualMetaphor: { complexity: 0.78, coherence: 0.45, velocityScale: 0.92 } },
  { id: 'vision', name: 'Visión clara', desc: 'Claridad mental y comprensión rápida', color: '#f472b6', iconKey: 'vision', stimulus: { carrierBase: 310, beat: 38, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Gamma (30-100 Hz)'], expectedEffects: ['high-frequency processing'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.82, targetAttention: 0.92, targetRelaxation: 0.18, fatigueRate: 0.1, habituationTau: 410 }, visualMetaphor: { complexity: 0.95, coherence: 0.82, velocityScale: 0.88 } },
  { id: 'gamma-60', name: 'Gamma 60', desc: 'Entrenamiento gamma de alta frecuencia (60 Hz) — experimental', color: '#e879f9', iconKey: 'gamma-60', stimulus: { carrierBase: 330, beat: 60, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Gamma (30-100 Hz)'], expectedEffects: ['high-frequency entrainment'], evidenceLevel: 'Speculative' }, modelParams: { targetArousal: 0.85, targetAttention: 0.9, targetRelaxation: 0.15, fatigueRate: 0.12, habituationTau: 420 }, visualMetaphor: { complexity: 1.0, coherence: 0.85, velocityScale: 0.95 } },
  { id: 'gamma-100', name: 'Gamma 100', desc: 'Gamma muy alta (100 Hz): frontera experimental, usá auriculares de buena respuesta', color: '#f0abfc', iconKey: 'gamma-100', stimulus: { carrierBase: 350, beat: 100, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Gamma (30-100 Hz)'], expectedEffects: ['very high frequency processing'], evidenceLevel: 'Speculative' }, modelParams: { targetArousal: 0.9, targetAttention: 0.95, targetRelaxation: 0.1, fatigueRate: 0.15, habituationTau: 450 }, visualMetaphor: { complexity: 1.0, coherence: 0.9, velocityScale: 1.0 } },
  { id: 'estudio', name: 'Estudio', desc: 'Concentración para aprender', color: '#93c5fd', iconKey: 'estudio', stimulus: { carrierBase: 245, beat: 15, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Beta (12-30 Hz)'], expectedEffects: ['study focus', 'retention'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.65, targetAttention: 0.88, targetRelaxation: 0.35, fatigueRate: 0.1, habituationTau: 390 }, visualMetaphor: { complexity: 0.68, coherence: 0.67, velocityScale: 0.73 } },
  { id: 'paz', name: 'Paz', desc: 'Serenidad total en el presente', color: '#e0e7ff', iconKey: 'paz', stimulus: { carrierBase: 190, beat: 4, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['deep peace', 'present awareness'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.2, targetAttention: 0.45, targetRelaxation: 0.85, fatigueRate: 0.05, habituationTau: 290 }, visualMetaphor: { complexity: 0.32, coherence: 0.8, velocityScale: 0.33 } },
  { id: 'equilibrio', name: 'Equilibrio', desc: 'Calma y estabilidad emocional', color: '#5eead4', iconKey: 'equilibrio', stimulus: { carrierBase: 210, beat: 7, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['emotional balance', 'stability'], evidenceLevel: 'Moderate' }, modelParams: { targetArousal: 0.38, targetAttention: 0.52, targetRelaxation: 0.72, fatigueRate: 0.06, habituationTau: 270 }, visualMetaphor: { complexity: 0.48, coherence: 0.74, velocityScale: 0.45 } },
  { id: 'gateway', name: 'Gateway', desc: 'El experimento: expansión de conciencia (Foco 10)', color: '#a78bfa', iconKey: 'gateway', stimulus: { carrierBase: 200, beat: 4, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['expanded awareness'], evidenceLevel: 'Speculative' }, modelParams: { targetArousal: 0.25, targetAttention: 0.6, targetRelaxation: 0.8, fatigueRate: 0.05, habituationTau: 350 }, visualMetaphor: { complexity: 0.6, coherence: 0.78, velocityScale: 0.4 } },
  { id: 'hemisync', name: 'Hemi-Sync', desc: 'Sincronización de hemisferios (Foco 12)', color: '#818cf8', iconKey: 'hemisync', stimulus: { carrierBase: 210, beat: 5.5, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['hemispheric synchrony'], evidenceLevel: 'Limited' }, modelParams: { targetArousal: 0.28, targetAttention: 0.58, targetRelaxation: 0.78, fatigueRate: 0.05, habituationTau: 330 }, visualMetaphor: { complexity: 0.5, coherence: 0.76, velocityScale: 0.42 } },
  { id: 'schumann-armonico', name: 'Schumann 14,3', desc: '2ª armónica de la resonancia de Schumann (14,3 Hz) — experimental', color: '#34d399', iconKey: 'schumann', stimulus: { carrierBase: 190, beat: 14.3, modulation: 'sine' }, neuralHypothesis: { targetBands: ['Alpha/Beta Border (13-15 Hz)'], expectedEffects: ['harmonic grounding'], evidenceLevel: 'Speculative' }, modelParams: { targetArousal: 0.45, targetAttention: 0.55, targetRelaxation: 0.65, fatigueRate: 0.06, habituationTau: 280 }, visualMetaphor: { complexity: 0.55, coherence: 0.7, velocityScale: 0.5 } },
  {
    id: 'solfeggio963',
    name: '963 Hz · Divino',
    desc: 'La "Frecuencia de Dios": se le atribuye activar la glándula pineal, conectar con la conciencia superior y armonizar con la unidad cósmica — sin respaldo científico físico',
    color: '#f0abfc',
    iconKey: 'solfeggio963',
    featured: false,
    stimulus: { carrierBase: 963, beat: 4, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Theta (4-8 Hz)'], expectedEffects: ['pineal activation', 'higher consciousness', 'cosmic harmony'], evidenceLevel: 'Anecdotal' },
    modelParams: { targetArousal: 0.2, targetAttention: 0.55, targetRelaxation: 0.9, fatigueRate: 0.04, habituationTau: 320 },
    visualMetaphor: { complexity: 0.5, coherence: 0.75, velocityScale: 0.4 }
  },
  {
    id: 'personalizado',
    name: 'Personalizado',
    desc: 'Diseña tu propia frecuencia a tu gusto',
    color: '#22d3ee',
    iconKey: 'personalizado',
    featured: false,
    custom: true,
    stimulus: { carrierBase: 220, beat: 10, modulation: 'sine' },
    neuralHypothesis: { targetBands: ['Custom'], expectedEffects: ['user defined'], evidenceLevel: 'N/A' },
    modelParams: { targetArousal: 0.5, targetAttention: 0.5, targetRelaxation: 0.5, fatigueRate: 0.1, habituationTau: 300 },
    visualMetaphor: { complexity: 0.5, coherence: 0.5, velocityScale: 0.5 }
  }
];

// Derive a human-readable band label from the first target band string
function _bandLabel(profile) {
  const b = profile.neuralHypothesis?.targetBands?.[0] || 'Custom';
  const beat = profile.stimulus.beat;
  return `${b.split(' ')[0]} · ${beat} Hz`;
}

/**
 * PROFILES: Full scientific profile objects with UI-compatibility shims injected.
 * Each entry exposes:
 *   .base   → stimulus.carrierBase (Hz)
 *   .beat   → stimulus.beat (Hz)
 *   .band   → human-readable band label
 *
 * The `.icon` field is injected at runtime by main.js (where ICONS is defined)
 * via the `icon` getter on each profile object.
 */
export const PROFILES = _RAW_PROFILES.map(p => ({
  ...p,
  // Legacy UI compat shims
  get base() { return p.stimulus.carrierBase; },
  get beat() { return p.stimulus.beat; },
  get band() { return _bandLabel(p); },
  // icon is set by main.js after ICONS is available
  icon: null
}));

export function getProfileById(id) {
  return PROFILES.find(p => p.id === id) || PROFILES[0];
}
