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
    // v2: los canales son inmutables una vez creados; al añadir vibración se
    // cambió el ID para que las instalaciones existentes reciban el canal nuevo
    // (con vibración) en lugar de heredar el viejo sin ella.
    // v3: la alarma ahora suena con el RINGTONE DE ALARMA del sistema
    // (USAGE_ALARM), no con el sonido de notificación genérico: es una alarma
    // real, no un aviso pasivo. Nuevo ID para que las instalaciones existentes
    // reciban el canal con sonido de alarma.
    // v4: reportado que una alarma disparó SOLO la notificación, sin sonido
    // ni vibración — un teléfono que ya tenía "bineural_alarms_v3" creado
    // (de una build de prueba anterior de esta sesión, antes o después de
    // que este archivo cambiara) sigue con la config VIEJA de ese canal para
    // siempre: createNotificationChannel() es un no-op si el ID ya existe,
    // Android no permite reconfigurar sonido/vibración de un canal existente
    // por código. Nuevo ID otra vez para que TODAS las instalaciones (nuevas
    // y viejas) reciban el canal con la config actual desde cero.
    // v5: MISMO síntoma reportado otra vez (notificación sin sonido ni
    // vibración) — el teléfono de prueba instaló varias builds de esta
    // sesión ANTES de este archivo, así que "v4" quedó fijado con lo que
    // fuera que tenía en ese momento.
    // v6: confirmado en un dispositivo con instalación fresca del v5 — ni
    // siquiera el botón "Probar notificación" (dispara al toque, sin
    // scheduling de por medio) sonaba/vibraba. Esta vez la causa SÍ era la
    // config de abajo: RingtoneManager.getDefaultUri() puede devolver null
    // (tono de alarma en "Silencio"), y setSound(null, attrs) apaga el
    // sonido del canal a propósito — se agregó un 3er fallback. Bump para
    // que el canal se cree de cero con ese fallback ya aplicado.
    // v7: los diagnósticos nuevos de /diagnostico (alarmChannelDiagnostics,
    // AndroidBridge.kt) mostraron la causa REAL en el dispositivo que seguía
    // reportando "llega pero no suena ni vibra": el canal v6 (creado con
    // IMPORTANCE_HIGH por código) terminó en IMPORTANCE_LOW — Android puede
    // bajar la importancia de un canal por su cuenta si el usuario descarta
    // varias notificaciones de esa app sin abrirlas (comportamiento adaptativo
    // de Android 12+), y pasamos varias builds de esta sesión probando/
    // descartando notificaciones de prueba en ese mismo canal. Un canal
    // existente es inmutable por código — ni ensureChannels() ni ninguna otra
    // llamada puede subirle la importancia de vuelta a HIGH; solo el usuario
    // puede hacerlo a mano en Ajustes, o se crea un canal nuevo. Bump a v7
    // para que el canal nazca de cero en IMPORTANCE_HIGH otra vez.
    // v8: reportado otra vez "llega pero a veces sin alarma" DESPUÉS de v7 —
    // esta vez el hueco no es importancia ni sonido nulo, es que el canal
    // nunca pedía bypassear No Molestar (ver setBypassDnd(true) abajo). Igual
    // que importancia/sonido, bypassDnd es un atributo de canal que Android
    // solo aplica al CREARSE por primera vez — createNotificationChannel()
    // sobre un canal existente no lo cambia, así que necesita ID nuevo para
    // que los teléfonos que ya tenían v7 lo reciban.
    // v9: mismo síntoma reportado otra vez en vivo (llega pero no despliega
    // heads-up, sin sonido ni vibración) DESPUÉS de v8 — consistente con que
    // Android bajó la importancia sola (ver comentario v7): esta sesión
    // disparó/descartó muchas notificaciones de prueba en el canal v8. Bump
    // para que nazca de cero en IMPORTANCE_HIGH otra vez. Como esto puede
    // volver a pasar con el uso normal (no es exclusivo de testing), ver
    // permissions-modal.js/main.js: ahora la UI detecta importancia degradada
    // y lo señala de forma prominente en vez de depender de otro bump manual.
    const val CHANNEL_ALARMS = "bineural_alarms_v9"
    // M1 — canal de fin de sesión: IMPORTANCE_DEFAULT (sonido suave, sin
    // vibración) para avisar que el temporizador terminó. Canal propio para
    // no mezclarse con el reproductor ni con las alarmas.
    const val CHANNEL_SESSION_END = "bineural_session_end"
    private const val NOTIF_PLAYER = 1001
    private const val NOTIF_ALARM = 2001
    private const val NOTIF_SESSION_END = 2002

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
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
            NotificationChannel(CHANNEL_ALARMS, "Alarmas Vyneural", NotificationManager.IMPORTANCE_HIGH).apply {
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
        logChannelState(nm)
    }

    /** Diagnóstico: v4/v5/v6 fueron sucesivos intentos a ciegas de arreglar
     *  "no suena ni vibra" sin poder confirmar la causa real en el
     *  dispositivo que lo reportaba. Esto lee de vuelta lo que el SISTEMA
     *  efectivamente terminó aplicando al canal (no lo que le pedimos) —
     *  visible con `adb logcat -s BineuralLog` — para la próxima vez saber
     *  con certeza en vez de seguir adivinando con otro bump de versión. */
    private fun logChannelState(nm: NotificationManager) {
        try {
            val ch = nm.getNotificationChannel(CHANNEL_ALARMS) ?: return
            com.vyneural.bineural.util.BineuralLog.d(
                "notif-channel",
                "id=${ch.id} importance=${ch.importance} sound=${ch.sound} " +
                    "vibrationEnabled=${ch.shouldVibrate()} pattern=${ch.vibrationPattern?.toList()} " +
                    "audioAttrs=${ch.audioAttributes}",
            )
        } catch (e: Exception) {
            com.vyneural.bineural.util.BineuralLog.e("notif-channel", "no se pudo leer el estado del canal", e)
        }
    }

    private val VIBRATION_ALARM = longArrayOf(0, 500, 300, 500, 300, 700)

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
    ): Notification {
        ensureChannels(context)
        val openIntent = Intent(context, MainActivity::class.java)
        // Deep link (paridad con el Web Push, ver reminders.py:_deep_link): al
        // tocar la notificación, MainActivity abre la web en esta frecuencia
        // exacta en vez de la pantalla por defecto. Sin freq (alarma legado sin
        // config), se abre la app tal cual — comportamiento anterior intacto.
        if (freq != null) {
            openIntent.putExtra(MainActivity.EXTRA_FREQ, freq)
            if (beat != null) openIntent.putExtra(MainActivity.EXTRA_BEAT, beat)
            if (wave != null) openIntent.putExtra(MainActivity.EXTRA_WAVE, wave)
            openIntent.putExtra(MainActivity.EXTRA_AUTOSTART, true)
        }
        val open = PendingIntent.getActivity(
            context, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_ALARMS)
            .setSmallIcon(R.drawable.ic_stat_bineural)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(open)
            .setAutoCancel(true)
            // CATEGORY_ALARM (no REMINDER): el sistema la trata como alarma real
            // (prioridad en No molestar según la política del usuario).
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            // El SONIDO de alarma (ringtone TYPE_ALARM con USAGE_ALARM) lo lleva
            // el canal v3 (inmutable, se configura al crearse): la notificación
            // no necesita repetirlo. Vibración con patrón de recordatorio.
            .setVibrate(VIBRATION_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
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
    fun showAlarm(
        context: Context,
        title: String,
        body: String,
        freq: Double? = null,
        beat: Double? = null,
        wave: String? = null,
        alarmId: String? = null,
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
        logChannelState(nm)
        nm.notify(NOTIF_ALARM, alarmNotification(context, title, body, freq, beat, wave))
    }

    /**
     * Cancela la notificación de alarma. La usa AlarmSilenceReceiver al vencer
     * el límite de sonido sin respuesta (AlarmScheduler.ALARM_RING_LIMIT_MS):
     * corta el sonido/vibración si aún suenan y limpia el sombreado. Es un
     * no-op si el usuario ya la tocó o descartó.
     */
    fun cancelAlarm(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(NOTIF_ALARM)
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
}
