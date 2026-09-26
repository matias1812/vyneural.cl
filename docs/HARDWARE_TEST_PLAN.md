# Plan de hardware físico — Vyneural (H1–H8)

> Criterio: nada se marca PASS sin `IMPLEMENTADO + EJECUTADO + OBSERVADO + VERIFICADO`.
> Esta matriz separa lo que quedó **verificado en emulador (Android 14)** de lo que
> **requiere hardware físico** (etiquetado `NOT_TESTED` con el dispositivo exacto).

## Resumen

| # | Ítem | Emulador | Hardware físico |
|---|---|---|---|
| H1 | Alarma con la app **cerrada** (proceso muerto) | ✅ PASS | ✅ redundante (lógica cerrada) |
| H2 | Alarma con **pantalla bloqueada** | ✅ PASS (sin keyguard: screen off) | ⚠️ NOT_TESTED (keyguard real) |
| H3 | Audio en **segundo plano / pantalla apagada** | ✅ PASS | ⚠️ NOT_TESTED (doze real) |
| H4 | **Bluetooth** (controles + desconexión) | ❌ no aplica | ⚠️ NOT_TESTED (auriculares BT reales) |
| H5 | **Kill por OEM** (Samsung/Xiaomi/Huawei) | ❌ no aplica | ⚠️ NOT_TESTED (dispositivo OEM) |
| H6 | **Reinicio real** → BootReceiver → alarma | ⚠️ PARCIAL (lógica + emulador) | ⚠️ NOT_TESTED (reboot real) |
| H7 | **Ducking por llamada** (audio focus externo) | ✅ PASS (llamada simulada real: gsm call → LOSS_TRANSIENT → pausa → recuperación) | ⚠️ NOT_TESTED (llamada real en operadora) |
| H8 | **PWA instalada** (WebAPK real) | ✅ PARCIAL (instalabilidad + --app standalone) | ⚠️ NOT_TESTED (Chrome del emulador roto) |

## Evidencia de emulador (ejecutada en esta fase)

### H1 — Alarma con APK cerrada ✅ PASS
Cadena completa automatizada (`scripts/alarm-chain-test.mjs`, 6/6):
1. `SCHEDULE_ALARM` responde OK.
2. `dumpsys alarm` → PendingIntent en el reloj del SO (`RTC_WAKEUP · ALARM_<id>`).
3. `kill -9` del proceso → el reloj del SO conserva la alarma.
4. Al dispararse, el SO despierta el proceso solo para el broadcast.
5. Notificación nativa única con el título esperado (`count=1`).
6. Registro persistente consumido (un solo disparo).

### H2/H3 — Pantalla apagada con audio ✅ PASS (sin keyguard)
- `input keyevent 26` (apagado de pantalla; el emulador no tiene keyguard/PIN).
- `dumpsys audio` → **AudioTrack nativo `state:started`** (session 641, 44.1 kHz,
  stereo) — el audio sigue saliendo con la pantalla apagada.
- Notificación del reproductor presente (`id=1001`, canal `bineural_player`,
  `vis=PUBLIC` → visible en la pantalla de bloqueo de un dispositivo real).
- Unlock: la sesión sigue PLAYING; el watchdog de focus no tuvo que actuar
  (`focusReacquireCount=0`).

### H6 — Reboot: lógica verificada ✅, reboot real pendiente
- `BootReceiver` reprograma desde `SharedPreferences` (`rescheduleAll`) — código
  revisado; la persistencia de alarmas y el disparo tras proceso muerto están
  verificados (H1). Falta el reboot real del dispositivo.

### H8 — PWA: instalabilidad + runtime standalone ✅ (Chrome del host)
- `scripts/pwa-audit.mjs install` → **PASS 7/7**: HTTPS, manifest válido
  (display=standalone, start=/), iconos 192+512, SW registrado y controlando,
  viewport.
- `scripts/pwa-audit.mjs standalone` (Chrome `--app`, display-mode standalone) →
  **PASS 7/7**: display-mode `standalone`, SW controlando, audio ruta única
  (element · gain 0.60 · rms 0.266 · sid=1), MediaSession con metadata,
  badge = "PWA" (nunca falso APK), AudioContext **no suspendido** al pasar a
  segundo plano.
- **Bloqueo del emulador**: el Chrome del emulador (113, x86_64) crashea al
  arrancar (`pid=(not running)`), por lo que la **instalación WebAPK real** no
  pudo ejecutarse en él → queda como H8 físico.

## Pendientes físicos (NOT_TESTED) — dispositivo requerido

| Ítem | Dispositivo | Qué verificar |
|---|---|---|
| H2 real | Teléfono con PIN/patrón | Alarma con pantalla bloqueada + keyguard → notificación visible e interactuable |
| H3 real | Teléfono en doze | Audio nativo con screen off prolongado (5+ min) sin corte |
| H4 | Auriculares Bluetooth reales | Play/pause/stop por los controles BT; desconexión BT → duck/pausa y recuperación |
| H5 | Samsung / Xiaomi / Huawei | Kill del proceso por el "reciente" del fabricante → alarma sigue (OEM specific). **También pendiente en estos fabricantes** (agregado 2026-09-26, no cubierto por esta fila hasta ahora): la degradación instantánea de importancia del canal de alarma al conceder el permiso (confirmada solo en Honor/Magic OS, ver `docs/NOTIFICATION_CHANNEL_HISTORY.md` v12 y `NotificationHelper.channelDegraded`) — el código es agnóstico de fabricante, pero nadie confirmó todavía si el mismo síntoma aparece en Samsung OneUI / Xiaomi MIUI-HyperOS / Huawei. |
| H6 real | Teléfono | Reboot → BootReceiver reprograma → alarma dispara con app cerrada |
| H7 | Teléfono con SIM | Llamada entrante → audio focus LOSS_TRANSIENT → duck/pausa y recuperación al colgar |
| H8 real | Teléfono con Chrome sano | Instalar la PWA (WebAPK) desde el menú de Chrome → standalone real con su proceso |

## Rutina recurrente (exclusiva de la APK)

- **Alcance**: la repetición por días (L M X J V S D) y la página `/rutina`
  existen SOLO dentro de la APK. Web/PWA: recordatorios de una sola vez (el
  navegador no puede reprogramar con la pestaña cerrada).
- **Automatizado**: `node scripts/alarm-chain-test.mjs <segundos>` programa,
  mata el proceso y verifica la notificación. Para rutinas, añadir `days` al
  payload de `SCHEDULE_ALARM` (p. ej. `[1,4]`) y comprobar en `dumpsys alarm`
  que tras el disparo aparece la próxima ocurrencia (p. ej. `origWhen` del
  lunes siguiente) y que la notificación llega con la app muerta.
- **En físico**: repetir el mismo ciclo en un teléfono real (H1 con días),
  incluida la vibración observable en el dispositivo.

## Cómo ejecutar cada ítem pendiente

```bash
# H2/H3: alarma + lock
node scripts/alarm-chain-test.mjs 70   # y bloquear el teléfono durante la espera

# H8: auditoría PWA (Chrome del host; el emulador no sirve)
node scripts/pwa-audit.mjs install      # contra Chrome headless (puerto 9224)
node scripts/pwa-audit.mjs standalone   # contra Chrome --app (puerto 9225)

# H1: cadena de alarma automatizada (emulador)
node scripts/alarm-chain-test.mjs 70
```

## Checklists para dispositivo físico

### H4 — Bluetooth real (auriculares BT)

**Dispositivo:** cualquier teléfono Android (8.0+) + auriculares Bluetooth (TWS/over-ear).

**Preparación:** instalar la release (`adb install public/vyneural.apk` o copiar la APK),
emparejar y conectar los auriculares, iniciar una sesión (volumen ~0.4) y verificar
que suena por los auriculares.

| # | Paso | Esperado | Evidencia a capturar |
|---|---|---|---|
| 1 | Botón **Play/Pause** del auricular | El audio se pausa/reanuda (MediaSession `play`/`pause` handler) | Estado de la UI (playing ↔ paused) + `GET_AUDIO_STATE` |
| 2 | Botón **Next/Previous** del auricular | Cambia de estado de contenido (selectState), NO navega páginas | Estado nuevo + `GET_NAV_STATE` (stack intacto) |
| 3 | Volumen BT (rockers) | El audio sigue, el volumen del sistema cambia | Nivel de volumen observado |
| 4 | **Desconectar** los auriculares | Audio nativo sigue o pausa limpia sin glitch; al reconectar, se recupera (o el usuario reanuda) | Logcat `AudioForegroundService` + `GET_AUDIO_STATE` |
| 5 | Conectar auriculares **con sesión en pausa** | La sesión NO arranca sola (sin falso positivo de capacidad) | Estado sigue paused |
| 6 | Pantalla bloqueada + controles BT | Play/pause desde lock screen via BT funciona | Pantalla de bloqueo mostrando controles + audio respondiendo |

**Criterio PASS:** #1, #2, #4 sin glitch y con recuperación; #5 sin auto-start.

### iOS Safari (Web/PWA — no APK)

**Dispositivo:** iPhone (iOS 16/17) + Safari. La APK no aplica; esto valida el
camino `direct` + ancla muda (fallback específico de iOS, único camino de audio
web sin validación en dispositivo).

| # | Paso | Esperado | Evidencia a capturar |
|---|---|---|---|
| 1 | Abrir https://www.vyneural.cl en Safari | Página carga; el badge muestra "Web" (nunca "APK") | Screenshot del badge |
| 2 | Tocar **Play** | El audio arranca tras un gesto (requisito de iOS); AudioContext `running` | `GET_AUDIO_STATE`/probe → `ctx: running` |
| 3 | Audio con pantalla encendida + interacciones (menú, scroll, cambiar estado) | Sin cortes ni glitches; `sid=1` estable | Muestras del probe durante interacciones |
| 4 | **Bloquear pantalla** (botón lateral) | Comportamiento documentado: iOS suele pausar web audio al bloquear; si se pausa, es LIMITACIÓN DE PLATAFORMA esperada, no bug | Nota de qué ocurrió (pausa vs continua) |
| 5 | Minimizar Safari y volver | El contexto no muere; al volver reanuda si estaba sonando | `ctx` state al volver |
| 6 | Notificaciones (si aplica) | Permiso solicitado al activar la función; sin claims falsos de background | Estado del permiso |

**Criterio PASS:** #1–#3 sin glitch; #4 documentado como limitación de iOS si pausa
(no se intenta un hack para forzar background — prohibido por el contrato).

## Estado del plan

- Emulador: **H1, H2-parcial, H3, H6-lógica, H8-parcial** ejecutados y verificados;
  **H7-ducking** verificado con llamada simulada real (`gsm call` → LOSS_TRANSIENT →
  pausa → recuperación al colgar).
- Físico: **H2, H3, H4, H5, H6, H7, H8** → `NOT_TESTED` con el dispositivo
  exacto arriba. No se declara PASS físico sin el hardware.
