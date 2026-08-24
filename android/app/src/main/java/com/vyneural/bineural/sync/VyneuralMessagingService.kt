package com.vyneural.bineural.sync

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.vyneural.bineural.notifications.AlarmScheduler
import com.vyneural.bineural.notifications.NotificationHelper
import com.vyneural.bineural.util.FcmTokenStore

/**
 * P6 — recibe push FCM real. Play Services despierta ESTE servicio incluso
 * con el proceso completo de la app muerto (no solo en 2.º plano) — es el
 * mecanismo que Instagram/YouTube usan para notificaciones con la app
 * cerrada, algo que un AlarmManager propio no puede igualar en fabricantes
 * que matan procesos agresivamente (ver OemAutostart.kt).
 *
 * REGLA DE ORO — este servicio JAMÁS arranca audio ni toca
 * AudioForegroundService: onMessageReceived() solo construye y muestra la
 * MISMA notificación nativa que dispara una alarma del AlarmManager local
 * (NotificationHelper.showAlarm) — un solo camino de notificación, sin
 * importar qué la disparó. El usuario decide con un gesto explícito si
 * quiere reproducir, igual que con cualquier otra notificación de la app.
 */
class VyneuralMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        FcmTokenStore.set(applicationContext, token)
        // Reporta el token nuevo YA si hay sesión (AlarmSync.run() es no-op
        // sin AuthStore.token()); si no hay sesión, queda guardado para el
        // próximo login (STORE_AUTH ya dispara un ciclo de sync).
        AlarmSync.run(applicationContext)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        // Data-only (nunca message.notification): la app decide qué mostrar,
        // nunca el payload de FCM directamente — mismo principio que "el
        // backend nunca arranca audio", aplicado a la notificación misma.
        if (data["kind"] != "alarm") return

        val id = data["id"] ?: return
        val title = data["title"] ?: "Vyneural"
        val body = data["body"] ?: "Hora de tu sesión"
        val freq = data["freq"]?.toDoubleOrNull()
        val beat = data["beat"]?.toDoubleOrNull()
        val wave = data["wave"]

        NotificationHelper.showAlarm(applicationContext, title, body, freq, beat, wave)
        // Mismo límite de sonido/vibración sin respuesta que una alarma
        // local (AlarmReceiver): se auto-silencia si nadie la toca.
        AlarmScheduler(applicationContext).scheduleSilence(id)
    }
}
