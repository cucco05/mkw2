// Which orders an administrator must NOT edit or delete (step 4.6, S3 / D5 / D8), and the written reason that every critical admin action needs.
//
// An order with PROOF OF A STRIPE PAYMENT - a payment attempt, a Stripe payment or charge id, a recorded payment date, a refund, Stripe data in its metadata,
// or a payment that is on hold - is a record of money that really moved (or may have moved). Its lines and totals are what Stripe was asked to charge: changing
// or deleting them would make the books disagree with the bank, so no administrator (staff included) can do it from these routes.
// Three things are kept DISTINCT and none stands in for another:
//   1. a payment VERIFIED with Stripe  -> written only by the payment verification (lib/payment-sync.ts): `paidAt`, a payment attempt `paid`, `metadata.stripe`;
//   2. a payment REGISTERED BY AN ADMINISTRATOR (cash, bank transfer, ...) -> `metadata.manualPayment = { by, at, reason, method }`; never `paidAt`, never a
//      Stripe id, never `metadata.stripe` (those cannot come from a typed identifier);
//   3. an EXCEPTIONAL AUTHORISATION to produce -> `metadata.productionAuthorization` (lib/order-payment-policy.ts).
import type { Prisma, PrismaClient } from '@prisma/client'

export const ADMIN_ACTION_REASON_MIN_LENGTH = 10
export const ADMIN_ACTION_REASON_MAX_LENGTH = 300

export type EvidenceReason = 'stripe_attempts' | 'stripe_payment_intent' | 'stripe_charge' | 'paid_at' | 'refund' | 'payment_review' | 'stripe_metadata' | 'invoice' | 'refund_operation'

type EvidenceOrder = {
  stripePaymentIntentId?: string | null
  stripeChargeId?: string | null
  stripeInvoiceId?: string | null
  paidAt?: Date | string | null
  refundedCents?: number | null
  paymentReviewReason?: string | null
  metadata?: unknown
}

function isNonEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0
}

// Pure: the proofs an order row (plus the number of its payment attempts and of its refund operations) carries. (step 4.6, S6) A refund the application requested is a
// record of money that moved or may have moved: an order that has one is not edited or deleted from here, whatever state the refund is in.
export function stripeEvidenceReasons(order: EvidenceOrder, attemptCount: number, refundOperationCount = 0): EvidenceReason[] {
  const reasons: EvidenceReason[] = []
  if (attemptCount > 0) reasons.push('stripe_attempts')
  if (order.stripePaymentIntentId) reasons.push('stripe_payment_intent')
  if (order.stripeChargeId) reasons.push('stripe_charge')
  if (order.stripeInvoiceId) reasons.push('invoice')
  if (order.paidAt) reasons.push('paid_at')
  if ((order.refundedCents ?? 0) > 0) reasons.push('refund')
  if (order.paymentReviewReason) reasons.push('payment_review')
  const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? (order.metadata as Record<string, unknown>) : {}
  if (isNonEmptyObject(metadata.stripe) || isNonEmptyObject(metadata.stripeInvoice)) reasons.push('stripe_metadata')
  if (refundOperationCount > 0) reasons.push('refund_operation')
  return reasons
}

type Db = PrismaClient | Prisma.TransactionClient

// The proofs of the order with this id (null = the order does not exist).
export async function loadStripeEvidence(db: Db, orderId: string): Promise<{ reasons: EvidenceReason[] } | null> {
  const order = await db.printOrder.findUnique({
    where: { id: orderId },
    select: { stripePaymentIntentId: true, stripeChargeId: true, stripeInvoiceId: true, paidAt: true, refundedCents: true, paymentReviewReason: true, metadata: true, _count: { select: { paymentAttempts: true, refundOperations: true } } },
  })
  if (!order) return null
  return { reasons: stripeEvidenceReasons(order, order._count.paymentAttempts, order._count.refundOperations) }
}

export class AdminActionError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: Record<string, unknown>) { super(message) }
}

export function requireAdminReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (reason.length < ADMIN_ACTION_REASON_MIN_LENGTH) {
    throw new AdminActionError('REASON_REQUIRED', `A written reason of at least ${ADMIN_ACTION_REASON_MIN_LENGTH} characters is required.`, 400)
  }
  if (reason.length > ADMIN_ACTION_REASON_MAX_LENGTH) {
    throw new AdminActionError('REASON_TOO_LONG', `The reason can be at most ${ADMIN_ACTION_REASON_MAX_LENGTH} characters.`, 400)
  }
  return reason
}

// Throws the refusal (409) when the order carries proof of a Stripe payment.
export function assertNoStripeEvidence(evidence: { reasons: EvidenceReason[] }) {
  if (evidence.reasons.length > 0) {
    throw new AdminActionError(
      'ORDER_HAS_PAYMENT_EVIDENCE',
      'This order has a Stripe payment (or one on hold) recorded against it: its lines and totals can no longer be changed and it cannot be deleted from here.',
      409,
      { reasons: evidence.reasons },
    )
  }
}
