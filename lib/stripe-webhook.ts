// Stripe webhook processing: idempotent, retry-safe, concurrency-safe. PostgreSQL only (no queue).
//
// The rule that makes it reliable: the "event was processed" record (StripeEvent) and the order updates are
// written in the SAME database transaction.
//   * processing fails      -> the whole transaction rolls back, no record is left, Stripe retries and the retry
//                              processes the event for real (the old code recorded the event first, so a retry was
//                              answered "duplicate" and the order stayed unpaid forever);
//   * processing succeeds   -> record + order updates commit together; any later delivery is a harmless duplicate;
//   * identical events at the same time -> the second INSERT waits on the unique key of the first. If the first commits
//                              the second sees a duplicate; if the first rolls back the second does the work itself.
// Orders are locked (SELECT ... FOR UPDATE) before the current payment state is read from Stripe, so different events for
// the same payment (processing / succeeded / refunded...) are applied one after the other, newest state last.
//
// External effects: reading from Stripe is read-only; receipts are generated after the commit and are idempotent.
import type Stripe from 'stripe'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import {
  SYNC_TX_OPTIONS,
  applyInvoiceToOrders,
  applyPaymentIntentToOrders,
  generateReceiptsBestEffort,
} from '@/lib/stripe-payments'

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
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,255}$/
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,255}$/

export type StripeWebhookResult =
  | { outcome: 'processed'; duplicate: false; type: string; paymentIntentId: string | null; invoiceId: string | null; updatedOrders: number }
  | { outcome: 'duplicate'; duplicate: true; type: string; paymentIntentId: string | null; invoiceId: string | null }
  | { outcome: 'ignored'; duplicate: false; type: string; reason: string }

type Target = { kind: 'payment_intent'; id: string } | { kind: 'invoice'; id: string }

function readObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id
  return null
}

// Which Stripe object does this event concern? (Taken from the signed event; ids are format-checked before use.)
function classifyEvent(event: Stripe.Event): { target: Target } | { ignored: string } {
  const object = event.data?.object as unknown as Record<string, unknown> | undefined
  if (!object) return { ignored: 'event_without_object' }
  if (PAYMENT_INTENT_EVENTS.has(event.type)) {
    const id = object.object === 'payment_intent' ? readObjectId(object) : readObjectId(object.payment_intent)
    if (!id) return { ignored: 'no_payment_intent' }
    if (!PAYMENT_INTENT_ID.test(id)) return { ignored: 'invalid_payment_intent_id' }
    return { target: { kind: 'payment_intent', id } }
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

  const outcome = await prisma.$transaction(async (tx) => {
    // Claim the event. ON CONFLICT DO NOTHING: no error and no aborted transaction on a duplicate; if an identical event is
    // being processed right now, this waits until that transaction commits or rolls back.
    const claimed = await tx.stripeEvent.createMany({
      data: [{
        id: event.id,
        type: event.type,
        paymentIntentId,
        payload: event as unknown as Prisma.InputJsonValue,
      }],
      skipDuplicates: true,
    })
    if (claimed.count === 0) return { duplicate: true as const }

    const synced = target.kind === 'payment_intent'
      ? await applyPaymentIntentToOrders(tx, target.id, event.type)
      : await applyInvoiceToOrders(tx, target.id, event.type)
    return { duplicate: false as const, orderIds: synced.orderIds, updatedOrders: synced.updatedOrders }
  }, SYNC_TX_OPTIONS)

  if (outcome.duplicate) {
    incrementMetric('stripe_webhook_events_total', 1, { outcome: 'duplicate', type: event.type })
    logEvent({ event: 'stripe.webhook', level: 'info', outcome: 'duplicate', eventId: event.id, type: event.type })
    return { outcome: 'duplicate', duplicate: true, type: event.type, paymentIntentId, invoiceId }
  }

  // After the commit: idempotent, best-effort side effects (a failure here must not undo or repeat the event).
  await generateReceiptsBestEffort(outcome.orderIds, 'stripe.webhook')

  incrementMetric('stripe_webhook_events_total', 1, { outcome: 'processed', type: event.type })
  if (outcome.updatedOrders === 0) {
    // Normal when the webhook is faster than the browser that creates the order: the order is reconciled with Stripe
    // right after it is created (lib/orders.ts). Logged so a payment that never gets an order can be found.
    logEvent({ event: 'stripe.webhook', level: 'warn', outcome: 'processed_no_matching_order', eventId: event.id, type: event.type, paymentIntentId, invoiceId })
  } else {
    logEvent({ event: 'stripe.webhook', level: 'info', outcome: 'processed', eventId: event.id, type: event.type, updatedOrders: outcome.updatedOrders })
  }
  return { outcome: 'processed', duplicate: false, type: event.type, paymentIntentId, invoiceId, updatedOrders: outcome.updatedOrders }
}
