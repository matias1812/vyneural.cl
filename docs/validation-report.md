# BINEURAL — VALIDATION REPORT

**Fecha:** 2026-08-14 · **Entorno de validación:** Windows (Git Bash), Node ≥ 18,
Chrome (preview localhost:5199, build local) · **No se modificó código durante
la auditoría inicial** (regla de oro); los arreglos se listan al final y se
aplicaron después del AUDIT.

**Corpus de evidencia:**

- **E1** — `npm test`: `54 Passed, 0 Failed` (headless, Node).
- **E2** — `npm run build`: `✓ built in 1.31s`, bundle 187.33 kB (gzip 59.47 kB).
- **E3** — Tortura en navegador (9 operaciones: play/play/play/pause/play/pause/play/stop/play): ancla = **1 siempre**; consistencia UI ↔ MediaSession ↔ ancla ↔ lifecycle en **cada** paso; 1 `experimentStarted` y 1 `experimentCompleted` por sesión (registro fresco, sin duplicados).
- **E4** — Modal de permisos en vivo: Notificaciones "Concedido ✓", Media Session "Disponible (al reproducir)", Wake Lock "Pantalla activa disponible", Push "No configurado — requiere servidor".
- **E5** — Integridad de sesión: play→pausa limpia → `100%` con exposición == tiempo de sesión.
- **E6** — Máquina de estados: transiciones headless (FOREGROUND→AUDIO_RUNNING_BACKGROUND→AUDIO_SUSPENDED→RETURNING→FOREGROUND) y en vivo (FOREGROUND→STOPPED).
- **E7** — Lighthouse (reportes en `docs/lighthouse/`): home 79/100/96*/100 (TBT 766 ms), páginas de contenido 100/100/100/100. *best-practices 96 solo por 404 locales de Vercel Analytics.
- **E8** — Red/privacidad: sin `fetch`/XHR/beacon/WebSocket en `src/`; red real = ancla (blob) + icono; único tercero: `@vercel/analytics`; localStorage solo claves de app.
- **E9** — Estático: **un solo** sitio de creación de AudioContext (`src/audio.js:41`, dentro de `ensure()` con guard `if (!this.ctx)`); **un solo** `new SimulationEngine` (`src/main.js`); `start()` llama `stopInstant()` antes de crear osciladores; `startAnchor()` guarda `if (!audioAnchor)`; AmbientEngine comparte el ctx del motor.
- **E10** — Tests de AudioClock: fase sin drift tras 20 min simulados; `nextBeatAt()` con reloj de audio.
- **E11** — `BinauralEngine.getAudioStats()` y hook `onCtxStateChange` presentes.
- **E12** — Cymatics: modos `'scientific'` (solo capas Bessel físicas) vs `'cinematic'` (artístico) — `src/cymatics.js:765-772`.

---

## FASE 0 — Auditoría arquitectónica

**Status:** PASS (funcional) / PARTIAL (como clases únicas)

**Código relevante:** `src/audio.js:41`, `src/main.js:45,1521-1680,2835-2837`, `src/notifications.js:35-160`, `src/core/lifecycle.js`, `public/sw.js`

**Implementación encontrada:**

| Entidad buscada | ¿Existe? | Dónde |
|---|---|---|
| BinauralEngine | ✅ única instancia | `src/audio.js` (1 sitio de creación) |
| SessionController | ❌ como clase; estado distribuido | `playing` (main.js) + `AppLifecycle` + `ExperimentEventLog` |
| MediaController | ❌ como clase; cableado único en main.js | `main.js:1521-1680` (1 solo bloque) |
| LifecycleManager | ✅ `AppLifecycle` | `src/core/lifecycle.js` |
| AlarmScheduler | ❌ como clase; `startAlarmWatcher()` | `src/notifications.js` (setInterval 15 s) |
| ExperimentController | ✅ `ExperimentRunner` | `src/core/experiments.js` |
| AudioIntegrityMonitor | ❌ como clase; `getAudioStats()` + watchdog | `src/audio.js` + `src/core/audio-health.js` |
| SimulationEngine | ✅ única instancia | `src/core/simulation.js` |
| SyntheticEEG | ✅ `EegInterface` | `src/core/eeg.js` |
| Service Worker | ✅ | `public/sw.js` (registro solo no-localhost) |

**Mapa de dependencias (eventos y timers):**

- `AudioContext`: 1 sitio de creación (E9). Excepción: `playChime()` crea un contexto temporal de 4 s (campanita) — no interfiere, pero es un 2º contexto efímero.
- `setInterval`: `tickTimer` (250 ms, solo UI del temporizador), watcher de alarmas (15 s), progreso del loader. **Ninguno gobierna el audio.**
- `setTimeout`: fade-outs, toasts, restore (250 ms tras fullscreen/pointer), pulse visual auto-corregido con `AudioClock.nextBeatAt`. **Ninguno gobierna la fase.**
- Listeners: `visibilitychange` ×3 (guardar sesión / ciclo de vida+duck / re-adquirir WakeLock — funciones distintas, consolidables), `fullscreenchange`, `pageshow`, `focus`, `resume` (Chrome), `pointerdown`.

**Prueba ejecutada:** greps E9 + tortura E3 + suite E1.

**Resultado:** No hay múltiples AudioContext persistentes, ni múltiples BinauralEngine, ni múltiples sesiones activas, ni handlers de MediaSession duplicados (se registran una vez en el bloque `if (MEDIA_SESSION)`).

**Problemas:** La autoridad de la sesión está repartida (sin `SessionController` único): hoy es correcta por disciplina y tests, pero es el mayor riesgo arquitectónico a futuro (P1).

**Riesgo:** P1 · **Corrección:** consolidar en `SessionController`/`MediaController` (fase P8/P9 del plan). · **Regresión posible:** alta si se hace sin la suite; hoy 54 tests la protegen.

---

## FASE 1 — Audio continuo

**Status:** PARTIAL (mitigaciones implementadas; validación física pendiente)

**Código relevante:** `src/core/media-anchor.js`, `src/audio.js:recoverFade()`, `src/main.js:restoreFromBackground()`, watchdog `src/core/simulation.js`

**Implementación encontrada:** ancla de medios audible-para-el-navegador (sin `volume=0`, pista 8 s), `recoverFade()` (ganancia al piso → resume → rampa), duck a 0 en iOS Safari al ocultar, reafirmación en fullscreen/pointerdown, watchdog que NO actúa en segundo plano.

**Prueba ejecutada:** E3 (escritorio, continuidad al togglear) + inspección estática. **Tests A–E (minimizar 60 s, bloqueo, otra app, otra pestaña, Bluetooth) = NOT TESTABLE** sin dispositivo físico.

**Resultado:** En escritorio no se produce cambio de frecuencia/beat/fase ni duplicación. En móvil, **pendiente de verificación física** (Fase 29).

**Problemas:** El SO puede suspender el AudioContext (iOS sin PWA, pérdida de audio focus): en ese caso el audio se detiene — se registra `audioSuspended` y la integridad baja honestamente. **No se declara "audio perfecto en background".**

**Riesgo:** P1 (depende de plataforma, no del código) · **Corrección:** dispositivo real (tests de tortura P34) · **Regresión:** n/a.

---

## FASE 2 — AudioClock / independencia del FPS

**Status:** PASS

**Código relevante:** `src/core/audio-clock.js`, `src/audio.js` (`clock.setEpoch`, `getBeatPhaseAt`), `src/core/simulation.js` (dt acumulado, cadencia 30/10 Hz)

**Implementación encontrada:** la fase del latido, el tiempo de sesión y el pulso se derivan de `AudioContext.currentTime`; `Date.now()`/`performance.now()`/timers solo para UI, historial y scheduler externo. Los modelos usan `dt` real (acumulado, cap 0.25 s), por lo que no dependen del FPS.

**Prueba ejecutada:** E10 (20 min simulados sin drift; fase esperada en t exacto) + E1.

**Resultado:** La señal es matemáticamente consistente para cualquier FPS y con la pestaña oculta (el reloj de audio no se congela si el contexto sigue running).

**Problemas:** ninguno detectado. · **Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 3 — Background lifecycle

**Status:** PASS (máquina) / NOT TESTABLE (transiciones SO reales)

**Código relevante:** `src/core/lifecycle.js`, `src/main.js` (visibilitychange + `onCtxStateChange`)

**Implementación encontrada:** estados `FOREGROUND/BACKGROUND/AUDIO_RUNNING_BACKGROUND/AUDIO_SUSPENDED/RETURNING/STOPPED`; transiciones inválidas rechazadas; alimentado por `visibilitychange` y por `AudioContext.onstatechange` (fuente de verdad real). Cada transición registra `{ts, type, ctxState, visible}`.

**Prueba ejecutada:** E6 (headless secuencia completa + rechazo de inválidas; en vivo FOREGROUND→STOPPED) + E3 (sin estados contradictorios: en cada paso UI/MediaSession/lifecycle coinciden).

**Resultado:** No existe estado contradictorio detectable (p. ej. UI pausada con MediaSession "playing" no ocurre — E3).

**Problemas:** lock/unlock y congelación reales del SO = NOT TESTABLE aquí. · **Riesgo:** P2 · **Corrección:** dispositivo · **Regresión:** n/a.

---

## FASE 4 — Media Session

**Status:** PASS (implementación) / NOT TESTABLE (lock screen)

**Código relevante:** `src/main.js:1521-1680`

**Implementación encontrada:** `play`, `pause`, `stop`, `previoustrack`, `nexttrack`, `seekto`, `seekbackward`, `seekforward` — registrados una vez, dentro de `try/catch` (Safari < 15.4 sin soporte). Los handlers llaman a `start()/stop()/moveTrack()/seekBy()` reales (modifican el estado REAL, no la UI: E3 lo confirma).

**Prueba ejecutada:** E3 (pause desde el sistema reflejado en el estado real), E4 (etiqueta honesta).

**Resultado:** SUPPORTED: play, pause, stop, prev/next, seek (desktop/Android según plataforma); NOT SUPPORTED donde `setActionHandler` no exista (catch); NOT IMPLEMENTED: ninguno de los 7.

**Problemas:** lock screen / Bluetooth = NOT TESTABLE sin dispositivo. · **Riesgo:** P2 · **Corrección:** P34 · **Regresión:** n/a.

---

## FASE 5 — Media metadata

**Status:** PASS

**Código relevante:** `src/main.js:updateMediaSession()` y `updateMediaPosition()`

**Implementación encontrada:** `title` (estado), `artist` (Bineural), `album` (banda + frecuencias reales), `artwork` (iconos), `playbackState` (playing/paused según estado real), `setPositionState` con el temporizador real (duración/posición). Al detener: `playbackState='paused'` (E3: ms pasa a "paused" al pausar).

**Prueba ejecutada:** E3 (metadata "Aprendizaje", playbackState coherente en cada paso).

**Resultado:** La metadata coincide con la sesión real; cambia con el estado; al detener queda en "paused" (patrón Spotify). Nunca muestra una sesión distinta a la que suena.

**Problemas:** "desaparecer al detener" se implementa como paused (no limpiado) — decisión intencional y estándar. · **Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 6 — Wake Lock

**Status:** PARTIAL

**Código relevante:** `src/main.js` (`acquireWakeLock`/`releaseWakeLock`), `src/core/capabilities.js`

**Implementación encontrada:** adquisición en play, liberación en pausa, re-adquisición en `visibilitychange → visible` solo si la sesión sigue activa, estados supported/unsupported (try/catch) y `release` listener. **Separación explícita SCREEN WAKE LOCK vs BACKGROUND AUDIO** en la UI: "Pantalla activa" (no "garantiza el audio") — E4.

**Prueba ejecutada:** E4 (etiquetas), E1 (lógica pura de `evaluatePermissions`).

**Resultado:** En Chrome soportado; el estado "activo" no es comprobable en este entorno (la retención real depende del SO y de la visibilidad). La honestidad del mensaje sí está verificada.

**Problemas:** sin dispositivo no se verifica la re-adquisición tras bloqueo. · **Riesgo:** P2 · **Corrección:** P34 · **Regresión:** n/a.

---

## FASE 7 — Permisos reales

**Status:** PASS

**Código relevante:** `src/core/permissions.js`, `src/core/capabilities.js`, `src/main.js` (modal + `requestAllPermissions`)

**Tabla:**

| Permiso/API | Estado real | Uso real | Fallback | Riesgo |
|---|---|---|---|---|
| Notification | GRANTED (en prueba) / default→se pide | Alarmas y recordatorios del sistema | Campanita local; respaldo calendario | P3 |
| Push | UNSUPPORTED/NO CONFIGURADO (sin backend) | Ninguno | Calendario/.ics | P2 (honestidad ✓) |
| Wake Lock | supported (Chrome); active según SO | Pantalla activa | Ninguno (no crítico) | P3 |
| Media Session | capability (no permiso) | Controles del SO | Nada (no necesita permiso) | P3 |
| Audio/autoplay | política del navegador | Inicio con gesto | Reanudar en primer toque | P2 |

**Prueba ejecutada:** E4 + validación anterior (con permiso "sin decidir", `Notification.requestPermission()` se llama de verdad en play y al abrir el modal).

**Resultado:** Denegar notificaciones degrada a campanita local (sin diálogos repetidos); desactivar en el modal es un gate real; ninguna capacidad usa a otra como explicación falsa.

**Problemas:** ninguno. · **Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 8 — Service Worker

**Status:** PASS (registro/lifecycle/fetch/notificationclick) / PARTIAL (push)

**Código relevante:** `public/sw.js`

**Implementación encontrada:** registro en no-localhost (`main.js:2835`); `install` (precache + skipWaiting), `activate` (limpieza + claim), `fetch` (network-first navegación + cache-first assets), `notificationclick` (cerrar → `clients.matchAll({includeUncontrolled})` → `navigate`/`postMessage` + `focus` → o `clients.openWindow`), `notificationclose`.

**Prueba ejecutada:** estática (lectura del archivo) — en dev no hay SW (localhost). **PUSH = NOT CONFIGURED** (no existe backend; la UI lo dice: E4).

**Resultado:** Una notificación puede enfocar/abrir la app (código presente); verificación física pendiente.

**Problemas:** el SW no es scheduler persistente — reconocido en docs y UI. · **Riesgo:** P2 · **Corrección:** backend para push (futuro) · **Regresión:** n/a.

---

## FASE 9 — Notificaciones background (matriz)

**Status:** PAGE DEPENDENT (honesto)

| Condición | Notification local | Push | Calendario/.ics | SW |
|---|---|---|---|---|
| Página visible | ✅ | — | ✅ | ✅ |
| Página hidden (viva) | ✅ vía `reg.showNotification()` + acciones | — | ✅ | ✅ |
| Pestaña congelada | ❌ (límite navegador) | ❌ | ✅ (recordatorio OS) | parcial (click si llegó) |
| PWA cerrada | ❌ | ❌ | ✅ | ❌ |
| Navegador cerrado | ❌ | ❌ | ✅ | ❌ |

**Prueba ejecutada:** matriz por diseño + docs. · **Resultado:** no se declara "background notifications" como PASS; la UI y los docs lo explican.

**Riesgo:** P2 · **Corrección:** backend push o confiar en calendario · **Regresión:** n/a.

---

## FASE 10 — Alarm scheduler

**Status:** PAGE DEPENDENT (clasificación honesta)

**Código relevante:** `src/notifications.js:startAlarmWatcher()` (setInterval 15 s) + `nextAlarmAt` (Date.now)

**Implementación encontrada:** revisión de alarmas vencidas (tolerancia 5 min) mientras la página vive; respaldo Google Calendar/.ics; deep link con `autostart=true`.

**Prueba ejecutada:** estática + docs. Tests "+30 s con pestaña minimizada" y "+2 min con teléfono bloqueado" = NOT TESTABLE sin dispositivo.

**Resultado:** **PAGE DEPENDENT / BEST EFFORT**, no REAL BACKGROUND. La arquitectura dice la verdad (docs y UI).

**Riesgo:** P2 · **Corrección:** push backend (futuro) · **Regresión:** n/a.

---

## FASE 11 — Notification actions

**Status:** PASS (implementación) / NOT TESTABLE (dispositivo)

**Código relevante:** `src/notifications.js:showSessionAlarmNotification` (acciones START/DISMISS solo si `'actions' in Notification.prototype`), `public/sw.js:notificationclick` (start → deep link con `autostart=true`; enfoca 1 ventana, sin duplicados)

**Implementación encontrada:** sin duplicar ventana (primer cliente enfocable), sin duplicar sesión (deep link con autostart → `start()` se protege con `sessionLog.reset()` y el flujo de play).

**Prueba ejecutada:** estática + E3 (flujo de play idempotente). · **Riesgo:** P2 · **Corrección:** dispositivo · **Regresión:** n/a.

---

## FASE 12 — Session Controller

**Status:** PARTIAL

**Código relevante:** `src/core/lifecycle.js` (estados de ciclo de vida), `src/main.js:playing`, `src/core/experiment-events.js`

**Implementación encontrada:** NO existe una máquina `idle/starting/playing/paused/background/recovering/finishing/completed`. Existen: `AppLifecycle` (ciclo de vida SO) + flag `playing` + `ExperimentEventLog`. Transiciones inválidas de `AppLifecycle` se rechazan (testeado); el flag `playing` no tiene máquina propia.

**Prueba ejecutada:** E1 (lifecycle), E3 (sin estados contradictorios observables).

**Resultado:** Hoy no hay corrupción observable, pero la autoridad de "sesión" es difusa: riesgo de regresión futura.

**Problemas:** falta el controlador único (P9 del plan). · **Riesgo:** P1 · **Corrección:** `SessionController` con estados `idle/starting/playing/paused/finishing/completed` + `background/recovering` derivados; mantener los 54 tests · **Regresión posible:** media/alta sin la suite.

---

## FASE 13 — Duplicación de audio

**Status:** PASS (evidencia observable y estática)

**Código relevante:** `src/audio.js` (`ensure()` guard, `start()` → `stopInstant()`), `src/main.js` (`startAnchor()` guard), E9

**Prueba ejecutada:** E3 — secuencia play/play/play/pause/play/pause/play/stop/play:

| Paso | Anclas | UI | MediaSession | Lifecycle | experimentStarted |
|---|---|---|---|---|---|
| tras cada play | **1** | Pausar | playing | FOREGROUND | 1 (log fresco) |
| tras cada pause/stop | **1** | Comenzar | paused | STOPPED | 1 |

**Resultado:** una sola sesión activa; sin capas duplicadas; sin acumulación de `experimentStarted`.

**Problemas:** resuelto en FIX — `window.__audioProbe` expone el estado real. **RETEST medido** (secuencia play/stop/play/stop/play): oscillatorCount = **2** en play, **0** en stop, nunca 4/6; contexto `running` único, sin recreación.

**Riesgo:** P2 · **Corrección:** hook de diagnóstico (aplicado) · **Regresión:** sin regresión.

---

## FASE 14 — Cambio de dispositivo

**Status:** PARTIAL (por diseño) / NOT TESTABLE

**Código relevante:** `src/audio.js` (sin recreación de contexto ante cambios de ruta; `retune()` solo en entrada de usuario), `src/main.js:restoreFromBackground`

**Implementación encontrada:** el navegador gestiona el cambio de salida; no se reinician osciladores ni se crea un segundo contexto; los eventos se registran en el log (`audioSuspended`/`audioRecovered`).

**Prueba ejecutada:** estática (sin lógica de reset por ruta). Bluetooth = NOT TESTABLE.

**Riesgo:** P2 · **Corrección:** dispositivo · **Regresión:** n/a.

---

## FASE 15 — Experimental Mode

**Status:** PASS

**Código relevante:** `src/core/experiments.js` + `src/core/reproducibility.js`

**Implementación encontrada:** cada ejecución tiene seed, modelVersion, config canónica (JSON byte-idéntico), condición, portadora, Δf, duración, timestamp y export JSON.

**Prueba ejecutada:** E1 (determinismo bajo seed+config; export; condiciones).

**Resultado:** misma seed + parámetros + modelo → mismos resultados (testeado).

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 16 — Condiciones experimentales

**Status:** PASS

**Código relevante:** `src/core/experiments.js` (`conditionProfile`), tests

**Implementación encontrada:** BINAURAL, AM, PURE_TONE, NOISE, SILENCE — cada una modifica el modelo (binaural entrena hacia Δf; sin estímulo relaja a línea base), no solo la etiqueta.

**Prueba ejecutada:** E1 (binaural → 6 Hz dominante; control → 12 Hz; PSD válida). Señal real medida vía modelo, no solo UI.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 17 — Event logging

**Status:** PASS

**Código relevante:** `src/core/experiment-events.js`, `src/main.js` (wiring)

**Implementación encontrada:** `experimentStarted/Paused/Resumed/Backgrounded/Foregrounded`, `audioSuspended/Recovered`, `stimulusChanged`, `volumeChanged`, `conditionChanged`, `experimentCompleted` — cada uno con `{ts, audioTime, type, payload}`.

**Prueba ejecutada:** E1 (integridad y eventos) + E3/E5 en vivo.

**Resultado:** la sesión es reconstruible desde el registro (`window.__sessionLog`).

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 18 — Experiment integrity

**Status:** PASS

**Código relevante:** `src/core/experiment-events.js:compute()/integrityText()`

**Implementación encontrada:** interrupciones registradas con duración y motivo; integridad = exposición/esperada; pausas voluntarias no bajan la integridad; el resumen muestra "92% — Interrupción de audio 24.8 s".

**Prueba ejecutada:** E1 (0.9 con 2 s suspendido; 1.0 con pausa voluntaria) + E5 en vivo (100% limpio).

**Resultado:** las interrupciones nunca se ocultan.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 19 — WaveField

**Status:** PASS

**Código relevante:** `src/wavefield.js` + tests E1 (CFL < 1, clamp c>1/√2, energía 0 en reposo, impulso → energía positiva, decaimiento monótono, sin NaN/Inf en 300 pasos, amplitud acotada, celdas exteriores a la máscara sin fuga)

**ACTUALIZACIÓN (auditoría 2026-09-08):** el test de frontera original se
llamaba "Dirichlet en bordes" y solo comprobaba que las celdas del borde del
ARRAY (fuera de la máscara circular) quedaran en 0 — cierto para cualquier
condición de contorno y por tanto sin valor discriminante, mientras que
`step()` ya había pasado de Dirichlet a Neumann (borde libre) sin que ningún
test lo verificara. Se agregó un test nuevo que mide la frecuencia
fundamental real del FDTD y la compara contra el cero de Neumann J'_0=3,8317
(en vez del cero de Dirichlet J_0=2,4048) — ver "free (Neumann) boundary" en
`diagnostics.js`.

**Prueba ejecutada:** E1 (9 tests de física).

**Resultado:** estable bajo los parámetros permitidos; sin NaN/Infinity/explosiones.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 20 — Cymatics

**Status:** PARTIAL

**Código relevante:** `src/cymatics.js:162-323` (Bessel J0/J1/J_m…), `765-772` (modos `scientific`/`cinematic`)

**Implementación encontrada:** separación PHYSiCAL (Bessel eigenmodes, patrón modal con detuning) vs CINEMATIC (grano, armónicos mD, modulación arbitraria); el modo `scientific` solo usa capas físicas; el HUD etiqueta la metáfora visual como HEURISTIC.

**Prueba ejecutada:** estática (E12) + E1 (sin tests numéricos de eigenmodes).

**Problemas:** **no hay validación numérica** de las funciones de Bessel contra valores conocidos (ceros de J_m) ni del detuning; la suite cubre WaveField pero no Cymatics.

**Riesgo:** P2 · **Corrección:** tests de eigenmodes (ceros de J0 ≈ 2.4048, J1 ≈ 3.8317, etc.) · **Regresión posible:** baja.

---

## FASE 21 — Neural model

**Status:** PASS (honestidad) / PARTIAL (relaciones heurísticas explícitas)

**Código relevante:** `src/core/neural.js`, `src/models/profiles.js` (`neuralHypothesis`), HUD (etiquetas HYPOTHESIS·HEURISTIC)

**Implementación encontrada:** el pipeline es Stimulus → Auditory → Neural → EEG → Cognitive → Visual; las relaciones "latido → banda" viven en `neuralHypothesis` de cada perfil y se presentan como hipótesis, no como medición; el HUD separa SIMULATED/ESTIMATED/HYPOTHESIS.

**Prueba ejecutada:** E1 (determinismo, bounds, habituación) + revisión de etiquetas.

**Resultado:** ninguna variable neural se presenta como medición real.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 22 — Synthetic EEG

**Status:** PASS

**Código relevante:** `src/core/eeg.js` (Voss–McCartney 1/f, bandas, asimetría, coherencia) + tests E1 (bandas ∈ [0,1], fluctuación 1/f, determinismo bajo seed, validez del stream)

**Implementación encontrada:** identificado explícitamente como SIMULATED en HUD y docs; PSD/bandas validadas.

**Resultado:** no es "random + sinusoids" sin documentación: hay modelo documentado (`docs/scientific-model.md`) y tests.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 23 — Cognitive state

**Status:** PASS

**Código relevante:** `src/core/cognitive.js` (arousal/atención/relajación/fatiga/confianza con bounds), HUD (COGNITIVE·ESTIMATED con confianza)

**Prueba ejecutada:** E1 (bounds en 6000 pasos).

**Resultado:** los valores estimados nunca se presentan como medición.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 24 — Neural → Visual

**Status:** PASS

**Código relevante:** `src/core/visual.js` (única puerta con provenance por campo)

**Tabla (resumen):** dominante/cognitivo → metáfora visual, clasificada HEURISTIC/ARTISTIC con `basis` y `origin` por campo (detalle en `docs/scientific-model.md`).

**Prueba ejecutada:** E1 (mapeo determinista + provenance).

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 25 — Simulación en background

**Status:** PASS

**Código relevante:** `src/main.js:drawVisual` (gate `if (document.hidden) return;`), `src/core/simulation.js` (cadencia 30/10 Hz con dt acumulado)

**Prueba ejecutada:** estática + E7 (TBT 1113→766 ms, TTI 5180→4182 ms tras el throttle).

**Resultado:** render congelado en segundo plano; sin CPU innecesaria; al volver la fase se reconstruye desde AudioClock.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 26 — Recuperación (drift)

**Status:** PASS (matemática del reloj) / NOT TESTABLE (5 min reales)

**Código relevante:** `src/core/audio-clock.js`

**Prueba ejecutada:** E10 (20 min simulados: fase esperada == fase calculada; tras 1200 s exactos, fase ≈ 0 con tolerancia flotante).

**Resultado:** la fase y el elapsed se derivan del reloj de audio: no hay drift posible aunque la pestaña esté oculta (mientras el contexto corra).

**Riesgo:** P2 · **Corrección:** dispositivo · **Regresión:** n/a.

---

## FASE 27 — Interferencia

**Status:** PARTIAL

**Código relevante:** watchdog (`src/core/audio-health.js`), ancla, `recoverFade`, duck iOS, `onCtxStateChange`, `getAudioStats()`

**Implementación encontrada:** monitor de estado (contexto, sample rate, reloj, RMS, ganancia, osciladores) y registro de interrupciones; causas clasificadas por dominio (SO/navegador/hardware no se atribuyen al código).

**Prueba ejecutada:** E1 (watchdog: sin falsos positivos, respeta volumen 0) + E3 (sin glitches en escritorio).

**Resultado:** mitigaciones activas; medición física de drift/phase en tab-switch/lock/Bluetooth = NOT TESTABLE sin dispositivo.

**Riesgo:** P1 (depende de plataforma) · **Corrección:** P34 en dispositivo · **Regresión:** n/a.

---

## FASE 28 — Performance

**Status:** PASS

**Prueba ejecutada:** E7 (Lighthouse) + E2.

| Métrica | Valor |
|---|---|
| TBT | 766 ms (antes 1113) |
| FCP / LCP | 1.43 s / 2.1 s |
| CLS | ~0 |
| Bundle | 187 kB (gzip 59) |

**Resultado:** sin degradación innecesaria; throttle de cadencia en reposo.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 29 — Mobile

**Status:** NOT TESTABLE (sin dispositivo físico disponible)

**Registro:** pendiente — se documenta la matriz de compatibilidad en `docs/system-robustness.md` (P33). No se extrapola desktop → móvil.

**Riesgo:** P1 · **Corrección:** pruebas físicas (Android Chrome/PWA, iOS Safari/PWA) · **Regresión:** n/a.

---

## FASE 30 — Seguridad y privacidad

**Status:** PASS

**Prueba ejecutada:** E8 (sin fetch/XHR/beacon/WebSocket; red = ancla + icono; único tercero Vercel Analytics; localStorage solo claves de app) + revisión de `public/sw.js` (sin exfiltración).

**Resultado:** audio, experimentos, EEG y estado cognitivo permanecen locales; nada se envía sin consentimiento; páginas legales enlazadas.

**Riesgo:** P3 · **Corrección:** n/a · **Regresión:** n/a.

---

## FASE 31 — Matriz final

| ID | Requisito | Estado | Evidencia | Riesgo | Acción |
|---|---|---|---|---|---|
| F0 | Única autoridad de audio/sesión | PARTIAL | E9/E1 | P1 | SessionController/MediaController |
| F1 | Audio continuo background | PARTIAL | E3+estático | P1 | Verificación física |
| F2 | AudioClock (FPS-independiente) | PASS | E10/E1 | P3 | — |
| F3 | Lifecycle background | PASS | E6/E3 | P2 | Verificación física |
| F4 | Media Session acciones | PASS | E3/E4 | P2 | Verificación física |
| F5 | Media metadata | PASS | E3 | P3 | — |
| F6 | Wake Lock | PARTIAL | E4/E1 | P2 | Verificación física |
| F7 | Permisos reales | PASS | E4+request real | P3 | — |
| F8 | Service Worker | PARTIAL (push off) | estático | P2 | Backend push (futuro) |
| F9 | Notif. background | PAGE DEPENDENT | docs | P2 | Backend/calendario |
| F10 | Alarm scheduler | PAGE DEPENDENT | docs | P2 | Backend/calendario |
| F11 | Notification actions | PASS | estático+E3 | P2 | Verificación física |
| F12 | SessionController | PARTIAL | E1/E3 | P1 | Consolidar |
| F13 | Sin duplicación de audio | PASS | E3/E9 | P2 | Hook diagnóstico |
| F14 | Cambio de dispositivo | PARTIAL | estático | P2 | Verificación física |
| F15 | Experimental determinista | PASS | E1 | P3 | — |
| F16 | Condiciones reales | PASS | E1 | P3 | — |
| F17 | Event logging | PASS | E1/E3/E5 | P3 | — |
| F18 | Integridad | PASS | E1/E5 | P3 | — |
| F19 | WaveField | PASS | E1 | P3 | — |
| F20 | Cymatics | PARTIAL | E12 | P2 | Tests de eigenmodes Bessel |
| F21 | Neural honesto | PASS | E1 | P3 | — |
| F22 | EEG sintético | PASS | E1 | P3 | — |
| F23 | Cognitive estimado | PASS | E1 | P3 | — |
| F24 | Neural→Visual | PASS | E1 | P3 | — |
| F25 | Simulación background | PASS | E7 | P3 | — |
| F26 | Recuperación sin drift | PASS | E10 | P2 | Verificación física |
| F27 | Anti-interferencia | PARTIAL | E1/E3 | P1 | Verificación física |
| F28 | Performance | PASS | E7 | P3 | — |
| F29 | Mobile | NOT TESTABLE | — | P1 | Dispositivo |
| F30 | Seguridad/privacidad | PASS | E8 | P3 | — |

---

## FASE 32 — Regresiones (ANTES vs DESPUÉS)

**Prueba ejecutada:** E1 (54/54, incluye los tests de robustez añadidos), E2 (build), E3 (tortura sin cambios de comportamiento), E4/E5 (permisos e integridad intactos).

**Resultado:** sin regresión en audio, frecuencias, MediaSession, notificaciones, experimentos ni simulaciones tras la fase de robustez.

---

## FASE 33 — Prueba final de tortura

**Status:** PARTIAL — subconjunto de escritorio ejecutado (E3: 9 operaciones; consistencia perfecta). Los pasos de dispositivo (lock, Bluetooth, otra app, OS pause/resume) = NOT TESTABLE aquí (Fase 29).

---

## FASE 34 — Informe final

### Executive Summary

Bineural cumple su postura científica y de robustez con un núcleo bien testeado
(54/54, física estable, permisos y capacidades honestos, integridad de sesión,
reloj de audio sin drift, sin duplicación de audio observable). Las
debilidades principales no son del código sino de **verificación física**
(móvil/lock/Bluetooth) y de **arquitectura** (falta un `SessionController`/
`MediaController` únicos; el scheduler de alarmas es PAGE DEPENDENT; Push no
configurado — todo declarado honestamente en UI y docs).

### P0 Critical Failures
Ninguno.

### P1 High Priority
1. Verificación física pendiente (audio continuo, lock screen, Bluetooth) — F1/F27/F29.
2. Falta la autoridad única de sesión (`SessionController`/`MediaController`) — F0/F12.
3. Instrumentación de runtime para conteo de osciladores/contextos no expuesta — F13.

### P2 Medium Priority
1. Cymatics sin validación numérica de eigenmodes (ceros de Bessel) — F20.
2. Alarmas page-dependent + Push sin backend (honestos, pero limitados) — F9/F10.
3. `playChime()` crea un 2º AudioContext efímero — mejor reutilizar el del motor.
4. Tres listeners de `visibilitychange` consolidables.

### P3 Low Priority
Consolidar páginas duplicadas (raíz vs `public/`), `llms.txt` (auditoría agentic), namespacing de claves de localStorage.

### Puntuaciones

| Área | Puntos | Nota |
|---|---|---|
| Audio Integrity | 78/100 | Núcleo sólido + mitigaciones; verificación física pendiente |
| Background Robustness | 65/100 | Mitigaciones fuertes; scheduler page-dependent; sin verificación física |
| Media Controls | 70/100 | Cableado completo; verificación física pendiente |
| Notifications | 60/100 | Page-dependent; push no configurado; acciones sin verificar |
| Permissions | 85/100 | Reales, honestos, degradación correcta |
| Experimental Engine | 85/100 | Determinista, loggeado, con integridad |
| WaveField | 85/100 | Estabilidad numérica cubierta |
| Cymatics | 60/100 | Separación de modos ✓; validación numérica ✗ |
| Neural Model | 75/100 | Honesto; relaciones como hipótesis |
| Scientific Integrity | 88/100 | Postura de honestidad consistente |
| Performance | 80/100 | Lighthouse bueno; bundle 187 kB |

**OVERALL SCORE: 76/100**

Limitación conocida dominante: **la validación móvil real no se ha podido
ejecutar** (Fase 29); las puntuaciones de background/media/notificaciones
subirán o bajarán según el dispositivo.

---

## FIXES APLICADOS TRAS LA AUDITORÍA (AUDIT → FIX → RETEST)

1. **P1-F13 — Hook de diagnóstico de audio** (`main.js`): exponer
   `window.__audioProbe = () => ({ ctx, stats })` (solo lectura) para contar
   osciladores/contexto en CI y en dispositivo.
2. **P2-F34 — `playChime()` reutiliza el contexto del motor** si existe
   (`notifications.js`), evitando el 2º AudioContext efímero cuando hay sesión.

**RETEST:** `npm test` 54/54 ✓ · build ✓ · tortura E3 repetida: sin regresión;
nuevo conteo medido de osciladores vía `__audioProbe` (2 en play / 0 en stop,
nunca duplicados).

---

## ADDENDUM — P0.5 Refactor de transporte (post-auditoría, por diagnóstico externo)

El diagnóstico externo detectó: (a) `startAnchor()` creaba el ancla con
`createSilentAudio(1)` (1 s) mientras la arquitectura declaraba 8 s;
(b) la vía principal era "audio real + audio falso" en vez de un pipeline
único; (c) el duck a 0 al salir modificaba el estímulo.

**Corregido y revalidado (58/58 tests, build ✓, navegador ✓):**

| Punto | Antes | Después | Evidencia nueva |
|---|---|---|---|
| Ancla | `createSilentAudio(1)` — 1 s, contradictorio | `createSilentAudio()` — 8 s (ANCHOR_SECONDS) | código + test de pista larga |
| Pipeline | AudioContext directo + ancla silenciosa (2 vías) | AudioContext → MediaStreamDestination → `<audio>` real (1 vía); ancla = fallback legacy solo modo `direct` (iOS) | navegador: `transport.mode='element'`, `hasMediaStreamDestination=true`, elemento con `srcObject`, RMS 0.23 a ganancia 0.8, sin ancla en DOM |
| Duck | `fadeTo(0)` al ocultar (genérico) | Solo iOS Safari sin PWA, etiquetado "mitigación de interrupción de plataforma" + evento `duckOnBackground` registrado | código + log de eventos |
| Recuperación | inline | `planRecovery()` — una sola decisión, estados NONE/REQUIRED/RUNNING/SUCCESS/FAILED | tests headless |
| Watchdog | reintentos cada 0.5 s en foreground | sin cambios (no es agresivo: umbral 3, resetea tras actuar); suspensiones registradas | E1 |
| Push | solo `notificationclick` | + handler `push` en sw.js (listo para backend); UI declara "No configurado — requiere servidor"; nota honesta en el modal de alarmas | código + UI |

**Verificación en navegador (desktop Chrome):** play → `transport.mode='element'`,
elemento real reproduciendo (reloj 40.9 s y subiendo), osciladores 2, RMS 0.2325
a ganancia 0.8, MediaSession "playing", 0 anclas; pause → elemento pausado, osc 0,
MediaSession "paused"; play → todo recuperado. Sin errores de consola.

**Pendiente honesto:** verificación física en Android/iOS (el modo `element` es
la vía correcta en Android; iOS sigue con `direct` + ancla legacy por
limitación de la plataforma).

---

## ADDENDUM — P0 Sistema de notificaciones (post-P0.5, plan "Zero Backend")

Reemplazo del watcher legacy (`setInterval` 15 s en `notifications.js`) por
**`AlarmManager`** (`src/core/alarm-manager.js`): scheduler ÚNICO de 5 s,
persistencia durable en IndexedDB (espejo localStorage para la UI),
estados SCHEDULED/TRIGGERED/CANCELLED/EXPIRED/MISSED con anti-duplicado real,
y multi-tab (Web Locks elige la pestaña PRIMARIA; sin Web Locks, elección por
BroadcastChannel con confirmación en el store antes de disparar).
`NotificationManager` orquesta providers (ServiceWorker → Local → Calendar
manual; Push **desactivado**: sin backend). Capacidades detectadas con
honestidad (`notification-capabilities.js`) y diagnóstico en
`window.__notificationDiagnostics()`. El SW ganó un message bus con validación
de schema; el watcher legacy se eliminó (0 schedulers duplicados).

**Verificado (71/71 tests, build ✓, navegador ✓):**

| Ítem | Resultado | Evidencia |
|---|---|---|
| Disparo único | 1 fire por alarma, nunca duplica | 2 ticks = 1 fire; store vacío tras disparar |
| Cancelada | nunca se ejecuta | fires sin cambio tras 7 s |
| Vencida | MISSED, no se ejecuta tarde | unit test + estado lastNotification |
| Recarga | se restaura desde IndexedDB | alarma `test-reload-1` presente tras reload real |
| Multi-tab | solo primaria dispara | tests Web Locks (concedido/denegado) + elección BroadcastChannel |
| UI | badge/lista sincronizados | badge 0→1→0 en flujo real de modal |
| Honestidad | Push "requiere servidor", background "no garantizado" | `__notificationDiagnostics()` en navegador |
| Sin interferencia con audio | la notificación jamás crea AudioContext/sesión | `onFire` en hidden solo notifica/chime (Fase 21) |

Informe completo del sistema: **`docs/notification-report.md`**.

---

## ADDENDUM — P0.6 Transiciones de frecuencia y condición (visuales graduales)

Fase 16 (condiciones) y FASE 1/FASE 2 (audio continuo + reloj): el cambio de
frecuencia y de condición ahora se ve **poco a poco**, sin saltos:

| Capa | Mecanismo | τ | Evidencia |
|---|---|---|---|
| Audio | `retune()`: `linearRampToValueAtTime` con `cancelScheduledValues` en osciladores y modulador AM | 1,5 s | código + audición |
| Gotas | `visBase`/`visBeat` (EMA) alimentan `T1 = K_VIS/f` y el período del latido | 1,5 s | probe `visual` en navegador |
| Cimática | `pBase` EMA + `_dropF` por gota (incluye f2=f1 en tono puro) | 1,5 s | probe + canvas |
| Pulso | sigue anclado a `getBeatPhase()` real — solo morfa el ritmo, no la fase | — | sin drift |

**Verificado en navegador:** Meditación (210/6) → Concentración (240/16):
visual recorrió 218,5 → 228,3 → 233,7 → 236,7 Hz y latido 8,8 → 12,1 → 13,9
→ 14,9 Hz; 240→210 en sentido inverso idéntico. `__platformProbe().visual`
expone smoothed vs target. Sin errores de consola; 71/71 tests; build ✓.
