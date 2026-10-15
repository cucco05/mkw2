import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { viewerGuards } from '@/lib/viewer'
import { GUEST_ACCESS_COOKIE } from '@/lib/guest-order-access'
import { allowStripeRefresh, enforceStatusRateLimit, jsonNoStore, STATUS_REFRESH_MIN_INTERVAL_MS } from '@/lib/checkout-api'
import {
  canViewOrder,
  derivePublicState,
  ORDER_ID_PATTERN,
  refreshableAttempt,
  toPublicStatus,
  type StatusAttempt,
  type StatusOrder,
} from '@/lib/checkout-status'
import { syncPayment } from '@/lib/payment-sync'
import { withRequestObservability } from '@/lib/request-observability'
import { incrementMetric } from '@/lib/observability-metrics'
import { logEvent } from '@/lib/observability-logger'

export const dynamic = 'force-dynamic'

// GET /api/checkout/status?order=<id>[&return=1]
//
// The state of ONE order of the hosted checkout, for the person who made it and nobody else:
//  * the signed-in owner, or the guest whose browser holds this order's access token (cookie, checked against the hash and expiry
//    stored on the order). The order id alone opens nothing; neither does being able to reach the confirmation page.
//  * no access, no such order, an order of the old flow: the SAME answer (404), so the endpoint never confirms that an order exists.
//  * the answer holds an order number, one of five states, the total and its currency - never personal data, addresses, files,
//    Stripe identifiers, review reasons or metadata - and is never stored by any cache (private, no-store).
//  * `return=1` is only the browser saying "I am back from the payment page". It can turn "not paid" into "confirming" when we could
//    not check with Stripe; it can never produce "paid". Everything that matters is read from our database or from Stripe.
//  * if the order is still waiting for its payment, Stripe is asked (at most once every few seconds per order, and with a
//    shop-wide cap): a customer who paid sees "paid" even when the webhook is late. If Stripe cannot be reached the answer
//    is still given from what we hold.
const PRIVATE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
}
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  jsonNoStore(body, { status, headers: { ...PRIVATE_HEADERS, ...extra } })
const notFound = () => reply({ error: 'Order not found.', code: 'NOT_FOUND' }, 404)

const ORDER_SELECT = {
  id: true,
  userId: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  paymentReviewReason: true,
  totalCents: true,
  currency: true,
  paymentSyncedAt: true,
  guestAccessTokenHash: true,
  guestAccessExpiresAt: true,
} as const

const loadOrder = (id: string): Promise<StatusOrder | null> => prisma.printOrder.findUnique({ where: { id }, select: ORDER_SELECT })
const loadAttempts = (orderId: string): Promise<StatusAttempt[]> =>
  prisma.paymentAttempt.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, stripeSessionId: true } })

async function handleGet(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get('order') ?? ''
  if (!ORDER_ID_PATTERN.test(orderId)) return notFound()

  // counted before anything is looked up
  const limited = await enforceStatusRateLimit(req, orderId)
  if (limited) {
    return reply(
      { error: 'Too many requests. Please wait a moment.', code: 'RATE_LIMITED', retryAfterSeconds: limited.retryAfterSeconds },
      429,
      { 'Retry-After': String(limited.retryAfterSeconds) },
    )
  }

  const viewer = await viewerGuards.getViewer()
  let order = await loadOrder(orderId)
  if (!order || !canViewOrder(order, viewer?.id ?? null, req.cookies.get(GUEST_ACCESS_COOKIE)?.value)) return notFound()
  let attempts = await loadAttempts(order.id)
  if (attempts.length === 0) return notFound() // not an order of the hosted checkout

  let unverified = false
  const toAsk = refreshableAttempt(order, attempts, new Date(), STATUS_REFRESH_MIN_INTERVAL_MS)
  if (toAsk) {
    if (await allowStripeRefresh(order.id)) {
      try {
        await syncPayment(
          { kind: 'checkout_session', id: toAsk.stripeSessionId as string, hint: { orderId: order.id, attemptId: toAsk.id } },
          { eventType: 'status.poll', effects: 'background', maxWaitMs: 1500 },
        )
        incrementMetric('checkout_status_refresh_total', 1, { outcome: 'ok' })
      } catch (err) {
        // Stripe unreachable, another update of this order still running, a slow read: the answer comes from what we hold
        unverified = true
        incrementMetric('checkout_status_refresh_total', 1, { outcome: 'failed' })
        logEvent({ event: 'checkout.status', level: 'warn', outcome: 'refresh_failed', message: err instanceof Error ? err.name : 'error' })
      }
      order = (await loadOrder(order.id)) ?? order
      attempts = await loadAttempts(order.id)
    } else {
      unverified = true // somebody just asked, or the shop-wide cap is reached: we do not know more than the last answer
    }
  }

  const state = derivePublicState(order, attempts[0] ?? null, { returned: req.nextUrl.searchParams.get('return') === '1', unverified })
  return reply(toPublicStatus(order, state))
}

export const GET = withRequestObservability(handleGet, { routeName: '/api/checkout/status' })
