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
