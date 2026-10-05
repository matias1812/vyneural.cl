// ════════════════════════════════════════════════════════════════════════════
// Arranque diferido del chat de soporte.
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE ESTE ARCHIVO (auditoría Lighthouse móvil, 2026-10-03):
// site.js importaba support-chat.js de forma ESTÁTICA, así que toda página del
// sitio descargaba y ejecutaba el chat completo (modal, cliente WebSocket,
// polling, premium-gate) además de su CSS, aunque la enorme mayoría de las
// visitas nunca abre el chat. En el reporte eso aparecía como el chunk
// `support-ws-client` + un pedazo grande de CSS sin usar.
//
// Ahora site.js importa SOLO este archivo, que es deliberadamente mínimo:
//   1. monta la burbuja (support-fab.js) — tiene que estar pintada desde el
//      arranque para poder recibir el click;
//   2. publica window.__bugReport como proxy perezoso, para que el menú ⋯ del
//      generador (main.js, action === 'bug') siga funcionando igual;
//   3. hace `import('./support-chat.js')` recién cuando el usuario interactúa
//      con la burbuja.
//
// EXCEPCIÓN IMPORTANTE — conversación ya abierta:
// support-chat.js arranca un polling de fondo al cargar la página SI hay una
// conversación conocida en localStorage, y es lo único que dispara el banner
// de "tenés un mensaje nuevo" con el chat cerrado (ver el trade-off
// documentado en la cabecera de support-chat.js). Si el módulo solo se
// cargara al hacer click, ese aviso proactivo desaparecería para quien dejó
// una conversación abierta. Por eso, cuando la clave existe, el módulo se
// carga igual — pero en tiempo de inactividad (requestIdleCallback), fuera
// del camino crítico del primer render. Quien nunca usó el chat (y cualquier
// visita nueva, incluido un audit de Lighthouse con perfil limpio) no paga
// nada hasta tocar la burbuja.
//
// REGLA DE ORO: acá no se reproduce ni se prepara audio de ninguna clase.
// Este módulo solo monta UI de soporte y difiere red; no toca el motor de
// audio ni ningún autostart.
// ════════════════════════════════════════════════════════════════════════════

import { ensureSupportFab } from './support-fab.js';

// Clave única de la conversación en localStorage. Se define acá (y
// support-chat.js la importa de este módulo) para que exista UNA sola
// definición: el boot necesita leerla ANTES de cargar el chat, así que no
// puede importarla del chat sin anular el import dinámico.
export const LS_CONV_ID = 'vyneural_support_conversation_id';

let api = null; // API real del chat, una vez inicializado
let loading = null; // promesa del import() en vuelo
let openPending = false; // ya hay una apertura esperando a que termine la carga

/**
 * Carga + inicializa el chat de soporte una sola vez.
 * Si el import falla (red caída, chunk no disponible) se olvida la promesa
 * para que un segundo intento del usuario pueda reintentar.
 */
function loadSupportChat() {
  if (api) return Promise.resolve(api);
  if (!loading) {
    loading = import('./support-chat.js')
      .then((mod) => {
        api = mod.initSupportChat();
        return api;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/** Precarga silenciosa (hover/foco/pointerdown): el click después no espera. */
function warmSupportChat() {
  loadSupportChat().catch(() => {
    /* se reintenta en el click; no hay nada que avisar en una precarga */
  });
}

/**
 * Abre el chat, cargándolo antes si hace falta. Único dueño del gesto de
 * apertura: support-chat.js ya NO cablea el click de la burbuja (si lo
 * hiciera, después de la primera carga habría dos handlers y open() correría
 * dos veces por click, duplicando el round-trip de premium/conversación).
 */
export function openSupportChat() {
  if (api) {
    api.open();
    return;
  }
  if (openPending) return; // clicks repetidos mientras carga: una sola apertura
  openPending = true;
  loadSupportChat()
    .then((a) => {
      openPending = false;
      a.open();
    })
    .catch(() => {
      openPending = false;
    });
}

function closeSupportChat() {
  if (api) api.close();
}

function hasStoredConversation() {
  try {
    return !!localStorage.getItem(LS_CONV_ID);
  } catch {
    return false; // sin almacenamiento disponible: nada que retomar
  }
}

function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 4000 });
  else window.setTimeout(fn, 1500);
}

function initSupportChatBoot() {
  const fab = ensureSupportFab();

  // Precarga en cuanto el usuario se acerca a la burbuja: `pointerenter`
  // cubre el mouse (hover, bastante antes del click), `pointerdown` el táctil
  // (donde no hay hover) y `focus` la navegación por teclado.
  fab.addEventListener('pointerenter', warmSupportChat, { once: true });
  fab.addEventListener('pointerdown', warmSupportChat, { once: true });
  fab.addEventListener('focus', warmSupportChat, { once: true });
  fab.addEventListener('click', openSupportChat);

  // Proxy perezoso de la API histórica. Se publica YA (no después de cargar)
  // porque main.js hace `if (window.__bugReport) window.__bugReport.open()` y
  // avisa por consola si no existe: sin esto, la opción "reportar un
  // problema" del menú ⋯ quedaría muerta hasta que alguien tocara la burbuja.
  // Cuando el chat real se inicializa, support-chat.js reemplaza este objeto
  // por el verdadero ({ open, close, fab }); hasta entonces `fab` se expone
  // como getter para no devolver un nodo distinto del que está en el DOM.
  window.__bugReport = {
    open: openSupportChat,
    close: closeSupportChat,
    get fab() {
      return document.getElementById('support-fab');
    },
  };

  // Ver la "EXCEPCIÓN IMPORTANTE" de la cabecera: con una conversación ya
  // abierta el chat se carga igual, pero sin estorbar al primer render.
  if (hasStoredConversation()) whenIdle(warmSupportChat);
}

if (typeof document !== 'undefined') {
  if (document.readyState !== 'loading') initSupportChatBoot();
  else document.addEventListener('DOMContentLoaded', initSupportChatBoot);
}
