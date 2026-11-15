// src/core/audio-clock.js
// Reloj maestro de la sesión. La fase del latido, el tiempo de sesión y la
// alineación de la simulación se derivan SIEMPRE del reloj del AudioContext
// (ctx.currentTime), nunca de setInterval/setTimeout/Date.now()/RAF.
//
// Por qué: cuando la pestaña pasa a segundo plano, los timers JS se
// estrangulan (hasta 1 Hz) y Date.now() no representa el reloj de audio; un
// pulso visual basado en timers acumula deriva y se desalinea del latido
// real. El AudioContext, mientras siga "running", avanza con precisión de
// muestreo aunque la pestaña esté oculta.
//
// La clase es pura y testeable: en tests se inyecta un reloj simulado.

export class AudioClock {
  /**
   * @param {() => number} [getTime]  Fuente del tiempo de audio. En el
   *   navegador: () => audioContext.currentTime. En tests: un reloj manual.
   */
  constructor(getTime = () => 0) {
    this._getTime = getTime;
    this._epoch = null; // instante de audio del inicio de la sesión (fase 0)
    this._beatRamp = null;
  }

  /** Marca el inicio de la sesión en el reloj de audio. */
  setEpoch(time = this._getTime()) {
    this._epoch = time;
  }

  /** Instante actual del reloj de audio. */
  now() {
    return this._getTime();
  }

  /** Época de la sesión (null si aún no arrancó). */
  get epoch() {
    return this._epoch;
  }

  /** Segundos de sesión transcurridos en el reloj de audio. */
  elapsed() {
    if (this._epoch == null) return 0;
    return Math.max(0, this.now() - this._epoch);
  }

  /** Ancla el contador al inicio de las fuentes o al cambio de estímulo. */
  resetBeatCycles(time, hz, cycles = 0) {
    this._beatRamp = { time, cycles, from: hz, to: hz, duration: 0 };
  }

  /** Ciclos acumulados y frecuencia instantánea durante la rampa del audio. */
  sampleBeat(time = this.now()) {
    const ramp = this._beatRamp;
    if (!ramp) return null;
    const dt = Math.max(0, time - ramp.time);
    if (!ramp.duration) return { cycles: ramp.cycles + ramp.to * dt, hz: ramp.to };
    const t = Math.min(dt, ramp.duration);
    const hz = ramp.from + (ramp.to - ramp.from) * t / ramp.duration;
    const cycles = ramp.cycles + (ramp.from + hz) * t / 2 + ramp.to * (dt - t);
    return { cycles, hz };
  }

  retuneBeat(time, hz, duration) {
    const current = this.sampleBeat(time);
    if (!current) return this.resetBeatCycles(time, hz);
    this._beatRamp = { time, cycles: current.cycles, from: current.hz, to: hz, duration };
  }

  /**
   * Fase del latido en [0,1) en un instante dado. 0 = justo el latido.
   * Independiente de timers: si la pestaña estuvo 20 minutos congelada,
   * al volver la fase es exactamente la que corresponde al reloj de audio.
   * @param {number} beat  Frecuencia del latido (Hz).
   * @param {number} [time]  Instante (por defecto, ahora).
   * @returns {number|null} Fase en [0,1), o null si no hay época o beat ≤ 0.
   */
  beatPhase(beat, time = this.now()) {
    if (this._epoch == null || !beat || beat <= 0) return null;
    const period = Math.max(0.08, 1 / beat);
    const elapsed = time - this._epoch;
    return (((elapsed % period) + period) % period) / period;
  }

  /**
   * Instante de audio del próximo latido (o del siguiente tras `time`).
   * Útil para programar el pulso visual sin timers: setTimeout(t, delay)
   * con delay calculado aquí se auto-corrige en cada disparo.
   * @param {number} beat
   * @param {number} [time]
   * @returns {number|null}
   */
  nextBeatAt(beat, time = this.now()) {
    if (this._epoch == null || !beat || beat <= 0) return null;
    const period = Math.max(0.08, 1 / beat);
    const elapsed = time - this._epoch;
    const sinceLast = ((elapsed % period) + period) % period;
    return time + (period - sinceLast);
  }
}
