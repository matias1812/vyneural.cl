package com.vyneural.bineural.billing

import android.app.Activity
import android.os.Handler
import android.os.Looper
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.vyneural.bineural.util.AuthStore
import com.vyneural.bineural.util.BineuralLog
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Wrapper fino sobre BillingClient — SOLO habla con Google Play. Nunca llama
 * al backend: eso lo hace la web (api/billing.js), con el resultado de acá
 * pasado de vuelta por el bridge — mismo criterio que el resto de esta app
 * (ver AndroidBridge.kt::API_REQUEST): Kotlin no duplica lógica de auth/red
 * que ya existe del lado JS.
 *
 * REGLA análoga a la de audio: esto nunca otorga Premium por su cuenta — solo
 * entrega {purchaseToken, orderId, productId} de una compra real que Google
 * ya procesó. Otorgar Premium es 100% responsabilidad del backend, después
 * de verificar ESE token contra la Android Publisher API (ver
 * routers/payments.py::google_play_verify) — nunca se confía en este
 * resultado del lado cliente.
 */
class PlayBillingManager(private val activity: Activity) : PurchasesUpdatedListener {
    private var client: BillingClient? = null
    private var pendingCallback: ((JSONObject) -> Unit)? = null

    private fun ensureClient(onReady: (BillingClient) -> Unit, onError: (String) -> Unit) {
        val existing = client
        if (existing != null && existing.isReady) {
            onReady(existing)
            return
        }
        val fresh = BillingClient.newBuilder(activity)
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
            )
            .build()
        client = fresh
        // 2026-09-24: startConnection() no tenía NINGUNA protección — si
        // onBillingSetupFinished nunca llegaba (Play Store no responde,
        // servicio no disponible), el flujo entero quedaba colgado en el
        // primer paso, antes incluso de llegar a los timeouts de
        // queryPurchasesAsync/queryProductDetailsAsync de más abajo. Mismo
        // patrón de timeout+fallback que esos dos.
        val resolved = AtomicBoolean(false)
        val timeoutRunnable = Runnable {
            if (resolved.compareAndSet(false, true)) {
                BineuralLog.d("play-billing", "startConnection no contestó a tiempo")
                onError("no pudimos conectar con Google Play, reintentá")
            }
        }
        mainHandler.postDelayed(timeoutRunnable, CONNECT_TIMEOUT_MS)
        fresh.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (!resolved.compareAndSet(false, true)) return
                mainHandler.removeCallbacks(timeoutRunnable)
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    onReady(fresh)
                } else {
                    onError("billing setup failed: ${result.debugMessage} (${result.responseCode})")
                }
            }

            override fun onBillingServiceDisconnected() {
                // Best-effort: el próximo startPurchase() reconecta solo
                // (ensureClient reconstruye si !isReady). Si había una compra
                // en curso, no dejarla colgada en silencio hasta que el
                // timeout de 5 min del lado JS expire sin explicación — se
                // resuelve acá mismo con un error claro y accionable.
                mainHandler.removeCallbacks(timeoutRunnable)
                resolved.set(true)
                BineuralLog.d("play-billing", "servicio de facturación desconectado")
                pendingCallback?.let { cb ->
                    pendingCallback = null
                    cb(JSONObject().put("error", "servicio de facturación desconectado, reintentá"))
                }
            }
        })
    }

    /**
     * Lanza el flujo de compra real de Play para `productId`. `isSubscription`
     * decide si se consulta como SUBS (mensual/anual) o INAPP (de por vida) —
     * ver billing/plans.py::GOOGLE_PLAY_PRODUCT_IDS del lado backend, mismos
     * IDs. El resultado llega por `onResult`, UNA vez, con uno de:
     *   {purchaseToken, orderId, productId} → compra completada
     *   {cancelled: true} → el usuario cerró el flujo de Play sin comprar
     *   {error: "..."} → fallo real (red, producto no encontrado, etc.)
     */
    fun startPurchase(productId: String, isSubscription: Boolean, onResult: (JSONObject) -> Unit) {
        pendingCallback = onResult
        ensureClient(
            onReady = { billingClient -> queryAndLaunch(billingClient, productId, isSubscription, onResult) },
            onError = { message -> onResult(JSONObject().put("error", message)) },
        )
    }

    // Antes de abrir el diálogo de Play, se chequea si el producto YA está
    // comprado (compra "huérfana": Google la procesó pero nuestro backend
    // nunca llegó a verificarla — típicamente porque la sesión murió a mitad
    // del flujo, ver premium.js). Si existe, se devuelve directo sin abrir
    // el diálogo — el reintento de verifyGooglePlayPurchase en premium.js la
    // recupera solo. Un intento anterior de esto dejaba el botón colgado
    // para siempre si queryPurchasesAsync nunca llamaba a su callback (causa
    // exacta no confirmada — posible gotcha de threading de BillingClient);
    // por eso ahora esto tiene un timeout manual acotado (QUERY_TIMEOUT_MS):
    // si no contesta a tiempo, se seguí igual al flujo normal en vez de
    // bloquear el botón indefinidamente otra vez.
    private val mainHandler = Handler(Looper.getMainLooper())

    private companion object {
        const val QUERY_TIMEOUT_MS = 3000L
        const val QUERY_DETAILS_TIMEOUT_MS = 6000L
        const val CONNECT_TIMEOUT_MS = 8000L
    }

    private fun queryAndLaunch(
        billingClient: BillingClient,
        productId: String,
        isSubscription: Boolean,
        onResult: (JSONObject) -> Unit,
    ) {
        val productType = if (isSubscription) BillingClient.ProductType.SUBS else BillingClient.ProductType.INAPP
        val resolved = AtomicBoolean(false)
        val timeoutRunnable = Runnable {
            if (resolved.compareAndSet(false, true)) {
                BineuralLog.d("play-billing", "queryPurchasesAsync no contestó a tiempo — sigo directo al flujo normal")
                launchNewPurchase(billingClient, productId, isSubscription, onResult)
            }
        }
        mainHandler.postDelayed(timeoutRunnable, QUERY_TIMEOUT_MS)

        val queryParams = QueryPurchasesParams.newBuilder().setProductType(productType).build()
        billingClient.queryPurchasesAsync(queryParams) { _, purchases ->
            if (!resolved.compareAndSet(false, true)) return@queryPurchasesAsync
            mainHandler.removeCallbacks(timeoutRunnable)
            val orphan = purchases.firstOrNull { p ->
                p.purchaseState == Purchase.PurchaseState.PURCHASED && p.products.contains(productId)
            }
            if (orphan != null) {
                BineuralLog.d("play-billing", "compra huérfana recuperada sin abrir Play: $productId")
                // Resuelve acá directo (nunca pasa por onPurchasesUpdated, que
                // es lo único que normalmente limpia pendingCallback) — hay
                // que limpiarlo a mano, si no un onPurchasesUpdated posterior
                // (de otra compra, o un evento tardío de Play) llamaría este
                // mismo callback ya usado una segunda vez.
                if (pendingCallback === onResult) pendingCallback = null
                onResult(
                    JSONObject()
                        .put("purchaseToken", orphan.purchaseToken)
                        .put("orderId", orphan.orderId ?: "")
                        .put("productId", orphan.products.firstOrNull() ?: productId)
                )
            } else {
                launchNewPurchase(billingClient, productId, isSubscription, onResult)
            }
        }
    }

    private fun launchNewPurchase(
        billingClient: BillingClient,
        productId: String,
        isSubscription: Boolean,
        onResult: (JSONObject) -> Unit,
    ) {
        val productType = if (isSubscription) BillingClient.ProductType.SUBS else BillingClient.ProductType.INAPP
        val product = QueryProductDetailsParams.Product.newBuilder()
            .setProductId(productId)
            .setProductType(productType)
            .build()
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(product)).build()
        // Mismo gotcha que queryPurchasesAsync en queryAndLaunch(): si este
        // callback de Play nunca llega, el botón quedaba colgado hasta el
        // timeout de 5min del lado JS (PLAY_PURCHASE_TIMEOUT_MS) sin ningún
        // mensaje — confirmado como causa real de "se queda cargando" en
        // /premium al comprar "de por vida" en la APK (2026-09-24). Mismo
        // patrón de timeout manual acotado que la consulta anterior.
        val resolved = AtomicBoolean(false)
        val timeoutRunnable = Runnable {
            if (resolved.compareAndSet(false, true)) {
                BineuralLog.d("play-billing", "queryProductDetailsAsync no contestó a tiempo")
                onResult(JSONObject().put("error", "no pudimos consultar el producto, reintentá"))
            }
        }
        mainHandler.postDelayed(timeoutRunnable, QUERY_DETAILS_TIMEOUT_MS)
        billingClient.queryProductDetailsAsync(params) { billingResult, productDetailsResult ->
            if (!resolved.compareAndSet(false, true)) return@queryProductDetailsAsync
            mainHandler.removeCallbacks(timeoutRunnable)
            val details = productDetailsResult.productDetailsList.firstOrNull()
            if (billingResult.responseCode != BillingClient.BillingResponseCode.OK || details == null) {
                onResult(JSONObject().put("error", "producto no encontrado: $productId (${billingResult.debugMessage})"))
                return@queryProductDetailsAsync
            }
            val productDetailsParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
            if (isSubscription) {
                val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
                if (offerToken != null) productDetailsParams.setOfferToken(offerToken)
            }
            val flowParamsBuilder = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productDetailsParams.build()))
            // Correlaciona la compra con nuestro usuario del lado de Google —
            // sin esto, RTDN (routers/payments.py::google_play_rtdn) no tiene
            // forma de saber a quién otorgarle Premium si el cliente nunca
            // vuelve a avisar (sesión muerta, app matada a mitad de compra).
            AuthStore.userId(activity)?.takeIf { it.isNotBlank() }?.let { userId ->
                flowParamsBuilder.setObfuscatedAccountId(userId)
            }
            activity.runOnUiThread {
                // 2026-09-24: launchBillingFlow() devuelve un BillingResult
                // SÍNCRONO que dice si la pantalla de compra realmente se
                // pudo abrir — se descartaba por completo. Si Play la
                // rechaza (ej. ITEM_ALREADY_OWNED: una compra de prueba
                // anterior de "de por vida" quedó sin consumir/confirmar,
                // muy plausible siendo un producto no-consumible) nunca
                // llega ningún onPurchasesUpdated, y sin chequear esto el
                // botón quedaba colgado hasta el timeout de 5min del lado
                // JS sin ningún mensaje — reportado en vivo: "de por vida"
                // se cuelga y los otros dos planes (suscripciones) sí
                // funcionan, justo la asimetría que predice esta causa.
                val launchResult = billingClient.launchBillingFlow(activity, flowParamsBuilder.build())
                if (launchResult.responseCode != BillingClient.BillingResponseCode.OK) {
                    val msg = if (launchResult.responseCode == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
                        "esta cuenta de Google ya tiene esta compra registrada — probá con otra cuenta o contactá soporte para liberarla"
                    } else {
                        "no se pudo abrir la pantalla de compra: ${launchResult.debugMessage} (${launchResult.responseCode})"
                    }
                    onResult(JSONObject().put("error", msg))
                }
            }
        }
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val callback = pendingCallback ?: return
        pendingCallback = null
        when {
            result.responseCode == BillingClient.BillingResponseCode.USER_CANCELED ->
                callback(JSONObject().put("cancelled", true))
            result.responseCode != BillingClient.BillingResponseCode.OK || purchases.isNullOrEmpty() ->
                callback(JSONObject().put("error", "compra no completada: ${result.debugMessage} (${result.responseCode})"))
            else -> {
                val purchase = purchases.first()
                callback(
                    JSONObject()
                        .put("purchaseToken", purchase.purchaseToken)
                        .put("orderId", purchase.orderId ?: "")
                        .put("productId", purchase.products.firstOrNull() ?: "")
                )
                // Sin acknowledge acá a propósito: lo hace el backend
                // server-side recién después de verificar la compra contra
                // Google (ver google_play_verify) — Play igual espera hasta
                // 3 días antes de reembolsar automáticamente por falta de
                // acknowledge, así que no hay apuro del lado cliente.
            }
        }
    }
}
