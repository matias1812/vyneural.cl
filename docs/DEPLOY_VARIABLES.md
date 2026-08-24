# Variables de despliegue — Vyneural (Render + Vercel)

> Estado verificado: **2026-08-23**. En producción está corriendo la
> **Opción B** (`EMAIL_PROVIDER=brevo`, confirmado en vivo vía
> `node scripts/check-deploy.mjs`: `provider=brevo · configured=true`) —
> Opción A (SMTP) queda documentada abajo solo como alternativa de pago, no
> es lo que está desplegado hoy. Backend real: `https://vyneural-backend.onrender.com`
> (NO `vyneural-api.onrender.com` — ese hostname no tiene servicio, `x-render-routing: no-server`).
> `node scripts/check-deploy.mjs` corre esta misma verificación (health, rewrite,
> CORS, hash del APK) contra `https://www.vyneural.cl` en un solo comando.

## Arquitectura

| Componente | Dónde vive | URL |
|---|---|---|
| Web/PWA/APK (frontend) | Vercel | `https://www.vyneural.cl` (dominio canónico; `vyneural-six.vercel.app` redirige 308 ahí) |
| API FastAPI | Render Web Service | `https://vyneural-backend.onrender.com` |
| PostgreSQL | Render Managed PostgreSQL | vinculada vía `DATABASE_URL` |

El frontend NO guarda secretos: en Vercel solo se publica el rewrite de `/api`
(`vercel.json`) o, como alternativa, `VITE_API_URL`.

---

## Render → Web Service → Environment

### Manuales — correo (OBLIGATORIAS para que lleguen los mails)

> ⚠️ **Render free BLOQUEA los puertos SMTP (25/465/587)** desde el 26/09/2025
> (changelog oficial). El SMTP de Gmail NO funciona en el plan free — el envío
> falla con error de conexión (`/health/email?test=1` → `error_kind: connect`).
> Dos caminos:
> - **A. Plan de pago en Render** (Starter): el SMTP funciona tal cual.
> - **B. Free: proveedor por HTTPS** (`EMAIL_PROVIDER=resend|brevo` + API key).
>   No está bloqueado. Resend: 100 correos/día free · Brevo: 300/día free.

**Opción A — SMTP (requiere plan de pago en Render):**

| Variable | Valor |
|---|---|
| `EMAIL_PROVIDER` | `smtp` (default) |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `matias.torres1812@gmail.com` |
| `SMTP_PASSWORD` | app password de Gmail (nunca en Git; ya está en `backend/.env` local) |
| `SMTP_FROM` | `matias.torres1812@gmail.com` |
| `SMTP_FROM_NAME` | `Vyneural` |
| `SMTP_TLS` | `true` |
| `SMTP_SSL` | `false` |
| `FRONTEND_BASE_URL` | `https://www.vyneural.cl` *(nunca localhost: es la base de los enlaces del correo)* |

**Opción B — HTTPS API (gratis, recomendada en Render free):**

| Variable | Valor |
|---|---|
| `EMAIL_PROVIDER` | `resend` o `brevo` |
| `RESEND_API_KEY` | `re_…` (resend.com → API Keys; verificar el remitente en Resend) |
| `BREVO_API_KEY` | `xkeysib-…` (brevo.com → SMTP & API → API Keys) |
| `SMTP_FROM` | el correo **verificado** en el proveedor |
| `SMTP_FROM_NAME` | `Vyneural` |

### Manuales — API / push

| Variable | Valor |
|---|---|
| `VAPID_PUBLIC_KEY` | generada con `py -m app.push.keys` (o la del `.env` local) |
| `VAPID_PRIVATE_KEY` | ídem (secreta) |
| `VAPID_SUBJECT` | `mailto:matias.torres1812@gmail.com` |
| `CORS_ORIGINS` | `https://www.vyneural.cl,https://vyneural.cl,https://vyneural-six.vercel.app,null,file://` *(`null`/`file://`: origen opaco del WebView de la APK, sin origen http/https propio)* |
| `ENVIRONMENT` | `production` |
| `LOG_LEVEL` | `INFO` |
| `FIREBASE_CREDENTIALS_JSON` | el JSON **completo** de la cuenta de servicio de Firebase (Consola Firebase → ⚙️ Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada), pegado tal cual como valor de una sola variable — no un archivo. Sin esto, el push FCM a la APK es un no-op silencioso: el `AlarmManager` nativo sigue funcionando igual, solo se pierde la entrega cuando el proceso está muerto. |

### Automáticas / generadas por Render

| Variable | Origen |
|---|---|
| `DATABASE_URL` | se vincula sola desde la PostgreSQL (blueprint) |
| `JWT_SECRET` | `generateValue` del blueprint (o generarla a mano) |
| `JWT_REFRESH_SECRET` | ídem |

### Opcionales

| Variable | Default | Nota |
|---|---|---|
| `REQUIRE_EMAIL_VERIFICATION` | `false` | `true` **solo después** de confirmar que el correo llega (si no, nadie inicia sesión) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `15` | — |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | — |
| `EMAIL_VERIFICATION_EXPIRE_MINUTES` | `1440` | TTL del token de verificación (24 h) |
| `PASSWORD_RESET_EXPIRE_MINUTES` | `30` | TTL del token de reset |

---

## Vercel → Proyecto `bineural`

**Sin variables obligatorias.** El único requisito es que el rewrite de `/api`
esté publicado. Vía `vercel.json` (ya corregido en este repo):

```json
"rewrites": [
  { "source": "/api/:path*", "destination": "https://vyneural-backend.onrender.com/api/:path*" }
]
```

> ⚠️ El destination debe ser la URL REAL del servicio Render. Si el servicio se
> llama distinto (p. ej. `vyneural-backend`), usar ESA URL, no la del blueprint.

**Alternativa sin `vercel.json`:** en Vercel → Project → Settings → Environment
Variables → `VITE_API_URL=https://vyneural-backend.onrender.com` (Production) y
redeploy. Ojo: se incrusta en el build; hay que re-desplegar al cambiarla.

---

## Checklist post-deploy

```bash
# 1) Backend vivo
curl -s https://vyneural-backend.onrender.com/health        # → {"status":"ok",...}
curl -s https://vyneural-backend.onrender.com/health/db     # → database ok
curl -s -o /dev/null -w "%{http_code}\n" https://vyneural-backend.onrender.com/docs  # → 200

# 2) Rewrite del frontend (401 "no autorizado" del FastAPI = OK; página 404 de Vercel = NO publicado)
curl -s -w "\n%{http_code}\n" https://www.vyneural.cl/api/v1/auth/me

# 3) Correo: pedir un reset (llega un mail real si el SMTP está configurado)
curl -s -X POST https://vyneural-backend.onrender.com/api/v1/auth/forgot-password \
  -H "Content-Type: application/json" -d '{"email":"TU-EMAIL"}'
# → revisar bandeja + spam; si solo aparece en los logs de Render, el SMTP no está bien

# 4) Automatizado
node scripts/check-deploy.mjs
```

## Troubleshooting — `email_sent: false` (el correo no sale de Render)

`POST /api/v1/auth/resend-verification` devuelve `email_sent: bool`. Si es
`false`, el backend ACEPTÓ el reenvío pero **no entregó el correo**. Orden de
revisión:

1. **¿Es un plan free de Render?** Desde 2026-09 Render free bloquea los puertos
   SMTP 25/465/587 → el envío falla con error de conexión aunque las variables
   estén perfectas. Verificar con `/health/email?test=1`:
   `error_kind: connect` = bloqueo de Render (o red). Solución: plan de pago o
   `EMAIL_PROVIDER=resend|brevo` (HTTPS, no bloqueado).
2. **¿Están las variables en el servicio CORRECTO?** El servicio real es
   `vyneural-backend` (no `vyneural-api`, que ni siquiera existe). Abrir
   Render → el servicio → Environment y confirmar `SMTP_HOST`, `SMTP_USER`,
   `SMTP_PASSWORD`, `SMTP_FROM` (o `EMAIL_PROVIDER` + API key).
2. **Logs de Render**: en Logs buscar `EMAIL [VERIFY] failed to=... error=...`
   (muestra el error exacto del SMTP) o `EMAIL [VERIFY] sent` (entregado). Si
   al arrancar aparece `PRODUCTION sin SMTP_HOST`, las variables no llegaron a
   ese servicio.
3. **App password de Gmail**: `SMTP_PASSWORD` debe ser una *app password*
   (requiere 2FA activado en la cuenta) — no la contraseña normal. Revisar
   también si Gmail avisó de un inicio de sesión bloqueado (alerta de
   seguridad) y aprobarlo.
4. **Redesplegar tras cambiar variables**: si se editaron las variables después
   del último deploy, forzar Render → Manual Deploy → Deploy branch.
5. Verificación final: `node scripts/check-deploy.mjs --email TU-EMAIL` y/o
   registrar un usuario y tocar "Reenviar" → debe devolver `email_sent: true`.

## Cómo se publica

1. **Render**: el deploy sale de GitHub (`matias1812/vyneural-backend`) por push a
   la rama conectada, o botón "Manual Deploy → Deploy branch" en el dashboard.
2. **Vercel**: el deploy sale de GitHub (`matias1812/vyneural.cl`) por push a la
   rama de producción (ver Vercel → Settings → Git → Production Branch), o
   "Redeploy" en el dashboard. El `vercel.json` corregido debe llegar a esa rama.
