# Objetivo
Terminar el Bloque 2 de cumplimiento Ley 21.719 en el frontend: checkbox de mayoría de edad en registro + botón "Exportar mis datos" en /cuenta (backend ya listo).

# Criterio de término
- `npm run build` en verde.
- `src/ui/auth.js`: segundo checkbox "Declaro que soy mayor de 18 años." junto al de Términos, mismo patrón de validación obligatoria.
- `cuenta.html` + `src/cuenta.js`: botón que descarga `GET /api/v1/users/me/export` como `vyneural-mis-datos-<fecha>.json`, siguiendo el patrón de `downloadBackup` en `src/main.js:1484-1497`.
- No se tocó `terminos.html` ni el fix de `is_admin` en `auth.js` (de otra tarea).
- Sin rastro del correo personal del admin en los archivos tocados.

# Tareas
- [x] T1 · Pieza 1: segundo checkbox de edad mínima (18+) en `src/ui/auth.js`, mismo estilo/patrón que el checkbox de Términos (HTML cerca de línea 328, validación cerca de línea 515) · agente: bajo · depende de: -
- [x] T2 · Pieza 2: wrapper `exportMyData()` en `src/api/auth.js` (GET `/api/v1/users/me/export`, usa `get()` de `./client.js`), botón `#cuenta-export-data` en `cuenta.html` (zona de "Zona de peligro"/eliminar cuenta), wiring en `src/cuenta.js` (descarga como en `downloadBackup`, deshabilita botón mientras descarga, feedback de éxito/error con el patrón ya usado en el archivo) · agente: medio · depende de: -
- [x] T3 · Verificación final: `npm run build`, lectura de diff de los 3 archivos, grep del correo personal del admin, confirmar que `terminos.html` e `is_admin` quedaron intactos · agente: (orquestador) · depende de: T1, T2

# Registro
- Iteración 1: Investigación de contexto (grep/read) hecha por el orquestador para armar prompts autocontenidos: ubicado checkbox de Términos (auth.js:327-332, validación :514-516), patrón `downloadBackup` (main.js:1484-1497), sección "Zona de peligro" en cuenta.html (:296-305), wrappers existentes en `src/api/auth.js` y `src/api/client.js` (`get`, `post`, `patch`), confirmado endpoint backend `GET /api/v1/users/me/export` (`backvyneural/backend/app/routers/users.py:205-220`). Delegando T1 y T2 en paralelo.
- Iteración 2: T1 (agente bajo) y T2 (agente medio) completados. Verificación independiente del orquestador: leído `src/ui/auth.js` completo en las 2 zonas tocadas (checkbox `auth-age-18` + validación), `src/api/auth.js` completo (export `exportMyData`), sección nueva en `cuenta.html` (`#cuenta-export-data`), wiring en `src/cuenta.js` (`wireExportData`, llamada en `init()`). `npm run build` corrido por el orquestador: verde (`✓ built in 5.60s`, `cuenta.html` 23.58 kB / `cuenta-DGDEoxPU.js` 29.85 kB). Grep del correo personal del admin en los 4 archivos tocados: sin resultados. Confirmado `is_admin` intacto en `auth.js:162-164` y `terminos.html` intacto (`#edad-minima` presente, sin cambios). Criterio de término cumplido. Nada commiteado, por instrucción explícita del usuario.
