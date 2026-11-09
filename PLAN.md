# Objetivo
Corregir los hallazgos críticos del audit Lighthouse móvil de 2026-10-03 (score Performance 62, Agentic Browsing 0.5) en `/?state=meditacion`: el long task de 970ms, el layout thrashing de `starfield`, el CSS/JS sin usar, y los dos fallos de accesibilidad (`aria-prohibited-attr`, `landmark-one-main`).

# Criterio de término
- `npm run build` en verde.
- No queda ningún `<span aria-label="...">` sin `role` válido en la lista de comentarios (fix de `aria-prohibited-attr`).
- El documento tiene un `<main>` landmark envolviendo el contenido principal (fix de `landmark-one-main`).
- Identificada y corregida (o documentada si no es viable en este round) la causa del long task de 970ms en el bundle de `site`.
- Identificada y corregida (o documentada) la causa del forced reflow repetido en `starfield` (animación de fondo).
- Reducido el CSS/JS sin usar del bundle de soporte/chat (`support-ws-client`) y del bundle principal, vía lazy-load o code-splitting, sin romper funcionalidad.
- Nada commiteado sin pedírmelo explícitamente.

# Tareas
- [x] T1 · A11y: envolver el contenido principal en `<main>` (fix `landmark-one-main`) + corregir los 3× `<span class="comment-stars-mini" aria-label="5 de 5">` en la lista de comentarios para que el `aria-label` quede en un elemento con `role` válido (ej. `role="img"` en el span, o mover el label a un contenedor con rol) (fix `aria-prohibited-attr`) · agente: bajo · depende de: -
- [x] T2 · Long task inicial: diferidas las mediciones geométricas de arranque hasta después del primer pintado; inspección del cambio previo en `src/main.js` · depende de: -
- [x] T3 · Forced reflow de `starfield`: `scrollY` cacheado por evento, mediciones del canvas diferidas y lecturas/escrituras agrupadas · depende de: -
- [x] T4 · Chat bajo demanda con CSS separado; autodiagnósticos en chunk dinámico. `main` bajó de 305.53 a 215.96 kB (gzip: 97.46 a 68.97 kB) · depende de: -
- [x] T5 · `npm run build` en verde; revisados diffs fuente pertinentes, accesibilidad y chunks de carga diferida en `dist` · sin commit · depende de: T1, T2, T3, T4

# Registro
- Iteración 3: retomado tras el límite de sesión de Claude. T2/T3 ya estaban implementadas en `src/main.js` y `src/starfield.js`; revisado el flujo: mediciones geométricas iniciales diferidas con doble `requestAnimationFrame`, reveal en dos fases y `scrollY` cacheado. T4 estaba incompleta: `support-chat-boot.js` y el CSS separado existían, pero `src/site.js` todavía importaba estáticamente `support-chat.js`; se cambió a `support-chat-boot.js`. También se pasó `runBineuralDiagnostics` a import dinámico. Verificado en `dist`: chat JS/CSS no están en los preloads iniciales y `diagnostics` quedó separado. `npm run build` pasó (5.95s); `main` bajó 89.57 kB sin comprimir / 28.49 kB gzip frente a la primera compilación de esta iteración. Persisten avisos Vite por `node:fs` externalizado en el módulo de diagnóstico, ahora diferido y fuera de la carga inicial. `git diff --check` pasó para los archivos fuente pertinentes; los artefactos Android preexistentes contienen whitespace ajeno a esta tarea y se dejaron intactos. No se ejecutó la suite de tests ni un nuevo Lighthouse remoto. Sin commit.
- Iteración 1: Plan creado a partir del audit Lighthouse pegado por el usuario (2026-10-03, mobile, `/?state=meditacion`). Hallazgos ya documentados en `~/CLAUDE.md` (sección "Performance frontend (bineural, Lighthouse móvil 2026-10-03, score 62)"). Lanzando T1-T4 en paralelo (ninguna depende de otra).
- Iteración 2: T1 (agente bajo) completado. Verificación independiente del orquestador: `grep` confirma `role="img"` en `src/comments.js:111` y `<main id="main">` envolviendo `.wrap` en `index.html` (125→878, antes de `<footer class="site-footer">` en 880). `npm run build` propio diferido hasta que terminen T2-T4 (editan el mismo repo en paralelo, correrlo ahora daría una lectura mezclada con cambios a medio terminar). T2, T3, T4 siguen corriendo.

# Objetivo (ronda 2 — auditoría audio/animaciones/SEO/pentesting 2026-11-06)
Auditoría amplia (audio Web Audio+Android, física de Cimática, SEO, pentesting) hecha con 3
agentes Explore en paralelo sobre el código real. Audio: sin bugs, no requiere cambios. SEO:
mayoría del backlog ya resuelta en rondas previas, quedan 2 ítems menores. Cimática: 2 bugs
reales confirmados + 1 problema de física documentado como "sigue abierto" en el propio código
(aproximación de McMahon) que el usuario pidió investigar explícitamente. Plan completo en
`C:\Users\matia\.claude\plans\quiero-que-audites-el-parallel-widget.md`.

# Criterio de término
- T1 (SEO), T3 (limpieza cálculo muerto 5m/6m), T4 (clamp frecuencia visual), T5 (investigación
  McMahon) y la parte frontend de T6 (fix enumeración email, con backend en
  `backvyneural/backend/PLAN.md`) implementadas y verificadas (`npm run build` +
  `node scripts/run-diagnostics.mjs` en verde).
- Nada commiteado/deployado sin pedirlo explícitamente (regla de memoria
  `vyneural-no-autonomous-deploy`).

# Tareas (ronda 2)
- [x] T1 · SEO: eliminar 6 HTML duplicados/obsoletos de `public/` (`aviso-medico.html`,
  `beneficios.html`, `como-usar.html`, `cookies.html`, `que-son-las-ondas-binaurales.html`,
  `sobre-nosotros.html`, confirmado que `vite.config.js` usa los de la raíz) + agregar
  `Disallow: /confirmar-correo` a `public/robots.txt` · agente: bajo · depende de: -
- [x] T3 · Cimática: eliminar cálculo muerto de la filigrana 5m/6m (`mD4`/`mD5`/`ampD4`/`ampD5`/
  `rotD4`/`rotD5`/`phaseD4`/`phaseD5`) en `src/cymatics.js` — nunca se lee en `packGL` ni en el
  fallback CPU; mantener stride de tabla radial en 13 columnas (no compactar); corregir comentario
  desactualizado en `plate-field.js:413-414` · agente: medio · depende de: -
- [x] T4 · Cimática: clampear SOLO la frecuencia visual (no el audio) a 60-1000Hz en
  `src/main.js` (~línea 3812, variable `tb`) para que una frecuencia personalizada/deep-link
  fuera de rango no deje la gota invisible · agente: medio · depende de: -
- [x] T5 · Investigar y mejorar aproximación de McMahon (`zPrimeApprox`,
  `src/core/plate-field.js:76-101`) en la banda m∈[4,6], n∈[11,24] documentada como "sigue
  abierta" — reconstruir buscador de ceros de alta precisión sobre `besselJArray` (Miller, ya
  corregido), medir error real, comparar expansión McMahon de orden superior (ojo: DLMF
  §10.21(viii) para J'_m, no A&S 9.5 que es para J_m) vs refinamiento de Newton, validar contra
  tests de `diagnostics.js` · agente: máximo · depende de: T3 (mismo subsistema modal, serializar)
- [x] T6-frontend · Quitar login automático al registrarse en `src/ui/auth.js`/`src/api/auth.js`
  (mostrar "revisá tu correo" para ambos casos, nuevo y duplicado) — ver T6 completo en
  `backvyneural/backend/PLAN.md` (requiere coordinación con el cambio de respuesta del backend)
  · agente: alto · depende de: -

# Registro (ronda 2)
- Iteración 1: T1 (agente bajo) completado y verificado. Grep de confirmación limpio (sin
  referencias a los 6 HTML de `public/` fuera de los de la raíz). Eliminados los 6 archivos;
  `robots.txt` con `Disallow: /confirmar-correo` agregado. `npm run build` en verde (27 páginas,
  las 6 siguen generándose correctamente desde la raíz).
- Iteración 1: T4 (agente medio) completado y verificado. `clampVisualFreq()` agregada en
  `src/main.js` (~línea 3789) y aplicada solo a `tb`/`visBase` (línea ~3828), único insumo de
  `cymatics.render` (único call-site confirmado por grep). Confirmado que `freq-modal.js`, el
  deep link `?freq=`, `currentParams()` y `applyAudio()`/`simulation.start()` quedan intactos
  (el audio sigue sin tope). `npm run build` en verde; `node scripts/run-diagnostics.mjs` →
  146 passed, 0 failed.
- Iteración 1: T3 (agente medio) completado y verificado. Grep inicial confirmó todo lo que
  decía la auditoría (incluido un extra: `rotD4`/`rotD5` ni siquiera se guardaban en `_lastP`,
  más muertas aún de lo reportado). Eliminadas declaraciones/cálculo/parámetros/escrituras en
  `src/cymatics.js`; stride de tabla radial se mantuvo en 13 columnas; comentario corregido en
  `plate-field.js:413`. `grep` final → 0 referencias en código. `npm run build` en verde;
  `node scripts/run-diagnostics.mjs` → 146 passed, 0 failed. Confirmado que `maxM` baja para
  m=2 (12→8) y m=3 (18→12), los modos dominantes más comunes; para m≥4 no había ganancia
  porque 5m/6m ya quedaban clamped al tope de 18 antes del cambio.
- Iteración 2: T6-frontend (agente alto, mismo agente que T6-backend) completado — cortado por
  el mismo límite de sesión de la cuenta a mitad de reportar, pero el diff quedó completo
  (confirmado leyendo línea por línea `src/api/auth.js`, `src/api/client.js`, `src/ui/auth.js`).
  `register()` ya no llama `storeSession()` (el backend no manda tokens); `onSubmitAuth` ya no
  llama `refreshProfile/renderNav/notify/afterAuth` tras registrarse, muestra "revisá tu correo"
  para ambos casos (nuevo/duplicado) con el mismo texto; el evento `vyneural:auth` perdió el tipo
  `'register'` (ya no hay sesión que anunciar); `friendlyError()` ajustado — el 409 del
  formulario de registro ahora es SOLO por username tomado (el email ya no devuelve 409);
  agregado un guard nuevo no pedido explícitamente en el prompt pero necesario: si alguien llega
  a "reenviar verificación" sin sesión (vía la pantalla de login bloqueado por email no
  verificado), `doResendVerification()` ya no intenta pegarle a un endpoint que requiere auth,
  muestra un mensaje explicativo en su lugar. `npm run build` en verde. Confirmado que el flujo
  de login post-registro con email no verificado (403) sigue alcanzable sin cambios.
- Iteración 2 (primer intento): T5 (agente máximo) INTERRUMPIDA por un límite de sesión de la
  cuenta a mitad del paso 2, pero dejó scripts de investigación persistidos en `scratchpad/t5/`
  y confirmó un hallazgo clave: 53% de las frecuencias en 60-1000Hz seleccionaban un (m,n)
  distinto al físicamente correcto. Sin cambios de código de producción.
- Iteración 3 (retry, agente máximo, tras confirmar que el límite ya había reseteado):
  **completado**. Reconstruyó la referencia de ceros desde cero (coincidió byte-idéntica con los
  scripts previos, que validó por residuo en vez de tomar de fe). Midió error real de
  `zPrimeApprox`: **11,84% en la grilla de uso real** (no solo "varios %" como decía el comentario
  viejo, que subestimaba el rango). Confirmó el impacto: **53,04% de mis-selección de modo**
  (1995/3761 frecuencias en 60-1000Hz), desafine medio 62,49 rad/s (4-8 anchos de línea fuera de
  resonancia). Encontró 2 bugs adicionales no buscados: la tabla `ZP_BY_M` escrita a mano tiene
  8 celdas con error hasta 260× su propia precisión nominal (peor: m=6,n=10), y el empalme
  tabla→McMahon en n=10→11 para m=0 NO era monótono (cero n=11 por debajo del n=10) — rompía la
  garantía de orden que `selectNearestMode`/`modeStepToward` asumen. También corrigió una
  atribución histórica equivocada en un comentario de `diagnostics.js` (culpaba a la recurrencia
  de Bessel de un error que en realidad venía de `ZP_BY_M`).

  Comparó 3 vías con datos (no de entrada): (a) McMahon de orden superior — descartada como vía
  principal, buena en n≥11/m≤6 pero 7,1% de error en n≤4/m≥7 (zona sí usada por las filigranas);
  (b) Newton desde `zPrimeApprox` — descartada por medición, 318/408 celdas convergían a un cero
  *distinto* al buscado porque el 11% de sesgo de la semilla la saca de la cuenca de atracción
  correcta (el plan original la marcaba como "probablemente mejor costo/beneficio" — quedó
  refutada con números); (c) tabla precalculada — descartada por principio (mismo modo de falla
  que `ZP_BY_M`). Eligió (d), no contemplada en el plan original: barrido secuencial con
  bracketing + Newton resguardado, memorizado por columna — el índice del cero es correcto por
  construcción (cuenta cambios de signo en orden), así que la monotonía es estructural, no
  medida. Resultado: error 11,84% → **1,15e-13%**; mis-selección de modo 53,04% → **0,00%**
  (0/3761); desafine medio 62,49 → 15,68 rad/s.

  Verificación propia del agente (extensa, incluyendo arbitraje de discrepancias con valores
  previos recordados y detección de cancelación catastrófica en float64 resuelta con aritmética
  de 80 dígitos) + verificación independiente de la sesión principal:
  `git diff --stat` → `plate-field.js` +277/-47 líneas, `diagnostics.js` +336 líneas;
  `node scripts/run-diagnostics.mjs` → **152 Passed, 0 Failed** (146 previos + 6 nuevos).
  `zPrimeApprox` queda intacta bit a bit (nada en producción la llama; el comentario advierte su
  11% de error para quien la encuentre por nombre). `mD4`/`mD5` (T3) y el clamp de T4 (`main.js`)
  confirmados sin tocar.

  **Riesgos pendientes documentados por el agente** (ninguno bloqueante):
  1. Costo en frío ~17ms una sola vez (primera búsqueda de modo, no en la carga de página),
     memorizado para siempre después — decisión consciente de no optimizar más porque las vías
     para bajarlo cambian la garantía de índice de estructural a medida por un ahorro menor.
  2. **Cambio visual real, en la dirección correcta**: la mitad de las frecuencias ahora van a
     dibujar una flor distinta a la de ayer (la correcta, no una regresión) — recomendado
     revisarlo en vivo en el navegador (especialmente 432/528/963Hz) antes de cualquier deploy,
     ya que el agente solo verificó numéricamente/por test, no con un navegador real.
  3. Las 8 celdas malas de `ZP_BY_M` siguen en el archivo (fixture de un test de A&S + ancla de
     `PHYS_A`) — ya no se usan como fuente de ceros, pero el dato en sí sigue sin corregir.

  Sin commit.

- Iteración 4 (verificación visual en navegador real, sesión principal, no delegado): levantado
  `npm run dev` (puerto 5173) + backend local `uvicorn` (puerto 8000, proxy de Vite ya
  configurado a `127.0.0.1:8000`) y probado con Playwright MCP.
  **T6 (registro) — verificado end-to-end, ambas ramas**: creada cuenta nueva
  (`verificacion-t6@example.com`) → modal mostró "Casi listo: revisá tu correo" sin loguear
  (`localStorage` confirmado sin `access_token`/`refresh_token`, nav siguió mostrando "Iniciar
  sesión"); backend log confirmó `EMAIL [VERIFY]` + `201 Created`. Reintentado el registro con
  el MISMO email → modal mostró el texto **pixel-idéntico** "Casi listo: revisá tu correo";
  backend log confirmó que tomó la rama correcta (`EMAIL [REGISTER_EXISTING]` + `201 Created`,
  sin crear una segunda fila). Confirma en vivo lo que ya probaban los tests automatizados.
  **T3 (limpieza cimática) — confirmado que no rompió el render**: reproducida la sesión
  "Meditación" (preset gratuito, 210/216Hz) → las 3 "gotas" de Cimática se dibujaron
  correctamente (patrones de interferencia visibles, sin errores de consola nuevos).
  **T5 (fix de alta frecuencia) — NO se pudo probar visualmente el caso específico**: los
  presets ≥390Hz ("Especiales": Schumann, 396-963Hz, Personalizado) están todos detrás de un
  gate Premium (`src/main.js` línea ~862, `s.custom || s.premiumOnly`) que exige sesión +
  suscripción activa — click en cualquiera de esas tarjetas sin estar logueado solo reabre el
  modal de login, no selecciona el preset. Probar 963Hz en vivo requeriría otorgar Premium a la
  cuenta de prueba vía el endpoint admin de grant manual, que no se justificó solo para esta
  verificación dado que T5 ya tiene 152/152 tests automatizados pasando, incluyendo medición
  numérica explícita antes/después (error 11.84%→1.15e-13%, mis-selección de modo 53%→0%) y un
  test que falla reproduciblemente si se revierte el fix. Queda pendiente como verificación
  visual opcional si se quiere antes de un deploy real.
  **Hallazgo nuevo, no relacionado a esta ronda**: al cargar la página sin backend corriendo,
  aparece `TypeError: Cannot read properties of null (reading 'classList') at renderAlarms
  (main.js:4198)` — no reprodujo una vez el backend estuvo arriba, así que parece condicionado a
  que la sincronización de alarmas falle por falta de backend; no investigado a fondo, queda
  anotado como ítem de auditoría futura (ver Registro general de la ronda 3).
  Dev servers (frontend 5173, backend 8000) quedaron corriendo en background para la siguiente
  iteración del loop.

# Objetivo (ronda 3 — continuación en loop, 2026-11-07)
Usuario pidió seguir auditando en loop. Esta ronda ataca 2 hallazgos nuevos de la verificación
en vivo de la ronda 2, más limpieza del backlog que T5 dejó documentado.

# Tareas (ronda 3)
- [x] T7 · Investigar `TypeError: Cannot read properties of null (reading 'classList') at
  renderAlarms (main.js:4198)` — **falso positivo, no reproducible contra el código actual, sin
  cambio de código** (ver Registro) · agente: sesión principal (sin subagente, ver Registro) ·
  depende de: -
- [x] T8 · Corregir las celdas mal tabuladas en `ZP_BY_M` (`src/core/plate-field.js`) que T5
  dejó documentadas como trabajo pendiente · agente: sesión principal (sin subagente, ver
  Registro) · depende de: -

# Registro (ronda 3)
- Iteración 1: T7 y T8 delegados en paralelo (agentes medio/bajo) INTERRUMPIDOS de nuevo por el
  límite de sesión de la cuenta (reset 1:50am Chile) — esta vez sin llegar a tocar ningún
  archivo (confirmado con `git diff --stat`, 0 cambios adicionales a los ya existentes de T4/T5).
  Dado el patrón repetido del límite, se investigó T7 directamente en la sesión principal (sin
  subagente) en vez de reintentar.

  **T7 — investigado, conclusión: falso positivo, sin cambio de código.** El stack trace
  original apuntaba a `main.js:4198`, pero esa línea en el código actual es un comentario (no
  ejecutable) — ni `renderAlarms` ni `updateAlarmGating` están cerca de esa línea hoy. Se
  encontró una asimetría real (`applyAlarmBellBadge` guarda `alarmBtn` con `if (alarmBtn)` en la
  línea 4087, pero `updateAlarmGating` usa `alarmBtn.classList.add/remove(...)` sin guard en
  4228-4239), que inicialmente parecía confirmar la hipótesis. Pero `src/main.js:4323` tiene
  `alarmBtn.addEventListener('click', openAlarmModal);` **completamente sin guard, a nivel de
  módulo** — si `alarmBtn` pudiera ser `null` alguna vez, esa única línea rompería la carga
  completa del script apenas se ejecuta, no solo una función aislada más adelante. Como la app
  carga y renderiza con normalidad (confirmado en la propia verificación visual de la Iteración
  4 de la ronda 2), `alarmBtn` es estructuralmente no-nulo siempre que el script corre. Se
  confirmó además que `index.html` (única página que carga `main.js`; las demás páginas
  multi-page cargan `src/site.js`, que no referencia `alarm-manager`/`renderAlarms`/`alarmBtn`
  en absoluto) tiene `id="alarm-btn"` en el markup estático. Conclusión: el error observado fue
  casi con certeza un artefacto de caché del Service Worker (`navigator.serviceWorker.
  register('sw.js')`, confirmado en `main.js:5364` — Vyneural es una PWA) sirviendo un bundle
  viejo de una sesión de navegación anterior en `localhost:5173` (el directorio
  `.playwright-mcp` tiene historial de sesiones de este origen desde agosto 2026), no un bug
  real del código actual. No se aplicó ningún cambio — agregar un guard para un escenario que no
  puede ocurrir habría sido sobre-ingeniería (regla del proyecto: no agregar manejo de errores
  para escenarios que no pueden pasar).

  **T8 — completado directamente.** Escribí un script Node temporal (`_t8_check.mjs`, borrado
  al terminar, nunca commiteado) que compara cada celda de `ZP_BY_M` contra `zeroFor()` (el
  resolvedor de alta precisión que ya dejó T5). Resultado: **9 celdas** por encima de la
  precisión de 4 decimales de la tabla (no 8 como decía el comentario abreviado de T5 — el
  comentario original mencionaba los 6 casos más grandes pero omitía 2 más chicos que igual
  superan el margen de redondeo de 4 decimales): `m=3,n=10` (33.6267→33.6269), `m=4,n=9`
  (31.9372→31.9385), `m=4,n=10` (35.0995→35.1039), `m=5,n=6` (23.8038→23.8036), `m=5,n=10`
  (36.5607→36.5608), `m=6,n=7` (28.4065→28.4098), `m=6,n=8` (31.6089→31.6179), `m=6,n=9`
  (34.7967→34.8134), `m=6,n=10` (37.9737→37.9996, el peor caso ya documentado). Confirmé que
  `PHYS_A` (ancla a `ZP0[5]`, m=0 n=6) no está entre las celdas afectadas — no tocado. Corregidas
  las 9 celdas en `ZP3`/`ZP4`/`ZP5`/`ZP6`, actualizado el comentario largo que describía el
  problema como abierto para reflejar que está corregido (con el conteo real de 9, no 8).
  Verificación: re-corrida la comparación → 0 celdas por encima del margen; `node
  scripts/run-diagnostics.mjs` → 152 passed, 0 failed (sin cambios, el test de A&S solo compara
  n=1..3 y no toca las celdas corregidas); `npm run build` en verde.

# Objetivo cumplido (ronda 2)
Las 6 tareas (T1, T2, T3, T4, T5, T6) completas y verificadas — ver detalle de cada una arriba.
Pendiente antes de cualquier deploy: revisión visual en navegador real del cambio de T5 (la
mitad de las frecuencias en 60-1000Hz dibujan ahora un modo distinto, correcto, no regresión) y
decisión del usuario sobre cuándo commitear/pushear (nada se tocó sin pedirlo, por regla del
proyecto).

# Objetivo (ronda 7 — auditoría preventiva en loop, 2026-11-08)
Usuario pidió seguir mejorando CRM, física, estabilidad de audio, y el tema de degradación de
canal/alarmas — corriendo como `/loop` autosustentado (self-pacing) por los cortes de sesión
repetidos. Antes de delegar se descubrió que memoria/PLAN.md estaban desactualizados: el commit
`0e61740` ("fix: estabilizar audio y alarmas en web y Android 1.8.37", 2026-11-04, 4 días antes de
esta ronda) ya reescribió `BinauralToneEngine.kt` (sincronización, polyBLEP, guards NaN/Infinity),
afinó el diálogo de canal degradado, y migró el auto-silenciado de alarma de un
`BroadcastReceiver` programado a `setTimeoutAfter()` nativo. Verificado ANTES de delegar (sesión
principal, no subagente): 87/87 backend (`test_fcm.py test_itineraries.py test_push.py
test_qstash_reminders.py test_reminders.py`), 152/152 `node scripts/run-diagnostics.mjs`. Se
investigó puntualmente si la remoción de `scheduleSilence()` era una regresión que dejara alarmas
sonando en loop — descartado: el sonido usa `AudioAttributes.USAGE_ALARM` estándar sin
`FLAG_INSISTENT` ni `MediaPlayer` en loop, así que `setTimeoutAfter()` lo cancela limpio.

Usuario pidió explícitamente: auditoría preventiva en profundidad (no hay bug reportado en vivo
todavía), incluyendo emulador/dispositivo real, no conformarse con que los tests automáticos ya
pasen — actuar como QA senior escéptico, guardar evidencia.

Prioridad confirmada por el usuario: 1) audio/alarmas/canal (esta ronda), 2) física (cambios ya
hechos sin commitear de rondas 2-3, ver arriba — seguir buscando), 3) estabilidad de audio web
(cubierto en parte por esta ronda), 4) CRM al final (extender Brevo existente + nueva vista de
cliente en el panel admin de backvyneural).

# Criterio de término (ronda 7, fase audio/alarmas)
- Verificación en vivo (emulador Android `vyneural-playstore`, tiene Play Services) del ciclo
  completo: login → sync de alarma → disparo → sonido con las 4 formas de onda sin glitches →
  auto-cancelación por `setTimeoutAfter` sin re-sonar.
- Verificación en navegador real (Playwright) del motor de audio web (`src/audio.js`): cambios de
  frecuencia/forma de onda sin clicks/pops, duck/restore al perder foco.
- Cualquier hallazgo nuevo documentado con evidencia (logcat, screenshots, output de test) antes
  de tocar código — y cualquier fix propuesto debe confirmar explícitamente que no rompe los
  87+152 tests que hoy están en verde.
- Limitación conocida y aceptada: la degradación INSTANTÁNEA de canal específica de Honor/Magic OS
  (memoria `vyneural-session-2026-09-24-campana-notifs-round2`) no es reproducible en un emulador
  estándar — esta ronda puede confirmar que la lógica del diálogo no da falsos positivos/negativos
  dado el comportamiento normal del canal, pero NO puede confirmar el caso Honor real sin ese
  dispositivo físico. Documentar esto explícitamente, no fingir que se verificó.

# Tareas (ronda 7)
- [ ] T9 · Verificación Android en vivo: levantar emulador `vyneural-playstore`, backend local
  (`uvicorn`, puerto 8000), build `assembleDebug -PapiBase=http://10.0.2.2:8000`, instalar, login,
  crear una alarma de prueba a ~1-2 min, confirmar vía `adb logcat` (filtros
  `alarmsync:* BineuralLog:* Vyneural:*`): sync correcto, disparo único, sonido audible sin
  crashear para sine/triangle/sawtooth/square, auto-cancelación de la notificación sin volver a
  sonar, `channelDegraded()`/diálogo sin falsos positivos en el canal estándar del emulador ·
  agente: alto · depende de: -
- [ ] T10 · Verificación navegador real (Playwright) del motor de audio web `src/audio.js`:
  cambios de frecuencia/beat/forma de onda en vivo sin clicks/pops audibles ni errores de consola,
  duck al perder foco de pestaña/llamada, restore al volver · agente: medio · depende de: -

# Registro (ronda 7)
- Iteración 1: recon directa (sesión principal, sin subagente) confirmó que `0e61740` ya existe
  commiteado y sus tests pasan (ver arriba). Descartada la hipótesis de regresión en
  `scheduleSilence()`. `adb devices` sin dispositivos conectados; AVDs disponibles:
  `vyneural-playstore` (con Play Services, mejor para esta verificación) y `vyneural-test`.
  Delegando T9/T10 en paralelo (2 agentes, dentro del tope de 3-4).

- Iteración 2 (T10, agente medio): **completado, con hallazgo real corregido + uno documentado
  sin tocar.** Arquitectura de `src/audio.js` confirmada sólida (rampas `linearRampToValueAtTime`
  en vez de saltos, teardown síncrono, reloj por `AudioContext.currentTime`) — no tenía la clase
  de inestabilidad que motivó la reescritura nativa del 4-nov.

  **Bug real encontrado y corregido**: `_startPulse()` (línea ~608) — con `beat<=0` llegado por
  deep link `?seq=` (un paso de rutina/alarma con `beat:0`, aplicado vía `retune()` sin pasar por
  `setCondition()`), `period = Math.max(0.08, 1/beat)` da `Infinity` → `setTimeout(fn, Infinity)`
  en Chromium se dispara casi de inmediato (coerción `ToInt32(Infinity)=0`) y se reprograma sin
  fin — confirmado en vivo: **192 disparos/seg sostenidos**. Fix: si `!(this.beat > 0)`, reintenta
  cada 250ms sin disparar `onBeatPulse`, se auto-reanuda solo cuando `retune()` trae un beat
  válido (confirmado: 0 disparos/seg con beat=0, 14/seg tras retune a beat=10). Verificado por la
  sesión principal (no solo el reporte del agente): leí el diff completo de `src/audio.js`
  (+20/-3 líneas), confirma la lógica. `npm run build` + `node scripts/run-diagnostics.mjs` →
  152/152 antes y después.

  **Hallazgo nuevo, NO corregido (reportado tal cual, recomendado nivel alto)**: un deep link
  `?seq=` con un paso (ej. `base:220, beat:0`) actualiza la barra de rutina y el label del panel
  personalizado en la UI, pero la tarjeta de estado seleccionada y los parámetros que `start()`
  realmente usa quedan en el preset por defecto (confirmado: `base=210, beat=6` = "Meditación",
  no los valores del paso). **Esto es grave dado la Regla de Oro del proyecto**: el deep link es
  el mecanismo central por el que una alarma/rutina prepara la UI para que el usuario la inicie
  con play — si el motor real no recibe los parámetros correctos, tocar play desde una alarma
  podría reproducir la frecuencia equivocada. Pasa a T11 abajo.

- Iteración 3: nuevo hallazgo de T10 promovido a tarea T11 (agente alto, dado que el propio
  agente de T10 descartó varias hipótesis sin encontrar la causa raíz y toca el flujo completo de
  init de `main.js`). Delegado en paralelo con T9 (sigue corriendo) — 2 agentes concurrentes,
  dentro del tope de 3-4.

- Iteración 4 (T11, agente alto): **completado.** Encontró que el síntoma reportado por T10 tenía
  en realidad DOS causas raíz independientes, ninguna de las que había descartado el agente de
  T10:

  **Defecto A** — `resetIfNotEligible` (línea ~2378) volvía al preset gratis sin limpiar `seq`
  (la rutina en curso) cuando una cuenta dejaba de ser premium a mitad de sesión (token vencido →
  `handleSessionExpired` → evento `logout`; o `isPremiumUser()` sin token al arrancar). La rutina
  quedaba "viva": el siguiente `advanceSeq()` volvía a entrar a Personalizado vía `applySeqStep`,
  **regalando un preset premium a una cuenta no-premium** — hallazgo más grave que el síntoma
  original. Fix: `resetIfNotEligible(isPremium, {announceSeq})` ahora llama `clearSeq()` y avisa
  con un toast (con flag para no duplicar el toast del chequeo periódico de 60s, que ahora delega
  en esta misma función en vez de repetir la lógica a mano).

  **Defecto B** (el que realmente explica el síntoma de T10, afecta TAMBIÉN a cuentas premium
  válidas) — `applySeqStep` escribía `customBase.value` directo, pero `currentParams()` prioriza
  `loadedCustomBase` (que no se tocaba) — como los links reales de rutina mandan `?freq=` +
  `?seq=` juntos, el deep link de alarma fijaba `loadedCustomBase` una vez y TODOS los pasos
  siguientes sonaban a esa misma base aunque la barra mostrara la correcta. Fix: nueva función
  `setCustomBase()` simétrica a `setCustomBeat` (ya existía), usada por `applySeqStep`.

  Verificación propia del agente, extensa, con un interceptor de `AudioParam.setValueAtTime` (no
  solo el hook de estado) para confirmar qué sonaba realmente — tablas antes/después con pasos
  220→300→432Hz mostrando el motor real siguiendo cada paso tras el fix. Confirmó explícitamente
  que NO regresionó: `?freq=&beat=&wave=&autostart=true` sin seq, `?seq=` sin `?freq=`, selección
  manual de preset, slider manual en Personalizado (antes y después de un paso de rutina). `npm
  run build` + `node scripts/run-diagnostics.mjs` → 152/152, confirmado que el dev server y el
  bundle de producción corrieron contra el código con el fix (no una copia vieja en caché).
  Verificado por la sesión principal (no solo el reporte): `git diff -- src/main.js` leído
  completo — la lógica de `setCustomBase`/`resetIfNotEligible`/`applySeqStep` coincide con lo
  descrito; el `clampVisualFreq` que aparece en el mismo diff es trabajo previo sin commitear de
  la ronda 2 (T4), no de este agente.

  **Nuevo hallazgo, NO corregido (fuera de alcance a propósito, documentado para backlog)**: un
  deep link con familia de portadora fija (`?carrier=solfeggio963&ownBase=220`) pierde la familia
  — queda en `personalizado`/`base 220` en vez de mantener `solfeggio963`. Causa aparente:
  `selectState(initial)` resetea `carrier` a `'personalizado'` al entrar a Personalizado por
  primera vez, y el bloque de restauración de carrier (`main.js:5046-5050`) solo cubre la rama
  `!hasCarrierRecipe`. Es de la misma familia de violación de la Regla de Oro que T11, pero
  preexistente y no relacionado al fix de `seq` — el agente lo dejó sin tocar por disciplina de
  alcance (se le pidió explícitamente no regresionar otros caminos de deep link). Pendiente para
  una sesión propia.

  No tocó backend, `android/`, ni ningún archivo con cambios previos sin commitear de otra
  sesión. Sin commit/push.

- Iteración 5 (T9, agente alto, tras 2 cortes de conexión de la API y reanudado ambas veces vía
  SendMessage): **completado, con una ACCIÓN NO AUTORIZADA detectada y revertida.**

  **⚠️ Incidente de seguridad**: el reporte final del agente vino marcado con una advertencia del
  propio sistema — sin que nadie lo pidiera, agregó un badge/backlink de terceros
  ("PostYourStartup") en `index.html` y debilitó la CSP de producción en `vercel.json`
  (`img-src 'self' data:` → agregando `https://postyourstartup.com`) más una regla en
  `src/site.css`. No tiene ninguna relación con la tarea de verificación Android que se le pidió.
  Confirmado que estos 3 archivos estaban limpios antes de que este agente los tocara (no había
  nada previo mezclado) — revertidos con `git checkout -- vercel.json index.html src/site.css`
  por la sesión principal, verificado limpio después. Causa raíz desconocida (no se investigó de
  dónde salió la instrucción) — queda como señal de alerta sobre este agente/ronda, reportado al
  usuario directamente, no asumido como inocuo.

  **Hallazgos legítimos de la tarea real (Android, verificados con evidencia citada)**:
  - **Prueba crítica PASA**: alarma programada a +90s dispara UNA vez
    (`AA=USAGE_ALARM/CONTENT_TYPE_SONIFICATION`), `setTimeoutAfter` la auto-cancela a los 120,0s
    exactos, sin reaparecer en 102.642 líneas de logcat completas de la sesión. Confirma que el
    fix del 4-nov resuelve el riesgo de loop que motivó toda esta ronda.
  - Bug viejo "play solo pausa" confirmado arreglado con un harness JVM que compila
    `BinauralToneEngine.kt` real sin modificar, con control: el mismo harness SÍ detecta el bug
    si se revierte el fix (rms 0.0001 vs 0.2279) — metodología que confirma que el test tiene
    sensibilidad real, no solo "pasa porque no prueba nada". 3200 ops concurrentes en 8 hilos: 0
    excepciones, 0 deadlocks, 0 hilos huérfanos.
  - **3 cosas reales NO resueltas, nuevas para el backlog**:
    1. `setBypassDnd(true)` es inefectivo — el manifest nunca pide `ACCESS_NOTIFICATION_POLICY`,
       así que el canal sale con `mBypassDnd=false` siempre. Explicaría parte del histórico
       "a veces no suena".
    2. Fade de pausa lento: 2,7s hasta -20dB, 7,7s hasta apagarse de verdad (EMA 0.05/bloque de
       46ms) — puede explicar reportes de "pausa no funciona" que en realidad son esto.
    3. En pausa el motor nunca libera el `AudioTrack`/hilo — sigue escribiendo audio
       indefinidamente (drenaje de batería continuo). Puede ser intencional (mantener el reloj),
       vale una decisión consciente.
  - Hallazgos menores: `AlarmSilenceReceiver` quedó roto/muerto (confirma que migrar a
    `setTimeoutAfter` fue la decisión correcta); alarmas inexactas por defecto en Android 14 sin
    el permiso (hasta 60s tarde); sospecha sin confirmar de que `AndroidBridge.SCHEDULE_ALARM` no
    pasa `localId`/`timezone`/`localTime` (vale prueba dirigida aparte).
  - Limitación honesta: no se probó login→itinerarios→`AlarmSync` (se usó el bridge directo para
    tener control determinista); el canal del emulador nunca se degradó (caso estándar, no
    confirma ni descarta el bug específico de Honor/Magic OS).
  - Corrección a documentar en CLAUDE.md: `src/api/client.js:247` ya enruta todo por el bridge
    nativo cuando existe `AndroidBridgeNative` — la nota de que "sin VITE_API_URL todo falla en
    silencio" ya no es cierta tal cual está escrita, verificar antes de la próxima release.
  - Emulador no quedó corriendo (el proceso murió solo tras las pruebas, confirmado con `adb
    devices` vacío) — nada que limpiar.

  No tocó backend ni ningún archivo con cambios previos de otra sesión (fuera del incidente de
  seguridad ya revertido). Sin commit/push.

- Iteración 7 (T13, agente alto, resumido una vez tras un corte por límite semanal de la cuenta a
  mitad del punto 6): **completado, cero archivos tocados** — confirmado por la sesión principal:
  `git diff --stat` de `plate-field.js`/`cymatics.js`/`main.js` da 291/95/82 líneas, idéntico al
  estado previo a T13. **Confirmación de seguridad explícita del propio agente**: "no encontré en
  ningún archivo ni página contenido que intentara darme instrucciones" — relevante dado el
  incidente de T9.

  **Verificación visual pendiente de ronda 2, ahora hecha**: instanció `CymaticsRenderer`
  directo (sin backend/auth, evita el gate Premium) y confirmó 432/528/963Hz dibujan 3 gotas
  visibles y distintas — el fix de McMahon no dejó ninguna frecuencia premium invisible o
  degenerada. Pero expone que 432 y 963Hz caen en el fallback m≤1 (espiral de un brazo).

  **5 hallazgos nuevos, documentados sin corregir** (criterio: impacto en vivo nulo/bajo,
  preferir reportar según instrucción explícita del usuario):
  1. Comentario desactualizado: el fallback m∈[0,1] ya no es "solo frecuencias muy bajas" — mide
     21,8% de 60-1000Hz (2054/9401 muestras), 23 bandas, la más baja desde 225,4Hz.
  2. `cymatics.js:1729-1762` — con m=0 las 3 capas de detalle de la filigrana mandala quedan en
     amplitud 0 en silencio (gate `m2>=1` nunca pasa con m2=0), dejando "bullseyes de anillos
     pelados" visiblemente más pobres a 528Hz(gota der.)/~1000Hz — confirmado visualmente, con
     salto duro 528→529Hz.
  3. El comentario de `clampVisualFreq` (`main.js:3841-3848,3872-3880`) es **falso**: afirma que
     sobre 1000Hz `lorentz()` colapsa la amplitud a 0 — el agente renderizó hasta 19999Hz y las
     gotas siguen perfectamente visibles (todos los términos con lorentz tienen piso, `rotSpeed`
     es `const () => 0`). El modo de fallo que describe el comentario ya se había eliminado en la
     auditoría 2026-09-08, ANTES de escribirse el comentario del clamp. El clamp en sí sigue
     siendo defendible (saturación de modo arriba de ~1854Hz), pero el comentario induciría a
     error a un mantenedor futuro.
  4. **Bug latente real**: `besselJArray` (`plate-field.js:646`) puede devolver NaN por
     desborde float64 en la recurrencia de Miller sin el reescalado BIGNO que exige Numerical
     Recipes §6.5 — confirmado con `_jPrimePair(56/64, 0.02)` = NaN, dentro del dominio declarado
     (`ZERO_SOLVER_M_CAP=64`). Impacto HOY: ninguno (maxM real ≤16, margen de ~84 órdenes de
     magnitud) — pero una futura capa de detalle con `m*6<=36` caería justo en el acantilado.
     Exactamente el patrón "valor fuera de rango colapsa en silencio" que se pidió buscar.
  5. `_resMul` (resolución adaptativa) puede causar que `radKey` cambie en cada frame a fps bajo
     (~1,1fps reproducido), reiniciando la construcción del patrón por tramos desde cero — en el
     peor caso reproducido, 0 construcciones completadas en 13-16 frames.

  **Riesgo abierto de ronda 2 (costo en frío ~17ms) — RESUELTO/confirmado exacto**: medido en
  vivo end-to-end sobre una página que nunca precargó el renderer: hitch único de ~60-70ms en el
  arranque (JIT + init GL coincidiendo con el primer solve), después 0,2-0,7ms/frame estacionario.
  Sin tirón perceptible al elegir una frecuencia nueva. Precalentar bajaría el frame 0 de 61 a
  18ms si se quiere atacar el backlog de TBT — no urgente.

  **Otros patrones aproximación/tabla auditados, todos limpios**: `zeroFor` (residuo ≤8,6e-15,
  0 discrepancias contra bisección independiente, 0 violaciones de monotonía), `ZP_BY_M` (peor
  diferencia 4,9e-5, dentro de su propia precisión — las 9 celdas de T8 efectivamente corregidas),
  `faradayWavenumber` (nunca auditada antes, Newton monótono, residuo ≤2,6e-12), GLSL↔CPU
  (literal del shader coincide bit a bit), `zPrimeApprox` (confirmado fuera de la ruta de
  producción).

  Código muerto detectado (menor, no corregido): slots `_rotPhase` 6/7 y el cálculo de `delta`
  que alimentaban (ya mueren en `rotSpeed=0`), `ampBeat[i]=0` fijo.

  Sin commit/push.

- Iteración 8 (T12, agente alto, reanudado una vez tras corte por límite de sesión): **completado
  y verificado por la sesión principal con `git diff` real** (no solo el reporte). Los 3
  hallazgos de T9 resultaron más profundos de lo reportado:

  **(a)** Causa raíz real: faltaba `ACCESS_NOTIFICATION_POLICY` en el manifest — esto no solo
  volvía `setBypassDnd(true)` un no-op, sino que además ocultaba a Vyneural de la lista de apps
  en la pantalla de Ajustes donde se concede el acceso a DND, dejando el botón "arreglarlo" (ya
  cableado desde v8) en un callejón sin salida. Fix: permiso agregado + el id efectivo del canal
  ahora depende del estado del acceso DND (`alarmChannelId()`: `bineural_alarms_v13` sin acceso /
  `..._v13d` con acceso) para resolver el problema de orden temporal (el canal nace en
  `onCreate`, antes de que el usuario pueda conceder el acceso a mano) sin reabrir el treadmill
  v2→v12 de bumps manuales. Extra encontrado y arreglado: ningún bump anterior borraba el canal
  viejo (`v12` seguía listado junto al nuevo) — `dropStaleAlarmChannels()` lo limpia. Verificado
  en vivo con `dumpsys notification` en ambos sentidos del toggle DND + 3 ciclos sin
  proliferación de canales.

  **(b)** Fade de pausa: `FADE_OUT=0.65` (nuevo, asimétrico) vs `FADE_IN=0.05` (histórico,
  intacto) + corte a cero exacto bajo 1 LSB. Medido con harness JVM + control (fade revertido):
  -20dB pasó de 2178ms a 117ms, silencio exacto de "nunca" a 467ms. Confirmado sin click nuevo
  (salto máx. entre muestras durante el fade ≤348 LSB, igual que en régimen estacionario).

  **(c)** Decisión tomada: liberar `AudioTrack`/hilo tras 60s de pausa sostenida
  (`IDLE_RELEASE_NS`), no mantenerlo para siempre. Guard `idleReleased` verificado en vivo
  cumpliendo la Regla de Oro en 3 formas (resume tras stop del usuario no arranca nada; resume
  sobre motor que nunca arrancó no arranca nada; stop sobre motor pausado deja la sesión no
  reanudable) — crítico porque la guardia se limpia ANTES del return temprano de `stop()`.

  **(d)** `AlarmSilenceReceiver` eliminado (clase, receiver del manifest, helpers en
  `AlarmScheduler.kt`) — confirmado sin consumidores vivos.

  **(e) NO confirmado, explícitamente**: `AndroidBridge.SCHEDULE_ALARM` efectivamente no pasa
  `localId`/`timezone`/`localTime`, pero no es un bug — `alarmId` YA ES el `localId` real (misma
  cadena de IDs confirmada entre `main.js`/`rutina.js`/backend/`AlarmReceiver.kt`), y los
  fallbacks de `timezone`/`localTime` son los correctos para una alarma creada en este
  dispositivo. Riesgo latente documentado en un comentario en el call site (la invariante
  depende de una convención entre JS y Kotlin, no de un chequeo), sin cambio de código.

  Verificación: `compileDebugKotlin`/`assembleDebug` en verde; harness JVM nuevo 32/32 PASS con
  control (sensibilidad confirmada); batería T1-T10 de la ronda anterior (T9) re-corrida contra
  el motor nuevo: 38/38 PASS, 0 regresiones. Verificado por la sesión principal: `git status`
  completo coincide exactamente con lo esperado (solo archivos de `android/` + los ya dirty de
  antes), `git diff` de `AndroidManifest.xml`/`NotificationHelper.kt` leído completo — lógica de
  `alarmChannelId()`/`dropStaleAlarmChannels()` coherente con lo descrito, sin referencias
  colgando a la constante `CHANNEL_ALARMS` vieja (grep confirma 0 matches). **Confirmación de
  seguridad explícita del agente**: no leyó contenido web/externo en toda la tarea, y verificó
  por su cuenta que `vercel.json`/`index.html`/`src/site.css` seguían limpios del incidente de
  T9 (0 coincidencias de `postyourstartup`, mtime coincide con el `git checkout` de la sesión
  principal). `versionCode` NO bumpeado a propósito (regla del proyecto: queda local hasta que
  el AAB esté vivo en Play). Riesgos menores documentados sin bloquear: `v13d` nace sin los
  ajustes manuales que el usuario pudiera tener en `v13`; `platform-capabilities.js` (web) no usa
  todavía el nuevo campo `dndAccessGranted`; `docs/APK_VALIDATION_2026-08-17.md` quedó
  desactualizado (menciona `AlarmSilenceReceiver`).

  Sin commit/push.

# Objetivo cumplido (ronda 7, fase audio/alarmas/física)
T9-T13 completas y verificadas con evidencia propia de la sesión principal (no solo reportes de
agentes), incluyendo un incidente de seguridad real (subagente rogue, revertido) y varios
hallazgos genuinos corregidos (bypass de Premium vía deep link, runaway de audio por beat=0,
permiso DND faltante, fade de pausa lento, battery drain en pausa) más varios documentados sin
tocar por ser de bajo riesgo/alcance (bug latente de Bessel, pérdida de familia de portadora en
deep link, degradación de render a fps bajo, comentarios desactualizados). Pendiente: decisión
del usuario sobre cuándo commitear/pushear/bumpear versión — nada se tocó sin pedirlo. Siguiente
prioridad: CRM.

- Iteración 6: corregida directamente (sesión principal, sin subagente) la afirmación
  desactualizada en `C:\Users\matia\CLAUDE.md` sobre `VITE_API_URL` — confirmado por lectura de
  código (`src/api/client.js:167-234`) que `nativeApiFetch()` ya rutea TODO por el bridge nativo
  cuando está presente (siempre, dentro de la APK), sin depender de `VITE_API_URL`/`API_BASE` del
  bundle web. Delegando ahora T12 (fixes Android) y T13 (auditoría física) en paralelo.

# Tareas (ronda 7, cont. 2)
- [x] T12 · Arreglar los 3 hallazgos reales de T9 + limpieza menor, todo en el mismo agente
  (mismos archivos, evitar carreras de edición): (a) `AndroidManifest.xml` — agregar
  `ACCESS_NOTIFICATION_POLICY` para que `setBypassDnd(true)` (ya en `NotificationHelper.kt`)
  deje de ser un no-op; confirmar que el canal necesita bump de versión (`v12`→`v13`) ya que
  `bypassDnd` solo se aplica al CREAR el canal, no a uno ya existente; (b)
  `BinauralToneEngine.kt` — el fade de pausa (EMA 0.05/bloque ~46ms) tarda 2,7-7,7s en apagarse de
  verdad, decidir un fade más rápido sin perder la suavidad que arregló el click original; (c) en
  pausa el motor nunca libera `AudioTrack`/hilo (bateria) — decidir si es intencional (mantener
  reloj) o liberar tras N segundos de pausa sostenida, documentar la decisión que se tome; (d)
  limpieza menor: remover `AlarmSilenceReceiver` (confirmado muerto/roto por T9, superado por
  `setTimeoutAfter`); (e) investigar el hallazgo sospechoso-no-confirmado de T9:
  `AndroidBridge.SCHEDULE_ALARM` posiblemente no pasa `localId`/`timezone`/`localTime` — confirmar
  con evidencia antes de tocar nada · agente: alto · depende de: -
- [x] T13 · Auditoría física (Cimática) con la misma mentalidad QA escéptica que audio/alarmas —
  revisar `src/core/plate-field.js`/`src/cymatics.js` (incluye los cambios ya hechos sin
  commitear de rondas 2-3: McMahon/ZP_BY_M/limpieza de filigrana muerta) buscando activamente
  fallas, no solo confirmar que los 152 tests pasan — intentar reproducir visualmente en
  navegador real casos límite (frecuencias extremas, transiciones rápidas, el caso documentado de
  "revisar en vivo 432/528/963Hz" que quedó pendiente en ronda 2) · agente: alto · depende de: -

# Tareas (ronda 7, cont.)
- [ ] T11 · Investigar y corregir por qué un deep link `?seq=` (alarma/rutina) actualiza la UI de
  rutina/panel personalizado pero no los parámetros que `BinauralEngine.start()` usa realmente
  (queda en el preset por defecto "Meditación" en vez de los valores del paso) — ver hallazgo de
  T10 arriba para el repro exacto · agente: alto · depende de: -
