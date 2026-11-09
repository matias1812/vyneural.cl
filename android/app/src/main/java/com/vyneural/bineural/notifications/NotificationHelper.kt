package com.vyneural.bineural.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.vyneural.bineural.MainActivity
import com.vyneural.bineural.R
import com.vyneural.bineural.audio.AudioForegroundService

/**
 * Notificaciones Android REALES (P1). No dependen de que el JavaScript de la
 * WebView siga vivo: el canal, el PendingIntent y el poster son 100 % nativos.
 */
object NotificationHelper {

    const val CHANNEL_PLAYER = "bineural_player"
    // Los canales de notificación son inmutables una vez creados por Android
    // (createNotificationChannel() es un no-op sobre un ID existente), así
    // que cada vez que hizo falta cambiar su config (sonido, vibración,
    // importancia, bypass de DND) hubo que mintar un ID nuevo — de ahí el
    // historial v2→v12 de este canal. Historia completa, dispositivo por
    // dispositivo: docs/NOTIFICATION_CHANNEL_HISTORY.md. Dos hallazgos de
    // ese historial siguen vigentes hoy:
    // - v8: el canal necesita bypassear No Molestar (setBypassDnd(true)
    //   abajo) para una alarma real — no alcanza con importancia/sonido.
    // - v12 (2026-09-24, Honor/Magic OS): `adb shell dumpsys notification`
    //   mostró la importancia cayendo a LOW INSTANTÁNEAMENTE al conceder el
    //   permiso, antes de mostrarse una sola notificación — esto invalida la
    //   teoría v3→v11 de "Android la baja por descartes repetidos" para esta
    //   clase de dispositivo. Bumpear el ID de nuevo (v13, v14…) NO arregla
    //   esto ahí; el lever real es channelDegraded() + el diálogo nativo de
    //   MainActivity.onRequestPermissionsResult que ofrece el arreglo de un
    //   toque apenas se concede el permiso. (Ojo: ese hallazgo es sobre la
    //   IMPORTANCIA. El bump a v13 de abajo es por otra cosa — bypassDnd — y
    //   ahí sí el id nuevo es la única salida.)
    // v13 (2026-11-08): el bump es OBLIGATORIO acá, no cosmético — hasta esta
    // versión el manifest nunca declaró ACCESS_NOTIFICATION_POLICY, así que
    // Android descartaba el setBypassDnd(true) de abajo y el canal v12 quedó
    // creado con mBypassDnd=false en TODOS los dispositivos (confirmado con
    // `adb shell dumpsys notification`). Como bypassDnd solo se aplica al
    // CREAR el canal, el v12 ya existente no se arregla ni declarando ahora el
    // permiso: hay que mintar un id nuevo.
    private const val CHANNEL_ALARMS_BASE = "bineural_alarms_v13"
    // ...y el bump solo no alcanza: el usuario concede el acceso a No Molestar
    // A MANO y casi siempre DESPUÉS de que el canal ya nació (el v13 se crea en
    // MainActivity.onCreate, mucho antes de que alguien toque el botón de la
    // campana). Si el id fuera una constante, el canal nacería otra vez con
    // bypassDnd=false y el próximo arreglo sería un v14 — exactamente el
    // treadmill v2→v12 de este archivo. Por eso el id EFECTIVO depende del
    // estado del acceso a DND: hay como máximo DOS ids (sin acceso / con
    // acceso) y cada uno nace con el bypass que Android de verdad le va a
    // aplicar. Cuando el usuario concede el acceso, el id cambia a la variante
    // "d" y ESE canal sí nace con mBypassDnd=true, sin pedirle nada más.
    private const val CHANNEL_ALARMS_DND = "${CHANNEL_ALARMS_BASE}d"
    /** Prefijo común de TODA la familia de canales de alarma, incluidos los
     *  históricos (`bineural_alarms`, `bineural_alarms_v2`…`_v12`) y los
     *  personalizados por sonido/vibración. Lo usa dropStaleAlarmChannels para
     *  limpiar los que quedaron de versiones anteriores. Ojo: `bineural_player`
     *  / `bineural_reminders` / etc. NO caen bajo este prefijo. */
    private const val ALARM_CHANNEL_FAMILY = "bineural_alarms"
    private const val CHANNEL_REMINDERS = "bineural_reminders"
    // M1 — canal de fin de sesión: IMPORTANCE_DEFAULT (sonido suave, sin
    // vibración) para avisar que el temporizador terminó. Canal propio para
    // no mezclarse con el reproductor ni con las alarmas.
    const val CHANNEL_SESSION_END = "bineural_session_end"
    // Chat de soporte 1:1 con el admin — importancia default, sin bypass de
    // DND (no es una alarma), canal propio para no mezclarlo con el fin de sesión.
    const val CHANNEL_SUPPORT_CHAT = "bineural_support_chat"
    private const val NOTIF_PLAYER = 1001
    private const val NOTIF_ALARM = 2001
    private const val NOTIF_SESSION_END = 2002
    private const val NOTIF_SUPPORT_CHAT = 2003

    /** ¿El usuario concedió el acceso a la política de No Molestar? Es un
     *  "special app access" (Ajustes → Apps → Acceso a No molestar), NO un
     *  runtime permission: no hay diálogo que la app pueda mostrar, solo el
     *  intent a la pantalla de Ajustes (AndroidBridge::OPEN_DND_ACCESS_SETTINGS,
     *  ya cableado al botón de la campana). El manifest tiene que declarar
     *  ACCESS_NOTIFICATION_POLICY para que la app siquiera APAREZCA en esa
     *  lista — ver AndroidManifest.xml. Sin este acceso, setBypassDnd(true) es
     *  un no-op silencioso. */
    fun dndAccessGranted(context: Context): Boolean = runCatching {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.isNotificationPolicyAccessGranted
    }.getOrDefault(false)

    /** Id EFECTIVO del canal de alarmas por defecto (ver CHANNEL_ALARMS_DND).
     *  Única fuente de verdad: nadie debe volver a hardcodear el literal ni
     *  guardarse el valor — cambia cuando el usuario concede/revoca el acceso
     *  a No Molestar. */
    fun alarmChannelId(context: Context): String =
        if (dndAccessGranted(context)) CHANNEL_ALARMS_DND else CHANNEL_ALARMS_BASE

    /** Borra todo canal de la familia de alarmas que NO sea el vigente: la
     *  variante del otro lado del acceso a DND, los canales personalizados
     *  derivados de ella (ver channelFor) y los canales de versiones viejas
     *  (v2…v12).
     *
     *  Confirmado en vivo (`adb shell dumpsys notification`, 2026-11-09): tras
     *  actualizar, el `bineural_alarms_v12` seguía ahí al lado del canal nuevo
     *  — ningún bump anterior borró el que dejaba atrás, así que en un teléfono
     *  que vivió v2→v12 el usuario ve una lista de "Alarmas Vyneural" idénticas
     *  en los ajustes del sistema y no puede saber cuál manda (y si toca la
     *  equivocada para subir la Importancia, no arregla nada). Los canales
     *  viejos están muertos: nadie publica en ellos.
     *
     *  Recrear un canal borrado restaura su config anterior (Android la
     *  conserva a propósito), así que esto es reversible y estable si el acceso
     *  a DND se revoca y se vuelve a conceder. */
    private fun dropStaleAlarmChannels(nm: NotificationManager, activeId: String) {
        // El "_" final importa: los ids de las dos variantes se diferencian por
        // la "d", así que "${activeId}_" nunca matchea la otra variante — solo
        // los personalizados derivados de la ACTIVA, que son los que hay que
        // conservar.
        val keepPrefix = "${activeId}_"
        runCatching {
            for (ch in nm.notificationChannels) {
                if (!ch.id.startsWith(ALARM_CHANNEL_FAMILY)) continue
                if (ch.id == activeId || ch.id.startsWith(keepPrefix)) continue
                nm.deleteNotificationChannel(ch.id)
                com.vyneural.bineural.util.BineuralLog.d(
                    "notif-channel",
                    "canal de alarmas obsoleto borrado: ${ch.id} (vigente: $activeId)",
                )
            }
        }
    }

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val alarmsChannelId = alarmChannelId(context)
        dropStaleAlarmChannels(nm, alarmsChannelId)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_REMINDERS, "Recordatorios Vyneural", NotificationManager.IMPORTANCE_DEFAULT),
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_PLAYER, "Reproductor Vyneural", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Control de la sesión en curso"
                setShowBadge(false)
            },
        )
        // P5 — la alarma vibra (patrón de recordatorio) además de sonar: es un
        // aviso de alarma, no una notificación pasiva. El canal se crea con la
        // vibración habilitada desde el arranque para que Android la permita.
        // v3 — ALARMA REAL: el canal usa el ringtone de ALARMA del sistema con
        // AudioAttributes USAGE_ALARM (el mismo que la app Reloj): suena alto,
        // aunque el teléfono esté en silencio/No molestar según la política del
        // SO, y vibra. No es el "pop" genérico de una notificación.
        nm.createNotificationChannel(
            NotificationChannel(alarmsChannelId, "Alarmas Vyneural", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Alarmas reales de sesión (sonido de alarma + vibración)"
                enableVibration(true)
                setVibrationPattern(VIBRATION_ALARM)
                // v8 — reportado de nuevo "llega pero a veces sin alarma" tras v7
                // (que arregló la importancia bajada sola). Hueco real encontrado
                // acá: el canal NUNCA pedía bypassear No Molestar. USAGE_ALARM ya
                // enruta el sonido por el stream de alarma (audible aunque el
                // ringer esté silenciado), pero en Modo Silencio Total / algunas
                // políticas de DND de terceros eso no basta — solo bypassDnd(true)
                // + el permiso ACCESS_NOTIFICATION_POLICY concedido hace que el
                // canal mismo se trate como excepción de DND. Sin este flag, el
                // comportamiento dependía 100% de la política de DND del teléfono,
                // lo que explica el "a veces" (varía según el modo activo en cada
                // disparo). Como sonido/importancia, bypassDnd solo se aplica al
                // CREARSE el canal — de ahí el bump a v8 (ver arriba).
                // v13 (2026-11-08): esta línea fue un NO-OP desde v8 hasta hoy —
                // faltaba ACCESS_NOTIFICATION_POLICY en el manifest Y el acceso a
                // DND concedido por el usuario. Ahora el id del canal depende de
                // ese acceso (CHANNEL_ALARMS_DND), así que esta llamada solo
                // "cuenta" en el canal que nace con el acceso ya concedido.
                setBypassDnd(true)
                // Reportado en vivo: ni el botón "Probar notificación" ni las
                // alarmas reales sonaban/vibraban en un dispositivo — hueco
                // real encontrado acá: RingtoneManager.getDefaultUri() puede
                // devolver null si el usuario puso el tono de alarma (o el de
                // timbre, el 2º fallback) en "Silencio" — no es el VOLUMEN,
                // es la selección del tono en sí. setSound(null, attrs) APAGA
                // el sonido del canal a propósito según la API de Android; sin
                // este 3er fallback al sonido de notificación por defecto del
                // sistema (que casi nunca es null), el canal quedaba mudo sin
                // que el código lo supiera. La vibración es independiente de
                // esto — enableVibration(true) de arriba no se toca.
                val alarmSound = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM)
                    ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE)
                    ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION)
                setSound(
                    alarmSound,
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            },
        )
        // M1 — fin de sesión: aviso suave (sonido del sistema, sin vibración).
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SESSION_END, "Fin de sesión", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Aviso de que la sesión terminó"
                setShowBadge(false)
            },
        )
        // Chat de soporte: notificación de nuevo mensaje del admin (importancia
        // default, sonido del sistema, sin bypass de DND).
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SUPPORT_CHAT, "Chat de soporte", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Mensajes nuevos en tu conversación de soporte con Vyneural"
                setShowBadge(true)
            },
        )
        logChannelState(nm, alarmsChannelId)
    }

    /** Diagnóstico: v4/v5/v6 fueron sucesivos intentos a ciegas de arreglar
     *  "no suena ni vibra" sin poder confirmar la causa real en el
     *  dispositivo que lo reportaba. Esto lee de vuelta lo que el SISTEMA
     *  efectivamente terminó aplicando al canal (no lo que le pedimos) —
     *  visible con `adb logcat -s BineuralLog` — para la próxima vez saber
     *  con certeza en vez de seguir adivinando con otro bump de versión. */
    private fun logChannelState(nm: NotificationManager, channelId: String) {
        try {
            val ch = nm.getNotificationChannel(channelId) ?: return
            com.vyneural.bineural.util.BineuralLog.d(
                "notif-channel",
                "id=${ch.id} importance=${ch.importance} sound=${ch.sound} " +
                    "vibrationEnabled=${ch.shouldVibrate()} pattern=${ch.vibrationPattern?.toList()} " +
                    // bypassDnd en el log: es lo que confirma de un vistazo si el
                    // arreglo de v13 (permiso + acceso a DND) está surtiendo efecto
                    // en el dispositivo real, sin tener que leer dumpsys.
                    "bypassDnd=${ch.canBypassDnd()} " +
                    "audioAttrs=${ch.audioAttributes}",
            )
        } catch (e: Exception) {
            com.vyneural.bineural.util.BineuralLog.e("notif-channel", "no se pudo leer el estado del canal", e)
        }
    }

    /** P8 — confirmado en vivo (dumpsys) en un dispositivo Honor/Magic OS: el
     *  canal puede quedar en Importancia baja INSTANTÁNEAMENTE al conceder el
     *  permiso, sin que se haya mostrado ni descartado una sola notificación
     *  — la teoría de "Android la baja sola tras varios descartes" (ver
     *  docs/NOTIFICATION_CHANNEL_HISTORY.md, v3→v11) no explica este caso. Por
     *  código no hay forma de subirla de vuelta (ver openAlarmChannelSettings)
     *  — esto solo lee el estado real para decidir si hace falta ofrecer el
     *  arreglo ya mismo. Dos superficies reaccionan a esta señal a propósito,
     *  sin coordinarse entre sí — no es duplicación accidental: el diálogo
     *  nativo (MainActivity.onRequestPermissionsResult) cubre el instante
     *  justo después de conceder el permiso, y src/ui/degraded-alarm-banner.js
     *  cubre cualquier degradación posterior que no pase por ese flujo (no
     *  hay forma de que la app se entere si el canal se degrada mientras está
     *  cerrada, así que el banner re-chequea en cada visibilitychange). */
    fun channelDegraded(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = nm.getNotificationChannel(alarmChannelId(context)) ?: return false
        return ch.importance < NotificationManager.IMPORTANCE_HIGH
    }

    /** Salta directo a los ajustes del canal "Alarmas Vyneural" (mismo intent
     *  que AndroidBridge.kt::OPEN_ALARM_CHANNEL_SETTINGS, extraído acá para
     *  reusarlo también desde MainActivity justo después de conceder el
     *  permiso — ver P8 arriba, el momento en que más importa ofrecerlo). */
    fun openAlarmChannelSettings(context: Context) {
        try {
            val i = Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, alarmChannelId(context))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
        } catch (e: Exception) {
            com.vyneural.bineural.util.BineuralLog.e("notif-channel", "open alarm channel settings", e)
            try {
                val i = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(i)
            } catch (e2: Exception) {
                com.vyneural.bineural.util.BineuralLog.e("notif-channel", "open alarm channel settings fallback", e2)
            }
        }
    }

    private val VIBRATION_ALARM = longArrayOf(0, 500, 300, 500, 300, 700)

    // Personalización de alarma (P7): patrones de vibración a elegir por
    // alarma — "default" es VIBRATION_ALARM de siempre (compatibilidad con
    // canal/config existente), el resto son variantes nuevas.
    val VIBRATIONS: Map<String, LongArray> = mapOf(
        "default" to VIBRATION_ALARM,
        "short" to longArrayOf(0, 300),
        "long" to longArrayOf(0, 800, 400, 800, 400, 800),
        "pulse" to longArrayOf(0, 200, 200, 200, 200, 200, 200, 200),
    )

    /** Canal por combinación (sonido elegido, patrón de vibración): los
     *  canales son inmutables por ID una vez creados (ver historial v2→v10
     *  arriba) — la única forma de tener sonido/vibración DISTINTOS por
     *  alarma es un canal propio por combinación, creado la primera vez que
     *  se usa. La combinación por defecto (sin sonido custom, vibración
     *  "default") sigue siendo el canal de alarmas de siempre — nada cambia
     *  para una alarma sin personalizar. `soundUri`: URI elegida con el picker de
     *  tonos del sistema (ACTION_RINGTONE_PICKER, TYPE_ALARM) — no un
     *  catálogo fijo nuestro, así el usuario elige entre lo que YA tiene en
     *  su teléfono, sin depender de archivos de audio propios. */
    fun usesDefaultAlarmChannel(soundUri: String?, vibrationId: String): Boolean =
        soundUri.isNullOrBlank() && (vibrationId == "default" || vibrationId !in VIBRATIONS)

    fun channelFor(context: Context, soundUri: String?, vibrationId: String): String {
        val vibKey = if (VIBRATIONS.containsKey(vibrationId)) vibrationId else "default"
        val base = alarmChannelId(context)
        if (usesDefaultAlarmChannel(soundUri, vibrationId)) return base
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return base
        // Deriva del id EFECTIVO del canal por defecto (no un literal aparte) —
        // antes este prefijo estaba hardcodeado como "bineural_alarms_v9_",
        // desincronizado del bump de la constante de arriba, así que un
        // futuro v11/v12 solo tocaría uno de los dos lugares por accidente.
        // Al derivar de alarmChannelId() los canales personalizados también
        // nacen del lado correcto del acceso a DND (si no, tendrían el mismo
        // no-op de setBypassDnd que tuvo el canal por defecto hasta v12).
        val id = "${base}_" + kotlin.math.abs((soundUri.orEmpty() + "|" + vibKey).hashCode())
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(id) == null) {
            val alarmSound = soundUri?.let { android.net.Uri.parse(it) }
                ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM)
                ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE)
                ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION)
            nm.createNotificationChannel(
                NotificationChannel(id, "Alarmas Vyneural (personalizada)", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Alarma con sonido/vibración elegidos por el usuario"
                    enableVibration(true)
                    setVibrationPattern(VIBRATIONS[vibKey])
                    setBypassDnd(true)
                    setSound(
                        alarmSound,
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                },
            )
        }
        return id
    }

    /** Notificación del reproductor (Foreground Service): el SO la muestra en
     *  lock screen y centro de control mientras el servicio corre. Con la
     *  MediaSession adjunta (P1.5) el sombreado de notificaciones y la
     *  pantalla de bloqueo exponen los controles reales: ▶/⏸ contextual según
     *  el estado del motor y ■ detener. Nunca se duplica reproducción: los
     *  botones reenvían al MISMO servicio/motor. */
    fun mediaNotification(
        context: Context,
        title: String,
        text: String,
        sessionToken: android.media.session.MediaSession.Token?,
        isPlaying: Boolean,
    ): Notification {
        ensureChannels(context)
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val play = PendingIntent.getService(
            context, 2,
            Intent(context, AudioForegroundService::class.java).setAction(AudioForegroundService.ACTION_PLAY),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val pause = PendingIntent.getService(
            context, 3,
            Intent(context, AudioForegroundService::class.java).setAction(AudioForegroundService.ACTION_PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            context, 1,
            Intent(context, AudioForegroundService::class.java).setAction(AudioForegroundService.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // ⏮/⏭ mueven la PORTADORA ±10 Hz (AudioForegroundService.stepFrequency),
        // no cambian de sesión — antes el callback nativo (onSkipToNext/Previous)
        // ya existía pero esta notificación nunca mostraba los botones para
        // llegar a él. Solo se muestran reproduciendo (mismo criterio que la
        // MediaSession — ver setSessionPlaying: en pausa la sesión queda
        // deliberadamente sin acciones de skip, REGLA DE ORO).
        val next = PendingIntent.getService(
            context, 4,
            Intent(context, AudioForegroundService::class.java).setAction(AudioForegroundService.ACTION_SKIP_NEXT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val prev = PendingIntent.getService(
            context, 5,
            Intent(context, AudioForegroundService::class.java).setAction(AudioForegroundService.ACTION_SKIP_PREV),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // minSdk 26: API de plataforma para MediaStyle sin dependencias extra.
        val builder = Notification.Builder(context, CHANNEL_PLAYER)
            .setSmallIcon(R.drawable.ic_stat_bineural)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
        val compactIndices: IntArray
        if (isPlaying) {
            // Orden clásico de reproductor: anterior / pausar / siguiente en la
            // vista compacta, detener como cuarta acción (solo en la expandida).
            builder.addAction(0, "Anterior", prev)
            builder.addAction(0, "Pausar", pause)
            builder.addAction(0, "Siguiente", next)
            builder.addAction(0, "Detener", stop)
            compactIndices = intArrayOf(0, 1, 2)
        } else {
            builder.addAction(0, "Reproducir", play)
            builder.addAction(0, "Detener", stop)
            compactIndices = intArrayOf(0, 1)
        }
        builder.setStyle(
            Notification.MediaStyle()
                .setMediaSession(sessionToken)
                .setShowActionsInCompactView(*compactIndices),
        )
        return builder.build()
    }

    fun alarmNotification(
        context: Context,
        title: String,
        body: String,
        freq: Double? = null,
        beat: Double? = null,
        wave: String? = null,
        alarmId: String? = null,
        soundUri: String? = null,
        vibrationId: String = "default",
        snoozeEnabled: Boolean = false,
        snoozeMinutes: Int = 5,
        notifyOnly: Boolean = false,
    ): Notification {
        ensureChannels(context)
        val channelId = if (notifyOnly) CHANNEL_REMINDERS else channelFor(context, soundUri, vibrationId)
        val openIntent = Intent(context, MainActivity::class.java)
        if (alarmId != null) openIntent.action = "com.vyneural.bineural.OPEN_ALARM.$alarmId"
        // Deep link (paridad con el Web Push, ver reminders.py:_deep_link): al
        // tocar la notificación, MainActivity abre la web en esta frecuencia
        // exacta en vez de la pantalla por defecto. Sin freq (alarma legado sin
        // config), se abre la app tal cual — comportamiento anterior intacto.
        if (freq != null && freq.isFinite() && freq > 0) {
            openIntent.putExtra(MainActivity.EXTRA_FREQ, freq)
            if (beat != null && beat.isFinite() && beat >= 0) openIntent.putExtra(MainActivity.EXTRA_BEAT, beat)
            if (wave != null) openIntent.putExtra(MainActivity.EXTRA_WAVE, wave)
            openIntent.putExtra(MainActivity.EXTRA_AUTOSTART, true)
        }
        val open = PendingIntent.getActivity(
            context, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_bineural)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(open)
            .setAutoCancel(true)
            // CATEGORY_ALARM (no REMINDER): el sistema la trata como alarma real
            // (prioridad en No molestar según la política del usuario).
            .setCategory(if (notifyOnly) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_ALARM)
            // El sonido/vibración los lleva el canal (channelFor arriba,
            // inmutable al crearse): la notificación no necesita repetirlos.
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        // Posponer: self-contained en el propio PendingIntent (título/body/
        // freq/beat/wave/sonido/vibración/alarmId) — NO depende de que el
        // record en SharedPreferences siga existiendo (una alarma de una
        // sola vez ya se borró de ahí en AlarmReceiver antes de que el
        // usuario llegue a tocar el botón).
        if (!notifyOnly && snoozeEnabled && alarmId != null) {
            val snoozeIntent = Intent(context, AlarmSnoozeReceiver::class.java).apply {
                putExtra("alarmId", alarmId)
                putExtra("title", title)
                putExtra("body", body)
                putExtra("snoozeMinutes", snoozeMinutes)
                if (freq != null) putExtra("freq", freq)
                if (beat != null) putExtra("beat", beat)
                if (wave != null) putExtra("wave", wave)
                if (soundUri != null) putExtra("soundUri", soundUri)
                putExtra("vibrationId", vibrationId)
            }
            val snoozePi = PendingIntent.getBroadcast(
                context,
                alarmId.hashCode(),
                snoozeIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, "Posponer $snoozeMinutes min", snoozePi)
        }
        if (!notifyOnly && alarmId != null) builder.setTimeoutAfter(AlarmScheduler.ALARM_RING_LIMIT_MS)
        return builder.build()
    }

    // P6 — una misma alarma puede llegar a mostrarse por DOS caminos
    // independientes: AlarmReceiver (AlarmManager local, programado de
    // antemano) y VyneuralMessagingService (push FCM, que Play Services
    // puede entregar tarde — típicamente recién cuando el teléfono recupera
    // conexión/se reabre la app). Reportado en vivo: sonó bien estando la
    // app cerrada y volvió a sonar al reabrirla — el FCM llegó tarde y
    // ninguno de los dos caminos sabía que el otro ya la había mostrado.
    // Este dedup por alarmId es el único punto en común entre ambos.
    private const val DEDUP_PREFS = "bineural_alarm_dedup"
    private const val DEDUP_WINDOW_MS = 5 * 60 * 1000L // > ALARM_RING_LIMIT_MS de sobra

    private fun alreadyShownRecently(context: Context, alarmId: String): Boolean {
        val prefs = context.getSharedPreferences(DEDUP_PREFS, Context.MODE_PRIVATE)
        val last = prefs.getLong(alarmId, 0L)
        return last != 0L && System.currentTimeMillis() - last < DEDUP_WINDOW_MS
    }

    private fun markShown(context: Context, alarmId: String) {
        val prefs = context.getSharedPreferences(DEDUP_PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val editor = prefs.edit().putLong(alarmId, now)
        // Limpieza oportunista: sin esto, cada alarma que alguna vez sonó
        // queda para siempre en este SharedPreferences (nunca crece mucho,
        // pero no hay razón para no barrerlo cuando ya pasó de sobra la
        // ventana de dedup).
        for ((key, value) in prefs.all) {
            if (value is Long && now - value >= DEDUP_WINDOW_MS) editor.remove(key)
        }
        editor.apply()
    }

    /** Publica la alarma. Respeta el permiso POST_NOTIFICATIONS (Android 13+).
     *  `alarmId`: si se pasa (AlarmReceiver / VyneuralMessagingService, NO el
     *  botón de diagnóstico "Probar notificación"), deduplica contra el otro
     *  camino de entrega — ver comentario arriba. */
    @Synchronized
    fun showAlarm(
        context: Context,
        title: String,
        body: String,
        freq: Double? = null,
        beat: Double? = null,
        wave: String? = null,
        alarmId: String? = null,
        soundUri: String? = null,
        vibrationId: String = "default",
        snoozeEnabled: Boolean = false,
        snoozeMinutes: Int = 5,
        notifyOnly: Boolean = false,
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            com.vyneural.bineural.util.BineuralLog.e("notif-channel", "showAlarm: POST_NOTIFICATIONS no concedido, notificación DESCARTADA")
            return
        }
        if (alarmId != null && alreadyShownRecently(context, alarmId)) {
            com.vyneural.bineural.util.BineuralLog.d("notif-channel", "showAlarm: alarmId=$alarmId ya mostrada por el otro camino, se omite el duplicado")
            return
        }
        if (alarmId != null) markShown(context, alarmId)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        logChannelState(nm, alarmChannelId(context))
        val notification = alarmNotification(
            context, title, body, freq, beat, wave, alarmId, soundUri, vibrationId,
            snoozeEnabled, snoozeMinutes, notifyOnly,
        )
        if (alarmId != null) {
            nm.notify(alarmId, NOTIF_ALARM, notification)
        } else {
            nm.notify(NOTIF_ALARM, notification)
        }
    }

    /** Cancela un aviso específico o la notificación sin etiqueta de diagnóstico. */
    fun cancelAlarm(context: Context, alarmId: String? = null) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(alarmId, NOTIF_ALARM)
    }

    /**
     * M1 — fin de sesión nativo (id 2002, canal `bineural_session_end`): avisa
     * que el temporizador terminó aunque la WebView esté en segundo plano (la
     * web no puede mostrar new Notification() dentro del WebView). Toca la
     * notificación para volver a la app. Respeta POST_NOTIFICATIONS (Android 13+).
     */
    fun showSessionEnd(context: Context, title: String, body: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ensureChannels(context)
        val open = PendingIntent.getActivity(
            context, 10, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_SESSION_END)
            .setSmallIcon(R.drawable.ic_stat_bineural)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_SESSION_END, n)
    }

    /**
     * Chat de soporte (id 2003, canal `bineural_support_chat`): notificación
     * de nuevo mensaje en la conversación de soporte con el admin. Toca la
     * notificación para volver a la app. Respeta POST_NOTIFICATIONS (Android 13+).
     */
    fun showSupportMessage(context: Context, title: String, body: String, conversationId: String?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ensureChannels(context)
        val open = PendingIntent.getActivity(
            context, 11, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_SUPPORT_CHAT)
            .setSmallIcon(R.drawable.ic_stat_bineural)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_SUPPORT_CHAT, n)
    }
}
