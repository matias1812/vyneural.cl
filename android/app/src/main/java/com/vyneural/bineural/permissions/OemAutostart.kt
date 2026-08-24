package com.vyneural.bineural.permissions

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.vyneural.bineural.util.BineuralLog

/**
 * MIUI (Xiaomi), EMUI/Magic UI (Huawei/Honor), ColorOS (Oppo), FuntouchOS/
 * OriginOS (Vivo) y OxygenOS (OnePlus) matan alarmas/procesos en 2.º plano
 * cuando el usuario desliza la app fuera de recientes — AUNQUE la app esté en
 * la whitelist oficial de optimización de batería de Android (esa API es de
 * AOSP; estos fabricantes tienen su PROPIO gestor de "inicio automático" /
 * "apps protegidas" por fuera del estándar). Bug real reportado en vivo: un
 * recordatorio creado dentro de la APK (<5 min de anticipación) no sonó tras
 * deslizar la app de recientes, con batería y alarmas exactas ya autorizadas.
 *
 * Sin una API pública para esto (no existe en AOSP), la única vía es abrir la
 * pantalla de ajustes específica del fabricante mediante el nombre exacto de
 * su Activity — que cambia entre versiones de cada skin y no está garantizado
 * que exista. Se intenta cada candidato conocido (mismo enfoque que proyectos
 * de referencia como dontkillmyapp.com) y, si ninguno resuelve, se cae a la
 * pantalla de info de la app — mejor que no ofrecer nada.
 */
object OemAutostart {

    /** Fabricantes con gestor de inicio automático propio conocido. Samsung
     *  queda afuera: no tiene una pantalla dedicada consistente — la
     *  optimización de batería estándar (ya cubierta aparte) es lo que hay. */
    private val KNOWN_MANUFACTURERS = setOf(
        "xiaomi", "huawei", "honor", "oppo", "vivo", "oneplus", "realme",
    )

    fun manufacturer(): String = Build.MANUFACTURER.lowercase()

    /** ¿Este fabricante necesita guía de inicio automático además de la
     *  optimización de batería estándar? */
    fun needsGuidance(): Boolean = manufacturer() in KNOWN_MANUFACTURERS

    /** Candidatos conocidos por fabricante (Activity exacta del gestor de
     *  inicio automático / apps protegidas). Varios por fabricante porque el
     *  nombre cambió entre versiones de la skin. */
    private fun candidates(): List<Intent> {
        val m = manufacturer()
        val pairs: List<Pair<String, String>> = when {
            "xiaomi" in m -> listOf(
                "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            )
            "huawei" in m -> listOf(
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            )
            "honor" in m -> listOf(
                "com.hihonor.systemmanager" to "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            )
            "oppo" in m || "realme" in m -> listOf(
                "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
                "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            )
            "vivo" in m -> listOf(
                "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            )
            "oneplus" in m -> listOf(
                "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
            )
            else -> emptyList()
        }
        return pairs.map { (pkg, cls) ->
            Intent().apply {
                component = android.content.ComponentName(pkg, cls)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
    }

    /** Intenta abrir el gestor de inicio automático del fabricante; si ningún
     *  candidato resuelve (skin/versión distinta a la esperada), cae a la
     *  pantalla de info de la app — nunca falla en silencio sin abrir nada. */
    fun openSettings(context: Context) {
        for (intent in candidates()) {
            try {
                context.startActivity(intent)
                return
            } catch (_: ActivityNotFoundException) {
                // Este candidato no existe en esta versión de la skin: probar el siguiente.
            } catch (e: Exception) {
                BineuralLog.e("oem-autostart", "candidato falló: ${intent.component}", e)
            }
        }
        try {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = android.net.Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(fallback)
        } catch (e: Exception) {
            BineuralLog.e("oem-autostart", "ni el fallback de ajustes de la app pudo abrirse", e)
        }
    }
}
