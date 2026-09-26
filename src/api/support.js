// src/api/support.js
// Chat de soporte 1:1 con el admin del producto (backend ya existe y está
// deployado — otro repo, no se toca acá). Requiere sesión: Authorization:
// Bearer ya lo maneja client.js (get/post), incluido el transporte dual
// web (fetch) / APK (bridge nativo, sin CORS).
//
// Contrato real (ver backend, routers/support.py):
//   POST /api/v1/support/conversations                     get-or-create
//   POST /api/v1/support/conversations/{id}/messages        enviar mensaje
//   GET  /api/v1/support/conversations/{id}/messages?since=…  polling
//   POST /api/v1/support/conversations/{id}/rate             calificar (CIERRA
//        la conversación del lado servidor: el contenido de los mensajes se
//        purga, pero la fila de la conversación con su rating sobrevive para
//        el historial del panel de admin — ver support-chat.js, que limpia
//        su estado local en el mismo paso ya que no tiene sentido seguir
//        consultando/mandando mensajes contra una conversación cerrada).
//   POST /api/v1/support/report                             reporte simple
//        (usuarios no-Premium): un mensaje de texto libre, sin thread ni
//        rating — el backend lo manda por mail al admin y siempre devuelve
//        {ok:true} si el mensaje no viene vacío. Requiere sesión igual que
//        el resto de este archivo; el check de Premium es 100% del lado
//        frontend (ver support-chat.js / ui/premium-gate.js), el backend no
//        lo valida.

import { get, post } from './client.js';

// get-or-create: siempre la conversación ABIERTA del usuario (nunca crea una
// segunda mientras haya una sin cerrar). Body vacío: el backend identifica al
// usuario por el token, no por nada que mandemos acá.
export const getOrCreateConversation = () => post('/api/v1/support/conversations', {});

export const sendMessage = (conversationId, content) =>
  post(`/api/v1/support/conversations/${conversationId}/messages`, { content });

// `since` es opcional (ISO datetime del último mensaje ya pintado en pantalla).
// Sin él, el backend devuelve el historial completo — usado solo para la
// primera carga manual si getOrCreateConversation() no alcanzara.
export const getMessages = (conversationId, since) => {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  return get(`/api/v1/support/conversations/${conversationId}/messages${qs}`);
};

// Califica y CIERRA la conversación del lado servidor: los mensajes se
// purgan pero la conversación (con su rating) queda para el historial del
// admin — no tiene sentido seguir pidiendo este id después de esto (404
// esperado si se insiste). `cannedMessage` es opcional.
export const rateConversation = (conversationId, rating, cannedMessage) =>
  post(`/api/v1/support/conversations/${conversationId}/rate`, {
    rating,
    ...(cannedMessage ? { canned_message: cannedMessage } : {}),
  });

// Reporte simple para usuarios NO-Premium: un mensaje de texto libre, sin
// thread ni rating — el backend lo manda por mail al admin. `context` es
// opcional (p. ej. la ruta actual, para dar pistas de dónde pasó el problema).
export const reportBug = (message, context) =>
  post('/api/v1/support/report', { message, ...(context ? { context } : {}) });
