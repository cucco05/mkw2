// Resolving a payment that is "on hold" - the administrator's recorded decision (step 4.5).
//
// An order's payment is ON HOLD when the server does not know whether money was taken, or knows it was taken and a person has to look at it:
//   * the payment is being confirmed (payment status "processing", an attempt "processing");
//   * a payment arrived that did not match (a wrong amount, an unpaid completion...): `paymentReviewReason` is set;
//   * money arrived for an order that had been cancelled, or for a second time.
// While it is on hold the same cart can not be paid again (lib/checkout-orders.ts, findPurchaseInFlight) - and there is NO time limit on that. Most holds end by
// themselves, because the server asks Stripe (the status page, the checkout guard, the webhooks). What is left is a person's decision, and this is where it is
// taken, with a reason, and kept:
//   * "no_charge": nothing was charged. Stripe is asked again, by the server, and the decision is refused if any payment of the order is collected or on its
//     way - and ALSO if Stripe can not be asked, or does not answer for every payment page of the order (409 STRIPE_UNVERIFIABLE, no decision is taken): nothing an
//     administrator declares takes the place of the answer (F01, closed in step 4.6, S6, P4-0). The order is cancelled (the customer may pay again) and the open
//     payment pages are closed;
//   * "accepted": the money is verified and the reason it was held has been dealt with (a refund of a duplicate, a corrected address...). The hold is cleared;
//     the order's status is moved with the usual control.
// Only an administrator (not staff) may do it. Nothing here reads a state from the browser: the figures come from our database and from Stripe.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { isPaymentVerified, refundOperationBlocks, refundOperationBlocksWhere } from '@/lib/order-payment-policy'
import { recordAdminAuditEvent, type AdminAuditInput } from '@/lib/admin-audit'
import { syncPayment } from '@/lib/payment-sync'
import { attemptChangeIsFinancial, withFinancialRevision } from '@/lib/financial-revision'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'

export const PAYMENT_HOLD_REASON_MIN_LENGTH = 10
export const PAYMENT_HOLD_REASON_MAX_LENGTH = 300
export type HoldOutcome = 'no_charge' | 'accepted'
// What Stripe said when the decision was taken. There is no result for "Stripe could not be asked": such a decision is not taken at all (F01).
export type StripeCheck = 'confirmed_no_charge' | 'payment_collected'

export class PaymentHoldError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PaymentHoldError'
    this.status = status
    this.code = code
  }
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
// (step 4.6, S6, P2c) a refund the application requested and has not closed is money that is leaving: no decision about the payment is taken meanwhile
const REFUND_IN_PROGRESS_MESSAGE = 'A refund of this order was requested from the application and is not over yet: the payment can not be resolved until it is closed.'
async function assertNoRefundInProgress(db: Pick<Prisma.TransactionClient, 'refundOperation'>, orderId: string) {
  const operations = await db.refundOperation.findMany({ where: { orderId, ...refundOperationBlocksWhere }, select: { status: true, appliedAt: true } })
  if (operations.some(refundOperationBlocks)) throw new PaymentHoldError(409, 'REFUND_IN_PROGRESS', REFUND_IN_PROGRESS_MESSAGE)
}
const OPEN_ATTEMPT_STATUSES = ['creating', 'open', 'processing', 'mismatch']

// Is there anything to resolve? (A hold the server clears by itself, or an order that was never on hold, is refused with a clear reason.)
export function isOnHold(order: { status: string; paymentStatus: string; paymentReviewReason: string | null }, attempts: ReadonlyArray<{ status: string }>): boolean {
  if (order.paymentReviewReason) return true
  if (order.paymentStatus === 'processing') return true
  if (isPaymentVerified(order.paymentStatus) && order.status === 'awaiting_review') return true
  return attempts.some((attempt) => attempt.status === 'processing' || attempt.status === 'mismatch')
}

type Evidence = 'money' | 'none' | 'unknown'

// Does ANY payment of this order have money collected or on its way? Read from Stripe now (one read per payment page), never assumed. A payment page that was
// never opened has nothing to read.
async function readChargeEvidence(attempts: ReadonlyArray<{ stripeSessionId: string | null; stripePaymentIntentId: string | null }>): Promise<Evidence> {
  const stripe = getStripe()
  let unknown = false
  for (const attempt of attempts) {
    try {
      if (attempt.stripeSessionId) {
        const session = await stripe.checkout.sessions.retrieve(attempt.stripeSessionId, { expand: ['payment_intent'] }, { timeout: 8000 })
        if (session.payment_status === 'paid') return 'money'
        const intent = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null
        if (intent && ['succeeded', 'processing', 'requires_capture'].includes(intent.status)) return 'money'
        if (!intent && typeof session.payment_intent === 'string') {
          const direct = await stripe.paymentIntents.retrieve(session.payment_intent, undefined, { timeout: 8000 })
          if (['succeeded', 'processing', 'requires_capture'].includes(direct.status)) return 'money'
        }
      } else if (attempt.stripePaymentIntentId) {
        const intent = await stripe.paymentIntents.retrieve(attempt.stripePaymentIntentId, undefined, { timeout: 8000 })
        if (['succeeded', 'processing', 'requires_capture'].includes(intent.status)) return 'money'
      }
    } catch {
      unknown = true
    }
  }
  return unknown ? 'unknown' : 'none'
}

export type ResolveHoldInput = {
  orderId: string
  adminId: string
  outcome: HoldOutcome
  reason: string
  audit: Omit<AdminAuditInput, 'adminId' | 'action' | 'targetType' | 'targetId' | 'metadata'>
}

export async function resolvePaymentHold(input: ResolveHoldInput) {
  const reason = input.reason.trim()
  if (reason.length < PAYMENT_HOLD_REASON_MIN_LENGTH) {
    throw new PaymentHoldError(400, 'REASON_REQUIRED', `A written reason is needed (at least ${PAYMENT_HOLD_REASON_MIN_LENGTH} characters).`)
  }
  const load = async () => {
    const order = await prisma.printOrder.findUnique({ where: { id: input.orderId }, include: { paymentAttempts: { orderBy: { createdAt: 'desc' } } } })
    if (!order) throw new PaymentHoldError(404, 'NOT_FOUND', 'Order not found.')
    return order
  }
  let order = await load()
  if (order.paymentAttempts.length === 0) throw new PaymentHoldError(409, 'NOT_A_HOSTED_ORDER', 'This order has no payment attempts of the hosted checkout.')
  if (!isOnHold(order, order.paymentAttempts)) {
    throw new PaymentHoldError(409, 'NOT_ON_HOLD', 'This order\'s payment is not on hold.')
  }
  // before Stripe is asked anything; checked again under the lock below
  await assertNoRefundInProgress(prisma, order.id)

  // 1. Ask Stripe again, through the payment sync (it may well settle the hold by itself: a payment that is paid is recorded as paid).
  let synced = true
  for (const attempt of order.paymentAttempts) {
    if (!attempt.stripeSessionId || !OPEN_ATTEMPT_STATUSES.includes(attempt.status)) continue
    try {
      await syncPayment({ kind: 'checkout_session', id: attempt.stripeSessionId, hint: { orderId: order.id, attemptId: attempt.id } }, { eventType: 'admin.payment_hold', effects: 'background', maxWaitMs: 4000 })
    } catch {
      synced = false
    }
  }
  order = await load()

  // 2. The decision.
  let stripeCheck: StripeCheck
  if (input.outcome === 'accepted') {
    if (!isPaymentVerified(order.paymentStatus)) {
      throw new PaymentHoldError(409, 'NOT_PAID', 'Only a payment that Stripe shows as collected can be accepted. If nothing was charged, resolve it as "no charge".')
    }
    stripeCheck = 'payment_collected'
  } else {
    if (isPaymentVerified(order.paymentStatus)) {
      throw new PaymentHoldError(409, 'PAYMENT_COLLECTED', 'Stripe shows this payment as collected: it can be accepted, or refunded, but not released as "no charge".')
    }
    const evidence = await readChargeEvidence(order.paymentAttempts)
    if (evidence === 'money') {
      throw new PaymentHoldError(409, 'CHARGE_EXISTS', 'A payment of this order is collected or on its way at Stripe. Refund it, or accept it - it can not be released as "no charge".')
    }
    if (evidence === 'unknown' || !synced) {
      // Stripe could not be asked, or did not answer for every payment page of the order (the payment sync or the check failed): "no charge" is NOT confirmed, and nothing the
      // administrator declares takes the place of the answer. No decision is taken; the request can be repeated when Stripe answers (F01).
      throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', 'Stripe could not be asked (or did not answer for every payment page of this order), so "no charge" can not be confirmed and the decision was not taken. Try again when Stripe answers.')
    }
    stripeCheck = 'confirmed_no_charge'
  }

  // 3. Applied in one transaction with the audit record.
  const now = new Date()
  const closedSessions: string[] = []
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${order.id} FOR UPDATE`
    const fresh = await tx.printOrder.findUniqueOrThrow({ where: { id: order.id }, include: { paymentAttempts: true } })
    // the order may have moved while Stripe was being asked (or another decision may have been taken at the same moment): the decision is only valid for the
    // state it was made on
    if (!isOnHold(fresh, fresh.paymentAttempts)) throw new PaymentHoldError(409, 'NOT_ON_HOLD', 'This order\'s payment is not on hold.')
    await assertNoRefundInProgress(tx, fresh.id)
    if (input.outcome === 'no_charge' && isPaymentVerified(fresh.paymentStatus)) {
      throw new PaymentHoldError(409, 'PAYMENT_COLLECTED', 'The payment was collected while this was being decided.')
    }
    if (input.outcome === 'accepted' && !isPaymentVerified(fresh.paymentStatus)) {
      throw new PaymentHoldError(409, 'NOT_PAID', 'The order is no longer paid.')
    }
    const metadata = asRecord(fresh.metadata)
    const prior = Array.isArray(metadata.paymentHoldResolution) ? metadata.paymentHoldResolution : []
    const entry = {
      outcome: input.outcome,
      by: input.adminId,
      at: now.toISOString(),
      reason: reason.slice(0, PAYMENT_HOLD_REASON_MAX_LENGTH),
      stripeCheck,
      previousStatus: fresh.status,
      previousPaymentStatus: fresh.paymentStatus,
      previousReviewReason: fresh.paymentReviewReason,
    }
    const data: Prisma.PrintOrderUncheckedUpdateInput = {
      paymentReviewReason: null,
      metadata: { ...metadata, paymentHoldResolution: [...prior.slice(-9), entry] } as Prisma.InputJsonValue,
    }
    if (input.outcome === 'no_charge') {
      data.status = 'cancelled'
      data.paymentStatus = 'canceled'
      data.metadata = { ...asRecord(data.metadata), cancellation: { reason: 'admin_payment_hold_release', at: now.toISOString(), by: input.adminId } } as Prisma.InputJsonValue
      for (const attempt of fresh.paymentAttempts) {
        if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status)) continue
        // (also a payment page whose payment is "being confirmed": the customer could still complete it)
        if (attempt.stripeSessionId) closedSessions.push(attempt.stripeSessionId)
      }
      await tx.paymentAttempt.updateMany({
        where: { orderId: fresh.id, status: { in: OPEN_ATTEMPT_STATUSES } },
        data: { status: 'failed', failureReason: 'admin_released' },
      })
    }
    // (step 4.6, S6, P2b) the resolution changes the money situation of the order (the review reason, and for "no charge" the payment status, the cancellation and the attempts
    // that were being confirmed): the financial revision goes up in this same UPDATE, so no authorization given before it can come back to life
    const attemptsClosed = input.outcome === 'no_charge' && fresh.paymentAttempts.some((attempt) => OPEN_ATTEMPT_STATUSES.includes(attempt.status) && attemptChangeIsFinancial(attempt, { status: 'failed' }))
    const updated = await tx.printOrder.update({ where: { id: fresh.id }, data: withFinancialRevision(fresh, data, { attempt: attemptsClosed }), select: { id: true, status: true, paymentStatus: true, paymentReviewReason: true } })
    await recordAdminAuditEvent({
      ...input.audit,
      adminId: input.adminId,
      action: 'admin.order.payment_hold.resolve',
      targetType: 'print_order',
      targetId: fresh.id,
      metadata: { outcome: input.outcome, reason: entry.reason, stripeCheck, previousStatus: entry.previousStatus, previousPaymentStatus: entry.previousPaymentStatus, previousReviewReason: entry.previousReviewReason } as Prisma.InputJsonValue,
    }, tx)
    return updated
  }, { maxWait: 10_000, timeout: 20_000 })

  // 4. Best effort, after the commit: close the payment pages that were open, so that nobody can pay a cancelled order later (if they do, the payment is
  // recorded and shown to a person, never put into production: paid_after_cancel).
  if (input.outcome === 'no_charge') {
    for (const sessionId of closedSessions) {
      try { await getStripe().checkout.sessions.expire(sessionId) } catch { /* it expires by itself */ }
    }
  }
  incrementMetric('payment_hold_resolved_total', 1, { outcome: input.outcome, stripeCheck })
  logEvent({ event: 'payment.hold', level: 'info', outcome: input.outcome, orderId: result.id, message: stripeCheck })
  return { order: result, stripeCheck }
}
