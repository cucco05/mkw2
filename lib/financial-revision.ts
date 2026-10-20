// The financial revision of an order (step 4.6, S6a, P2b) - which changes of an order count as a change of its MONEY SITUATION, written down once.
//
// `PrintOrder.financialRevision` is a counter that only goes UP. Every writer that changes one of the facts below increases it IN THE SAME UPDATE (and under the row lock the
// writer already holds), through `withFinancialRevision`. An administrator's authorization to produce records the revision the order had when it was given
// (lib/order-payment-policy.ts) and is valid only while the order still has that revision. So an authorization given for one money situation can not outlive it, and - because
// the counter never comes back down - a refund that fails afterwards, a dispute that is resolved or a total that is put back does not bring an old authorization to life:
// a NEW decision, with a written reason, is needed (this is the "ABA" problem of comparing values instead of counting changes).
//
// The list is CLOSED and numbered (E1-E14); the changes that do NOT count are listed too (N1-N10) with the reason. `tests/production-release-guards.test.ts` (G11) makes every
// writer of an order use this module, and `tests/production-release-facts-oracle.test.ts` fails if the release decision starts to read a fact that is in neither list.
// Pure: no database, no network. Types only from Prisma.
import type { Prisma } from '@prisma/client'

export type FinancialEvent = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9' | 'E10' | 'E11' | 'E12' | 'E13' | 'E14'

export const FINANCIAL_EVENT_TEXT: Record<FinancialEvent, string> = {
  E1: 'the payment status or the payment date changes (any direction)',
  E2: 'the reason a person has to look at the payment is set, changed or removed',
  E3: 'the refunded amount changes (any direction)',
  E4: 'a total, subtotal, shipping, tax, discount or the currency changes',
  E5: 'the Stripe PaymentIntent or invoice linked to the order changes',
  E6: 'the payment method changes (it decides which kind of authorization is allowed)',
  E7: 'a Stripe proof in the metadata changes (payment status, PaymentIntent, invoice status, dispute)',
  E8: 'the PayPal proof in the metadata changes',
  E9: 'a payment attested by an administrator is registered or varied',
  E10: 'a new entry in the payment review log',
  E11: 'a new entry in the payment hold resolutions',
  E12: 'a payment attempt enters or leaves processing / paid / mismatch, or its amount received or PaymentIntent changes',
  E13: 'a refund operation of the order changes state',
  E14: 'the order is cancelled or re-opened',
}

// ---- E1-E6, E14: columns --------------------------------------------------------------------------------------------------------------------------------------
export const FINANCIAL_COLUMN_EVENTS = {
  paymentStatus: 'E1', paidAt: 'E1',
  paymentReviewReason: 'E2',
  refundedCents: 'E3',
  totalCents: 'E4', subtotalCents: 'E4', shippingCents: 'E4', taxCents: 'E4', discountPercent: 'E4', currency: 'E4',
  stripePaymentIntentId: 'E5', stripeInvoiceId: 'E5',
  paymentMethod: 'E6',
} as const satisfies Record<string, FinancialEvent>
export type FinancialColumn = keyof typeof FINANCIAL_COLUMN_EVENTS
export const FINANCIAL_COLUMNS = Object.keys(FINANCIAL_COLUMN_EVENTS) as FinancialColumn[]

// ---- E7-E11: keys of the metadata ------------------------------------------------------------------------------------------------------------------------------
export const FINANCIAL_METADATA_PATHS: ReadonlyArray<{ event: FinancialEvent; path: readonly string[] }> = [
  { event: 'E7', path: ['stripe', 'paymentStatus'] },
  { event: 'E7', path: ['stripe', 'paymentIntentId'] },
  { event: 'E7', path: ['stripe', 'dispute'] },
  { event: 'E7', path: ['stripeInvoice', 'paymentStatus'] },
  { event: 'E8', path: ['paypal', 'captureId'] },
  { event: 'E8', path: ['paypal', 'paymentStatus'] },
  { event: 'E9', path: ['manualPayment'] },
  { event: 'E10', path: ['paymentReview'] },
  { event: 'E11', path: ['paymentHoldResolution'] },
]

// E14: the order status crosses the cancellation boundary (either way).
export function isCancelledStatus(status: unknown) {
  return status === 'cancelled' || status === 'canceled'
}

// E12: payment attempts. Opening, expiring or failing a payment PAGE without money (N3) is not an event.
export const FINANCIAL_ATTEMPT_STATUSES: readonly string[] = ['processing', 'paid', 'mismatch']
export function attemptChangeIsFinancial(
  prev: { status: string; amountReceivedCents?: number | null; stripePaymentIntentId?: string | null },
  patch: { status?: string; amountReceivedCents?: number | null; stripePaymentIntentId?: string | null },
): boolean {
  if (patch.status !== undefined && patch.status !== prev.status && (FINANCIAL_ATTEMPT_STATUSES.includes(prev.status) || FINANCIAL_ATTEMPT_STATUSES.includes(patch.status))) return true
  if (patch.amountReceivedCents !== undefined && (patch.amountReceivedCents ?? null) !== (prev.amountReceivedCents ?? null)) return true
  if (patch.stripePaymentIntentId !== undefined && (patch.stripePaymentIntentId ?? null) !== (prev.stripePaymentIntentId ?? null)) return true
  return false
}

// ---- what does NOT count, and why --------------------------------------------------------------------------------------------------------------------------------
export const NON_EVENTS: Record<string, string> = {
  N1: 'stripeChargeId, stripeCustomerId, receiptUrl, receiptStatus, hostedInvoiceUrl, invoicePdfUrl: the release decision does not read them',
  N2: 'paymentSyncLeaseId, paymentSyncLeaseUntil, paymentSyncedAt: bookkeeping of the payment synchronisation',
  N3: 'payment attempts creating -> open, creating/open -> expired, creating/open -> failed WITHOUT money: availability of the page (an open page blocks by itself, and a customer must not be able to cancel an administrator\'s decision by opening a page)',
  N4: 'production statuses (queued, printing, post_process, shipped, completed, failed) and printer assignment',
  N5: 'markers of the production flows in the metadata (printLabSubmissions, lastPrintLabSubmission, externalEffects, stockworks*)',
  N6: 'reprint, orgApproval, adminPricing, adminFreeCheckout: not read by the decision (their effect on the amounts goes through E4)',
  N7: 'guestAccess*, guestSessionHash',
  N8: 'shippingAddress, customerEmail, customerName, notes',
  N9: 'order lines that do not change the amounts (material, colour, notes)',
  N10: 'the grant of the authorization itself (it records the revision, it does not increase it)',
}

// ---- the helper every writer of an order uses --------------------------------------------------------------------------------------------------------------------
export type FinancialPrev = Partial<Record<FinancialColumn, unknown>> & { status?: unknown; metadata?: unknown }
// The Prisma selection of what a writer must read (under its row lock) to tell `withFinancialRevision` what the order was. A test keeps it in step with the registry.
export const FINANCIAL_PREV_SELECT = {
  status: true, paymentStatus: true, paidAt: true, paymentReviewReason: true, refundedCents: true, totalCents: true, subtotalCents: true, shippingCents: true,
  taxCents: true, discountPercent: true, currency: true, stripePaymentIntentId: true, stripeInvoiceId: true, paymentMethod: true, metadata: true,
} as const
export type FinancialExtras = {
  // E12: a payment attempt of the order changes in a financial way (use `attemptChangeIsFinancial`)
  attempt?: boolean
  // E13: a refund operation of the order changes state
  refundOperation?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value instanceof Date) return `date:${value.getTime()}`
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}
// A Prisma column write can be a plain value or an operation ({ set } / { increment } / ...).
function columnWriteChanges(previous: unknown, written: unknown): boolean {
  if (written === undefined) return false
  if (isRecord(written) && !(written instanceof Date)) {
    if ('set' in written) return stable(written.set) !== stable(previous)
    if ('increment' in written) return Number(written.increment) !== 0
    if ('decrement' in written) return Number(written.decrement) !== 0
    return true // multiply / divide / anything else: counted, never missed
  }
  return stable(written) !== stable(previous)
}
function metadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

// The events a write would cause: `prev` is the order as the writer read it UNDER ITS LOCK, `data` is what it is about to write.
// A column the writer writes but did not tell us the previous value of counts as changed (never a missed event).
export function financialEvents(prev: FinancialPrev, data: Record<string, unknown>, extras: FinancialExtras = {}): FinancialEvent[] {
  const events = new Set<FinancialEvent>()
  for (const column of FINANCIAL_COLUMNS) {
    if (!(column in data)) continue
    const previous = column in prev ? prev[column] : Symbol('unknown previous value')
    if (columnWriteChanges(previous, data[column])) events.add(FINANCIAL_COLUMN_EVENTS[column])
  }
  if ('status' in data && data.status !== undefined) {
    const next = isRecord(data.status) && 'set' in data.status ? data.status.set : data.status
    // a writer that writes the status without telling us the previous one counts as crossing the boundary (never a missed re-opening)
    if (!('status' in prev) || isCancelledStatus(next) !== isCancelledStatus(prev.status)) events.add('E14')
  }
  if ('metadata' in data && data.metadata !== undefined) {
    // null / Prisma.JsonNull / DbNull wipe the metadata: every financial key that was there is gone
    const nextMetadata = metadataRecord(data.metadata)
    const previousMetadata = metadataRecord(prev.metadata)
    for (const { event, path } of FINANCIAL_METADATA_PATHS) {
      if (stable(readPath(previousMetadata, path)) !== stable(readPath(nextMetadata, path))) events.add(event)
    }
  }
  if (extras.attempt) events.add('E12')
  if (extras.refundOperation) events.add('E13')
  return [...events].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
}

// Adds `financialRevision: { increment: 1 }` to the data of an order UPDATE when the write changes a financial fact. Nothing else in the code assigns the revision.
export function withFinancialRevision<T extends Record<string, unknown>>(prev: FinancialPrev, data: T, extras: FinancialExtras = {}): T & { financialRevision?: Prisma.IntFieldUpdateOperationsInput } {
  if ('financialRevision' in data) throw new Error('financialRevision is never assigned: it only goes up, through withFinancialRevision')
  if (financialEvents(prev, data, extras).length === 0) return data
  return { ...data, financialRevision: { increment: 1 } }
}

// ---- classification of what the release decision READS (used by the oracle test and by the documentation) -------------------------------------------------------------
export type FactClass = { kind: 'event' | 'non_event' | 'authorization' | 'revision' | 'container'; code: string }
const FACT_PATTERNS: ReadonlyArray<{ pattern: RegExp; cls: FactClass }> = [
  { pattern: /^paymentStatus$/, cls: { kind: 'event', code: 'E1' } },
  { pattern: /^paidAt$/, cls: { kind: 'event', code: 'E1' } },
  { pattern: /^paymentReviewReason$/, cls: { kind: 'event', code: 'E2' } },
  { pattern: /^refundedCents$/, cls: { kind: 'event', code: 'E3' } },
  { pattern: /^(totalCents|currency)$/, cls: { kind: 'event', code: 'E4' } },
  { pattern: /^(stripePaymentIntentId|stripeInvoiceId)$/, cls: { kind: 'event', code: 'E5' } },
  { pattern: /^paymentMethod$/, cls: { kind: 'event', code: 'E6' } },
  { pattern: /^metadata\.stripe\.(paymentStatus|paymentIntentId|dispute(\..+)?)$/, cls: { kind: 'event', code: 'E7' } },
  { pattern: /^metadata\.stripeInvoice\.paymentStatus$/, cls: { kind: 'event', code: 'E7' } },
  { pattern: /^metadata\.paypal\.(captureId|paymentStatus)$/, cls: { kind: 'event', code: 'E8' } },
  { pattern: /^metadata\.manualPayment\.[A-Za-z]+$/, cls: { kind: 'event', code: 'E9' } },
  { pattern: /^metadata\.paymentReview(\.length|\[\]\.reason)$/, cls: { kind: 'event', code: 'E10' } },
  { pattern: /^metadata\.paymentHoldResolution(\[\]\.[A-Za-z]+)?$/, cls: { kind: 'event', code: 'E11' } },
  // `reprint` is read for the WORDING of a refusal only (a free reprint needs a reason): the verdict does not depend on it
  { pattern: /^metadata\.reprint(\..+)?$/, cls: { kind: 'non_event', code: 'N6' } },
  { pattern: /^paymentAttempts(\.length|\[\]\.status)$/, cls: { kind: 'event', code: 'E12' } },
  { pattern: /^paymentAttempts\[\]\.expiresAt$/, cls: { kind: 'non_event', code: 'N3' } },
  { pattern: /^refundOperations(\.length|\[\]\.(status|appliedAt))$/, cls: { kind: 'event', code: 'E13' } },
  { pattern: /^metadata\.productionAuthorization\.[A-Za-z.]+$/, cls: { kind: 'authorization', code: 'N10' } },
  { pattern: /^financialRevision$/, cls: { kind: 'revision', code: 'revision' } },
  { pattern: /^(metadata|metadata\.(stripe|stripeInvoice|paypal|manualPayment|paymentReview|paymentHoldResolution|productionAuthorization)|paymentAttempts|refundOperations)$/, cls: { kind: 'container', code: 'container' } },
  // the element of a list is read before its fields
  { pattern: /^(paymentAttempts|refundOperations|metadata\.paymentReview|metadata\.paymentHoldResolution)\[\]$/, cls: { kind: 'container', code: 'container' } },
]
export function classifyFactPath(path: string): FactClass | null {
  for (const { pattern, cls } of FACT_PATTERNS) if (pattern.test(path)) return cls
  return null
}
