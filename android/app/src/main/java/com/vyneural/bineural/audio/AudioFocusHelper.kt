package com.vyneural.bineural.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import com.vyneural.bineural.diag.Diagnostics
import com.vyneural.bineural.util.BineuralLog

/**
 * Audio Focus explícito (P1): llamadas, otro audio, Bluetooth… la sesión
 * decide qué hacer (duck / pause / resume) y JAMÁS reinicia la simulación.
 * Cada cambio se registra en Diagnostics.focusState y se reenvía al JS
 * (log de interferencias) vía onFocusChange.
 */
class AudioFocusHelper(
    private val context: Context,
    private val engine: BinauralToneEngine,
    private val onFocusChange: ((String) -> Unit)? = null,
) {

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var request: AudioFocusRequest? = null

    /** ¿El servicio tiene el foco de audio AHORA? (fuente de verdad para el
     *  watchdog de re-adquisición: P2 — el WebView/otra app pueden robarlo). */
    @Volatile
    var held: Boolean = false
        private set

    // P2 bis — bug real reportado en vivo: "cualquier audio [de otra app] lo
    // dispara". Causa: engine.pause() solo baja targetGain a 0 (el AudioTrack
    // sigue vivo, playing=true) y ACTION_PAUSE nunca abandonaba el foco — la
    // sesión seguía siendo la dueña registrada. Cuando CUALQUIER otra app
    // soltaba su foco, Android se lo devolvía acá (GAIN) y este listener
    // llamaba a engine.resume() sin condición, subiendo targetGain de nuevo:
    // el motor volvía a sonar sin ningún gesto del usuario. `ducked` distingue
    // el ÚNICO caso en el que GAIN debe tocar el motor por su cuenta (deshacer
    // un duck transitorio de la MISMA sesión que nunca dejó de sonar) de
    // cualquier otro caso — un resume real de pausa/pérdida es responsabilidad
    // EXCLUSIVA de AudioForegroundService.handleFocusChange() (política: GAIN
    // nunca reanuda solo).
    @Volatile
    private var ducked: Boolean = false

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        val label = when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> "GAIN"
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "LOSS_TRANSIENT"
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "DUCK"
            AudioManager.AUDIOFOCUS_LOSS -> "LOSS"
            else -> "UNKNOWN"
        }
        BineuralLog.d("audio-focus", "change=$change -> $label")
        // Observabilidad: el estado SE MUESTRA tal cual llegó (nunca se
        // transforma en silencio; UNKNOWN queda visible como UNKNOWN).
        Diagnostics.focusState = label
        // P2 — defensa de focus: `held` es el estado OPERACIONAL (fuente de
        // verdad del watchdog), separado de Diagnostics.focusState (solo
        // observabilidad). DUCK (LOSS_TRANSIENT_CAN_DUCK) NO pierde el foco:
        // la sesión sigue poseyéndolo, solo baja el volumen — held=true para
        // que el watchdog no intente re-adquirir un foco que ya tenemos.
        held = when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> true
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> true
            else -> false
        }
        onFocusChange?.invoke(label)
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN ->
                // Solo deshace un duck de ESTA MISMA sesión (nunca dejó de
                // sonar, solo bajó de volumen). Cualquier otro caso — incluida
                // una pausa real, propia o ajena — NO toca el motor acá: la
                // política de si corresponde reanudar vive únicamente en
                // AudioForegroundService.handleFocusChange().
                if (ducked) {
                    ducked = false
                    engine.duck(false)
                }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // Un LOSS_TRANSIENT pausa por completo (gain=0), sin importar
                // si veníamos de un duck: si quedara `ducked=true` acá, el
                // próximo GAIN llamaría duck(false) → gain a volumen completo
                // sin gesto del usuario, reintroduciendo el mismo bug.
                ducked = false
                engine.pause()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                ducked = true
                engine.duck(true)
            }
            else -> {
                // Pérdida permanente: pausar (la sesión queda en pausa, no se destruye).
                ducked = false
                engine.duck(false)
                engine.pause()
            }
        }
    }

    fun request() {
        // P2 — la fuente de verdad del watchdog es `held` (estado operacional),
        // NO Diagnostics.focusState (observabilidad): puede existir
        // focusState="GAIN" con held=false (callback de Android que no llegó
        // aunque el SO concedió — observado en el emulador) y en ese caso hay
        // que volver a solicitar. Si ya poseemos el foco, no re-solicitar.
        if (held) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val r = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                .setOnAudioFocusChangeListener(listener)
                .build()
            request = r
            val res = am.requestAudioFocus(r)
            // P2 — el emulador reveló que el callback puede no llegar aunque el
            // SO conceda el focus (stack con GAIN, notified:true, pero
            // Diagnostics quedaba en NONE). El código de retorno es la verdad
            // del SO: reportarlo es honesto, no un workaround.
            if (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                BineuralLog.d("audio-focus", "request granted (res=$res)")
                held = true
                if (Diagnostics.focusState != "GAIN") {
                    Diagnostics.focusState = "GAIN"
                    onFocusChange?.invoke("GAIN")
                }
            } else {
                BineuralLog.d("audio-focus", "request denied (res=$res)")
            }
        } else {
            @Suppress("DEPRECATION")
            val res = am.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
            if (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) held = true
        }
    }

    fun abandon() {
        val r = request
        if (r != null) {
            am.abandonAudioFocusRequest(r)
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(listener)
        }
        held = false
    }
}
