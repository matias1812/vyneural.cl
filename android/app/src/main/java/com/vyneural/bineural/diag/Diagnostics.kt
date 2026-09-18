package com.vyneural.bineural.diag

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.vyneural.bineural.audio.AudioForegroundService
import com.vyneural.bineural.notifications.AlarmScheduler
import com.vyneural.bineural.notifications.NotificationHelper

/**
 * Estado global para la pantalla de diagnóstico y la sonda del bridge.
 * Los valores reales los escriben el servicio, el lifecycle y el bridge.
 */
object Diagnostics {

    @Volatile
    var lifecycle: String = "FOREGROUND"

    @Volatile
    var audioActive: Boolean = false

    @Volatile
    var focusState: String = "NONE"

    /** P2 — política de focus visible: veces que el watchdog re-solicitó el
     *  foco tras una pérdida/interrupción (incluido UNKNOWN). */
    @Volatile
    var focusReacquireCount: Int = 0

    /** P2 — política de focus visible: veces que se recibió un callback de
     *  Audio Focus NO reconocido (UNKNOWN, visible como tal, nunca pérdida
     *  genérica silenciosa). */
    @Volatile
    var focusUnknownCount: Int = 0

    /** MediaSession activa y reproduciendo (P1.5). */
    @Volatile
    var mediaSessionActive: Boolean = false

    /** 'playing' | 'paused' | 'stopped' — estado real de la MediaSession. */
    @Volatile
    var mediaSessionPlaybackState: String = "stopped"

    @Volatile
    var bridgeStatus: String = "UNAVAILABLE"

    /** Pantalla completa nativa (immersive mode) activa o no. */
    @Volatile
    var immersiveActive: Boolean = false

    @Volatile
    var lastError: String? = null

    // ── P5.4 — instrumentación causal ─────────────────────────────────────────
    // Cada comando, cambio de focus y restart queda en un anillo con timestamp:
    // si "se activa sola", la traza dice EXACTAMENTE qué componente emitió el
    // primer PLAY (y su generación de servicio).
    private val causalRing = java.util.ArrayDeque<String>()
    private const val MAX_CAUSAL = 80

    /** Generación del servicio (++ en cada onCreate): identifica recreaciones. */
    @Volatile
    var serviceStartId: Long = 0L

    @Synchronized
    fun trace(kind: String, detail: String) {
        val ts = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
        causalRing.addLast("[${ts}] gen=${serviceStartId} [$kind] $detail")
        while (causalRing.size > MAX_CAUSAL) causalRing.removeFirst()
    }

    @Synchronized
    fun causalLog(): List<String> = causalRing.toList()

    /** Texto legible de la pantalla de diagnóstico. */
    fun snapshot(context: Context): String {
        val b = StringBuilder()
        b.appendLine("BINEURAL — DIAGNÓSTICO ANDROID")
        b.appendLine("==============================")
        b.appendLine("Platform: Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        b.appendLine("App: ${context.packageName} ${com.vyneural.bineural.BuildConfig.VERSION_NAME}")
        b.appendLine()
        b.appendLine("BRIDGE: $bridgeStatus")
        b.appendLine("LIFECYCLE: $lifecycle")
        b.appendLine()
        b.appendLine("AUDIO:")
        b.appendLine("  Service running: ${AudioForegroundService.isRunning(context)}")
        b.appendLine("  Audio active: $audioActive")
        b.appendLine("  Focus: $focusState (re-adquisiciones del watchdog: $focusReacquireCount, callbacks UNKNOWN: $focusUnknownCount)")
        b.appendLine("  MediaSession: ${if (mediaSessionActive) "ACTIVE" else "INACTIVE"} ($mediaSessionPlaybackState)")
        b.appendLine("  Service generation: $serviceStartId")
        b.appendLine()
        b.appendLine("NOTIFICATIONS:")
        val perm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PackageManager.PERMISSION_GRANTED
        }
        b.appendLine("  POST_NOTIFICATIONS: ${if (perm == PackageManager.PERMISSION_GRANTED) "GRANTED" else "NOT GRANTED"}")
        b.appendLine("  Channel player: ${if (channelExists(context, "bineural_player")) "YES" else "NO"}")
        // Antes comparaba contra el string legado "bineural_alarms" (previo al
        // versionado v2+) — siempre reportaba NO sin importar el estado real
        // del canal vigente. Usa la constante actual, la misma que crea
        // ensureChannels() y consulta alarmChannelDiagnostics().
        b.appendLine("  Channel alarms: ${if (channelExists(context, NotificationHelper.CHANNEL_ALARMS)) "YES" else "NO"}")
        b.appendLine()
        b.appendLine("ALARMS:")
        val s = AlarmScheduler(context)
        b.appendLine("  Scheduled: ${s.list().size}")
        b.appendLine("  Exact allowed: ${s.canScheduleExact()}")
        b.appendLine("  Next: ${s.nextAt()?.let { java.text.DateFormat.getDateTimeInstance().format(it) } ?: "—"}")
        b.appendLine()
        b.appendLine("LAST ERROR: ${lastError ?: "—"}")
        b.appendLine()
        b.appendLine("CAUSAL TRACE (últimas ${causalLog().size}):")
        causalLog().forEach { b.appendLine("  $it") }
        return b.toString()
    }

    private fun channelExists(context: Context, id: String): Boolean {
        return runCatching {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) true
            else {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                nm.getNotificationChannel(id) != null
            }
        }.getOrDefault(false)
    }
}
