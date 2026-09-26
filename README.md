# 🎧 Vyneural · Ondas binaurales

![Estado](https://img.shields.io/badge/estado-production--ready-8b5cf6)
![Tests](https://img.shields.io/badge/tests-113%20passed-4ade80)
![Build](https://img.shields.io/badge/build-Vite%206-38bdf8)
![Plataformas](https://img.shields.io/badge/plataformas-Web%20·%20PWA%20·%20APK-22d3ee)

Generador de **ondas binaurales en tiempo real** para meditación, sueño,
relajación y concentración. 31 estados de frecuencia, 6 ambientes sintetizados
en vivo, dos visualizadores independientes (cimática WebGL y ondas de agua) y
una **APK Android offline** con motor de audio nativo.

> **Principio rector** (Plan Maestro Científico): ninguna metáfora visual se
> presenta como afirmación neurocientífica. Toda variable del pipeline tiene
> una clase de dominio (`PHYSICAL | NEURAL | PSYCHOLOGICAL | VISUAL | EMPIRICAL |
> HEURISTIC`) y una etiqueta de honestidad (`MEASURED | SIMULATED | DERIVED |
> ESTIMATED | HEURISTIC`). El aviso médico es parte del producto, no letra
> chica.

---

## Características

- **31 estados de frecuencia** por objetivo (Dormir, Meditar, Relajarse, Concentrarse, Aprender, Especiales), incluidos gamma experimental de alta frecuencia (60 y 100 Hz) y armónicas de Schumann — cada uno con nivel de evidencia honesto.
- **Generador personalizado**: portadora (60–400 Hz), ritmo (0.5–40 Hz), forma de onda (senoidal/triangular/diente de sierra/cuadrada) y condición experimental (binaural, tono puro, ruido, AM, control) con guardado en la cuenta.
- **6 ambientes** sintetizados en vivo (lluvia, río, bosque, pájaros, océano, fuego) con mezclador, sincronizados con el latido.
- **Motor de audio limpio**: fades sin clics (piso + rampa), fase continua, teardown síncrono de fuentes, watchdog que recupera una sesión muda sin interrumpir.
- **Permanencia**: en la APK, un *foreground service* con MediaSession mantiene el audio con pantalla bloqueada y controles en lock screen/auriculares (skip/seek = ±10 Hz con retune real).
- **Cuentas opcionales** (aditivo, nunca bloquea el generador): sincronización de favoritos y frecuencias. La app funciona 100% local sin backend. Excepción: **`/rutina`** (itinerarios + recordatorios) sí exige cuenta — viven en la nube, no localmente.
- **Rutina unificada**: itinerarios con pasos, horario acumulado y botón "Iniciar" que profundiza al generador **sin autoplay**; la repetición semanal con alarma real es exclusiva de la APK.
- **PWA instalable** (manifest + service worker) y **APK Android offline** con el bundle embebido.
- **Privacidad y seguridad por diseño**: sanitización auditada, ISO 27001 (Anexo A) documentado, cero dependencias de tracking salvo Vercel Analytics opcional.

---

## Inicio rápido

```bash
npm install        # dependencias (solo vite + vercel analytics)
npm run dev        # servidor de desarrollo → http://localhost:5173
npm run build      # build de producción multi-página → dist/
npm run preview    # servir el build localmente
npm test           # suite de validación (113 tests, headless Node)
```

La misma suite corre en el navegador con `window.runBineuralDiagnostics()`
desde la consola.

### Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `VITE_PROXY_TARGET` | `http://127.0.0.1:8000` | Destino del proxy `/api` en dev (backend FastAPI) |

### Estructura

```
├── index.html y *.html        → 20+ páginas (generador, cuenta, rutina, FAQ, diagnóstico…)
├── src/
│   ├── main.js                → orquestador del generador (estados, audio, visualizadores)
│   ├── audio.js               → motor binaural Web Audio API (clicks-free, watchdog)
│   ├── ambient.js             → 6 ambientes sintetizados en vivo
│   ├── cymatics.js / wavefield.js / starfield.js → visualizadores (WebGL2→WebGL1→CPU)
│   ├── core/                  → alarm-manager, audio-clock (reloj maestro), audio-transport
│   ├── api/                   → client (caché TTL + dedup), auth, favorites, frequencies,
│   │                            itineraries, alarms, push, sync, integration
│   ├── ui/                    → auth (login/registro/verificación/recuperación), freq-modal
│   ├── models/                → perfiles científicos de los 31 estados (profiles.js)
│   ├── platform/              → puente con la APK (bridge, eventos vyneural:*)
│   └── validation/            → suite de validación científica
├── public/                    → PWA (sw.js, manifest), sitemap, vyneural.apk (descarga)
├── android/                   → proyecto Android (APK offline, motor Kotlin nativo)
├── docs/                      → arquitectura, modelo científico, validación, ISO 27001…
└── scripts/run-diagnostics.mjs → runner de tests headless (113)
```

---

## Arquitectura

```
┌──────────── Web / PWA ────────────┐   ┌──────────── APK (Android) ────────────┐
│  Estado → BinauralEngine (WebAudio)│   │  WebView (mismo bundle, sin sonido:    │
│  · fades sin clics, fase continua  │   │  _platformMuted)                       │
│  · 2 osciladores L/R (Δf = latido) │   │  └─ BinauralToneEngine (Kotlin) ────── │
│  Visualizadores (WebGL/Canvas)     │   │     · AudioTrack streaming 44.1 kHz    │
│  Alarmas locales (IndexedDB)       │   │     · fase continua, rampas suaves     │
│  Caché API (TTL 8 s + dedup)       │   │  AudioForegroundService (MEDIA_PLAYBACK)│
└──────────────┬─────────────────────┘   │  · sobrevive al bloqueo de pantalla    │
               │ API (opcional, aditiva) │  MediaSession (lock screen, BT)        │
┌──────────────▼─────────────────────┐   │  · skip/seek = ±10 Hz, evento al JS    │
│  Backend FastAPI (backvyneural)    │   └────────────────────────────────────────┘
│  auth · sincronización · push      │
└────────────────────────────────────┘
```

El **backend nunca inicia audio** — solo identidad, datos y notificaciones.
La reproducción nace siempre de un gesto del usuario (y un restart del proceso
nativo nunca reanuda por sí solo: `START_NOT_STICKY` + `NO_AUTO_PLAY`).

---

## Audio: limpieza y permanencia

El motor está diseñado para **sonar bien y no cortarse**:

- **Limpieza auditiva**: senos con fase continua (sin clicks en el punto de
  unión), cambios de frecuencia con rampa suave, fades de entrada/salida con
  piso de ganancia, teardown síncrono (nunca coexisten dos sets de fuentes),
  compresor suave contra saturación y watchdog que detecta una sesión "en play
  pero muda" y la recupera sin clics. En la APK: 44.1 kHz / PCM 16-bit estéreo,
  retune con rampa por bloque, duck por audio focus.
- **Permanencia**: la APK usa un *foreground service* con
  `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK` (no lo mata el bloqueo de pantalla),
  MediaSession real conectada a lock screen/notificaciones/auriculares y un
  watchdog de audio focus que re-solicita con backoff y reanuda el **mismo**
  motor (nunca una segunda sesión).
- **Sin interferencias**: si otra app toma el foco, el motor baja (duck) o
  pausa y se recupera solo; en la APK el WebView está permanentemente mudo
  (`_platformMuted`), así que solo hay un dueño del audio: el servicio nativo.
  Toda la actividad queda en un log forense (`Diagnostics` + `/diagnostico`).

---

## Cuentas, sincronización y seguridad

- Flujo completo de cuentas: registro con **contraseña doble + términos**,
  verificación de correo (token 24 h), recuperación (token 30 min), cambio de
  contraseña con re-autenticación que cierra las otras sesiones. Documentado en
  [`docs/accounts.md`](docs/accounts.md).
- Caché de API con **TTL e invalidación tras mutaciones** + dedup de llamadas
  en vuelo (menos peticiones al backend en cada navegación).
- Sanitización auditada: todo dato de usuario va por `escapeHtml`/`textContent`.
- Auditoría de seguridad **ISO/IEC 27001** (Anexo A) con checklist de cierre
  para producción: [`docs/seguridad-iso27001.md`](docs/seguridad-iso27001.md).

---

## Build de la APK (Android)

La APK empaqueta el build web (`dist/`) en `android/app/src/main/assets/bineural/`
y corre offline con un motor nativo (Kotlin) para el audio. Requiere **JDK 17**
(Gradle 8.2 no soporta Java 25; el JBR de Android Studio es Java 25 y falla al
recompilar el build script):

```bash
# JDK 17 portable (dentro del repo, ignorado por git):
#   curl -sL -o android/.jdk17/jdk17.zip \
#     "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse"
#   cd android/.jdk17 && unzip jdk17.zip

npm run build
rm -rf android/app/src/main/assets/bineural && mkdir -p android/app/src/main/assets/bineural
(cd dist && tar cf - --exclude='*.apk' . | (cd ../android/app/src/main/assets/bineural && tar xf -))

cd android && JAVA_HOME="<ruta>/android/.jdk17/jdk-17.0.20+8" ./gradlew assembleRelease
# release firmada → app/build/outputs/apk/release/app-release.apk
# La app NO se distribuye por descarga directa desde la web (ver /descargar,
# que hoy es solo un anuncio de "próximamente en Google Play"): no hay que
# copiar el .apk a public/ ni re-buildear el sitio por esto. Para probarla en
# un dispositivo/emulador: adb install -r app/build/outputs/apk/release/app-release.apk
```

La release requiere firma: keystore y credenciales en `android/local.properties`
(gitignored) o variables `BINEURAL_STORE_*`. Compilar con JDK 17:
`JAVA_HOME=<ruta>.jdk17/jdk-17.0.20+8 ./gradlew assembleRelease`.

---

## Testing

```bash
npm test        # 113 tests de validación (modelo científico, audio, alarmas, UI)
```

Cobertura: pipeline científico (estímulo → auditivo → neural → EEG → cognitivo
→ visual), reproducción/condiciones experimentales, alarmas locales, flujos de
cuenta (frontend), modales y páginas. El backend tiene su propia suite (92
tests, incluidos los recordatorios por Web Push) en el repo
[`vyneural-backend`](https://github.com/matias1812/vyneural-backend).

---

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Arquitectura y flujo de datos del pipeline |
| [`docs/audit.md`](docs/audit.md) | Auditoría baseline (Fase 0) |
| [`docs/scientific-model.md`](docs/scientific-model.md) | Ecuaciones, parámetros y clasificación de cada modelo |
| [`docs/validation.md`](docs/validation.md) | Suite de validación, checklist de integridad y resultados |
| [`docs/development.md`](docs/development.md) | Flujo de desarrollo, estructura del repo, despliegue |
| [`docs/accounts.md`](docs/accounts.md) | Cuentas, verificación de correo, recuperación y sincronización |
| [`docs/seguridad-iso27001.md`](docs/seguridad-iso27001.md) | Auditoría de seguridad ISO/IEC 27001 (Anexo A) |
| [`docs/android-roadmap.md`](docs/android-roadmap.md) | Hoja de ruta de la APK (nativo, audio, MediaSession) |
| [`docs/MVP_LAUNCH.md`](docs/MVP_LAUNCH.md) | Plan de lanzamiento del MVP |
| [`docs/HARDWARE_TEST_PLAN.md`](docs/HARDWARE_TEST_PLAN.md) | Plan de testeo físico (audio, alarmas, MediaSession) |

---

## Estado del plan maestro

- ✅ Pipeline científico (P1–P9) · Experimental Mode (P10) · Suite de
  validación (P11) · Reproducibilidad (P12) · HUD científico con honestidad
  (P14/P17)
- ✅ Cuentas y verificación · Rutina/itinerarios · Web Push · APK con audio
  nativo y alarma real · ISO 27001
- ⏳ **Pendiente**: perfiles de rendimiento (P13), auditoría de páginas
  públicas (P18), cierre de la checklist de seguridad para producción.

## Repos

- **Este repo** (`vyneural.cl`): web/PWA + APK.
- [`vyneural-backend`](https://github.com/matias1812/vyneural-backend): API
  FastAPI (identidad, sincronización, push).

---

> ⚠️ **Aviso médico**: las ondas binaurales son una herramienta de relajación.
> No sustituyen atención ni tratamiento médico. Usá auriculares y un volumen
> seguro; no las uses mientras conduces o manejas maquinaria.
