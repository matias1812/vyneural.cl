# Data Safety — insumo para el formulario de Play Console

Este documento no es la política de privacidad (esa es `/privacidad`, la fuente
legal de cara al usuario) — es una transcripción directa del inventario real de
datos del código a las categorías que pide el formulario de **Data Safety** de
Play Console (Play Console → tu app → Política → Seguridad de datos), para no
tener que re-derivar esto a mano al completarlo. Fuente: modelos SQLAlchemy del
backend (`backvyneural/backend/app/models/*.py`), única fuente de verdad de lo
que realmente se guarda.

Regla general aplicable a TODAS las filas de abajo: nada se vende ni se
comparte con terceros para publicidad; los únicos "terceros" que ven datos son
subprocesadores necesarios para operar el servicio (Render, Vercel, Upstash/
QStash, Firebase, Transbank, Google Play) — cada uno solo ve lo estrictamente
necesario para su función (ver `/privacidad` para el detalle por proveedor).

## Info personal (Personal info)

| Dato | ¿Se recolecta? | ¿Se comparte? | Para qué | ¿Opcional? | Fuente |
|---|---|---|---|---|---|
| Email | Sí | No | Cuenta, login, avisos de vencimiento/renovación | Obligatorio (es el usuario) | `User.email` |
| Nombre de usuario / display name | Sí | No | Identificación dentro de la app | Opcional | `User.username` |
| Contraseña | Sí (hash bcrypt, nunca en texto plano) | No | Autenticación | Obligatorio | `User.password_hash` |

## Info financiera (Financial info)

| Dato | ¿Se recolecta? | ¿Se comparte? | Para qué | ¿Opcional? | Fuente |
|---|---|---|---|---|---|
| Historial de compras (plan, monto, canal, fecha) | Sí | No (salvo el propio procesador del pago: Transbank o Google, dueños de la transacción) | Otorgar/gestionar Premium, soporte | No aplica (se genera al comprar) | `Payment` (plan, amount, currency, channel, buy_order, authorized_at) |
| Últimos 4 dígitos + tipo de tarjeta | Sí, SOLO para Oneclick Mall (auto-renovación web) | No | Mostrar qué tarjeta está guardada en `/cuenta` | No aplica | `CardInscription.card_last_digits`, `.card_type` |
| Número completo de tarjeta | **Nunca** — ni Transbank Webpay/Oneclick ni Google Play devuelven esto a este backend | — | — | — | — |

## Actividad en la app (App activity)

| Dato | ¿Se recolecta? | ¿Se comparte? | Para qué | ¿Opcional? | Fuente |
|---|---|---|---|---|---|
| Contenido de usuario (frecuencias, favoritos, alarmas, itinerarios, preferencias) | Sí | No | Funcionalidad central de la app (sincronizar entre dispositivos) | Opcional (la app funciona sin cuenta, solo local) | modelos de alarmas/itinerarios/favoritos, `UserPreferences` |
| Registro de auditoría interno (qué acción, cuándo) | Sí, sin datos sensibles en el detalle | No | Soporte/debugging | No aplica | `AuditEvent` |

## IDs de dispositivo / otros (Device or other IDs)

| Dato | ¿Se recolecta? | ¿Se comparte? | Para qué | ¿Opcional? | Fuente |
|---|---|---|---|---|---|
| Token FCM (push nativo Android) | Sí, solo APK | Sí, con Firebase (Google) para poder entregar la notificación | Recordatorios/alarmas cuando el proceso está muerto | Opcional (requiere permiso de notificaciones) | `Device.fcm_token` |
| device_id (UUID generado por el cliente) | Sí | No | Identificar el dispositivo para sync de alarmas | No aplica | `Device.device_id` |
| Endpoint + claves de Web Push | Sí, solo navegador web | Sí, con el proveedor de push del navegador (necesario para entregar el push) | Recordatorios en web | Opcional | `PushSubscription` |
| Dirección IP | Sí, asociada a la sesión (no a cada request individual) | No | Seguridad de la sesión (detectar reuso indebido de un refresh token) | No aplica | `RefreshSession.ip_address` (o equivalente) |
| User-Agent | Sí | No | Igual que IP — contexto de la sesión | No aplica | `RefreshSession`/`Device` |

## Lo que NO se recolecta (para descartar categorías del formulario)

- Ubicación (ni precisa ni aproximada).
- Contactos, fotos/video, mensajes, registros de llamadas/SMS.
- Advertising ID / IDFA — no hay SDK de publicidad ni analytics de terceros en
  el APK nativo (Vercel Web Analytics/Speed Insights son solo del sitio web,
  cookieless, y no se ejecutan dentro del shell nativo de Android).
- Datos de salud (Health Connect u otra API de salud) — el aviso médico
  (`/aviso-medico`) es contenido informativo, no una integración de datos de
  salud.

## Permisos sensibles de Android — justificación para el formulario

| Permiso | Cuándo se pide | Justificación a declarar en Play Console |
|---|---|---|
| `SCHEDULE_EXACT_ALARM` | Bajo demanda, solo cuando el usuario programa una alarma con hora exacta — no al abrir la app | La app es un reproductor de frecuencias/alarmas de bienestar: el usuario espera que la alarma suene a la hora exacta elegida, no aproximada. |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Bajo demanda, para que el sync de alarmas en segundo plano sobreviva a los gestores de batería agresivos de algunos fabricantes | Sin esto, algunos fabricantes (ver `OemAutostart.kt`) matan el proceso y las alarmas programadas no llegan a sonar. |

Ninguno de los dos requiere código adicional — es completar el formulario de
Play Console citando lo de arriba.

## Borrado de cuenta/datos (pregunta obligatoria del formulario)

Play Console pregunta explícitamente si la app permite pedir el borrado de
cuenta/datos. Hoy **no hay un endpoint self-service** (`backend/app/routers/
users.py` solo implementa desactivación, no borrado duro) — el flujo real es
manual, ya documentado en `/privacidad` (línea ~188): el usuario escribe por
la burbuja de contacto 🐞 y se borra la cuenta y todo su contenido a mano.
Para el formulario de Play Console, esto se declara como "sí, mediante
solicitud" con el link a `/privacidad` como referencia del proceso — no hace
falta un botón in-app para un primer envío. Construir el borrado real
(`DELETE /users/me` con sus implicancias de auditoría) queda como mejora de
fase 2, no bloquea esta publicación.
