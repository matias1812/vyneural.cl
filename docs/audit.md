# Auditoría y Baseline — Bineural / Vyneural (Fase 0)

> Fecha: 2026-08-14 · Rama: `dev` · Build: `npm run build` ✓ · Suite científica: `npm test` ✓ (25 tests)
>
> Este documento es el baseline del "Plan Maestro de Evolución Científico-Tecnológica".
> Se actualiza al cerrar cada fase con su Test Final de Integridad.
>
> **Documentación relacionada**: [architecture.md](architecture.md) ·
> [scientific-model.md](scientific-model.md) · [validation.md](validation.md) ·
> [development.md](development.md) · [README.md](../README.md)

---

## CURRENT ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────┐
│ UI (index.html + main.js + site.js)                                  │
│   estados/profiles → SimulationEngine → BinauralEngine (Web Audio)   │
│   Visualizadores: WaveField (💧) · CymaticsRenderer (🔮) · starfield │
├─────────────────────────────────────────────────────────────────────┤
│ LAYERED SCIENTIFIC PIPELINE (src/core) — SimulaciónEngine.loop():    │
│   Stimulus (audio) → Auditory → Neural → EEG → Cognitive → Visual    │
│   cada paso es un modelo separado con estado propio                  │
├─────────────────────────────────────────────────────────────────────┤
│ Validación: src/validation (assert.js + diagnostics.js)              │
│   headless: npm test · navegador: window.runBineuralDiagnostics()    │
│ Reproducibilidad: src/core/reproducibility.js (seed/config/version)  │
└─────────────────────────────────────────────────────────────────────┘
```

| Módulo | Archivo | Estado |
|---|---|---|
| BinauralEngine (audio) | `src/audio.js` | Activo (Web Audio, ramps, beat-pulse) |
| AmbientEngine | `src/ambient.js` | Activo (6 paisajes sonoros) |
| WaveField (FDTD 2D) | `src/wavefield.js` | Activo (laboratorio de propagación) |
| CymaticsRenderer (GL) | `src/cymatics.js` | Activo (modos de Bessel, WebGL2→WebGL1→CPU) |
| StimulusState / PhysicalState / NeuralState / EEGState / CognitiveState / VisualState | `src/core/states.js` | Activo (Datos puros, sin lógica) |
| AuditoryStateModel | `src/core/auditory.js` | Activo (Fletcher-Munson + enmascaramiento) |
| NeuralStateModel | `src/core/neural.js` | Activo (entrenamiento por oscilador forzado) |
| EegInterface (sintético) | `src/core/eeg.js` | Activo (1/f, asimetría, parpadeos, coherencia) |
| CognitiveStateModel | `src/core/cognitive.js` | Activo (arousal/atención/relajación + flow emergente + confianza) |
| NeuralToVisualMapper | `src/core/visual.js` | Activo (mapeo explícito con provenance) |
| SimulationEngine | `src/core/simulation.js` | Activo (orquestador + bucle) |
| Profiles (científicos) | `src/models/profiles.js` | Activo (28 perfiles + hipótesis) |
| ScientificHUD | `src/ui/hud.js` | Activo (dominios agrupados + etiquetas de honestidad) |
| Diagnósticos | `src/validation/*` | Activo (54 tests headless) |
| Reproducibilidad | `src/core/reproducibility.js` | Activo (Phase 12) |
| Experimental Mode | `src/core/experiments.js` | Activo (Phase 10: 5 condiciones, FFT/PSD, export JSON) |
| Audio watchdog | `src/core/audio-health.js` | Activo (lógica pura, testeada) |
| Ancla de medios | `src/core/media-anchor.js` | Activo (WAV mudo en bucle; registra la pestaña como reproductor) |
| Lógica de permisos | `src/core/permissions.js` | Activo (decisiones puras, testeada — no adornos) |
| AudioClock (reloj maestro) | `src/core/audio-clock.js` | Activo (fase del latido desde AudioContext.currentTime) |
| AppLifecycle | `src/core/lifecycle.js` | Activo (máquina de estados FOREGROUND/BACKGROUND/SUSPENDED/…) |
| Integridad de sesión | `src/core/experiment-events.js` | Activo (eventos con audioTime + integridad %) |
| PlatformCapabilities | `src/core/capabilities.js` | Activo (capacidades reales + etiquetas honestas) |

Módulos legacy conservados pero **no** conectados al pipeline científico:
`src/starfield.js` (fondo decorativo), `src/site.js` (páginas secundarias).
`src/notifications.js` (alarmas + permisos) **sí** se usa desde `main.js`, pero
fuera del pipeline de simulación.

## CURRENT PHYSICS MODEL

**WaveField** — ecuación de onda 2D escalar con amortiguamiento (FDTD leapfrog):

```
u_tt = c²∇²u − 2γu_t
CFL = c·√2 < 1  (clamp a c ≤ 1/√2 ≈ 0.707)
E = ½Σ(Δu/Δt)² + ½c²Σ|∇u|²  (decaimiento ~ E₀·damp^(2t))
Libre/Neumann en borde circular (∂u/∂n=0, celda fantasma — era Dirichlet
antes de la auditoría 2026-09-08, ver esa fecha en wavefield.js:step())
```

Clasificación: PHYSICAL (paso), DERIVED (CFL, energía), EMPIRICAL (factor `damp`),
VISUAL (render de amplitud → píxel). Existe un clamp de amplitud no físico (5.0) que se
registra en `clipCount` para diagnóstico.

**CymaticsRenderer** — modos propios de una cuenca circular de Bessel + dispersión
gravedad-capilar (ω² = gk + (σ/ρ)k³), respuesta subarmónica de Faraday, detuning.
Dispone de modos `cinematic` y `scientific` y calcula el modo dominante `(m, n, ω, δ)`
para el HUD. Fallback WebGL2 → WebGL1 (GLSL ES 1.00) → rasterizador CPU.

## CURRENT NEURAL MODEL

Oscilador forzado amortiguado (aproximación):

```
dF/dt = (F_target − F) · k · adaptation · perceptualStrength · resonance(F_target − F)
adaptation = exp(−t / τ_habituación)
fatigue += rate · dt · 0.005   (acotado [0,1])
```

Bandas: distribución gaussiana de la frecuencia dominante sobre Delta/Theta/Alpha/Beta/Gamma.
`dominantFreq` se publica en el estado (corregido en esta auditoría; antes se leía un
`_owner` inexistente). El modelo es determinista (mismo params + misma secuencia dt →
misma trayectoria) — verificado por test.

**Clasificación:** NEURAL/SIMULATED, con parámetros EMPIRICAL/HEURISTIC declarados por perfil.

## CURRENT EEG MODEL

`EegInterface` = **EEG sintético**, explícitamente etiquetado SIMULATED (nunca se
presenta como medición fisiológica):

```
EEG = oscilaciones del NeuralStateModel
    + ruido 1/f (Voss–McCartney)
    + asimetría hemisférica (oscilación lenta ~30 s + sesgo individual)
    + artefactos de parpadeo (picos delta/theta 150–350 ms)
    + coherencia derivada de adaptación/fatiga
```

Conectado por defecto (flujo sintético activo; tecla `E` lo desconecta). Seedable
(Phase 12): con el mismo seed, dos streams son idénticos (verificado por test).

## CURRENT VISUAL MODEL

Mapeo explícito Neuronal → Visual (`NeuralToVisualMapper`, Phase 9), **única** puerta
de transformación: los renderers jamás leen variables neuronales directamente.

| Campo visual | Origen | Clase |
|---|---|---|
| Coherence | relajación (proxy alfa) | VISUAL · metáfora |
| Velocity | arousal | VISUAL · metáfora |
| Complexity | fatiga + theta | VISUAL · metáfora |
| baseFrequency | portadora del estímulo | PHYSICAL/DERIVED |

Cada campo lleva provenance (`{ class, tag, basis, origin }`) consumida por el HUD.

## CURRENT PERFORMANCE

- Build: Vite, ~150 kB JS (gzip 48 kB) en `dist`.
- Renderers: WebGL con resolución adaptativa, tablas radiales precalculadas,
  typed arrays; el bucle de simulación científica corre a rAF (barato: solo aritmética
  de estados; los renderers ya dominan el coste).
- No hay medición automática de FPS/ms por fotograma todavía (pendiente Phase 13).
- Diagnósticos headless: 36 tests en <2 s (Node).
- Experimental Mode (P10): simulación headless de 300 s en <50 ms (Node/browser).

## CURRENT SCIENTIFIC LIMITATIONS

1. **Hipótesis vs. evidencia**: los perfiles declaran `neuralHypothesis` (banda
   objetivo, efectos esperados, nivel de evidencia), pero la interfaz de marketing
   aún usa lenguaje causal ("el cerebro entra en theta"). El HUD científico corrige la
   presentación interna; falta auditar las páginas públicas (Fase 18).
2. **El latido físico (Δf) no es el latido perceptual**: `AuditoryStateModel`
   distingue ambos, pero la UI aún muestra "latido percibido" como Δf sin matiz.
3. **Fatiga/adaptación**: parámetros HEURISTIC sin validación empírica directa.
4. **El EEG sintético no debe confundirse con EEG real**: ya etiquetado SIMULATED;
   falta la separación formal `SyntheticEEG` vs `RealEEGInterface` (Phase 7 parcial).
5. **Determinismo**: los modelos neurales/cognitivos son deterministas; el EEG es
   seedable. La app en vivo usa semilla aleatoria (correcto para uso real).
6. **Falta Phase 13** (perfiles de rendimiento con medición de FPS/VRAM).
   Phase 10 (Experimental Mode) ya está implementada y testeada. La suite de
   validación de física de Cymatics (modos de Bessel, dispersión) aún no está
   automatizada en Node (depende del renderer GL).
7. **Clamp de amplitud** en WaveField (no físico) — registrado, no silencioso.

## DOMAIN CLASSIFICATION (vocabulario del plan)

PHYSICAL (derivado de un modelo físico) · NEURAL (modelo neurofisiológico reducido) ·
PSYCHOLOGICAL (fenomenológico) · VISUAL (decisión de representación) ·
EMPIRICAL (basado en evidencia) · HEURISTIC (sin validación directa).

Toda variable mostrada al usuario lleva etiqueta MEASURED / SIMULATED / DERIVED /
ESTIMATED / HEURISTIC (Fase 17, obligatorio en el HUD).
