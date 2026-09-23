# Checklist de lanzamiento en Google Play

Mismo espíritu que `docs/DATA_SAFETY_PLAY_CONSOLE.md`: un resumen accionable
para completar el envío real en Play Console, basado en el estado real del
repo a esta fecha (2026-09-22). Nada de esto reemplaza revisar la consola
directamente — algunas cosas (qué versionCode quedó subido a qué pista,
por ejemplo) no se pueden confirmar desde el código.

## Ya listo

- `applicationId` (`com.vyneural.bineural`), versionado (`versionCode 39` /
  `versionName 1.7.7`) y firma de release ya correctamente configurados y
  usados en releases anteriores (ver `android/app/build.gradle` y el proceso
  documentado en `C:\Users\matia\CLAUDE.md`).
- Sin permisos de ubicación en ningún lado — no aplica "Prominent
  Disclosure".
- `SCHEDULE_EXACT_ALARM` y `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (los dos
  permisos sensibles que sí requieren declaración en Play Console) ya tienen
  el texto de justificación redactado en `docs/DATA_SAFETY_PLAY_CONSOLE.md`.
- Formulario de Data Safety ya redactado por completo en
  `docs/DATA_SAFETY_PLAY_CONSOLE.md`, incluida la respuesta sobre borrado de
  cuenta/datos.
- `/privacidad` existe, es indexable (`robots: index, follow`) y no está
  bloqueada por `vercel.json` ni por ningún `robots.txt`.
- Play Console ya tiene 3 productos configurados (`premium_monthly`
  $2.990, `premium_annual` $19.990, `premium_lifetime` $50.000) y una pista
  de Internal Testing usada al menos hasta `versionCode 31`, con una compra
  real verificada (ver `docs/SESION_2026-09-15_APK_BILLING_VALIDACION.md`).
- El bug de doble suscripción cruzada (Google Play + Oneclick en paralelo) y
  el de dedup de notificaciones (AlarmManager vs FCM) — los dos hallazgos
  más graves de esta ronda de validación — ya están arreglados y verificados
  (ver commits de esta tanda).

## Falta antes de enviar

- **Confirmar en la consola** (no se puede ver desde el repo) si los builds
  entre `versionCode 31` y el actual `39` se subieron a alguna pista de
  prueba — la última confirmación documentada es del 2026-09-15, con
  `versionCode 31`.
- Cargar el formulario de Data Safety en la consola real, usando
  `docs/DATA_SAFETY_PLAY_CONSOLE.md` como fuente.
- Completar el cuestionario IARC de clasificación de contenido y la
  declaración de audiencia objetivo — no existe ningún borrador todavía en
  el repo.
- Definir cómo responder la política de contenido de salud de Play, dado que
  `descargar.html` autodeclara `"applicationCategory": "HealthApplication"`
  en su JSON-LD.
- Crear el feature graphic (1024×500) para la ficha de Play Store — no
  existe en el repo.
- Verificar/producir el ícono de alta resolución (512×512) conforme al spec
  de Play (existe `public/icons/icon-512.png` del PWA, con las dimensiones
  correctas pero sin verificar contra el spec específico de Play).
- Producir capturas de pantalla para la ficha de Play Store — no existen en
  el repo.
- Compilar una AAB de release nueva que incluya el fix de dedup nativo
  (Issue 9 de esta tanda, Kotlin) antes de subir a cualquier pista de Play.

## Decisiones pendientes del usuario (no son tareas de código)

- **`descargar.html`**: sigue marketeando explícitamente "fuera de Google
  Play (instalación directa)" con instrucciones para saltar la advertencia
  de Play Protect. Una vez que la ficha de Play esté publicada, hay que
  decidir si conviven ambos canales (con copy actualizado) o si se
  deprecia/desenfatiza el sideload.
- **`aviso-medico.html`**: sigue autodeclarado "Borrador — en revisión".
  Dado el escrutinio de Play a apps de bienestar/salud, hay que decidir si
  necesita una revisión de alguien con formación en salud antes de enviar,
  o si el contenido actual (conservador, con lista de condiciones que
  ameritan consultar a un médico) alcanza para un primer envío.
