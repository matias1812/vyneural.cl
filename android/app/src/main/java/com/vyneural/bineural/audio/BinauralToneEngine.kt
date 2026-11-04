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
    private val targetFrequencies = AtomicReference(220.0 to 6.0)
    private val gain = AtomicReference(0.0)
    private val targetGain = AtomicReference(0.6)
    private val volume = AtomicReference(0.6)
    private val wave = AtomicReference(0) // 0 sine · 1 triangle · 2 sawtooth · 3 square
    private val playing = AtomicBoolean(false)
    @Volatile private var track: AudioTrack? = null
    private var paused = false
    private var ducked = false

    @Synchronized
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
        if (playing.get()) {
            resume()
            return
        }
        val newTrack = createTrack()
        gain.set(0.0)
        paused = false
        ducked = false
        updateTargetGain()
        track = newTrack
        playing.set(true)
        Thread({ runLoop(newTrack) }, "bineural-audio").start()
    }

    @Synchronized
    fun pause() {
        paused = true
        updateTargetGain()
    }

    @Synchronized
    fun resume() {
        if (!playing.get()) return
        paused = false
        updateTargetGain()
    }

    /** Nivel de volumen de la sesión (0..1); se aplica al reanudar/retomar. */
    @Synchronized
    fun setVolume(level: Double) {
        if (!level.isFinite()) return
        volume.set(level.coerceIn(0.0, 1.0))
        updateTargetGain()
    }

    fun retune(newBase: Double, newBeat: Double) {
        if (!newBase.isFinite() || !newBeat.isFinite() ||
            newBase <= 0.0 || newBeat < 0.0 || newBase + newBeat >= sampleRate / 2.0
        ) return
        targetFrequencies.set(newBase to newBeat)
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

    // Suaviza el borde discontinuo en el intervalo de una muestra a cada
    // lado del salto. Así se reduce el aliasing de cuadrada y diente de sierra.
    private fun polyBlep(phase: Double, step: Double): Double {
        if (phase < step) {
            val x = phase / step
            return 2 * x - x * x - 1
        }
        if (phase > 1 - step) {
            val x = (phase - 1) / step
            return x * x + 2 * x + 1
        }
        return 0.0
    }

    private fun waveform(phase: Double, step: Double, type: Int): Double {
        return when (type) {
            1 -> { // triangle
                2.0 * kotlin.math.abs(2.0 * (phase - kotlin.math.floor(phase + 0.5))) - 1.0
            }
            2 -> { // sawtooth
                val shifted = if (phase < 0.5) phase + 0.5 else phase - 0.5
                2.0 * shifted - 1.0 - polyBlep(shifted, step)
            }
            3 -> {
                val shifted = if (phase < 0.5) phase + 0.5 else phase - 0.5
                val square = if (phase < 0.5) 1.0 else -1.0
                square + polyBlep(phase, step) - polyBlep(shifted, step)
            }
            else -> sin(2 * PI * phase)
        }
    }

    /** Audio focus: duck baja el volumen sin cortar; restore lo recupera. */
    @Synchronized
    fun duck(down: Boolean) {
        ducked = down
        updateTargetGain()
    }

    private fun updateTargetGain() {
        targetGain.set(when {
            paused -> 0.0
            ducked -> minOf(volume.get(), 0.12)
            else -> volume.get()
        })
    }

    @Synchronized
    fun stop() {
        if (!playing.getAndSet(false)) return
        targetGain.set(0.0)
        val stoppedTrack = track
        track = null
        try {
            stoppedTrack?.stop()
        } catch (_: Exception) {
        }
        try {
            stoppedTrack?.release()
        } catch (_: Exception) {
        }
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

    private fun runLoop(tr: AudioTrack) {
        val samples = ShortArray(blockSamples * 2)
        val dt = 1.0 / sampleRate
        var phaseL = 0.0
        var phaseR = 0.0
        var (f1, bt) = targetFrequencies.get()
        var currentGain = 0.0
        var previousWave = wave.get()
        try {
            if (track !== tr) return
            tr.play()
            while (track === tr) {
                val (targetBase, targetBeat) = targetFrequencies.get()
                f1 += (targetBase - f1) * 0.05
                bt += (targetBeat - bt) * 0.05
                val f2 = f1 + bt
                val stepL = f1 * dt
                val stepR = f2 * dt
                val previousGain = currentGain
                currentGain += (targetGain.get() - previousGain) * 0.05
                val wv = wave.get()
                for (i in samples.indices step 2) {
                    val blend = (i + 2).toDouble() / samples.size
                    val amp = (previousGain + (currentGain - previousGain) * blend) * 32767 * 0.6
                    phaseL += stepL
                    phaseR += stepR
                    if (phaseL >= 1.0) phaseL -= 1.0
                    if (phaseR >= 1.0) phaseR -= 1.0
                    val left = waveform(phaseL, stepL, wv)
                    val right = waveform(phaseR, stepR, wv)
                    val leftSample = if (previousWave == wv) left else waveform(phaseL, stepL, previousWave) * (1 - blend) + left * blend
                    val rightSample = if (previousWave == wv) right else waveform(phaseR, stepR, previousWave) * (1 - blend) + right * blend
                    samples[i] = (leftSample * amp).toInt().toShort()
                    samples[i + 1] = (rightSample * amp).toInt().toShort()
                }
                previousWave = wv
                var off = 0
                while (track === tr && off < samples.size) {
                    val w = tr.write(samples, off, samples.size - off)
                    if (w < 0) return
                    if (w == 0) Thread.sleep(2)
                    off += w
                }
                if (track === tr) gain.set(currentGain)
            }
        } catch (_: Exception) {
            // El sistema puede cerrar la salida mientras hay un write activo.
        } finally {
            synchronized(this) {
                if (track === tr) stop()
            }
        }
    }
}
