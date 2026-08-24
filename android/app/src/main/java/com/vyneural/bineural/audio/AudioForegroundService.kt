package com.vyneural.bineural.audio

import android.app.ActivityManager
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import com.vyneural.bineural.diag.Diagnostics
import com.vyneural.bineural.notifications.NotificationHelper
import com.vyneural.bineural.util.BineuralLog

/**
 * Foreground Service de audio (P1): mantiene la reproducción con la app en
 * segundo plano o la pantalla bloqueada. UN solo motor (BinauralToneEngine).
 * Comandos: START / PAUSE / RESUME / STOP / FREQ (retune en vivo) / PLAY.
 *
 * MediaSession real (P1.5): el servicio expone una MediaSession Android que el
 * SO conecta con los controles de la pantalla de bloqueo, el sombreado de
 * notificaciones, los auriculares y el centro multimedia. PlaybackState y
 * MediaMetadata reflejan el estado REAL del motor (nunca declarados sin
 * implementación).
 */
class AudioForegroundService : Service() {

    private val engine = BinauralToneEngine()
    private var focus: AudioFocusHelper? = null
    private var mediaSession: MediaSession? = null
    private var sessionTitle = "Sesión Vyneural"
    private var lastBase = 220.0
    private var lastBeat = 6.0
    // P2 — defensa de audio focus: `shouldPlay` = la sesión DEBERÍA estar
    // sonando. Si el foco se pierde (otra app, el propio WebView de la APK
    // reclamándolo al desbloquear) el servicio pausa y la MediaSession lo
    // refleja; un watchdog re-solicita el foco con backoff mientras shouldPlay
    // y al recuperarlo reanuda el MISMO motor (nunca una segunda sesión).
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var shouldPlay = false
    private var focusRetryRunnable: Runnable? = null
    private var focusRetryDelayMs = 1_200L
    // P3 — crash recovery: la sesión de audio se persiste en SharedPreferences
    // para que un restart START_STICKY (proceso eliminado por el SO mientras
    // sonaba) la restaure con las MISMAS frecuencias/onda/volumen — nunca
    // arranca con los defaults y la notificación nunca miente.
    private var lastWave = ""
    private var lastVolume = 0.6

    override fun onCreate() {
        super.onCreate()
        // P5.4 — cada recreación del servicio tiene un id propio: si algo
        // "se activa solo", la traza causal dice QUÉ servicio (generación)
        // emitió el primer PLAY.
        Diagnostics.serviceStartId += 1
        Diagnostics.trace("service", "created generation=${Diagnostics.serviceStartId}")
        focus = AudioFocusHelper(this, engine) { label ->
            onFocusStateChange?.invoke(label)
            handleFocusChange(label)
        }
        mediaSession = MediaSession(this, "Vyneural").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = handleSystemPlay()
                override fun onPause() = handleSystemPause()
                override fun onStop() = handleSystemStop()
                // Adelantar/retroceder la FRECUENCIA desde los controles del SO
                // (auriculares, pantalla de bloqueo, centro multimedia): cada
                // salto mueve la portadora ±10 Hz (clamp 60–400, como el slider
                // de la web) manteniendo el latido, con retune real del motor.
                override fun onSkipToNext() = stepFrequency(+FREQ_STEP_HZ)
                override fun onSkipToPrevious() = stepFrequency(-FREQ_STEP_HZ)
                // El seek de la barra se traduce al mismo control: adelante =
                // subir frecuencia, atrás = bajar (el tono es continuo, no hay
                // posición temporal que buscar).
                override fun onSeekTo(pos: Long) {
                    val now = android.os.SystemClock.elapsedRealtime()
                    stepFrequency(if (pos >= now) +FREQ_STEP_HZ else -FREQ_STEP_HZ)
                }
            })
            setActive(false)
        }
    }

    // ── P2 — gestión de interrupciones de audio focus ─────────────────────────
    // LOSS/LOSS_TRANSIENT: el motor pausó (AudioFocusHelper); la MediaSession y
    // la notificación reflejan la interrupción REAL (PAUSED) — pero NO se
    // empuja el evento de playback al JS: la sesión web (visualizador) sigue
    // viva y el JS ya recibe `vyneural:audiofocus` LOSS (INTERRUPTED). Empujar
    // "paused" haría pauseUiOnly() → teardown de la sesión → al recuperar foco
    // un "playing" re-arranca → bucle de sesión (sid++ por ciclo, observado en
    // el forense). Si la sesión debería seguir sonando, el watchdog re-solicita
    // foco con backoff. GAIN: reanuda el MISMO motor (nunca una segunda sesión).
    private fun handleFocusChange(label: String) {
        Diagnostics.trace(
            "focus",
            "$label {running=$running shouldPlay=$shouldPlay media=${Diagnostics.mediaSessionPlaybackState} " +
                "focusHeld=${focus?.held}",
        )
        when (label) {
            "LOSS", "LOSS_TRANSIENT" -> {
                if (shouldPlay && running) setSessionPlaying(playing = false, pushToJs = false)
                // REGLA DE ORO — bug real reportado en vivo: una llamada
                // entrante interrumpe (LOSS/LOSS_TRANSIENT), termina, el foco
                // se recupera (GAIN) y la sesión volvía a sonar SOLA porque
                // `shouldPlay` seguía en true — GAIN la reanudaba automático
                // más abajo. Android no distingue acá un blip de una llamada
                // real: cualquier interrupción debe exigir un gesto explícito
                // para volver a sonar, nunca reanudar sola al recuperar foco.
                shouldPlay = false
                cancelFocusReacquire()
            }
            // P2 — endurecimiento UNKNOWN: un callback no reconocido NO se
            // transforma en pérdida genérica silenciosa. Queda visible como
            // UNKNOWN en Diagnostics (observabilidad) y entra en la MISMA
            // política defensiva que LOSS: pausa y NO se reanuda sola. El
            // diagnóstico CRITICAL queda registrado en el log forense.
            "UNKNOWN" -> {
                BineuralLog.e(
                    "audio-focus",
                    "UNKNOWN focus callback — política defensiva: pausa, sin auto-resume (CRITICAL)",
                )
                // P2 — el UNKNOWN queda CONTADO y visible en el diagnóstico:
                // nunca se transforma en pérdida genérica silenciosa.
                Diagnostics.focusUnknownCount += 1
                if (shouldPlay && running) setSessionPlaying(playing = false, pushToJs = false)
                shouldPlay = false
                cancelFocusReacquire()
            }
            "GAIN" -> {
                // H7 — el foco se recuperó: volver al reintento rápido por si
                // vuelve a perderse (unlock, próximo gesto del WebView).
                // shouldPlay ya quedó en false tras cualquier LOSS/UNKNOWN (ver
                // arriba) — GAIN NUNCA vuelve a arrancar audio por su cuenta;
                // el próximo play tiene que ser un gesto real del usuario.
                focusRetryDelayMs = 1_200L
            }
            // "DUCK": el foco SIGUE poseído (held=true); AudioFocusHelper ya
            // aplicó engine.duck(true). No pausar, no tocar shouldPlay.
        }
    }

    private fun scheduleFocusReacquire() {
        if (!shouldPlay || focusRetryRunnable != null) return
        // P2 — cada intento de re-adquisición queda contado (diagnóstico).
        Diagnostics.focusReacquireCount += 1
        focusRetryRunnable = Runnable {
            focusRetryRunnable = null
            if (!shouldPlay) return@Runnable
            val f = focus ?: return@Runnable
            if (!f.held) {
                f.request()
                // request() informa GAIN por el código de retorno si el SO
                // concede (aunque el callback no llegue); si no, reintentar.
                if (!f.held) scheduleFocusReacquire()
            }
        }
        handler.postDelayed(focusRetryRunnable!!, focusRetryDelayMs)
        // H7 — backoff exponencial con tope: durante una interrupción LARGA
        // real (llamada en curso), el watchdog no debe spamear request() cada
        // 1.2 s (el SO no concederá GAIN hasta colgar). Se resetea al recibir
        // GAIN o al arrancar/reanudar. La recuperación tras colgar sigue siendo
        // ≤5 s (primer reintento a 1.2 s en el caso rápido del unlock).
        focusRetryDelayMs = (focusRetryDelayMs * 2).coerceAtMost(5_000L)
    }

    private fun cancelFocusReacquire() {
        focusRetryRunnable?.let { handler.removeCallbacks(it) }
        focusRetryRunnable = null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        // startForeground incondicional: todo arranque pasa por startForegroundService
        // (que exige llamar a startForeground en <5s) y un restart llega con intent
        // nulo — sin reafirmar el foreground, Android 12+ mata la app con
        // ForegroundServiceDidNotStartInTimeException.
        startForegroundCompat()

        // P5.1 — kill-switch de reproducción espontánea: un restart del servicio
        // tras la muerte del proceso (intent null) NUNCA reanuda audio por sí solo.
        // La sesión persistida (frecuencias, onda, volumen, título) se conserva
        // para el próximo comando explícito, pero un shouldPlay persistido JAMÁS
        // se convierte en engine.start(). El único camino a PLAYING es un comando
        // explícito (USER_PLAY / MEDIA_PLAY / USER_RESUME).
        if (intent == null) {
            handleNullIntentRestart()
            return START_NOT_STICKY
        }

        Diagnostics.trace(
            "cmd",
            "$action startId=$startId before{running=$running shouldPlay=$shouldPlay " +
                "media=${Diagnostics.mediaSessionPlaybackState} focus=${Diagnostics.focusState}",
        )

        when (action) {
            ACTION_START -> {
                val base = intent.getDoubleExtra(EXTRA_BASE, 220.0)
                val beat = intent.getDoubleExtra(EXTRA_BEAT, 6.0)
                val title = intent.getStringExtra(EXTRA_TITLE)
                val level = intent.getDoubleExtra(EXTRA_LEVEL, -1.0)
                if (!title.isNullOrEmpty()) sessionTitle = title
                engine.retune(base, beat)
                // P4-D — el motor arranca con el nivel del USUARIO (no el
                // default 0.6): aplicar el volumen ANTES de engine.start().
                // Si el SET_AUDIO_LEVEL llega después, el fade-in arranca al
                // default y hace un overshoot breve audible al pulsar play con
                // otro nivel de volumen.
                if (level in 0.0..1.0) {
                    engine.setVolume(level)
                    lastVolume = level
                }
                shouldPlay = true
                focus?.request()
                engine.start()
                // Resume restaura la ganancia si el motor estaba en pausa
                // (lock screen): sin esto un play web tras una pausa nativa
                // quedaría mudo.
                engine.resume()
                running = true
                Diagnostics.audioActive = true
                lastBase = base
                lastBeat = beat
                setSessionPlaying(playing = true)
                refreshPlayerNotification()
                persistSession()
            }
            ACTION_PAUSE -> {
                shouldPlay = false
                cancelFocusReacquire()
                engine.pause()
                running = false
                Diagnostics.audioActive = false
                setSessionPlaying(playing = false)
                refreshPlayerNotification()
                persistSession()
            }
            ACTION_RESUME, ACTION_PLAY -> {
                shouldPlay = true
                focus?.request()
                // P5.2 — RESUME sobre un motor DETENIDO no puede dejar un motor
                // mudo con la notificación "playing": si el motor no está
                // sonando, se arranca con los parámetros de la última sesión
                // (retune + start), igual que el play de la MediaSession.
                if (!engine.isPlaying()) {
                    engine.retune(lastBase, lastBeat)
                    engine.start()
                }
                engine.resume()
                running = true
                Diagnostics.audioActive = true
                setSessionPlaying(playing = true)
                refreshPlayerNotification()
                persistSession()
            }
            ACTION_FREQ -> {
                val base = intent.getDoubleExtra(EXTRA_BASE, 0.0)
                val beat = intent.getDoubleExtra(EXTRA_BEAT, 0.0)
                if (base > 0.0) engine.retune(base, beat)
                val wave = intent.getStringExtra(EXTRA_WAVE)
                if (!wave.isNullOrEmpty()) {
                    engine.setWave(wave)
                    lastWave = wave
                }
                if (base > 0.0) {
                    lastBase = base
                    lastBeat = beat
                    refreshPlayerNotification()
                }
                persistSession()
            }
            ACTION_WAVE -> {
                val wave = intent.getStringExtra(EXTRA_WAVE)
                if (!wave.isNullOrEmpty()) {
                    engine.setWave(wave)
                    lastWave = wave
                    persistSession()
                }
            }
            ACTION_VOLUME -> {
                val level = intent.getDoubleExtra(EXTRA_LEVEL, 0.6)
                engine.setVolume(level)
                lastVolume = level
                persistSession()
            }
            ACTION_SKIP_NEXT -> stepFrequency(+FREQ_STEP_HZ)
            ACTION_SKIP_PREV -> stepFrequency(-FREQ_STEP_HZ)
            ACTION_STOP -> {
                shouldPlay = false
                cancelFocusReacquire()
                focus?.abandon()
                engine.stop()
                stopForegroundCompat()
                stopSelf()
                running = false
                Diagnostics.audioActive = false
                setSessionStopped()
                clearSession()
            }
        }
        Diagnostics.trace(
            "cmd",
            "$action done{startId=$startId running=$running shouldPlay=$shouldPlay " +
                "media=${Diagnostics.mediaSessionPlaybackState} focus=${Diagnostics.focusState}",
        )
        // P5.1 — START_NOT_STICKY: si el SO mata el proceso, NO se recrea el
        // servicio (y por tanto nunca puede reanudar audio solo).
        return START_NOT_STICKY
    }

    // ── Controles del sistema (MediaSession callback) ─────────────────────────
    // La pantalla de bloqueo / notificaciones / Bluetooth invocan estos
    // handlers; siempre actúan sobre el MISMO motor (nunca crean otro) y
    // actualizan la notificación para reflejar el estado real.
    private fun handleSystemPlay() {
        Diagnostics.trace("media", "MEDIA_PLAY before{running=$running}")
        shouldPlay = true
        if (!running || !engine.isPlaying()) {
            engine.retune(lastBase, lastBeat)
            engine.start()
            focus?.request()
        } else {
            focus?.request()
            engine.resume()
        }
        running = true
        Diagnostics.audioActive = true
        setSessionPlaying(playing = true)
        refreshPlayerNotification()
        persistSession()
    }

    private fun handleSystemPause() {
        Diagnostics.trace("media", "MEDIA_PAUSE before{running=$running}")
        shouldPlay = false
        cancelFocusReacquire()
        engine.pause()
        running = false
        Diagnostics.audioActive = false
        setSessionPlaying(playing = false)
        refreshPlayerNotification()
        persistSession()
    }

    private fun handleSystemStop() {
        Diagnostics.trace("media", "MEDIA_STOP before{running=$running}")
        shouldPlay = false
        cancelFocusReacquire()
        focus?.abandon()
        engine.stop()
        setSessionStopped()
        stopForegroundCompat()
        stopSelf()
        running = false
        Diagnostics.audioActive = false
        clearSession()
    }

    // ── Frecuencia desde los controles del sistema (skip/seek) ────────────────
    // Mueve la portadora en pasos de 10 Hz (60–400, mismos límites que el
    // slider personalizado de la web) manteniendo el latido y la onda. Retunea
    // el MISMO motor, actualiza metadata/notificación y avisa al JS para que la
    // UI de la WebView quede sincronizada (evento 'vyneural:audiofreq').
    private fun stepFrequency(deltaHz: Double) {
        if (deltaHz == 0.0) return
        Diagnostics.trace("media", "FREQ_STEP $deltaHz before{base=$lastBase beat=$lastBeat}")
        val nextBase = (lastBase + deltaHz).coerceIn(60.0, 400.0)
        if (nextBase == lastBase) return
        lastBase = nextBase
        engine.retune(lastBase, lastBeat)
        refreshPlayerNotification()
        persistSession()
        // Metadata con las frecuencias nuevas (album = portadora/latido real).
        val s = mediaSession ?: return
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, sessionTitle)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Vyneural · Ondas binaurales")
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "${lastBase} / ${(lastBase + lastBeat).toFixed(1)} Hz")
                .build(),
        )
        onFrequencyChange?.invoke(lastBase, lastBeat)
        Diagnostics.trace("media", "FREQ_STEP done{base=$lastBase beat=$lastBeat}")
    }

    private fun setSessionPlaying(playing: Boolean, pushToJs: Boolean = true) {
        val s = mediaSession ?: return
        val now = android.os.SystemClock.elapsedRealtime()
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, sessionTitle)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Vyneural · Ondas binaurales")
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "${lastBase} / ${(lastBase + lastBeat).toFixed(1)} Hz")
                .build(),
        )
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    // REGLA DE ORO: en pausa, la sesión queda INACTIVA (ver
                    // isActive más abajo) — solo se declara ACTION_PLAY, sin
                    // SKIP/SEEK/PAUSE, para que ningún control externo (auriculares
                    // Bluetooth reconectando, botón físico de manos libres, Android
                    // Auto) tenga nada que invocar sobre una sesión inactiva.
                    if (playing) {
                        PlaybackState.ACTION_PAUSE or
                            PlaybackState.ACTION_STOP or
                            PlaybackState.ACTION_SKIP_TO_NEXT or
                            PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                            PlaybackState.ACTION_SEEK_TO
                    } else {
                        PlaybackState.ACTION_PLAY
                    },
                )
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, now, 1f)
                .build(),
        )
        // REGLA DE ORO — bug real encontrado en vivo: acá SIEMPRE quedaba
        // `isActive = true`, incluso en pausa. Una sesión "activa" (aunque
        // pausada) queda disponible para CUALQUIER control de medios externo
        // — reconectar auriculares Bluetooth manda un evento PLAY sintético en
        // varios Android/fabricantes, y eso llamaba a onPlay() → arrancaba
        // audio sin que el usuario tocara nada de Vyneural ("se puso a sonar
        // sola", "ningún botón de play activo", reportado en vivo). Solo
        // reproduciendo de verdad la sesión queda activa para el sistema; en
        // pausa se desactiva — el botón "Reproducir" de la notificación de
        // ESTA app sigue andando igual (usa un PendingIntent directo al
        // servicio, no pasa por la MediaSession), lo único que se pierde es
        // que un control externo la retome sin pasar por acá.
        s.isActive = playing
        Diagnostics.mediaSessionActive = playing
        Diagnostics.mediaSessionPlaybackState = if (playing) "playing" else "paused"
        // P2 — la interrupción por focus (LOSS) NO debe tumbar la sesión web:
        // pushToJs=false evita el bucle pause→play del sync JS (ver
        // handleFocusChange). El JS recibe el cambio de foco por separado.
        if (pushToJs) onPlaybackStateChange?.invoke(Diagnostics.mediaSessionPlaybackState)
    }

    private fun setSessionStopped() {
        val s = mediaSession ?: return
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(0)
                .setState(PlaybackState.STATE_STOPPED, 0L, 0f)
                .build(),
        )
        s.isActive = false
        Diagnostics.mediaSessionActive = false
        Diagnostics.mediaSessionPlaybackState = "stopped"
        onPlaybackStateChange?.invoke("stopped")
    }

    /** Re-publica la notificación de control con el estado actual (play/pause). */
    private fun refreshPlayerNotification() {
        val notif = NotificationHelper.mediaNotification(
            context = this,
            title = sessionTitle,
            text = if (running) "Reproduciendo · ${lastBase} / ${(lastBase + lastBeat).toFixed(1)} Hz" else "En pausa",
            sessionToken = mediaSession?.sessionToken,
            isPlaying = running,
        )
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_ID, notif)
        } catch (_: Exception) {
            /* la notificación se re-muestra en el próximo startForeground */
        }
    }

    // ── P5.1 — persistencia de la sesión (parámetros SÍ, auto-reproducción NO) ─
    // La sesión se persiste para que la UI pueda re-sincronizarse (GET_AUDIO_STATE)
    // y para que un comando explícito posterior use los mismos parámetros. PERO
    // un shouldPlay persistido JAMÁS se convierte en engine.start(): tras la
    // muerte del proceso, el servicio no se recrea (START_NOT_STICKY) y, si se
    // recrea con intent null, se detiene solo. Ningún audio nace sin causa
    // auditable.
    private fun persistSession() {
        try {
            // putFloat: SharedPreferences no tiene putDouble; la precisión
            // float (~7 dígitos) es más que suficiente para frecuencias.
            prefs().edit()
                .putBoolean("shouldPlay", shouldPlay)
                .putFloat("base", lastBase.toFloat())
                .putFloat("beat", lastBeat.toFloat())
                .putString("wave", lastWave)
                .putFloat("volume", lastVolume.toFloat())
                .putString("title", sessionTitle)
                .apply()
        } catch (_: Exception) {
            /* persistencia no disponible */
        }
    }

    // P5.1 — restart del servicio con intent null (recreación tras kill del
    // proceso): NUNCA reanuda audio. Se conservan los parámetros persistidos en
    // memoria (por si llega un comando explícito en esta generación) y el
    // servicio se detiene solo — sin sesión sonando no hay notificación ni
    // foreground colgado.
    private fun handleNullIntentRestart() {
        try {
            val p = prefs()
            lastBase = p.getFloat("base", 220f).toDouble()
            lastBeat = p.getFloat("beat", 6f).toDouble()
            lastWave = p.getString("wave", "") ?: ""
            lastVolume = p.getFloat("volume", 0.6f).toDouble()
            sessionTitle = p.getString("title", "Sesión Vyneural") ?: "Sesión Vyneural"
        } catch (_: Exception) {
            /* sin sesión persistida: quedan los defaults */
        }
        shouldPlay = false
        Diagnostics.trace(
            "restart",
            "intent=null: NO_AUTO_PLAY (parámetros conservados, motor NO arrancado) " +
                "persisted=${prefs().getBoolean("shouldPlay", false)}",
        )
        BineuralLog.d(
            "audio-service",
            "restart con intent null: NO_AUTO_PLAY — se espera un comando explícito (P5.1)",
        )
        stopForegroundCompat()
        stopSelf()
    }

    private fun clearSession() {
        try {
            prefs().edit().clear().apply()
        } catch (_: Exception) {
            /* persistencia no disponible */
        }
    }

    private fun prefs() =
        getSharedPreferences(PREFS_SESSION, android.content.Context.MODE_PRIVATE)

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat() {
        val notif = NotificationHelper.mediaNotification(
            context = this,
            title = sessionTitle,
            text = if (running) "Reproduciendo · ${lastBase} / ${(lastBase + lastBeat).toFixed(1)} Hz" else "Reproduciendo…",
            sessionToken = mediaSession?.sessionToken,
            isPlaying = running,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    override fun onDestroy() {
        shouldPlay = false
        cancelFocusReacquire()
        focus?.abandon()
        engine.stop()
        mediaSession?.release()
        mediaSession = null
        running = false
        Diagnostics.audioActive = false
        Diagnostics.mediaSessionActive = false
        Diagnostics.mediaSessionPlaybackState = "stopped"
        // No limpiar la sesión persistida aquí: onDestroy también se llama tras
        // un kill por el SO (donde SÍ queremos restaurar). El guardado queda
        // coherente por persistSession/clearSession en cada comando.
        BineuralLog.d("audio-service", "destroyed")
        super.onDestroy()
    }

    /** Formato de frecuencia para metadata/notificación (siempre punto decimal). */
    private fun Double.toFixed(decimals: Int = 1): String =
        String.format(java.util.Locale.US, "%.${decimals}f", this)

    companion object {
        const val ACTION_START = "com.vyneural.bineural.action.START"
        const val ACTION_PAUSE = "com.vyneural.bineural.action.PAUSE"
        const val ACTION_RESUME = "com.vyneural.bineural.action.RESUME"
        const val ACTION_PLAY = "com.vyneural.bineural.action.PLAY"
        const val ACTION_STOP = "com.vyneural.bineural.action.STOP"
        // Botones ⏮/⏭ de la notificación (mediaNotification, NotificationHelper):
        // mismo paso de frecuencia que onSkipToNext/Previous de la MediaSession
        // (stepFrequency) — la notificación los invoca vía PendingIntent directo
        // al servicio, no pasa por la MediaSession (misma razón que ACTION_PLAY).
        const val ACTION_SKIP_NEXT = "com.vyneural.bineural.action.SKIP_NEXT"
        const val ACTION_SKIP_PREV = "com.vyneural.bineural.action.SKIP_PREV"
        const val ACTION_FREQ = "com.vyneural.bineural.action.FREQ"
        const val ACTION_WAVE = "com.vyneural.bineural.action.WAVE"
        const val ACTION_VOLUME = "com.vyneural.bineural.action.VOLUME"
        const val EXTRA_BASE = "base"
        const val EXTRA_BEAT = "beat"
        const val EXTRA_WAVE = "wave"
        const val EXTRA_LEVEL = "level"
        const val EXTRA_TITLE = "title"
        private const val NOTIF_ID = 1001

        // P4-B — la sesión de audio se persiste con este nombre (SharedPreferences)
        // y el bridge la expone para que la UI web re-sincronice su estado tras
        // navegar dentro de la APK sin tocar el servicio.
        const val PREFS_SESSION = "vyneural_audio_session"

        // Callback hacia MainActivity para reenviar al JS los cambios de audio
        // focus (log de interferencias del HUD / /diagnostico).
        @Volatile
        var onFocusStateChange: ((String) -> Unit)? = null

        // Callback hacia MainActivity para reenviar al JS los cambios de
        // reproducción (pause/resume/stop desde lock screen o notificación),
        // para que la UI de la WebView quede sincronizada con el motor nativo.
        @Volatile
        var onPlaybackStateChange: ((String) -> Unit)? = null

        // Callback hacia MainActivity cuando los controles del SO (skip/seek)
        // cambian la FRECUENCIA: la UI web se entera del nuevo base/beat.
        @Volatile
        var onFrequencyChange: ((Double, Double) -> Unit)? = null

        // Paso de frecuencia por salto de MediaSession (adelantar/retroceder).
        const val FREQ_STEP_HZ = 10.0

        @Volatile
        var running = false
            private set

        /** MediaSession activa y reproduciendo (estado honesto para el bridge). */
        fun mediaSessionActive(): Boolean = Diagnostics.mediaSessionActive

        /** 'playing' | 'paused' | 'stopped' — estado real de la MediaSession. */
        fun mediaPlaybackState(): String = Diagnostics.mediaSessionPlaybackState

        fun start(context: Context, base: Double, beat: Double, title: String = "Sesión Vyneural", level: Double = -1.0) {
            val i = Intent(context, AudioForegroundService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_BASE, base)
                .putExtra(EXTRA_BEAT, beat)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_LEVEL, level)
            ContextCompat.startForegroundService(context, i)
        }

        // P5.1 — PAUSE de un servicio inactivo es NO-OP: un pause NUNCA puede
        // crear/revivir el servicio de audio (si no, una pausa tras un kill del
        // proceso crearía un foreground colgado con la notificación "En pausa").
        fun pause(context: Context) {
            if (!serviceAlive(context)) {
                Diagnostics.trace("cmd", "PAUSE dropped: servicio no activo (un pause no crea audio)")
                return
            }
            val i = Intent(context, AudioForegroundService::class.java).setAction(ACTION_PAUSE)
            context.startService(i)
        }

        // USER_RESUME / MEDIA_PLAY: SÍ pueden crear/revivir el servicio (es una
        // acción de reproducción explícita).
        fun resume(context: Context) {
            val i = Intent(context, AudioForegroundService::class.java).setAction(ACTION_RESUME)
            ContextCompat.startForegroundService(context, i)
        }

        // P5.1 — CONFIGURACIÓN nunca crea reproducción: retune/wave/volumen solo
        // se entregan si el servicio ya está activo. Si está muerto, se descartan
        // (el próximo START lleva los parámetros completos de todos modos).
        fun retune(context: Context, base: Double, beat: Double, wave: String? = null) {
            if (!serviceAlive(context)) {
                Diagnostics.trace("config", "RETUNE dropped: servicio no activo (config nunca revive audio)")
                return
            }
            val i = Intent(context, AudioForegroundService::class.java)
                .setAction(ACTION_FREQ)
                .putExtra(EXTRA_BASE, base)
                .putExtra(EXTRA_BEAT, beat)
                .putExtra(EXTRA_WAVE, wave ?: "")
            context.startService(i)
        }

        fun setWave(context: Context, wave: String) {
            if (!serviceAlive(context)) {
                Diagnostics.trace("config", "SET_WAVE dropped: servicio no activo (config nunca revive audio)")
                return
            }
            val i = Intent(context, AudioForegroundService::class.java)
                .setAction(ACTION_WAVE)
                .putExtra(EXTRA_WAVE, wave)
            context.startService(i)
        }

        fun setVolume(context: Context, level: Double) {
            if (!serviceAlive(context)) {
                Diagnostics.trace("config", "SET_AUDIO_LEVEL dropped: servicio no activo (config nunca revive audio)")
                return
            }
            val i = Intent(context, AudioForegroundService::class.java)
                .setAction(ACTION_VOLUME)
                .putExtra(EXTRA_LEVEL, level)
            context.startService(i)
        }

        fun stop(context: Context) {
            val i = Intent(context, AudioForegroundService::class.java).setAction(ACTION_STOP)
            try {
                // Mismo camino que el resto de comandos: startForegroundService.
                // Con startService, Android 8+ lanza IllegalStateException si la app
                // está en background y el servicio ya no corre — el STOP fallaría en
                // silencio y la notificación quedaría colgada.
                ContextCompat.startForegroundService(context, i)
            } catch (e: Exception) {
                // App en background y servicio ya muerto por el SO: no hay nada que
                // detener (los estáticos del proceso reiniciado ya están en falso).
                BineuralLog.e("audio-service", "stop: servicio ya no estaba activo (esperado)", e)
            }
        }

        fun isRunning(context: Context): Boolean {
            if (running) return true
            return isServiceRunning(context)
        }

        /** ¿El servicio de audio está vivo AHORA? (guarda de P5.1: los comandos
         *  que no son de reproducción nunca lo crean). */
        private fun serviceAlive(context: Context): Boolean {
            if (running) return true
            return isServiceRunning(context)
        }

        private fun isServiceRunning(context: Context): Boolean {
            return try {
                val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                @Suppress("DEPRECATION")
                am.getRunningServices(100).any { it.service.className == AudioForegroundService::class.java.name }
            } catch (_: Exception) {
                false
            }
        }
    }
}
