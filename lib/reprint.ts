// Reprints (S5, step 4.0a). Pure rules, no database: used by the order creation (lib/orders.ts), the customer pages and the tests.
//
// A reprint REQUESTED BY THE CUSTOMER is a request for a new quote, never an order that can go to production by itself:
//  * it starts in `awaiting_review`, payment method/status `quote` (not a verified payment, so S5 keeps it out of production);
//  * it inherits NO payment state, NO price and NO production authorization from the original order (a total of 0 means
//    "not priced yet", which is why `metadata.reprint.priceStatus` says so and the pages show "price to be quoted", never a free order);
//  * a free reprint (a production defect, for example) is a separate, explicit and recorded decision of an administrator
//    (checkManualTransition: `authorizeUnpaid` with a written reason); a paid one is priced by an administrator (admin order creation).
import { isProductionEligible, isReprintMetadata } from '@/lib/order-payment-policy'

// Only an order that was actually produced (or failed in production) can be reprinted.
export const REPRINT_SOURCE_STATUSES: readonly string[] = ['shipped', 'completed', 'failed', 'post_process', 'ready']
// A reprint request in one of these states is finished: the customer may ask again.
export const REPRINT_CLOSED_STATUSES: readonly string[] = ['cancelled', 'completed', 'shipped', 'failed']

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function canRequestReprint(order: { status: string; paymentStatus?: string | null; metadata?: unknown }) {
  return REPRINT_SOURCE_STATUSES.includes(order.status) && isProductionEligible(order)
}

export function isReprintOrder(order: { metadata?: unknown; reprintOfId?: string | null }) {
  return Boolean(order.reprintOfId) || isReprintMetadata(order.metadata)
}

// A reprint request that has no price yet: the total (0) must never be shown or read as "free".
// Also true for a request for a manual quote (lib/manual-quote.ts): same rule, same wording on the pages.
export function isReprintAwaitingQuote(order: { metadata?: unknown; paymentStatus?: string | null }) {
  const meta = asRecord(order.metadata)
  const toBeQuoted = asRecord(meta.reprint).priceStatus === 'to_be_quoted' || asRecord(meta.manualQuote).priceStatus === 'to_be_quoted'
  return toBeQuoted && order.paymentStatus === 'quote'
}

export function findOpenReprint<T extends { status: string }>(reprints: readonly T[]): T | null {
  return reprints.find((reprint) => !REPRINT_CLOSED_STATUSES.includes(reprint.status)) ?? null
}

export class ReprintNotAllowedError extends Error {
  constructor(readonly code: 'ORDER_NOT_FOUND' | 'REPRINT_NOT_ALLOWED', message: string) {
    super(message)
    this.name = 'ReprintNotAllowedError'
  }
}
