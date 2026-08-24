// Motor de ondas binaurales con Web Audio API.
// Reproduce dos osciladores: uno en el oído izquierdo (frecuencia base)
// y otro en el derecho (base + ritmo). El cerebro percibe la diferencia.
//
// Reloj maestro: la fase del latido y el tiempo de sesión se derivan del
// AudioContext.currentTime (AudioClock), nunca de timers JS, para que no
// haya drift aunque la pestaña pase minutos en segundo plano.
import { AudioClock } from './core/audio-clock.js';
import { AudioTransport } from './core/audio-transport.js';

export class BinauralEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.analyser = null;
    this.leftOsc = null;
    this.rightOsc = null;
    this.amGain = null; // condición AM: ganancia modulada por el LFO del ritmo
    this.amLfo = null; // condición AM: oscilador del ritmo (modulador)
    this._noiseBuf = null; // búfer de ruido reutilizable (condición 'noise')
    this.beat = 0;
    this._base = 0;
    // Condición experimental real del estímulo (P18): binaural | pure-tone |
    // noise | amplitude-modulation | none. Cambia lo que SE OYE, no solo el
    // registro: binaural = dos tonos L/R (latido); pure-tone = un tono en
    // ambos oídos (sin latido); amplitude-modulation = tono con envolvente al
    // ritmo; noise = ruido sin contenido tonal; none = silencio (control).
    this._condition = 'binaural';
    this._playing = false;
    // P5.6 — frontera estructural de plataforma: en la APK el motor web es
    // PERMANENTEMENTE inaudible (el servicio nativo es el único owner). Con
    // `_platformMuted` activo, NINGUNA operación de ganancia (start,
    // setCondition, setVolume, fadeTo, recoverFade) puede subir el volumen:
    // el motor sigue corriendo solo para el visualizador (model-driven).
    this._platformMuted = false;
    // P1 — instrumentación forense (M2): identificador de sesión de pipeline y
    // secuencia de ids por fuente, para demostrar que nunca coexisten dos
    // sets de fuentes. `_pendingTeardown` registra los nodos cuyo teardown se
    // difirió (fade de stop()) y que un start() nuevo debe ejecutar de forma
    // SÍNCRONA antes de crear fuentes nuevas.
    this._sessionId = 0;
    this._sourceSeq = 0;
    this._pendingTeardown = [];
    this.onBeatPulse = null;
    // Hook para el monitor de ciclo de vida: se dispara con cada cambio real
    // del AudioContext (running ↔ suspended) aunque no haya visibilitychange.
    this.onCtxStateChange = null;
    this._pulseTimer = null;
    this._epoch = null; // tiempo del AudioContext del último latido (fase 0)
    // Reloj maestro de la sesión (fase del latido, tiempo transcurrido).
    this.clock = new AudioClock(() => (this.ctx ? this.ctx.currentTime : 0));
    // Transporte de salida (P0.5): 'element' (MediaStreamDestination → <audio>
    // real) o 'direct' (ctx.destination, fallback iOS). Se asigna desde
    // main.js antes del primer play.
    this.transport = null;
  }

  get isPlaying() {
    return this._playing;
  }

  get currentBeat() {
    return this.beat;
  }

  // Crea el AudioContext (debe crearse/resumirse tras un gesto del usuario).
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      // Compresor suave: evita que la suma de ondas + ambientes sature
      // (distorsión) y pega las capas para un resultado más limpio.
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 20;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.005;
      this.compressor.release.value = 0.25;
      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.analyser);
      // Salida: el transporte decide dónde llega la señal (elemento real o
      // destination directa). Sin transporte (antes de asignarlo): directa.
      if (this.transport) {
        this.transport.attach(this.ctx, this.analyser);
      } else {
        this.analyser.connect(this.ctx.destination);
      }
      // Estado real del contexto como fuente de verdad del ciclo de vida:
      // iOS al bloquear, pérdida de audio focus o congelación de la pestaña
      // suspenden el contexto sin disparar visibilitychange.
      this.ctx.onstatechange = () => {
        if (this.onCtxStateChange) this.onCtxStateChange(this.ctx.state);
      };
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // Reanuda el AudioContext si el sistema lo suspendió (p. ej. al volver a
  // la app tras cambiar de aplicación, bloquear la pantalla o cerrar la
  // pestaña temporalmente). Sin esto la sesión vuelve muda hasta que el
  // usuario toca play otra vez.
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {
        /* el navegador exigirá un gesto para reanudar */
      });
    }
  }

  // Reanudación sin clics: si el SO suspendió el contexto (iOS al bloquear,
  // pérdida de audio focus en Android), al volver el audio arranca a plena
  // ganancia en mitad de un ciclo y suena un clic/pop. Aquí se baja la
  // ganancia al piso ANTES de reanudar, se reanuda y se sube con una rampa
  // suave hasta el volumen de la sesión: el reinicio queda inaudible.
  recoverFade(volume = 0.6, seconds = 0.8) {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const wasSuspended = ctx.state === 'suspended';
    const now = ctx.currentTime;
    try {
      this.masterGain.gain.cancelScheduledValues(now);
      // Piso inmediato: evita que el primer bloque renderizado tras resume()
      // salte a plena ganancia.
      this.masterGain.gain.setValueAtTime(0.0001, now);
    } catch (_) {
      /* contexto cerrado */
    }
    // P5.6 — frontera APK: la web jamás se recupera hacia lo audible.
    if (this._platformMuted) {
      try {
        this.masterGain.gain.setValueAtTime(0, now);
      } catch (_) {
        /* contexto cerrado */
      }
      return;
    }
    this.resume();
    if (wasSuspended) {
      // Rampa desde el piso: el fade de entrada enmascara la reanudación.
      try {
        this.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, volume), now + seconds);
      } catch (_) {
        /* contexto cerrado */
      }
    } else if (this.masterGain.gain.value < 0.02) {
      // Contexto ya corriendo pero mudo (watchdog): subir con suavidad.
      try {
        this.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, volume), now + seconds);
      } catch (_) {
        /* contexto cerrado */
      }
    }
    this._volume = volume;
  }

  // RMS de la señal que sale al altavoz, tomada del analizador (0…1 aprox.).
  // Devuelve null si no hay analizador todavía (antes del primer play). Lo usa
  // el watchdog del SimulationEngine para detectar una sesión "en play pero
  // muda" (contexto suspendido o ganancia muerta) y recuperarla.
  getRms() {
    if (!this.analyser) return null;
    const fft = this.analyser.fftSize;
    if (!this._tdBuf || this._tdBuf.length !== fft) this._tdBuf = new Uint8Array(fft);
    this.analyser.getByteTimeDomainData(this._tdBuf);
    let sum = 0;
    for (let i = 0; i < fft; i++) {
      const v = (this._tdBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / fft);
  }

  start({ base = 200, beat = 10, volume = 0.5, wave = 'sine', condition } = {}) {
    const ctx = this.ensure();
    const cond = condition || this._condition;
    // P1 — IDEMPOTENCIA (forense M2): si ya hay una sesión viva con los MISMOS
    // parámetros, un start() duplicado (eventos del sistema, doble play) NO
    // reconstruye nada: mismo sessionId, mismas fuentes, mismo pipeline. Solo
    // se re-afirma el nivel objetivo y el transporte si el SO lo pausó.
    if (
      this._playing &&
      this._base === base &&
      this.beat === beat &&
      this._wave === wave &&
      this._condition === cond
    ) {
      this._volume = volume;
      // P5.6 — en APK (platformMuted) un start duplicado jamás re-produce el
      // elemento web: el SO ya ve la reproducción del servicio nativo.
      if (!this._platformMuted && this.transport && this.transport.element && this.transport.element.paused) {
        this.transport.play();
      }
      return { idempotent: true, sessionId: this._sessionId };
    }
    // P1 — TEARDOWN SÍNCRONO antes de crear un pipeline nuevo (stop-before-
    // start): nunca se permite una ventana donde dos sets de fuentes produzcan
    // audio a la vez.
    //   1. fuentes vivas de una sesión anterior → detener/desconectar YA;
    //   2. teardown diferido de un stop() previo → ejecutar YA;
    //   3. recién después se crean las fuentes nuevas.
    this._teardownSources();
    this._flushPendingTeardown();
    if (condition) this._condition = condition;
    this._base = base;
    this.beat = beat;
    this._wave = wave;
    this._playing = true;
    this._sessionId += 1;
    this._createSources(base, beat, wave);
    // En modo 'element', arranca el elemento real dentro del gesto de play:
    // es ÉL el que el SO ve como reproducción (MediaSession, audio focus).
    // P5.6 — en modo APK (platformMuted) el transporte web queda pausado: el
    // SO ve una sola reproducción, la del servicio nativo.
    if (this.transport) {
      if (this._platformMuted) this.transport.pause();
      else this.transport.play();
    }
    // Volumen objetivo de la sesión (para restauraciones y el watchdog de audio).
    this._volume = volume;
    // Época del primer latido: el primer pulso del timer se dispara a +100 ms.
    this._epoch = ctx.currentTime + 0.1;
    this.clock.setEpoch(this._epoch);

    // Fundido de entrada para un inicio suave. P5.6 — en APK no hay fundido:
    // la ganancia queda en 0 (el sonido real lo genera el servicio nativo).
    const now = ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
    if (this._platformMuted) {
      this.masterGain.gain.setValueAtTime(0, now);
    } else {
      this.masterGain.gain.linearRampToValueAtTime(volume, now + 1.2);
    }

    this._startPulse();
  }

  // ── Condición experimental: construye las fuentes del estímulo real ────────
  // binaural             → dos osciladores L/R (base y base+latido), pan ±1
  // pure-tone            → UN tono en ambos oídos (mismo centro): sin latido
  // amplitude-modulation → portadora con envolvente AM a la frecuencia del ritmo
  // noise                → ruido (sin contenido tonal) filtrado cerca de la portadora
  // none                 → silencio (condición control; solo ambientes si los hay)
  _createSources(base, beat, wave) {
    const ctx = this.ctx;
    if (!ctx) return;
    switch (this._condition) {
      case 'pure-tone': {
        const osc = ctx.createOscillator();
        osc.type = wave;
        osc.frequency.value = base;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        osc.connect(g).connect(this.masterGain);
        osc.start();
        this.leftOsc = this._tag(osc);
        this.rightOsc = null;
        break;
      }
      case 'amplitude-modulation': {
        const osc = ctx.createOscillator();
        osc.type = wave;
        osc.frequency.value = base;
        const am = ctx.createGain();
        am.gain.value = 0.5;
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = beat;
        const depth = ctx.createGain();
        depth.gain.value = 0.42; // 0.5 ± 0.42: modulación profunda y rítmica
        lfo.connect(depth).connect(am.gain);
        osc.connect(am).connect(this.masterGain);
        osc.start();
        lfo.start();
        this.leftOsc = this._tag(osc);
        this.rightOsc = null;
        this.amGain = am;
        this.amLfo = this._tag(lfo);
        break;
      }
      case 'noise': {
        if (!this._noiseBuf) {
          const len = Math.floor(ctx.sampleRate * 2);
          const buf = ctx.createBuffer(1, len, ctx.sampleRate);
          const d = buf.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
          this._noiseBuf = buf;
        }
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuf;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = Math.min(6000, Math.max(250, base * 1.5));
        bp.Q.value = 0.55;
        const g = ctx.createGain();
        g.gain.value = 0.32;
        src.connect(bp).connect(g).connect(this.masterGain);
        src.start();
        this.leftOsc = this._tag(src);
        this.rightOsc = null;
        break;
      }
      case 'none':
        // Control de silencio: no hay estímulo (la sesión sigue "corriendo",
        // los ambientes seleccionados sí suenan a través del master).
        this.leftOsc = null;
        this.rightOsc = null;
        break;
      default: {
        // binaural (comportamiento original)
        const left = ctx.createOscillator();
        const right = ctx.createOscillator();
        left.type = wave;
        right.type = wave;
        left.frequency.value = base;
        right.frequency.value = base + beat;
        const leftGain = ctx.createGain();
        leftGain.gain.value = 0.5;
        const rightGain = ctx.createGain();
        rightGain.gain.value = 0.5;
        const leftPanner = ctx.createStereoPanner();
        leftPanner.pan.value = -1;
        const rightPanner = ctx.createStereoPanner();
        rightPanner.pan.value = 1;
        left.connect(leftGain).connect(leftPanner).connect(this.masterGain);
        right.connect(rightGain).connect(rightPanner).connect(this.masterGain);
        left.start();
        right.start();
        this.leftOsc = this._tag(left);
        this.rightOsc = this._tag(right);
      }
    }
  }

  // Cambia la condición experimental EN VIVO con un crossfade corto (sin
  // clics ni reinicio de sesión): baja al piso, reconstruye las fuentes y
  // sube suave al volumen de la sesión. Con la sesión detenida solo queda
  // almacenada para el próximo start().
  setCondition(cond) {
    const c = cond || 'binaural';
    if (c === this._condition) return;
    this._condition = c;
    if (!this.ctx || !this._playing) return;
    const now = this.ctx.currentTime;
    const vol = this._volume != null ? this._volume : 0.5;
    try {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
      this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
    } catch (_) {
      /* contexto cerrado */
    }
    this._teardownSources();
    this._createSources(this._base, this.beat, this._wave || 'sine');
    const t1 = now + 0.12;
    try {
      this.masterGain.gain.setValueAtTime(0.0001, t1);
      // P5.6 — en APK el crossfade baja pero jamás sube: la web es inaudible
      // por frontera (el estímulo real lo cambia el servicio nativo con RETUNE).
      if (this._platformMuted) {
        this.masterGain.gain.setValueAtTime(0, t1);
      } else {
        this.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, vol), t1 + 0.3);
      }
    } catch (_) {
      /* contexto cerrado */
    }
    // Re-época del latido: el nuevo estímulo arranca su propia fase 0.
    this._epoch = this.ctx.currentTime + 0.3;
    this.clock.setEpoch(this._epoch);
    this._startPulse();
  }

  _teardownSources() {
    const nodes = [this.leftOsc, this.rightOsc, this.amLfo, this.amGain];
    this.leftOsc = null;
    this.rightOsc = null;
    this.amLfo = null;
    this.amGain = null;
    nodes.forEach((n) => {
      if (!n) return;
      try {
        if (typeof n.stop === 'function') n.stop();
      } catch (_) {
        /* ya detenido */
      }
      try {
        n.disconnect();
      } catch (_) {
        /* ya desconectado */
      }
    });
  }

  /** Asigna un id de secuencia a una fuente viva (instrumentación forense). */
  _tag(node) {
    if (node) node._vyneuralId = ++this._sourceSeq;
    return node;
  }

  /**
   * Ejecuta YA el teardown diferido de nodos (P1): un stop() con fade
   * aplaza la destrucción de nodos para que el fade del masterGain termine;
   * si llega un start() antes de que dispare el timer, aquí se destruyen de
   * forma SÍNCRONA para que NUNCA coexistan dos pipelines.
   */
  _flushPendingTeardown() {
    if (!this._pendingTeardown || !this._pendingTeardown.length) return;
    const nodes = this._pendingTeardown;
    this._pendingTeardown = [];
    nodes.forEach((n) => {
      if (!n) return;
      try {
        if (typeof n.stop === 'function') n.stop();
      } catch (_) {
        /* ya detenido */
      }
      try {
        n.disconnect();
      } catch (_) {
        /* ya desconectado */
      }
    });
  }

  /** P5.6 — frontera APK: marca el motor como inaudible por plataforma. Al
   *  activarlo fuerza la ganancia a 0 y pausa el transporte al instante;
   *  mientras esté activo, ninguna operación puede volverlo audible. */
  setPlatformMuted(muted) {
    this._platformMuted = muted;
    if (!muted) return;
    if (this.ctx && this.masterGain) {
      try {
        const now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(0, now);
      } catch (_) {
        /* contexto cerrado */
      }
    }
    if (this.transport) this.transport.pause();
  }

  setVolume(v) {
    this._volume = v;
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
    // P5.6 — en APK el volumen real lo aplica el servicio nativo; la web 0.
    if (this._platformMuted) {
      this.masterGain.gain.setValueAtTime(0, now);
    } else {
      this.masterGain.gain.linearRampToValueAtTime(v, now + 0.2);
    }
  }

  // Fundido suave del volumen maestro a un nivel dado (0…1). Se usa al pasar
  // la app a segundo plano (fade-out a 0) y al volver (fade-in al volumen de
  // la sesión), para que la suspensión/reanudación del AudioContext no suene
  // a cortes, clics o interferencias.
  fadeTo(v, seconds = 0.25) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
    // P5.6 — en APK un fade jamás sube (la web es inaudible por frontera).
    if (this._platformMuted) {
      this.masterGain.gain.setValueAtTime(0, now);
    } else {
      this.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, v), now + seconds);
    }
  }

  // Reajusta las frecuencias en marcha con una transición suave (ramp),
  // sin reiniciar los osciladores ni cortar el sonido: al cambiar de estado
  // la portadora y el latido se deslizan hasta los valores nuevos en 1.5s.
  retune({ base, beat }) {
    if (!this.ctx || !this._playing) return;
    const now = this.ctx.currentTime;
    // En silencio (condición control) solo se guardan los valores.
    if (this._condition === 'none') {
      this._base = base;
      this.beat = beat;
      return;
    }
    // Transición ultra-suave cancelando valores previos. Las fuentes según
    // condición: binaural tiene L/R; pure-tone/AM solo la portadora; noise no
    // tiene frecuencia (se omite).
    if (this.leftOsc && this.leftOsc.frequency) {
      this.leftOsc.frequency.cancelScheduledValues(now);
      this.leftOsc.frequency.setValueAtTime(this.leftOsc.frequency.value, now);
      this.leftOsc.frequency.linearRampToValueAtTime(base, now + 1.5);
    }
    if (this.rightOsc && this.rightOsc.frequency) {
      this.rightOsc.frequency.cancelScheduledValues(now);
      this.rightOsc.frequency.setValueAtTime(this.rightOsc.frequency.value, now);
      this.rightOsc.frequency.linearRampToValueAtTime(base + beat, now + 1.5);
    }
    // AM: el modulador del ritmo sigue al latido nuevo.
    if (this.amLfo && this.amLfo.frequency) {
      this.amLfo.frequency.cancelScheduledValues(now);
      this.amLfo.frequency.linearRampToValueAtTime(beat, now + 1.5);
    }
    this._base = base;
    this.beat = beat;
  }

  // M4 — fija en seco (sin rampa) la frecuencia de los osciladores al valor
  // objetivo actual, cancelando cualquier automation pendiente. Se usa al
  // volver de segundo plano (restoreFromBackground): un retune() pudo dejar
  // una rampa de frecuencia A MEDIO CAMINO justo antes de que el SO suspenda
  // el AudioContext; currentTime no avanza mientras está suspendido, así que
  // al reanudar esa rampa retoma desde donde quedó — pero en algunos
  // navegadores/WebView el primer bloque tras resume() puede rendirizar ese
  // tramo de rampa mucho más rápido que en tiempo real (drift del reloj del
  // dispositivo de audio tras el resume), lo que se percibe como que "la
  // frecuencia se acelera" o, si L y R quedan temporalmente des-sincronizados
  // entre sí, como un batido/doblez audible. Fijar el valor en seco elimina
  // cualquier rampa en vuelo en el momento más delicado (justo al reanudar).
  pinFrequencies() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const base = this._base;
    const beat = this.beat;
    try {
      if (this.leftOsc && this.leftOsc.frequency) {
        this.leftOsc.frequency.cancelScheduledValues(now);
        this.leftOsc.frequency.setValueAtTime(base, now);
      }
      if (this.rightOsc && this.rightOsc.frequency) {
        this.rightOsc.frequency.cancelScheduledValues(now);
        this.rightOsc.frequency.setValueAtTime(base + beat, now);
      }
      if (this.amLfo && this.amLfo.frequency) {
        this.amLfo.frequency.cancelScheduledValues(now);
        this.amLfo.frequency.setValueAtTime(beat, now);
      }
    } catch (_) {
      /* contexto cerrado */
    }
  }

  // Cambia la forma de onda en vivo: el tipo del oscilador es mutable, así
  // que se puede cambiar sobre la marcha sin cortar ni reiniciar el sonido.
  setWave(wave) {
    this._wave = wave;
    if (this.leftOsc && this.leftOsc.type !== undefined) this.leftOsc.type = wave;
    if (this.rightOsc && this.rightOsc.type !== undefined) this.rightOsc.type = wave;
  }

  // Desvanece el volumen maestro a cero (fade-out) durante `duration` ms y
  // avisa al terminar, para que el final del temporizador no corte en seco.
  fadeAndStop(duration = 2000, done) {
    const ctx = this.ctx;
    if (!ctx || !this._playing) {
      if (done) done();
      return;
    }
    const now = ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
    this.masterGain.gain.linearRampToValueAtTime(0.0001, now + duration / 1000);
    setTimeout(() => {
      if (done) done();
    }, duration + 80);
  }

  // Dispara onBeatPulse cada latido binaural (para la animación visual).
  // El timer se auto-corrige con el reloj del AudioContext para no acumular
  // deriva y quedar siempre alineado con la fase real del latido.
  _startPulse() {
    if (this._pulseTimer) clearTimeout(this._pulseTimer);
    const tick = () => {
      if (!this._playing) return;
      // Sin latido percibido (tono puro, ruido, silencio): no hay pulso.
      if (this._condition === 'pure-tone' || this._condition === 'noise' || this._condition === 'none') return;
      if (this.onBeatPulse) this.onBeatPulse();
      let delay = this.beat > 0 ? 1000 / this.beat : 1000;
      if (this.ctx && this._epoch != null) {
        const period = Math.max(0.08, 1 / this.beat);
        const elapsed = this.ctx.currentTime - this._epoch;
        delay = Math.max(20, (period - (elapsed % period)) * 1000);
      }
      this._pulseTimer = setTimeout(tick, delay);
    };
    this._pulseTimer = setTimeout(tick, 100);
  }

  // Fase del latido [0,1) en un instante dado del reloj del AudioContext.
  // 0 = justo el latido, igual que el pulso que ven las gotas del visualizador.
  // Derivada del AudioClock (AudioContext.currentTime): sin drift por timers.
  getBeatPhaseAt(time) {
    if (!this.ctx || this._epoch == null || !this._playing || !this.beat) return null;
    // Solo las condiciones rítmicas (binaural, AM) tienen fase de latido; las
    // demás no perciben beat y el visualizador vuelve a la respiración suave.
    if (this._condition === 'pure-tone' || this._condition === 'noise' || this._condition === 'none') return null;
    return this.clock.beatPhase(this.beat, time);
  }

  // Fase del latido en este momento.
  getBeatPhase() {
    if (!this.ctx) return null;
    return this.getBeatPhaseAt(this.ctx.currentTime);
  }

  // Estado real del motor para el monitor de integridad (P26/P36): contexto,
  // sample rate, reloj, ganancia, RMS y nº de osciladores. Devuelve null si
  // todavía no hay contexto.
  getAudioStats() {
    if (!this.ctx) return null;
    return {
      ctxState: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      currentTime: this.ctx.currentTime,
      gain: this.masterGain ? this.masterGain.gain.value : 0,
      rms: this.getRms(),
      oscillatorCount: (this.leftOsc ? (this.rightOsc ? 2 : 1) : 0) + (this.amLfo ? 1 : 0),
      condition: this._condition,
      // P1 — instrumentación forense (M2): identidad de la sesión de pipeline
      // y de las fuentes vivas, más teardown pendiente. Un salto de sessionId
      // con fuentes viejas vivas = doble pipeline (FAIL).
      sessionId: this._sessionId,
      sourceSeq: this._sourceSeq,
      pendingTeardown: this._pendingTeardown.length,
      liveSourceIds: this._liveSourceIds(),
    };
  }

  /** Ids de las fuentes vivas (orden: left, right, amLfo). */
  _liveSourceIds() {
    const ids = [];
    for (const n of [this.leftOsc, this.rightOsc, this.amLfo]) {
      if (n && n._vyneuralId != null) ids.push(n._vyneuralId);
    }
    return ids;
  }

  // Época del latido actual (para alinear el LFO de los ambientes).
  getBeatEpoch() {
    return this._epoch;
  }

  stop(fade = true) {
    if (!this.ctx || !this._playing) return;
    const nodes = [this.leftOsc, this.rightOsc, this.amLfo, this.amGain];
    if (this.transport) this.transport.pause();
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
    this.masterGain.gain.linearRampToValueAtTime(0.0001, now + (fade ? 1 : 0.05));
    this._playing = false;
    this.leftOsc = null;
    this.rightOsc = null;
    this.amLfo = null;
    this.amGain = null;
    if (this._pulseTimer) {
      clearTimeout(this._pulseTimer);
      this._pulseTimer = null;
    }
    // P1 — el teardown de nodos se DIERE (el fade del masterGain debe terminar
    // antes de matar las fuentes: cortarlas al instante cortaría el fade), pero
    // los nodos se REGISTRAN: un start() posterior ejecuta _flushPendingTeardown()
    // de forma síncrona y no existe ventana de doble pipeline.
    this._pendingTeardown = nodes.filter(Boolean);
    setTimeout(() => this._flushPendingTeardown(), fade ? 1100 : 80);
  }

  stopInstant() {
    this.stop(false);
  }
}
