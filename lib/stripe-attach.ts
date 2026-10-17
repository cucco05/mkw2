// Linking a Stripe PaymentIntent to an order BY HAND (step 4.6, S4). Pure checks: no database, no network.
//
// The administrator types a `pi_...` identifier. That is a CLAIM, never a proof. The link is made only if everything below holds, and the key one is the association:
//
//   * the PaymentIntent Stripe returns IS the one asked for (identity);
//   * Stripe says the money was collected (`succeeded`), the amount collected equals the amount asked for AND the order's total, in the order's currency;
//   * no other order or payment attempt already uses it;
//   * the order is in a state where a payment can still be attached: not cancelled, nothing under review, not paid, not being paid, no payment page of the hosted
//     checkout (those orders are settled by the payment sync from the Checkout Session, not by hand);
//   * and THE PAYMENT POINTS TO THIS ORDER: Stripe's own record carries `metadata.orderId` equal to this order's id (and, if it carries an `attemptId`, it must be one
//     of this order's). That is the only accepted proof of the association. The same customer, the same e-mail, the same amount, a close date, a matching user: none of
//     them is a substitute, alone or together. A payment that does not point to this order is refused, the order stays unpaid, and there is no administrative bypass.
//
// A manual payment (cash, a transfer...) is a different thing with its own path (`metadata.manualPayment`, lib/orders.ts): this function never produces one.
export type AttachCheck = 'identity' | 'collected' | 'amount' | 'currency' | 'order_association' | 'not_reused' | 'order_state'
export type AttachProblem = { check: AttachCheck; message: string }

export type AttachIntent = {
  id: string
  status: string
  amount: number
  amount_received?: number | null
  currency: string
  metadata?: Record<string, string> | null
}

export type AttachOrder = {
  id: string
  status: string
  paymentStatus: string
  paymentReviewReason: string | null
  totalCents: number
  currency: string
  stripePaymentIntentId: string | null
  paidAt: Date | string | null
  paymentAttempts: ReadonlyArray<{ id: string; status: string }>
}

export type AttachUsage = { orderIds: readonly string[]; attemptIds: readonly string[] }

export function evaluateAttach(input: { requestedId: string; intent: AttachIntent | null; order: AttachOrder; usedElsewhere: AttachUsage }): { ok: boolean; problems: AttachProblem[] } {
  const { requestedId, intent, order, usedElsewhere } = input
  const problems: AttachProblem[] = []
  const add = (check: AttachCheck, message: string) => problems.push({ check, message })

  // ---- the order itself (these are re-checked under the lock before anything is written)
  if (order.status === 'cancelled') add('order_state', 'The order is cancelled.')
  if (order.paymentReviewReason) add('order_state', 'The order\'s payment is under review (resolve the payment hold first).')
  if (['paid', 'free', 'processing', 'succeeded'].includes(String(order.paymentStatus || '').toLowerCase()) || order.paidAt) add('order_state', 'The order is already paid, or a payment is being confirmed.')
  if (order.stripePaymentIntentId && order.stripePaymentIntentId !== requestedId) add('order_state', 'The order is already linked to a different PaymentIntent.')
  if (order.paymentAttempts.length > 0) add('order_state', 'The order has payment pages of the hosted checkout: its payment is settled from them, not by typing a PaymentIntent.')
  if (usedElsewhere.orderIds.length > 0 || usedElsewhere.attemptIds.length > 0) add('not_reused', 'That PaymentIntent is already used by another order or payment attempt.')

  // ---- what Stripe says
  if (!intent) {
    add('identity', 'Stripe did not return that PaymentIntent.')
    return { ok: false, problems }
  }
  if (intent.id !== requestedId) add('identity', 'Stripe returned a different PaymentIntent than the one asked for.')
  if (intent.status !== 'succeeded') add('collected', `The payment is not collected (Stripe status: ${intent.status}).`)
  if (!(intent.amount === order.totalCents && typeof intent.amount_received === 'number' && intent.amount_received === order.totalCents)) {
    add('amount', `The amount does not match: the order is ${order.totalCents}, the payment asked for ${intent.amount} and collected ${typeof intent.amount_received === 'number' ? intent.amount_received : 'nothing readable'} (in the smallest currency unit).`)
  }
  if (String(intent.currency || '').toLowerCase() !== String(order.currency || '').toLowerCase()) add('currency', 'The currency does not match the order\'s.')

  // ---- the association: the payment itself says it is for THIS order
  const metadata = intent.metadata && typeof intent.metadata === 'object' ? intent.metadata : {}
  if (metadata.orderId !== order.id) {
    add('order_association', 'The payment does not carry this order\'s identifier in its Stripe metadata (orderId), so it can not be proven to belong to this order. The customer, the e-mail, the amount or the date are not a substitute.')
  } else if (metadata.attemptId && !order.paymentAttempts.some((attempt) => attempt.id === metadata.attemptId)) {
    add('order_association', 'The payment points to a payment attempt that is not this order\'s.')
  }
  return { ok: problems.length === 0, problems }
}

export const STRIPE_ATTACH_REASON_MIN_LENGTH = 10
