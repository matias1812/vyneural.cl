// ════════════════════════════════════════════════════════════════════════════
// Burbuja (FAB) del chat de soporte — SOLO el botón, sin lógica de chat.
// ─────────────────────────────────────────────────────────────────────────────
// Se separó de support-chat.js para que la burbuja pueda existir desde el
// arranque de la página (hay que poder hacerle click) sin arrastrar el resto
// del chat: modal, cliente WebSocket, polling y su CSS se cargan después, con
// import() dinámico, desde support-chat-boot.js.
//
// Vive en su propio módulo (y no duplicado en boot + support-chat) para que
// haya UNA sola definición del markup/ids: support-chat.js:build() llama a
// esta misma función y reusa el botón que el boot ya montó, en vez de crear
// una segunda burbuja encima de la primera.
//
// Su estilo (.support-fab*) se queda en site.css a propósito: es lo único del
// chat que es crítico en toda página. Ver src/support-chat.css.
// ════════════════════════════════════════════════════════════════════════════

export const SUPPORT_FAB_ID = 'support-fab';

/**
 * Monta la burbuja flotante si no existe todavía y la devuelve.
 * Idempotente: llamarla dos veces devuelve el mismo botón, nunca crea otro.
 */
export function ensureSupportFab() {
  const existing = document.getElementById(SUPPORT_FAB_ID);
  if (existing) return existing;

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = SUPPORT_FAB_ID;
  fab.className = 'support-fab';
  fab.setAttribute('aria-label', 'Chat de soporte');
  fab.setAttribute('title', 'Chat de soporte');
  fab.innerHTML = `
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
    <span class="support-fab-pulse" aria-hidden="true"></span>
    <span class="support-fab-label">Chat de soporte</span>
  `;
  document.body.appendChild(fab);
  return fab;
}
