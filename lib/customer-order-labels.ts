// How a customer's orders are described in the customer area (step 4.3). DISPLAY ONLY: it reads an order and chooses words; it changes no state and
// production, analytics and the admin pages keep using lib/order-status.ts as they are. The point is that an order which has not been paid is never shown
// as "Queued", and that an order the customer left unpaid does not clutter the list for ever.
//
// The customer pages are still English (one language per page until the dedicated translation phase), so the words are English and all here:
// translating them later means translating this file. Nothing here reveals WHY a payment is under review (paymentReviewReason stays private).
import { isReprintAwaitingQuote } from '@/lib/reprint'

export type CustomerOrderLike = {
  status: string
  paymentStatus?: string | null
  paymentReviewReason?: string | null
  paidAt?: Date | string | null
  metadata?: unknown
}

export type CustomerOrderKind =
  | 'awaiting_payment'   // created, not paid: the payment page was left or is still open
  | 'confirming'         // the payment is being confirmed
  | 'under_review'       // paid (or payment under check) but a person looks at the order first
  | 'quote_requested'    // a request for a quote (manual quote, reprint): no price yet
  | 'closed_unpaid'      // the payment page expired and the order was closed without any charge
  | 'production'         // everything else: the usual production status

export const CUSTOMER_ORDER_COPY: Record<Exclude<CustomerOrderKind, 'production'>, { label: string; tone: string; message: string }> = {
  awaiting_payment: {
    label: 'Awaiting payment',
    tone: 'border-amber-400/40 text-amber-200 bg-amber-500/10',
    message: 'This order has not been paid yet, so nothing is being printed. If you left the payment page, go back to your cart to try again. If you have already paid, wait a moment: the confirmation can take a little while.',
  },
  confirming: {
    label: 'Confirming payment',
    tone: 'border-sky-400/40 text-sky-200 bg-sky-500/10',
    message: 'We are confirming your payment. This usually takes a few seconds. You do not need to do anything.',
  },
  under_review: {
    label: 'Under review',
    tone: 'border-amber-400/40 text-amber-200 bg-amber-500/10',
    message: 'We are checking a few details of this order before printing. You do not need to do anything: we will contact you if we need something.',
  },
  quote_requested: {
    label: 'Quote requested',
    tone: 'border-sky-400/40 text-sky-200 bg-sky-500/10',
    message: 'We will review this request and send you a quote. Nothing is charged and nothing is printed until you accept it.',
  },
  closed_unpaid: {
    label: 'Payment not completed',
    tone: 'border-white/20 text-slate-300 bg-white/5',
    message: 'The payment page expired and this order was closed. Nothing was charged. You can order again from your cart.',
  },
}

const isPaid = (paymentStatus?: string | null) => paymentStatus === 'paid' || paymentStatus === 'free'

function cancellationReason(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const cancellation = (metadata as Record<string, unknown>).cancellation
  if (!cancellation || typeof cancellation !== 'object' || Array.isArray(cancellation)) return null
  const reason = (cancellation as Record<string, unknown>).reason
  return typeof reason === 'string' ? reason : null
}

// An order the customer left unpaid until the payment page expired: nothing was charged, nobody needs to look at it. Kept in the history, out of the
// main list. An order with ANY money or any doubt (a late payment, an amount to check) is never in this group.
export function isAbandonedExpiredOrder(order: CustomerOrderLike): boolean {
  return order.status === 'cancelled'
    && cancellationReason(order.metadata) === 'checkout_expired'
    && !order.paidAt
    && !order.paymentReviewReason
    && !isPaid(order.paymentStatus)
    && order.paymentStatus !== 'processing'
}

export function describeCustomerOrder(order: CustomerOrderLike): CustomerOrderKind {
  if (isReprintAwaitingQuote({ metadata: order.metadata, paymentStatus: order.paymentStatus })) return 'quote_requested'
  const paid = isPaid(order.paymentStatus)
  if (order.status === 'cancelled') {
    if (paid || order.paymentReviewReason) return 'under_review' // money after a cancellation: a person decides
    return isAbandonedExpiredOrder(order) ? 'closed_unpaid' : 'production' // other cancellations keep the usual "Cancelled"
  }
  if (paid) return order.paymentReviewReason || order.status === 'awaiting_review' ? 'under_review' : 'production'
  if (order.paymentReviewReason) return 'under_review'
  if (order.status === 'awaiting_payment') return order.paymentStatus === 'processing' ? 'confirming' : 'awaiting_payment'
  return 'production'
}

// The main list shows everything except the abandoned-and-expired orders, which go to the history below it.
export function splitOrdersForCustomer<T extends CustomerOrderLike>(orders: readonly T[]): { current: T[]; history: T[] } {
  const current: T[] = []
  const history: T[] = []
  for (const order of orders) (isAbandonedExpiredOrder(order) ? history : current).push(order)
  return { current, history }
}
