// Stripe webhook processing: idempotent, retry-safe, concurrency-safe. PostgreSQL only (no queue).
//
// An event is a HINT about which Stripe object to look at; the state is always read from Stripe (lib/payment-sync.ts), never
// taken from the event. That is what makes duplicates, late deliveries and out-of-order events harmless.
//   * processing fails      -> nothing is recorded, Stripe retries and the retry processes the event for real;
//   * processing succeeds   -> the event record and the order updates were committed together; later deliveries are duplicates;
//   * identical events at the same time -> one applies it, the other finds it already recorded;
//   * different events for the same payment at the same time -> they run one after the other (one lease per order), the later
//                              one reads Stripe after the earlier one has applied its state.
// What counts as a valid payment is decided in ONE place: lib/payment-verification.ts.
import type Stripe from 'stripe'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import { syncPayment, type PaymentHint, type SyncTarget } from '@/lib/payment-sync'

// Only these events change anything we store. Subscribe the Stripe webhook endpoint to exactly this list.
export const PAYMENT_INTENT_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
] as const

// Hosted checkout. Only the card flow exists; delayed payment methods are not enabled, so their events are not handled.
export const CHECKOUT_SESSION_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.expired',
] as const

export const INVOICE_EVENT_TYPES = [
  'invoice.sent',
  'invoice.finalized',
  'invoice.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
] as const

const PAYMENT_INTENT_EVENTS = new Set<string>(PAYMENT_INTENT_EVENT_TYPES)
const INVOICE_EVENTS = new Set<string>(INVOICE_EVENT_TYPES)
const SESSION_EVENTS = new Set<string>(CHECKOUT_SESSION_EVENT_TYPES)
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,255}$/
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,255}$/

export type StripeWebhookResult =
  | { outcome: 'processed'; duplicate: false; type: string; paymentIntentId: string | null; invoiceId: string | null; checkoutSessionId: string | null; updatedOrders: number }
  | { outcome: 'duplicate'; duplicate: true; type: string; paymentIntentId: string | null; invoiceId: string | null; checkoutSessionId: string | null }
  | { outcome: 'ignored'; duplicate: false; type: string; reason: string }

function readObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id
  return null
}

// Our own ids, put into the Stripe object when we created it. Used only to FIND the order; the payment is verified later
// against what Stripe returns when asked.
function readHint(object: Record<string, unknown>): PaymentHint | undefined {
  const metadata = object.metadata && typeof object.metadata === 'object' ? object.metadata as Record<string, unknown> : null
  const orderId = typeof metadata?.orderId === 'string' ? metadata.orderId : undefined
  const attemptId = typeof metadata?.attemptId === 'string' ? metadata.attemptId : undefined
  return orderId || attemptId ? { orderId, attemptId } : undefined
}

// Which Stripe object does this event concern? (Taken from the signed event; ids are format-checked before use.)
function classifyEvent(event: Stripe.Event): { target: SyncTarget } | { ignored: string } {
  const object = event.data?.object as unknown as Record<string, unknown> | undefined
  if (!object) return { ignored: 'event_without_object' }
  if (PAYMENT_INTENT_EVENTS.has(event.type)) {
    const isIntent = object.object === 'payment_intent'
    const id = isIntent ? readObjectId(object) : readObjectId(object.payment_intent)
    if (!id) return { ignored: 'no_payment_intent' }
    if (!PAYMENT_INTENT_ID.test(id)) return { ignored: 'invalid_payment_intent_id' }
    return { target: { kind: 'payment_intent', id, hint: isIntent ? readHint(object) : undefined } }
  }
  if (SESSION_EVENTS.has(event.type)) {
    const id = object.object === 'checkout.session' ? readObjectId(object) : null
    if (!id) return { ignored: 'no_checkout_session' }
    if (!CHECKOUT_SESSION_ID.test(id)) return { ignored: 'invalid_checkout_session_id' }
    return { target: { kind: 'checkout_session', id, hint: readHint(object) } }
  }
  if (INVOICE_EVENTS.has(event.type)) {
    const id = object.object === 'invoice' ? readObjectId(object) : readObjectId(object.invoice)
    if (!id) return { ignored: 'no_invoice' }
    if (!INVOICE_ID.test(id)) return { ignored: 'invalid_invoice_id' }
    return { target: { kind: 'invoice', id } }
  }
  return { ignored: 'unsupported_event_type' }
}

// A test-mode event must not change live data (and vice versa). Different signing secrets already make this unlikely.
function livemodeMismatch(event: Stripe.Event) {
  if (typeof event.livemode !== 'boolean') return false
  const key = process.env.STRIPE_SECRET_KEY || ''
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return !event.livemode
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return event.livemode
  return false
}

function ignored(event: Stripe.Event, reason: string): StripeWebhookResult {
  incrementMetric('stripe_webhook_events_total', 1, { outcome: 'ignored', type: event.type })
  logEvent({ event: 'stripe.webhook', level: 'info', outcome: 'ignored', reason, eventId: event.id, type: event.type })
  return { outcome: 'ignored', duplicate: false, type: event.type, reason }
}

/**
 * Process one VERIFIED Stripe event. Resolves when the event has been processed (or was already processed, or is not
 * relevant): the caller may then answer 2xx. Throws when processing failed: the caller must answer non-2xx so that
 * Stripe retries; nothing is left behind in the database in that case.
 */
export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<StripeWebhookResult> {
  const classified = classifyEvent(event)
  if ('ignored' in classified) return ignored(event, classified.ignored)
  if (livemodeMismatch(event)) return ignored(event, 'livemode_mismatch')
  const { target } = classified

  const paymentIntentId = target.kind === 'payment_intent' ? target.id : null
  const invoiceId = target.kind === 'invoice' ? target.id : null
  const checkoutSessionId = target.kind === 'checkout_session' ? target.id : null

  const outcome = await syncPayment(target, { eventType: event.type, event })

  if (outcome.duplicate) {
    incrementMetric('stripe_webhook_events_total', 1, { outcome: 'duplicate', type: event.type })
    logEvent({ event: 'stripe.webhook', level: 'info', outcome: 'duplicate', eventId: event.id, type: event.type })
    return { outcome: 'duplicate', duplicate: true, type: event.type, paymentIntentId, invoiceId, checkoutSessionId }
  }

  incrementMetric('stripe_webhook_events_total', 1, { outcome: 'processed', type: event.type })
  if (outcome.updatedOrders === 0) {
    // Normal for the old flow when the webhook is faster than the browser that creates the order (the order is reconciled with
    // Stripe right after it is created, lib/orders.ts). For a payment that never gets an order: the event is stored with
    // orderId = null and is listed by the reconciliation script.
    logEvent({ event: 'stripe.webhook', level: 'warn', outcome: 'processed_no_matching_order', eventId: event.id, type: event.type, paymentIntentId, invoiceId, checkoutSessionId })
  } else {
    logEvent({ event: 'stripe.webhook', level: 'info', outcome: 'processed', eventId: event.id, type: event.type, updatedOrders: outcome.updatedOrders, released: outcome.releasedOrderIds.length })
  }
  return { outcome: 'processed', duplicate: false, type: event.type, paymentIntentId, invoiceId, checkoutSessionId, updatedOrders: outcome.updatedOrders }
}
