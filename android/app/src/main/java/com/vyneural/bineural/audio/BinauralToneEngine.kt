package com.vyneural.bineural.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.sin

/**
 * Motor de tono binaural nativo (AudioTrack streaming). ÚNICO motor de audio
 * de la APK: genera L = sen(2π·f1·t) y R = sen(2π·f2·t) con f2 = f1 + beat.
 *
 * - La frecuencia cambia con rampa suave (mismo espíritu que el ramp de
 *   1,5 s de la web) y la ganancia hace fade al pausar/reanudar: sin clics.
 * - No usa setInterval/setTimeout como reloj: el reloj es la corriente de
 *   muestras del AudioTrack (P1 audio clock).
 * - La WebView controla las frecuencias (retune); el transporte lo sostiene
 *   este servicio.
 */
class BinauralToneEngine {
    private val sampleRate = 44100
    private val blockSamples = 2048
    private val base = AtomicReference(220.0)
    private val beat = AtomicReference(6.0)
    private val targetBase = AtomicReference(220.0)
    private val targetBeat = AtomicReference(6.0)
    private val gain = AtomicReference(0.0)
    private val targetGain = AtomicReference(0.6)
    private val volume = AtomicReference(0.6)
    private val wave = AtomicReference(0) // 0 sine · 1 triangle · 2 sawtooth · 3 square
    private val playing = AtomicBoolean(false)
    private val trackStarted = AtomicBoolean(false)
    private var phaseL = 0.0
    private var phaseR = 0.0
    @Volatile private var track: AudioTrack? = null
    private var thread: Thread? = null

    fun start() {
        // Bug real reportado en vivo: "el botón play no funciona" (solo
        // pausa). Causa: pause() SOLO baja targetGain a 0 — nunca pone
        // playing en false (eso es cosa de stop()). Un start() posterior a un
        // pause() encontraba playing=true y retornaba sin hacer NADA — ni
        // siquiera restauraba la ganancia — dejando la MediaSession/
        // notificación en "reproduciendo" con el motor mudo de verdad.
        // handleSystemPlay() (el callback de MediaSession, el que dispara el
        // widget del sistema) llama a start() y confía en que "arranca o
        // reanuda"; el camino de ACTION_PLAY en onStartCommand se salvaba
        // porque SIEMPRE llama resume() después — start() ahora hace lo
        // mismo para cualquier llamador, así deja de depender de que cada
        // caller recuerde encadenar resume().
        if (playing.getAndSet(true)) {
            targetGain.set(volume.get())
            return
        }
        if (track == null) track = createTrack()
        trackStarted.set(false)
        thread = Thread({ runLoop() }, "bineural-audio").apply { start() }
    }

    fun pause() {
        targetGain.set(0.0)
    }

    fun resume() {
        if (playing.get()) targetGain.set(volume.get())
    }

    /** Nivel de volumen de la sesión (0..1); se aplica al reanudar/retomar. */
    fun setVolume(level: Double) {
        volume.set(level.coerceIn(0.0, 1.0))
        if (playing.get()) targetGain.set(level.coerceIn(0.0, 1.0))
    }

    fun retune(newBase: Double, newBeat: Double) {
        targetBase.set(newBase)
        targetBeat.set(newBeat)
    }

    /** Forma de onda: sine / triangle / sawtooth / square (mismo set que la web). */
    fun setWave(waveId: String) {
        val w = when (waveId.lowercase()) {
            "triangle" -> 1
            "sawtooth" -> 2
            "square" -> 3
            else -> 0
        }
        wave.set(w)
    }

    private fun waveform(phase: Double, type: Int): Double {
        return when (type) {
            1 -> { // triangle
                val p = phase / (2 * PI)
                2.0 * kotlin.math.abs(2.0 * (p - kotlin.math.floor(p + 0.5))) - 1.0
            }
            2 -> { // sawtooth
                val p = phase / (2 * PI)
                2.0 * (p - kotlin.math.floor(p + 0.5))
            }
            3 -> if (phase % (2 * PI) < PI) 1.0 else -1.0 // square
            else -> sin(phase) // sine
        }
    }

    /** Audio focus: duck baja el volumen sin cortar; restore lo recupera. */
    fun duck(down: Boolean) {
        targetGain.set(if (down) 0.12 else volume.get())
    }

    fun stop() {
        if (!playing.getAndSet(false)) return
        targetGain.set(0.0)
        trackStarted.set(false)
        try {
            track?.stop()
        } catch (_: Exception) {
        }
        try {
            track?.release()
        } catch (_: Exception) {
        }
        track = null
    }

    fun isPlaying(): Boolean = playing.get() && gain.get() > 0.01

    private fun createTrack(): AudioTrack {
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        val fmt = AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build()
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_STEREO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val buf = maxOf(minBuf * 2, blockSamples * 4)
        return AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(fmt)
            .setBufferSizeInBytes(buf)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    private fun runLoop() {
        val samples = ShortArray(blockSamples * 2)
        val dt = 1.0 / sampleRate
        while (playing.get()) {
            val tr = track ?: break
            // P2 — bug real encontrado en emulador: en MODE_STREAM el AudioTrack
            // queda idle y write() bloquea para siempre si nunca se llama a
            // play(). Sin esto el motor nativo compilaba pero JAMÁS sonaba.
            if (!trackStarted.getAndSet(true)) {
                try {
                    tr.play()
                } catch (_: Exception) {
                    /* emulador/dispositivo sin salida de audio */
                }
            }
            val f1 = base.get() + (targetBase.get() - base.get()) * 0.05
            val bt = beat.get() + (targetBeat.get() - beat.get()) * 0.05
            base.set(f1)
            beat.set(bt)
            val f2 = f1 + bt
            val g = gain.get() + (targetGain.get() - gain.get()) * 0.05
            gain.set(g)
            val amp = (g * 32767 * 0.6).toInt()
            val wv = wave.get()
            for (i in samples.indices step 2) {
                phaseL += 2 * PI * f1 * dt
                phaseR += 2 * PI * f2 * dt
                if (phaseL > 2 * PI) phaseL -= 2 * PI
                if (phaseR > 2 * PI) phaseR -= 2 * PI
                samples[i] = (waveform(phaseL, wv) * amp).toInt().toShort()
                samples[i + 1] = (waveform(phaseR, wv) * amp).toInt().toShort()
            }
            try {
                var off = 0
                while (off < samples.size) {
                    val w = tr.write(samples, off, samples.size - off)
                    if (w <= 0) {
                        // Sin espacio/salida: dormir un poco en vez de girar en vacío.
                        Thread.sleep(2)
                        break
                    }
                    off += w
                }
            } catch (_: Exception) {
                break
            }
        }
        try {
            track?.stop()
        } catch (_: Exception) {
        }
        trackStarted.set(false)
    }
}
