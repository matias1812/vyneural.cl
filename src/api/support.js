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
//   POST /api/v1/support/conversations/{id}/rate             calificar (BORRA
//        la conversación del lado servidor — ver support-chat.js, que limpia
//        su estado local en el mismo paso, nunca vuelve a pedir este id).

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

// Califica y BORRA la conversación del lado servidor: no se puede volver a
// pedir este id después de esto (404 esperado). `cannedMessage` es opcional.
export const rateConversation = (conversationId, rating, cannedMessage) =>
  post(`/api/v1/support/conversations/${conversationId}/rate`, {
    rating,
    ...(cannedMessage ? { canned_message: cannedMessage } : {}),
  });
