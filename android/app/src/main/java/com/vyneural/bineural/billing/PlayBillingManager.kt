package com.vyneural.bineural.billing

import android.app.Activity
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.vyneural.bineural.util.BineuralLog
import org.json.JSONObject

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
        fresh.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    onReady(fresh)
                } else {
                    onError("billing setup failed: ${result.debugMessage} (${result.responseCode})")
                }
            }

            override fun onBillingServiceDisconnected() {
                // Best-effort: el próximo startPurchase() reconecta solo
                // (ensureClient reconstruye si !isReady).
                BineuralLog.d("play-billing", "servicio de facturación desconectado")
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

    private fun queryAndLaunch(
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
        billingClient.queryProductDetailsAsync(params) { billingResult, productDetailsResult ->
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
            val flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productDetailsParams.build()))
                .build()
            activity.runOnUiThread {
                billingClient.launchBillingFlow(activity, flowParams)
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
