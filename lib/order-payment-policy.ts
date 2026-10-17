// Payment-method and production-entry policy for orders (S5). One place, used by every code path that
// creates an order or changes its status.
//
// 1. Which payment methods a person may use is decided on the SERVER from the session, never from the request:
//      guests and customers: card (Stripe) or a quote request (no payment, no production)
//      administrators:       everything, including cash / invoice / purchase order / no-charge
// 2. An order enters PRODUCTION only if its payment is VERIFIED or an administrator explicitly authorized it.
//    "Verified" is strict: `paid` (Stripe confirmed the money) or `free` (a no-charge order created by an administrator).
//    Pending, processing, authorized-only, failed, quote... are NOT verified.
//    The authorization is recorded in `metadata.productionAuthorization` ({ authorized, by, at, reason }).
// 3. (step 4.6, S4) WHETHER an order may be assigned to a printer, sent to PrintLab, started or advanced is decided by ONE pure function, `releaseDecision`, and
//    only by it. It looks at everything that matters for money - the verified payment AND the proof of it that the server keeps, a payment under review, a
//    payment being confirmed, a Stripe payment page still open - and an administrator's authorization never overrides a payment that is held, being confirmed
//    or still active. Every code path that has an effect calls it at the moment of the effect, under a lock on the order (lib/production-release.ts).
import type { Prisma } from '@prisma/client'
import { normalizePaymentStatus } from '@/lib/orderworks-status'
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

export function getProductionAuthorization(metadata: unknown): { by: string; at: string; reason: string | null } | null {
  const raw = asRecord(asRecord(metadata).productionAuthorization)
  if (raw.authorized !== true || typeof raw.by !== 'string' || !raw.by) return null
  return { by: raw.by, at: typeof raw.at === 'string' ? raw.at : '', reason: typeof raw.reason === 'string' ? raw.reason : null }
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
]

export function sanitizeExternalMetadata(value: unknown): Record<string, unknown> {
  const input = asRecord(value)
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(input)) {
    if (!RESERVED_ORDER_METADATA_KEYS.includes(key)) out[key] = entry
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

export function withProductionAuthorization(metadata: unknown, adminId: string, reason?: string | null): Json {
  return {
    ...asRecord(metadata),
    productionAuthorization: {
      authorized: true,
      by: adminId,
      at: new Date().toISOString(),
      reason: reason?.trim() ? reason.trim().slice(0, 300) : null,
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
  | 'payment_processing'   // a payment is being confirmed: nothing overrides it
  | 'payment_active'       // a Stripe payment page is open (or being created): nothing overrides it
  | 'payment_hold'         // a person has to look at the payment: nothing overrides it
  | 'external_review'      // an order from an outside service that nobody authorized; an administrator may authorize

// WHY an order is released. The three ways to get there stay distinct everywhere (audit, logs, screens).
export type ReleaseBasis = 'stripe_verified' | 'paypal_verified' | 'manual_payment' | 'free_order' | 'admin_authorization'

export type ReleaseCode =
  | 'PAYMENT_NOT_VERIFIED'
  | 'PAYMENT_UNPROVEN'
  | 'PAYMENT_PROCESSING'
  | 'PAYMENT_ACTIVE'
  | 'PAYMENT_ON_HOLD'
  | 'EXTERNAL_ORDER_NOT_AUTHORIZED'

export type ReleaseAttemptFacts = { status: string; expiresAt?: Date | string | null }

// Everything the decision needs. Every field is REQUIRED (nullable where the database allows it), on purpose: a caller that forgets to load the payment
// attempts or the review reason would silently get a more permissive answer, so it does not compile. `RELEASE_FACTS_SELECT` is the Prisma selection that loads them.
export type ReleaseFacts = {
  paymentStatus: string | null | undefined
  paymentReviewReason: string | null | undefined
  metadata: unknown
  totalCents: number
  stripePaymentIntentId: string | null | undefined
  stripeInvoiceId: string | null | undefined
  paidAt: Date | string | null | undefined
  paymentAttempts: ReadonlyArray<ReleaseAttemptFacts>
}

export const RELEASE_FACTS_SELECT = {
  paymentStatus: true,
  paymentReviewReason: true,
  metadata: true,
  totalCents: true,
  stripePaymentIntentId: true,
  stripeInvoiceId: true,
  paidAt: true,
  paymentAttempts: { select: { status: true, expiresAt: true } },
} as const

// The facts of an order that does not exist yet (being created): nothing is under review, no attempts, no Stripe reference.
export function newOrderFacts(input: { paymentStatus: string | null | undefined; totalCents: number; metadata?: unknown }): ReleaseFacts {
  return {
    paymentStatus: input.paymentStatus, paymentReviewReason: null, metadata: input.metadata ?? {}, totalCents: input.totalCents,
    stripePaymentIntentId: null, stripeInvoiceId: null, paidAt: null, paymentAttempts: [],
  }
}

export type ReleaseDecision = {
  state: ReleaseState
  released: boolean
  basis: ReleaseBasis | null
  // may an explicit administrator authorization (with a written reason) release it? Never for a payment that is held, being confirmed or still active.
  authorizable: boolean
  code: ReleaseCode | null
  // one sentence for the administrator (English, like the admin panels)
  message: string
  // the code that put the payment on hold (column or log), if any
  reviewReason: string | null
  // for `payment_active`: until when the open payment page / reservation may still bring money
  activeUntil: string | null
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
// the record of a payment taken outside Stripe that an administrator registered (lib/orders.ts, D8): complete, or it is not a record
export function hasManualPaymentRecord(metadata: unknown) {
  const manual = asRecord(asRecord(metadata).manualPayment)
  return nonEmpty(manual.by) && nonEmpty(manual.at) && nonEmpty(manual.reason) && nonEmpty(manual.method)
}

// "The payment status says paid" is NOT proof: legacy and administrative routes can set it. Proof is what only the server writes after it has checked the
// money: a Stripe reference together with the verification (`paidAt`, a `paid` attempt, the Stripe record kept in the metadata), a PayPal capture verified by
// the server, a registered manual payment, or a no-charge order whose total really is zero. Returns the basis, or null when the status is not "paid/free" or
// no proof backs it.
export function verifiedPaymentBasis(facts: ReleaseFacts): Exclude<ReleaseBasis, 'admin_authorization'> | null {
  const status = normalizePaymentStatus(facts.paymentStatus)
  if (status !== 'paid' && status !== 'free') return null
  const metadata = asRecord(facts.metadata)
  if (hasStripeProof(facts, metadata)) return 'stripe_verified'
  if (hasPayPalProof(metadata)) return 'paypal_verified'
  if (hasManualPaymentRecord(metadata)) return 'manual_payment'
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
  PAYMENT_UNPROVEN: 'This order is marked as paid, but the server holds no proof of the payment (no Stripe confirmation and no registered manual payment). Verify or register the payment, or authorize production with a written reason.',
  PAYMENT_PROCESSING: 'A payment for this order is still being confirmed. Production can not start - and no authorization can override it - until the payment is settled.',
  PAYMENT_ACTIVE: 'A Stripe payment page for this order is still open, so money may still arrive. Production can not start - and no authorization can override it - until the payment is completed or the page has expired.',
  PAYMENT_ON_HOLD: 'The payment of this order is under review. Production can not start - and no authorization can override it - until a person has resolved the payment hold.',
  EXTERNAL_ORDER_NOT_AUTHORIZED: 'This order came from an outside service and has not been checked. Authorize it explicitly, with a written reason, before it goes to production.',
}

// THE rule. Pure: no database, no network, no clock except `opts.now`. Precedence (first match wins):
//   1. a payment review reason other than "external order" (ANY code, known or not)                         -> payment_hold        (not authorizable)
//   2. "external order" whose review log also holds a money problem found later (duplicate payment...)      -> payment_hold        (not authorizable)
//   3. payment status "processing", or an attempt being confirmed                                           -> payment_processing  (not authorizable)
//   4. an order from an outside service: released only by an explicit authorization (and never over an open page)
//   5. a verified payment AND the proof the server keeps of it                                              -> released (stripe_verified | paypal_verified | manual_payment | free_order)
//   6. a Stripe payment page / reservation still open                                                        -> payment_active      (not authorizable)
//   7. an explicit administrator authorization                                                              -> released (admin_authorization)
//   8. the status says paid / free but there is no proof                                                    -> payment_unproven    (authorizable)
//   9. anything else (pending, requires_capture, quote, failed, canceled...)                                -> payment_pending     (authorizable)
// An authorization (7) therefore never overrides a payment that is held, being confirmed or still active; and a typed Stripe reference, a PrintLab event or
// a status word alone never releases anything.
export function releaseDecision(facts: ReleaseFacts, opts: { now?: number | Date } = {}): ReleaseDecision {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now())
  const metadata = asRecord(facts.metadata)
  const reason = facts.paymentReviewReason ? facts.paymentReviewReason : null
  const authorization = getProductionAuthorization(metadata)
  const external = reason === EXTERNAL_ORDER_REASON

  const blocked = (state: Exclude<ReleaseState, 'released'>, code: ReleaseCode, extra: { reviewReason?: string | null; activeUntil?: number | null } = {}): ReleaseDecision => ({
    state, released: false, basis: null, authorizable: state === 'payment_pending' || state === 'payment_unproven' || state === 'external_review',
    code, message: MESSAGES[code], reviewReason: extra.reviewReason ?? null, activeUntil: extra.activeUntil ? new Date(extra.activeUntil).toISOString() : null,
  })
  const released = (basis: ReleaseBasis): ReleaseDecision => ({
    state: 'released', released: true, basis, authorizable: false, code: null, message: '', reviewReason: null, activeUntil: null,
  })

  if (reason && !external) return blocked('payment_hold', 'PAYMENT_ON_HOLD', { reviewReason: reason })
  if (external) {
    const later = loggedMoneyReason(metadata)
    if (later) return blocked('payment_hold', 'PAYMENT_ON_HOLD', { reviewReason: later })
  }
  if (normalizePaymentStatus(facts.paymentStatus) === 'processing' || facts.paymentAttempts.some((attempt) => attempt.status === 'processing')) {
    return blocked('payment_processing', 'PAYMENT_PROCESSING')
  }
  const activeUntil = activeAttemptUntil(facts, nowMs)
  if (external) {
    if (!authorization) return blocked('external_review', 'EXTERNAL_ORDER_NOT_AUTHORIZED', { reviewReason: reason })
    if (activeUntil) return blocked('payment_active', 'PAYMENT_ACTIVE', { activeUntil })
    return released('admin_authorization')
  }
  const basis = verifiedPaymentBasis(facts)
  if (basis) return released(basis)
  if (activeUntil) return blocked('payment_active', 'PAYMENT_ACTIVE', { activeUntil })
  if (authorization) return released('admin_authorization')
  if (isPaymentVerified(facts.paymentStatus)) return blocked('payment_unproven', 'PAYMENT_UNPROVEN')
  return blocked('payment_pending', 'PAYMENT_NOT_VERIFIED')
}

export function isReleasedToProduction(facts: ReleaseFacts, opts: { now?: number | Date } = {}) {
  return releaseDecision(facts, opts).released
}

// Short texts for the administrator's screens: a label and a sentence about the decision.
export function describeRelease(decision: ReleaseDecision): { label: string; detail: string } {
  if (decision.released) {
    const labels: Record<ReleaseBasis, [string, string]> = {
      stripe_verified: ['Released - Stripe payment verified', 'The payment was verified with Stripe.'],
      paypal_verified: ['Released - PayPal payment verified', 'The PayPal capture was verified by the server.'],
      manual_payment: ['Released - manual payment registered', 'An administrator registered a payment taken outside Stripe (it is not a Stripe payment).'],
      free_order: ['Released - no charge', 'The order has no amount to pay.'],
      admin_authorization: ['Released - administrator authorization', 'An administrator authorized production without a verified payment.'],
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
}
export function releaseView(decision: ReleaseDecision): ReleaseView {
  const text = describeRelease(decision)
  return {
    released: decision.released, state: decision.state, basis: decision.basis, authorizable: decision.authorizable, code: decision.code,
    label: text.label, detail: text.detail, reviewReason: decision.reviewReason, activeUntil: decision.activeUntil,
  }
}

// ---- A Prisma prefilter equivalent to the decision ------------------------------------------------------------
// For queries that PICK orders (the automatic queue, planning reads). It is a PREFILTER, not the rule: it can not read the review log of an outside order
// (a money problem found after the authorization), so it may let such an order through; every effect therefore re-decides with `releaseDecision` under a lock
// on the order, and tests/security/production-release.sec.ts proves that nothing `releaseDecision` releases is left out of it.
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
    ],
  }
  const paypalProof: Prisma.PrintOrderWhereInput = { AND: [present(['paypal', 'captureId']), { metadata: { path: ['paypal', 'paymentStatus'], equals: 'paid' } }] }
  const manualProof: Prisma.PrintOrderWhereInput = { AND: ['by', 'at', 'reason', 'method'].map((key) => present(['manualPayment', key])) }
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
      { OR: [{ paymentReviewReason: null }, { paymentReviewReason: '' }, { paymentReviewReason: EXTERNAL_ORDER_REASON }] },
      { paymentStatus: { not: 'processing' } },
      { paymentAttempts: { none: { status: { in: ['creating', 'open'] }, expiresAt: { gt: activeSince } } } },
    ],
  }
  return { AND: [{ paymentAttempts: { none: { status: 'processing' } } }, { OR: [verified, authorized] }] }
}

// ---- The legacy checkout and the stock of ready-made products -----------------------------------------------------
// Stock of a ready-made product is taken out when the sale is real: a payment verified in the same request (or a no-charge order), or an order an administrator
// enters by hand for cash / an invoice / a purchase order. NEVER for a quote request (anyone, guests included, can send one), and not yet for a card or PayPal payment
// that is still being confirmed or only authorized: the `inventory` effect after the payment is verified takes it then, with the same reference so it is never taken twice.
export function productStockMayBeTakenAtCheckout(input: { paymentMethod: string; paymentStatus: string | null | undefined }) {
  if (input.paymentMethod === 'quote') return false
  return isPaymentVerified(input.paymentStatus) || ['cash', 'invoice', 'po'].includes(input.paymentMethod)
}

// ---- What an operation may do to an order in which status -----------------------------------------------------
export const ASSIGN_PRINTER_STATUSES: readonly string[] = ['queued', 'printing', 'in_production']
export const PRINTLAB_SUBMIT_STATUSES: readonly string[] = ['queued']
export const ORG_APPROVAL_STATUSES: readonly string[] = ['awaiting_review', 'awaiting_payment']

export type ProductionTransition =
  | { allowed: true; metadata?: Json; release?: ReleaseDecision }
  | { allowed: false; error: string; code?: string; releaseState?: ReleaseState }

// A free reprint is a deliberate decision: it must say why (kept on the order with the administrator's id and the date).
export const REPRINT_AUTHORIZATION_REASON_MIN_LENGTH = 10

export function isReprintMetadata(metadata: unknown) {
  return Object.keys(asRecord(asRecord(metadata).reprint)).length > 0
}

// Manual (administrator) transition: a production status for an order that is not released needs `authorizeUnpaid`, which is recorded in the order metadata -
// and which is refused whenever the payment is held, being confirmed or still active (releaseDecision.authorizable).
export function checkManualTransition(
  order: ReleaseFacts,
  nextStatus: string,
  opts: { authorizeUnpaid?: boolean; adminId: string; reason?: string | null; now?: number | Date },
): ProductionTransition {
  if (!isProductionStatus(nextStatus)) return { allowed: true }
  const release = releaseDecision(order, { now: opts.now })
  if (release.released) return { allowed: true, release }
  const refusal = { allowed: false as const, error: release.message, code: release.code ?? undefined, releaseState: release.state }
  if (!release.authorizable) return refusal
  if (!opts.authorizeUnpaid) return refusal
  if (isReprintMetadata(order.metadata) && (opts.reason ?? '').trim().length < REPRINT_AUTHORIZATION_REASON_MIN_LENGTH) {
    return {
      allowed: false,
      code: 'AUTHORIZATION_REASON_REQUIRED',
      error: `A free reprint needs a written reason (at least ${REPRINT_AUTHORIZATION_REASON_MIN_LENGTH} characters).`,
      releaseState: release.state,
    }
  }
  return { allowed: true, metadata: withProductionAuthorization(order.metadata, opts.adminId, opts.reason), release }
}

// Automatic transition (webhooks, other services, approvals): never lets an order that is not released into production.
// Returns the status the order may take: `requested` when allowed, otherwise `fallback`.
export function gateAutomaticStatus(order: ReleaseFacts, requested: string, fallback = 'awaiting_payment') {
  return !isProductionStatus(requested) || isReleasedToProduction(order) ? requested : fallback
}
