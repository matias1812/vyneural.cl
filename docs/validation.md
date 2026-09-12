# Validación

## Cómo ejecutar

```bash
npm test                       # suite headless (Node) — 113 tests, < 2 s
window.runBineuralDiagnostics()# misma suite en el navegador (consola; async → await)
npm run build                  # build de producción
```

La suite importa exactamente los mismos módulos en Node y en el navegador
(la física y los modelos son libres de DOM; `WaveField` crea su canvas de forma
perezosa para permitirlo).

## Inventario de la suite (src/validation/diagnostics.js)

### Ancla de medios (Media Session en móvil)

| Test | Qué valida |
|---|---|
| WAV silencioso con cabecera válida | RIFF/WAVE/fmt/data, 8 kHz, mono, 16-bit |
| Muestras a cero (silencio real) | El ancla no aporta sonido |
| Pista por defecto ≥ 6 s | Línea de tiempo de medios estable (no reinicia cada segundo) |

### Lógica de permisos (src/core/permissions.js — decisiones reales)

| Test | Qué valida |
|---|---|
| Sin decidir y activados → pedir + adquirir | El diálogo se pide de verdad (no es adorno) |
| Concedido → no se vuelve a pedir | No molesta dos veces |
| Denegado → no se vuelve a pedir | No molesta dos veces |
| Desactivados manualmente → no se pide nada | El toggle del modal es un gate real |
| iOS sin PWA instalada → no se llama a un diálogo inexistente | Honestidad por plataforma |
| Wake Lock activo → no se re-adquiere | Sin duplicados |
| Sin soporte de Wake Lock → se omite | Degradación limpia |
| Textos de estado por plataforma | Modal honesto (concedido/denegado/iOS/unsupported) |

### Robustez de sistema (P4/P5/P19/P20/P10)

| Test | Qué valida |
|---|---|
| AudioClock: fase sin drift (20 min) | La fase deriva de AudioContext.currentTime, no de timers |
| AudioClock: nextBeatAt | El pulso visual se programa con el reloj de audio |
| AppLifecycle: secuencia real | FOREGROUND → AUDIO_RUNNING_BACKGROUND → AUDIO_SUSPENDED → RETURNING → FOREGROUND |
| AppLifecycle: transiciones imposibles rechazadas | No se fuerza el estado; stop/start correctos |
| Integridad con interrupciones del SO | 10 s + 2 s suspendido + 8 s → integridad 0.9 y texto honesto |
| Pausa voluntaria ≠ interrupción | La integridad no baja por pausar (solo por fallos del audio) |
| PlatformCapabilities | Cada capacidad con su función real; Push honesto sin backend |
| AudioTransport: iOS → direct | Sin MediaStream a <audio> en iOS (limitación real) |
| AudioTransport: modo element | El audio real viaja por UN único <audio> (srcObject) |
| AudioTransport: fallback único | Si el <audio> falla, degrada UNA vez a salida directa |
| PlanRecovery (P0.5.9) | Decide una recuperación según el estado real, sin reiniciar |

### Sistema de notificaciones (P0 — AlarmManager / NotificationManager)

| Test | Qué valida |
|---|---|
| `alarmStateOnTick` | wait/fire/miss/skip según estado real (gracia 5 min) |
| Disparo único + anti-duplicado | One-shot en memoria y store durable; 2º tick no duplica |
| Cancelada nunca se ejecuta | CANCELLED fuera de la lista y del store |
| Vencida → MISSED | No se ejecuta una alarma vieja (pasada la gracia) |
| Recarga desde store durable | La alarma sobrevive a una recarga (Fase 5) |
| EXPIRED al arrancar | Lo que venció hace mucho se descarta sin ejecutarse |
| Multi-tab (Web Locks) | Solo la pestaña PRIMARIA dispara (Fase 15) |
| Multi-tab sin Web Locks | BroadcastChannel elige UNA primaria (instancia menor) |
| NotificationManager providers | SW primero, local como fallback; denegado → no finge |
| Push desactivado / Calendar manual | Honestidad: sin backend, nada automático |
| NotificationCapabilities | API disponible ≠ garantizado; push "requiere servidor" |
| CalendarProvider | `.ics` válido (UID/DTSTART/DTEND) + URL Google Calendar |

### Física de ondas (WaveField)

| Test | Qué valida |
|---|---|
| CFL < 1 | Estabilidad numérica del esquema leapfrog |
| CFL clamping con c > 1/√2 | El constructor clampa la velocidad insegura |
| Energía = 0 en rejilla en reposo | Definición de energía |
| Impulso crea energía > 0 | Fuentes inyectan energía |
| Decaimiento monótono bajo damping | Disipación sin fuentes |
| Sin NaN/Infinity tras 300 pasos | Robustez numérica |
| Clamp de amplitud tras pulso extremo | Límite no físico se respeta |
| Celdas exteriores a la máscara nunca filtran amplitud | Sanity check del array (no depende de qué BC use el borde) |
| Frontera libre/Neumann — la fundamental coincide con el cero de J'_0 (3,8317), no con el de J_0 (2,4048) | Condición de contorno REAL del stencil (auditoría 2026-09-08: pasó de Dirichlet a Neumann; antes esto solo se comprobaba a mano) |

### Audio / estímulo

| Test | Qué valida |
|---|---|
| Derivación de oídos (L=carrier, R=carrier+Δf) | Consistencia del estímulo físico |
| Todos los perfiles con carrier/beat válidos | Integridad del dataset |
| ModelParams y visualMetaphor en [0,1] | Bounds de parámetros |

### Modelo neural

| Test | Qué valida |
|---|---|
| Bounds bajo fatiga alta (36 000 pasos) | fatigue/adaptation ∈ [0,1] |
| Habituación converge a ~0 | H(t) = exp(−t/τ) |
| Determinismo (misma trayectoria) | Reproducibilidad del modelo |
| dominantFreq publicado y plausible (4–40 Hz) | Wiring corregido (antes `_owner` roto) |

### Reproducibilidad (P12)

| Test | Qué valida |
|---|---|
| SimulationConfig rechaza params inválidos | Validación estricta |
| JSON canónico estable ante orden de claves | Byte-identidad |
| mulberry32 determinista y bien distribuido | PRNG |
| EEG idéntico bajo el mismo seed | Streams reproductibles |
| EEG distinto bajo distinto seed | Sensibilidad a la semilla |
| ExperimentRecord completo (versión, seed, config) | Formato de exportación |

### EEG sintético

| Test | Qué valida |
|---|---|
| Bandas finitas y ∈ [0,1] en 2000 pasos | Validez numérica |
| Fluctuación 1/f no trivial (std ≥ 0.004, seed 7) | Canales vivos (no muertos) |

### Modelo cognitivo y visual

| Test | Qué valida |
|---|---|
| Valores y confianza ∈ [0,1] (6000 pasos) | Bounds de CognitiveState |
| VisualMapper determinista y con provenance | Puerta Neural→Visual correcta |

### Audio watchdog (lógica pura — src/core/audio-health.js)

| Test | Qué valida |
|---|---|
| Contexto suspendido → `resume` al 3er chequeo | Recuperación de suspensión del SO |
| Señal nula con ganancia → `refade` al 3er chequeo | Sesión "en play pero muda" |
| Señal presente → nunca actúa y resetea contador | Sin falsos positivos |
| Volumen del usuario a 0 → nunca actúa | No pelea con el slider de volumen |
| Sin sesión activa → nunca actúa | No actúa en pausa |

### Experimental Mode (Phase 10 — src/core/experiments.js)

| Test | Qué valida |
|---|---|
| Determinismo bajo la misma semilla y config | Reproducibilidad del experimento |
| Binaural entraña hacia Δf; sin estímulo relaja a línea base | Respuesta del modelo según condición |
| PSD finita, no negativa y bandas integradas | Validez del espectro (FFT) |
| Todas las condiciones producen estados finitos | Robustez en las 5 condiciones |
| Exporta registro JSON reproductible (seed + config) | Formato de experimento |
| `conditionProfile` rechaza condiciones desconocidas | Validación de entrada |

## Checklist de integridad (Fase 20)

| # | Ítem | Estado (2026-08-14) |
|---|---|---|
| 1 | `npm run build` | ✅ 6 páginas, 150 kB JS (gzip 48 kB) |
| 2 | `npm test` (diagnósticos) | ✅ 71/71 (Node) |
| 3 | Suite en el navegador | ✅ 71/71 (`window.runBineuralDiagnostics()`, async) |
| 4 | GPU (WebGL2) | ✅ contexto GL2 detectado; fallback GL1 (GLSL ES 1.00) + `OES_texture_float`; fallback CPU |
| 5 | CPU fallback | ✅ presente en el código (`buildGLProgram` → null → rasterizador) |
| 6 | Móvil | ⚠️ sin dispositivo físico disponible; canvas adaptativo (`devicePixelRatio`), rotación forzada en vertical |
| 7 | NaN/Infinity | ✅ cubierto por tests (WaveField, EEG, cognitivo) |
| 8 | Bounds | ✅ `assertBounds` en neural/cognitivo; tests de rango |
| 9 | HUD no confunde simulación con medición | ✅ grupos separados + etiquetas (Fase 16/17) |
| 10 | Ninguna variable visual presentada como neurofisiológica | ✅ provenance `visual metaphor` obligatoria |
| 11 | Revisión de ecuaciones | ✅ documentada en `docs/scientific-model.md` |

## Reporte de validación — 2026-08-14

- **Entorno**: Windows (Git Bash), Node ≥ 18, Chrome (runtime del preview).
- **Build**: `✓ built in ~1.3 s` — `dist/` regenerado (6 páginas + assets).
- **Tests**: 71/71 en Node y 71/71 en el navegador (corridas consecutivas, sin
  flakiness tras fijar semilla del test 1/f; la suite ahora soporta tests async
  para AlarmManager).
- **Robustez de sistema** (fase P0–P40, núcleo implementado): `AudioClock`
  (reloj maestro), `AppLifecycle` (máquina de estados), `ExperimentEventLog`
  (eventos + integridad de sesión), `PlatformCapabilities` (etiquetas
  honestas), SW con `notificationclick`/acciones y render congelado en
  segundo plano. Documentado en `docs/system-robustness.md`.

## Auditoría Lighthouse (2026-08-14)

Ejecutada con Chrome headless (Lighthouse vía `npx`) sobre la web desplegada
(`https://vyneural-six.vercel.app`) y el build local. Reportes JSON completos en
`docs/lighthouse/`.

| Página | Perf | Accesibilidad | Prácticas | SEO | Notas |
|---|---|---|---|---|---|
| `/` (home, build local con cambios) | 79 | 100 | 96* | 100 | TBT 766 ms; FCP 1.43 s; LCP 2.1 s; CLS ~0 |
| `/privacidad` | 100 | 100 | 100 | 100 | — |
| `/que-son-las-ondas-binaurales` | 100 | 100 | 100 | 100 | 98→100 tras corregir jerarquía de encabezados del footer |
| `/como-usar` | 100 | 98 | 100 | 100 | heading-order del footer (corregido, pendiente de deploy) |

*Los 2 "errores de consola" de la home en local son los scripts de Vercel
Analytics (`/_vercel/*`), que solo existen en producción — artefacto local, no
un defecto real.

**Mejoras aplicadas por la auditoría**:
- Cadencia del pipeline científico (SimulationEngine): 30 Hz en sesión,
  10 Hz en reposo en vez de 60 fps constantes → TBT 1113 → 766 ms, TTI
  5180 → 4182 ms (la simulación sigue avanzando en tiempo real con dt
  acumulado).
- Jerarquía de encabezados del footer (`h4` → `h3`) en las 5 páginas de
  contenido + home: accesibilidad 98 → 100.
- `docs/lighthouse/*.json` guardados como artefacto reproducible.
- **Runtime**: la app arranca sin errores de consola; HUD científico poblado
  (STIMULUS con frecuencias reales, NEURAL con arrastre 12→16 Hz, EEG SIMULATED,
  VISUAL con base de metáfora).
- **Errores estructurales corregidos en esta auditoría** (ver `docs/audit.md`):
  `dominantFreq` sin wiring, EEG nunca conectado, canvas de WaveField en el
  constructor (bloqueaba headless), drenaje de fatiga constante en cognitive,
  test de habituación que caía en la rama equivocada, test CFL con precisión
  flotante.

## Reproducibilidad de un experimento

1. Elegir `SimulationSeed(seed)` y `SimulationConfig(...)`.
2. Construir el motor con la semilla:
   `new SimulationEngine(cymatics, { seed })`.
3. Ejecutar y exportar `engine.recordExperiment(results)` → JSON
   `{ modelVersion, seed, config, recordedAt, results }`.
4. Re-ejecutar con el mismo seed + config → mismos streams (verificado por test).
