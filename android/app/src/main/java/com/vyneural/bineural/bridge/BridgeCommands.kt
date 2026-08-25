package com.vyneural.bineural.bridge

/**
 * Whitelist de comandos permitidos. Espejo EXACTO de
 * `src/platform/native-bridge.js` (BRIDGE_COMMANDS). Cualquier comando fuera
 * de esta lista se rechaza con DENIED — jamás se ejecuta algo arbitrario
 * desde el contenido web (P1 security).
 */
object BridgeCommands {
    val ALL: Set<String> = setOf(
        "GET_PLATFORM_CAPABILITIES",
        "START_BACKGROUND_AUDIO",
        "STOP_BACKGROUND_AUDIO",
        "PAUSE_BACKGROUND_AUDIO",
        "RESUME_BACKGROUND_AUDIO",
        "SCHEDULE_ALARM",
        "CANCEL_ALARM",
        "REQUEST_NOTIFICATION_PERMISSION",
        "REQUEST_EXACT_ALARM_PERMISSION",
        "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        "REQUEST_AUTOSTART_SETTINGS",
        "OPEN_EXPERIMENT",
        "OPEN_SETTINGS",
        "SET_FULLSCREEN",
        "SET_ORIENTATION",
        "TEST_NOTIFICATION",
        "SAVE_ICS",
        "SET_WAVE",
        "SET_AUDIO_LEVEL",
        "RETUNE_BACKGROUND_AUDIO",
        "GET_AUDIO_STATE",
        "GET_MEDIA_SESSION_STATE",
        "GET_NAV_STATE",
        "OPEN_NOTIFICATION_SETTINGS",
        "OPEN_ALARM_CHANNEL_SETTINGS", // salta directo al canal "Alarmas Vyneural" (Importancia), no a la lista general
        "SESSION_END", // M1 — aviso nativo de fin de sesión (la WebView no muestra new Notification())
        "STORE_AUTH", // sesión del WebView → prefs nativas (worker de sync en 2.º plano)
        "CLEAR_AUTH", // cierre de sesión → limpiar prefs nativas + alarmas sincronizadas
        "SYNC_ALARMS", // recordatorio/itinerario creado o editado → resincronizar YA (no esperar el ciclo de ~5 min)
        "API_REQUEST", // HTTP nativo (sin CORS): el WebView de la APK (file://) no puede
        //               hacer fetch al backend porque su origen es opaco (null).
    )

    fun isAllowed(command: String): Boolean = command in ALL
}
