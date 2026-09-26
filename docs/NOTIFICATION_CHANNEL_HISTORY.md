# Historial del canal de alarmas (`NotificationHelper.CHANNEL_ALARMS`)

Historial completo de los bumps de ID del canal de notificaciones de alarma, movido
aquí desde el comentario inline en `NotificationHelper.kt` (que se condensó porque la
mayoría de estas entradas documentan una teoría ya invalidada — ver v12 más abajo — y
no explican el comportamiento actual). Se conserva por si algún síntoma parecido
vuelve a aparecer y hace falta el contexto completo.

Android trata los atributos de un `NotificationChannel` (importancia, sonido,
vibración, bypass de DND) como **inmutables una vez creado**: `createNotificationChannel()`
sobre un ID existente es un no-op si ya existe, así que la única forma de que un
dispositivo con una instalación vieja reciba una config nueva es mintar un ID nuevo.
De ahí el patrón de "v2, v3, v4… bump" en cada entrada.

- **v2**: se agregó vibración — bump para que instalaciones existentes reciban el
  canal nuevo (con vibración) en vez de heredar el viejo sin ella.
- **v3**: la alarma pasó a sonar con el ringtone de ALARMA del sistema
  (`USAGE_ALARM`), no el sonido de notificación genérico — bump para que las
  instalaciones existentes reciban el canal con sonido de alarma real.
- **v4**: reportado en vivo que una alarma disparó solo la notificación, sin sonido
  ni vibración — un teléfono con `bineural_alarms_v3` ya creado (de una build de
  prueba anterior) seguía con la config vieja de ese canal para siempre
  (`createNotificationChannel()` no reconfigura un canal existente). Bump para que
  todas las instalaciones (nuevas y viejas) recibieran la config actual desde cero.
- **v5**: mismo síntoma reportado otra vez — el teléfono de prueba había instalado
  varias builds de esa sesión antes de este archivo, así que "v4" quedó fijado con
  lo que fuera que tenía en ese momento.
- **v6**: confirmado en un dispositivo con instalación fresca del v5 que ni siquiera
  el botón "Probar notificación" (dispara al toque, sin scheduling de por medio)
  sonaba/vibraba. Causa real esta vez: `RingtoneManager.getDefaultUri()` puede
  devolver `null` (tono de alarma en "Silencio"), y `setSound(null, attrs)` apaga el
  sonido del canal a propósito — se agregó un 3er fallback. Bump para que el canal
  se creara de cero con ese fallback ya aplicado.
- **v7**: los diagnósticos de `/diagnostico` (`alarmChannelDiagnostics`,
  `AndroidBridge.kt`) mostraron la causa real en el dispositivo que seguía
  reportando "llega pero no suena ni vibra": el canal v6 (creado con
  `IMPORTANCE_HIGH` por código) terminó en `IMPORTANCE_LOW` — teoría en ese momento:
  Android puede bajar la importancia de un canal por su cuenta si el usuario
  descarta varias notificaciones de esa app sin abrirlas (comportamiento adaptativo
  de Android 12+), y esa sesión pasó varias builds probando/descartando
  notificaciones de prueba en ese mismo canal. Bump a v7 para que el canal naciera
  de cero en `IMPORTANCE_HIGH` otra vez.
- **v8**: reportado otra vez "llega pero a veces sin alarma" después de v7 — esta
  vez el hueco no era importancia ni sonido nulo, sino que el canal nunca pedía
  bypassear No Molestar (`setBypassDnd(true)`, sigue vigente hoy). Bump para que
  los teléfonos que ya tenían v7 lo recibieran.
- **v9**: mismo síntoma reportado otra vez en vivo (llega pero no despliega
  heads-up, sin sonido ni vibración) después de v8 — consistente con la teoría v7
  de degradación por descartes repetidos durante testing. Bump para que naciera de
  cero en `IMPORTANCE_HIGH` otra vez. Como esto podía volver a pasar con uso normal
  (no solo testing), se agregó detección de importancia degradada en la UI
  (`permissions-modal.js`/`main.js`) en vez de depender de otro bump manual.
- **v10**: primera prueba real post-Play (v1.7.8, instalado desde la consola, no
  por adb) reportó el mismo síntoma — pero la sospecha principal esa vez era que el
  push nunca llegó por FCM en absoluto (posible `FIREBASE_CREDENTIALS_JSON` sin
  configurar en Render) y cayó al fallback de Web Push, que nunca pasa por este
  canal. El bump se hizo por las dudas, pero no reemplazaba confirmar si FCM estaba
  configurado en producción.
- **v11 (2026-09-23)**: confirmado en vivo por logcat (`logChannelState`) que v10 ya
  estaba en `importance=2` (LOW), degradado durante las mismas rondas de testing de
  esa sesión (crear/descartar notificaciones de prueba repetidamente) — mismo
  patrón que v6/v7/v8/v9.
- **v12 (2026-09-24) — el hallazgo que invalida la teoría de v3→v11**: mismo
  síntoma reportado apenas se activaron los permisos ("llega la notificación pero
  desapercibida y sin alarma"), confirmado en vivo por `adb shell dumpsys
  notification --noredact` (no logcat esta vez, directo el estado real): `mImportance=2`
  (LOW), `mOriginalImp=4`, degradado **instantáneamente al conceder el permiso**,
  **antes de que se mostrara o descartara una sola notificación**. Esto invalida la
  teoría "Android baja la importancia por descartes repetidos" para esta clase de
  dispositivo (confirmado en un Honor/Magic OS) — bumpear el ID otra vez (v13, v14…)
  no lo va a arreglar ahí. El único lever real es pedir el permiso lo antes posible
  y ofrecer el arreglo de un toque (`Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS`)
  de inmediato — eso es lo que implementa `MainActivity.onRequestPermissionsResult`
  hoy (Fase K, 2026-09-24) junto con `channelDegraded()`.

Ver también [[vyneural-session-2026-09-24-campana-notifs-round2]] (memoria de la
sesión que produjo el hallazgo v12) y `src/ui/degraded-alarm-banner.js`, que cubre
la misma señal fuera del momento inmediato de conceder el permiso.
