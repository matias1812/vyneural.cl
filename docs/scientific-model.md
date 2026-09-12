# Modelo científico

> Todo modelo está clasificado. Vocabulario del plan:
> **PHYSICAL** (deriva de un modelo físico) · **NEURAL** (neurofisiológico
> reducido) · **PSYCHOLOGICAL** (fenomenológico) · **VISUAL** (decisión de
> representación) · **EMPIRICAL** (parámetro basado en evidencia) ·
> **HEURISTIC** (aproximación sin validación directa).
>
> Etiquetas de honestidad (Fase 17): **MEASURED | SIMULATED | DERIVED |
> ESTIMATED | HEURISTIC**.

## 1. Estímulo (StimulusState · PHYSICAL)

| Variable | Definición | Clase |
|---|---|---|
| `carrierFrequency` | Frecuencia base (ambos oídos) | PHYSICAL |
| `beatFrequency` | Δf = f_R − f_L (diferencia *física*) | PHYSICAL |
| `left/rightFrequency` | f_L = carrier, f_R = carrier + Δf | DERIVED |
| `amplitude` | Ganancia maestra [0,1] | PHYSICAL |
| `waveform` | sine/triangle/sawtooth/square | PHYSICAL |
| `riseTime/fallTime` | Fundidos de entrada/salida | PHYSICAL |

El audio es una representación del estímulo y puede reproducirse **sin ningún
renderer** (`BinauralEngine` solo). El latido físico (Δf) **no** se equipara al
latido perceptual: eso lo decide la capa auditiva.

## 2. AuditoryStateModel (src/core/auditory.js · PSYCHOLOGICAL/EMPIRICAL)

Puente entre acústica y respuesta neural, separando el Δf físico de la
representación perceptual.

- **Ponderación A aproximada** (curvas de igual sonoridad ISO 226), normalizada
  a ~1.0 en 1 kHz y comprimida con √:

  ```
  Ra(f) = (12194²·f⁴) / ((f²+20.6²)·√((f²+107.7²)(f²+737.9²))·(f²+12194²))
  weight = clamp01(√(Ra·1.25))            ← EMPIRICAL (aprox.)
  ```

- **Enmascaramiento**: el ambiente actúa como enmascarador de banda ancha.
  `SNR = (volumen·weight)/volumenAmbiente`; si `SNR < 1.5` →
  `penalty = 1 − SNR/1.5`, dejando un residual neurológico mínimo (0.2×).

  ```
  perceptualStrength = max(0, unmaskedStrength · (1 − 0.8·penalty))   ← HEURISTIC
  ```

| Salida | Clase |
|---|---|
| `perceptualStrength` [0,1] → NeuralStateModel | HEURISTIC |
| `perceivedPhons` (mapeo 0–1 → 20–80) | HEURISTIC (pseudo-phons) |

## 3. NeuralStateModel (src/core/neural.js · NEURAL/SIMULATED)

Oscilador forzado amortiguado (aproximación de arrastre):

```
resonance(ΔF) = 1 / (1 + (ΔF/15)²)                 # Lorentziana
pullForce     = 0.05 · adaptation · perceptualStrength · resonance
dF/dt         = (F_target − F) · pullForce

adaptation    = exp(−t / τ_habituación)             # H(t) — habituación
fatigue      += fatigueRate · dt · 0.005            # acotado [0,1]
```

Bandas EEG desde la frecuencia dominante (gaussianas):

```
band(f) = exp(−(f − centro)² / (2·width²))
δ:2Hz w1.5 · θ:6Hz w2 · α:10Hz w2 · β:20Hz w6 · γ:40Hz w15
```

| Parámetro | Origen | Clase |
|---|---|---|
| `habituationTau`, `fatigueRate` | por perfil | EMPIRICAL/HEURISTIC |
| `resonanceWidth = 15` | constante del modelo | HEURISTIC |
| `perceptualStrength` (entrada) | capa auditiva | HEURISTIC |
| `dominantFreq` (salida) | derivado | NEURAL/DERIVED |

Modelo **determinista** (mismo params + misma secuencia dt → misma trayectoria;
verificado por test). Si no hay estímulo o `Δf = 0`, relaja hacia la línea base
(12 Hz) con inercia.

## 4. EegInterface (src/core/eeg.js · SIMULADO — nunca EEG real)

```
EEG = oscilaciones del modelo neural
    + ruido 1/f (Voss–McCartney, 3 registros)
    + asimetría hemisférica (sesgo individual + oscilación lenta ~30 s)
    + artefactos de parpadeo (transitorios δ/θ de 150–350 ms)
    + ruido blanco por banda
coherence = clamp01(0.4 + 0.4·adaptation − 0.2·fatigue + ruido)
```

- Auto-conectado al arrancar (flujo sintético). Tecla `E` lo desconecta.
- **Reproducible**: `new EegInterface({ seed })` produce streams idénticos bajo
  el mismo seed (mulberry32; verificado por test).
- Presentado en el HUD como `SIMULATED`; nunca como medición fisiológica.

## 5. CognitiveStateModel (src/core/cognitive.js · PSYCHOLOGICAL/ESTIMATED)

Cada variable es `{ value, confidence }` (la confianza evita falsas certezas).

```
E            = adaptation · (1 − 0.6·fatigue)         # estímulo efectivo
k            = 0.025 · E                               # acoplamiento

tArousal     = targetArousal · (0.3 + 0.7·(β + 0.5·γ))
tAttention   = targetAttention · (0.4 + 0.6·(0.6·θ + 0.4·α))
tRelaxation  = max(0, targetRelaxation · 1.3·α − 0.5·(β + γ))

dArousal    -= fatigue · arousal · 0.06 · dt           # penalización proporcional
dAttention  -= fatigue · attention · 0.09 · dt
# inhibición mutua (Yerkes–Dodson suave): arousal↔relajación ±0.08·otra·0.3·dt

flow = attention · bell(arousal) · bell(relaxation) · (1 − 0.8·fatigue) · timeBonus
       bell(x) = exp(−((x−0.5)/0.25)²), timeBonus = min(1, t/120)
       EMA con τ = 30 s (estado lento, emergente — no es un objetivo)
```

| Variable | Clase |
|---|---|
| arousal / attention / relaxation / engagement / flow | ESTIMATED |
| confidences | ESTIMATED (crecen con exposición, decaen con enmascaramiento) |
| Ecuaciones (inspiradas en psicofisiología) | HEURISTIC — **no son biomarcadores validados** |

## 6. NeuralToVisualMapper (src/core/visual.js · VISUAL/metáfora)

Única transformación Neural→Visual. Determinista y con provenance por campo.

```
coherence  = clamp01(0.3 + 0.7·relaxation)      # metáfora: relajación (proxy α)
velocity   = clamp01(0.2·(1−velScale) + velScale·(0.2 + 0.8·arousal))
complexity = clamp01(baseComplexity + 0.2·fatigue + 0.15·θ)
baseFrequency = portadora                        # PHYSICAL
```

Cada campo declara `{ class: 'VISUAL', tag: 'visual metaphor', basis, origin }`.
**Ningún renderer lee variables neuronales directamente.**

## 7. WaveField (src/wavefield.js · laboratorio de propagación)

Ecuación de onda 2D escalar (FDTD leapfrog, Δx=Δy=Δt=1):

```
u_next = 2u − u_prev + c²·∇²u        # paso físico
u_next *= damp                        # disipación (proxy EMPIRICAL)
CFL = c·√2 < 1  (clamp a c ≤ 1/√2 ≈ 0.7071)
E = ½Σ(Δu/Δt)² + ½c²Σ|∇u|²           # energía; decae ~ E₀·damp^(2t)
```

- Contorno circular libre/Neumann (∂u/∂n=0 en el borde de la máscara, reflexión
  de gradiente nulo vía celda fantasma en `step()`; era Dirichlet u=0 antes de
  la auditoría 2026-09-08 — ver esa auditoría para el porqué del cambio, y el
  test "free (Neumann) boundary" en `diagnostics.js` para la verificación
  numérica). `setCircle` / `pokeDisc`.
- Clamp de amplitud ±5.0 (no físico, registrado en `clipCount`).
- Métricas (`getPhysicsMetrics`): CFL, energía, tasa de decaimiento teórica,
  clipCount, steps. Clasificación: PHYSICAL (paso, energía) · EMPIRICAL (damp) ·
  DERIVED (CFL, tasa) · VISUAL (`render()`).

## 8. CymaticsRenderer (src/cymatics.js · modos de Bessel)

- Modos propios de cuenca circular: radiales `J_m(kr)` con condición de contorno
  libre/Neumann (`J'_m(ka)=0` — superficie libre en pared vertical, NO
  Dirichlet: los ceros usados son de la derivada de Bessel, ver `ZP_BY_M` en
  `core/plate-field.js`); dispersión gravedad-capilar `ω² = gk + (σ/ρ)k³`
  (límite de agua profunda — sin término `tanh(kh)`, no modela profundidad
  finita); respuesta
  subarmónica de Faraday (conducción a ~2× la resonancia); detuning
  `δ = ω_conducción − ω_res`.
- Modo dominante `(m, n, ω, δ)` calculado en cada render (`getDominantMode()`) y
  mostrado en el HUD como DERIVED.
- **Modos**: `cinematic` (con capas artísticas) y `scientific` (solo cantidades
  del modelo). `setRenderMode('scientific'|'cinematic')`, tecla `M`.
- **Render**: WebGL2 (GLSL ES 3.00) → WebGL1 (GLSL ES 1.00, requiere
  `OES_texture_float`) → rasterizador CPU. Fallback progresivo documentado.
- Clasificación: modos/ω/δ DERIVED/PHYSICAL · grano/arena/wobble/rotación VISUAL
  (HEURISTIC).

## 9. Perfiles (src/models/profiles.js · hipótesis, no causalidad)

Cada perfil declara `stimulus`, `neuralHypothesis` (bandas objetivo, efectos
esperados, `evidenceLevel`) y `modelParams`. Los niveles de evidencia son
honestos: `Strong | Moderate | Limited | Speculative | N/A`. Un perfil
**nunca** afirma causalidad ("6 Hz = meditación"); expresa una hipótesis
contrastable con su nivel de evidencia.

## 10. Reproducibilidad (src/core/reproducibility.js · P12)

```
MODEL_VERSION = 'bineural-reduced-order-v2'
SimulationSeed(seed)        → mulberry32 (determinista, pure integer math)
SimulationConfig({...})     → validado ([carrier 20–20000 Hz], [beat 0.1–40 Hz],
                              waveform, condition, duration, volume, modelParams)
                              + canonical() (JSON byte-idéntico sin importar orden)
buildExperimentRecord({config, seed, results}) → JSON { modelVersion, seed, config, recordedAt, results }
```

`SimulationEngine.recordExperiment()` exporta el registro del run actual.

## 11. Experimental Mode (Phase 10 — src/core/experiments.js)

Ejecuta el pipeline reducido **headless** (sin AudioContext, sin DOM) para una
condición de estímulo y devuelve una comparación reproducible:
estímulo (PHYSICAL) · bandas (NEURAL/SIMULADO) · PSD (DERIVED, FFT radix-2 de
2048 muestras @ 128 Hz sobre una traza sintética) · cognitivo (ESTIMADO) ·
visual (metáfora). Mismas semilla + config → mismos resultados (verificado).

Condiciones y su efecto en el modelo (mapeo HEURISTIC):

| Condición | Latido objetivo | Fuerza | Efecto esperado en el modelo |
|---|---|---|---|
| binaural | Δf | 0.9 | Entrenamiento pleno hacia Δf |
| AM | Δf | 0.5 | Entrenamiento más débil (envolvente) |
| tono puro | — | 0.6 | Sin ritmo → sin entrenamiento |
| ruido | — | 0.25 | Sin ritmo → sin entrenamiento |
| sin estímulo | — | 0 | Control: relaja a línea base |

El experimento se exporta como JSON reproductible (`modelVersion + seed +
config + resultados`) y desde la UI se descarga con un clic.

## 12. Audio watchdog (src/core/audio-health.js)

Lógica pura que detecta una sesión "en play pero muda" (contexto suspendido por
el SO sin `visibilitychange`, o señal nula con ganancia no nula) y decide
`resume`/`refade`. Nunca actúa con el volumen del usuario a 0. `SimulationEngine`
la aplica cada ~0.5 s; está validada por tests headless.

## 13. Límites científicos declarados

1. El EEG es **sintético** (SIMULADO), no una medición.
2. Las ecuaciones cognitivas son **heurísticas** inspiradas en la literatura,
   no biomarcadores validados.
3. El latido físico Δf ≠ latido perceptual; el modelo auditivo es una
   aproximación reducida.
4. La estética amplifica la estructura matemática, no la reemplaza: las capas
   VISUAL están etiquetadas como metáforas.
5. Verificación empírica externa: pendiente (Experimental Mode, P10).
