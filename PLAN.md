# Objetivo
Complemento frontend de E1-E4 del backend (ver backvyneural/backend/PLAN.md): selector de canal al otorgar Premium manual desde el admin, y filtro "Premium sin canal (huérfano)" en el listado de usuarios.

# Criterio de término
`renderAdminUserRow` tiene un `<select>` de canal (Sin canal/Google Play/Oneclick/Webpay Plus) que viaja en el body de `grantUserPremium` solo si no está vacío. Checkbox "Solo Premium sin canal" arriba de la lista que manda `orphan_premium=true` a `listAdminUsers` y recarga desde la página 1. `npm run build` en verde. Sin commit/push.

# Tareas
- [x] F1 · Selector de canal en "Otorgar Premium" (`src/admin.js` renderAdminUserRow + wiring, `src/api/admin.js::grantUserPremium`) · agente: expert · depende de: -
- [x] F2 · Filtro "Premium huérfano" (`admin.html`, `src/admin.js`, `src/api/admin.js::listAdminUsers`) · agente: expert · depende de: -

# Tareas (ronda 3 — SEO)
- [x] G1 · Agregar `/reembolso` al sitemap, `<lastmod>` en todas las URLs (fechas reales de git log por página, presets dinámicos con la fecha de hoy), y `Disallow` explícito en robots.txt para `/admin` + rutas transaccionales (`/oneclick-retorno`, `/pago-retorno`, `/restablecer`, `/verificar`) · agente: (implementado directo por la sesión principal, cambio chico y de bajo riesgo)

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
