package com.vyneural.bineural.notifications

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

/**
 * Programador de alarmas NATIVO (P1): usa AlarmManager del sistema, nunca
 * setTimeout/setInterval de la WebView. La alarma sobrevive a cerrar la
 * WebView, bloquear la pantalla o minimizar la app.
 *
 * - Exacta (setExactAndAllowWhileIdle) si SCHEDULE_EXACT_ALARM está
 *   autorizado; si no, window de 60 s (honesto: supported ≠ granted).
 * - Persistencia en SharedPreferences para reprogramar tras reinicio.
 * - P5 — RUTINAS: si se pasan días de repetición (0=domingo … 6=sábado,
 *   mismos valores que Date.getDay() en JS), la alarma se reprograma sola
 *   a la siguiente ocurrencia al dispararse (AlarmReceiver) y tras reboot
 *   (rescheduleAll recalcula la PRÓXIMA ocurrencia, nunca una pasada).
 */
class AlarmScheduler(private val context: Context) {

    companion object {
        /**
         * Límite de sonido de la alarma sin respuesta: a los
         * ALARM_RING_LIMIT_MS de dispararse, si la notificación de alarma
         * sigue activa (nadie la tocó ni descartó), se cancela sola — se
         * corta el sonido/vibración (un ringtone de alarma puede ser largo y
         * algunos OEM lo repiten hasta descartar) y se limpia el sombreado.
         * La alarma avisa un tiempo acotado, nunca suena indefinidamente.
         */
        const val ALARM_RING_LIMIT_MS = 2 * 60 * 1000L // 2 minutos por defecto
    }

    private val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private val prefs = context.getSharedPreferences("bineural_alarms", Context.MODE_PRIVATE)

    fun canScheduleExact(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.canScheduleExactAlarms() else true

    fun schedule(
        alarmId: String,
        title: String,
        body: String,
        atMs: Long,
        days: List<Int>? = null,
        freq: Double? = null,
        beat: Double? = null,
        wave: String? = null,
        soundUri: String? = null,
        vibrationId: String = "default",
        snoozeEnabled: Boolean = false,
        snoozeMinutes: Int = 5,
        localId: String? = null,
        timezone: String? = null,
        localTime: String? = null,
    ) {
        val record = JSONObject()
            .put("title", title)
            .put("body", body)
            .put("at", atMs)
            // P7 — personalización de alarma: sonido/vibración/posponer, ver
            // NotificationHelper.kt::channelFor()/alarmNotification().
            .put("vibrationId", vibrationId)
            .put("snoozeEnabled", snoozeEnabled)
            .put("snoozeMinutes", snoozeMinutes)
        if (soundUri != null) record.put("soundUri", soundUri)
        // localId (config.localId del backend) es el id que usa el dedup de
        // NotificationHelper.showAlarm — DISTINTO de `alarmId` (la clave de
        // este SharedPreferences/PendingIntent, que tiene que seguir siendo
        // el id del servidor para que sync/cancelación funcionen). Sin esto,
        // AlarmReceiver mostraba la alarma con el id crudo del servidor
        // mientras VyneuralMessagingService (FCM) la mostraba con localId —
        // dos claves distintas para la MISMA alarma, dedup roto, el
        // duplicado original podía reaparecer.
        if (localId != null) record.put("localId", localId)
        // Deep link: al tocar la notificación, MainActivity abre la web en esta
        // frecuencia exacta en vez de la pantalla por defecto (ver AlarmReceiver
        // + NotificationHelper). Opcional: alarmas sin config (legado) siguen
        // funcionando, solo sin deep link.
        if (freq != null && freq.isFinite() && freq > 0) record.put("freq", freq)
        if (beat != null && beat.isFinite() && beat >= 0) record.put("beat", beat)
        if (wave != null) record.put("wave", wave)
        if (days != null && days.isNotEmpty()) {
            record.put("days", JSONArray(days))
            // Se guarda la hora del día (local) para recalcular la próxima
            // ocurrencia cuando la alarma se dispare o tras un reinicio.
            val zone = alarmZone(timezone)
            val time = localTime?.let { runCatching { LocalTime.parse(it) }.getOrNull() }
                ?: Instant.ofEpochMilli(atMs).atZone(zone).toLocalTime()
            record.put("hh", time.hour)
            record.put("mm", time.minute)
            if (timezone != null) record.put("timezone", zone.id)
        }
        prefs.edit().putString(alarmId, record.toString()).apply()

        val now = System.currentTimeMillis()
        if (atMs <= now) {
            // Alarma vencida: descartar para evitar ráfagas tras reinicio o retardo.
            prefs.edit().remove(alarmId).apply()
            return
        }

        val pi = pendingIntent(alarmId)
        if (canScheduleExact()) {
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
                return
            } catch (_: SecurityException) {
                // El permiso puede cambiar entre la lectura y la programación.
            }
        }
        am.setWindow(AlarmManager.RTC_WAKEUP, atMs, 60_000L, pi)
    }

    fun cancel(alarmId: String) {
        prefs.edit().remove(alarmId).apply()
        am.cancel(pendingIntent(alarmId))
        // Antes acá había un cancelSilence(alarmId) que cancelaba la alarma de
        // "silenciar" que programaba scheduleSilence() en versiones anteriores.
        // Se eliminó junto con AlarmSilenceReceiver: el límite de sonido lo
        // aplica el sistema con builder.setTimeoutAfter() desde que se migró
        // (ver NotificationHelper.alarmNotification), así que no hay nada que
        // cancelar — y las alarmas de AlarmManager de la versión anterior ya no
        // existen de todos modos: el SO las descarta al reemplazar el paquete
        // (igual que en un reinicio, de ahí BootReceiver/rescheduleAll).
    }

    fun list(): List<String> = prefs.all.keys.toList()

    fun pendingCount(defaultChannelOnly: Boolean = false): Int {
        val now = System.currentTimeMillis()
        return prefs.all.values.count { raw ->
            runCatching {
                val record = JSONObject(raw as String)
                record.optLong("at") > now && (!defaultChannelOnly || NotificationHelper.usesDefaultAlarmChannel(
                    record.optString("soundUri"),
                    record.optString("vibrationId", "default"),
                ))
            }.getOrDefault(false)
        }
    }

    fun nextAt(): Long? =
        prefs.all.values.mapNotNull { raw ->
            runCatching { JSONObject(raw as String).optLong("at") }.getOrNull()
        }.minOrNull()

    /**
     * P5 — reprograma la siguiente ocurrencia de una alarma recurrente
     * (misma hora, próximo día del patrón). Las de una sola vez se descartan
     * (ya se dispararon). Lo llama AlarmReceiver al disparar.
     */
    fun rescheduleAlarm(alarmId: String) {
        val raw = prefs.getString(alarmId, null) ?: return
        val j = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val days = j.optJSONArray("days")
        val hh = j.optInt("hh", -1)
        val mm = j.optInt("mm", -1)
        if (days != null && days.length() > 0 && hh >= 0 && mm >= 0) {
            val dayList = (0 until days.length()).map { days.optInt(it) }
            val timezone = j.optString("timezone").ifBlank { null }
            val next = nextOccurrence(hh, mm, dayList, System.currentTimeMillis() + 60_000, timezone)
            if (next != null) {
                schedule(
                    alarmId,
                    j.optString("title", "Vyneural"),
                    j.optString("body", ""),
                    next,
                    dayList,
                    if (j.has("freq")) j.optDouble("freq") else null,
                    if (j.has("beat")) j.optDouble("beat") else null,
                    if (j.has("wave")) j.optString("wave") else null,
                    j.optString("soundUri").takeIf { it.isNotBlank() },
                    j.optString("vibrationId", "default"),
                    j.optBoolean("snoozeEnabled", false),
                    j.optInt("snoozeMinutes", 5),
                    j.optString("localId").takeIf { it.isNotBlank() },
                    timezone,
                    LocalTime.of(hh, mm).toString(),
                )
            } else {
                prefs.edit().remove(alarmId).apply()
            }
        } else {
            prefs.edit().remove(alarmId).apply()
        }
    }

    /** Próxima fecha ≥ fromMs cuyo día de la semana esté en [days] a las hh:mm. */
    private fun alarmZone(timezone: String?): ZoneId =
        timezone?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneId.systemDefault()

    private fun nextOccurrence(hh: Int, mm: Int, days: List<Int>, fromMs: Long, timezone: String?): Long? {
        if (days.isEmpty() || hh !in 0..23 || mm !in 0..59) return null
        val zone = alarmZone(timezone)
        val from = Instant.ofEpochMilli(fromMs)
        val startDate = from.atZone(zone).toLocalDate()
        for (i in 0..8) {
            val date = startDate.plusDays(i.toLong())
            if (date.dayOfWeek.value % 7 !in days) continue
            val candidate = date.atTime(hh, mm).atZone(zone).toInstant()
            if (!candidate.isBefore(from)) return candidate.toEpochMilli()
        }
        return null
    }

    /** Reprograma todas las alarmas (tras BOOT_COMPLETED). Las recurrentes se
     *  reagendan a su PRÓXIMA ocurrencia; las de una sola vez, tal cual. */
    fun rescheduleAll() {
        for ((id, raw) in prefs.all) {
            runCatching {
                val j = JSONObject(raw as String)
                val daysArr = j.optJSONArray("days")
                val days =
                    if (daysArr != null && daysArr.length() > 0) (0 until daysArr.length()).map { daysArr.optInt(it) }
                    else emptyList()
                val hh = j.optInt("hh", -1)
                val mm = j.optInt("mm", -1)
                val freq = if (j.has("freq")) j.optDouble("freq") else null
                val beat = if (j.has("beat")) j.optDouble("beat") else null
                val wave = if (j.has("wave")) j.optString("wave") else null
                val soundUri = j.optString("soundUri").takeIf { it.isNotBlank() }
                val vibrationId = j.optString("vibrationId", "default")
                val snoozeEnabled = j.optBoolean("snoozeEnabled", false)
                val snoozeMinutes = j.optInt("snoozeMinutes", 5)
                val localId = j.optString("localId").takeIf { it.isNotBlank() }
                if (days.isNotEmpty() && hh >= 0 && mm >= 0) {
                    val timezone = j.optString("timezone").ifBlank { null }
                    val next = nextOccurrence(hh, mm, days, System.currentTimeMillis() + 60_000, timezone)
                    if (next != null) {
                        schedule(
                            id, j.optString("title", "Vyneural"), j.optString("body", ""), next, days,
                            freq, beat, wave, soundUri, vibrationId, snoozeEnabled, snoozeMinutes, localId,
                            timezone, LocalTime.of(hh, mm).toString(),
                        )
                    }
                } else {
                    schedule(
                        id, j.optString("title", "Vyneural"), j.optString("body", ""), j.optLong("at"), null,
                        freq, beat, wave, soundUri, vibrationId, snoozeEnabled, snoozeMinutes, localId,
                    )
                }
            }
        }
    }

    private fun pendingIntent(alarmId: String): PendingIntent {
        val i = Intent(context, AlarmReceiver::class.java)
            .setAction("com.vyneural.bineural.ALARM_$alarmId")
        return PendingIntent.getBroadcast(
            context,
            alarmId.hashCode(),
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
