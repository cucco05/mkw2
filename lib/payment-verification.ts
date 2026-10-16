// THE place that decides whether a Stripe payment counts for an order, and what it may do to the order.
// Pure functions: no database, no network. Everything that can mark an order paid or release it to production goes through
// verifyCheckoutSession / verifyPaymentIntent / verifyInvoice and decidePaymentUpdate (lib/payment-sync.ts is the only caller),
// so the Stripe Checkout flow and the old PaymentIntent flow cannot differ in what they accept.
//
// A payment is PAID for an order only if ALL of these hold:
//   * it is tied to THIS order (our own id in Stripe's object, and for hosted checkout the attempt we created);
//   * Stripe says the money is collected (PaymentIntent "succeeded"), not "processing", "authorized" or anything else;
//   * the amount received equals the order total EXACTLY (not "at least"), and the currency is the order's currency.
// Anything else never authorizes production. A payment that is wrong in a way a person has to look at is a MISMATCH.
import type Stripe from 'stripe'
import { isPaymentVerified } from '@/lib/order-payment-policy'

export type ReviewReason =
  | 'amount'                      // collected / requested amount is not the order total
  | 'currency'
  | 'order_reference'             // the payment does not point to this order / attempt
  | 'session_reference'
  | 'mode'
  | 'payment_intent_missing'
  | 'unpaid_completion'           // a checkout session finished without the money (a delayed method; none is enabled)
  | 'payment_already_used'        // the payment belongs to another order
  | 'duplicate_payment'           // the order was already paid with a different payment
  | 'paid_after_cancel'           // money arrived for an order that had been cancelled
  | 'status_regression'           // Stripe shows a not-paid state for an order we hold as paid
  | 'dispute'
  | 'shipping_country'            // delivery address outside the countries we serve
  | 'shipping_address_missing'
  | 'external_order'              // created from an outside service's claim (OrderWorks webhook): a person decides

export type OrderFacts = { id: string; totalCents: number; currency: string }
export type AttemptFacts = { id: string; orderId: string; amountCents: number; currency: string }

export type PaymentIntentLike = {
  id: string
  status: string
  amount: number
  amount_received?: number | null
  currency: string
  metadata?: Record<string, string> | null
}

export type CheckoutSessionLike = {
  id: string
  mode?: string | null
  status?: string | null
  payment_status?: string | null
  amount_total?: number | null
  currency?: string | null
  client_reference_id?: string | null
  metadata?: Record<string, string> | null
  payment_intent?: PaymentIntentLike | string | null
}

export type InvoiceLike = {
  id: string
  status?: string | null
  amount_due?: number | null
  amount_paid?: number | null
  currency?: string | null
  payment_intent?: string | { id: string } | null
}

export type PaymentVerdict =
  | { outcome: 'paid'; paymentIntentId: string | null; amountReceivedCents: number }
  | { outcome: 'processing'; paymentIntentId: string | null }
  | { outcome: 'authorized'; paymentIntentId: string | null }      // money reserved, not collected: not paid
  | { outcome: 'unpaid'; paymentIntentId: string | null; stripeStatus: string }
  | { outcome: 'canceled'; paymentIntentId: string | null }
  | { outcome: 'expired'; paymentIntentId: null }                   // a checkout session ended without payment
  | { outcome: 'mismatch'; reason: ReviewReason; paymentIntentId: string | null; detail: Record<string, unknown> }

const upper = (value: string | null | undefined) => String(value || '').toUpperCase()

function mismatch(reason: ReviewReason, paymentIntentId: string | null, detail: Record<string, unknown>): PaymentVerdict {
  return { outcome: 'mismatch', reason, paymentIntentId, detail }
}

// ---- PaymentIntent ---------------------------------------------------------------------------------------------------------
export function verifyPaymentIntent(
  order: OrderFacts,
  intent: PaymentIntentLike,
  opts: { attempt?: AttemptFacts | null; requireOrderReference: boolean },
): PaymentVerdict {
  const piId = intent.id
  if (opts.requireOrderReference) {
    if (intent.metadata?.orderId !== order.id) {
      return mismatch('order_reference', piId, { expectedOrderId: order.id, foundOrderId: intent.metadata?.orderId ?? null })
    }
    if (opts.attempt && intent.metadata?.attemptId !== opts.attempt.id) {
      return mismatch('order_reference', piId, { expectedAttemptId: opts.attempt.id, foundAttemptId: intent.metadata?.attemptId ?? null })
    }
  }
  const moneyMoves = ['succeeded', 'processing', 'requires_capture'].includes(intent.status)
  if (moneyMoves) {
    if (upper(intent.currency) !== upper(order.currency)) {
      return mismatch('currency', piId, { expected: upper(order.currency), received: upper(intent.currency) })
    }
    if (intent.amount !== order.totalCents) {
      return mismatch('amount', piId, { expectedCents: order.totalCents, requestedCents: intent.amount })
    }
  }
  switch (intent.status) {
    case 'succeeded': {
      const received = typeof intent.amount_received === 'number' ? intent.amount_received : null
      if (received !== order.totalCents) {
        return mismatch('amount', piId, { expectedCents: order.totalCents, receivedCents: received })
      }
      return { outcome: 'paid', paymentIntentId: piId, amountReceivedCents: received }
    }
    case 'processing':
      return { outcome: 'processing', paymentIntentId: piId }
    case 'requires_capture':
      return { outcome: 'authorized', paymentIntentId: piId }
    case 'canceled':
      return { outcome: 'canceled', paymentIntentId: piId }
    default:
      return { outcome: 'unpaid', paymentIntentId: piId, stripeStatus: intent.status }
  }
}

// ---- Checkout Session (hosted checkout) -----------------------------------------------------------------------------------
export function verifyCheckoutSession(order: OrderFacts, attempt: AttemptFacts | null, session: CheckoutSessionLike): PaymentVerdict {
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null
  if (!attempt || attempt.orderId !== order.id) return mismatch('session_reference', piId, { sessionId: session.id })
  if (session.mode !== 'payment') return mismatch('mode', piId, { mode: session.mode ?? null })
  if (session.client_reference_id !== order.id || session.metadata?.orderId !== order.id) {
    return mismatch('session_reference', piId, { expectedOrderId: order.id, clientReference: session.client_reference_id ?? null, metadataOrderId: session.metadata?.orderId ?? null })
  }
  if (session.status === 'expired') {
    // "Expired" is only believed if no money is on its way: a PaymentIntent that is paid or being paid always wins.
    const attached = typeof session.payment_intent === 'object' && session.payment_intent ? session.payment_intent : null
    if (attached && ['succeeded', 'processing', 'requires_capture'].includes(attached.status)) {
      return verifyPaymentIntent(order, attached, { attempt, requireOrderReference: true })
    }
    return { outcome: 'expired', paymentIntentId: null }
  }
  if (upper(session.currency) !== upper(order.currency) || upper(attempt.currency) !== upper(order.currency)) {
    return mismatch('currency', piId, { expected: upper(order.currency), session: upper(session.currency), attempt: upper(attempt.currency) })
  }
  if (session.amount_total !== order.totalCents || attempt.amountCents !== order.totalCents) {
    return mismatch('amount', piId, { expectedCents: order.totalCents, sessionCents: session.amount_total ?? null, attemptCents: attempt.amountCents })
  }
  if (session.status === 'open') return { outcome: 'unpaid', paymentIntentId: piId, stripeStatus: 'open' }
  if (session.status !== 'complete') return { outcome: 'unpaid', paymentIntentId: piId, stripeStatus: String(session.status) }

  // The customer finished on Stripe's page. Whether it counts depends on the money, which lives on the PaymentIntent.
  if (session.payment_status !== 'paid') {
    return mismatch('unpaid_completion', piId, { paymentStatus: session.payment_status ?? null })
  }
  const intent = typeof session.payment_intent === 'object' && session.payment_intent ? session.payment_intent : null
  if (!intent) return mismatch('payment_intent_missing', piId, { sessionId: session.id })
  return verifyPaymentIntent(order, intent, { attempt, requireOrderReference: true })
}

// ---- Invoice (administrator invoices) --------------------------------------------------------------------------------------
export function verifyInvoice(order: OrderFacts, invoice: InvoiceLike): PaymentVerdict {
  const piId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id ?? null
  if (invoice.status === 'void') return { outcome: 'canceled', paymentIntentId: piId }
  if (invoice.status === 'uncollectible') return { outcome: 'unpaid', paymentIntentId: piId, stripeStatus: 'uncollectible' }
  if (invoice.status !== 'paid') return { outcome: 'unpaid', paymentIntentId: piId, stripeStatus: String(invoice.status ?? 'unknown') }
  if (upper(invoice.currency) !== upper(order.currency)) {
    return mismatch('currency', piId, { expected: upper(order.currency), received: upper(invoice.currency) })
  }
  if (invoice.amount_paid !== order.totalCents) {
    return mismatch('amount', piId, { expectedCents: order.totalCents, receivedCents: invoice.amount_paid ?? null })
  }
  return { outcome: 'paid', paymentIntentId: piId, amountReceivedCents: invoice.amount_paid }
}

// ---- What a verdict is allowed to do to the order ------------------------------------------------------------------------------
export type OrderPaymentState = {
  status: string
  paymentStatus: string
  paymentReviewReason: string | null
  stripePaymentIntentId: string | null
  // true for orders created by the hosted checkout (they have payment attempts): their payment status is only
  // pending / processing / paid, a failed attempt is a fact about the attempt, not about the order.
  hosted: boolean
}

export type AttemptStatus = 'open' | 'processing' | 'paid' | 'expired' | 'failed' | 'mismatch'

export type PaymentDecision = {
  paymentStatus: string | null      // new value, or null = leave as it is
  status: string | null             // new order status, or null = leave as it is
  release: boolean                  // the order enters production NOW (exactly once: only from awaiting_payment)
  review: ReviewReason | null       // a person has to look at this
  attemptStatus: AttemptStatus | null
  linkPaymentIntentId: string | null
  paidNow: boolean                  // first time this order is seen as paid
}

const NO_CHANGE: PaymentDecision = {
  paymentStatus: null, status: null, release: false, review: null, attemptStatus: null, linkPaymentIntentId: null, paidNow: false,
}

// What the old code called the state: kept for orders that do not come from the hosted checkout.
function legacyLabel(verdict: PaymentVerdict): string | null {
  switch (verdict.outcome) {
    case 'processing': return 'processing'
    case 'authorized': return 'authorized'
    case 'canceled': return 'canceled'
    case 'unpaid': return verdict.stripeStatus === 'requires_payment_method' || verdict.stripeStatus === 'requires_action' ? 'failed' : 'pending'
    default: return null
  }
}

// What Stripe says about a PaymentIntent that is NOT collecting money: the customer can still try again, or has left. (Not "open": that is a payment page, which
// says nothing about the payment behind it.)
const NO_MONEY_MOVING = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action'])

export function decidePaymentUpdate(
  state: OrderPaymentState,
  verdict: PaymentVerdict,
  // `processingEnded`: the attempt this answer is about WAS the one being confirmed, and no other attempt of the order is being confirmed, paid, or under review
  // (computed by the caller, which knows the attempts).
  extras: { shippingProblem?: ReviewReason | null; processingEnded?: boolean } = {},
): PaymentDecision {
  const alreadyPaid = isPaymentVerified(state.paymentStatus)
  const cancelled = state.status === 'cancelled'

  switch (verdict.outcome) {
    case 'mismatch':
      // Wrong money or wrong reference: nothing is marked paid, nothing is released, a person is told.
      return { ...NO_CHANGE, review: verdict.reason, attemptStatus: 'mismatch' }

    case 'paid': {
      if (alreadyPaid) {
        const samePayment = !state.stripePaymentIntentId || !verdict.paymentIntentId || state.stripePaymentIntentId === verdict.paymentIntentId
        return samePayment
          ? { ...NO_CHANGE, attemptStatus: 'paid' }
          : { ...NO_CHANGE, attemptStatus: 'paid', review: 'duplicate_payment' }
      }
      const paid: PaymentDecision = {
        ...NO_CHANGE, paymentStatus: 'paid', attemptStatus: 'paid', linkPaymentIntentId: verdict.paymentIntentId, paidNow: true,
      }
      // Money for an order that was cancelled: recorded and shown to a person, never turned back into production on its own.
      if (cancelled) return { ...paid, review: 'paid_after_cancel' }
      if (state.status !== 'awaiting_payment') return paid
      if (extras.shippingProblem) return { ...paid, status: 'awaiting_review', review: extras.shippingProblem }
      // Anything already flagged for a person to look at is not released automatically.
      if (state.paymentReviewReason) return paid
      return { ...paid, status: 'queued', release: true }
    }

    case 'processing':
    case 'authorized':
    case 'unpaid':
    case 'canceled': {
      // A payment we already hold as paid can never legitimately be shown by Stripe as "not paid" again. If Stripe says so about
      // the very same payment, keep the order paid and tell a person; about any other payment (another attempt), ignore it.
      const sameKnownPayment = Boolean(state.stripePaymentIntentId) && verdict.paymentIntentId === state.stripePaymentIntentId
      if (alreadyPaid) return sameKnownPayment ? { ...NO_CHANGE, review: 'status_regression' } : { ...NO_CHANGE }

      const progress: AttemptStatus | null =
        verdict.outcome === 'processing' || verdict.outcome === 'authorized' ? 'processing'
          : verdict.outcome === 'canceled' ? 'failed'
            : null
      const attemptStatus = state.hosted ? progress : null
      // A cancelled order is not changed by a payment that is not paid.
      if (cancelled) return { ...NO_CHANGE, attemptStatus }
      // Hosted orders only ever show pending / processing / paid: a failed or abandoned attempt is a fact about the attempt...
      if (state.hosted) {
        // ...except that an order that WAS being confirmed stays "confirming" for ever if the payment behind it ends without money (canceled, or failed and waiting for
        // another try): nothing else would bring it back, the customer could not pay again, and - since step 4.5 - the same cart would stay blocked for ever (the
        // 72-hour window that used to hide this is gone). Stripe, asked by the server, says no money is moving: the order waits for its payment again.
        const ended = state.paymentStatus === 'processing' && extras.processingEnded === true
          && (verdict.outcome === 'canceled' || (verdict.outcome === 'unpaid' && NO_MONEY_MOVING.has(verdict.stripeStatus)))
        if (ended) return { ...NO_CHANGE, paymentStatus: 'pending', attemptStatus: 'failed' }
        return { ...NO_CHANGE, paymentStatus: progress === 'processing' ? 'processing' : null, attemptStatus }
      }
      return { ...NO_CHANGE, paymentStatus: legacyLabel(verdict), attemptStatus }
    }

    case 'expired':
      // (an expired payment page is believed only when no money is moving on it: verifyCheckoutSession) - for an order that was being confirmed, that ends it
      if (state.hosted && state.paymentStatus === 'processing' && extras.processingEnded === true && !alreadyPaid && !cancelled) {
        return { ...NO_CHANGE, paymentStatus: 'pending', attemptStatus: 'expired' }
      }
      return { ...NO_CHANGE, attemptStatus: 'expired' }
  }
}

// An order may be cancelled because its payment page expired ONLY if nothing else could still bring a payment.
// (The caller has just read the payment state from Stripe; this checks what we hold about the other attempts.)
export function mayCancelAfterExpiry(
  order: { status: string; paymentStatus: string; paymentReviewReason: string | null },
  attempts: Array<{ id: string; status: string; createdAt: Date }>,
  expiredAttemptId: string,
  opts: { now?: Date; staleReservationMs: number },
): boolean {
  if (order.status !== 'awaiting_payment') return false
  if (isPaymentVerified(order.paymentStatus) || order.paymentStatus === 'processing') return false
  if (order.paymentReviewReason) return false
  const now = (opts.now ?? new Date()).getTime()
  return attempts.every((attempt) => {
    if (attempt.id === expiredAttemptId) return true
    if (attempt.status === 'expired' || attempt.status === 'failed') return true
    // a reservation nobody completed (older than the join window) can no longer lead to a payment page
    if (attempt.status === 'creating' && now - attempt.createdAt.getTime() > opts.staleReservationMs) return true
    return false // open, processing, paid, mismatch, or a fresh reservation
  })
}

// ---- Delivery address collected by Stripe ---------------------------------------------------------------------------------------
export type CollectedAddress = {
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  country: string | null
}

export function addressFromSession(session: Stripe.Checkout.Session | Record<string, any>): CollectedAddress | null {
  const details = (session as any)?.collected_information?.shipping_details ?? (session as any)?.shipping_details ?? null
  const address = details?.address
  if (!address || typeof address !== 'object') return null
  return {
    name: details.name ?? null,
    line1: address.line1 ?? null,
    line2: address.line2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postalCode: address.postal_code ?? null,
    country: address.country ? String(address.country).toUpperCase() : null,
  }
}
