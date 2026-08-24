package com.vyneural.bineural.util

import android.content.Context

/**
 * Token FCM actual, persistido en SharedPreferences. AlarmSync lo lee para
 * incluirlo en cada reporte de dispositivo (PUT /devices/me); no hace su
 * propia llamada de red — un token nuevo solo se envía en el próximo reporte
 * (inmediato si hay sesión, ver VyneuralMessagingService.onNewToken).
 */
object FcmTokenStore {
    private const val PREFS = "bineural_fcm"
    private const val KEY = "token"

    fun get(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)

    fun set(context: Context, token: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, token).apply()
    }
}
