import { NextRequest } from 'next/server'
import { z } from 'zod'
import { viewerGuards } from '@/lib/viewer'
import { shouldUseSecureCookies } from '@/lib/auth'
import { isSameOriginRequest } from '@/lib/csrf'
import { buildCardQuote, CheckoutQuoteError, checkoutItemSchema } from '@/lib/checkout-quote'
import { getCheckoutBlocker } from '@/lib/checkout-guards'
import {
  assertSameCheckout,
  CHECKOUT_KEY_PATTERN,
  CheckoutKeyConflictError,
  cartFingerprint,
  checkoutFingerprint,
  findPurchaseInFlight,
  verifiedGuestOrderIds,
  PriceChangedError,
  createPendingCardOrder,
  findOrderByCheckoutKey,
  storedCheckoutKey,
} from '@/lib/checkout-orders'
import { CheckoutSessionError, openCheckoutSession } from '@/lib/checkout-sessions'
import { enforceCheckoutRateLimit, jsonError, jsonNoStore, readJsonBody } from '@/lib/checkout-api'
import { deriveGuestAccessToken, GUEST_ACCESS_COOKIE, mergeGuestAccessCookie, verifyGuestAccess } from '@/lib/guest-order-access'
import { resolveInternalBaseUrl, resolveReturnBaseUrl } from '@/lib/public-url'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'
import { incrementMetric } from '@/lib/observability-metrics'
import { logEvent } from '@/lib/observability-logger'

export const dynamic = 'force-dynamic'

// "Pay": create the order (once), then open the Stripe payment page for it. Safe to call again: the same checkoutKey and cart
// always lead to the same order and, while it is still usable, the same payment page.
// The request carries ONLY the cart, the delivery choice and the key. Totals, status and payment state are decided here.
const bodySchema = z.object({
  checkoutKey: z.string().regex(CHECKOUT_KEY_PATTERN),
  // The total (in cents) the customer was shown in the quote. Used ONLY to refuse the payment if the server's total differs.
  expectedTotalCents: z.number().int().min(0).max(100_000_000),
  items: z.array(checkoutItemSchema).min(1).max(50),
  shipping: z.object({ method: z.enum(['pickup', 'ship']) }).strict().default({ method: 'pickup' }),
  rush: z.boolean().optional().default(false),
}).strict()

async function handlePost(req: NextRequest) {
  try {
    if (!isSameOriginRequest(req)) return jsonError(403, 'INVALID_ORIGIN', 'Invalid request origin.')

    const viewer = await viewerGuards.getViewer()
    const principalId = viewer?.id ?? null
    const limited = await enforceCheckoutRateLimit(req, 'session', principalId)
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

    const storedKey = storedCheckoutKey(principalId, checkoutKey)
    const fingerprint = checkoutFingerprint({ principalId, items, shippingMethod: shipping.method, rush, expectedTotalCents })
    const sameCart = cartFingerprint({ principalId, items, shippingMethod: shipping.method, rush })

    // 1. The order. A repeated request finds it; the price is NOT calculated again (the total is frozen).
    let order = await findOrderByCheckoutKey(storedKey)
    if (order) {
      assertSameCheckout(order, principalId, fingerprint)
    } else {
      // A payment for exactly this cart that is being confirmed (or waits for a person) is not to be paid twice, whatever tab or key this request comes from:
      // the server answers from its own orders - the account's, or the ones the guest's access cookie really opens - never from the browser's memory.
      const guestOrderIds = principalId ? [] : await verifiedGuestOrderIds(req.cookies.get(GUEST_ACCESS_COOKIE)?.value)
      const inFlight = await findPurchaseInFlight({ principalId, guestOrderIds, cartFingerprint: sameCart })
      if (inFlight) {
        incrementMetric('checkout_in_flight_blocked_total')
        return jsonError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this cart is already being confirmed. Check its status before paying again.', { orderId: inFlight.orderId, orderNumber: inFlight.orderNumber })
      }
      const quote = await buildCardQuote({ items, shippingMethod: shipping.method, rush, publicBaseUrl: resolveInternalBaseUrl(req) })
      // the configuration stored in the database (the shop's minimum order) is known only now: still before any order exists
      const configBlocker = getCheckoutBlocker({ shippingMethod: shipping.method, minimumOrderSubtotal: quote.ctx.cfg?.minimumOrderSubtotalUsd ?? null })
      if (configBlocker) return jsonError(configBlocker.status, configBlocker.code, configBlocker.message)
      // What the customer was shown must be what they are charged: if the server's total is different, nothing is created.
      if (quote.totals.amount !== expectedTotalCents) throw new PriceChangedError(quote.totals.amount, quote.totals.currencyCode)
      const result = await createPendingCardOrder({ storedKey, fingerprint, cartFingerprint: sameCart, guestOrderIds, quote, items, rush })
      order = result.order
      // lost the race to an identical simultaneous request: that order is the one, but it must be the same cart
      if (!result.created) assertSameCheckout(order, principalId, fingerprint)
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
        secure: await shouldUseSecureCookies(),
        path: '/',
        maxAge: Math.max(60, Math.floor(((order.guestAccessExpiresAt?.getTime() ?? Date.now()) - Date.now()) / 1000)),
      })
    }
    return response
  } catch (err: any) {
    if (err instanceof PriceChangedError) {
      return jsonError(409, 'PRICE_CHANGED', err.message, { currentTotalCents: err.currentTotalCents, currency: err.currency })
    }
    if (err instanceof CheckoutKeyConflictError) return jsonError(409, 'CHECKOUT_KEY_CONFLICT', err.message)
    if (err instanceof CheckoutQuoteError) return jsonError(err.status, err.code || 'QUOTE_REJECTED', err.message, err.details ? { details: err.details } : {})
    if (err instanceof CheckoutSessionError) return jsonError(err.status, err.code, err.message, { retry: err.retry })
    await captureError(err, { category: 'checkout_session', route: '/api/checkout/session' })
    incrementMetric('checkout_session_failures_total')
    return jsonError(500, 'CHECKOUT_FAILED', 'The payment could not be started. Please try again.', { retry: true })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout/session' })
