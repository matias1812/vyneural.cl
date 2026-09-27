# Objetivo
Implementar en el frontend/Android el flujo "cupón activado + Google Play → mostrar código de canje" usando el nuevo endpoint backend `POST /payments/coupon/google-play-code`.

# Criterio de término
- El JS de `premium.js` llama a `/payments/coupon/google-play-code` con el plan elegido en el punto correcto del flujo (solo canal APK/Google Play, cuando hay cupón pendiente activado).
- Si `ok=true`: se muestra el código y se abre `redeem_url` de forma correcta para la app (externo, no dentro de la WebView).
- Si `ok=false`: se muestra `reason` con el mismo estilo visual que otros mensajes de error/éxito de la página.
- No dispara audio/reproducción automática (regla de oro).
- `npm run dev` (o build) no rompe, y si es posible `assembleDebug` compila.

# Tareas
- [x] T1 · Investigar patrón actual + implementar la llamada al endpoint y UI del código/error + apertura de redeem_url (premium.js, api/billing.js, android/ Kotlin si hace falta) · agente: expert · depende de: -
- [x] T2 · Verificar build (npm run build) de forma independiente y confirmar que android/ Kotlin no fue tocado · agente: worker · depende de: T1

# Registro
- Iteración 1: creado PLAN.md, arrancando T1 (investigación) delegada a expert, combinada con T2 (implementación) en un solo agente dado que la arquitectura cruza JS+Kotlin y separar investigación/implementación en dos agentes distintos perdería contexto valioso. T3 (verificación de build) se delega aparte a worker.
- Iteración 2: se encontró que PLAN.md era de una sesión anterior sin cambios reales aplicados (git diff no muestra cambios en premium.js/billing.js/android relacionados a cupones). Se resetea T1 a pendiente y se relanza como una única tarea expert (investigación + implementación), dado que no hay hallazgos previos persistidos para reusar. Se mantiene T2 (verificación) separada, delegada a worker, dependiente de T1.
- Iteración 3: T1 completó. Cambios: `src/api/billing.js` (nueva `getGooglePlayCouponCode(plan)`, mismo patrón que `verifyGooglePlayPurchase`) y `src/premium.js` (en `buyPlan()`, branch android: si `plan !== 'lifetime'` y `lastPremiumStatus.has_pending_coupon`, llama al endpoint nuevo en vez de `startPlayPurchase`; `showGooglePlayCode()` reusa `#premium-error`/`.auth-ok` igual que `cuenta.js::wireEditProfile`; el link de canje se abre por `shouldOverrideUrlLoading` ya existente en `MainActivity.kt`, sin cambios Kotlin). Revisé el diff completo yo mismo (orquestador) además del reporte del agente: lógica de gating correcta (solo Android+no-lifetime+cupón pendiente), sin disparo de audio, mismo estilo visual reusado. `npm run build` ya corrió limpio dentro de T1. Delego T2 (worker) para una verificación de build independiente antes de cerrar.
- Iteración 4: T2 completó — `npm run build` independiente OK (exit 0, sin warnings nuevos), `git diff --stat` confirma 62 líneas en 2 archivos (15 en billing.js + 47 en premium.js), y confirmación explícita de que ningún archivo `android/` (Kotlin) fue tocado. Criterio de término cumplido en su totalidad. PLAN cerrado, ambas tareas [x]. No se hizo commit (no solicitado).
