# Soporte: "ya compré pero no tengo Premium en esta cuenta" (Google Play)

## Cuándo aplica

Un usuario reporta que compró Premium en la APK (Google Play Billing), pero una
cuenta de Vyneural DISTINTA a la que usó para comprar no tiene Premium — o que
al intentar comprar de nuevo Google le dice `ITEM_ALREADY_OWNED` / la app muestra
un error 409 ("esta cuenta de Google Play ya usó esta compra en otra cuenta de
Vyneural").

Esto pasa cuando la cuenta de **Google Play** del dispositivo (nivel de sistema,
una sola por teléfono normalmente) se mantiene igual pero el usuario cambia de
cuenta de **Vyneural** (backend, la sesión con la que entra a la app) — típico en
un teléfono compartido o al probar con una segunda cuenta.

**Esto no es un bug**: el diseño es intencional — cada compra de Google Play
(`purchaseToken`) queda asociada para siempre a la primera cuenta de Vyneural que
la canjeó (`Payment.google_play_purchase_token`, columna única en la BD — ver
`backvyneural/backend/app/models/payment.py`). `google_play_verify`
(`backvyneural/backend/app/routers/payments.py`) rechaza con 409 cualquier intento
de canjear ese mismo token bajo un `user_id` distinto. Nunca se comparte ni se
transfiere solo, a propósito — Premium nunca debe "seguir" a la cuenta de Google
Play, solo a la cuenta de Vyneural que efectivamente pagó.

## Qué hacer si el usuario legítimamente necesita liberarla

1. Confirmar la identidad de ambas cuentas de Vyneural (la que compró y la que
   necesita el acceso) — pedir el email de cada una.
2. Ubicar el `Payment` en la base de datos por `google_play_purchase_token` (no
   por email — el token es la clave real del conflicto):
   ```sql
   select id, user_id, plan, google_play_purchase_token, created_at
   from payments
   where google_play_purchase_token = '<token>';
   ```
   Si no se tiene el token a mano, se puede ubicar por `user_id` de la cuenta que
   compró (`select * from payments where user_id = '<uuid>' order by created_at desc`).
3. Decidir el criterio de negocio (esto es soporte humano, no algo que la app
   resuelva sola):
   - Si es la MISMA persona que simplemente cambió de cuenta de Vyneural: se
     puede reasignar el `Payment.user_id` a la cuenta nueva (y considerar
     revocar el acceso de la cuenta vieja si corresponde).
   - Si son DOS personas distintas compartiendo un dispositivo/cuenta de Google
     Play: cada una necesita su propia compra — no corresponde reasignar, hay
     que explicarles el modelo (Premium sigue a la cuenta de Vyneural, no a la
     de Google Play) y que la segunda persona compre con su propia cuenta de
     Google Play si quiere Premium en su propia cuenta de Vyneural.
4. Si se decide reasignar: actualizar `Payment.user_id` a mano en la BD. No hay
   endpoint/UI para esto todavía — es una operación manual de soporte/dev.
5. Opcionalmente, si Google mantiene el producto como "ya poseído" y bloquea
   compras futuras desde esa cuenta de Google Play para el mismo producto
   (`ITEM_ALREADY_OWNED`), y de verdad hace falta liberarlo del lado de Google
   (no solo del lado Vyneural), eso se hace desde la Play Console
   (Monetización → Pedidos → reembolsar/revocar la orden) — revocar ahí SÍ
   libera el producto para que la cuenta de Google Play pueda comprarlo de
   nuevo.

## Por qué no está automatizado

El caso es raro (requiere el mismo dispositivo/cuenta de Google Play + cambio de
cuenta de Vyneural + intento de reclamar la misma compra) y la resolución correcta
depende de un juicio humano (¿es la misma persona o dos?) que el sistema no puede
inferir solo — por eso el código se limita a bloquear el conflicto de forma segura
(409, nunca otorga Premium por error) y deja la reasignación como una operación
manual de soporte.
