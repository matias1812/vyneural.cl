// src/api/support-ws-client.js
// Cliente WebSocket compartido del chat de soporte — usado tanto por
// support-chat.js (usuario) como por src/admin.js (bandeja del admin), así
// las dos superficies comparten EXACTAMENTE la misma lógica de reconexión y
// de resolución de URL en vez de mantenerla duplicada dos veces.
//
// Transporte PRIMARIO con reconexión/backoff — el polling REST existente en
// cada lado (getMessages()/getAdminSupportMessages(), cada 4s) sigue
// corriendo siempre en paralelo, sin condicionarse a que el socket esté
// conectado: este módulo es aditivo, nunca la única vía. Si el socket nunca
// conecta (o el navegador no soporta WebSocket), el chat sigue funcionando
// exactamente como antes de esta pieza.
//
// Vercel rewrites (/api/* → backend Render, ver vercel.json) proxian HTTP
// normal pero NO túnel WebSocket hacia un destino externo — un socket a
// wss://www.vyneural.cl/... nunca llegaría al backend. Por eso, cuando no
// hay VITE_API_URL (build web, same-origin) Y no estamos en localhost (dev,
// donde el proxy de Vite SÍ reenvía WS si server.proxy tiene ws:true, ver
// vite.config.js), se conecta directo al origen real del backend.

import { API_BASE, getAccessToken } from './client.js';

const PROD_BACKEND_ORIGIN = 'https://vyneural-backend.onrender.com';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function httpBase() {
  if (API_BASE) return API_BASE;
  if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    return '';
  }
  return PROD_BACKEND_ORIGIN;
}

function wsUrl(conversationId) {
  const base = httpBase();
  if (base) {
    return `${base.replace(/^http/, 'ws')}/api/v1/support/ws/${encodeURIComponent(conversationId)}`;
  }
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
  const host = typeof location !== 'undefined' ? location.host : 'localhost';
  return `${proto}://${host}/api/v1/support/ws/${encodeURIComponent(conversationId)}`;
}

/**
 * Abre (y mantiene) un socket para una conversación de soporte.
 *
 * handlers.onMessage(messageDict) — un mensaje nuevo llegó por el socket
 *   (misma forma que SupportMessageOut: {id, sender, content, created_at}).
 * handlers.onStatusChange('connecting'|'open'|'down') — para pintar un
 *   indicador de "en vivo" vs "sincronizando" (ver render*ConnStatus en
 *   support-chat.js/admin.js) — 'down' cubre tanto "todavía reconectando"
 *   como "sin WebSocket disponible", el polling cubre ambos igual.
 *
 * Devuelve { close() } — cierra el socket actual y cancela cualquier
 * reintento pendiente; después de close() nunca se reconecta solo.
 */
export function openSupportSocket(conversationId, { onMessage, onStatusChange } = {}) {
  let ws = null;
  let closedByCaller = false;
  let attempt = 0;
  let reconnectTimer = null;

  function setStatus(s) {
    if (onStatusChange) onStatusChange(s);
  }

  function scheduleReconnect() {
    if (closedByCaller) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (closedByCaller) return;
    if (typeof WebSocket === 'undefined') {
      // Entorno sin WebSocket (no debería pasar en un navegador real ni en
      // el WebView de la APK) — el polling ya cubre todo, no reintentar.
      setStatus('down');
      return;
    }
    const token = getAccessToken();
    if (!token) {
      // Sin sesión todavía (o token no cargado): reintentar más adelante,
      // el polling sigue funcionando mientras tanto.
      setStatus('down');
      scheduleReconnect();
      return;
    }
    setStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(wsUrl(conversationId));
    } catch (_) {
      setStatus('down');
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener('open', () => {
      attempt = 0; // conectó: la próxima caída vuelve a empezar el backoff desde 1s
      try {
        socket.send(JSON.stringify({ token: getAccessToken() }));
      } catch (_) {
        /* el próximo 'close' ya dispara el reintento */
      }
      setStatus('open');
    });
    socket.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (onMessage) onMessage(data);
      } catch (_) {
        /* frame no-JSON: no debería pasar con este backend, se ignora */
      }
    });
    socket.addEventListener('close', () => {
      ws = null;
      setStatus('down');
      scheduleReconnect();
    });
    // 'close' siempre sigue a 'error' en la API de WebSocket — el reintento
    // ya se dispara ahí, este listener solo evita un error no manejado en consola.
    socket.addEventListener('error', () => {});
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws) {
        try {
          ws.close();
        } catch (_) {
          /* no-op */
        }
        ws = null;
      }
    },
  };
}
