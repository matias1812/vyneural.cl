# Cuentas, verificación y sincronización (aditivo)

Desde la FASE 17 el proyecto tiene un backend opcional (FastAPI + PostgreSQL,
en `../backvyneural`). La web, la PWA y la APK siguen funcionando 100% local y
sin cuenta: todo lo que toca el backend es **aditivo** y solo actúa cuando el
usuario inicia sesión.

## Reglas de oro

- **Sin sesión, sin backend**: el generador no cambia su comportamiento.
- **Sin audio por datos**: favoritos, frecuencias, alarmas e itinerarios son
  datos sincronizados; NUNCA reproducen audio por sí solos.
- **Un aviso push no reproduce audio**: el service worker solo muestra la
  notificación; la reproducción exige gesto del usuario.

## Módulos del frontend

| Módulo | Rol |
|---|---|
| `src/api/client.js` | Fetch con token, refresh con rotación, sesión en localStorage |
| `src/api/auth.js` | register / login / logout / me / verifyEmail / resend / forgot / reset / changePassword |
| `src/ui/auth.js` | Modal login · registro (confirmar clave + términos) · olvidé mi contraseña · estados post-registro |
| `src/ui/freq-modal.js` | Modal compartido "Guardar frecuencia personalizada" (generador + `/cuenta`) |
| `src/api/fav-sync.js` | Favoritos del generador ↔ nube (idempotente, con `state_id`) |
| `src/api/push.js` | Suscripción web push VAPID por dispositivo |
| `src/cuenta.js` | `/cuenta`: perfil, favoritos, frecuencias, alarmas, dispositivos, push y desactivar cuenta |

## Páginas

- `/cuenta` — vista de usuario con sesión (badge de verificación, reenvío de
  correo, cambio de contraseña con re-autenticación, desactivar cuenta con
  confirmación por contraseña). La gestión de itinerarios (crear, pausar,
  eliminar, editar pasos) vive **solo** en `/rutina` — antes `/cuenta` tenía
  su propia copia completa del mismo formulario, que terminó divergiendo de
  la de `/rutina` (le faltaba ambiente, no podía cargar una guardada para
  editarla); se sacó por completo y quedó un link a `/rutina` en su lugar.
  `/cuenta` sigue mostrando "Mis alarmas" (incluidas las que vienen de un
  paso de itinerario, marcadas como tal — se editan desde `/rutina`).
- `/rutina` — la única página que **exige sesión siempre** (excepción a la
  regla de arriba: itinerarios y recordatorios viven en la nube, no
  localmente). Sin sesión muestra un gate de login en vez del generador de
  itinerarios; con sesión es el editor completo (crear/editar pasos, día de
  la semana, grilla semanal con horario real).
- `/verificar?token=…` — confirma el correo tras el registro.
- `/restablecer?token=…` — crea contraseña nueva desde el correo de
  recuperación.
- `/preguntas-frecuentes` — FAQ con acordeón accesible.

## Push web

- El backend publica `GET /api/v1/push/status` (VAPID); el frontend suscribe el
  dispositivo con `pushManager.subscribe` y registra el endpoint.
- `src/cuenta.js` muestra el **estado real del dispositivo** (suscrito o no) y
  avisa cuando falta contexto seguro (HTTPS / localhost).

## Desactivar cuenta

`POST /api/v1/users/me/deactivate` (backend, `routers/users.py`) exige la
contraseña actual (mismo criterio que cambiar contraseña) y marca
`User.is_active=False` — bloquea login (`routers/auth.py::login`, 403
"usuario inactivo") y cualquier request autenticado en la próxima consulta
(`deps.get_current_user` ya rechaza `is_active=False`, sin esperar a que
expire el access token vigente), y revoca todas las sesiones. No borra
ningún dato ni es reversible por el propio usuario — self-service solo
llega hasta desactivar; reactivarla requiere contacto directo (la burbuja
🐞 de reportes de la web, nunca un correo personal del equipo). El frontend
(`/cuenta`, tarjeta "⚠️ Zona de peligro") pide confirmación con modal +
contraseña antes de llamar al endpoint.

## Verificación estricta

El flag `REQUIRE_EMAIL_VERIFICATION` del backend (default `false`) bloquea el
login de correos sin confirmar. En producción conviene activarlo: la UI ya
tiene la pantalla "Confirmá tu correo" y el reenvío.

## Despliegue

- El proxy de desarrollo de Vite redirige `/api` a `http://127.0.0.1:8000`
  (`VITE_PROXY_TARGET` para cambiarlo).
- En producción, Vercel redirige `/api` al backend (Render) con `vercel.json`.
- El email se imprime en el log en dev (`EMAIL [VERIFY] / [RESET]`). En
  producción va por **Brevo** (`EMAIL_PROVIDER=brevo` + `BREVO_API_KEY`, HTTPS
  API) — Render free bloquea la salida a puertos SMTP directos (25/465/587),
  así que el proveedor por HTTPS es el único camino que funciona ahí (ver
  `../backvyneural/app/config.py`). Verificar con
  `node scripts/check-deploy.mjs` (backend/frontend/CORS/email, todo en uno).

### Reenvío honesto

`POST /api/v1/auth/resend-verification` devuelve `email_sent: bool`: `true`
si el correo se entregó por SMTP, `false` si el SMTP no está configurado o
falló (en ese caso el enlace solo se loguea). La UI usa ese flag para no
mostrar "Correo enviado ✓" cuando en realidad no salió nada, y muestra el
error de reenvío en la vista visible (bug corregido: antes caía en un div
oculto).
