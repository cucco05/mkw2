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
//     administrator declares takes the place of the answer (F01, closed in step 4.6, S6, P4-0). It is refused in the same way if a payment attempt of the order has
//     NO Stripe identifier - nothing can be asked about it, so it is not evidence that nothing was charged (F02, step 4.6, S6, P3b-1: lib/payment-attempt-legs.ts) - and if the
//     payment attempts of the order are no longer the ones that Stripe was asked about when the decision is taken, under the lock of the order. The order is cancelled (the
//     customer may pay again) - but ONLY once every payment page that could still be paid has been CLOSED at Stripe, with proof (follow-up P0-A): the pages are closed BEFORE the
//     decision is committed, outside any database transaction, and the decision is refused (409 PAGES_NOT_CLOSED) if a page can not be closed or read, or is COMPLETE (money:
//     CHARGE_EXISTS); pages that were closed before a decision that could not be completed stay closed, and asking again reconciles them. After the closing the order, its
//     attempts and the proofs are read again under the lock and a decision whose basis changed meanwhile is refused;
//   * "accepted": the money is verified and the reason it was held has been dealt with (a refund of a duplicate, a corrected address...). The hold is cleared;
//     the order's status is moved with the usual control.
// Only an administrator (not staff) may do it. Nothing here reads a state from the browser: the figures come from our database and from Stripe.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { isPaymentVerified, refundOperationBlocks, refundOperationBlocksWhere } from '@/lib/order-payment-policy'
import { recordAdminAuditEvent, type AdminAuditInput } from '@/lib/admin-audit'
import { syncPayment } from '@/lib/payment-sync'
import { closeAtProvider } from '@/lib/checkout-pages'
import { closingIsProved, isSessionId, REASON_CLOSED_BY_US, REASON_PROVIDER_EXPIRED, stampProof } from '@/lib/checkout-session-plan'
import {
  attemptSetsMatch, classifyAttemptLegs, combineLegEvidence, snapshotAttempts,
  type CombinedChargeEvidence, type LegRead, type VerifiedAttempt,
} from '@/lib/payment-attempt-legs'
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

// What Stripe says about ONE payment attempt that has a Stripe identifier: is money collected or on its way? These are the reads the check has always made; they throw when Stripe
// can not be asked.
async function showsMoney(stripe: ReturnType<typeof getStripe>, attempt: VerifiedAttempt, intentOnlyStatus: Map<string, string>): Promise<boolean> {
  if (attempt.stripeSessionId) {
    const session = await stripe.checkout.sessions.retrieve(attempt.stripeSessionId, { expand: ['payment_intent'] }, { timeout: 8000 })
    if (session.payment_status === 'paid') return true
    const intent = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null
    if (intent && ['succeeded', 'processing', 'requires_capture'].includes(intent.status)) return true
    if (!intent && typeof session.payment_intent === 'string') {
      const direct = await stripe.paymentIntents.retrieve(session.payment_intent, undefined, { timeout: 8000 })
      if (['succeeded', 'processing', 'requires_capture'].includes(direct.status)) return true
    }
  } else if (attempt.stripePaymentIntentId) {
    const intent = await stripe.paymentIntents.retrieve(attempt.stripePaymentIntentId, undefined, { timeout: 8000 })
    intentOnlyStatus.set(attempt.id, intent.status) // (an attempt that is only a PaymentIntent has no page to close: it is closed if this PaymentIntent is canceled - see closePagesWithProof)
    if (['succeeded', 'processing', 'requires_capture'].includes(intent.status)) return true
  }
  return false
}

// Does ANY payment of this order have money collected or on its way? Read from Stripe now (one read per payment attempt that CAN be asked about), never assumed.
// (F02, step 4.6, S6, P3b-1) A payment attempt that has no Stripe identifier can not be asked about, so it is NOT "no money": it makes the answer "unknown" - unless another
// attempt shows money, which wins (lib/payment-attempt-legs.ts). A read that fails is "unreadable", never "no money". The attempts are those of the examined copy, not the live rows.
async function readChargeEvidence(attempts: ReadonlyArray<VerifiedAttempt>, intentOnlyStatus: Map<string, string>): Promise<CombinedChargeEvidence> {
  const stripe = getStripe()
  const legs = classifyAttemptLegs(attempts)
  const reads = new Map<string, LegRead>()
  for (const [index, attempt] of attempts.entries()) {
    if (legs[index]?.basis !== 'stripe_readable') continue
    try {
      const money = await showsMoney(stripe, attempt, intentOnlyStatus)
      reads.set(attempt.id, money ? 'money' : 'no_money')
      if (money) break
    } catch {
      reads.set(attempt.id, 'unreadable')
    }
  }
  return combineLegEvidence(legs, reads)
}

const STRIPE_UNVERIFIABLE_MESSAGE = 'Stripe could not be asked (or did not answer for every payment page of this order), so "no charge" can not be confirmed and the decision was not taken. Try again when Stripe answers.'
// (F02) nothing can be asked about an attempt with no identifier: asking again does not help, the order needs a person
const NO_IDENTIFIER_MESSAGE = 'A payment attempt of this order has no Stripe identifier, so nothing can be asked of Stripe about it and "no charge" can not be confirmed: the decision was not taken. This order needs assistance.'
// (follow-up P0-A) a page that could still be paid was not closed with proof
const PAGES_NOT_CLOSED_MESSAGE = 'A payment page of this order could not be closed at Stripe (Stripe did not answer, or the page is still open, or a payment is not over), so "no charge" can not be confirmed and the decision was not taken. Pages that were closed stay closed: ask again when Stripe answers.'
const CHARGE_EXISTS_MESSAGE = 'A payment of this order is collected or on its way at Stripe. Refund it, or accept it - it can not be released as "no charge".'
// (P3b-1, audit) the payment attempts that Stripe was asked about are no longer the attempts of the order: what was read may not cover them
const ATTEMPTS_CHANGED_MESSAGE = 'The payment attempts of this order changed while Stripe was being asked, so what was read no longer covers them: "no charge" can not be confirmed and the decision was not taken. Ask again.'

// ---- the closing of the pages (follow-up P0-A) --------------------------------------------------------------------------------------------------------------------------------
// Which attempts have a payment page (or a payment) that could still be paid, and so must be closed - with proof - before "no charge" is confirmed: every attempt that is live or being confirmed
// or did not match, a status nobody knows, and a closed row whose page was never shown closed (an identifier is not a proof: lib/checkout-session-plan.ts). Rows closed WITH the provider's proof
// need nothing; a paid attempt is money (refused long before).
type ClosableAttempt = { id: string; status: string; stripeSessionId: string | null; failureReason: string | null }
function needsClosing(attempt: ClosableAttempt): boolean {
  if (attempt.status === 'paid') return false
  if (attempt.status === 'expired' || attempt.status === 'failed') return !closingIsProved(attempt.failureReason) || !isSessionId(attempt.stripeSessionId)
  return true
}

// Closes, at the provider and WITH PROOF, every page of the order that could still be paid. Outside any database transaction. Returns, for each attempt closed, the reason to write on its row.
// It throws when a page is COMPLETE (the customer finished paying: money, CHARGE_EXISTS) or can not be closed or read (PAGES_NOT_CLOSED) - and then nothing has been written; the pages closed
// before the failure STAY closed (irreversible, and safe): asking again finds them closed and goes on. An attempt that is only a PaymentIntent has no page: it counts as closed if that
// PaymentIntent is CANCELED, as it was read when the money was asked about; in any other state it is a doubtful payment.
async function closePagesWithProof(orderId: string, attempts: ReadonlyArray<ClosableAttempt>, intentOnlyStatus: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const closure = new Map<string, string>()
  for (const attempt of attempts) {
    if (!needsClosing(attempt)) continue
    if (attempt.stripeSessionId) {
      if (!isSessionId(attempt.stripeSessionId)) throw notClosed(orderId, attempt.id, 'identifier')   // (the examination refused such an attempt already)
      const proof = await closeAtProvider(attempt.stripeSessionId)
      if (proof.state === 'complete') {
        incrementMetric('payment_hold_pages_total', 1, { outcome: 'complete' })
        logEvent({ event: 'payment.hold', level: 'warn', outcome: 'page_complete', orderId, attemptId: attempt.id })
        throw new PaymentHoldError(409, 'CHARGE_EXISTS', CHARGE_EXISTS_MESSAGE)
      }
      if (proof.state !== 'closed') throw notClosed(orderId, attempt.id, 'unconfirmed')
      closure.set(attempt.id, proof.by === 'us' ? `${REASON_CLOSED_BY_US}admin_released` : `${REASON_PROVIDER_EXPIRED} (admin_released)`)
      incrementMetric('payment_hold_pages_total', 1, { outcome: 'closed' })
    } else {
      if (intentOnlyStatus.get(attempt.id) !== 'canceled') throw notClosed(orderId, attempt.id, 'intent')
      closure.set(attempt.id, 'admin_released')
    }
  }
  return closure
}
function notClosed(orderId: string, attemptId: string, why: string): PaymentHoldError {
  incrementMetric('payment_hold_pages_total', 1, { outcome: 'not_closed' })
  logEvent({ event: 'payment.hold', level: 'warn', outcome: 'pages_not_closed', orderId, attemptId, message: why })
  return new PaymentHoldError(409, 'PAGES_NOT_CLOSED', PAGES_NOT_CLOSED_MESSAGE)
}

// The checks of the transaction below, made once more BEFORE any page is closed at the provider (a closing can not be undone): without the lock - the transaction repeats them under it, and
// decides. If the basis of the decision already changed while Stripe was being asked (a payment collected, a refund requested, an attempt added or changed, the money situation moved), nothing is
// closed. (A change that comes after this read is caught by the transaction, and the pages closed meanwhile stay closed: asking again reconciles them.)
async function assertNoChargeBasis(orderId: string, examined: ReadonlyArray<VerifiedAttempt>, examinedRevision: number): Promise<void> {
  const fresh = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: true } })
  if (!isOnHold(fresh, fresh.paymentAttempts)) throw new PaymentHoldError(409, 'NOT_ON_HOLD', 'This order\'s payment is not on hold.')
  await assertNoRefundInProgress(prisma, fresh.id)
  if (isPaymentVerified(fresh.paymentStatus)) throw new PaymentHoldError(409, 'PAYMENT_COLLECTED', 'The payment was collected while this was being decided.')
  if (!attemptSetsMatch(examined, fresh.paymentAttempts) || fresh.financialRevision !== examinedRevision) throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', ATTEMPTS_CHANGED_MESSAGE)
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
  // (P3b-1, audit) the payment attempts that "no charge" is decided on: an immutable copy, made BEFORE Stripe is asked about them and compared, under the lock below, with the attempts
  // the order has then. ("accepted" rests on no such examination: it is unchanged.)
  let examined: ReadonlyArray<VerifiedAttempt> | null = null
  // (follow-up P0-A) what the closing of the pages needs: the money situation the examination looked at, the state of the attempts that are only a PaymentIntent, and the proof of every page closed
  let examinedRevision = order.financialRevision
  const intentOnlyStatus = new Map<string, string>()
  let closure = new Map<string, string>()
  if (input.outcome === 'accepted') {
    if (!isPaymentVerified(order.paymentStatus)) {
      throw new PaymentHoldError(409, 'NOT_PAID', 'Only a payment that Stripe shows as collected can be accepted. If nothing was charged, resolve it as "no charge".')
    }
    stripeCheck = 'payment_collected'
  } else {
    if (isPaymentVerified(order.paymentStatus)) {
      throw new PaymentHoldError(409, 'PAYMENT_COLLECTED', 'Stripe shows this payment as collected: it can be accepted, or refunded, but not released as "no charge".')
    }
    examined = snapshotAttempts(order.paymentAttempts)
    examinedRevision = order.financialRevision
    const examinedForClosing: ClosableAttempt[] = order.paymentAttempts.map((attempt) => ({ id: attempt.id, status: attempt.status, stripeSessionId: attempt.stripeSessionId, failureReason: attempt.failureReason }))
    const evidence = await readChargeEvidence(examined, intentOnlyStatus)
    if (evidence.verdict === 'money') {
      throw new PaymentHoldError(409, 'CHARGE_EXISTS', CHARGE_EXISTS_MESSAGE)
    }
    if (evidence.verdict !== 'none' || !synced) {
      // Only an answer that is exactly "none" - every attempt asked, none showed money - lets the decision go on. Anything else is "unknown": Stripe could not be asked, or did not answer for
      // every payment page of the order (the payment sync or the check failed), or a payment attempt has no Stripe identifier and nothing can be asked about it (F02). "No charge" is NOT
      // confirmed, and nothing the administrator declares takes the place of the answer. No decision is taken; if Stripe was the problem the request can be repeated when Stripe answers
      // (F01); an attempt with no identifier needs a person.
      throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', evidence.withoutIdentifier > 0 ? NO_IDENTIFIER_MESSAGE : STRIPE_UNVERIFIABLE_MESSAGE)
    }
    stripeCheck = 'confirmed_no_charge'
    // No money, everything asked: the pages that could still be paid are closed NOW, at the provider, with proof - before anything is written. A page that is complete, or can not be closed or read,
    // keeps the hold exactly as it is.
    await assertNoChargeBasis(order.id, examined, examinedRevision)
    closure = await closePagesWithProof(order.id, examinedForClosing, intentOnlyStatus)
  }

  // 3. Applied in one transaction with the audit record.
  const now = new Date()
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${order.id} FOR UPDATE`
    // (P3b-1, audit) for "no charge" the attempts of the order are locked too - the order first, then its attempts, as every other writer does - so that a writer that does NOT take the
    // lock of the order (the save of a Stripe session id, the closing of an attempt) can not change an attempt between the re-read below and the commit. Short, in this transaction.
    if (input.outcome === 'no_charge') await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "orderId" = ${order.id} FOR UPDATE`
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
    // (P3b-1, audit) "no charge" rests on the examination of the attempts the order had when Stripe was asked. If they are not the attempts it has now - one more, one less, another
    // identifier, another status, one replaced by another with the same count - what was read may not cover them: refused, nothing is written and nothing is asked again here.
    // (This is OUR lock: it says nothing about what happens at Stripe after the last read.)
    if (input.outcome === 'no_charge' && (examined === null || !attemptSetsMatch(examined, fresh.paymentAttempts))) {
      throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', ATTEMPTS_CHANGED_MESSAGE)
    }
    // (follow-up P0-A) The decision rests on the examination AND on the closing of the pages, both made while this transaction was not open. Read again under the lock: the money situation of the order
    // (its financial revision) is the one that was examined, and every attempt whose page could still be paid has its proof. Otherwise nothing is written, and the request can be repeated.
    if (input.outcome === 'no_charge') {
      if (fresh.financialRevision !== examinedRevision) throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', ATTEMPTS_CHANGED_MESSAGE)
      const withoutProof = fresh.paymentAttempts.find((attempt) => needsClosing(attempt) && !closure.has(attempt.id))
      if (withoutProof) throw notClosed(fresh.id, withoutProof.id, 'changed')
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
        const proof = closure.get(attempt.id)
        if (OPEN_ATTEMPT_STATUSES.includes(attempt.status)) {
          // (also a payment page whose payment is "being confirmed": it was closed above, with proof - the customer can no longer complete it)
          const moved = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: attempt.status }, data: { status: 'failed', failureReason: proof ?? 'admin_released' } })
          if (moved.count !== 1) throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', ATTEMPTS_CHANGED_MESSAGE)
        } else if (proof && (attempt.status === 'expired' || attempt.status === 'failed') && isSessionId(attempt.stripeSessionId) && !closingIsProved(attempt.failureReason)) {
          // a row the database held as closed whose page the provider has now shown closed: the proof is written on it; the row keeps its status
          const stamped = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: attempt.status, failureReason: attempt.failureReason }, data: { failureReason: stampProof(proof, attempt.failureReason) } })
          if (stamped.count !== 1) throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', ATTEMPTS_CHANGED_MESSAGE)
        }
      }
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
      metadata: { outcome: input.outcome, reason: entry.reason, stripeCheck, previousStatus: entry.previousStatus, previousPaymentStatus: entry.previousPaymentStatus, previousReviewReason: entry.previousReviewReason, pagesClosed: closure.size } as Prisma.InputJsonValue,
    }, tx)
    return updated
  }, { maxWait: 10_000, timeout: 20_000 })

  // 4. Nothing is asked of Stripe after the commit: the pages that could be paid were closed, with proof, before it (a payment page that is still payable on a cancelled order is what a
  // best-effort closing AFTER the commit left behind: an unreachable provider, a timeout or a crash between two calls, and the page stayed open).
  incrementMetric('payment_hold_resolved_total', 1, { outcome: input.outcome, stripeCheck })
  logEvent({ event: 'payment.hold', level: 'info', outcome: input.outcome, orderId: result.id, message: `${stripeCheck}; pages closed: ${closure.size}` })
  return { order: result, stripeCheck }
}
