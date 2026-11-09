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
 *   El fade es ASIMÉTRICO (FADE_IN / FADE_OUT): entrar es suave (~2 s),
 *   pausar es casi inmediato (~0,3 s a inaudible) — una pausa que tarda
 *   segundos en callarse se lee como "la pausa no funciona".
 * - No usa setInterval/setTimeout como reloj: el reloj es la corriente de
 *   muestras del AudioTrack (P1 audio clock).
 * - Tras IDLE_RELEASE_NS de pausa sostenida suelta el AudioTrack y el hilo
 *   (batería); un resume/play explícito lo recrea de forma transparente.
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
    /** Instante (nanoTime) en que empezó la pausa vigente; 0 = no está en
     *  pausa. Lo lee el hilo de audio sin tomar el lock (de ahí el @Volatile),
     *  para decidir si la pausa ya es lo bastante larga como para soltar el
     *  AudioTrack — ver IDLE_RELEASE_NS. */
    @Volatile private var pausedSinceNs = 0L
    /** true SOLO si el AudioTrack se liberó por pausa prolongada (no por un
     *  stop() del usuario). Es lo que distingue "sesión viva, en pausa, con el
     *  hardware soltado" de "sesión detenida": la primera puede reanudarse, la
     *  segunda NO (REGLA DE ORO — un resume() nunca puede crear audio de la
     *  nada). */
    private var idleReleased = false

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
        startLocked()
    }

    /** Arranca motor + hilo. Ya con el lock tomado (@Synchronized de start()/
     *  resume()): no re-entra, solo centraliza el arranque para que start() y
     *  el resume tras una liberación por pausa prolongada hagan EXACTAMENTE lo
     *  mismo. */
    private fun startLocked() {
        val newTrack = createTrack()
        gain.set(0.0)
        paused = false
        pausedSinceNs = 0L
        idleReleased = false
        ducked = false
        updateTargetGain()
        track = newTrack
        playing.set(true)
        Thread({ runLoop(newTrack) }, "bineural-audio").start()
    }

    @Synchronized
    fun pause() {
        if (!paused) pausedSinceNs = System.nanoTime()
        paused = true
        updateTargetGain()
    }

    @Synchronized
    fun resume() {
        paused = false
        pausedSinceNs = 0L
        updateTargetGain()
        if (playing.get()) return
        // El AudioTrack se soltó por pausa prolongada (ver IDLE_RELEASE_NS):
        // reanudar tiene que RECREARLO. Sin esto, un resume() sobre un motor
        // liberado dejaría la sesión muda con la notificación en "reproduciendo"
        // — la misma clase de bug que el histórico "el botón play no funciona"
        // documentado en start(). `idleReleased` es la guarda que impide que
        // esto se convierta en "resume() arranca audio de la nada": si el motor
        // nunca arrancó o el usuario hizo stop(), idleReleased es false y acá
        // no pasa nada (REGLA DE ORO).
        if (idleReleased) startLocked()
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
        val wasPlaying = playing.getAndSet(false)
        // Un stop() explícito cierra la sesión: deja de ser reanudable (ver
        // resume()/idleReleased). Se limpia ANTES del return temprano a
        // propósito: si el motor ya estaba liberado por pausa prolongada,
        // playing es false y el return saldría dejando la sesión marcada como
        // reanudable — un resume() posterior volvería a sonar después de un
        // stop() del usuario (REGLA DE ORO).
        idleReleased = false
        pausedSinceNs = 0L
        if (!wasPlaying) return
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

    /**
     * Libera el AudioTrack tras una pausa prolongada y deja la sesión marcada
     * como reanudable. Decisión consciente (medido en vivo: en pausa el motor
     * seguía escribiendo ~176 KB de muestras cada 5 s, para siempre, con el
     * hilo `bineural-audio` y la ruta de audio del SO despiertos — una sesión
     * "pausada" y olvidada drenaba batería indefinidamente).
     *
     * Por qué NO mantener el reloj de audio vivo para siempre: el único
     * beneficio sería que reanudar es instantáneo, y eso se conserva igual
     * durante el primer minuto (IDLE_RELEASE_NS), que es la ventana que cubre
     * las pausas reales — una llamada, una interrupción, mirar otra app.
     * Después de un minuto, recrear el AudioTrack cuesta milisegundos y el
     * motor retoma en la MISMA frecuencia objetivo (runLoop arranca en
     * targetFrequencies, no barre desde cero), así que la única diferencia
     * audible es el fade de entrada de FADE_IN, idéntico al de cualquier play.
     *
     * @return true si hay que salir del loop (liberado, o el track ya no es el
     *         vigente); false si hubo un resume entre la medición y el lock y
     *         el loop tiene que seguir sonando.
     */
    @Synchronized
    private fun releaseIdleTrack(tr: AudioTrack): Boolean {
        if (track !== tr) return true
        // Carrera real posible: el usuario reanuda justo entre el chequeo del
        // umbral (sin lock) y este punto. En ese caso NO se libera nada.
        if (!paused) return false
        stop()
        // stop() limpia idleReleased (un stop explícito no es reanudable);
        // acá se re-marca a propósito, DESPUÉS, porque esta liberación sí lo es.
        idleReleased = true
        return true
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
                val target = targetGain.get()
                // Fade de ganancia asimétrico. Medido en vivo con el harness
                // JVM (2026-11-08): con el 0,05 por bloque que usaban AMBAS
                // direcciones, pausar tardaba ~2,7 s en llegar a -20 dB y ~7,7 s
                // en apagarse de verdad — por eso los reportes históricos de
                // "la pausa no funciona" (el usuario toca pausa y sigue oyendo
                // el tono varios segundos). El fade suave existía para no meter
                // un click, pero un click necesita una discontinuidad de
                // MUESTRA: con FADE_OUT la envolvente sigue siendo continua y
                // lineal por tramos dentro de cada bloque (ver `blend` abajo),
                // y la caída completa son ~6-7 bloques de 46 ms. La subida
                // (play/resume, deshacer un duck, subir volumen) mantiene el
                // 0,05 de siempre: ahí la lentitud es deseada (entrada suave,
                // ~2 s) y acelerarla sí se oiría como un salto.
                val k = if (target < previousGain) FADE_OUT else FADE_IN
                currentGain += (target - previousGain) * k
                // El fade exponencial nunca llega exactamente a 0: sin este
                // corte el motor se queda escribiendo muestras de ±1 LSB para
                // siempre y "silencio real" nunca es medible ni exacto.
                // SILENT_GAIN equivale a ~1 LSB de 16 bits al volumen máximo:
                // pasar de 1 LSB a 0 es inaudible por definición.
                if (target <= 0.0 && currentGain < SILENT_GAIN) currentGain = 0.0
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
                // Pausa prolongada: soltar el hardware (ver releaseIdleTrack).
                val since = pausedSinceNs
                if (since != 0L && currentGain == 0.0 &&
                    System.nanoTime() - since >= IDLE_RELEASE_NS &&
                    releaseIdleTrack(tr)
                ) {
                    return
                }
            }
        } catch (_: Exception) {
            // El sistema puede cerrar la salida mientras hay un write activo.
        } finally {
            synchronized(this) {
                if (track === tr) stop()
            }
        }
    }

    private companion object {
        // Los dos coeficientes son POR BLOQUE de `blockSamples` frames
        // (2048 @ 44,1 kHz ≈ 46,4 ms), no por segundo.
        /** Subida (play/resume/volumen arriba/fin de duck): entrada suave,
         *  ~2 s al 90 %. Es el valor histórico — se mantiene a propósito. */
        private const val FADE_IN = 0.05
        /** Bajada (pausa/stop/volumen a 0/duck): ~200 ms a -40 dB, ~310 ms a
         *  -60 dB, silencio exacto a ~0,5 s. Reemplaza el 0,05 que tardaba
         *  7,7 s en apagarse de verdad. */
        private const val FADE_OUT = 0.65
        /** ~1 LSB de 16 bits a la amplitud máxima (amp = gain·32767·0,6):
         *  por debajo de esto la muestra ya cuantiza a 0. */
        private const val SILENT_GAIN = 1.0 / (32767.0 * 0.6)
        /** Pausa sostenida tras la cual se suelta el AudioTrack y muere el
         *  hilo de audio (ver releaseIdleTrack). 60 s: cubre con holgura las
         *  pausas "voy y vuelvo" manteniendo el reloj caliente, y corta el
         *  consumo de una sesión pausada y olvidada. */
        private const val IDLE_RELEASE_NS = 60_000_000_000L
    }
}
