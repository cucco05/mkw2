// What a person may learn about an order from the payment pages (step 4.1), and who may learn it.
//
// WHO: only the signed-in owner of the order, or the guest whose browser holds the order's access token (lib/guest-order-access.ts,
// checked against the hash and the expiry stored on THAT order). Knowing an order id - from the address bar, a screenshot, a
// forwarded link - is not enough, and neither is being able to open the confirmation page. Everyone else gets the same answer as
// for an order that does not exist.
// WHAT: an order number, one of five states, the total and its currency, and when to ask again. Never names, e-mails, addresses,
// files, Stripe identifiers, review reasons or anything from the order's metadata.
// WHERE the truth comes from: always the server. The browser can say "I am back from the payment page" (it only softens a
// wording, see derivePublicState); it can never say "paid".
import { findGuestToken, verifyGuestAccess } from '@/lib/guest-order-access'

// Same shape the guest cookie accepts for an order id.
export const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export type PublicCheckoutState =
  | 'pending'      // not paid (yet); the payment page can be opened again
  | 'confirming'   // the customer paid or is paying; we are waiting for the confirmation
  | 'paid'         // payment verified
  | 'attention'    // payment received/verified but a person looks at the order first (nothing else is said)
  | 'canceled'     // the payment page expired and the order was closed

export type StatusOrder = {
  id: string
  userId: string | null
  orderNumber: number
  status: string
  paymentStatus: string
  paymentReviewReason: string | null
  totalCents: number
  currency: string
  paymentSyncedAt: Date | null
  guestAccessTokenHash: string | null
  guestAccessExpiresAt: Date | null
}
export type StatusAttempt = { id: string; status: string; stripeSessionId: string | null }

export type PublicOrderStatus = {
  orderNumber: number
  state: PublicCheckoutState
  totalCents: number
  currency: string
  // true when nothing more will change by itself from the customer's point of view
  final: boolean
  // milliseconds until the page should ask again, or null when it should not
  pollAfterMs: number | null
}

const isPaid = (paymentStatus: string) => paymentStatus === 'paid' || paymentStatus === 'free'

export function canViewOrder(order: StatusOrder, viewerId: string | null, guestCookie: string | null | undefined, now: Date = new Date()): boolean {
  if (viewerId && order.userId && order.userId === viewerId) return true
  // a guest order only (verifyGuestAccess is false for any order that belongs to an account)
  return verifyGuestAccess(order, findGuestToken(guestCookie, order.id), now)
}

// `attempt` is the newest payment attempt. `returned`: the browser says it comes back from the payment page; `unverified`: we tried
// to ask Stripe and could not. Together they only turn "not paid" into "confirming" (we cannot tell yet), never into "paid".
export function derivePublicState(
  order: Pick<StatusOrder, 'status' | 'paymentStatus' | 'paymentReviewReason'>,
  attempt: Pick<StatusAttempt, 'status'> | null,
  opts: { returned?: boolean; unverified?: boolean } = {},
): PublicCheckoutState {
  const paid = isPaid(order.paymentStatus)
  if (order.status === 'cancelled') return paid ? 'attention' : 'canceled' // money after a cancellation: a person decides
  if (paid) return order.paymentReviewReason || order.status === 'awaiting_review' ? 'attention' : 'paid'
  if (order.paymentReviewReason || attempt?.status === 'mismatch') return 'attention'
  if (order.paymentStatus === 'processing' || attempt?.status === 'processing') return 'confirming'
  if (opts.returned && opts.unverified) return 'confirming'
  return 'pending'
}

export function toPublicStatus(order: StatusOrder, state: PublicCheckoutState): PublicOrderStatus {
  return {
    orderNumber: order.orderNumber,
    state,
    totalCents: order.totalCents,
    currency: order.currency,
    final: state === 'paid' || state === 'attention' || state === 'canceled',
    pollAfterMs: state === 'confirming' ? 2500 : null,
  }
}

// Should this request ask Stripe? Only for an order still waiting for its payment, with a payment page that could have been paid,
// and not when the state we hold was read from Stripe a moment ago (a webhook, or the previous request of this page).
export function refreshableAttempt<T extends StatusAttempt>(
  order: Pick<StatusOrder, 'status' | 'paymentStatus' | 'paymentReviewReason' | 'paymentSyncedAt'>,
  attemptsNewestFirst: readonly T[],
  now: Date,
  minIntervalMs: number,
): T | null {
  if (order.status !== 'awaiting_payment' || isPaid(order.paymentStatus) || order.paymentReviewReason) return null
  if (order.paymentSyncedAt && now.getTime() - order.paymentSyncedAt.getTime() < minIntervalMs) return null
  return attemptsNewestFirst.find((attempt) => attempt.stripeSessionId && (attempt.status === 'open' || attempt.status === 'processing')) ?? null
}
