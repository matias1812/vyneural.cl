# Checklist manual — corte de sesión Premium y limpieza de notificaciones enviadas

Generado para verificar en UI real los cambios de los commits `10d38d5` y
`58bd1f9` (ya confirmados correctos a nivel de código, ver reporte del agente).
Entorno local:

- Frontend: http://localhost:5177/  (`npm run dev`, puerto puede variar si
  cambia; revisar el log de Vite si no carga)
- Backend: http://localhost:8000/  (`uvicorn --reload`)
- Usuario de prueba (Premium lifetime ya otorgado en la DB local):
  - Email: `test-manual-verify@gmail.com`
  - Password: `TestManual123!`

Usar Chrome normal (no incógnito) para que persista `localStorage`.

## Escenario 1 — Corte de sesión al desloguear con Premium activo

- [ ] Abrir `http://localhost:5177/` en Chrome.
- [ ] Iniciar sesión con el usuario de prueba de arriba (botón de cuenta,
      arriba a la derecha).
- [ ] En la pantalla principal, seleccionar el preset **"Divino"** (o
      cualquier tarjeta marcada como Premium) y tocar play.
- [ ] Confirmar que empieza a sonar (indicador de reproducción activo /
      audio audible).
- [ ] Abrir el menú de cuenta (ícono de usuario, arriba a la derecha) → click
      en **"Cerrar sesión"** (`auth-menu-danger`, ícono de salida).
- [ ] Confirmar, inmediatamente tras el click:
      - El audio se detiene al instante (no sigue sonando ni un segundo más).
      - El estado visual vuelve a un preset gratuito (ya no queda "Divino"
        seleccionado).
- [ ] Refrescar la página → confirmar que sigue en estado gratis y deslogueado
      (no reaparece sesión Premium fantasma).
- [ ] Volver a loguear con el mismo usuario → confirmar que Premium se
      restaura sin errores (el preset "Divino" vuelve a estar disponible).

## Escenario 2 — Notificaciones enviadas se limpian tras verlas

- [ ] Con sesión iniciada, abrir la campana (`#alarm-btn`, ícono de
      recordatorio en la barra superior).
- [ ] Ir a la sección "Notificaciones enviadas" dentro del modal.
- [ ] Si no hay ninguna entrada, generar una con el botón de "Probar
      notificación" del propio modal (dispara `POST /alarms/test-notification`)
      y refrescar la lista.
- [ ] Anotar cuántas entradas hay y el texto de la primera.
- [ ] Cerrar el modal.
- [ ] Reabrir la campana → la lista debe estar vacía o mostrar solo entradas
      NUEVAS generadas después del cierre (las ya vistas no deben reaparecer).
- [ ] Refrescar la página completa → confirmar que el estado persiste (no
      reaparecen las viejas; el watermark vive en `localStorage` bajo la key
      `vyneural_alarm_notif_seen_before`, visible en DevTools → Application →
      Local Storage).

## Bonus — Retune en pausa (commit `58bd1f9`)

- [ ] Reproducir cualquier preset, pausar.
- [ ] Con el audio en pausa, cambiar a otro preset (ej. "Divino").
- [ ] Tocar play → debe sonar el preset NUEVO, no el que estaba pausado antes.
- [ ] Repetir el mismo cambio de preset pero SIN pausar (cambiando mientras
      suena) → confirmar que sigue funcionando como siempre (no debe
      regresionar).

Registrar para cada escenario: **PASS / FAIL / BLOQUEADO** + captura de
pantalla si falla algo.
