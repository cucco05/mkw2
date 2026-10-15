// Brings an order's payment state in line with what Stripe says, safely. The only code that writes it from Stripe data.
//
// One cycle, for one Stripe object (checkout session, payment intent or invoice):
//   1. LEASE   short transaction: find the orders it concerns, lock them, and take a lease on each (a random id + an expiry).
//              If another cycle holds a lease on any of them, wait a little and try again. No other cycle can read-and-apply for
//              the same order until this one is done.
//   2. READ    ask Stripe for the CURRENT state. No database transaction is open and no row is locked during this call.
//   3. APPLY   short transaction: lock the orders again, check the lease is still ours, record the event (if any), verify the
//              payment against the order (lib/payment-verification.ts), write the result, clear the lease.
//   4. EFFECTS after the commit: receipts, notifications, PrintLab... (lib/order-effects.ts): idempotent and retryable.
//
// Why a lease and not "the newest state wins": Stripe states do not form a simple ladder. A payment attempt can fail and be
// retried (processing -> failed -> processing -> paid), a refund can fail and the refunded amount can go DOWN again, a session can
// end "expired" while another attempt is open. So a state read earlier cannot be told apart from a newer one by its value. What
// we can guarantee is the ORDER of the reads: two cycles for the same order never overlap, so the one that reads later also
// applies later, and what is stored is always what Stripe said last. An event is only a hint about what to look at; its payload
// is never used as the state.
//
// A crash between 1 and 3 leaves a lease that simply expires. A cycle that comes back after its lease expired and was taken over
// finds a different lease id in step 3 and applies nothing (the event stays unrecorded, Stripe delivers it again).
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import type { PaymentAttempt } from '@prisma/client'
import type Stripe from 'stripe'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import { isShippingCountryAllowed } from '@/lib/shipping'
import { JOIN_WINDOW_MS } from '@/lib/checkout-sessions'
import {
  addressFromSession,
  decidePaymentUpdate,
  mayCancelAfterExpiry,
  verifyCheckoutSession,
  verifyInvoice,
  verifyPaymentIntent,
  type AttemptStatus,
  type PaymentVerdict,
  type ReviewReason,
} from '@/lib/payment-verification'
import {
  mergeStripeInvoiceMetadata,
  mergeStripePaymentMetadata,
  normalizeStripePaymentStatus,
} from '@/lib/stripe-metadata'
import { runPostPaymentEffects } from '@/lib/order-effects'

type Tx = Prisma.TransactionClient

export type PaymentHint = { orderId?: string; attemptId?: string }
export type SyncTarget =
  | { kind: 'payment_intent'; id: string; hint?: PaymentHint }
  | { kind: 'checkout_session'; id: string; hint?: PaymentHint }
  | { kind: 'invoice'; id: string }

export type PaymentSyncResult = {
  duplicate: boolean
  unmatched: boolean
  orderIds: string[]
  updatedOrders: number
  paidOrderIds: string[]
  releasedOrderIds: string[]
  paymentStatus: string | null
}

export class PaymentSyncBusyError extends Error {
  constructor() {
    super('Another payment update for the same order is still running; try again shortly.')
    this.name = 'PaymentSyncBusyError'
  }
}
export class PaymentSyncReadTimeoutError extends Error {
  constructor() {
    super('Reading the payment state from Stripe took too long; nothing was applied.')
    this.name = 'PaymentSyncReadTimeoutError'
  }
}
export class PaymentSyncLeaseLostError extends Error {
  constructor() {
    super('The payment update lost its lease (it took too long); nothing was applied.')
    this.name = 'PaymentSyncLeaseLostError'
  }
}

const DEFAULT_LEASE_TTL_MS = 45_000
const STRIPE_READ_TIMEOUT_MS = 8_000
// How long a permission lasts. Overridable (PAYMENT_SYNC_LEASE_TTL_MS) only so that the tests with several real processes can
// watch an expiry without waiting 45 seconds; the value is clamped to a sensible range.
function leaseTtlMs() {
  const parsed = Number.parseInt(process.env.PAYMENT_SYNC_LEASE_TTL_MS || '', 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 500), 5 * 60_000) : DEFAULT_LEASE_TTL_MS
}
// The whole reading phase (all Stripe calls together) must end well before the permission can expire, leaving time to apply.
function readDeadlineMs() {
  return Math.floor(leaseTtlMs() * 0.55)
}

// Extension point for the tests (the same pattern as effectHooks / viewerGuards): called after Stripe was read and before the result is
// applied, i.e. exactly where a slow or paused process would be.
export const syncHooks: { afterRead?: () => Promise<void> } = {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// How long a cycle waits for another cycle on the same order. Kept short: Stripe retries what we refuse.
function maxWaitMs() {
  const parsed = Number.parseInt(process.env.PAYMENT_SYNC_MAX_WAIT_MS || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8_000
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function lockOrders(tx: Tx, orderIds: string[]) {
  if (orderIds.length === 0) return
  await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" IN (${Prisma.join(orderIds)}) ORDER BY "id" FOR UPDATE`
}

// ---- 1. which orders, and the lease ---------------------------------------------------------------------------------------
type Match = { orderId: string; attemptId: string | null; sessionId: string | null }
type Lease = { id: string | null; orderIds: string[]; matches: Match[] }

async function findMatches(tx: Tx, target: SyncTarget): Promise<Match[]> {
  const found = new Map<string, Match>()
  const add = (match: Match) => {
    const prior = found.get(match.orderId)
    if (!prior || (!prior.attemptId && match.attemptId)) found.set(match.orderId, match)
  }

  if (target.kind === 'checkout_session' || target.kind === 'payment_intent') {
    // Hosted checkout: the attempt we wrote before calling Stripe is what ties a Stripe object to an order. The attempt id
    // carried in the (signed) event is only used to FIND it; the payment is verified against Stripe's own data afterwards.
    const or: Prisma.PaymentAttemptWhereInput[] = [
      target.kind === 'checkout_session' ? { stripeSessionId: target.id } : { stripePaymentIntentId: target.id },
    ]
    if (target.hint?.attemptId) {
      or.push({ id: target.hint.attemptId, ...(target.hint.orderId ? { orderId: target.hint.orderId } : {}) })
    }
    const attempts = await tx.paymentAttempt.findMany({ where: { OR: or }, select: { id: true, orderId: true, stripeSessionId: true } })
    for (const attempt of attempts) add({ orderId: attempt.orderId, attemptId: attempt.id, sessionId: attempt.stripeSessionId })
  }
  if (target.kind === 'payment_intent') {
    const orders = await tx.printOrder.findMany({
      where: {
        OR: [
          { stripePaymentIntentId: target.id },
          { metadata: { path: ['paymentIntentId'], equals: target.id } },
          { metadata: { path: ['stripe', 'paymentIntentId'], equals: target.id } },
        ],
      },
      select: { id: true },
    })
    for (const order of orders) add({ orderId: order.id, attemptId: null, sessionId: null })
  }
  if (target.kind === 'invoice') {
    const orders = await tx.printOrder.findMany({
      where: { OR: [{ stripeInvoiceId: target.id }, { metadata: { path: ['stripeInvoice', 'invoiceId'], equals: target.id } }] },
      select: { id: true },
    })
    for (const order of orders) add({ orderId: order.id, attemptId: null, sessionId: null })
  }
  return [...found.values()].sort((a, b) => (a.orderId < b.orderId ? -1 : 1))
}

async function acquireLease(target: SyncTarget): Promise<Lease> {
  const deadline = Date.now() + maxWaitMs()
  let delay = 40
  for (;;) {
    const result = await prisma.$transaction(async (tx): Promise<Lease | 'busy'> => {
      const matches = await findMatches(tx, target)
      const orderIds = matches.map((m) => m.orderId)
      if (orderIds.length === 0) return { id: null, orderIds, matches }
      await lockOrders(tx, orderIds)
      // Expiry is judged with the DATABASE clock (the same clock for every process and server), never with the clock of the
      // application: a server whose clock is a minute off must not shorten or lengthen anybody's permission. The timestamp
      // columns hold UTC, like the rest of the schema.
      const busy = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM "PrintOrder"
        WHERE "id" IN (${Prisma.join(orderIds)}) AND "paymentSyncLeaseId" IS NOT NULL
          AND "paymentSyncLeaseUntil" > (clock_timestamp() AT TIME ZONE 'UTC')`
      if (Number(busy[0]?.n ?? 0) > 0) return 'busy'
      const id = randomUUID()
      await tx.$executeRaw`
        UPDATE "PrintOrder"
        SET "paymentSyncLeaseId" = ${id},
            "paymentSyncLeaseUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + (${leaseTtlMs()}::double precision / 1000.0) * interval '1 second'
        WHERE "id" IN (${Prisma.join(orderIds)})`
      return { id, orderIds, matches }
    }, { maxWait: 10_000, timeout: 15_000 })
    if (result !== 'busy') return result
    if (Date.now() >= deadline) {
      incrementMetric('payment_sync_busy_total')
      throw new PaymentSyncBusyError()
    }
    await sleep(delay)
    delay = Math.min(delay * 2, 400)
  }
}

async function releaseLease(lease: Lease) {
  if (!lease.id) return
  try {
    await prisma.printOrder.updateMany({
      where: { id: { in: lease.orderIds }, paymentSyncLeaseId: lease.id },
      data: { paymentSyncLeaseId: null, paymentSyncLeaseUntil: null },
    })
  } catch (err) {
    // The lease expires by itself; nothing else to do.
    console.error('Could not release the payment sync lease (it will expire):', err)
  }
}

// ---- 2. read from Stripe (no transaction, no lock) --------------------------------------------------------------------------------
type Snapshot = {
  sessions: Map<string, Stripe.Checkout.Session>
  intent: Stripe.PaymentIntent | null
  invoice: Stripe.Invoice | null
}

async function readFromStripe(target: SyncTarget, matches: Match[]): Promise<Snapshot> {
  const stripe = getStripe()
  const snapshot: Snapshot = { sessions: new Map(), intent: null, invoice: null }

  const sessionIds = new Set<string>()
  if (target.kind === 'checkout_session' && matches.length > 0) sessionIds.add(target.id)
  if (target.kind === 'payment_intent') for (const m of matches) if (m.sessionId) sessionIds.add(m.sessionId)
  for (const id of sessionIds) {
    snapshot.sessions.set(id, await stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent.latest_charge'] }, { timeout: STRIPE_READ_TIMEOUT_MS }))
  }
  // Old-style payment (no hosted session): read the PaymentIntent itself. Also when nothing matches yet, so that job forms
  // and the reconciliation done when the order is created see the real state.
  if (target.kind === 'payment_intent' && (matches.length === 0 || matches.some((m) => !m.sessionId))) {
    snapshot.intent = await stripe.paymentIntents.retrieve(target.id, { expand: ['latest_charge', 'customer'] }, { timeout: STRIPE_READ_TIMEOUT_MS })
  }
  if (target.kind === 'invoice' && matches.length > 0) {
    snapshot.invoice = await stripe.invoices.retrieve(target.id, { expand: ['customer', 'payment_intent'] } as any, { timeout: STRIPE_READ_TIMEOUT_MS } as any)
  }
  return snapshot
}

function chargeFromIntent(intent: Stripe.PaymentIntent | null) {
  const latest = intent?.latest_charge
  if (!latest) return { chargeId: null, receiptUrl: null, refundedCents: 0, disputed: false }
  if (typeof latest === 'string') return { chargeId: latest, receiptUrl: null, refundedCents: 0, disputed: false }
  return { chargeId: latest.id, receiptUrl: latest.receipt_url || null, refundedCents: latest.amount_refunded || 0, disputed: Boolean(latest.disputed) }
}

// All the reads together must end before the permission could expire (a few calls, each with its own timeout and retries, could add
// up to more). If it takes too long nothing is applied: the event is not recorded and Stripe delivers it again.
async function readWithDeadline<T>(reading: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PaymentSyncReadTimeoutError()), readDeadlineMs())
  })
  try {
    return await Promise.race([reading, deadline])
  } finally {
    if (timer) clearTimeout(timer)
    reading.catch(() => {}) // a late failure of the abandoned reading must not become an unhandled rejection
  }
}

// ---- 3. apply --------------------------------------------------------------------------------------------------------------------
const ATTEMPT_MOVES: Record<AttemptStatus, string[]> = {
  open: [],
  processing: ['creating', 'open'],
  paid: ['creating', 'open', 'processing'],
  expired: ['creating', 'open'],
  failed: ['creating', 'open', 'processing'],
  mismatch: ['creating', 'open', 'processing', 'failed', 'expired'],
}
const canMoveAttempt = (from: string, to: AttemptStatus) => ATTEMPT_MOVES[to].includes(from)

function hasAddress(value: unknown) {
  const record = asRecord(value)
  return typeof record.line1 === 'string' && record.line1.trim().length > 0
}

type OrderOutcome = { updated: boolean; paidNow: boolean; released: boolean; refreshReceipt: boolean; paymentStatus: string }

async function applyToOrder(
  tx: Tx,
  match: Match,
  target: SyncTarget,
  snapshot: Snapshot,
  readStartedAt: Date,
  eventType: string,
): Promise<OrderOutcome> {
  const order = await tx.printOrder.findUniqueOrThrow({ where: { id: match.orderId } })
  const attempts = await tx.paymentAttempt.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })
  const hosted = attempts.length > 0 || asRecord(order.metadata).source === 'stripe_checkout'
  const facts = { id: order.id, totalCents: order.totalCents, currency: order.currency }

  // ---- which Stripe object describes this order's payment, and what does it say
  const sessionId = target.kind === 'checkout_session' ? target.id : match.sessionId
  let verdict: PaymentVerdict
  let attempt: PaymentAttempt | null = null
  let session: Stripe.Checkout.Session | null = null
  let intent: Stripe.PaymentIntent | null = null
  let invoice: Stripe.Invoice | null = null

  if (target.kind === 'invoice') {
    invoice = snapshot.invoice
    verdict = invoice ? verifyInvoice(facts, invoice as any) : { outcome: 'unpaid', paymentIntentId: null, stripeStatus: 'unknown' }
  } else if (sessionId && snapshot.sessions.has(sessionId)) {
    session = snapshot.sessions.get(sessionId) as Stripe.Checkout.Session
    attempt = attempts.find((a) => a.stripeSessionId === session!.id)
      ?? attempts.find((a) => a.id === session!.metadata?.attemptId && !a.stripeSessionId)
      ?? null
    intent = typeof session.payment_intent === 'object' ? session.payment_intent : null
    verdict = verifyCheckoutSession(facts, attempt, session as any)
  } else {
    intent = snapshot.intent
    attempt = intent
      ? attempts.find((a) => a.stripePaymentIntentId === intent!.id) ?? attempts.find((a) => a.id === intent!.metadata?.attemptId) ?? null
      : null
    verdict = intent
      ? verifyPaymentIntent(facts, intent as any, { attempt, requireOrderReference: hosted })
      : { outcome: 'unpaid', paymentIntentId: null, stripeStatus: 'unknown' }
  }

  // An attempt tied to one payment cannot be used for another.
  if (attempt?.stripePaymentIntentId && verdict.paymentIntentId && attempt.stripePaymentIntentId !== verdict.paymentIntentId && verdict.outcome !== 'mismatch') {
    verdict = { outcome: 'mismatch', reason: 'order_reference', paymentIntentId: verdict.paymentIntentId, detail: { attemptPaymentIntent: attempt.stripePaymentIntentId } }
  }
  // A payment that already belongs to another order cannot count for this one (and cannot be linked to it).
  const paymentIntentForLink = verdict.paymentIntentId ?? intent?.id ?? null
  const otherOwner = paymentIntentForLink
    ? await tx.printOrder.findFirst({ where: { stripePaymentIntentId: paymentIntentForLink, id: { not: order.id } }, select: { id: true } })
    : null
  if (otherOwner && verdict.paymentIntentId && ['paid', 'processing', 'authorized'].includes(verdict.outcome)) {
    verdict = { outcome: 'mismatch', reason: 'payment_already_used', paymentIntentId: verdict.paymentIntentId, detail: { otherOrderId: otherOwner.id } }
  }

  // ---- the delivery address Stripe collected (hosted checkout)
  let shippingProblem: ReviewReason | null = null
  const collected = verdict.outcome === 'paid' && session ? addressFromSession(session) : null
  if (verdict.outcome === 'paid' && order.shippingMethod === 'ship' && !hasAddress(order.shippingAddress)) {
    if (!collected || !collected.line1) shippingProblem = 'shipping_address_missing'
    else if (!isShippingCountryAllowed(collected.country)) shippingProblem = 'shipping_country'
  }

  const decision = decidePaymentUpdate(
    {
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentReviewReason: order.paymentReviewReason,
      stripePaymentIntentId: order.stripePaymentIntentId,
      hosted,
    },
    verdict,
    { shippingProblem },
  )

  // ---- write the order
  const charge = chargeFromIntent(intent)
  const sameKnownPayment = Boolean(intent) && intent!.id === order.stripePaymentIntentId
  const recordCharge = Boolean(intent) && (!hosted || verdict.outcome === 'paid' || sameKnownPayment)
  const data: Prisma.PrintOrderUncheckedUpdateInput = {
    paymentSyncedAt: readStartedAt,
    paymentSyncLeaseId: null,
    paymentSyncLeaseUntil: null,
  }
  let nextPaymentStatus = order.paymentStatus
  if (decision.paymentStatus && decision.paymentStatus !== order.paymentStatus) { data.paymentStatus = decision.paymentStatus; nextPaymentStatus = decision.paymentStatus }
  if (decision.status) data.status = decision.status
  if (decision.paidNow) data.paidAt = new Date()
  if (decision.review && !order.paymentReviewReason) data.paymentReviewReason = decision.review
  if (decision.linkPaymentIntentId) data.stripePaymentIntentId = decision.linkPaymentIntentId
  else if (!hosted && intent && !otherOwner) data.stripePaymentIntentId = intent.id // old flow: the order is tied to the payment it was matched with
  if (verdict.outcome === 'paid' && charge.disputed && !order.paymentReviewReason && !decision.review) data.paymentReviewReason = 'dispute'
  if (recordCharge) {
    data.stripeChargeId = charge.chargeId || undefined
    data.stripeCustomerId = (typeof intent!.customer === 'string' ? intent!.customer : intent!.customer?.id) || undefined
    data.receiptUrl = charge.receiptUrl || undefined
    data.refundedCents = charge.refundedCents
  }
  if (invoice) {
    data.stripeInvoiceId = invoice.id
    data.hostedInvoiceUrl = invoice.hosted_invoice_url || undefined
    data.invoicePdfUrl = invoice.invoice_pdf || undefined
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
    if (customerId) data.stripeCustomerId = customerId
    const invoicePi = verdict.paymentIntentId
    if (invoicePi) data.stripePaymentIntentId = invoicePi
  }
  if (session && verdict.outcome === 'paid') {
    const details = session.customer_details
    if (!order.customerEmail && details?.email) data.customerEmail = details.email
    if (!order.customerName && details?.name) data.customerName = details.name
    if (collected && collected.line1 && order.shippingMethod === 'ship' && !hasAddress(order.shippingAddress) && !shippingProblem) {
      data.shippingAddress = {
        name: collected.name, line1: collected.line1, line2: collected.line2, city: collected.city,
        state: collected.state, postalCode: collected.postalCode, country: collected.country,
      }
    }
  }

  // metadata: what Stripe said last, plus the reasons a person has to look at
  let metadata = asRecord(order.metadata)
  if (invoice) {
    metadata = asRecord(mergeStripeInvoiceMetadata(metadata, {
      invoiceId: invoice.id,
      invoiceStatus: invoice.status || null,
      paymentStatus: nextPaymentStatus,
      customerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null,
      hostedInvoiceUrl: invoice.hosted_invoice_url || null,
      invoicePdfUrl: invoice.invoice_pdf || null,
      paymentIntentId: verdict.paymentIntentId,
      eventType,
    }))
  } else if (intent && (recordCharge || !hosted)) {
    metadata = asRecord(mergeStripePaymentMetadata(metadata, {
      paymentIntentId: intent.id,
      paymentStatus: nextPaymentStatus,
      chargeId: charge.chargeId,
      receiptUrl: charge.receiptUrl,
      customerId: typeof intent.customer === 'string' ? intent.customer : intent.customer?.id || null,
      refundedCents: charge.refundedCents,
      eventType,
    }))
  }
  const reviewEntry = decision.review ?? (data.paymentReviewReason as ReviewReason | undefined) ?? null
  if (reviewEntry) {
    const prior = Array.isArray(metadata.paymentReview) ? metadata.paymentReview : []
    metadata = {
      ...metadata,
      paymentReview: [...prior.slice(-9), {
        reason: reviewEntry,
        at: new Date().toISOString(),
        eventType,
        sessionId: session?.id ?? null,
        paymentIntentId: verdict.paymentIntentId,
        orderTotalCents: order.totalCents,
        currency: order.currency,
        details: verdict.outcome === 'mismatch' ? verdict.detail : {},
      }],
    }
  }

  // ---- the attempt
  const attemptPatch: Prisma.PaymentAttemptUncheckedUpdateInput = {}
  if (attempt) {
    if (decision.attemptStatus && canMoveAttempt(attempt.status, decision.attemptStatus)) {
      attemptPatch.status = decision.attemptStatus
      if (decision.attemptStatus === 'paid') { attemptPatch.completedAt = new Date(); attemptPatch.amountReceivedCents = intent?.amount_received ?? undefined }
      if (decision.attemptStatus === 'processing') attemptPatch.completedAt = new Date()
      if (decision.attemptStatus === 'mismatch' && verdict.outcome === 'mismatch') attemptPatch.failureReason = verdict.reason
      if (decision.attemptStatus === 'failed') attemptPatch.failureReason = 'payment_canceled'
    }
    if (session && !attempt.stripeSessionId && verdict.outcome !== 'mismatch') attemptPatch.stripeSessionId = session.id
    if (intent && !attempt.stripePaymentIntentId && verdict.outcome !== 'mismatch') {
      const taken = await tx.paymentAttempt.findFirst({ where: { stripePaymentIntentId: intent.id, id: { not: attempt.id } }, select: { id: true } })
      if (!taken) attemptPatch.stripePaymentIntentId = intent.id
    }
  }

  // ---- an order is cancelled for an expired payment page only if nothing else could still bring the money
  if (verdict.outcome === 'expired' && attempt) {
    const after = attempts.map((a) => (a.id === attempt!.id ? { ...a, status: 'expired' } : a))
    if (mayCancelAfterExpiry(order, after, attempt.id, { staleReservationMs: JOIN_WINDOW_MS })) {
      data.status = 'cancelled'
      data.paymentStatus = 'canceled'
      nextPaymentStatus = 'canceled'
      metadata = { ...metadata, cancellation: { reason: 'checkout_expired', at: new Date().toISOString(), attemptId: attempt.id } }
    }
  }

  data.metadata = metadata as Prisma.InputJsonValue
  await tx.printOrder.update({ where: { id: order.id }, data })
  if (attempt && Object.keys(attemptPatch).length > 0) {
    await tx.paymentAttempt.update({ where: { id: attempt.id }, data: attemptPatch })
  }

  return {
    updated: true,
    paidNow: decision.paidNow,
    released: decision.release,
    refreshReceipt: !decision.paidNow && recordCharge && charge.refundedCents !== order.refundedCents,
    paymentStatus: nextPaymentStatus,
  }
}

async function commit(
  target: SyncTarget,
  ctx: { eventType: string; event?: Stripe.Event },
  lease: Lease,
  snapshot: Snapshot,
  readStartedAt: Date,
): Promise<PaymentSyncResult & { refreshReceiptIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    if (lease.orderIds.length > 0) {
      await lockOrders(tx, lease.orderIds)
      const holders = await tx.printOrder.findMany({ where: { id: { in: lease.orderIds } }, select: { paymentSyncLeaseId: true } })
      if (holders.some((holder) => holder.paymentSyncLeaseId !== lease.id)) throw new PaymentSyncLeaseLostError()
    }

    const empty = { duplicate: false, unmatched: lease.orderIds.length === 0, orderIds: lease.orderIds, updatedOrders: 0, paidOrderIds: [] as string[], releasedOrderIds: [] as string[], paymentStatus: null as string | null, refreshReceiptIds: [] as string[] }

    // The event is recorded in the SAME transaction as its effects: all or nothing.
    if (ctx.event) {
      const object = asRecord(ctx.event.data?.object)
      const claimed = await tx.stripeEvent.createMany({
        data: [{
          id: ctx.event.id,
          type: ctx.event.type,
          paymentIntentId: target.kind === 'payment_intent' ? target.id : (snapshot.intent?.id ?? (typeof object.payment_intent === 'string' ? object.payment_intent : null)),
          checkoutSessionId: target.kind === 'checkout_session' ? target.id : null,
          orderId: lease.orderIds[0] ?? null,
          payload: ctx.event as unknown as Prisma.InputJsonValue,
        }],
        skipDuplicates: true,
      })
      if (claimed.count === 0) {
        if (lease.id) await tx.printOrder.updateMany({ where: { id: { in: lease.orderIds }, paymentSyncLeaseId: lease.id }, data: { paymentSyncLeaseId: null, paymentSyncLeaseUntil: null } })
        return { ...empty, duplicate: true }
      }
    }

    // Old-style job forms follow the payment they were created with.
    if (snapshot.intent) {
      await tx.jobForm.updateMany({
        where: { paymentIntentId: snapshot.intent.id },
        data: { paymentStatus: normalizeStripePaymentStatus(snapshot.intent.status) || undefined },
      })
    }

    const result = { ...empty }
    for (const match of lease.matches) {
      const outcome = await applyToOrder(tx, match, target, snapshot, readStartedAt, ctx.eventType)
      result.updatedOrders += outcome.updated ? 1 : 0
      if (outcome.paidNow) result.paidOrderIds.push(match.orderId)
      if (outcome.released) result.releasedOrderIds.push(match.orderId)
      if (outcome.refreshReceipt) result.refreshReceiptIds.push(match.orderId)
      result.paymentStatus = result.paymentStatus ?? outcome.paymentStatus
    }
    return result
  }, { maxWait: 10_000, timeout: 20_000 })
}

// ---- the whole cycle ----------------------------------------------------------------------------------------------------------------
async function alreadyProcessed(eventId: string) {
  return Boolean(await prisma.stripeEvent.findUnique({ where: { id: eventId }, select: { id: true } }))
}

export async function syncPayment(target: SyncTarget, ctx: { eventType: string; event?: Stripe.Event }): Promise<PaymentSyncResult> {
  const duplicate: PaymentSyncResult = { duplicate: true, unmatched: false, orderIds: [], updatedOrders: 0, paidOrderIds: [], releasedOrderIds: [], paymentStatus: null }
  if (ctx.event && await alreadyProcessed(ctx.event.id)) return duplicate

  const lease = await acquireLease(target)
  let committed: PaymentSyncResult & { refreshReceiptIds: string[] }
  try {
    // another cycle for the same event may have finished while we waited for the lease
    if (ctx.event && await alreadyProcessed(ctx.event.id)) {
      await releaseLease(lease)
      return duplicate
    }
    const readStartedAt = new Date()
    const snapshot = await readWithDeadline(readFromStripe(target, lease.matches))
    await syncHooks.afterRead?.()
    committed = await commit(target, ctx, lease, snapshot, readStartedAt)
  } catch (err) {
    await releaseLease(lease)
    throw err
  }

  // After the commit. Nothing here can undo or repeat what was recorded; each effect is idempotent and retryable.
  for (const orderId of committed.paidOrderIds) {
    await runPostPaymentEffects(orderId)
  }
  if (committed.refreshReceiptIds.length > 0) {
    const { generateOrderReceiptBestEffort } = await import('@/lib/receipts/order-receipts')
    for (const orderId of committed.refreshReceiptIds) await generateOrderReceiptBestEffort(orderId, 'payment-sync')
  }
  if (committed.releasedOrderIds.length > 0) incrementMetric('orders_released_to_production_total', committed.releasedOrderIds.length)
  logEvent({
    event: 'payment.sync', level: 'info', target: target.kind, targetId: target.id, eventType: ctx.eventType,
    orders: committed.orderIds.length, released: committed.releasedOrderIds.length, duplicate: committed.duplicate,
  })
  const { refreshReceiptIds: _ignored, ...result } = committed
  void _ignored
  return result
}

// Payments Stripe told us about that no order claims (yet): the event is stored with orderId = null. Listed by the
// reconciliation script so that money received for something we do not know cannot go unnoticed.
export async function findUnmatchedPaymentEvents(limit = 100) {
  const candidates = await prisma.stripeEvent.findMany({
    where: { orderId: null, type: { in: ['payment_intent.succeeded', 'checkout.session.completed', 'invoice.paid'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, type: true, paymentIntentId: true, checkoutSessionId: true, createdAt: true },
  })
  const unmatched: typeof candidates = []
  for (const event of candidates) {
    // an order created after the event (old flow) is reconciled with Stripe when it is created, so it is no longer unmatched
    const claimed = event.paymentIntentId
      ? await prisma.printOrder.findFirst({
        where: { OR: [{ stripePaymentIntentId: event.paymentIntentId }, { metadata: { path: ['paymentIntentId'], equals: event.paymentIntentId } }] },
        select: { id: true },
      })
      : null
    if (!claimed) unmatched.push(event)
  }
  return unmatched
}
