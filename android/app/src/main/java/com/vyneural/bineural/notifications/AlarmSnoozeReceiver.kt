package com.vyneural.bineural.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Botón "Posponer" de la notificación de alarma (P7 — personalización).
 * Self-contained: toda la info necesaria (título/body/freq/beat/wave/
 * sonido/vibración) viaja en los extras del propio PendingIntent (ver
 * NotificationHelper.alarmNotification) en vez de releerse de
 * SharedPreferences — una alarma de una sola vez ya borró su record ahí
 * (AlarmReceiver) antes de que el usuario llegue a tocar el botón.
 */
class AlarmSnoozeReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getStringExtra("alarmId") ?: return
        val title = intent.getStringExtra("title") ?: "Vyneural"
        val body = intent.getStringExtra("body") ?: "Hora de tu sesión"
        val snoozeMinutes = intent.getIntExtra("snoozeMinutes", 5)
        val freq = if (intent.hasExtra("freq")) intent.getDoubleExtra("freq", 0.0) else null
        val beat = if (intent.hasExtra("beat")) intent.getDoubleExtra("beat", 0.0) else null
        val wave = intent.getStringExtra("wave")
        val soundUri = intent.getStringExtra("soundUri")
        val vibrationId = intent.getStringExtra("vibrationId") ?: "default"

        NotificationHelper.cancelAlarm(context)
        AlarmScheduler(context).schedule(
            alarmId,
            title,
            body,
            System.currentTimeMillis() + snoozeMinutes * 60_000L,
            days = null,
            freq = freq,
            beat = beat,
            wave = wave,
            soundUri = soundUri,
            vibrationId = vibrationId,
            snoozeEnabled = true,
            snoozeMinutes = snoozeMinutes,
        )
    }
}
