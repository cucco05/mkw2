// Payment-method and production-entry policy for orders (S5). One place, used by every code path that
// creates an order or changes its status.
//
// 1. Which payment methods a person may use is decided on the SERVER from the session, never from the request:
//      guests and customers: card (Stripe) or a quote request (no payment, no production)
//      administrators:       everything, including cash / invoice / purchase order / no-charge
// 2. An order enters PRODUCTION only if its payment is VERIFIED or an administrator explicitly authorized it.
//    "Verified" is strict: `paid` (Stripe confirmed the money) or `free` (a no-charge order created by an administrator).
//    Pending, processing, authorized-only, failed, quote... are NOT verified.
//    The authorization is recorded in `metadata.productionAuthorization` ({ authorized, by, at, reason, kind, financialRevision, ... }).
// 3. (step 4.6, S4) WHETHER an order may be assigned to a printer, sent to PrintLab, started or advanced is decided by ONE pure function, `releaseDecision`, and
//    only by it. It looks at everything that matters for money - the verified payment AND the proof of it that the server keeps, a payment under review, a
//    payment being confirmed, a Stripe payment page still open - and an administrator's authorization never overrides a payment that is held, being confirmed
//    or still active. Every code path that has an effect calls it at the moment of the effect, under a lock on the order (lib/production-release.ts).
// 4. (step 4.6, S6) The same function also knows the REFUNDS: a refund of the order's own Stripe payment takes the payment proof away (it can only be released again by
//    a new, explicit authorization), a refund that was requested from the application and is not over blocks everything (nothing overrides it), and an authorization
//    is valid only for the money situation it was given for (lib/financial-revision.ts).
import type { Prisma } from '@prisma/client'
import { isPaymentPromise, normalizePaymentStatus } from '@/lib/orderworks-status'
import { describeReviewReason } from '@/lib/payment-review-reasons'

export type PaymentMethodKey = 'card' | 'paypal' | 'cash' | 'invoice' | 'po' | 'quote' | 'comped'
export type CheckoutRole = 'guest' | 'customer' | 'staff' | 'admin'

// ---- Who may use which payment method --------------------------------------------------------------
const PUBLIC_PAYMENT_METHODS: readonly PaymentMethodKey[] = ['card', 'quote']
const ADMIN_PAYMENT_METHODS: readonly PaymentMethodKey[] = ['card', 'quote', 'cash', 'invoice', 'po', 'comped', 'paypal']

export function checkoutRoleOf(user: { isAdmin?: boolean | null; role?: string | null } | null | undefined): CheckoutRole {
  if (!user) return 'guest'
  if (user.isAdmin || user.role === 'admin') return 'admin'
  if (user.role === 'staff') return 'staff'
  return 'customer'
}

export function allowedPaymentMethods(role: CheckoutRole): readonly PaymentMethodKey[] {
  return role === 'admin' ? ADMIN_PAYMENT_METHODS : PUBLIC_PAYMENT_METHODS
}

export function isPaymentMethodAllowed(method: string, role: CheckoutRole) {
  return (allowedPaymentMethods(role) as readonly string[]).includes(method)
}

// ---- Production entry -------------------------------------------------------------------------------
// Statuses that mean "this order is in the production pipeline" (legacy aliases included).
const PRODUCTION_STATUSES = new Set(['queued', 'printing', 'post_process', 'shipped', 'completed', 'in_production', 'ready'])

export function isProductionStatus(status: string | null | undefined) {
  return PRODUCTION_STATUSES.has(String(status || ''))
}

export function isPaymentVerified(paymentStatus: string | null | undefined) {
  const normalized = normalizePaymentStatus(paymentStatus)
  return normalized === 'paid' || normalized === 'free'
}

type Json = Record<string, unknown>
function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// ---- The administrator's authorization to produce (step 4.6, S6) ---------------------------------------------------------------------------------------------
// Two kinds, never interchangeable: an EXCEPTIONAL authorization (produce although nothing is paid) and a COMMERCIAL CREDIT (an invoice / purchase-order order produced on
// credit: the amount still due is part of the record and is shown wherever the release is shown). A credit is not a payment: the payment status stays what it is.
export type AuthorizationKind = 'exceptional' | 'commercial_credit'
export type CommercialCredit = { method: string; reference: string | null; amountDueCents: number; currency: string; dueAt: string | null }
export type ProductionAuthorization = {
  by: string
  at: string
  reason: string | null
  kind: AuthorizationKind
  // the financial revision (lib/financial-revision.ts) the order had when this was given; null = recorded before S6, or unreadable: the authorization is then NOT valid
  financialRevision: number | null
  credit: CommercialCredit | null
}
// Why an authorization that exists is not valid any more
export type AuthorizationStale = 'revision_changed' | 'no_revision'

function readCredit(raw: unknown): CommercialCredit | null {
  const credit = asRecord(raw)
  const amount = credit.amountDueCents
  if (!nonEmpty(credit.method) || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || !nonEmpty(credit.currency)) return null
  return {
    method: credit.method, reference: nonEmpty(credit.reference) ? credit.reference : null, amountDueCents: amount, currency: credit.currency,
    dueAt: nonEmpty(credit.dueAt) ? credit.dueAt : null,
  }
}

export function getProductionAuthorization(metadata: unknown): ProductionAuthorization | null {
  const raw = asRecord(asRecord(metadata).productionAuthorization)
  if (raw.authorized !== true || typeof raw.by !== 'string' || !raw.by) return null
  const kind: AuthorizationKind = raw.kind === 'commercial_credit' ? 'commercial_credit' : 'exceptional'
  const credit = kind === 'commercial_credit' ? readCredit(raw.credit) : null
  // a commercial credit without the amount still due is not an authorization: the amount due must always be visible
  if (kind === 'commercial_credit' && !credit) return null
  const revision = raw.financialRevision
  return {
    by: raw.by,
    at: typeof raw.at === 'string' ? raw.at : '',
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    kind,
    financialRevision: typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : null,
    credit,
  }
}

// An authorization is valid only while the order still has the financial revision it had when the authorization was given. A missing, non-integer or negative revision is
// "no revision" (an authorization from before S6 or a forged one): not valid.
export function authorizationStaleness(authorization: ProductionAuthorization, orderRevision: number | null | undefined): AuthorizationStale | null {
  if (authorization.financialRevision === null) return 'no_revision'
  if (typeof orderRevision !== 'number' || !Number.isInteger(orderRevision) || orderRevision < 0) return 'revision_changed'
  return authorization.financialRevision === orderRevision ? null : 'revision_changed'
}

// Metadata keys written ONLY by our own code (administrator routes, payment verification, reprint requests, the production flows). Whatever an outside
// service or a customer sends as "metadata" must never be able to set them: `productionAuthorization`, for one, makes an order releasable (releaseDecision),
// and the markers of what was already sent to PrintLab / taken out of stock keep a job from being sent, or material from being consumed, twice.
export const RESERVED_ORDER_METADATA_KEYS: readonly string[] = [
  'productionAuthorization', 'productionAuthorizedWithoutPayment', 'paymentReview', 'postPayment', 'cancellation', 'reprint',
  'checkout', 'stripe', 'stripeInvoice', 'artifacts', 'adminFreeCheckout',
  // step 4.6: what an administrator registered (a payment taken outside Stripe; a price set below the shop's minimum) - never writable by an outside service
  'manualPayment', 'adminPricing',
  // step 4.6, S4: a PayPal capture the server verified (it counts as proof of payment), and the records of the production flows
  'paypal', 'printLabSubmissions', 'lastPrintLabSubmission', 'stockworksConsumedAt', 'stockworksConsumption', 'stockworksConsumptionTrigger', 'stockworksConsumptionSource',
  'externalEffects', 'orgApproval',
  // step 4.6, S6: the revision of the money situation and the record of the payment hold resolutions
  'financialRevision', 'paymentHoldResolution', 'noChargeDecision',
]
// step 4.6, S6 (F21): the ids the SERVER writes into the metadata of an order made from a job - the link to the job, the payment identifier of the job, its source. An outside
// sender must not be able to point an order at another job or at someone else's payment (`payment-sync` finds the orders of a PaymentIntent by this metadata too).
export const ORDER_LINK_METADATA_KEYS: readonly string[] = ['paymentIntentId', 'source', 'jobFormId', 'orderId']

// What an outside sender sends as "metadata", without the keys only our own code writes. `keepLinks`: the caller has put its OWN link keys in and only wants the proofs and
// markers stripped; the server's values are always written AFTER whatever came from outside.
export function sanitizeExternalMetadata(value: unknown, opts: { keepLinks?: boolean } = {}): Record<string, unknown> {
  const input = asRecord(value)
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(input)) {
    if (RESERVED_ORDER_METADATA_KEYS.includes(key)) continue
    if (!opts.keepLinks && ORDER_LINK_METADATA_KEYS.includes(key)) continue
    out[key] = entry
  }
  return out
}

export type OrderPaymentState = { paymentStatus?: string | null; metadata?: unknown }

// LEGACY and NOT ENOUGH to authorize anything: "the status says paid, or an authorization exists". It ignores the payments under review, the payments being
// confirmed, the Stripe pages still open and the proof of payment. Whether an order may go to production is `releaseDecision` (below) and nothing else; this
// stays only for the places that ask a different question ("does the original of a reprint look paid?") and for tests that check what an outside sender can
// NOT make eligible. A test (tests/security/production-release.sec.ts) lists the files allowed to call it.
export function isProductionEligible(order: OrderPaymentState) {
  return isPaymentVerified(order.paymentStatus) || getProductionAuthorization(order.metadata) !== null
}

// Prisma filter equivalent of `isProductionEligible`. LEGACY: use `releasedOrderWhere` to pick orders for production.
export const productionEligibleOrderWhere = {
  OR: [
    { paymentStatus: { in: ['paid', 'free'] } },
    { metadata: { path: ['productionAuthorization', 'authorized'], equals: true } },
  ],
}

// The record of an authorization. `grant.financialRevision` is the revision the order has NOW, read under the lock of the release (the grant itself does not change it).
export function withProductionAuthorization(
  metadata: unknown,
  adminId: string,
  reason: string | null | undefined,
  grant: { financialRevision: number; kind?: AuthorizationKind; credit?: CommercialCredit | null; financialFacts?: Json },
): Json {
  return {
    ...asRecord(metadata),
    productionAuthorization: {
      authorized: true,
      by: adminId,
      at: new Date().toISOString(),
      reason: reason?.trim() ? reason.trim().slice(0, 300) : null,
      kind: grant.kind ?? 'exceptional',
      financialRevision: grant.financialRevision,
      // what was authorized, for the person who reads it later ("what did I authorize / what has changed"): an explanation, never used to decide
      ...(grant.financialFacts ? { financialFacts: grant.financialFacts } : {}),
      ...(grant.credit ? { credit: grant.credit } : {}),
    },
  }
}

// ---- The release decision (step 4.6, S4) ------------------------------------------------------------------
export const EXTERNAL_ORDER_REASON = 'external_order'
// A Stripe payment page / reservation that is still open counts as "money may still arrive" for this long after its stated expiry (Stripe's own clock and
// the webhook that tells us it expired are not instantaneous).
export const ACTIVE_ATTEMPT_GRACE_MS = 10 * 60 * 1000

export type ReleaseState =
  | 'released'
  | 'payment_pending'      // no verified payment and no authorization; an administrator may authorize
  | 'payment_unproven'     // the status says paid / free but the proof only the server writes is missing; an administrator may authorize
  | 'payment_refunded'     // the order's own Stripe payment was refunded (in part or in full): the proof is gone; an administrator may authorize it again, with a reason
  | 'payment_refund_pending' // a refund requested from the application is not over: nothing overrides it
  | 'payment_processing'   // a payment is being confirmed: nothing overrides it
  | 'payment_active'       // a Stripe payment page is open (or being created): nothing overrides it
  | 'payment_hold'         // a person has to look at the payment: nothing overrides it
  | 'external_review'      // an order from an outside service that nobody authorized; an administrator may authorize

// WHY an order is released. The ways to get there stay distinct everywhere (audit, logs, screens).
export type ReleaseBasis = 'stripe_verified' | 'paypal_verified' | 'manual_payment' | 'free_order' | 'admin_authorization' | 'commercial_credit'

export type ReleaseCode =
  | 'PAYMENT_NOT_VERIFIED'
  | 'PAYMENT_UNPROVEN'
  | 'PAYMENT_REFUNDED'
  | 'REFUND_IN_PROGRESS'
  | 'PAYMENT_PROCESSING'
  | 'PAYMENT_ACTIVE'
  | 'PAYMENT_ON_HOLD'
  | 'EXTERNAL_ORDER_NOT_AUTHORIZED'

export type ReleaseAttemptFacts = { status: string; expiresAt?: Date | string | null }

// ---- Refund operations (step 4.6, S6, M3a): the refunds requested from the application ------------------------------------------------------------------------------
// ONE definition of which operations block the production of an order, used by the pure function and by the database filter alike (a test proves they agree):
//   * `abandoned` (PROVEN that nothing was ever sent) never blocks;
//   * `succeeded` / `failed` / `canceled` block until the final state has been read back from Stripe and applied (`appliedAt`): a refund that Stripe reports done, but whose
//     effect on the order is not applied yet, is still money in motion;
//   * everything else blocks - requested, sending, unknown, pending, requires_action, unresolved - and so does a status nobody knows (fail closed).
export const REFUND_OPERATION_STATUSES = ['requested', 'sending', 'unknown', 'pending', 'requires_action', 'succeeded', 'failed', 'canceled', 'abandoned', 'unresolved'] as const
export const REFUND_TERMINAL_STATUSES: readonly string[] = ['succeeded', 'failed', 'canceled']
export const REFUND_NEVER_BLOCKING_STATUSES: readonly string[] = ['abandoned']
export type RefundOperationFacts = { status: string; appliedAt: Date | string | null | undefined }

export function refundOperationBlocks(operation: RefundOperationFacts): boolean {
  if (REFUND_NEVER_BLOCKING_STATUSES.includes(operation.status)) return false
  if (REFUND_TERMINAL_STATUSES.includes(operation.status)) return !operation.appliedAt
  return true
}
// The same predicate for Prisma (`select` of the facts and the filter that picks orders for production)
export const refundOperationBlocksWhere: Prisma.RefundOperationWhereInput = {
  OR: [
    { status: { notIn: [...REFUND_NEVER_BLOCKING_STATUSES, ...REFUND_TERMINAL_STATUSES] } },
    { status: { in: [...REFUND_TERMINAL_STATUSES] }, appliedAt: null },
  ],
}

// Everything the decision needs. Every field is REQUIRED (nullable where the database allows it), on purpose: a caller that forgets to load the payment
// attempts or the review reason would silently get a more permissive answer, so it does not compile. `RELEASE_FACTS_SELECT` is the Prisma selection that loads them.
export type ReleaseFacts = {
  paymentStatus: string | null | undefined
  paymentReviewReason: string | null | undefined
  metadata: unknown
  totalCents: number
  currency: string | null | undefined
  paymentMethod: string | null | undefined
  stripePaymentIntentId: string | null | undefined
  stripeInvoiceId: string | null | undefined
  paidAt: Date | string | null | undefined
  // what Stripe says was refunded of the order's own payment (written only by the payment sync / the refund operations)
  refundedCents: number | null | undefined
  // the counter of the changes of the money situation (lib/financial-revision.ts): an authorization is valid only while it is the one it was given at
  financialRevision: number | null | undefined
  paymentAttempts: ReadonlyArray<ReleaseAttemptFacts>
  // only the operations that BLOCK are loaded (refundOperationBlocksWhere); the decision applies `refundOperationBlocks` again
  refundOperations: ReadonlyArray<RefundOperationFacts>
}

export const RELEASE_FACTS_SELECT = {
  paymentStatus: true,
  paymentReviewReason: true,
  metadata: true,
  totalCents: true,
  currency: true,
  paymentMethod: true,
  stripePaymentIntentId: true,
  stripeInvoiceId: true,
  paidAt: true,
  refundedCents: true,
  financialRevision: true,
  paymentAttempts: { select: { status: true, expiresAt: true } },
  refundOperations: { where: refundOperationBlocksWhere, select: { status: true, appliedAt: true } },
} as const

// The facts of an order row that was loaded with its payment attempts and (only the blocking) refund operations.
export function releaseFactsOf(
  order: Omit<ReleaseFacts, 'paymentAttempts' | 'refundOperations'>,
  parts: { paymentAttempts: ReadonlyArray<ReleaseAttemptFacts>; refundOperations: ReadonlyArray<RefundOperationFacts> },
): ReleaseFacts {
  return {
    paymentStatus: order.paymentStatus, paymentReviewReason: order.paymentReviewReason, metadata: order.metadata, totalCents: order.totalCents, currency: order.currency,
    paymentMethod: order.paymentMethod, stripePaymentIntentId: order.stripePaymentIntentId, stripeInvoiceId: order.stripeInvoiceId, paidAt: order.paidAt,
    refundedCents: order.refundedCents, financialRevision: order.financialRevision, paymentAttempts: parts.paymentAttempts, refundOperations: parts.refundOperations,
  }
}

// The facts of an order that does not exist yet (being created): nothing is under review, no attempts, no Stripe reference, nothing refunded, revision 0.
export function newOrderFacts(input: { paymentStatus: string | null | undefined; totalCents: number; metadata?: unknown; paymentMethod?: string | null; currency?: string | null }): ReleaseFacts {
  return {
    paymentStatus: input.paymentStatus, paymentReviewReason: null, metadata: input.metadata ?? {}, totalCents: input.totalCents, currency: input.currency ?? null,
    paymentMethod: input.paymentMethod ?? null, stripePaymentIntentId: null, stripeInvoiceId: null, paidAt: null, refundedCents: 0, financialRevision: 0,
    paymentAttempts: [], refundOperations: [],
  }
}

export type ReleaseDecision = {
  state: ReleaseState
  released: boolean
  basis: ReleaseBasis | null
  // may an explicit administrator authorization (with a written reason) release it? Never for a payment that is held, being confirmed, still active or being refunded.
  authorizable: boolean
  code: ReleaseCode | null
  // one sentence for the administrator (English, like the admin panels)
  message: string
  // the code that put the payment on hold (column or log), if any
  reviewReason: string | null
  // for `payment_active`: until when the open payment page / reservation may still bring money
  activeUntil: string | null
  // an authorization exists but is no longer valid: the money situation of the order changed after it was given (or it carries no revision)
  authorizationStale: AuthorizationStale | null
  // for a release on commercial credit: what is still due (a credit is not a payment)
  credit: CommercialCredit | null
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function loggedMoneyReason(metadata: Json): string | null {
  const log = metadata.paymentReview
  if (!Array.isArray(log)) return null
  for (let index = log.length - 1; index >= 0; index--) {
    const reason = asRecord(log[index]).reason
    if (nonEmpty(reason) && reason !== EXTERNAL_ORDER_REASON) return reason
  }
  return null
}

function hasStripeProof(facts: ReleaseFacts, metadata: Json) {
  if (!nonEmpty(facts.stripePaymentIntentId) && !nonEmpty(facts.stripeInvoiceId)) return false
  if (facts.paidAt) return true
  if (facts.paymentAttempts.some((attempt) => attempt.status === 'paid')) return true
  return asRecord(metadata.stripe).paymentStatus === 'paid' || asRecord(metadata.stripeInvoice).paymentStatus === 'paid'
}
function hasPayPalProof(metadata: Json) {
  const paypal = asRecord(metadata.paypal)
  return nonEmpty(paypal.captureId) && paypal.paymentStatus === 'paid'
}

// ---- A payment taken outside Stripe that an administrator ATTESTED (step 4.6, D8, S6) -----------------------------------------------------------------------------------
// A record is complete only if it says WHO attested it, WHEN, WHY, by which agreed method, HOW the money was received, HOW MUCH (taken from the order by the server, never typed),
// in which currency, and - for a bank transfer - the reference of the bank statement. An invoice or a purchase order is a CREDIT, not money: it counts only through the
// record of the money that arrived for it (cash or a bank transfer). PayPal is not attestable at all: a PayPal capture is verified by the server or it is not paid.
// Records from before S6 (no amount, no receipt method, method invoice / po / paypal) are NOT valid: they must be registered again.
export const MANUAL_RECORD_METHODS: readonly string[] = ['cash', 'invoice', 'po', 'comped']
export const RECEIVED_VIA_METHODS: readonly string[] = ['cash', 'bank_transfer']
export function isCreditPaymentMethod(method: string | null | undefined) {
  return method === 'invoice' || method === 'po'
}
function manualRecordIsComplete(manual: Json): boolean {
  if (!nonEmpty(manual.by) || !nonEmpty(manual.at) || !nonEmpty(manual.reason) || !nonEmpty(manual.method)) return false
  if (!MANUAL_RECORD_METHODS.includes(manual.method)) return false
  const amount = manual.amountCents
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || !nonEmpty(manual.currency)) return false
  // a no-charge registration is a decision not to charge, with no money received
  if (manual.method === 'comped') return manual.receivedVia === 'none' && amount === 0
  if (typeof manual.receivedVia !== 'string' || !RECEIVED_VIA_METHODS.includes(manual.receivedVia)) return false
  if (manual.method === 'cash' && manual.receivedVia !== 'cash') return false
  if (manual.receivedVia === 'bank_transfer' && !nonEmpty(manual.reference)) return false
  return true
}
// the record of a payment taken outside Stripe that an administrator registered (lib/orders.ts, D8): complete, or it is not a record
export function hasManualPaymentRecord(metadata: unknown) {
  return manualRecordIsComplete(asRecord(asRecord(metadata).manualPayment))
}
// ...and it covers THIS order: the amount received is at least the total, in the order's currency
export function manualPaymentCovers(metadata: unknown, totalCents: number, currency: string | null | undefined) {
  const manual = asRecord(asRecord(metadata).manualPayment)
  if (!manualRecordIsComplete(manual)) return false
  if (String(manual.currency).toUpperCase() !== String(currency || '').toUpperCase()) return false
  if (manual.method === 'comped') return true
  return (manual.amountCents as number) >= totalCents
}

// "The payment status says paid" is NOT proof: legacy and administrative routes can set it. Proof is what only the server writes after it has checked the
// money: a Stripe reference together with the verification (`paidAt`, a `paid` attempt, the Stripe record kept in the metadata), a PayPal capture verified by
// the server, a registered manual payment that covers the total, or a no-charge order whose total really is zero. Returns the basis, or null when the status is not
// "paid/free" or no proof backs it.
export function verifiedPaymentBasis(facts: ReleaseFacts): Exclude<ReleaseBasis, 'admin_authorization' | 'commercial_credit'> | null {
  const status = normalizePaymentStatus(facts.paymentStatus)
  if (status !== 'paid' && status !== 'free') return null
  const metadata = asRecord(facts.metadata)
  if (hasStripeProof(facts, metadata)) return 'stripe_verified'
  if (hasPayPalProof(metadata)) return 'paypal_verified'
  if (manualPaymentCovers(metadata, facts.totalCents, facts.currency)) return 'manual_payment'
  if (status === 'free' && facts.totalCents === 0) return 'free_order'
  return null
}

function activeAttemptUntil(facts: ReleaseFacts, nowMs: number): number | null {
  let until: number | null = null
  for (const attempt of facts.paymentAttempts) {
    if (attempt.status !== 'creating' && attempt.status !== 'open') continue
    const expires = toMillis(attempt.expiresAt)
    // an attempt with no readable expiry is taken as still open
    const stillOpenUntil = expires === null ? nowMs + ACTIVE_ATTEMPT_GRACE_MS : expires + ACTIVE_ATTEMPT_GRACE_MS
    if (stillOpenUntil > nowMs) until = Math.max(until ?? 0, stillOpenUntil)
  }
  return until
}

const MESSAGES: Record<ReleaseCode, string> = {
  PAYMENT_NOT_VERIFIED: 'Payment has not been verified for this order. Production can only start after a verified payment or an explicit administrator authorization.',
  PAYMENT_UNPROVEN: 'This order is marked as paid, but the server holds no proof of the payment (no Stripe confirmation and no registered manual payment that covers the total). Verify or register the payment, or authorize production with a written reason.',
  PAYMENT_REFUNDED: 'The payment of this order was refunded (in part or in full), so it no longer proves that the order is paid. Production can not go ahead on that payment: authorize it explicitly, with a written reason, if it is meant to continue.',
  REFUND_IN_PROGRESS: 'A refund of this order was requested from the application and is not over: it is still being sent, waiting for Stripe, of unknown outcome, or its final state has not been read back and applied yet. Production can not start - and no authorization can override it - until the refund is closed.',
  PAYMENT_PROCESSING: 'A payment for this order is still being confirmed. Production can not start - and no authorization can override it - until the payment is settled.',
  PAYMENT_ACTIVE: 'A Stripe payment page for this order is still open, so money may still arrive. Production can not start - and no authorization can override it - until the payment is completed or the page has expired.',
  PAYMENT_ON_HOLD: 'The payment of this order is under review. Production can not start - and no authorization can override it - until a person has resolved the payment hold.',
  EXTERNAL_ORDER_NOT_AUTHORIZED: 'This order came from an outside service and has not been checked. Authorize it explicitly, with a written reason, before it goes to production.',
}
const STALE_SENTENCE = ' An authorization was given earlier, but the payment situation of the order has changed since (or the authorization carries no revision): it is no longer valid, and a new authorization with a written reason is needed.'
const AUTHORIZABLE_STATES = new Set<ReleaseState>(['payment_pending', 'payment_unproven', 'payment_refunded', 'external_review'])

// THE rule. Pure: no database, no network, no clock except `opts.now`. Precedence (first match wins):
//   1. a payment review reason other than "external order" (ANY code, known or not)                         -> payment_hold          (not authorizable)
//   2. "external order" whose review log also holds a money problem found later (duplicate payment...)      -> payment_hold          (not authorizable)
//   3. a refund requested from the application that is not over (S6)                                        -> payment_refund_pending (not authorizable)
//   4. payment status "processing", or an attempt being confirmed                                           -> payment_processing    (not authorizable)
//   5. an order from an outside service: released only by an explicit, VALID authorization (and never over an open page)
//   6. a verified payment AND the proof the server keeps of it (a Stripe payment that was refunded no longer is proof)
//                                                                                                           -> released (stripe_verified | paypal_verified | manual_payment | free_order)
//   7. a Stripe payment page / reservation still open                                                        -> payment_active        (not authorizable)
//   8. an explicit administrator authorization that is VALID for the money situation the order is in now    -> released (admin_authorization | commercial_credit)
//   9. the order's own Stripe payment was refunded                                                           -> payment_refunded      (authorizable)
//  10. the status says paid / free but there is no proof                                                    -> payment_unproven      (authorizable)
//  11. anything else (pending, requires_capture, quote, failed, canceled...)                                -> payment_pending       (authorizable)
// An authorization (8) therefore never overrides a payment that is held, being confirmed, still active or being refunded; and a typed Stripe reference, a PrintLab event or
// a status word alone never releases anything.
export function releaseDecision(facts: ReleaseFacts, opts: { now?: number | Date } = {}): ReleaseDecision {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now())
  const metadata = asRecord(facts.metadata)
  const reason = facts.paymentReviewReason ? facts.paymentReviewReason : null
  const record = getProductionAuthorization(metadata)
  const stale = record ? authorizationStaleness(record, facts.financialRevision) : null
  const authorization = record && !stale ? record : null
  const external = reason === EXTERNAL_ORDER_REASON

  const blocked = (state: Exclude<ReleaseState, 'released'>, code: ReleaseCode, extra: { reviewReason?: string | null; activeUntil?: number | null } = {}): ReleaseDecision => {
    const authorizable = AUTHORIZABLE_STATES.has(state)
    return {
      state, released: false, basis: null, authorizable, code, message: MESSAGES[code] + (stale && authorizable ? STALE_SENTENCE : ''),
      reviewReason: extra.reviewReason ?? null, activeUntil: extra.activeUntil ? new Date(extra.activeUntil).toISOString() : null, authorizationStale: stale, credit: null,
    }
  }
  const released = (basis: ReleaseBasis, credit: CommercialCredit | null = null): ReleaseDecision => ({
    state: 'released', released: true, basis, authorizable: false, code: null, message: '', reviewReason: null, activeUntil: null, authorizationStale: null, credit,
  })
  const releasedByAuthorization = (valid: ProductionAuthorization) => (valid.kind === 'commercial_credit' ? released('commercial_credit', valid.credit) : released('admin_authorization'))

  if (reason && !external) return blocked('payment_hold', 'PAYMENT_ON_HOLD', { reviewReason: reason })
  if (external) {
    const later = loggedMoneyReason(metadata)
    if (later) return blocked('payment_hold', 'PAYMENT_ON_HOLD', { reviewReason: later })
  }
  if (facts.refundOperations.some(refundOperationBlocks)) return blocked('payment_refund_pending', 'REFUND_IN_PROGRESS')
  if (normalizePaymentStatus(facts.paymentStatus) === 'processing' || facts.paymentAttempts.some((attempt) => attempt.status === 'processing')) {
    return blocked('payment_processing', 'PAYMENT_PROCESSING')
  }
  const activeUntil = activeAttemptUntil(facts, nowMs)
  if (external) {
    if (!authorization) return blocked('external_review', 'EXTERNAL_ORDER_NOT_AUTHORIZED', { reviewReason: reason })
    if (activeUntil) return blocked('payment_active', 'PAYMENT_ACTIVE', { activeUntil })
    return releasedByAuthorization(authorization)
  }
  const basis = verifiedPaymentBasis(facts)
  // A refund of the order's own Stripe payment takes the proof away: the money (or part of it) went back
  const refundTookProofAway = basis === 'stripe_verified' && (facts.refundedCents ?? 0) > 0
  if (basis && !refundTookProofAway) return released(basis)
  if (activeUntil) return blocked('payment_active', 'PAYMENT_ACTIVE', { activeUntil })
  if (authorization) return releasedByAuthorization(authorization)
  if (refundTookProofAway) return blocked('payment_refunded', 'PAYMENT_REFUNDED')
  if (isPaymentVerified(facts.paymentStatus)) return blocked('payment_unproven', 'PAYMENT_UNPROVEN')
  return blocked('payment_pending', 'PAYMENT_NOT_VERIFIED')
}

export function isReleasedToProduction(facts: ReleaseFacts, opts: { now?: number | Date } = {}) {
  return releaseDecision(facts, opts).released
}

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`

// Short texts for the administrator's screens: a label and a sentence about the decision.
export function describeRelease(decision: ReleaseDecision): { label: string; detail: string } {
  if (decision.released) {
    if (decision.basis === 'commercial_credit' && decision.credit) {
      const credit = decision.credit
      return {
        label: `Released - commercial credit (${credit.method}${credit.reference ? ` ${credit.reference}` : ''}): ${money(credit.amountDueCents, credit.currency)} still due`,
        detail: 'An administrator authorized production on credit. This is NOT a payment: the amount is still due until the money arrives.',
      }
    }
    const labels: Record<ReleaseBasis, [string, string]> = {
      stripe_verified: ['Released - Stripe payment verified', 'The payment was verified with Stripe.'],
      paypal_verified: ['Released - PayPal payment verified', 'The PayPal capture was verified by the server.'],
      manual_payment: ['Released - manual payment registered', 'An administrator attested a payment taken outside Stripe (it is not a Stripe payment).'],
      free_order: ['Released - no charge', 'The order has no amount to pay.'],
      admin_authorization: ['Released - administrator authorization', 'An administrator authorized production without a verified payment.'],
      commercial_credit: ['Released - commercial credit', 'An administrator authorized production on credit.'],
    }
    const [label, detail] = labels[decision.basis ?? 'admin_authorization']
    return { label, detail }
  }
  const text = describeReviewReason(decision.reviewReason)
  switch (decision.state) {
    case 'payment_hold': return { label: `Not released - payment under review${text ? ` (${text.label})` : ''}`, detail: text ? text.detail : decision.message }
    case 'payment_processing': return { label: 'Not released - payment being confirmed', detail: decision.message }
    case 'payment_active': return { label: 'Not released - payment page open', detail: decision.message }
    case 'payment_unproven': return { label: 'Not released - payment not proven', detail: decision.message }
    case 'payment_refunded': return { label: 'Not released - payment refunded', detail: decision.message }
    case 'payment_refund_pending': return { label: 'Not released - refund in progress', detail: decision.message }
    case 'external_review': return { label: 'Not released - outside order to check', detail: decision.message }
    default: return { label: 'Not released - awaiting payment', detail: decision.message }
  }
}

// What the administrator's screens receive about the decision: plain data (no Date, no function) that can cross from a server page to a client component.
export type ReleaseView = {
  released: boolean
  state: ReleaseState
  basis: ReleaseBasis | null
  authorizable: boolean
  code: ReleaseCode | null
  label: string
  detail: string
  reviewReason: string | null
  activeUntil: string | null
  authorizationStale: AuthorizationStale | null
  credit: CommercialCredit | null
}
export function releaseView(decision: ReleaseDecision): ReleaseView {
  const text = describeRelease(decision)
  return {
    released: decision.released, state: decision.state, basis: decision.basis, authorizable: decision.authorizable, code: decision.code,
    label: text.label, detail: text.detail, reviewReason: decision.reviewReason, activeUntil: decision.activeUntil,
    authorizationStale: decision.authorizationStale, credit: decision.credit,
  }
}

// ---- A Prisma prefilter equivalent to the decision ------------------------------------------------------------
// For queries that PICK orders (the automatic queue, planning reads). It is a PREFILTER, not the rule: it can not read the review log of an outside order
// (a money problem found after the authorization) and can not compare the revision of an authorization (a value inside a JSON) with the revision column, so it may let
// such an order through; every effect therefore re-decides with `releaseDecision` under a lock on the order, and tests/security/production-release.sec.ts proves that nothing
// `releaseDecision` releases is left out of it. On ONE point it is exact: an order with a refund operation that blocks is never picked (`refundOperationBlocksWhere`).
const present = (path: string[]) => ({ metadata: { path, not: '' } })
export function releasedOrderWhere(now: Date = new Date()): Prisma.PrintOrderWhereInput {
  const activeSince = new Date(now.getTime() - ACTIVE_ATTEMPT_GRACE_MS)
  const noReason: Prisma.PrintOrderWhereInput = { OR: [{ paymentReviewReason: null }, { paymentReviewReason: '' }] }
  const stripeProof: Prisma.PrintOrderWhereInput = {
    AND: [
      { OR: [{ stripePaymentIntentId: { not: null } }, { stripeInvoiceId: { not: null } }] },
      {
        OR: [
          { paidAt: { not: null } },
          { paymentAttempts: { some: { status: 'paid' } } },
          { metadata: { path: ['stripe', 'paymentStatus'], equals: 'paid' } },
          { metadata: { path: ['stripeInvoice', 'paymentStatus'], equals: 'paid' } },
        ],
      },
      // a refund of the order's own payment takes the proof away
      { refundedCents: 0 },
    ],
  }
  const paypalProof: Prisma.PrintOrderWhereInput = { AND: [present(['paypal', 'captureId']), { metadata: { path: ['paypal', 'paymentStatus'], equals: 'paid' } }] }
  const manualProof: Prisma.PrintOrderWhereInput = { AND: ['by', 'at', 'reason', 'method', 'receivedVia', 'amountCents', 'currency'].map((key) => present(['manualPayment', key])) }
  const verified: Prisma.PrintOrderWhereInput = {
    AND: [
      noReason,
      {
        OR: [
          { AND: [{ paymentStatus: { in: ['paid', 'success', 'succeeded'] } }, { OR: [stripeProof, paypalProof, manualProof] }] },
          { AND: [{ paymentStatus: 'free' }, { OR: [{ totalCents: 0 }, stripeProof, paypalProof, manualProof] }] },
        ],
      },
    ],
  }
  const authorized: Prisma.PrintOrderWhereInput = {
    AND: [
      { metadata: { path: ['productionAuthorization', 'authorized'], equals: true } },
      present(['productionAuthorization', 'by']),
      // an authorization without a revision is never valid (the revision is compared with the order's by releaseDecision, under the lock)
      present(['productionAuthorization', 'financialRevision']),
      { OR: [{ paymentReviewReason: null }, { paymentReviewReason: '' }, { paymentReviewReason: EXTERNAL_ORDER_REASON }] },
      { paymentStatus: { not: 'processing' } },
      { paymentAttempts: { none: { status: { in: ['creating', 'open'] }, expiresAt: { gt: activeSince } } } },
    ],
  }
  return {
    AND: [
      { paymentAttempts: { none: { status: 'processing' } } },
      { refundOperations: { none: refundOperationBlocksWhere } },
      { OR: [verified, authorized] },
    ],
  }
}

// ---- The legacy checkout and the stock of ready-made products -----------------------------------------------------
// Stock of a ready-made product is taken out when the sale is real: a payment verified in the same request (or a no-charge order), or an order an administrator
// enters by hand for cash / an invoice / a purchase order. NEVER for a quote request (anyone, guests included, can send one), and not yet for a card or PayPal payment
// that is still being confirmed or only authorized: the `inventory` effect after the payment is verified takes it then, with the same reference so it is never taken twice.
export function productStockMayBeTakenAtCheckout(input: { paymentMethod: string; paymentStatus: string | null | undefined }) {
  if (input.paymentMethod === 'quote') return false
  return isPaymentVerified(input.paymentStatus) || ['cash', 'invoice', 'po'].includes(input.paymentMethod)
}

// ---- What an administrator is told about a payment (step 4.6, S6, F24) ------------------------------------------------------------------------
// The title of the notification: "Payment received" only for a payment that is verified. Everything else says what it is.
export function adminPaymentNotificationTitle(paymentMethod: string | null | undefined, paymentStatus: string | null | undefined, opts: { created?: boolean } = {}): string {
  const method = String(paymentMethod || '').trim().toLowerCase()
  if (method === 'comped') return 'No-charge order received'
  if (method === 'quote') return 'Quote request received'
  if (isPaymentVerified(paymentStatus)) return opts.created === false ? 'Payment updated' : 'Payment received'
  if (isPaymentPromise(method, paymentStatus)) return 'Payment promise received'
  return opts.created === false ? 'Payment updated' : 'Order received - payment pending'
}

// ---- What an operation may do to an order in which status -----------------------------------------------------
export const ASSIGN_PRINTER_STATUSES: readonly string[] = ['queued', 'printing', 'in_production']
export const PRINTLAB_SUBMIT_STATUSES: readonly string[] = ['queued']
export const ORG_APPROVAL_STATUSES: readonly string[] = ['awaiting_review', 'awaiting_payment']

export type ProductionTransition =
  | { allowed: true; metadata?: Json; release?: ReleaseDecision }
  | { allowed: false; error: string; code?: string; releaseState?: ReleaseState; httpStatus?: number }

// Every authorization to produce without a verified payment is a deliberate decision: it must say why (kept on the order with the administrator's id and the date).
export const AUTHORIZATION_REASON_MIN_LENGTH = 10
export const REPRINT_AUTHORIZATION_REASON_MIN_LENGTH = AUTHORIZATION_REASON_MIN_LENGTH

export function isReprintMetadata(metadata: unknown) {
  return Object.keys(asRecord(asRecord(metadata).reprint)).length > 0
}

export type ManualTransitionOptions = {
  authorizeUnpaid?: boolean
  adminId: string
  reason?: string | null
  now?: number | Date
  // 'exceptional' (default) or 'commercial_credit' (an invoice / purchase-order order produced on credit)
  kind?: AuthorizationKind
  creditReference?: string | null
  creditDueAt?: string | null
}
export const CREDIT_REFERENCE_MAX_LENGTH = 120

// Manual (administrator) transition: a production status for an order that is not released needs `authorizeUnpaid`, which is recorded in the order metadata -
// and which is refused whenever the payment is held, being confirmed, still active or being refunded (releaseDecision.authorizable), when no written reason is given, and
// when the KIND of the authorization does not fit the order (a commercial credit is only for an invoice / purchase-order order, and an invoice / purchase-order order can only
// be produced on credit - except an outside order, which is authorized as it is).
export function checkManualTransition(order: ReleaseFacts, nextStatus: string, opts: ManualTransitionOptions): ProductionTransition {
  if (!isProductionStatus(nextStatus)) return { allowed: true }
  const release = releaseDecision(order, { now: opts.now })
  if (release.released) return { allowed: true, release }
  const refusal = { allowed: false as const, error: release.message, code: release.code ?? undefined, releaseState: release.state }
  if (!release.authorizable) return refusal
  if (!opts.authorizeUnpaid) return refusal
  const reason = (opts.reason ?? '').trim()
  if (reason.length < AUTHORIZATION_REASON_MIN_LENGTH) {
    return {
      allowed: false,
      code: 'REASON_REQUIRED',
      httpStatus: 400,
      error: `A written reason of at least ${AUTHORIZATION_REASON_MIN_LENGTH} characters is required to authorize production without a verified payment${isReprintMetadata(order.metadata) ? ' (a free reprint included)' : ''}.`,
      releaseState: release.state,
    }
  }
  const kind: AuthorizationKind = opts.kind === 'commercial_credit' ? 'commercial_credit' : 'exceptional'
  const creditOrder = isCreditPaymentMethod(order.paymentMethod)
  const mismatch = kind === 'commercial_credit' ? !creditOrder : (creditOrder && release.state !== 'external_review')
  if (mismatch) {
    return {
      allowed: false,
      code: 'CREDIT_KIND_MISMATCH',
      error: creditOrder
        ? 'An invoice / purchase-order order is produced on credit: authorize it as a commercial credit (with the invoice or order reference), not as an exceptional authorization.'
        : 'A commercial credit is only for an invoice / purchase-order order.',
      releaseState: release.state,
    }
  }
  let credit: CommercialCredit | null = null
  if (kind === 'commercial_credit') {
    const reference = (opts.creditReference ?? '').trim()
    if (reference.length < 1 || reference.length > CREDIT_REFERENCE_MAX_LENGTH) {
      return { allowed: false, code: 'CREDIT_REFERENCE_REQUIRED', httpStatus: 400, error: `A commercial credit needs the reference of the invoice or purchase order (1 to ${CREDIT_REFERENCE_MAX_LENGTH} characters).`, releaseState: release.state }
    }
    const dueAt = (opts.creditDueAt ?? '').trim()
    credit = {
      method: String(order.paymentMethod || 'invoice'), reference, amountDueCents: Math.max(0, Math.round(order.totalCents)),
      currency: String(order.currency || '').toUpperCase() || 'EUR', dueAt: dueAt || null,
    }
  }
  const revision = typeof order.financialRevision === 'number' && Number.isInteger(order.financialRevision) && order.financialRevision >= 0 ? order.financialRevision : 0
  return {
    allowed: true,
    metadata: withProductionAuthorization(order.metadata, opts.adminId, reason, {
      financialRevision: revision, kind, credit,
      financialFacts: { refundedCents: order.refundedCents ?? 0, totalCents: order.totalCents, currency: order.currency ?? null, proofBasis: verifiedPaymentBasis(order) },
    }),
    release,
  }
}

// Automatic transition (webhooks, other services, approvals): never lets an order that is not released into production.
// Returns the status the order may take: `requested` when allowed, otherwise `fallback`.
export function gateAutomaticStatus(order: ReleaseFacts, requested: string, fallback = 'awaiting_payment') {
  return !isProductionStatus(requested) || isReleasedToProduction(order) ? requested : fallback
}
