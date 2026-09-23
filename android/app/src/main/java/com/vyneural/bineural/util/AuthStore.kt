package com.vyneural.bineural.util

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Sesión guardada por el WebView vía bridge (STORE_AUTH/CLEAR_AUTH) para que
 * el worker de sincronización en segundo plano pueda autenticarse contra el
 * backend aunque la app esté cerrada. Access token + refresh token (mismo
 * par que rota el WebView) + ids mínimos; nunca claves privadas.
 *
 * Cifrado con una clave respaldada por el Android Keystore
 * (EncryptedSharedPreferences) — antes eran SharedPreferences en texto
 * plano, legibles con root/adb backup en un dispositivo comprometido. Falla
 * en modo seguro: si el Keystore no está disponible por algún motivo (muy
 * raro), se trata como "sin sesión guardada" en vez de crashear la app o
 * caer de vuelta a texto plano en silencio.
 */
object AuthStore {
    private const val PREFS = "bineural_auth_v2"

    @Volatile private var cached: SharedPreferences? = null

    private fun prefs(context: Context): SharedPreferences? {
        cached?.let { return it }
        return synchronized(this) {
            cached ?: createEncryptedPrefs(context, allowReset = true)?.also { cached = it }
        }
    }

    private fun createEncryptedPrefs(context: Context, allowReset: Boolean): SharedPreferences? {
        return runCatching {
            val masterKey = MasterKey.Builder(context.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context.applicationContext,
                PREFS,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }.getOrElse { e ->
            BineuralLog.e("auth-store", "no se pudo inicializar el storage cifrado", e)
            // Bug real visto en vivo: AEADBadTagException/KeyStoreException
            // "Signature/MAC verification failed" — la clave del Keystore ya
            // no puede desencriptar el archivo guardado (el sistema la
            // invalidó/rotó por su cuenta en algún momento — pasa, poco
            // frecuente pero documentado en Jetpack Security). Sin este
          // reset, este storage queda roto PARA SIEMPRE en cada arranque:
            // AuthStore.save()/token() nunca vuelven a funcionar, la sesión
            // nativa nunca se guarda, y AlarmSync.run() corta apenas arranca
            // (siempre ve "sin sesión") — el dispositivo NUNCA llega a
            // reportar su token FCM. Girar la llave es imposible (la vieja
            // ciphertext quedó huérfana de una clave que ya no existe); lo
            // único que se puede hacer es borrar el archivo y empezar de
            // cero (pierde la sesión guardada UNA vez — el próximo login la
            // vuelve a guardar con una clave sana).
            if (allowReset) {
                context.applicationContext.deleteSharedPreferences(PREFS)
                createEncryptedPrefs(context, allowReset = false)
            } else {
                null
            }
        }
    }

    fun token(context: Context): String? =
        prefs(context)?.getString("access_token", null)?.takeIf { it.isNotBlank() }

    fun refreshToken(context: Context): String? =
        prefs(context)?.getString("refresh_token", null)?.takeIf { it.isNotBlank() }

    fun userId(context: Context): String? = prefs(context)?.getString("user_id", null)

    fun email(context: Context): String? = prefs(context)?.getString("email", null)

    fun save(context: Context, token: String?, refreshToken: String?, userId: String?, email: String?) {
        prefs(context)?.edit()
            ?.putString("access_token", token)
            ?.putString("refresh_token", refreshToken)
            ?.putString("user_id", userId)
            ?.putString("email", email)
            ?.apply()
    }

    /** Actualiza solo el par de tokens (rotación), sin tocar user_id/email. */
    fun saveTokens(context: Context, token: String?, refreshToken: String?) {
        prefs(context)?.edit()
            ?.putString("access_token", token)
            ?.putString("refresh_token", refreshToken)
            ?.apply()
    }

    fun clear(context: Context) {
        prefs(context)?.edit()?.clear()?.apply()
        // Restos de la versión vieja (texto plano, PREFS anterior) — borrar
        // también aunque ya no se lea de ahí, para no dejar tokens huérfanos
        // en disco en instalaciones que venían de una versión anterior.
        runCatching {
            context.getSharedPreferences("bineural_auth", Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}
