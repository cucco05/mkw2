// Stripe Checkout sessions for an order that already exists (lib/checkout-orders.ts).
//
// The rules that make it safe to call again and again:
//  1. RESERVE, then call Stripe, then complete. A PaymentAttempt row ("creating") is written first, in a short transaction that
//     locks the order. No database transaction is open while Stripe is called.
//  2. The Stripe call carries the attempt id as idempotency key and its parameters depend only on the stored order and attempt.
//     If the server dies after Stripe created the session but before the answer was saved, the retry finds the same attempt,
//     repeats the call and Stripe returns the SAME session. Two simultaneous requests converge on one session the same way.
//  3. At most one live attempt per order: a request that finds one reuses it instead of opening another.
//  4. Nothing here ever marks an order paid. That is decided only from verified Stripe data (step 3 of S2/S3).
import type Stripe from 'stripe'
import type { PaymentAttempt, PrintOrder, PrintOrderItem } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { SHIPPING_COUNTRIES, SHIPPING_LABEL } from '@/lib/shipping'
import { isPaymentVerified } from '@/lib/order-payment-policy'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'

// Stripe needs a session to live at least 30 minutes; the extra 2 minutes cover the time between reserving and calling.
export const SESSION_TTL_MS = 32 * 60 * 1000
// A reservation that is still young may belong to a request in flight (or to one that lost its answer): join it.
export const JOIN_WINDOW_MS = 90 * 1000
// A session that is about to expire is not handed out again.
export const REUSE_MARGIN_MS = 60 * 1000
export const MAX_ATTEMPTS_PER_ORDER = 5
const STRIPE_CALL_TIMEOUT_MS = 15_000

export class CheckoutSessionError extends Error {
  readonly status: number
  readonly code: string
  readonly retry: boolean
  constructor(status: number, code: string, message: string, retry: boolean) {
    super(message)
    this.name = 'CheckoutSessionError'
    this.status = status
    this.code = code
    this.retry = retry
  }
}

export type OrderForSession = PrintOrder & { items: PrintOrderItem[] }

export type OpenSessionResult =
  | { kind: 'open'; attemptId: string; url: string; expiresAt: Date }
  | { kind: 'blocked'; reason: 'paid' | 'processing' | 'cancelled' | 'not_payable' }
  | { kind: 'too_many_attempts' }

// ---- What Stripe is asked to charge ---------------------------------------------------------------------------------------
function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// One line per cart item, then shipping, then tax that is added on top. The lines must add up to the order total EXACTLY;
// if they do not, no session is created (a wrong amount must never reach the payment page).
export function buildSessionLineItems(order: OrderForSession): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const currency = order.currency.toLowerCase()
  const lines: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  let sum = 0
  const push = (name: string, description: string | null, unitAmount: number, quantity: number) => {
    lines.push({
      quantity,
      price_data: {
        currency,
        unit_amount: unitAmount,
        product_data: { name: clip(name, 120), ...(description ? { description: clip(description, 300) } : {}) },
      },
    })
    sum += unitAmount * quantity
  }
  for (const item of order.items) {
    const name = item.partName ? `${item.modelTitle} – ${item.partName}` : item.modelTitle
    const colors = Array.isArray(item.colors) ? item.colors.filter((c): c is string => typeof c === 'string') : []
    const description = [
      `Materiale ${item.material}`,
      colors.length ? `Colori ${colors.join(', ')}` : null,
      item.finish ? `Finitura ${item.finish}` : null,
    ].filter(Boolean).join(' · ')
    // quantity x unit price when it is exact, otherwise the line total as a single unit: never a rounding difference
    const exact = item.quantity > 0 && item.unitPriceCents * item.quantity === item.totalCents
    push(name, description, exact ? item.unitPriceCents : item.totalCents, exact ? item.quantity : 1)
  }
  if (order.shippingCents > 0) push(SHIPPING_LABEL, null, order.shippingCents, 1)
  const remainder = order.totalCents - sum
  if (remainder < 0 || (remainder !== 0 && remainder !== order.taxCents)) {
    throw new Error('Order lines do not add up to the order total; no payment session created.')
  }
  if (remainder > 0) push('IVA', null, remainder, 1)
  if (sum !== order.totalCents) throw new Error('Order lines do not add up to the order total; no payment session created.')
  return lines
}

export function buildCheckoutSessionParams(input: {
  order: OrderForSession
  attempt: Pick<PaymentAttempt, 'id' | 'expiresAt'>
  returnBaseUrl: string
}): Stripe.Checkout.SessionCreateParams {
  const { order, attempt, returnBaseUrl } = input
  const metadata = { orderId: order.id, attemptId: attempt.id, orderNumber: String(order.orderNumber) }
  return {
    mode: 'payment',
    // First version: cards and the wallets that run on cards (Apple Pay, Google Pay). No asynchronous methods.
    payment_method_types: ['card'],
    line_items: buildSessionLineItems(order),
    client_reference_id: order.id,
    // Known only for registered customers; a guest types the email on the Stripe page.
    customer_email: order.userId && order.customerEmail ? order.customerEmail : undefined,
    success_url: `${returnBaseUrl}/checkout/success?order=${encodeURIComponent(order.id)}`,
    cancel_url: `${returnBaseUrl}/checkout?canceled=1`,
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
    shipping_address_collection: order.shippingMethod === 'ship'
      ? { allowed_countries: [...SHIPPING_COUNTRIES] as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] }
      : undefined,
    metadata,
    payment_intent_data: {
      metadata,
      description: `Ordine MW-${String(order.orderNumber).padStart(5, '0')}`,
    },
  }
}

// What Stripe answered must be exactly what was asked, otherwise the session is thrown away.
export function sessionProblem(session: Stripe.Checkout.Session, order: OrderForSession): string | null {
  if (session.mode !== 'payment') return 'mode'
  if (session.status !== 'open') return 'status'
  if (!session.url) return 'no_url'
  if (session.amount_total !== order.totalCents) return 'amount'
  if ((session.currency || '').toLowerCase() !== order.currency.toLowerCase()) return 'currency'
  if (session.client_reference_id !== order.id) return 'client_reference_id'
  if (session.metadata?.orderId !== order.id) return 'metadata'
  return null
}

// ---- Step 1: reserve ---------------------------------------------------------------------------------------------------------
type Plan =
  | { kind: 'blocked'; reason: 'paid' | 'processing' | 'cancelled' | 'not_payable' }
  | { kind: 'too_many_attempts' }
  | { kind: 'reuse'; attempt: PaymentAttempt }
  | { kind: 'create'; attempt: PaymentAttempt; joined: boolean }

// Short transaction, database only. The order row is locked so that simultaneous requests are decided one after the other.
async function planAttempt(orderId: string): Promise<Plan> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.printOrder.findUniqueOrThrow({ where: { id: orderId } })
    if (isPaymentVerified(order.paymentStatus)) return { kind: 'blocked', reason: 'paid' }
    if (order.paymentStatus === 'processing') return { kind: 'blocked', reason: 'processing' }
    if (order.status === 'cancelled') return { kind: 'blocked', reason: 'cancelled' }
    if (order.status !== 'awaiting_payment') return { kind: 'blocked', reason: 'not_payable' }

    const attempts = await tx.paymentAttempt.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
    if (attempts.some((a) => a.status === 'paid')) return { kind: 'blocked', reason: 'paid' }
    if (attempts.some((a) => a.status === 'processing')) return { kind: 'blocked', reason: 'processing' }

    const now = Date.now()
    const open = attempts.find((a) => a.status === 'open' && a.stripeSessionId && a.expiresAt.getTime() - now > REUSE_MARGIN_MS)
    if (open) return { kind: 'reuse', attempt: open }

    const young = attempts.find((a) => a.status === 'creating' && now - a.createdAt.getTime() < JOIN_WINDOW_MS)
    if (young) return { kind: 'create', attempt: young, joined: true }

    // reservations that nobody completed are closed so that they cannot be joined later with an expiry that is too close
    await tx.paymentAttempt.updateMany({
      where: { orderId, status: 'creating', createdAt: { lt: new Date(now - JOIN_WINDOW_MS) } },
      data: { status: 'expired', failureReason: 'stale_reservation' },
    })
    if (attempts.length >= MAX_ATTEMPTS_PER_ORDER) return { kind: 'too_many_attempts' }

    const attempt = await tx.paymentAttempt.create({
      data: {
        orderId,
        amountCents: order.totalCents,
        currency: order.currency,
        status: 'creating',
        expiresAt: new Date(now + SESSION_TTL_MS),
      },
    })
    return { kind: 'create', attempt, joined: false }
  }, { maxWait: 10_000, timeout: 15_000 })
}

// ---- Step 2: call Stripe (no database transaction is open here) ------------------------------------------------------------------
function isRetryableStripeError(err: any): boolean {
  const type: string = err?.type || err?.rawType || ''
  const code: string = err?.code || ''
  if (code === 'idempotency_key_in_use' || err?.statusCode === 409) return true // the same call is still running: ask again later
  if (type === 'StripeIdempotencyError' || type === 'idempotency_error') return false // same key, different parameters: start over
  if (['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError', 'invalid_request_error'].includes(type)) return false
  return true // connection problems, 5xx, rate limits, anything unknown: the call is idempotent, trying again is safe
}

async function closeAttempt(attemptId: string, from: string[], status: string, reason: string) {
  await prisma.paymentAttempt.updateMany({ where: { id: attemptId, status: { in: from } }, data: { status, failureReason: reason.slice(0, 200) } })
}

async function createSessionForAttempt(order: OrderForSession, attempt: PaymentAttempt, returnBaseUrl: string): Promise<OpenSessionResult> {
  const stripe = getStripe()
  const params = buildCheckoutSessionParams({ order, attempt, returnBaseUrl })

  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `makerworks:checkout-session:${attempt.id}`,
      timeout: STRIPE_CALL_TIMEOUT_MS,
    })
  } catch (err: any) {
    if (isRetryableStripeError(err)) {
      logEvent({ event: 'checkout.session', level: 'warn', outcome: 'provider_unavailable', orderId: order.id, attemptId: attempt.id, errorType: err?.type || err?.name })
      throw new CheckoutSessionError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is not reachable right now. Please try again.', true)
    }
    await closeAttempt(attempt.id, ['creating'], 'failed', `${err?.type || err?.name || 'error'}:${err?.code || ''}`)
    logEvent({ event: 'checkout.session', level: 'error', outcome: 'provider_rejected', orderId: order.id, attemptId: attempt.id, errorType: err?.type || err?.name, errorCode: err?.code })
    throw new CheckoutSessionError(500, 'PAYMENT_PROVIDER_ERROR', 'The payment could not be started.', false)
  }

  const problem = sessionProblem(session, order)
  if (problem) {
    // Never hand out a payment page that does not match the order. Close the session at Stripe (best effort) and the attempt here.
    try { await stripe.checkout.sessions.expire(session.id) } catch { /* the session expires by itself */ }
    await closeAttempt(attempt.id, ['creating'], 'failed', `session_mismatch:${problem}`)
    incrementMetric('checkout_session_mismatch_total', 1, { problem })
    logEvent({ event: 'checkout.session', level: 'error', outcome: 'session_mismatch', orderId: order.id, attemptId: attempt.id, sessionId: session.id, problem })
    throw new CheckoutSessionError(500, 'PAYMENT_PROVIDER_ERROR', 'The payment could not be started.', false)
  }

  const expiresAt = session.expires_at ? new Date(session.expires_at * 1000) : attempt.expiresAt
  try {
    // Completes the reservation. If another request already completed it with the same session, nothing changes.
    await prisma.paymentAttempt.updateMany({
      where: { id: attempt.id, status: 'creating' },
      data: { stripeSessionId: session.id, status: 'open', expiresAt },
    })
  } catch (err) {
    // Stripe holds a session our database does not know yet. The reservation is still there: the next request repeats the same
    // Stripe call (same key) and gets this same session back. Logged with the ids so an operator can find it.
    logEvent({ event: 'checkout.session', level: 'error', outcome: 'save_failed', orderId: order.id, attemptId: attempt.id, sessionId: session.id })
    throw new CheckoutSessionError(503, 'TEMPORARY_ERROR', 'Something went wrong while saving the payment. Please try again.', true)
  }
  incrementMetric('checkout_sessions_created_total')
  return { kind: 'open', attemptId: attempt.id, url: session.url as string, expiresAt }
}

// An attempt we already hold: ask Stripe whether it is still usable.
async function reopenAttempt(order: OrderForSession, attempt: PaymentAttempt): Promise<OpenSessionResult | null> {
  if (!attempt.stripeSessionId) {
    await closeAttempt(attempt.id, ['open'], 'failed', 'open_without_session')
    return null
  }
  let session: Stripe.Checkout.Session
  try {
    session = await getStripe().checkout.sessions.retrieve(attempt.stripeSessionId, undefined, { timeout: STRIPE_CALL_TIMEOUT_MS })
  } catch {
    throw new CheckoutSessionError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is not reachable right now. Please try again.', true)
  }
  if (session.status === 'open' && session.url && !sessionProblem(session, order)) {
    return { kind: 'open', attemptId: attempt.id, url: session.url, expiresAt: attempt.expiresAt }
  }
  if (session.status === 'complete') {
    // The customer already finished paying on Stripe's side. Whether it counts is decided only by the verified payment
    // handling (S2/S3 step 3); until then no second session may be opened.
    await closeAttempt(attempt.id, ['open'], 'processing', 'session_complete_at_provider')
    return { kind: 'blocked', reason: 'processing' }
  }
  const mismatch = session.status === 'open' ? sessionProblem(session, order) : null
  await closeAttempt(
    attempt.id, ['open'],
    session.status === 'expired' ? 'expired' : 'failed',
    mismatch ? `session_mismatch:${mismatch}` : `provider_status:${session.status}`,
  )
  return null
}

export async function openCheckoutSession(input: { orderId: string; returnBaseUrl: string }): Promise<OpenSessionResult> {
  for (let round = 0; round < 3; round++) {
    const plan = await planAttempt(input.orderId)
    if (plan.kind === 'blocked') return plan
    if (plan.kind === 'too_many_attempts') return plan

    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: input.orderId }, include: { items: { orderBy: { createdAt: 'asc' } } } })
    if (plan.kind === 'reuse') {
      const reused = await reopenAttempt(order, plan.attempt)
      if (reused) return reused
      continue // the attempt was closed: plan again
    }
    return createSessionForAttempt(order, plan.attempt, input.returnBaseUrl)
  }
  throw new CheckoutSessionError(503, 'TEMPORARY_ERROR', 'The payment could not be prepared. Please try again.', true)
}
