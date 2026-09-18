package com.vyneural.bineural

import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.vyneural.bineural.audio.AudioForegroundService
import com.vyneural.bineural.bridge.AndroidBridge
import com.vyneural.bineural.sync.AlarmSync
import com.vyneural.bineural.diag.Diagnostics
import com.vyneural.bineural.lifecycle.LifecycleManager
import com.vyneural.bineural.notifications.AlarmScheduler
import com.vyneural.bineural.notifications.NotificationHelper
import com.vyneural.bineural.permissions.PermissionManager
import com.vyneural.bineural.util.BineuralLog

/**
 * Shell Android (P1): carga la web Vyneural desde assets locales (offline,
 * sin servidor) y le inyecta `window.AndroidBridge` con el contrato exacto de
 * `src/platform/native-bridge.js`. UN WebView, UN servicio de audio, UNA
 * sesión — cero duplicación.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var scheduler: AlarmScheduler
    private lateinit var permissions: PermissionManager
    // P4-B — historial MANUAL de páginas: con file:// + shouldOverrideUrlLoading
    // el WebView no acumula historial (canGoBack() siempre false), así que el
    // BACK del sistema salía de la app en vez de volver a la página anterior.
    // Este stack es la fuente de verdad de la navegación hacia atrás. NUNCA
    // toca el audio: el sonido lo sostiene el Foreground Service aparte.
    private val pageStack = ArrayDeque<String>()
    // Página actual cacheada: `webView.url` solo puede leerse desde el hilo
    // main, y el bridge (GET_NAV_STATE) corre en el hilo JavaBridge. Este
    // campo se actualiza en loadLocalPageInternal (main) y es @Volatile para
    // que el diagnóstico lo lea sin tocar el WebView desde otro hilo.
    @Volatile
    private var currentPage = "index"

    companion object {
        // Extras del Intent que abre MainActivity al tocar la notificación de
        // una alarma (ver NotificationHelper.alarmNotification): deep link a la
        // frecuencia exacta configurada, paridad con el Web Push
        // (backend/app/services/reminders.py:_deep_link + public/sw.js).
        const val EXTRA_FREQ = "vyneural_extra_freq"
        const val EXTRA_BEAT = "vyneural_extra_beat"
        const val EXTRA_WAVE = "vyneural_extra_wave"
        const val EXTRA_AUTOSTART = "vyneural_extra_autostart"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        scheduler = AlarmScheduler(this)
        permissions = PermissionManager(this)
        NotificationHelper.ensureChannels(this)
        Diagnostics.bridgeStatus = "PENDING"

        webView = WebView(this)
        setContentView(webView)
        // targetSdk 36 fuerza edge-to-edge sin ningún opt-out (el atributo
        // legacy solo existía para targetSdk 35) — sin esto, el WebView
        // dibuja contenido debajo de la barra de estado/navegación en vez de
        // respetarla (bug real visto en vivo: "la app se ve más larga, la
        // barra de notificaciones queda atrás"). Se le da el padding
        // correcto directo del lado nativo — no depende de que la web
        // coopere con env(safe-area-inset-*) (que hoy no existe en el CSS).
        // setImmersiveMode() sigue funcionando igual: cuando oculta las
        // barras los insets bajan a 0 y este padding se reduce solo.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        // P4-B — BACK (tecla y gesto Android 13+) usa el historial manual de
        // páginas; cuando se agota, el callback se deshabilita y el sistema
        // cierra la Activity como siempre.
        onBackPressedDispatcher.addCallback(this, onBack)
        // Solo debug: permite inspeccionar/controlar la WebView por CDP
        // (adb forward → chrome://inspect) para la validación P2 en
        // dispositivo/emulador. Nunca en release (BuildConfig.DEBUG=false).
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        // P3 — P5.1: el WebView NO puede iniciar reproducción de medios sin un
        // gesto del usuario. En la APK el audio real pertenece al servicio
        // nativo (la WebView solo dibuja: su motor queda mudo y su <audio>
        // pausado). Cero autoplay → una vía menos de reproducción espontánea.
        s.mediaPlaybackRequiresUserGesture = true
        s.allowFileAccess = true
        s.useWideViewPort = true
        // Los módulos ES del build de Vite se cargan en modo CORS y el origen
        // file:// es opaco: sin esto Chromium bloquea los .js en silencio y la
        // app se queda en la pantalla de carga. Solo habilita file→file (la
        // app es 100% offline; nada externo necesita acceso universal).
        s.allowFileAccessFromFileURLs = true

        webView.addJavascriptInterface(AndroidBridge(this, scheduler, permissions), "AndroidBridgeNative")

        // Push de eventos nativos al JS: cambios de audio focus (llamadas, otro
        // audio, Bluetooth) para el log de interferencias del HUD / /diagnostico.
        AudioForegroundService.onFocusStateChange = { label ->
            pushToWeb("window.dispatchEvent(new CustomEvent('vyneural:audiofocus',{detail:{state:'$label'}}))")
        }
        // Cambios de reproducción desde los controles del SO (lock screen,
        // notificación, Bluetooth): pause/resume/stop para sincronizar la UI
        // de la WebView con el motor nativo (P1.5 — la UI nunca inventa estado).
        AudioForegroundService.onPlaybackStateChange = { state ->
            pushToWeb("window.dispatchEvent(new CustomEvent('vyneural:audioplayback',{detail:{state:'$state'}}))")
        }
        // Adelantar/retroceder la frecuencia desde los controles del SO
        // (skip/seek): la UI web se re-sincroniza con el nuevo base/beat del
        // motor nativo ('vyneural:audiofreq').
        AudioForegroundService.onFrequencyChange = { base, beat ->
            pushToWeb("window.dispatchEvent(new CustomEvent('vyneural:audiofreq',{detail:{base:$base,beat:$beat}}))")
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith("file:///android_asset/bineural/")) return false
                // Enlaces externos (GitHub, Instagram, fuentes): abrir en el
                // navegador del sistema, nunca dentro de la WebView.
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (e: Exception) {
                        BineuralLog.e("webview", "no external browser for $url")
                    }
                    return true
                }
                val path = request.url.path ?: "/"
                val page = path.trim('/').ifEmpty { "index" }
                loadLocalPage(page)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                injectBridge()
                Diagnostics.bridgeStatus = if (view.url?.startsWith("file://") == true) "CONNECTED" else "ERROR"
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    BineuralLog.e("webview", "error ${error.errorCode} → ${request.url}")
                    // P4-B — el fallback a index NO debe empujar la página rota
                    // al historial (si no, BACK volvería al error y rebotaría).
                    loadLocalPageInternal("index", push = false)
                }
            }
        }

        // Deep link: si la app se abrió tocando la notificación de una alarma
        // (ver NotificationHelper), arrancar directo en esa frecuencia en vez
        // de la pantalla por defecto.
        loadLocalPageInternal("index", push = true, query = deepLinkQuery(intent))

        // Sincronización en segundo plano: programa el ciclo periódico (30
        // min, auto-reprogramable, sobrevive reboot) y, si hay sesión,
        // sincroniza las alarmas del servidor de inmediato. Las alarmas
        // creadas en la WEB llegan a la APK y disparan con la app cerrada.
        AlarmSync.run(this)
    }

    /** Envía JavaScript al WebView (eventos nativos → JS). */
    fun pushToWeb(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }

    /** Pantalla completa (immersive): oculta/muestra las barras del sistema. */
    fun setImmersiveMode(enabled: Boolean) {
        Diagnostics.immersiveActive = enabled
        runOnUiThread {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val controller = window.insetsController
                if (enabled) controller?.hide(WindowInsets.Type.systemBars())
                else controller?.show(WindowInsets.Type.systemBars())
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = if (enabled) {
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                        View.SYSTEM_UI_FLAG_FULLSCREEN or
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                } else {
                    View.SYSTEM_UI_FLAG_VISIBLE
                }
            }
        }
    }

    /** Rotación: portrait / landscape / sensor (libera). */
    fun setOrientation(mode: String) {
        runOnUiThread {
            requestedOrientation = when (mode) {
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }
    }

    /** Carga una página local (MPA de Vite): /privacidad → privacidad.html. */
    private fun loadLocalPage(page: String) = loadLocalPageInternal(page, push = true)

    private fun loadLocalPageInternal(page: String, push: Boolean, query: String? = null) {
        val clean = page.replace(Regex("[^A-Za-z0-9_-]"), "").ifEmpty { "index" }
        if (push) {
            val current = currentPage
            // No empujar si ya estamos en esa página (evita stack infinito) ni
            // duplicar entradas consecutivas iguales.
            if (current != clean && (pageStack.isEmpty() || pageStack.last() != current)) {
                pageStack.addLast(current)
            }
        }
        currentPage = clean
        val suffix = if (query.isNullOrEmpty()) "" else "?$query"
        webView.loadUrl("file:///android_asset/bineural/$clean.html$suffix")
    }

    /** Query string ?freq=&beat=&wave=&autostart=true a partir de los extras
     *  del Intent (ver companion object), o null si el intent no es un deep
     *  link de alarma. `autostart` acá solo prepara la UI para el gesto del
     *  usuario — el propio src/main.js (deepAutostart) nunca reproduce audio
     *  sin ese gesto (REGLA DE ORO), igual que el deep link del Web Push. */
    private fun deepLinkQuery(intent: Intent?): String? {
        if (intent == null || !intent.hasExtra(EXTRA_FREQ)) return null
        val freq = intent.getDoubleExtra(EXTRA_FREQ, 0.0)
        if (freq <= 0) return null
        val beat = intent.getDoubleExtra(EXTRA_BEAT, 10.0)
        val wave = intent.getStringExtra(EXTRA_WAVE)?.takeIf { it.isNotBlank() } ?: "sine"
        val autostart = intent.getBooleanExtra(EXTRA_AUTOSTART, false)
        val q = StringBuilder("freq=").append(freq).append("&beat=").append(beat).append("&wave=").append(wave)
        if (autostart) q.append("&autostart=true")
        return q.toString()
    }

    /** launchMode="singleTask" (manifest): un segundo tap en la notificación
     *  de alarma con la app ya abierta llega acá, no a un onCreate nuevo. Sin
     *  este override, ese segundo tap no navegaba a nada (gap detectado en la
     *  auditoría). Solo navega si el intent trae un deep link real: un tap en
     *  la notificación del reproductor (sin extras) no debe interrumpir la
     *  pantalla donde el usuario esté. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val query = deepLinkQuery(intent) ?: return
        loadLocalPageInternal("index", push = true, query = query)
    }

    /** Nombre de la página actual (cacheado; nunca toca el WebView desde
     *  hilos no-main — el bridge corre en JavaBridge). */
    private fun currentPageName(): String = currentPage

    /** Estado de navegación para el diagnóstico (P4-B): página actual, historial
     *  manual y si el BACK está habilitado. Nunca toca el audio. */
    fun navState(): String {
        val j = org.json.JSONObject()
            .put("current", currentPageName())
            .put("stack", org.json.JSONArray(pageStack.toList()))
            .put("backEnabled", pageStack.isNotEmpty())
        return j.toString()
    }

    /** Inyecta window.AndroidBridge con el contrato exacto del JS (P0). */
    private fun injectBridge() {
        val js = """
            if (!window.AndroidBridge) {
              window.AndroidBridge = {
                version: AndroidBridgeNative.getVersion(),
                postMessage: function (m) {
                  try {
                    // El adapter ya manda un JSON string (el objeto nativo solo
                    // acepta String): si m es string se pasa tal cual, si es
                    // objeto se serializa. Idempotente, sin doble stringify.
                    var raw = (typeof m === 'string') ? m : JSON.stringify(m);
                    return JSON.parse(AndroidBridgeNative.postMessage(raw));
                  } catch (e) { return null; }
                },
                getPlatformInfo: function () {
                  try { return JSON.parse(AndroidBridgeNative.getPlatformInfo()); } catch (e) { return null; }
                }
              };
            }
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        LifecycleManager.onResume()
        // Sincronización al volver a primer plano: si hay sesión, las alarmas
        // creadas en la web mientras la app estuvo cerrada llegan al instante
        // (no hay que esperar el ciclo periódico). No-op si no hay token.
        AlarmSync.run(this)
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        LifecycleManager.onPause()
    }

    override fun onStop() {
        super.onStop()
        LifecycleManager.onStop()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    // P4-B — BACK del sistema (tecla y gesto) navega al historial manual. Al
    // agotarse (estamos en la home) el callback se deshabilita y el sistema
    // cierra la actividad como siempre. Nada de esto toca el audio nativo.
    private val onBack = object : androidx.activity.OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val prev = pageStack.removeLastOrNull()
            if (prev != null) {
                loadLocalPageInternal(prev, push = false)
            } else {
                finish()
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        this.permissions.onRequestPermissionsResult(requestCode, grantResults)
    }
}
