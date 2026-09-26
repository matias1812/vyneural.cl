// src/platform/platform-capabilities.js
// P0 — Separación Core / Platform.
//
// Distingue el ENTORNO real y fusiona las capacidades de la WEB
// (probeCapabilities, honestas) con las del shell NATIVO (Android) cuando el
// bridge está presente. Regla del P0 gate §2/§8:
//
//   "Un Chrome Android sigue siendo WEB" — android-native SOLO cuando el
//   bridge respondió el handshake; el user-agent jamás concede capacidades.
//
// Es pura (recibe inyección) para poder testearla headless.

/**
 * Clasifica el entorno real (nunca por UA para conceder capacidades).
 * @param {object} [env]
 * @param {string} [env.ua]            navigator.userAgent.
 * @param {boolean} [env.bridgePresent] ¿window.AndroidBridge detectado?
 * @returns {'desktop'|'android-browser'|'android-native'|'ios'|'unknown'}
 */
export function detectPlatformKind({ ua = '', bridgePresent = false } = {}) {
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  if (isIos) return 'ios';
  if (isAndroid) return bridgePresent ? 'android-native' : 'android-browser';
  if (!ua) return 'unknown';
  return 'desktop';
}

/**
 * Fusiona capacidades web + nativas en una matriz única.
 * @param {object} p
 * @param {object} p.web         Resultado de probeCapabilities().
 * @param {object|null} p.native getState() del adaptador de bridge (null si no hay APK).
 * @param {object} [p.env]       { ua, bridgePresent } para clasificar el entorno.
 * @returns {object} Matriz con provider y estados separados.
 */
export function mergePlatformCapabilities({ web, native = null, env = {} }) {
  const isNative = !!(native && native.present);
  const platformKind = detectPlatformKind({
    ua: env.ua || '',
    bridgePresent: isNative,
  });

  // Notificaciones: nativo puede avisar con la app cerrada; la web no.
  // Bug real: PermissionManager.notificationState() (Kotlin) manda el estado
  // en MAYÚSCULAS ("GRANTED"/"DENIED"/...) — comparar sin normalizar contra
  // 'granted' (minúsculas) daba SIEMPRE false en la APK, así que el modal de
  // permisos (y cualquier aviso que dependa de esta cascada) creía que el
  // permiso de notificaciones nunca estaba concedido, aunque lo estuviera.
  const nativeNotifPermRaw = native && native.info && native.info.notificationPermission;
  const nativeNotifPerm = typeof nativeNotifPermRaw === 'string' ? nativeNotifPermRaw.toLowerCase() : null;
  const notif = isNative
    ? {
        provider: 'native',
        supported: !!native.info && !!native.info.notifications,
        granted: nativeNotifPerm === 'granted',
        permission: nativeNotifPerm || web.notifications.permission,
        label: notifNativeLabel(nativeNotifPerm),
      }
    : { provider: 'web', granted: web.notifications.permission === 'granted', ...web.notifications };

  // Audio en segundo plano: web limitada; APK con Foreground Service lo
  // garantiza si el sistema lo permite.
  const backgroundAudio = isNative
    ? {
        provider: 'native',
        supported: !!native.info && !!native.info.backgroundService,
        active: !!native.info && !!native.info.backgroundServiceActive,
        label: native.info && native.info.backgroundService
          ? (native.info.backgroundServiceActive ? 'Servicio activo ✓' : 'Disponible (Foreground Service)')
          : 'No disponible en este dispositivo',
      }
    : {
        provider: 'web',
        supported: false,
        active: false,
        label: 'Limitado por el navegador (la pestaña debe seguir viva)',
      };

  // Alarmas exactas: solo la APK con el SO.
  const exactAlarms = isNative
    ? {
        provider: 'native',
        supported: !!native.info && !!native.info.exactAlarms,
        granted: !!native.info && !!native.info.exactAlarmsGranted,
        label: native.info && native.info.exactAlarms
          ? (native.info.exactAlarmsGranted ? 'Autorizadas ✓' : 'Requiere configuración del sistema')
          : 'No soportado en este dispositivo',
      }
    : {
        provider: 'web',
        supported: false,
        granted: false,
        label: 'No garantizado sin la app (requiere calendario o web abierta)',
      };

  // Optimización de batería: solo la APK. Sin la excepción, muchos
  // fabricantes (MIUI, Samsung, etc.) matan el ciclo de sincronización en
  // segundo plano (AlarmSync, cada ~5 min) — las alarmas creadas en la web
  // no llegan al reloj nativo hasta que el usuario abre la app (bug real
  // reportado: "la notificación de la apk llega solo si entro").
  const batteryUnrestricted = isNative
    ? {
        provider: 'native',
        supported: true,
        granted: !!native.info && !!native.info.batteryUnrestricted,
        label: native.info && native.info.batteryUnrestricted
          ? 'Sin restricciones ✓'
          : 'Requiere configuración del sistema (recomendado)',
      }
    : {
        provider: 'web',
        supported: false,
        granted: false,
        label: 'No aplica en el navegador',
      };

  // Inicio automático por fabricante: MIUI, EMUI/Magic UI, ColorOS,
  // FuntouchOS y OxygenOS matan alarmas al deslizar la app de recientes
  // AUNQUE la app esté en la whitelist de batería estándar — usan su propio
  // gestor de "inicio automático" por fuera de la API de Android, sin forma
  // de consultar si ya está concedido (a diferencia de batería/alarmas
  // exactas). Bug real reportado: recordatorio creado en la APK no sonó tras
  // deslizarla de recientes, con batería y alarmas exactas ya autorizadas.
  const autostartGuidance = isNative
    ? {
        provider: 'native',
        supported: !!native.info && !!native.info.needsAutostartGuidance,
        manufacturer: (native.info && native.info.manufacturer) || '',
        label: native.info && native.info.needsAutostartGuidance
          ? 'Recomendado revisar (no verificable por la app)'
          : 'No requerido en este fabricante',
      }
    : {
        provider: 'web',
        supported: false,
        manufacturer: '',
        label: 'No aplica en el navegador',
      };

  // Media Session: nativa en la APK; web depende del navegador. supported =
  // implementación REAL (no teórica); active y playbackState reflejan el
  // estado que el servicio nativo reporta (P1.5 Fase 14 — sin falsos
  // positivos).
  const mediaSession = isNative
    ? {
        provider: 'native',
        supported: !!native.info && !!native.info.mediaSession,
        active: !!native.info && !!native.info.mediaSessionActive,
        playbackState: native.info && native.info.mediaSessionPlaybackState
          ? native.info.mediaSessionPlaybackState
          : null,
        controls: native.info && native.info.mediaSessionControls
          ? native.info.mediaSessionControls
          : (native.info && native.info.mediaSession ? ['play', 'pause', 'stop'] : []),
        label: native.info && native.info.mediaSession
          ? (native.info.mediaSessionActive ? 'Controles activos ✓' : 'Disponible (al reproducir)')
          : 'No soportado',
      }
    : { provider: 'web', ...web.mediaSession, label: web.mediaSession.label };

  // Canal de alarma real: si Android puede bypassear No Molestar para las
  // alarmas de Vyneural (v8, ver NotificationHelper.kt) — requiere el
  // permiso ACCESS_NOTIFICATION_POLICY concedido A MANO por el usuario
  // (Android no lo pide con un diálogo normal, solo con un Intent a una
  // lista general). Bug real: "llega pero a veces sin alarma" en modo
  // silencio/No Molestar — setBypassDnd(true) en el canal no basta sin este
  // permiso adicional del sistema.
  const alarmChannel = isNative
    ? {
        provider: 'native',
        supported: !!native.info && !!native.info.alarmChannel && !!native.info.alarmChannel.exists,
        dndBypassGranted: !!(native.info && native.info.alarmChannel && native.info.alarmChannel.canBypassDnd),
        // Bug real: este campo faltaba acá (el único consumidor probado era la
        // copia independiente de main.js::refreshAlarmPerm, que lee
        // info.alarmChannel directo sin pasar por este merge) — sin él,
        // caps.alarmChannel.importance quedaba siempre undefined y el botón
        // "⚠️ Las alarmas están silenciadas" del modal de permisos (y
        // cualquier otro consumidor de mergePlatformCapabilities) nunca se
        // activaba pese a que el Kotlin sí manda el dato (ver
        // AndroidBridge.kt::alarmChannelDiagnostics).
        importance:
          native.info && native.info.alarmChannel && typeof native.info.alarmChannel.importance === 'number'
            ? native.info.alarmChannel.importance
            : null,
        label:
          native.info && native.info.alarmChannel && native.info.alarmChannel.exists
            ? (native.info.alarmChannel.canBypassDnd
                ? 'Suena en No Molestar ✓'
                : 'Requiere configuración del sistema (recomendado)')
            : 'Se crea al usar la primera alarma',
      }
    : {
        provider: 'web',
        supported: false,
        dndBypassGranted: false,
        importance: null,
        label: 'No aplica en el navegador',
      };

  return {
    platformKind,
    platform: isNative ? 'android' : 'web',
    native: isNative,
    notifications: notif,
    backgroundAudio,
    exactAlarms,
    batteryUnrestricted,
    autostartGuidance,
    alarmChannel,
    mediaSession,
    // La APK no cambia estas: push sigue necesitando backend; wake lock es
    // pantalla, no audio.
    wakeLock: web.wakeLock,
    push: web.push,
    audio: web.audio,
  };
}

function notifNativeLabel(perm) {
  if (perm === 'granted') return 'Nativa — concedido ✓';
  if (perm === 'denied' || perm === 'denied_permanently') return 'Nativa — denegado en el sistema';
  return 'Nativa — sin decidir';
}
