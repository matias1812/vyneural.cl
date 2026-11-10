// src/core/alarm-manager.js
// Sistema de recordatorios — P0 Notification System.
//
// Única autoridad sobre: creación, persistencia, programación y ejecución de
// alarmas. Arquitectura de providers: LocalNotification / ServiceWorker /
// Calendar (viven en notifications.js). Web Push SÍ está conectado de punta
// a punta (suscripción en ui/auth.js::syncPushState → POST /push/subscribe →
// reminders.py::_dispatch_push → FCM o fallback a Web Push VAPID real vía
// push/service.py → listener 'push' en public/sw.js) — este comentario decía
// "DESACTIVADO (sin backend)" desde el 2026-08-14, pero el backend de push
// existe desde el 2026-08-16/17; quedó desactualizado ~3 meses. Dentro de la
// APK este camino se desactiva a propósito (auth.js) porque ahí FCM nativo ya
// cubre el dispositivo — no es el caso web/PWA.
//
// Persistencia: IndexedDB (durable) con espejo síncrono en localStorage para
// la UI (getAlarms() sigue funcionando); si IndexedDB no existe, localStorage.
// Al arrancar se restauran las alarmas y se importan las del formato legacy.
//
// Scheduler: UN solo bucle setInterval mientras la página viva (nunca
// setTimeout/RAF para programar). Multi-tab: Web Locks elige la pestaña
// PRIMARIA (única que dispara); las SECUNDARIAS refrescan la UI vía
// BroadcastChannel/storage. Si la primaria se cierra, otra toma el lock.
//
// HONESTIDAD: esto NO es un scheduler del SO. Con la pestaña congelada o la
// app cerrada no se dispara nada; el respaldo real es el calendario
// (CalendarProvider / ICS). El estado de cada alarma impide disparos
// duplicados (nunca se ejecuta CANCELLED ni dos veces TRIGGERED).

export const ALARM_STATES = {
  SCHEDULED: 'SCHEDULED',
  TRIGGERED: 'TRIGGERED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  MISSED: 'MISSED',
};

/**
 * Decisión pura de un tick (testeable).
 * @returns {'wait'|'fire'|'miss'|'skip'}
 *   wait  → todavía no toca.
 *   fire  → dentro de la ventana de gracia → disparar.
 *   miss  → pasó la gracia → marcar MISSED (no ejecutar una alarma vieja).
 *   skip  → ya no está SCHEDULED (cancelada/disparada) → no tocar.
 */
export function alarmStateOnTick(alarm, now, graceMs = 5 * 60 * 1000) {
  if (!alarm || !alarm.nextAt) return 'skip';
  if (alarm.state && alarm.state !== ALARM_STATES.SCHEDULED) return 'skip';
  if (alarm.cancelled) return 'skip';
  // P2 — alarma gestionada externamente (APK: la dispara el AlarmManager nativo
  // del SO, no el scheduler web). El web scheduler la conserva SOLO para la
  // lista de la UI; el disparo es responsabilidad del propietario externo.
  // Así nunca hay doble alarma/notificación para el mismo evento (I6).
  if (alarm.external) return 'skip';
  if (now < alarm.nextAt) return 'wait';
  if (now - alarm.nextAt <= graceMs) return 'fire';
  return 'miss';
}

// ── Stores (backend inyectable; testeable con memoria) ─────────────────────

/**
 * P2 — dueño único de la alarma por plataforma (I6). Decisión pura y testeable:
 * APK con bridge nativo real → dueño NATIVO (AlarmManager del SO, sobrevive
 * app cerrada/reboot); Web/PWA → dueño WEB (scheduler de pestaña viva, honesto).
 * El espejo web marca `external` y nunca dispara en paralelo (un solo
 * disparador por evento lógico). La cadena completa nativa
 * (UI→bridge→AlarmScheduler→PendingIntent→AlarmReceiver→NotificationHelper)
 * se valida por evidencia de emulador (no cubierta por unit tests).
 */
export function alarmOwnerForPlatform(platformKind, nativeBridgeAvailable) {
  return platformKind === 'android-native' && nativeBridgeAvailable ? 'native' : 'web';
}

export function inMemoryAlarmStore() {
  const map = new Map();
  return {
    async getAll() {
      return [...map.values()];
    },
    async put(a) {
      map.set(a.id, { ...a });
    },
    async remove(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

// Almacenamiento síncrono de respaldo (localStorage) con la misma interfaz.
export function localStorageAlarmStore(mirrorKey = 'vyneural_alarms') {
  const read = () => {
    try {
      const raw = localStorage.getItem(mirrorKey);
      return Array.isArray(JSON.parse(raw || '[]')) ? JSON.parse(raw || '[]') : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      localStorage.setItem(mirrorKey, JSON.stringify(list));
    } catch {
      /* almacenamiento no disponible */
    }
  };
  return {
    async getAll() {
      return read();
    },
    async put(a) {
      const list = read();
      const i = list.findIndex((x) => x.id === a.id);
      if (i >= 0) list[i] = { ...a };
      else list.push({ ...a });
      write(list);
    },
    async remove(id) {
      write(read().filter((x) => x.id !== id));
    },
    async clear() {
      write([]);
    },
  };
}

// ── AlarmManager ────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object} [opts.store]           Backend durable (IndexedDB o memoria).
 * @param {() => number} [opts.now]       Reloj (Date.now por defecto).
 * @param {number} [opts.tickMs]          Intervalo del scheduler único.
 * @param {number} [opts.graceMs]         Ventana de gracia tras la hora.
 * @param {(alarm: object) => void} [opts.onFire]  Disparo (notificación/sesión).
 * @param {() => void} [opts.onSync]      La UI se refresca (lista/badge).
 * @param {object} [opts.channel]         BroadcastChannel-like (onmessage, postMessage).
 * @param {object} [opts.locks]           navigator.locks-like (request).
 * @param {string} [opts.mirrorKey]       Clave del espejo localStorage.
 */
export class AlarmManager {
  constructor(opts = {}) {
    this.store = opts.store || localStorageAlarmStore();
    this.now = opts.now || Date.now;
    this.tickMs = opts.tickMs || 5000;
    this.graceMs = opts.graceMs != null ? opts.graceMs : 5 * 60 * 1000;
    this.onFire = opts.onFire || null;
    this.onSync = opts.onSync || null;
    this.channel = opts.channel || null;
    this.locks = opts.locks || null;
    this.mirrorKey = opts.mirrorKey || 'vyneural_alarms';
    this.alarms = new Map(); // id → alarma activa (SCHEDULED)
    this._timer = null;
    this._primary = true; // sin Web Locks ni canal: esta pestaña es la única
    // Instancia única de esta pestaña (inyectable para tests deterministas).
    this._instance =
      opts.instanceId || String(Date.now()).padStart(14, '0') + Math.random().toString(36).slice(2, 8);
    this._initialized = false;
    this.fires = 0;
    this.lastAlarm = null;
    this.lastNotification = null;
    this.lastError = null;
  }

  get activeScheduler() {
    return this._timer ? (this._primary ? 'primary' : 'secondary') : 'none';
  }

  async init() {
    if (this._initialized) return this;
    this._initialized = true;
    try {
      const stored = await this.store.getAll();
      for (const a of stored) {
        if (a && a.id && a.nextAt) {
          this.alarms.set(a.id, { ...a, state: ALARM_STATES.SCHEDULED });
        }
      }
    } catch (e) {
      this.lastError = `store:${String(e)}`;
    }
    // Importar formato legacy (localStorage) si el store durable está vacío.
    if (this.alarms.size === 0) {
      try {
        const legacy = JSON.parse(localStorage.getItem(this.mirrorKey) || '[]');
        if (Array.isArray(legacy)) {
          for (const a of legacy) {
            // No filtramos por "todavía en el futuro": una alarma ya vencida
            // pero dentro de graceMs debe seguir viva para que el tick
            // inmediato la dispare (onFire). Filtrarla acá la borraba en
            // silencio antes de que el scheduler llegara a verla — el
            // recordatorio pendiente desaparecía sin avisar al reabrir la app.
            // _expireOverdue() ya se encarga de descartar lo realmente viejo.
            if (a && a.id && a.nextAt) {
              this.alarms.set(a.id, { ...a, state: ALARM_STATES.SCHEDULED });
            }
          }
        }
      } catch {
        /* sin legacy */
      }
    }
    await this._persistAll();
    this._expireOverdue();
    this._electPrimary();
    // UN solo scheduler (mientras la página viva; honesto).
    this._timer = setInterval(() => {
      this.tick().catch((e) => {
        this.lastError = `tick:${String(e)}`;
      });
    }, this.tickMs);
    if (this.channel) {
      this.channel.onmessage = (e) => {
        const m = e && e.data;
        if (!m || typeof m.type !== 'string') return;
        // Los mensajes externos se validan por schema (Fase 17): solo se
        // aceptan los tipos conocidos; el resto se ignora.
        if (m.type === 'ALARM_PRIMARY_PROBE') {
          if (m.instance && m.instance !== this._instance) {
            this._broadcast({ type: 'ALARM_PRIMARY_ANSWER', instance: this._instance });
          }
          return;
        }
        if (m.type === 'ALARM_PRIMARY_ANSWER') {
          // Elección best-effort sin Web Locks: gana la instancia menor.
          if (m.instance && m.instance < this._instance) this._primary = false;
          return;
        }
        if (['ALARM_CREATED', 'ALARM_CANCELLED', 'ALARM_TRIGGERED'].includes(m.type)) {
          this._reloadFromStore();
          if (this.onSync) this.onSync();
        }
      };
    }
    // Tick inmediato al arrancar: dispara lo que ya venció y descarta lo
    // obsoleto (MISSED) sin ejecutar alarmas viejas.
    await this.tick();
    return this;
  }

  /** Crea una alarma (persistida y reflejada). */
  async create(data) {
    const alarm = {
      id: data.id || `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ...data,
      state: ALARM_STATES.SCHEDULED, // el estado es autoridad del manager
    };
    this.alarms.set(alarm.id, alarm);
    await this._persistPut(alarm);
    this._broadcast({ type: 'ALARM_CREATED', id: alarm.id });
    if (this.onSync) this.onSync();
    return alarm;
  }

  /** Cancela una alarma pendiente (nunca se ejecutará). */
  async cancel(id) {
    const a = this.alarms.get(id);
    if (a) a.state = ALARM_STATES.CANCELLED;
    this.alarms.delete(id);
    await this._persistRemove(id);
    this._broadcast({ type: 'ALARM_CANCELLED', id });
    if (this.onSync) this.onSync();
  }

  /** Alarmas pendientes (SCHEDULED), ordenadas por hora. */
  list() {
    return [...this.alarms.values()]
      .filter((a) => a.state === ALARM_STATES.SCHEDULED)
      .sort((a, b) => a.nextAt - b.nextAt);
  }

  get(id) {
    return this.alarms.get(id) || null;
  }

  /** Tick del scheduler único: dispara una vez, nunca duplica, nunca ejecuta
   *  canceladas, y las viejas se marcan MISSED (no se ejecutan). Solo la
   *  pestaña PRIMARIA dispara (Fase 15); antes de disparar confirma en el
   *  store durable que la alarma sigue existiendo (otra pestaña pudo
   *  dispararla primero — cierra la carrera sin Web Locks). */
  async tick() {
    if (!this._primary) return; // pestaña secundaria: solo refresca la UI
    const now = this.now();
    let changed = false;
    for (const [id, alarm] of [...this.alarms]) {
      const decision = alarmStateOnTick(alarm, now, this.graceMs);
      if (decision === 'wait' || decision === 'skip') continue;
      changed = true;
      if (decision === 'fire') {
        // Confirmar en el store: si ya no está (otro tab la disparó), saltar.
        try {
          const stored = await this.store.getAll();
          if (!stored.some((a) => a.id === id)) {
            this.alarms.delete(id);
            continue;
          }
        } catch {
          /* store no disponible: seguir con el estado en memoria */
        }
        alarm.state = ALARM_STATES.TRIGGERED;
        this.fires += 1;
        this.lastAlarm = alarm;
        this.alarms.delete(id);
        // One-shot: se quita del store durable y del espejo.
        await this._persistRemove(id);
        this._broadcast({ type: 'ALARM_TRIGGERED', id });
        if (this.onFire) {
          try {
            this.onFire(alarm);
          } catch (e) {
            this.lastError = `fire:${String(e)}`;
          }
        }
      } else {
        // 'miss': pasó la gracia — se marca y se descarta, sin ejecutar.
        alarm.state = ALARM_STATES.MISSED;
        this.lastNotification = { id, state: ALARM_STATES.MISSED, nextAt: alarm.nextAt };
        this.alarms.delete(id);
        await this._persistRemove(id);
        this._broadcast({ type: 'ALARM_CANCELLED', id });
      }
    }
    if (changed && this.onSync) {
      try {
        this.onSync();
      } catch (e) {
        this.lastError = `sync:${String(e)}`;
      }
    }
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ── interno ───────────────────────────────────────────────────────────────

  _broadcast(msg) {
    if (this.channel && typeof this.channel.postMessage === 'function') {
      try {
        this.channel.postMessage(msg);
      } catch (e) {
        this.lastError = `broadcast:${String(e)}`;
      }
    }
  }

  async _persistAll() {
    const active = this.list();
    try {
      for (const a of active) await this.store.put(a);
    } catch (e) {
      this.lastError = `persist:${String(e)}`;
    }
    this._mirror(active);
  }

  async _persistPut(alarm) {
    try {
      await this.store.put(alarm);
    } catch (e) {
      this.lastError = `put:${String(e)}`;
    }
    this._mirror(this.list());
  }

  async _persistRemove(id) {
    try {
      await this.store.remove(id);
    } catch (e) {
      this.lastError = `remove:${String(e)}`;
    }
    this._mirror(this.list());
  }

  _mirror(active) {
    const plain = active.map(({ state, ...rest }) => ({ ...rest }));
    try {
      localStorage.setItem(this.mirrorKey, JSON.stringify(plain));
    } catch {
      /* sin localStorage */
    }
  }

  async _reloadFromStore() {
    try {
      const stored = await this.store.getAll();
      const fresh = new Map();
      for (const a of stored) {
        if (a && a.id && a.nextAt) fresh.set(a.id, { ...a, state: ALARM_STATES.SCHEDULED });
      }
      this.alarms = fresh;
      this._mirror(this.list());
    } catch (e) {
      this.lastError = `reload:${String(e)}`;
    }
  }

  _expireOverdue() {
    const now = this.now();
    let changed = false;
    for (const [id, a] of [...this.alarms]) {
      if (a.nextAt <= now - this.graceMs) {
        a.state = ALARM_STATES.EXPIRED;
        this.alarms.delete(id);
        this._persistRemove(id);
        changed = true;
      }
    }
    if (changed && this.onSync) this.onSync();
  }

  // Elección de pestaña PRIMARIA (la única que dispara). Web Locks es la
  // fuente autoritativa; sin Web Locks, elección best-effort por
  // BroadcastChannel (instancia menor gana). Sin ninguno de los dos, esta
  // pestaña asume primaria (caso de una sola pestaña).
  _electPrimary() {
    if (this.locks && typeof this.locks.request === 'function') {
      try {
        this.locks.request('vyneural-alarm-scheduler', { ifAvailable: true }, (lock) => {
          if (!lock) {
            this._primary = false;
            if (this.onSync) this.onSync();
            return;
          }
          this._primary = true;
          if (this.onSync) this.onSync();
          // Patrón estándar: mantener el lock mientras la pestaña viva
          // (promesa que nunca resuelve; se libera al cerrar la pestaña).
          return new Promise(() => {});
        });
      } catch (e) {
        this.lastError = `locks:${String(e)}`;
        this._primary = true;
      }
      return;
    }
    if (this.channel && typeof this.channel.postMessage === 'function') {
      this._primary = true;
      this._broadcast({ type: 'ALARM_PRIMARY_PROBE', instance: this._instance });
      return;
    }
    this._primary = true;
  }
}

/**
 * Fábrica de store durable: IndexedDB si está disponible, si no localStorage.
 * IndexedDB se abre de forma perezosa y NUNCA bloquea el arranque.
 */
export async function createDurableStore() {
  const idb = typeof indexedDB !== 'undefined' ? await tryIdbStore() : null;
  return idb || localStorageAlarmStore();
}

async function tryIdbStore() {
  try {
    const db = await openIdb();
    return {
      async getAll() {
        return tx(db, 'readonly', (s) => s.getAll());
      },
      async put(a) {
        return tx(db, 'readwrite', (s) => s.put(a));
      },
      async remove(id) {
        return tx(db, 'readwrite', (s) => s.delete(id));
      },
      async clear() {
        return tx(db, 'readwrite', (s) => s.clear());
      },
    };
  } catch {
    return null;
  }
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vyneural-alarms-db', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('alarms')) {
        d.createObjectStore('alarms', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('alarms', mode);
    const store = t.objectStore('alarms');
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
