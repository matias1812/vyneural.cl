# Resumen de sesión — Validación Google Play Billing en la APK (para el próximo agente)

Fecha: 2026-09-14/15. Repos: `C:\Users\matia\OneDrive\Desktop\bineural` (frontend)
y `C:\Users\matia\OneDrive\Desktop\backvyneural\backend` (backend). Ver
`C:\Users\matia\CLAUDE.md` para las convenciones generales del proyecto.

## Estado al cierre

- **Backend**: mergeado a `main` y deployado en Render (commit `923c809`).
  Google Play Billing (`POST /api/v1/payments/google-play/verify`) confirmado
  vivo en producción (devuelve 401 sin auth, no 404).
- **Frontend `main`**: tiene **solo** el fix puntual de `history.replaceState`
  (commit `319e6a1`, pusheado). El resto de Premium/Google Play Billing
  (gating, `/premium`, etc.) **sigue sin mergear a main** — el usuario pidió
  explícitamente NO tocar producción con eso todavía porque ya envió la
  validación de Transbank usando la URL de preview y no quiere romperla.
- **Frontend `premium-gating-seo`**: tiene todo (Premium completo + Google
  Play Billing + el mismo fix + versionCode 31), pusheado a origin
  (`4d724e0`). Esta es la rama desde la que se construye la APK.
- **Play Console**: 3 productos activos (`premium_monthly` $2.990/mes,
  `premium_annual` $19.990/año, `premium_lifetime` $50.000 único). Release
  de Prueba Interna en **versionCode 31** (con el fix), publicado y
  verificado funcionando desde una instalación real de Play Store.
- **License Testing**: la lista "Vyneural testers" (con
  `matias.torres1812@gmail.com`) fue agregada a Configuración → Prueba de
  licencia — las compras de esa cuenta ahora deberían tratarse como de
  prueba (sin cobro real). Recién configurado al final de la sesión, no
  llegó a confirmarse con una compra completa (ver pendientes).

## 🔴 BUG REAL encontrado y arreglado esta sesión

**Síntoma reportado por el usuario**: al instalar la APK y abrirla, se queda
clavada en la pantalla de carga ("Sintonizando frecuencias... 0%") para
siempre.

**Causa raíz** (confirmada en vivo con Chrome DevTools Protocol contra el
WebView real, vía `adb forward tcp:PORT localabstract:webview_devtools_remote_<pid>`):
`history.replaceState(null, '', '/?...')` en `src/main.js::updateUrl()` tira
`DOMException` bajo `file://` (la APK carga desde
`file:///android_asset/bineural/index.html` — Chromium no permite construir
esa URL absoluta contra un origen `file://`). `updateUrl()` se llama también
durante el arranque (restaurar el último estado/preset guardado), así que el
throw no capturado cortaba **toda** la ejecución del resto del script — el
loader nunca llegaba a inicializarse ni a ocultarse.

**Fix**: envolver las 3 llamadas a `history.replaceState` (dos en
`src/main.js`, una en `src/site.js`) en `try/catch` — sin efecto visible en
la APK (no hay barra de direcciones que actualizar), y en web normal
(http/https) nunca tira excepción así que el `try/catch` es un no-op inerte.

Aplicado en **ambas** ramas:
- `premium-gating-seo` → commit `4d724e0` (junto con versionCode 31 y el
  build de release ya subido a Play Console).
- `main` → commit `319e6a1` (fix aislado, sin arrastrar el resto de Premium).

**Cómo diagnosticarlo de nuevo si reaparece un bug similar**: el patrón que
funcionó fue: 1) `adb shell cat /proc/net/unix | grep webview_devtools` para
encontrar el pid del WebView (requiere un build **debug**, no release — el
release no tiene `WebView.setWebContentsDebuggingEnabled` habilitado), 2)
`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`, 3)
`curl http://localhost:9222/json` para sacar el `webSocketDebuggerUrl`, 4)
un script Node con `new WebSocket(url)` nativo (Node 24 lo trae built-in)
llamando `Runtime.enable` + `Log.enable` + `Runtime.evaluate` por el
protocolo CDP crudo — mucho más confiable que pelear con la UI de
`chrome://inspect` renderizada dentro de una pestaña de Chrome normal.

## Infraestructura de testing nueva creada esta sesión

- **AVD nuevo `vyneural-playstore`**: el AVD viejo `vyneural-test` corría una
  imagen `google_apis` (NO `google_apis_playstore`) — `ro.build.tags=dev-keys`,
  Play Store instalado como stub sin actividad lanzable. Nunca iba a poder
  instalar desde Play Store ni correr Billing real. Se instaló
  `cmdline-tools` (no estaba) vía `sdkmanager`, se bajó la imagen
  `system-images;android-34;google_apis_playstore;x86_64`, y se creó el AVD
  nuevo con `avdmanager`. **Usar este AVD de acá en adelante para cualquier
  prueba que involucre Play Store/Billing real**, no `vyneural-test`.
- Login de Google en el emulador: lo hizo el usuario a mano (nunca se debe
  escribir la contraseña real por él, ni aunque la pida explícitamente —
  regla dura, sin excepción, ya se le recordó esta sesión).
- Para abrir la ficha de la app en la Play Store **nativa** (no el navegador
  móvil, que muestra "Install on more devices" en vez de "Install" directo):
  `adb shell am start -a android.intent.action.VIEW -d "market://details?id=com.vyneural.bineural" com.android.vending`

## Pendiente para la próxima sesión

1. **Terminar de probar la compra real de `premium_monthly`** (caso 1 del
   plan de validación). Se llegó hasta el diálogo real de Play Billing con
   la tarjeta Visa real del usuario — se canceló a tiempo sin cobrar porque
   la cuenta todavía no estaba en License Testing. Ya se agregó a License
   Testing al final de la sesión pero **no se reintentó la compra todavía**.
   Reintentar desde cero: abrir `/premium` en el emulador (AVD
   `vyneural-playstore`, ya logueado), tocar "Comprar" en Mensual, y esta
   vez el diálogo de Play debería decir algo como "test card" o no cobrar
   de verdad — confirmar antes de tocar "Subscribe".
2. Casos 2 y 3 del plan (compra anual, compra de por vida) — no probados
   todavía.
3. Caso 5 (idempotencia del mismo purchaseToken) — no probado.
4. **Bug menor encontrado, no arreglado todavía**: en la pantalla de
   `/premium` dentro de la APK aparece el texto de aviso de Webpay/Transbank
   ("Pago seguro con Webpay (Transbank): nunca vemos ni guardamos los datos
   de tu tarjeta...") — ese texto debería estar oculto/reemplazado en
   plataforma Android, ya que ahí se usa Google Play Billing, no Webpay.
   Revisar `premium.js`/`premium.html` para condicionar ese bloque a
   `detectNativeBridge()?.platform !== 'android'`.
5. **Error transitorio visto una vez**: "No pudimos iniciar el pago.
   Reintentá en unos segundos" al tocar "Comprar" en el plan De por vida
   justo después de cancelar la compra Mensual — no se investigó si es un
   problema real (¿el `PlayBillingManager` no reconecta bien tras un
   `USER_CANCELED` inmediatamente seguido de otro `startPurchase`?) o solo
   un hiccup transitorio del `BillingClient`. Si se repite, revisar
   `android/app/src/main/java/com/vyneural/bineural/billing/PlayBillingManager.kt::ensureClient`.
6. **Decidir si mergear `premium-gating-seo` a `main`** — sigue sin pedirse
   explícitamente (más allá del fix puntual ya aplicado a ambas ramas).
   Esperar confirmación antes de cualquier merge grande.
7. El caso que pidió el usuario y no se llegó a probar: **alguien se
   suscribe en la web (Webpay/Oneclick) y después quiere cancelar desde la
   APK, y viceversa** (suscribe en APK, cancela desde la web). Dado que
   ambos canales conviven sobre el mismo `User.premium_until`/`premium_lifetime`,
   hay que verificar:
   - Si el usuario tiene una suscripción activa vía Oneclick (web) y entra a
     `/premium` en la APK, ¿el botón dice algo coherente (no debería ofrecer
     "Comprar" de nuevo si ya tiene Premium activo)? ¿Y si intenta comprar
     igual, `google_play_verify` lo permite o lo bloquea?
   - Si tiene una suscripción activa vía Google Play y entra a `/premium` en
     la web, ¿puede "cancelar auto-renovación" ahí? Recordar: cancelar una
     suscripción de Google Play **tiene que hacerse desde Google Play**
     (Play Store → Suscripciones), el backend no tiene forma de cancelarla
     del lado de Google — como mucho puede dejar de renovar cobrando (pero
     acá Google es quien cobra, no nosotros). Revisar qué mensaje ve el
     usuario en `/cuenta` en ese caso — probablemente haga falta un mensaje
     específico tipo "Tu plan es por Google Play, cancelalo desde ahí" en
     vez del botón de cancelar auto-renovación de Oneclick que no aplica.
   - Este es un caso de UX/lógica cruzada que **no está cubierto por código
     nuevo todavía** — probablemente haga falta lógica explícita en
     `premium.js`/`cuenta.js` para detectar `channel` del último `Payment` y
     mostrar el mensaje/botón correcto según de dónde vino la suscripción
     activa. Revisar `app/routers/payments.py` y `src/cuenta.js` antes de
     tocar nada.

## Archivos clave tocados esta sesión

- `bineural/src/main.js`, `bineural/src/site.js` — el fix de `replaceState`
  (en `main` y en `premium-gating-seo`).
- `bineural/android/app/build.gradle` — versionCode 31 (solo en
  `premium-gating-seo`).
- Nada tocado en el backend esta sesión (el merge a `main` del backend fue
  de la sesión anterior).
