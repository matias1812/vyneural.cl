package com.vyneural.bineural.sync

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.vyneural.bineural.BuildConfig
import com.vyneural.bineural.lifecycle.LifecycleManager
import com.vyneural.bineural.notifications.AlarmScheduler
import com.vyneural.bineural.util.AuthStore
import com.vyneural.bineural.util.BineuralLog
import com.vyneural.bineural.util.DeviceId
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * Sincronización NATIVA con el backend: un ciclo periódico (AlarmManager,
 * auto-reprogramable, ~5 min) consulta las alarmas del usuario y las
 * (re)programa en el reloj del sistema. Así una alarma creada en la WEB
 * llega a la APK y dispara con la app cerrada, aunque el usuario no abra la
 * app. También reporta el estado del dispositivo — incluido el token FCM
 * actual (PUT /api/v1/devices/me) — para la sección Dispositivos.
 *
 * P6 — este ciclo YA NO es la única vía de entrega: FCM (VyneuralMessagingService)
 * complementa esto con push real, entregado por Play Services incluso con el
 * PROCESO de la app muerto (no solo en 2.º plano) — algo que ni el
 * AlarmManager nativo puede garantizar en fabricantes que matan procesos
 * agresivamente (ver OemAutostart.kt). Este ciclo sigue siendo necesario:
 * sincroniza alarmas CREADAS EN LA WEB al reloj nativo (FCM no reemplaza
 * eso) y es el respaldo si FCM no está configurado o falla.
 *
 * Access token corto (15 min, ver app/config.py del backend): este ciclo
 * puede refrescarlo con su propio refresh_token cuando la app está cerrada
 * (LifecycleManager.state != FOREGROUND) — es el único actor con el token en
 * ese momento. En foreground, un 401 se descarta en silencio: la WebView ya
 * tiene su propio refresh reactivo (client.js::tryRefresh) y empuja el token
 * nuevo acá vía STORE_AUTH en cuanto lo obtiene. Si dos refrescos (nativo +
 * WebView) corrieran a la vez con el mismo refresh_token de un solo uso, el
 * segundo en llegar invalidaría la sesión del primero — este gate evita esa
 * carrera.
 */
object AlarmSync {
    const val ACTION_SYNC = "com.vyneural.bineural.ALARM_SYNC"

    /** Cada 5 min (inexacto, ventana de 1 min): una alarma creada en la web
     *  llega al teléfono en minutos, no media hora. Además se sincroniza al
     *  abrir la app (MainActivity.onResume) y al iniciar sesión (STORE_AUTH). */
    private const val SYNC_INTERVAL_MS = 5 * 60 * 1000L
    private const val SYNC_WINDOW_MS = 60 * 1000L

    private const val PREFS_SYNCED = "bineural_synced_alarms"
    private const val KEY_IDS = "ids"
    private const val KEY_LAST_REPORTED = "last_reported"

    /** Programa el próximo ciclo. Se auto-reprograma al ejecutarse. */
    fun schedulePeriodic(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = syncPendingIntent(context)
        am.setWindow(
            AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + SYNC_INTERVAL_MS,
            SYNC_WINDOW_MS,
            pi,
        )
    }

    /** Ejecuta un ciclo completo (alarmas + reporte de dispositivo). Cada
     *  paso relee el token de AuthStore (no lo captura una sola vez al
     *  entrar): si syncAlarms lo refresca —o lo limpia por sesión muerta—
     *  reportDevice ve el estado actualizado, no uno viejo. */
    fun run(context: Context) {
        if (AuthStore.token(context) == null) {
            // Sin sesión no hay nada que sincronizar; el ciclo periódico igual
            // queda programado (para cuando haya sesión).
            schedulePeriodic(context)
            return
        }
        Thread {
            try {
                syncAlarms(context)
                reportDevice(context)
            } catch (e: Exception) {
                BineuralLog.e("alarmsync", "ciclo de sincronización falló", e)
            } finally {
                schedulePeriodic(context)
            }
        }.start()
    }

    /** Cancela y olvida las alarmas que llegaron por sync (al cerrar sesión,
     *  o cuando el refresh nativo descubre que la sesión ya no es válida). */
    fun clearSynced(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_SYNCED, Context.MODE_PRIVATE)
        val synced = prefs.getStringSet(KEY_IDS, emptySet()) ?: emptySet()
        val scheduler = AlarmScheduler(context)
        for (id in synced) scheduler.cancel(id)
        prefs.edit().remove(KEY_IDS).remove(KEY_LAST_REPORTED).apply()
    }

    // ── Sincronización de alarmas ───────────────────────────────────────────
    private fun syncAlarms(context: Context) {
        val json = authorizedGet(context, "${BuildConfig.API_BASE}/api/v1/alarms") ?: return
        val server = JSONArray(json)
        val scheduler = AlarmScheduler(context)
        val syncedPrefs = context.getSharedPreferences(PREFS_SYNCED, Context.MODE_PRIVATE)
        val previouslySynced = syncedPrefs.getStringSet(KEY_IDS, emptySet()) ?: emptySet()
        val newSynced = mutableSetOf<String>()

        for (i in 0 until server.length()) {
            val a = server.optJSONObject(i) ?: continue
            val id = a.optString("id")
            if (id.isEmpty()) continue
            newSynced.add(id)

            if (!a.optBoolean("enabled", true)) {
                scheduler.cancel(id) // desactivada en la web → se quita del reloj
                continue
            }
            val atMs = parseIsoToMillis(a.optString("scheduled_at", "")) ?: continue
            if (atMs <= System.currentTimeMillis()) {
                scheduler.cancel(id) // ya pasó: no reprogramar ráfagas viejas
                continue
            }
            val title = a.optString("name").ifBlank { "Vyneural" }
            val days = parseByDay(a.optString("repeat_rule", ""))
            val config = a.optJSONObject("config")
            // Deep link: al tocar la notificación de esta alarma (manual o
            // generada por un ítem de itinerario con horario), la app abre esta
            // frecuencia exacta en vez de la pantalla por defecto.
            val freq = config?.let { if (it.has("freq")) it.optDouble("freq") else null }
            val beat = config?.let { if (it.has("beat")) it.optDouble("beat") else null }
            val wave = config?.let { if (it.has("wave")) it.optString("wave") else null }
            scheduler.schedule(id, title, buildBody(config, title), atMs, days, freq, beat, wave)
        }

        // Las sincronizadas que ya no están en el servidor fueron borradas en
        // la web: se cancelan. Las locales (creadas sin sesión) se respetan.
        for (id in previouslySynced) {
            if (id !in newSynced) scheduler.cancel(id)
        }
        syncedPrefs.edit().putStringSet(KEY_IDS, newSynced).apply()
        BineuralLog.d("alarmsync", "alarmas sincronizadas: ${newSynced.size} programada(s)")
    }

    // ── Reporte del dispositivo (estado de push) ────────────────────────────
    private fun reportDevice(context: Context) {
        // En segundo plano no hay Activity (el detalle DENIED_PERMANENTLY lo
        // reporta la web vía bridge cuando la app está abierta). Acá basta el
        // estado real del permiso del sistema.
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        val permission = if (granted) "granted" else "denied"

        // Nada de esto cambia seguido: si es idéntico al último reporte que
        // tuvo éxito, saltear el PUT. El GET de alarmas de arriba (lo que
        // importa para la velocidad de un recordatorio) no se ve afectado.
        // El token FCM entra en el fingerprint: un token nuevo (rotación de
        // Play Services, reinstalación) SIEMPRE dispara un reporte, aunque
        // permiso/versión no hayan cambiado — si no, el backend seguiría
        // mandando push al token viejo hasta el próximo cambio de versión.
        val fcmToken = com.vyneural.bineural.util.FcmTokenStore.get(context)
        val syncedPrefs = context.getSharedPreferences(PREFS_SYNCED, Context.MODE_PRIVATE)
        val fingerprint = "$permission|${BuildConfig.VERSION_NAME}|${fcmToken ?: ""}"
        if (syncedPrefs.getString(KEY_LAST_REPORTED, null) == fingerprint) return

        val body = JSONObject()
            .put("device_id", DeviceId.get(context))
            .put("platform", "apk")
            .put("app_version", BuildConfig.VERSION_NAME)
            .put("notification_permission", permission)
            .put("push_enabled", granted)
            .put("user_agent", "Vyneural-APK/${BuildConfig.VERSION_NAME}")
        if (fcmToken != null) body.put("fcm_token", fcmToken)
        val ok = authorizedPut(context, "${BuildConfig.API_BASE}/api/v1/devices/me", body)
        if (ok) syncedPrefs.edit().putString(KEY_LAST_REPORTED, fingerprint).apply()
    }

    // ── Autenticación con refresh nativo ────────────────────────────────────

    /** GET autenticado con reintento tras refresh (ver doc de la clase para
     *  el porqué del gate por LifecycleManager). Devuelve null si no hay
     *  sesión, si el refresh falla, o si la respuesta final no es 2xx. */
    private fun authorizedGet(context: Context, url: String): String? {
        val token = AuthStore.token(context) ?: return null
        val first = httpGet(url, token)
        if (first.code != 401) return if (first.code in 200..299) first.body else null
        if (!shouldRetryWithRefresh(context)) return null
        val fresh = AuthStore.token(context) ?: return null
        val retry = httpGet(url, fresh)
        return if (retry.code in 200..299) retry.body else null
    }

    /** PUT autenticado con el mismo reintento. Devuelve si terminó en 2xx. */
    private fun authorizedPut(context: Context, url: String, body: JSONObject): Boolean {
        val token = AuthStore.token(context) ?: return false
        val first = httpPut(url, token, body)
        if (first.code != 401) return first.code in 200..299
        if (!shouldRetryWithRefresh(context)) return false
        val fresh = AuthStore.token(context) ?: return false
        return httpPut(url, fresh, body).code in 200..299
    }

    /** Ante un 401: si la app está en foreground, la WebView ya tiene su
     *  propio refresh reactivo — no competir por el refresh_token de un solo
     *  uso, solo abortar este paso. Si no, intentar refrescar acá; si el
     *  refresh mismo falla (refresh_token vencido o revocado), la sesión
     *  está realmente muerta: limpiarla para que los próximos ciclos corten
     *  de inmediato en vez de seguir pegándole al backend cada 5 min. */
    private fun shouldRetryWithRefresh(context: Context): Boolean {
        if (LifecycleManager.state == "FOREGROUND") return false
        when (refreshAccessToken(context)) {
            RefreshOutcome.OK -> return true
            RefreshOutcome.NETWORK_FAILURE -> {
                // No pudimos ni preguntar (backend caído/dormido — Render free
                // tira cold starts de 20-50s, y este ciclo corre cada 5 min sin
                // que el usuario esté mirando, así que es MUY probable pegarle
                // al backend recién despertando). El refresh token de 30 días
                // sigue guardado tal cual: el próximo ciclo reintenta solo.
                BineuralLog.d("alarmsync", "refresh: fallo de red, sesión intacta, reintenta en el próximo ciclo")
                return false
            }
            RefreshOutcome.REJECTED -> {
                // El servidor contestó que el refresh token NO sirve de verdad
                // (vencido/revocado): ahí sí la sesión está muerta.
                BineuralLog.e("alarmsync", "refresh: token rechazado por el servidor, limpiando estado nativo")
                AuthStore.clear(context)
                clearSynced(context)
                return false
            }
        }
    }

    private enum class RefreshOutcome { OK, NETWORK_FAILURE, REJECTED }

    private fun refreshAccessToken(context: Context): RefreshOutcome {
        val refreshToken = AuthStore.refreshToken(context) ?: return RefreshOutcome.REJECTED
        val body = JSONObject().put("refresh_token", refreshToken)
        val result = httpPost("${BuildConfig.API_BASE}/api/v1/auth/refresh", body)
        // code == -1 es httpPost's propio marcador de fallo de red/timeout (ver
        // HttpResult más abajo) — cualquier código HTTP real (incluido 401) es
        // un rechazo explícito del servidor, no un problema de conectividad.
        if (result.code == -1) return RefreshOutcome.NETWORK_FAILURE
        if (result.code !in 200..299 || result.body == null) return RefreshOutcome.REJECTED
        return try {
            val json = JSONObject(result.body)
            val newAccess = json.optString("access_token", null) ?: return RefreshOutcome.REJECTED
            val newRefresh = json.optString("refresh_token", null) ?: return RefreshOutcome.REJECTED
            AuthStore.saveTokens(context, newAccess, newRefresh)
            BineuralLog.d("alarmsync", "access token refrescado en background")
            RefreshOutcome.OK
        } catch (e: Exception) {
            BineuralLog.e("alarmsync", "refresh: respuesta inválida", e)
            RefreshOutcome.REJECTED
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    private fun syncPendingIntent(context: Context): PendingIntent {
        val i = Intent(context, AlarmSyncReceiver::class.java).setAction(ACTION_SYNC)
        return PendingIntent.getBroadcast(
            context,
            0x5A7, // request code fijo del ciclo
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun buildBody(config: JSONObject?, title: String): String {
        val freq = config?.optDouble("freq")
        return if (freq != null && freq > 0) {
            "Toca para iniciar tu sesión de ${Math.round(freq)} Hz."
        } else {
            "Hora de tu sesión en Vyneural."
        }
    }

    // 'FREQ=WEEKLY;BYDAY=MO,TH' → [1,4] (0=domingo … 6=sábado, como Date.getDay()).
    private val DAY_INDEX = mapOf(
        "MO" to 1, "TU" to 2, "WE" to 3, "TH" to 4, "FR" to 5, "SA" to 6, "SU" to 0,
    )

    private fun parseByDay(rrule: String?): List<Int>? {
        if (rrule.isNullOrBlank()) return null
        val m = Regex("BYDAY=([A-Za-z,]+)").find(rrule) ?: return null
        val days = m.groupValues[1].split(",")
            .mapNotNull { DAY_INDEX[it.trim().uppercase()] }
            .distinct()
        return if (days.isEmpty()) null else days
    }

    // ISO 8601 con offset ('2026-08-17T19:00:00+00:00', '…Z', con o sin milis).
    private fun parseIsoToMillis(iso: String): Long? {
        if (iso.isBlank()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
        )
        for (p in patterns) {
            try {
                val sdf = SimpleDateFormat(p, Locale.US)
                sdf.timeZone = TimeZone.getTimeZone("UTC")
                return sdf.parse(iso)?.time
            } catch (_: Exception) { /* probar el siguiente formato */ }
        }
        return null
    }

    // ── HTTP crudo (sin retry: eso lo maneja authorizedGet/Put arriba) ──────
    private class HttpResult(val code: Int, val body: String?)

    private fun httpGet(url: String, token: String): HttpResult {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            val code = conn.responseCode
            if (code !in 200..299) {
                BineuralLog.e("alarmsync", "GET $url → $code")
                return HttpResult(code, null)
            }
            HttpResult(code, BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() })
        } catch (e: Exception) {
            BineuralLog.e("alarmsync", "GET falló: ${e.message}")
            HttpResult(-1, null)
        } finally {
            conn?.disconnect()
        }
    }

    private fun httpPut(url: String, token: String, body: JSONObject): HttpResult {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "PUT"
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) BineuralLog.e("alarmsync", "PUT $url → $code")
            HttpResult(code, null)
        } catch (e: Exception) {
            BineuralLog.e("alarmsync", "PUT falló: ${e.message}")
            HttpResult(-1, null)
        } finally {
            conn?.disconnect()
        }
    }

    /** POST sin Authorization (el refresh se autentica con el refresh_token
     *  en el body, no con un Bearer). */
    private fun httpPost(url: String, body: JSONObject): HttpResult {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } }
            if (code !in 200..299) BineuralLog.e("alarmsync", "POST $url → $code")
            HttpResult(code, text)
        } catch (e: Exception) {
            BineuralLog.e("alarmsync", "POST falló: ${e.message}")
            HttpResult(-1, null)
        } finally {
            conn?.disconnect()
        }
    }
}
