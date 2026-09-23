package com.vyneural.bineural.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/**
 * Disparo de alarma (AlarmManager → BroadcastReceiver → Notification nativa).
 * No depende de la WebView: funciona con la app cerrada, minimizada o con la
 * pantalla bloqueada.
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (!action.startsWith(ACTION_PREFIX)) return
        val id = action.removePrefix(ACTION_PREFIX)
        val prefs = context.getSharedPreferences("bineural_alarms", Context.MODE_PRIVATE)
        val record = runCatching {
            JSONObject(prefs.getString(id, "{}") ?: "{}")
        }.getOrNull() ?: return
        NotificationHelper.showAlarm(
            context,
            record.optString("title", "Vyneural"),
            record.optString("body", "Hora de tu sesión"),
            if (record.has("freq")) record.optDouble("freq") else null,
            if (record.has("beat")) record.optDouble("beat") else null,
            if (record.has("wave")) record.optString("wave") else null,
            // El dedup de showAlarm() compara este alarmId contra el que
            // manda VyneuralMessagingService (FCM) para la MISMA alarma —
            // que es localId, no el id crudo del servidor (ver AlarmSync.kt
            // y reminders.py: local_id = cfg.get("localId") or str(alarm.id)).
            // Mismo fallback que el backend: si no hay localId guardado
            // (alarma vieja, o creada sin pasar por la web), usar el id del
            // servidor como antes.
            alarmId = record.optString("localId").takeIf { it.isNotBlank() } ?: id,
            soundUri = record.optString("soundUri").takeIf { it.isNotBlank() },
            vibrationId = record.optString("vibrationId", "default"),
            snoozeEnabled = record.optBoolean("snoozeEnabled", false),
            snoozeMinutes = record.optInt("snoozeMinutes", 5),
        )
        // Límite de sonido sin respuesta: si nadie toca/descarta la alarma, se
        // silencia sola a los AlarmScheduler.ALARM_RING_LIMIT_MS (AlarmSilenceReceiver).
        AlarmScheduler(context).scheduleSilence(id)
        // P5 — rutina: si la alarma tiene días de repetición, se reprograma a la
        // PRÓXIMA ocurrencia (misma hora, próximo día del patrón). Si no, se
        // consume (una sola vez).
        val days = record.optJSONArray("days")
        if (days != null && days.length() > 0) {
            AlarmScheduler(context).rescheduleAlarm(id)
        } else {
            prefs.edit().remove(id).apply()
        }
    }

    companion object {
        const val ACTION_PREFIX = "com.vyneural.bineural.ALARM_"
    }
}
