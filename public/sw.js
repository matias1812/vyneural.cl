// Vyneural · Service Worker
// Estrategia: cache-first con revalidación en segundo plano para los assets
// estáticos (los nombres llevan hash, así un deploy nuevo trae URLs nuevas),
// y red-al-cache para las navegaciones (con fallback al index).
// v4: la API (/api/*, /health) ya no pasa por este cache — ver el fetch
// handler. El bump fuerza a limpiar cualquier respuesta de API vieja que
// hubiera quedado guardada en v3 antes de este fix.
const CACHE = 'vyneural-v4';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // La API (mismo origen vía el rewrite de Vercel) NUNCA pasa por cache-first:
  // son datos que cambian (crear/editar/borrar), no assets con hash en el
  // nombre. Cachearla como si fuera estática servía respuestas viejas de
  // entrada — ej. crear un itinerario en /cuenta y no verlo en /rutina hasta
  // que esa URL exacta se pidiera de nuevo en segundo plano. Directo a red.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // Navegaciones: red primero, con revalidación del index en cache.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Estáticos: cache-first + actualización en segundo plano.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetched;
    }),
  );
});

// ── Notificaciones de alarma (click y acciones) ────────────────────────────
// La página crea la notificación con reg.showNotification() (solo posible
// mientras la página está viva — limitación honesta del navegador; para
// ejecución con la app cerrada hace falta Web Push con backend, ver
// docs/system-robustness.md). Aquí se gestiona el click y las acciones:
// enfocar la ventana existente, navegarla al deep link de la sesión, o
// abrir la PWA si no hay ninguna ventana.

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const ndata = e.notification.data || {};
  const action = e.action || '';
  // 'dismiss' se usa solo para descartar (la notificación ya se cerró).
  if (action === 'dismiss') return;

  // Acciones específicas (abrir frecuencia/itinerario/alarma) apuntan a su URL.
  let target = ndata.url || '/';
  if (action && ndata.actions && ndata.actions[action]) {
    target = ndata.actions[action];
  }
  if (action === 'start') {
    // El deep link ya lleva autostart=true; se garantiza por si llegó sin él.
    const u = new URL(target, self.location.origin);
    u.searchParams.set('autostart', 'true');
    target = u.href;
  }
  // Abrir la UI NO inicia audio automáticamente: el arranque exige gesto
  // del usuario en la página (autostart solo prepara la interfaz).

  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if (client.focus) {
            // Navegar la ventana existente transfiere la configuración de la
            // sesión (freq/beat/wave/autostart); evitar duplicados abriendo
            // solo la primera ventana enfocable.
            if (client.navigate) {
              client.navigate(target).catch(() => {});
            } else {
              client.postMessage({ type: 'NAVIGATE', url: target });
            }
            return client.focus();
          }
          return null;
        }
        // Sin ventana abierta: abrir la PWA con el deep link.
        return self.clients.openWindow(target);
      }),
  );
});

// Cierre explícito de la notificación por el usuario (sin acción): no-op
// hoy; aquí se registrarían métricas locales si algún día existen.
self.addEventListener('notificationclose', (e) => {
  /* sin telemetría local */
});

// ── Web Push (P1) ───────────────────────────────────────────────────────────
// Recibe un push enviado por un backend y muestra la notificación. Sin
// backend configurado este handler nunca se dispara; la UI lo declara
// honestamente. La página informa al SW si el backend está configurado
// (mensaje PUSH_CONFIG). El payload esperado:
// { title, body, url, tag, actions }.
//
// REGLA DE ORO: una notificación push NUNCA reproduce audio. Aquí solo se
// muestra la notificación; el usuario decide con un gesto (click/acción).
let pushConfigured = false;

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (_) {
    /* payload vacío o no JSON */
  }
  const actions = Array.isArray(data.actions) && data.actions.length ? data.actions : [];
  const payload = {
    body: data.body || 'Vyneural',
    tag: data.tag || 'vyneural-push',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    renotify: true,
    // Sin esto, un Web Push (fallback cuando FCM no entrega, ver
    // reminders.py::_send_one_reminder) llegaba sin vibración — a diferencia
    // del camino nativo (NotificationHelper.kt), que sí la aplica siempre.
    vibrate: data.kind === 'alarm' ? [300, 200, 300, 200, 300] : [200],
    data: {
      url: data.url || '/',
      kind: data.kind || 'generic', // frequency | itinerary | alarm | generic
      id: data.id || null,
      actions: actions.reduce((acc, a) => {
        acc[a.action] = a.url || '';
        return acc;
      }, {}),
    },
  };
  if (actions.length) payload.actions = actions;
  e.waitUntil(self.registration.showNotification(data.title || 'Vyneural', payload));
});

// ── Message bus página ⇄ SW (P0, Fase 17) ───────────────────────────────────
// Solo se aceptan mensajes con schema conocido; el resto se ignora. El SW no
// es un scheduler persistente: aquí solo responde al diagnóstico y ejecuta
// comandos válidos que la página no puede hacer sola.
// ── Renovación automática de suscripción (P1) ───────────────────────────────
// El navegador puede invalidar/rotar una PushSubscription en segundo plano
// (poco frecuente, pero pasa). Sin este handler, el dispositivo quedaba mudo
// hasta que alguien abriera la app y notara el problema. El SW no puede
// autenticar un POST a /push/subscribe (no tiene acceso a localStorage, ahí
// vive el token de sesión) — solo renueva la suscripción a nivel de
// navegador; la página la sincroniza con el backend en su próxima carga
// (ver syncPushState en src/ui/auth.js — reintenta en silencio si el permiso
// ya estaba concedido, sin mostrar ningún diálogo nuevo).
self.addEventListener('pushsubscriptionchange', (e) => {
  const key = e.oldSubscription && e.oldSubscription.options
    ? e.oldSubscription.options.applicationServerKey
    : null;
  if (!key) return; // sin la key no se puede resuscribir; la página lo hará
  e.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .catch(() => {}),
  );
});

self.addEventListener('message', (e) => {
  const m = e && e.data;
  if (!m || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'DIAGNOSTICS':
      // Ping de estado: la página pregunta si el SW está activo.
      if (e.source && e.source.postMessage) {
        e.source.postMessage({
          type: 'SW_STATUS',
          active: true,
          cache: CACHE,
          hasPush: 'PushManager' in self,
          pushConfigured, // valor real (lo informa la página vía PUSH_CONFIG)
        });
      }
      break;
    case 'PUSH_CONFIG':
      // La página informa si el backend de push está configurado (solo bool;
      // nunca se envían claves al SW).
      if (typeof m.configured === 'boolean') pushConfigured = m.configured;
      break;
    default:
      // Tipo no reconocido: no procesar (validación de schema).
      break;
  }
});
