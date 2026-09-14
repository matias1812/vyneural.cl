// src/api/client.js
// Cliente HTTP del backend Vyneural (FastAPI). Aditivo: la app sigue
// funcionando sin backend (offline) — este módulo solo se usa si hay sesión.
//
// - Base URL: `VITE_API_URL` si está definida; si no, mismo origen (proxy de
//   Vite en dev / reverse proxy en prod). NUNCA se guardan secretos aquí.
// - Access token en memoria + localStorage (solo para arranque en frío).
// - Refresh automático UNA vez por 401 (rotación), sin carreras (promesa única).
// - Errores normalizados como ApiError { status, detail, code }.

const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || '';

const LS_TOKEN = 'vyneural_access_token';
let accessToken = null;
try {
  accessToken = localStorage.getItem(LS_TOKEN);
} catch (_) {
  accessToken = null;
}

let refreshPromise = null;

export function setAccessToken(token) {
  accessToken = token || null;
  try {
    if (token) localStorage.setItem(LS_TOKEN, token);
    else localStorage.removeItem(LS_TOKEN);
  } catch (_) {
    /* almacenamiento no disponible */
  }
}

export function clearAccessToken() {
  setAccessToken(null);
}

export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  constructor(status, detail, code) {
    super(detail || `error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.code = code || (status === 0 ? 'NETWORK' : status >= 500 ? 'SERVER' : 'API');
  }
}

// Notifica al bridge nativo (APK) cambios de sesión: el worker de segundo
// plano necesita el token para sincronizar alarmas del servidor y reportar
// el estado del dispositivo aunque la app esté cerrada.
function bridgeNotify(command, payload) {
  try {
    if (typeof window === 'undefined') return;
    const b = window.AndroidBridge || window.AndroidBridgeNative;
    if (b && typeof b.postMessage === 'function') {
      b.postMessage(JSON.stringify({ command, payload: payload || null }));
    }
  } catch (_) {
    /* bridge no disponible: la web sigue igual */
  }
}

// Avisa al nativo que una alarma/itinerario cambió (creado, editado o
// borrado): sin esto, el ciclo de sincronización nativo (AlarmSync.kt) solo
// se dispara al iniciar sesión o cada ~5 min — un recordatorio guardado
// para dentro de pocos minutos con la app YA abierta y logueada podía
// vencer ANTES del próximo ciclo y jamás llegar a programarse en el reloj
// del sistema (0 alarma, 0 notificación, sin ningún error visible).
export function notifyNativeAlarmsChanged() {
  bridgeNotify('SYNC_ALARMS', null);
}

// Registra la sesión (access + refresh) tras login/register.
export function storeSession(session) {
  setAccessToken(session.access_token);
  try {
    localStorage.setItem('vyneural_refresh_token', session.refresh_token);
  } catch (_) {
    /* sin storage */
  }
  bridgeNotify('STORE_AUTH', {
    access_token: session.access_token || null,
    refresh_token: session.refresh_token || null,
    user_id: session.user_id || null,
    email: session.email || null,
  });
}

export function getRefreshToken() {
  try {
    return localStorage.getItem('vyneural_refresh_token');
  } catch (_) {
    return null;
  }
}

export function clearSession() {
  clearAccessToken();
  try {
    localStorage.removeItem('vyneural_refresh_token');
  } catch (_) {
    /* sin storage */
  }
  bridgeNotify('CLEAR_AUTH', null);
}

// ── HTTP nativo en la APK (sin CORS) ───────────────────────────────────────
// El WebView de la APK carga desde file:// (origen opaco → Origin: null) y no
// puede depender de que el backend liste "null" en CORS. Cuando el bridge
// nativo está presente (AndroidBridgeNative, disponible desde el arranque de
// la página), TODAS las llamadas API se hacen por HttpURLConnection nativo vía
// el comando API_REQUEST: funcionan siempre, sin depender de la config del
// servidor. La web/PWA siguen usando fetch (same-origin vía proxy).
const NATIVE_TIMEOUT_MS = 30000;
let nativeApiSeq = 0;
const nativeApiPending = new Map();

function isNativeApiAvailable() {
  return (
    typeof window !== 'undefined' &&
    window.AndroidBridgeNative &&
    typeof window.AndroidBridgeNative.postMessage === 'function'
  );
}

// El lado Kotlin llama a esta función (evaluateJavascript) al terminar el
// HTTP nativo. Se registra UNA vez; el id identifica la promesa pendiente.
if (typeof window !== 'undefined' && !window.__vyneuralApiResponse) {
  window.__vyneuralApiResponse = (rid, json) => {
    const entry = nativeApiPending.get(rid);
    if (!entry) return;
    nativeApiPending.delete(rid);
    clearTimeout(entry.timer);
    let parsed = null;
    try {
      parsed = JSON.parse(json);
    } catch (_) {
      parsed = null;
    }
    if (!parsed || parsed.error) {
      entry.reject(new ApiError(0, 'sin conexión con el servidor', 'NETWORK'));
    } else {
      // Misma forma que el fetch web: { status, text } (request() lee res.text).
      entry.resolve({ status: parsed.status, text: parsed.body || '' });
    }
  };
}

function nativeApiFetch(path, { method = 'GET', headers, body } = {}) {
  const bridge = window.AndroidBridgeNative;
  return new Promise((resolve, reject) => {
    const id = ++nativeApiSeq;
    const timer = setTimeout(() => {
      nativeApiPending.delete(id);
      reject(new ApiError(0, 'sin conexión con el servidor', 'NETWORK'));
    }, NATIVE_TIMEOUT_MS);
    nativeApiPending.set(id, { resolve, reject, timer });
    let ack = null;
    try {
      ack = bridge.postMessage(
        JSON.stringify({
          command: 'API_REQUEST',
          payload: { id, method, path, body: body === undefined ? null : body, headers: headers || null },
        }),
      );
    } catch (_) {
      ack = null;
    }
    // El bridge nativo devuelve el ACK como STRING (el wrapper window.AndroidBridge
    // lo parsea; acá llamamos a AndroidBridgeNative directo).
    let ackObj = null;
    try {
      ackObj = typeof ack === 'string' ? JSON.parse(ack) : ack;
    } catch (_) {
      ackObj = null;
    }
    if (!ackObj || ackObj.status !== 'ACCEPTED') {
      clearTimeout(timer);
      nativeApiPending.delete(id);
      reject(new ApiError(0, 'sin conexión con el servidor', 'NETWORK'));
    }
  });
}

// Petición HTTP unificada (web: fetch; APK: bridge nativo) → { status, text }.
async function performFetch(path, { method = 'GET', headers, body } = {}) {
  if (isNativeApiAvailable()) {
    return nativeApiFetch(path, { method, headers, body });
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// Refresh único compartido: varias peticiones 401 no lanzan refreshes paralelos.
// Devuelve { ok, network }: `network:true` distingue "no pudimos ni preguntar
// si el refresh token sirve" (backend caído/dormido — Render free tira cold
// starts de 20-50s, ver .github/workflows/keep-alive.yml) de "el servidor
// contestó que el token NO sirve". Antes ambos casos devolvían `false` por
// igual y request() limpiaba la sesión en los dos — un cold start (que
// coincide justo con el escenario más común: el usuario vuelve después de
// los 15 min que dura el access token, así que el backend probablemente se
// durmió mientras tanto) bastaba para desloguear a alguien con un refresh
// token de 30 días perfectamente válido.
function tryRefresh() {
  if (refreshPromise) return refreshPromise;
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    refreshPromise = Promise.resolve({ ok: false, network: false });
  } else {
    refreshPromise = performFetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then((res) => {
        if (res.status < 200 || res.status >= 300) return { ok: false, network: false };
        try {
          const j = res.text ? JSON.parse(res.text) : null;
          if (!j || !j.access_token) return { ok: false, network: false };
          storeSession(j);
          return { ok: true, network: false };
        } catch (_) {
          return { ok: false, network: false };
        }
      })
      .catch(() => ({ ok: false, network: true }));
  }
  return refreshPromise.finally(() => {
    refreshPromise = null;
  });
}

export async function request(path, { method = 'GET', body, retry = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res;
  try {
    res = await performFetch(path, { method, headers, body });
  } catch (_) {
    throw new ApiError(0, 'sin conexión con el servidor', 'NETWORK');
  }

  if (res.status === 401 && retry) {
    const { ok, network } = await tryRefresh();
    if (ok) return request(path, { method, body, retry: false });
    if (network) {
      // No pudimos ni preguntar (backend caído/dormido): el refresh token
      // sigue guardado tal cual — NO es una sesión inválida, es que ahora
      // mismo no hay forma de confirmarla. El próximo request (cuando el
      // backend responda) puede refrescar normal, sin haber perdido nada.
      throw new ApiError(0, 'sin conexión con el servidor', 'NETWORK');
    }
    clearSession();
    // Confirmado (no solo "sin token": el refresh también falló porque el
    // SERVIDOR dijo que el token no sirve): avisar a TODA página, no solo a
    // la que hizo este fetch — antes cada página tenía que acordarse de
    // llamar expireSession() por su cuenta (/cuenta lo hacía, /rutina y el
    // generador no), y el chip de la nav quedaba mostrando la sesión vieja
    // hasta el próximo reload.
    try {
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('vyneural:session-expired'));
      }
    } catch (_) {
      /* sin document: contexto no-DOM, nada que notificar */
    }
    throw new ApiError(401, 'sesión expirada', 'UNAUTHORIZED');
  }

  if (res.status < 200 || res.status >= 300) {
    let detail = `error ${res.status}`;
    try {
      const j = res.text ? JSON.parse(res.text) : null;
      if (j && j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch (_) {
      /* sin cuerpo JSON */
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204 || !res.text) return null;
  return JSON.parse(res.text);
}

export const get = (path) => request(path);

// ── Caché TTL para GET (carga de peticiones) ────────────────────────────────
// Las listas del /cuenta y de la rutina se repiten al navegar entre páginas
// con sesión. Este caché en memoria evita re-pedir al backend dentro de la
// ventana TTL y se invalida automáticamente tras CADA mutación exitosa, así
// nunca sirve datos viejos después de crear/borrar algo.
const getCache = new Map(); // path -> { t: ms, data }
const GET_CACHE_TTL = 8000; // 8 s

/** GET con caché TTL: devuelve el dato fresco o el cacheado (nunca lanza por
 *  datos viejos: si el fetch falla y hay caché, se usa el caché).
 *  Deduplica llamadas EN VUELO: dos loadAll() concurrentes comparten la misma
 *  petición (la segunda espera la primera en vez de pedir otra vez). */
export async function cachedGet(path, ttl = GET_CACHE_TTL) {
  const hit = getCache.get(path);
  // Promesa en vuelo PRIMERO: un entry recién creado aún no tiene `data`
  // (undefined); si la rama TTL corría antes, una segunda llamada concurrente
  // resolvía `undefined` en vez de esperar la misma petición (bug real: dos
  // me() concurrentes en el arranque de /cuenta → perfil "Sesión no disponible").
  if (hit && hit.promise) return hit.promise;
  if (hit && hit.data !== undefined && Date.now() - hit.t < ttl) return hit.data;
  // `entry` (no `path`) es la clave de identidad que usamos abajo: un GET
  // lento (cold start de Render, 20-50s — ver .github/workflows/keep-alive.yml)
  // puede seguir en vuelo cuando una mutación ya invalidó este recurso. Si al
  // resolver escribiéramos ciegamente por `path`, esa respuesta vieja pisaba
  // el caché recién invalidado y el próximo render volvía a mostrar datos de
  // antes de la mutación (p. ej. un itinerario recién creado, sin su horario).
  // Comparando `getCache.get(path) === entry` sabemos si seguimos siendo la
  // entrada vigente antes de escribir.
  const entry = { t: Date.now(), data: undefined, promise: null };
  const promise = get(path)
    .then((data) => {
      if (getCache.get(path) === entry) {
        entry.data = data;
        entry.t = Date.now();
        entry.promise = null;
      }
      return data;
    })
    .catch((err) => {
      // Sin red pero con caché reciente: mejor datos que error (aditivo).
      if (hit && hit.data !== undefined) return hit.data;
      if (getCache.get(path) === entry) getCache.delete(path);
      throw err;
    });
  entry.promise = promise;
  getCache.set(path, entry);
  return promise;
}

/** Invalida el caché del recurso tras una mutación (create/update/delete). */
export function invalidateCache(path) {
  const parts = path.split('/').filter(Boolean);
  // /api/v1/<recurso>[/…] — se invalida todo el recurso. Los keys del caché
  // guardan la barra inicial (cachedGet se llama con '/api/v1/...'); sin
  // reponerla acá el prefijo nunca matcheaba y esto era un no-op silencioso
  // — una mutación podía seguir sirviendo el GET viejo hasta 8 s (el TTL).
  const prefix = '/' + parts.slice(0, 3).join('/');
  for (const key of [...getCache.keys()]) {
    if (key.startsWith(prefix)) getCache.delete(key);
  }
}

function mutating(method, path, body) {
  return request(path, { method, body }).then((data) => {
    invalidateCache(path);
    return data;
  });
}

export const post = (path, body) => mutating('POST', path, body);
export const put = (path, body) => mutating('PUT', path, body);
export const patch = (path, body) => mutating('PATCH', path, body);
export const del = (path, body) =>
  mutating('DELETE', path, body === undefined ? undefined : body);
