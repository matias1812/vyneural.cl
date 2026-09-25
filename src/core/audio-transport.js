// src/core/audio-transport.js
// Transporte de audio: cómo llega el sonido REAL al sistema operativo.
//
// Arquitectura objetivo (P0.5): un único pipeline
//
//   AudioContext → masterGain → compressor → analyser → limiter → outputTap
//                                                          │
//                                     ┌────────────────────┴──────────┐
//                                'element' (Android/desktop)     'direct' (iOS)
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
// Modo 'direct' (fallback): iOS Safari no reproduce fiablemente un
// MediaStream de Web Audio a través de un <audio>; ahí el sonido sale por
// ctx.destination y el ancla muda (legacy) se usa solo para reclamar la
// MediaSession. El ancla queda marcada como fallback legacy, nunca como vía
// principal.
//
// La clase es testeable: recibe fábricas inyectadas (Audio, AudioContext).

export const TRANSPORT_MODES = ['element', 'direct'];

export class AudioTransport {
  /**
   * @param {{isIos?: boolean, createElement?: (() => HTMLAudioElement)|null,
   *          onFallback?: (() => void)|null}} [opts]
   */
  constructor({ isIos = false, createElement = null, onFallback = null } = {}) {
    this.isIos = isIos;
    this.createElement = createElement || (() => new Audio());
    this.onFallback = onFallback;
    this.mode = 'direct'; // hasta que attach() decida
    this.ctx = null;
    this.outputTap = null;
    this.streamDest = null;
    this.element = null;
    this.fallbackApplied = false;
  }

  get canUseElementMode() {
    return (
      !this.isIos &&
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
        this.element.onerror = () => this._fallbackToDirect();
        this.mode = 'element';
      } catch (_) {
        this._fallbackToDirect();
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
    const p = this.element.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  pause() {
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
  _fallbackToDirect() {
    if (this.fallbackApplied) return;
    this.fallbackApplied = true;
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
