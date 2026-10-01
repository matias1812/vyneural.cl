# Objetivo
Complemento frontend de E1-E4 del backend (ver backvyneural/backend/PLAN.md): selector de canal al otorgar Premium manual desde el admin, y filtro "Premium sin canal (huérfano)" en el listado de usuarios.

# Criterio de término
`renderAdminUserRow` tiene un `<select>` de canal (Sin canal/Google Play/Oneclick/Webpay Plus) que viaja en el body de `grantUserPremium` solo si no está vacío. Checkbox "Solo Premium sin canal" arriba de la lista que manda `orphan_premium=true` a `listAdminUsers` y recarga desde la página 1. `npm run build` en verde. Sin commit/push.

# Tareas
- [x] F1 · Selector de canal en "Otorgar Premium" (`src/admin.js` renderAdminUserRow + wiring, `src/api/admin.js::grantUserPremium`) · agente: expert · depende de: -
- [x] F2 · Filtro "Premium huérfano" (`admin.html`, `src/admin.js`, `src/api/admin.js::listAdminUsers`) · agente: expert · depende de: -

# Tareas (ronda 3 — SEO)
- [x] G1 · Agregar `/reembolso` al sitemap, `<lastmod>` en todas las URLs (fechas reales de git log por página, presets dinámicos con la fecha de hoy), y `Disallow` explícito en robots.txt para `/admin` + rutas transaccionales (`/oneclick-retorno`, `/pago-retorno`, `/restablecer`, `/verificar`) · agente: (implementado directo por la sesión principal, cambio chico y de bajo riesgo)

# Tareas (ronda 4 — reemplazar Gastos por Facturas de consultoría)
- [x] H3 · Remover UI de "Gastos del mes" del todo (admin.html, admin.js, api/admin.js) + estilo del checkbox de filtro huérfano (hoy es un `<label><input>` plano sin clase, el usuario reportó que se ve como "un check gigante") · agente: expert · depende de: -
- [x] H4 · Nueva UI "Facturas de consultoría" (mismo patrón que la sección borrada) · agente: expert · depende de: H3

# Registro
- Iteración 1 (2026-09-28): Implementadas F1 y F2, `npm run build` en verde, sin commit.
  - F1:
    - `src/admin.js:604-611` — nuevo `<label>Canal (opcional)<select class="admin-user-channel">` (Sin canal/google_play/oneclick/webpay_plus) agregado a la `cuenta-form-row` de `renderAdminUserRow`.
    - `src/admin.js:687-698` — `wireAdminUserRows`: agregado `const channelSel = row.querySelector('.admin-user-channel')`; el body de `grantUserPremium` ahora incluye `channel: channelSel.value || undefined` en ambas ramas (lifetime y no-lifetime). `JSON.stringify` (usado por `src/api/client.js::performFetch`, línea ~252) omite claves `undefined`, así que "Sin canal" no viaja como `channel` en el body — confirmado leyendo `client.js`.
    - `.admin-user-revoke` y `.admin-user-days` no se tocaron.
    - `src/api/admin.js::grantUserPremium` (líneas 84-86) no necesitó cambios: ya recibe `body` genérico y lo reenvía tal cual.
  - F2:
    - `admin.html:37-44` — nuevo `<div class="admin-inline-row"><label><input type="checkbox" id="admin-users-orphan-filter" /> Solo Premium sin canal (huérfano)</label></div>` debajo del form de búsqueda existente. Sin clases CSS nuevas.
    - `src/api/admin.js:72-79` — `listAdminUsers` ahora acepta `orphanPremium = false`; si es `true` agrega `params.set('orphan_premium', 'true')`. Único caller existente (`src/admin.js:758`) no se rompe por el default.
    - `src/admin.js:575` — nueva variable de módulo `let adminUsersOrphanOnly = false;` junto a `adminUsersPage`/`adminUsersSearchTerm`.
    - `src/admin.js:758` — `loadAdminUsers` pasa `adminUsersOrphanOnly` como 4.º argumento a `listAdminUsers`.
    - `src/admin.js:766-798` (`wireAdminUsersForm`) — agregado `const orphanFilter = $('admin-users-orphan-filter')` y su listener `change` que setea `adminUsersOrphanOnly`, resetea `adminUsersPage = 1` y llama `loadAdminUsers()`.
  - Verificación: `npm run build` → `✓ built in 5.14s`, sin errores (solo los warnings preexistentes de `node:fs` externalizado en `validation/diagnostics.js`, no relacionados).
- Iteración 2 (2026-09-29): Implementadas H3 y H4, `npm run build` en verde, sin commit. Backend (repo `backvyneural`) implementado en paralelo por otro agente con el contrato exacto asumido acá (`consulting_invoices`/`consulting_invoice_summary` en `GET /monthly`, sin `total_iva_credit`/`iva_a_pagar_neto` en `f29`).
  - H3 (remover "Gastos"):
    - `admin.html:177-228` — sección `admin-accounting-expenses-section` completa (form + tabla + resumen) borrada; reemplazada en el mismo lugar por la nueva sección de facturas de consultoría (ver H4).
    - `admin.html:42-44` — el `<div class="admin-inline-row">` del checkbox huérfano ahora también lleva `admin-checkbox-row` (nueva clase chica, ver fix de estilo abajo).
    - `src/admin.js:21` — import cambiado de `createExpense, listExpenses, deleteExpense` a `createConsultingInvoice, listConsultingInvoices, deleteConsultingInvoice`.
    - `src/admin.js` — borrado `ADMIN_EXPENSE_CATEGORIES` (estaba antes de `renderMonthlyAccounting`); borradas del render del F29 las líneas `<p>IVA Crédito Fiscal (gastos)…</p>` e `<p>IVA a Pagar (neto)…</p>` (esos campos ya no vienen del backend); borrado el bloque completo de render de gastos (destructuring `expenses`/`expense_summary`, tabla, resumen) dentro de `renderMonthlyAccounting`; borrado el wiring del form de gastos + delegación de borrado dentro de `wireMonthlyAccounting`.
    - `src/api/admin.js:135-147` — `createExpense`/`listExpenses`/`deleteExpense` borradas.
    - **Fix de estilo del checkbox huérfano** — causa raíz encontrada: `src/site.css:3964` define `.admin-inline-row { … }` y justo debajo `.admin-inline-row input { flex: 1 1 200px; }` — como es selector descendiente (no hijo directo), también agarraba el `<input type="checkbox">` anidado dentro del `<label>`, estirándolo a 200px de ancho mínimo y haciéndolo verse como "un check gigante". Fix: `src/site.css` (después de esa regla) agrega `.admin-checkbox-row label { display:flex; align-items:center; gap:6px; }` y `.admin-checkbox-row input[type='checkbox'] { flex:none; width:auto; }`, scoped a la nueva clase `admin-checkbox-row` agregada solo a ese `<div>` — no afecta a los otros 7 usos de `.admin-inline-row` en `admin.html` (todos con inputs de texto/fecha/número, que sí necesitan el `flex: 1 1 200px`).
  - H4 (nueva "Facturas de consultoría"):
    - `admin.html:177-206` — nueva sección `admin-accounting-consulting-invoices-section`/`admin-consulting-invoice-section`: form con Fecha/Cliente/Descripción/N° documento (opcional)/Monto neto/Monto IVA (sin categoría, a diferencia de gastos), tabla `admin-consulting-invoices-table` (Fecha/Cliente/Descripción/N° doc/Neto/IVA/Acción), resumen `admin-consulting-invoice-summary`.
    - `src/api/admin.js:135-149` — nuevas `createConsultingInvoice`/`listConsultingInvoices`/`deleteConsultingInvoice` apuntando a `/api/v1/admin/accounting/consulting-invoices` (mismo patrón fino que las de gastos borradas).
    - `src/admin.js` (`renderMonthlyAccounting`) — nuevo bloque que destructura `consulting_invoices`/`consulting_invoice_summary` de `data` y renderiza tabla + resumen (mismo patrón que gastos, botón `.admin-consulting-invoice-delete-btn` con `data-id`).
    - `src/admin.js` (`wireMonthlyAccounting`) — wiring del form `admin-consulting-invoice-form` (crea vía `createConsultingInvoice`, resetea el form, recarga `loadMonthlyAccounting()`) + delegación de click en `.admin-consulting-invoice-delete-btn` (confirma, borra vía `deleteConsultingInvoice`, recarga).
  - Verificación: `npm run build` → `✓ built in 7.42s`, sin errores (mismos warnings preexistentes de `node:fs`, no relacionados). No se tocó nada de Android/Kotlin, `premium.js`, `native-bridge.js`, ni F1/F2 salvo el fix puntual de estilo pedido.
