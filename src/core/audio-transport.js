// src/core/audio-transport.js
// Transporte de audio: cómo llega el sonido REAL al sistema operativo.
//
// Arquitectura objetivo (P0.5): un único pipeline
//
//   AudioContext → masterGain → compressor → analyser → limiter → outputTap
//                                                          │
//                                     ┌────────────────────┴──────────┐
//                                'element' (Android web)   'direct' (escritorio/iOS)
//                                     │                            │
//                          MediaStreamDestination            ctx.destination
//                                     │
//                              <audio srcObject>  ← EL elemento que el SO
//                                     │              reconoce como reproducción
//                                     ▼              real (MediaSession, audio
//                                    OS               focus, lock screen)
//
// Modo 'element': el elemento <audio> reproduce la sesión real. MediaSession,
// el audio focus y la pantalla de bloqueo lo ven como UNA sola reproducción
// (no hay "audio real + audio falso").
//
// Modo 'direct': ctx.destination recibe la señal sin el búfer de MediaStream.
// En escritorio ese búfer retrasa el primer play. iOS también usa la salida
// directa por compatibilidad. El ancla muda solo registra la MediaSession.
//
// La clase es testeable: recibe fábricas inyectadas (Audio, AudioContext).

export const TRANSPORT_MODES = ['element', 'direct'];

const STREAM_STALL_SECONDS = 2;
const STREAM_MAX_SAMPLE_GAP_SECONDS = 1.5;

export class AudioTransport {
  /**
   * @param {{isIos?: boolean, preferDirect?: boolean, createElement?: (() => HTMLAudioElement)|null,
   *          onFallback?: (() => void)|null, onEvent?: ((event: string) => void)|null}} [opts]
   */
  constructor({ isIos = false, preferDirect = false, createElement = null, onFallback = null, onEvent = null } = {}) {
    this.preferDirect = isIos || preferDirect;
    this.createElement = createElement || (() => new Audio());
    this.onFallback = onFallback;
    this.onEvent = onEvent;
    this.mode = 'direct'; // hasta que attach() decida
    this.ctx = null;
    this.outputTap = null;
    this.streamDest = null;
    this.element = null;
    this.fallbackApplied = false;
    this.playAttempt = 0;
    this.mediaProgress = null;
  }

  get canUseElementMode() {
    return (
      !this.preferDirect &&
      this.ctx != null &&
      typeof this.ctx.createMediaStreamDestination === 'function'
    );
  }

  /**
   * Conecta la salida del pipeline al transporte.
   * @param {AudioContext} ctx
   * @param {AudioNode} inputNode  Nodo de entrada (el analyser del motor).
   */
  attach(ctx, inputNode) {
    this.ctx = ctx;
    if (!this.outputTap) {
      this.outputTap = ctx.createGain();
      inputNode.connect(this.outputTap);
    }
    if (this.canUseElementMode) {
      try {
        this.streamDest = ctx.createMediaStreamDestination();
        this.outputTap.connect(this.streamDest);
        this.element = this.createElement();
        this.element.srcObject = this.streamDest.stream;
        this.element.setAttribute('playsinline', '');
        // Adjuntar el elemento al DOM (oculto). Chrome Android solo registra
        // la MediaSession como controlable ante el SO (shade, lock screen,
        // botones de medios) cuando el elemento de reproducción real está en
        // el documento: sin esto el widget del reproductor aparece pero sus
        // controles no llegan a la app ("Media button session is null").
        // Es el mismo motivo por el que el anchor legacy se adjunta al body.
        this._attachToDocument();
        // El elemento representa la sesión real: nunca muted ni volume 0.
        this.element.onerror = () => this._fallbackToDirect('error');
        if (this.onEvent) {
          for (const event of ['waiting', 'stalled', 'playing', 'pause']) {
            this.element.addEventListener?.(event, () => {
              if (this.mode === 'element') this._report(event);
            });
          }
        }
        this.mode = 'element';
      } catch (_) {
        this._fallbackToDirect('attach');
      }
    } else {
      this.outputTap.connect(ctx.destination);
      this.mode = 'direct';
    }
    return this.mode;
  }

  /** Inicia la reproducción del elemento (llamar dentro del gesto de play). */
  play() {
    if (this.mode !== 'element' || !this.element) return;
    const attempt = ++this.playAttempt;
    this.mediaProgress = null;
    const handleFailure = error => {
      // La pausa invalida un play pendiente. Un fallo de formato del
      // MediaStream sí debe pasar a la salida directa del mismo motor.
      if (attempt === this.playAttempt && error?.name === 'NotSupportedError') {
        this._fallbackToDirect('unsupported');
      }
    };
    try {
      this.element.play()?.catch(handleFailure);
    } catch (error) {
      handleFailure(error);
    }
  }

  pause() {
    ++this.playAttempt;
    this.mediaProgress = null;
    if (this.mode !== 'element' || !this.element) return;
    try {
      this.element.pause();
    } catch (_) {
      /* elemento no disponible */
    }
  }

  /** Re-afirma el elemento si el sistema lo pausó (al volver de background). */
  reaffirm() {
    if (this.mode !== 'element' || !this.element) return false;
    if (this.element.paused) {
      this.play();
      return true;
    }
    return false;
  }

  /**
   * Detecta un MediaStream detenido aunque el grafo siga produciendo señal.
   * Se llama desde el monitor en primer plano durante una sesión audible.
   */
  checkPlaybackProgress(hasSignal) {
    const element = this.element;
    if (this.mode !== 'element' || !element || element.paused || this.ctx?.state !== 'running' || !hasSignal) {
      this.mediaProgress = null;
      return false;
    }
    const audioTime = this.ctx.currentTime;
    const mediaTime = element.currentTime;
    if (!Number.isFinite(audioTime) || !Number.isFinite(mediaTime)) {
      this.mediaProgress = null;
      return false;
    }
    const previous = this.mediaProgress;
    const gap = previous ? audioTime - previous.lastSample : 0;
    if (!previous || mediaTime !== previous.mediaTime || gap < 0 || gap > STREAM_MAX_SAMPLE_GAP_SECONDS) {
      this.mediaProgress = { mediaTime, lastSample: audioTime, stableSince: audioTime };
      return false;
    }
    previous.lastSample = audioTime;
    if (audioTime - previous.stableSince < STREAM_STALL_SECONDS) return false;
    this._fallbackToDirect('no-progress');
    return true;
  }

  // Adjunta el elemento de reproducción al documento (oculto). En entornos de
  // test no hay document/body: se omite sin error.
  _attachToDocument() {
    if (typeof document === 'undefined' || !document.body || !this.element) return;
    try {
      this.element.style.display = 'none';
      this.element.setAttribute('aria-hidden', 'true');
      this.element.setAttribute('tabindex', '-1');
      document.body.appendChild(this.element);
    } catch (_) {
      /* el elemento no se pudo adjuntar: la sesión sigue pero el SO puede no
         exponer los controles (comportamiento previo, no rompe el audio) */
    }
  }

  _report(event) {
    if (!this.onEvent) return;
    const el = this.element;
    const time = el?.currentTime;
    const position = Number.isFinite(time) ? time.toFixed(2) : '—';
    this.onEvent(event + ' · medio ' + position + ' s · estado ' + (el?.readyState ?? '—'));
  }

  /** Estado observable para diagnóstico (P0.5.5). */
  getState() {
    if (!this.ctx) return null;
    const el = this.element;
    return {
      mode: this.mode,
      fallbackApplied: this.fallbackApplied,
      elementPaused: el ? el.paused : null,
      elementReadyState: el ? el.readyState : null,
      elementCurrentTime: el ? el.currentTime : null,
      elementError: el && el.error ? String(el.error.code) : null,
      hasMediaStreamDestination: this.streamDest != null,
    };
  }

  // Si el elemento falla en runtime (plataforma que no reproduce streams de
  // Web Audio), se migra una sola vez a la salida directa. Legacy anchor:
  // main.js lo añade cuando mode === 'direct'.
  _fallbackToDirect(reason) {
    if (this.fallbackApplied) return;
    this.fallbackApplied = true;
    this._report('direct/' + reason);
    try {
      if (this.outputTap && this.streamDest) this.outputTap.disconnect(this.streamDest);
      if (this.outputTap && this.ctx) this.outputTap.connect(this.ctx.destination);
    } catch (_) {
      /* contexto cerrado */
    }
    if (this.element) {
      try {
        this.element.onerror = null;
        this.element.pause();
      } catch (_) {
        /* ignorar */
      }
    }
    this.streamDest = null;
    this.mode = 'direct';
    if (typeof this.onFallback === 'function') this.onFallback();
  }
}
