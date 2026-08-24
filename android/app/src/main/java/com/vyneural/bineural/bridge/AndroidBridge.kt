package com.vyneural.bineural.bridge

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import android.webkit.JavascriptInterface
import com.vyneural.bineural.BuildConfig
import com.vyneural.bineural.MainActivity
import com.vyneural.bineural.audio.AudioForegroundService
import com.vyneural.bineural.diag.Diagnostics
import com.vyneural.bineural.notifications.AlarmScheduler
import com.vyneural.bineural.notifications.NotificationHelper
import com.vyneural.bineural.permissions.PermissionManager
import com.vyneural.bineural.sync.AlarmSync
import com.vyneural.bineural.util.AuthStore
import com.vyneural.bineural.util.BineuralLog
import com.vyneural.bineural.util.DeviceId
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bridge WebView → Kotlin. Implementa el contrato de
 * `src/platform/native-bridge.js`:
 *
 *   window.AndroidBridge = {
 *     version, postMessage(msg), getPlatformInfo()
 *   }
 *
 * Reglas del P0 gate: whitelist, payload validado, estados honestos
 * (supported / granted / active nunca se confunden) y aislamiento de fallos
 * (un error aquí nunca rompe la UI web).
 */
class AndroidBridge(
    private val activity: MainActivity,
    private val scheduler: AlarmScheduler,
    private val permissions: PermissionManager,
) {
    private val context: Context = activity
    @JavascriptInterface
    fun getVersion(): String = "1.0.0"

    /** Capacidades REALES de esta instalación (supported/granted/active). */
    @JavascriptInterface
    fun getPlatformInfo(): String {
        val audioRunning = AudioForegroundService.isRunning(context)
        val info = JSONObject()
        info.put("platform", "android")
        info.put("appVersion", BuildConfig.VERSION_NAME)
        info.put("nativeAudio", true)
        // MediaSession REAL (P1.5): supported es estático (la clase está en el
        // APK), active/playbackState reflejan el estado REAL del servicio —
        // nunca se declara activa una sesión que no existe.
        info.put("mediaSession", true)
        info.put("mediaSessionActive", AudioForegroundService.mediaSessionActive())
        info.put("mediaSessionPlaybackState", AudioForegroundService.mediaPlaybackState())
        // v1.2 — skip/seek también cambian la FRECUENCIA (adelantar/retroceder).
        info.put("mediaSessionControls", JSONArray(listOf("play", "pause", "stop", "next", "previous")))
        info.put("notifications", true)
        info.put("notificationPermission", permissions.notificationState())
        // Dispositivo estable (mismo ID que usa el worker de sync en 2.º
        // plano): la web lo usa para reportar PUT /devices/me con un solo ID.
        info.put("deviceId", DeviceId.get(context))
        info.put("alarmScheduler", true)
        // P5 — conteo REAL de alarmas pendientes (las programadas en
        // AlarmManager y aún no disparadas); 0 no significa "sin función".
        info.put("alarmCount", runCatching { scheduler.list().size }.getOrDefault(0))
        info.put("exactAlarms", scheduler.canScheduleExact())
        info.put("exactAlarmsGranted", scheduler.canScheduleExact())
        // Sin esta excepción, el ciclo de sincronización en 2.º plano
        // (AlarmSync, cada ~5 min) puede quedar suspendido por el fabricante
        // y un recordatorio creado en la web no llega al reloj nativo hasta
        // que el usuario abre la app (bug real reportado en vivo).
        info.put("batteryUnrestricted", isIgnoringBatteryOptimizations())
        // Fabricantes con gestor de "inicio automático" propio (MIUI, EMUI,
        // ColorOS, FuntouchOS, OxygenOS): matan alarmas al deslizar la app de
        // recientes aunque la app esté en la whitelist de batería estándar.
        // Ver OemAutostart — sin API pública, es best-effort por fabricante.
        info.put("needsAutostartGuidance", com.vyneural.bineural.permissions.OemAutostart.needsGuidance())
        info.put("manufacturer", com.vyneural.bineural.permissions.OemAutostart.manufacturer())
        info.put("retuneNative", true)
        info.put("backgroundService", true)
        info.put("backgroundServiceActive", audioRunning)
        info.put("focusState", Diagnostics.focusState)
        // P2 — política de focus visible en el diagnóstico: contadores reales
        // del watchdog y de callbacks no reconocidos (UNKNOWN).
        info.put("focusReacquireCount", Diagnostics.focusReacquireCount)
        info.put("focusUnknownCount", Diagnostics.focusUnknownCount)
        info.put("fullscreen", Diagnostics.immersiveActive)
        return info.toString()
    }

    @SuppressLint("NewApi")
    @JavascriptInterface
    fun postMessage(raw: String): String {
        return try {
            val msg = JSONObject(raw)
            val command = msg.optString("command", "")
            val payload = msg.optJSONObject("payload")
            if (!BridgeCommands.isAllowed(command)) return respond("DENIED", command, null)
            when (command) {
                "GET_PLATFORM_CAPABILITIES" -> getPlatformInfo() // handshake: la info directa
                "START_BACKGROUND_AUDIO" -> {
                    val base = payload?.optDouble("base", 220.0) ?: 220.0
                    val beat = payload?.optDouble("beat", 6.0) ?: 6.0
                    val wave = payload?.optString("wave", "sine") ?: "sine"
                    val title = payload?.optString("title", "Sesión Vyneural") ?: "Sesión Vyneural"
                    // P4-D — el nivel llega en el START: el motor nativo arranca
                    // con el volumen del usuario (no 0.6) y no hay overshoot.
                    val level = payload?.optDouble("level", -1.0) ?: -1.0
                    AudioForegroundService.start(context, base, beat, title, level)
                    if (wave.isNotEmpty()) AudioForegroundService.setWave(context, wave)
                    respond("OK", command, null)
                }
                "RETUNE_BACKGROUND_AUDIO" -> {
                    val base = payload?.optDouble("base", 220.0) ?: 220.0
                    val beat = payload?.optDouble("beat", 6.0) ?: 6.0
                    val wave = payload?.optString("wave", "") ?: ""
                    val w: String? = if (wave.isNotEmpty()) wave else null
                    AudioForegroundService.retune(context, base, beat, w)
                    respond("OK", command, null)
                }
                "SET_WAVE" -> {
                    val wave = payload?.optString("wave", "sine") ?: "sine"
                    AudioForegroundService.setWave(context, wave)
                    respond("OK", command, null)
                }
                "SET_AUDIO_LEVEL" -> {
                    val level = payload?.optDouble("level", -1.0) ?: -1.0
                    if (level in 0.0..1.0) AudioForegroundService.setVolume(context, level)
                    respond("OK", command, null)
                }
                "PAUSE_BACKGROUND_AUDIO" -> {
                    AudioForegroundService.pause(context)
                    respond("OK", command, null)
                }
                "RESUME_BACKGROUND_AUDIO" -> {
                    AudioForegroundService.resume(context)
                    respond("OK", command, null)
                }
                "STOP_BACKGROUND_AUDIO" -> {
                    AudioForegroundService.stop(context)
                    respond("OK", command, null)
                }
                "SCHEDULE_ALARM" -> {
                    val id = payload?.optString("alarmId") ?: return respond("INVALID", command, null)
                    val title = payload.optString("title", "Vyneural")
                    val body = payload.optString("body", "Hora de tu sesión")
                    val at = payload.optLong("atMs", 0L)
                    if (id.isEmpty() || at <= 0L) return respond("INVALID", command, null)
                    // P5 — rutina: días de repetición (0=domingo … 6=sábado).
                    // Vacío/ausente = una sola vez.
                    val daysArr = payload.optJSONArray("days")
                    val days =
                        if (daysArr != null && daysArr.length() > 0) (0 until daysArr.length()).map { daysArr.optInt(it) }
                        else null
                    // Deep link: al tocar la notificación, MainActivity abre esta
                    // frecuencia exacta (ver main.js scheduleNativeAlarm).
                    val freq = if (payload.has("freq")) payload.optDouble("freq") else null
                    val beat = if (payload.has("beat")) payload.optDouble("beat") else null
                    val wave = if (payload.has("wave")) payload.optString("wave") else null
                    scheduler.schedule(id, title, body, at, days, freq, beat, wave)
                    respond("OK", command, null)
                }
                "CANCEL_ALARM" -> {
                    val id = payload?.optString("alarmId") ?: return respond("INVALID", command, null)
                    scheduler.cancel(id)
                    respond("OK", command, null)
                }
                "REQUEST_NOTIFICATION_PERMISSION" -> {
                    permissions.requestNotifications()
                    respond("OK", command, null)
                }
                "REQUEST_EXACT_ALARM_PERMISSION" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        try {
                            context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM))
                        } catch (e: Exception) {
                            BineuralLog.e("bridge", "exact alarm settings", e)
                        }
                    }
                    respond("OK", command, null)
                }
                "REQUEST_AUTOSTART_SETTINGS" -> {
                    com.vyneural.bineural.permissions.OemAutostart.openSettings(context)
                    respond("OK", command, null)
                }
                "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" -> {
                    try {
                        val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(Uri.parse("package:${context.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(i)
                    } catch (e: Exception) {
                        BineuralLog.e("bridge", "battery optimization settings", e)
                    }
                    respond("OK", command, null)
                }
                "OPEN_EXPERIMENT" -> {
                    // La app ya está abierta; enfocar (la sesión la controla la web).
                    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
                    launch?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    if (launch != null) context.startActivity(launch)
                    respond("OK", command, null)
                }
                "GET_AUDIO_STATE" -> {
                    val d = JSONObject()
                        .put("provider", "native")
                        .put("audioActive", Diagnostics.audioActive)
                        .put("serviceRunning", AudioForegroundService.isRunning(context))
                        .put("focusState", Diagnostics.focusState)
                        .put("focusReacquireCount", Diagnostics.focusReacquireCount)
                        .put("focusUnknownCount", Diagnostics.focusUnknownCount)
                        .put("playbackState", Diagnostics.mediaSessionPlaybackState)
                    // P4-B — parámetros de la sesión nativa en curso: la UI web
                    // los usa para re-sincronizarse tras navegar (nunca inventa
                    // estado y nunca re-arranca la sesión). Leídos de la sesión
                    // persistida por el servicio (siempre al día: cada comando
                    // llama persistSession()).
                    runCatching {
                        val p = context.getSharedPreferences(AudioForegroundService.PREFS_SESSION, Context.MODE_PRIVATE)
                        d.put("base", p.getFloat("base", 0f).toDouble())
                        d.put("beat", p.getFloat("beat", 0f).toDouble())
                        d.put("wave", p.getString("wave", "") ?: "")
                        d.put("volume", p.getFloat("volume", 0.6f).toDouble())
                        d.put("title", p.getString("title", "Sesión Vyneural") ?: "Sesión Vyneural")
                    }
                    respond("OK", command, d)
                }
                "GET_MEDIA_SESSION_STATE" -> {
                    val d = JSONObject()
                        .put("supported", true)
                        .put("active", AudioForegroundService.mediaSessionActive())
                        .put("playbackState", AudioForegroundService.mediaPlaybackState())
                        // v1.2 — skip/seek = adelantar/retroceder la frecuencia.
                        .put("controls", JSONArray(listOf("play", "pause", "stop", "next", "previous")))
                    respond("OK", command, d)
                }
                "GET_NAV_STATE" -> {
                    // P4-B — traza de navegación para /diagnostico: página
                    // actual, historial manual y estado del BACK.
                    respond("OK", command, runCatching { JSONObject(activity.navState()) }.getOrNull())
                }
                "OPEN_NOTIFICATION_SETTINGS" -> {
                    // Abre los ajustes de NOTIFICACIONES de esta app (Android
                    // 8+). Fallback: ajustes generales de la aplicación.
                    try {
                        val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(i)
                        respond("OK", command, null)
                    } catch (e: Exception) {
                        BineuralLog.e("bridge", "open notif settings", e)
                        try {
                            val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                            i.data = Uri.parse("package:${context.packageName}")
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            context.startActivity(i)
                            respond("OK", command, null)
                        } catch (e2: Exception) {
                            BineuralLog.e("bridge", "open app settings fallback", e2)
                            respond("BRIDGE_ERROR", command, null)
                        }
                    }
                }
                "OPEN_SETTINGS" -> {
                    try {
                        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        i.data = Uri.parse("package:${context.packageName}")
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(i)
                    } catch (e: Exception) {
                        BineuralLog.e("bridge", "open settings", e)
                        return respond("BRIDGE_ERROR", command, null)
                    }
                    respond("OK", command, null)
                }
                "SET_FULLSCREEN" -> {
                    val enabled = payload?.optBoolean("enabled", true) ?: true
                    activity.setImmersiveMode(enabled)
                    respond("OK", command, null)
                }
                "SET_ORIENTATION" -> {
                    val mode = payload?.optString("mode", "sensor") ?: "sensor"
                    activity.setOrientation(mode)
                    respond("OK", command, null)
                }
                "TEST_NOTIFICATION" -> {
                    NotificationHelper.showAlarm(context, "Vyneural · Prueba", "Notificaciones funcionando (diagnóstico).")
                    respond("OK", command, null)
                }
                // M1 — fin de sesión nativo: cuando el temporizador web termina con la
                // app en segundo plano, la WebView no puede mostrar new Notification();
                // la notificación REAL la publica el sistema (id propio, canal propio).
                "SESSION_END" -> {
                    val title = payload?.optString("title", "Vyneural") ?: "Vyneural"
                    val body = payload?.optString("body", "Tu sesión ha terminado.") ?: "Tu sesión ha terminado."
                    NotificationHelper.showSessionEnd(context, title, body)
                    respond("OK", command, null)
                }
                "STORE_AUTH" -> {
                    // La sesión del WebView se guarda para el worker de
                    // sincronización en segundo plano (alarmas del servidor +
                    // reporte de dispositivo). Al iniciar sesión se sincroniza
                    // de inmediato, sin esperar el ciclo periódico.
                    AuthStore.save(
                        context,
                        payload?.optString("access_token", null),
                        payload?.optString("refresh_token", null),
                        payload?.optString("user_id", null),
                        payload?.optString("email", null),
                    )
                    AlarmSync.run(context)
                    respond("OK", command, null)
                }
                "CLEAR_AUTH" -> {
                    AuthStore.clear(context)
                    AlarmSync.clearSynced(context)
                    respond("OK", command, null)
                }
                "SYNC_ALARMS" -> {
                    // La web creó/editó/borró un recordatorio o un paso de
                    // itinerario con horario: resincronizar YA en vez de
                    // esperar el ciclo periódico (~5 min) — si el horario
                    // elegido cae antes de ese próximo ciclo, la alarma
                    // nativa nunca se programa (ver AlarmSync.syncAlarms:
                    // scheduled_at ya vencido → se descarta en silencio).
                    AlarmSync.run(context)
                    respond("OK", command, null)
                }
                "API_REQUEST" -> {
                    // HTTP nativo (sin CORS): el WebView de la APK carga desde
                    // file:// (origen opaco → Origin: null) y el backend no puede
                    // listar "null" en CORS de forma confiable. Así el login y el
                    // resto de las llamadas del WebView funcionan SIEMPRE, sin
                    // depender de la configuración CORS del servidor.
                    val id = payload?.optLong("id", -1L) ?: -1L
                    val path = payload?.optString("path", "") ?: ""
                    if (id < 0 || path.isEmpty()) return respond("INVALID", command, null)
                    val method = (payload?.optString("method", "GET") ?: "GET").uppercase()
                    val body = if (payload != null && payload.has("body") && !payload.isNull("body")) payload.getString("body") else null
                    val headers = payload?.optJSONObject("headers")
                    // ACK inmediato (el JS ya registró el resolver por id) y la
                    // llamada HTTP corre en un hilo aparte: nunca se bloquea el
                    // hilo del bridge ni la UI. El resultado vuelve al JS por
                    // evaluateJavascript (pushToWeb postea al hilo del WebView).
                    Thread {
                        val result = runCatching { httpRequest(method, path, body, headers) }
                            .getOrElse { JSONObject().put("error", it.message ?: "request failed") }
                        activity.pushToWeb("window.__vyneuralApiResponse($id, ${JSONObject.quote(result.toString())})")
                    }.start()
                    respond("ACCEPTED", command, JSONObject().put("id", id))
                }
                "SAVE_ICS" -> {
                    // Guarda el .ics del recordatorio en Descargas. El DownloadManager
                    // no puede bajar blob: URLs (son internas del renderer), así que
                    // la web manda el contenido por el bridge y se escribe directo.
                    val name = payload?.optString("fileName", "vyneural-recordatorio.ics") ?: "vyneural-recordatorio.ics"
                    val content = payload?.optString("content", "") ?: ""
                    if (content.isEmpty()) return respond("INVALID", command, null)
                    val replaced = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
                    val safeName = if (replaced.isEmpty()) "vyneural-recordatorio.ics" else replaced
                    try {
                        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                        val file = File(dir, safeName)
                        file.parentFile?.mkdirs()
                        file.writeText(content, Charsets.UTF_8)
                        // Notificar a la galería/gestor de archivos y al usuario.
                        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf("text/calendar"), null)
                        BineuralLog.d("bridge", "ICS guardado: ${file.absolutePath}")
                        val data = JSONObject().put("path", file.absolutePath).put("fileName", safeName)
                        respond("OK", command, data)
                    } catch (e: Exception) {
                        BineuralLog.e("bridge", "no se pudo guardar el .ics", e)
                        respond("BRIDGE_ERROR", command, null)
                    }
                }
                else -> respond("DENIED", command, null)
            }
        } catch (e: Exception) {
            // Aislamiento de fallos: el error se reporta, la web sigue.
            BineuralLog.e("bridge", "postMessage error", e)
            Diagnostics.lastError = e.message
            respond("BRIDGE_ERROR", null, null)
        }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun respond(status: String, command: String?, data: JSONObject?): String {
        val r = JSONObject()
        r.put("status", status)
        if (command != null) r.put("command", command)
        if (data != null) r.put("data", data)
        return r.toString()
    }

    // ── HTTP nativo para API_REQUEST ─────────────────────────────────────────
    private fun httpRequest(method: String, path: String, body: String?, headers: JSONObject?): JSONObject {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(BuildConfig.API_BASE + path).openConnection() as HttpURLConnection
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 25_000
            conn.setRequestProperty("Accept", "application/json")
            if (headers != null) {
                val it = headers.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    val v = headers.optString(k, "")
                    if (v.isNotEmpty()) conn.setRequestProperty(k, v)
                }
            }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val text = try {
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                if (stream == null) "" else BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
            } catch (e: Exception) {
                ""
            }
            JSONObject().put("status", code).put("body", text)
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "request failed")
        } finally {
            conn?.disconnect()
        }
    }
}
