import { NextRequest } from 'next/server'
import { z } from 'zod'
import { viewerGuards } from '@/lib/viewer'
import { shouldUseSecureCookies } from '@/lib/auth'
import { isSameOriginRequest } from '@/lib/csrf'
import { buildCardQuote, CheckoutQuoteError, checkoutItemSchema } from '@/lib/checkout-quote'
import { getCheckoutBlocker } from '@/lib/checkout-guards'
import {
  assertKeyBelongsTo,
  answerForPurchaseKey,
  assertSameCheckout,
  bindGuestPurchaseKey,
  CHECKOUT_KEY_PATTERN,
  CheckoutKeyConflictError,
  cartFingerprint,
  cartFingerprintV1,
  checkoutFingerprint,
  checkoutFingerprintV1,
  findPurchaseInFlight,
  verifiedGuestOrderIds,
  PriceChangedError,
  PurchaseRefusedError,
  createPendingCardOrder,
  findOrderByCheckoutKey,
  storedCheckoutKey,
  type CheckoutOwner,
  type OrderWithItems,
} from '@/lib/checkout-orders'
import { purchaseKeyFor, purchaseRefusal } from '@/lib/purchase-intent'
import { CheckoutSessionError, openCheckoutSession } from '@/lib/checkout-sessions'
import { allowStripeRefresh, enforceCheckoutRateLimit, jsonError, jsonNoStore, readJsonBody } from '@/lib/checkout-api'
import { syncPayment } from '@/lib/payment-sync'
import { deriveGuestAccessToken, GUEST_ACCESS_COOKIE, mergeGuestAccessCookie, verifyGuestAccess } from '@/lib/guest-order-access'
import {
  guestSessionNeedsRenewal, mintGuestSession, readGuestSessionCookie, renewGuestSession, setGuestSessionCookie, verifyGuestSession,
} from '@/lib/guest-session'
import { resolveGuestCookieTransport } from '@/lib/guest-cookie-transport'
import { resolveInternalBaseUrl, resolveReturnBaseUrl } from '@/lib/public-url'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'
import { incrementMetric } from '@/lib/observability-metrics'
import { logEvent } from '@/lib/observability-logger'

export const dynamic = 'force-dynamic'

// "Pay": create the order (once), then open the Stripe payment page for it. Safe to call again: the same checkoutKey and cart
// always lead to the same order and, while it is still usable, the same payment page.
// The request carries ONLY the cart, the delivery choice and the key. Totals, status and payment state are decided here.
//
// A guest is told apart from the next guest by the signed cookie of its browser (lib/guest-session.ts, step 4.6 S5), never by what is in the cart. A guest
// whose request carries no valid session gets NOTHING made - no order, no call to Stripe - and is handed one with the answer (428): the page sends the same
// request once more, and if that is answered 428 again the browser does not keep cookies, which the page then says.
// Over a connection that production should not be seeing (the proxy of ours says plain http) a guest does not check out at all: 503, nothing made, no cookie
// (lib/guest-cookie-transport.ts) - never a fall-back to the weaker cookie.
const bodySchema = z.object({
  checkoutKey: z.string().regex(CHECKOUT_KEY_PATTERN),
  // The total (in cents) the customer was shown in the quote. Used ONLY to refuse the payment if the server's total differs.
  expectedTotalCents: z.number().int().min(0).max(100_000_000),
  items: z.array(checkoutItemSchema).min(1).max(50),
  shipping: z.object({ method: z.enum(['pickup', 'ship']) }).strict().default({ method: 'pickup' }),
  rush: z.boolean().optional().default(false),
}).strict()

// A guest's key is tied to an order this request can not show to be its own (R1-1b, lib/purchase-intent.ts): 409, ONE code and ONE sentence for every order and every state of it,
// a support code that is made from the key's fingerprint alone, and NOTHING else - no order, no number, no payment page, no cookie, and nothing about what has happened to the
// purchase (S-01 of the independent audit: the key alone must not be a way to read somebody else's payment). The state of the order is not even read to build this answer.
// Counted, with no label.
function refusePurchase(supportCode: string) {
  incrementMetric('checkout_purchase_key_refused_total')
  const refusal = purchaseRefusal()
  return jsonError(refusal.status, refusal.code, refusal.message, { supportCode, retry: false })
}

async function handlePost(req: NextRequest) {
  try {
    if (!isSameOriginRequest(req)) return jsonError(403, 'INVALID_ORIGIN', 'Invalid request origin.')

    const viewer = await viewerGuards.getViewer()
    const principalId = viewer?.id ?? null
    // How the guest's cookie is named and flagged is decided from the configuration BEFORE it is read, never from the cookie or from what the request claims
    // about itself (lib/guest-cookie-transport.ts). A customer with an account has no such cookie.
    const transport = principalId ? null : await resolveGuestCookieTransport(req.headers)
    const secureCookie = transport ? transport.mode === 'secure' : await shouldUseSecureCookies()
    const guest = transport && transport.mode !== 'refuse' ? verifyGuestSession(readGuestSessionCookie(req.cookies, secureCookie)) : null
    const limited = await enforceCheckoutRateLimit(req, 'session', principalId, guest?.hash ?? null)
    if (limited) return limited

    const raw = await readJsonBody(req)
    if ('response' in raw) return raw.response
    const parsed = bodySchema.safeParse(raw.data)
    if (!parsed.success) return jsonError(400, 'INVALID_REQUEST', 'Invalid checkout request.')
    const { checkoutKey, expectedTotalCents, items, shipping, rush } = parsed.data

    const blocker = getCheckoutBlocker({ shippingMethod: shipping.method })
    if (blocker) return jsonError(blocker.status, blocker.code, blocker.message)
    const returnBase = resolveReturnBaseUrl(req)
    if ('error' in returnBase) {
      logEvent({ event: 'checkout.session', level: 'error', outcome: 'base_url_invalid', message: returnBase.error })
      return jsonError(503, 'CHECKOUT_UNAVAILABLE', 'Online card checkout is not available right now.')
    }

    // The connection is not the https one production is meant to have (the trusted proxy says plain http): a guest does not check out. Nothing is made and no
    // cookie is handed out, whatever else the request carries.
    if (transport?.mode === 'refuse') {
      incrementMetric('checkout_insecure_transport_total')
      logEvent({ event: 'checkout.session', level: 'error', outcome: 'insecure_transport', message: 'a guest asked to pay over a connection the trusted proxy says is plain http: checkout refused' })
      return jsonError(503, 'CHECKOUT_UNAVAILABLE', 'Online card checkout is not available right now.')
    }

    // No valid session, no order and no payment page: the browser is given one and asked to repeat the request. Everything below this line may create
    // something, and none of it can be reached by a guest without a session.
    if (!principalId && !guest) {
      const issued = mintGuestSession()
      const response = jsonError(428, 'SESSION_REQUIRED', 'Your browser needs a session before it can pay. It has just been given one: send the same request once more.', { retry: true })
      setGuestSessionCookie(response, issued, secureCookie)
      incrementMetric('checkout_session_required_total')
      return response
    }

    const owner: CheckoutOwner = principalId ? { kind: 'account', userId: principalId } : { kind: 'guest', sessionHash: (guest as { hash: string }).hash }
    const guestSessionHash = owner.kind === 'guest' ? owner.sessionHash : null
    // (R1-1b) A guest's key must be a STRONG one - what a browser makes with Web Crypto (lib/checkout-key-format.ts) - and becomes its fingerprint here, once: the key itself goes no
    // further. Anything else is refused before a single thing is read or made, and the cart is none of its business. An account keeps the broad shape of the schema above and has
    // no fingerprint: the guard against a second order for the same key is for guests (an account is known by who it is).
    const purchaseKeyHash = owner.kind === 'guest' ? purchaseKeyFor(checkoutKey) : null
    if (owner.kind === 'guest' && !purchaseKeyHash) {
      incrementMetric('checkout_guest_key_refused_total')
      return jsonError(400, 'CHECKOUT_KEY_INVALID', 'The checkout key is not valid.')
    }
    const storedKey = storedCheckoutKey(owner, checkoutKey)
    const fingerprint = checkoutFingerprint({ principalId, items, shippingMethod: shipping.method, rush, expectedTotalCents })
    const sameCart = cartFingerprint({ principalId, items, shippingMethod: shipping.method, rush })
    // (orders made before step 4.6 carry the version 1 fingerprints: they are still recognised)
    const legacyFingerprint = checkoutFingerprintV1({ principalId, items, shippingMethod: shipping.method, rush, expectedTotalCents })
    const legacyCart = cartFingerprintV1({ principalId, items, shippingMethod: shipping.method, rush })

    // 1. The order. A repeated request finds it; the price is NOT calculated again (the total is frozen).
    let order: OrderWithItems | null = null
    // (R1-1b) A guest's key decides first: if it is bound to an order, THAT is the order for this key, whatever the session. The key only correlates - it shows nothing about whose
    // order it is. The owner (the same session, or the order's own access cookie) gets the order back, as before; anybody else is refused with the one refusal and a support code,
    // and nothing is made, asked of Stripe or named. (createPendingCardOrder reads the key again under its locks: what is read here is only a way to answer sooner.)
    let boundToKey = false
    const answerForKey = async () => (purchaseKeyHash && owner.kind === 'guest'
      ? answerForPurchaseKey({ purchaseKeyHash, sessionHash: owner.sessionHash, accessCookie: req.cookies.get(GUEST_ACCESS_COOKIE)?.value })
      : { kind: 'unbound' } as const)
    const viaKey = await answerForKey()
    if (viaKey.kind === 'refused') return refusePurchase(viaKey.supportCode)
    if (viaKey.kind === 'own') { order = viaKey.order; boundToKey = true }
    if (!order) order = await findOrderByCheckoutKey(storedKey)
    if (order) {
      // (an order found by the key is shown to be this guest's by the proof above; the check that the stored key belongs to this session is for the other way of finding it)
      if (!boundToKey) assertKeyBelongsTo(order, owner)
      assertSameCheckout(order, principalId, fingerprint, legacyFingerprint)
      // (R1-1b, B2) an order of this browser made before the keys were bound: its owner is back with the same key, and the key is bound to it now. If the key was bound to ANOTHER
      // order in the meantime, THAT is the order for this key: its owner is given it, anybody else is refused - the old order is not served as if the key were free.
      if (purchaseKeyHash && !boundToKey && (await bindGuestPurchaseKey({ purchaseKeyHash, orderId: order.id })) === 'other') {
        const afterRace = await answerForKey()
        if (afterRace.kind === 'refused') return refusePurchase(afterRace.supportCode)
        if (afterRace.kind === 'own') { order = afterRace.order; assertSameCheckout(order, principalId, fingerprint, legacyFingerprint) }
      }
    } else {
      // A payment for exactly this cart that is being confirmed (or waits for a person) is not to be paid twice, whatever tab or key this request comes from:
      // the server answers from its own orders - the account's, or a guest's: the ones its access cookie really opens and the ones its browser session made -
      // never from the browser's memory.
      const guestOrderIds = principalId ? [] : await verifiedGuestOrderIds(req.cookies.get(GUEST_ACCESS_COOKIE)?.value)
      // (a payment that is being confirmed is first asked about at Stripe, by the server: if no money is moving the customer may pay again; if it can not be
      // known, or it is paid, or it waits for a person, they may not)
      const inFlight = await findPurchaseInFlight({
        principalId,
        guestOrderIds,
        guestSessionHash,
        cartFingerprint: sameCart,
        legacyCartFingerprint: legacyCart,
        verify: async (target) => {
          if (!(await allowStripeRefresh(target.orderId))) throw new Error('asked a moment ago')
          await syncPayment(
            { kind: 'checkout_session', id: target.sessionId, hint: { orderId: target.orderId, attemptId: target.attemptId } },
            { eventType: 'checkout.guard', effects: 'background', maxWaitMs: 1500 },
          )
        },
      })
      if (inFlight) {
        // (R1-1b, B3) the order of a payment that is in doubt, shown above to be this guest's, is also the order of this key: the only thing a refusal writes. The binding is written
        // once and never changed (S-02 of the independent audit): if the key was bound to ANOTHER order in the meantime, THAT order is the key's - and a request that can not show it
        // is its own is refused like anybody else, not told about an order of its own that the key has nothing to do with. (If the key's order is this guest's too, or is gone, the
        // answer below stands: nothing is opened while a payment for this cart is being confirmed.)
        if (purchaseKeyHash && (await bindGuestPurchaseKey({ purchaseKeyHash, orderId: inFlight.orderId })) === 'other') {
          const afterRace = await answerForKey()
          if (afterRace.kind === 'refused') return refusePurchase(afterRace.supportCode)
        }
        incrementMetric('checkout_in_flight_blocked_total', 1, { state: inFlight.state })
        // The order is named only to a customer who is shown to own it: the account, or the guest whose access cookie opens it. A browser session alone is
        // not that (it opens nothing): it is told a payment is already under way, and no identifier leaves the server.
        const named = inFlight.via === 'session' ? {} : { orderId: inFlight.orderId, orderNumber: inFlight.orderNumber }
        return jsonError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this cart is already being confirmed. Check its status before paying again.', named)
      }
      const quote = await buildCardQuote({ items, shippingMethod: shipping.method, rush, publicBaseUrl: resolveInternalBaseUrl(req) })
      // the configuration stored in the database (the shop's minimum order) is known only now: still before any order exists
      const configBlocker = getCheckoutBlocker({ shippingMethod: shipping.method, minimumOrderSubtotal: quote.ctx.cfg?.minimumOrderSubtotalUsd ?? null })
      if (configBlocker) return jsonError(configBlocker.status, configBlocker.code, configBlocker.message)
      // What the customer was shown must be what they are charged: if the server's total is different, nothing is created.
      if (quote.totals.amount !== expectedTotalCents) throw new PriceChangedError(quote.totals.amount, quote.totals.currencyCode)
      const result = await createPendingCardOrder({ storedKey, fingerprint, legacyFingerprint, cartFingerprint: sameCart, guestOrderIds, guestSessionHash, purchaseKeyHash, quote, items, rush })
      order = result.order
      // lost the race to an identical simultaneous request, or the same browser's unpaid order for this cart: that order is the one, but it must be the same cart
      if (!result.created) assertSameCheckout(order, principalId, fingerprint, legacyFingerprint)
      else incrementMetric('checkout_orders_created_total')
    }

    // 2. The payment page.
    const session = await openCheckoutSession({ orderId: order.id, returnBaseUrl: returnBase.url })
    if (session.kind === 'blocked') {
      return jsonError(409, 'ORDER_NOT_PAYABLE', 'This order can no longer be paid with a new payment page.', { orderId: order.id, reason: session.reason })
    }
    if (session.kind === 'too_many_attempts') {
      return jsonError(429, 'TOO_MANY_ATTEMPTS', 'Too many payment attempts for this order. Please start a new checkout.', { orderId: order.id })
    }

    const response = jsonNoStore({
      orderId: order.id,
      orderNumber: order.orderNumber,
      url: session.url,
      expiresAt: session.expiresAt.toISOString(),
      currency: order.currency,
      totalCents: order.totalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
    })
    // A guest gets a cookie that lets them see the status of THIS order afterwards (nothing else).
    if (!order.userId && verifyGuestAccess(order, deriveGuestAccessToken(order.id))) {
      // This order is ADDED to the ones the browser already holds, so paying for a second order does not lock the first one out.
      const value = mergeGuestAccessCookie(req.cookies.get(GUEST_ACCESS_COOKIE)?.value, order.id, deriveGuestAccessToken(order.id))
      response.cookies.set(GUEST_ACCESS_COOKIE, value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        path: '/',
        maxAge: Math.max(60, Math.floor(((order.guestAccessExpiresAt?.getTime() ?? Date.now()) - Date.now()) / 1000)),
      })
    }
    // A browser that keeps paying keeps its session: the same identity, a new date, once the cookie is a day old.
    if (guest && guestSessionNeedsRenewal(guest)) setGuestSessionCookie(response, renewGuestSession(guest), secureCookie)
    return response
  } catch (err: any) {
    if (err instanceof PriceChangedError) {
      return jsonError(409, 'PRICE_CHANGED', err.message, { currentTotalCents: err.currentTotalCents, currency: err.currency })
    }
    if (err instanceof CheckoutKeyConflictError) return jsonError(409, 'CHECKOUT_KEY_CONFLICT', err.message)
    if (err instanceof PurchaseRefusedError) return refusePurchase(err.supportCode)
    if (err instanceof CheckoutQuoteError) return jsonError(err.status, err.code || 'QUOTE_REJECTED', err.message, err.details ? { details: err.details } : {})
    if (err instanceof CheckoutSessionError) return jsonError(err.status, err.code, err.message, { retry: err.retry })
    await captureError(err, { category: 'checkout_session', route: '/api/checkout/session' })
    incrementMetric('checkout_session_failures_total')
    return jsonError(500, 'CHECKOUT_FAILED', 'The payment could not be started. Please try again.', { retry: true })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout/session' })
