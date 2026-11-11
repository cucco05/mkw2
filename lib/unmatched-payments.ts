// R1-3 / KLOSS hardening C - the payments that Stripe TOLD us about and that no order shows as its own: a READ-ONLY diagnostic (scripts/unmatched-payments-check.ts prints it).
//
// What it can say, and what it can NOT say:
//   * it reads ONLY this database - the webhook events the application stored (StripeEvent) and the orders and payment attempts that may claim them. A payment whose webhook never arrived
//     (the endpoint not subscribed, failing, not delivered yet) left NO row here: finding no candidate here proves NOTHING about Stripe. The payments themselves are checked at Stripe,
//     separately and with authorization (docs/RILASCIO-PRODUZIONE.md, section 20);
//   * it never decides who a payment belongs to, and it never changes anything: every query runs in ONE transaction that PostgreSQL itself keeps READ ONLY (a write in it is an error);
//   * EVERY money event is looked at - also one the webhook stored with an order: being tied to an order (orderId, an attempt) is a CLAIM, not the proof that its money is recorded;
//   * a payment is RECONCILED only when the very financial reference it is, is persisted on an order that shows the payment (paid, free or refunded):
//       - a PaymentIntent:                      an order whose `stripePaymentIntentId` IS it (an attempt that carries it, or a metadata key, is not enough: an order paid with ANOTHER
//                                               PaymentIntent does not reconcile this one);
//       - a Checkout session (no PaymentIntent): the attempt of that session is the one that carried the order's payment (paid, with the order's own PaymentIntent);
//       - an invoice:                           an order whose `stripeInvoiceId` IS it;
//     anything else is a CANDIDATE: claimed but not reconciled (`claimed_not_reconciled`), or claimed by nothing (`recent`, younger than the threshold - an order of the old flow, which
//     writes the order after the payment, may still claim it; `orphan`, older);
//   * what the event Stripe signed says about the MONEY is kept apart (`money`): `collected` (a PaymentIntent succeeded with an amount received, a Checkout session paid, an invoice
//     paid); `not_confirmed` (a session completed whose payment is not paid - a delayed method -, a PaymentIntent still processing or waiting for an action); `unknown` (the event does
//     not say). A candidate whose money is not confirmed or not known is a case to look at, never an income;
//   * a payment is reported ONCE, whatever number of events it has: grouped by the PaymentIntent, else the Checkout session, else the invoice, else the event;
//   * where it comes from, read from the keys of the metadata Stripe signed (never their values): `hosted_checkout` (orderId), `legacy_checkout` (checkoutId, the old card checkout),
//     `invoice`, `unknown`. A lead for a person, not a proof of whose the payment is.
// Nothing personal is reported: identifiers of Stripe objects, of events and of orders, types, times, counts.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { isPaymentVerified } from '@/lib/order-payment-policy'
import { normalizePaymentStatus } from '@/lib/orderworks-status'

// the payment events that may mean "money was collected" - the list findUnmatchedPaymentEvents (lib/payment-sync.ts) looks at
export const MONEY_EVENT_TYPES = ['payment_intent.succeeded', 'checkout.session.completed', 'invoice.paid'] as const
export const RECENT_DEFAULT_MS = 60 * 60 * 1000

export const UNMATCHED_PAYMENTS_LIMITS: readonly string[] = [
  'Only the payment events stored by the webhook are looked at. A payment whose webhook never arrived leaves no event here: finding no candidate does NOT show that every Stripe payment is reconciled.',
  'The payments themselves (above all the PaymentIntents of the old card checkout) are checked at Stripe, separately and with authorization, before the owner guard goes on (docs/RILASCIO-PRODUZIONE.md).',
  'Nothing here assigns a payment to anybody: who a payment belongs to is shown only by its proof, never by its amount, its currency or its customer.',
  'A payment is reconciled only when its own reference (the PaymentIntent, the session that carried the payment, the invoice) is on an order that shows the payment; an order or an attempt that merely claims it is not enough.',
  '"recent" candidates are younger than the threshold and may still be claimed by an order of the old flow; "orphan" ones are older and nothing claims them; "claimed_not_reconciled" ones are claimed, but no order carries them as its payment.',
  'A candidate whose money is "not_confirmed" or "unknown" is a case to look at, not an income: the event that was stored does not show that the money was collected.',
]

export type CandidateState = 'orphan' | 'recent' | 'claimed_not_reconciled'
export type CandidateMoney = 'collected' | 'not_confirmed' | 'unknown'
export type CandidateOrigin = 'hosted_checkout' | 'legacy_checkout' | 'invoice' | 'unknown'
export type UnmatchedCandidate = {
  key: string
  paymentIntentId: string | null
  checkoutSessionId: string | null
  invoiceId: string | null
  eventTypes: string[]
  eventIds: string[]
  firstSeenAt: string
  lastSeenAt: string
  origin: CandidateOrigin
  money: CandidateMoney
  state: CandidateState
  claimedByOrders: string[]
}
export type UnmatchedPaymentsReport = {
  generatedAt: string
  scope: 'database_only'
  recentThresholdMinutes: number
  coverage: { moneyEventsStored: number; latestMoneyEventAt: string | null }
  eventsRead: number
  eventsWithoutOrder: number
  reconciled: number
  candidates: UnmatchedCandidate[]
  verdict: 'candidates_to_reconcile' | 'no_candidate_in_database'
  limits: readonly string[]
}

// Test seam, null in production (the same kind as ownerGuardHooks): run INSIDE the diagnostic's transaction, right after it was made read-only - a test puts a write here to show that
// PostgreSQL refuses it.
export const unmatchedPaymentsHooks: { insideTransaction: null | ((tx: Prisma.TransactionClient) => Promise<void>) } = { insideTransaction: null }

type StoredEvent = { id: string; type: string; paymentIntentId: string | null; checkoutSessionId: string | null; orderId: string | null; createdAt: Date; payload: Prisma.JsonValue | null }
type Group = { key: string; paymentIntentId: string | null; checkoutSessionId: string | null; invoiceId: string | null; events: StoredEvent[] }

const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,255}$/
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,255}$/
const shaped = (value: unknown, pattern: RegExp): string | null => (typeof value === 'string' && pattern.test(value) ? value : null)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const objectOf = (event: StoredEvent) => record(record(record(event.payload).data).object)
const idOf = (value: unknown): unknown => (typeof value === 'string' ? value : record(value).id)
const PAGE = 500
const CHUNK = 200

// which Stripe objects an event is about (only what has the shape of an identifier is taken)
function identifiersOf(event: StoredEvent): { paymentIntentId: string | null; checkoutSessionId: string | null; invoiceId: string | null } {
  const object = objectOf(event)
  const kind = object.object
  return {
    paymentIntentId: shaped(event.paymentIntentId, PAYMENT_INTENT_ID) ?? (kind === 'payment_intent' ? shaped(object.id, PAYMENT_INTENT_ID) : null) ?? shaped(idOf(object.payment_intent), PAYMENT_INTENT_ID),
    checkoutSessionId: shaped(event.checkoutSessionId, CHECKOUT_SESSION_ID) ?? (kind === 'checkout.session' ? shaped(object.id, CHECKOUT_SESSION_ID) : null),
    invoiceId: (kind === 'invoice' ? shaped(object.id, INVOICE_ID) : null) ?? shaped(idOf(object.invoice), INVOICE_ID),
  }
}

// where a payment comes from, by the KEYS of the metadata Stripe signed (the values are never read out)
function originOf(events: StoredEvent[]): CandidateOrigin {
  let legacy = false
  let invoice = false
  for (const event of events) {
    const object = objectOf(event)
    const metadata = record(object.metadata)
    if (typeof metadata.orderId === 'string' && metadata.orderId) return 'hosted_checkout'
    if (object.object === 'invoice' || idOf(object.invoice)) invoice = true
    if (typeof metadata.checkoutId === 'string' && metadata.checkoutId) legacy = true
  }
  return invoice ? 'invoice' : legacy ? 'legacy_checkout' : 'unknown'
}

// what ONE stored event says about the money, from the object Stripe signed
const NOT_YET = new Set(['processing', 'requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'canceled'])
function moneyOfEvent(event: StoredEvent): CandidateMoney {
  const object = objectOf(event)
  if (object.object === 'payment_intent') {
    if (object.status === 'succeeded' && typeof object.amount_received === 'number' && object.amount_received > 0) return 'collected'
    return typeof object.status === 'string' && NOT_YET.has(object.status) ? 'not_confirmed' : 'unknown'
  }
  if (object.object === 'checkout.session') {
    if (object.payment_status === 'paid') return 'collected'
    return object.payment_status === 'unpaid' || object.payment_status === 'no_payment_required' ? 'not_confirmed' : 'unknown'
  }
  if (object.object === 'invoice') {
    if (object.status === 'paid' || object.paid === true) return 'collected'
    return typeof object.status === 'string' ? 'not_confirmed' : 'unknown'
  }
  return 'unknown'
}
// a payment's money is collected if one of its events shows it; not confirmed if one says so and none shows it collected; unknown otherwise
function moneyOf(events: StoredEvent[]): CandidateMoney {
  const seen = events.map(moneyOfEvent)
  return seen.includes('collected') ? 'collected' : seen.includes('not_confirmed') ? 'not_confirmed' : 'unknown'
}

const chunks = <T>(values: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK))
  return out
}
const paymentShown = (paymentStatus: string | null) => isPaymentVerified(paymentStatus) || normalizePaymentStatus(paymentStatus) === 'refunded'

export async function diagnoseUnmatchedPayments(input: { now?: Date; recentMs?: number } = {}): Promise<UnmatchedPaymentsReport> {
  const now = input.now ?? new Date()
  const recentMs = input.recentMs ?? RECENT_DEFAULT_MS
  if (!Number.isFinite(recentMs) || recentMs < 0) throw new TypeError('recentMs must be a non-negative number of milliseconds.')
  return prisma.$transaction(async (tx) => {
    // (the first statement of the transaction: from here on PostgreSQL refuses any write in it)
    await tx.$executeRaw`SET TRANSACTION READ ONLY`
    if (unmatchedPaymentsHooks.insideTransaction) await unmatchedPaymentsHooks.insideTransaction(tx)
    const types = [...MONEY_EVENT_TYPES]
    const stored = await tx.stripeEvent.aggregate({ where: { type: { in: types } }, _count: { _all: true }, _max: { createdAt: true } })

    // EVERY money event, with an order or without (a page at a time, never a cut list)
    const events: StoredEvent[] = []
    for (let cursor: { createdAt: Date; id: string } | null = null; ;) {
      const page: StoredEvent[] = await tx.stripeEvent.findMany({
        where: {
          type: { in: types },
          ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE,
        select: { id: true, type: true, paymentIntentId: true, checkoutSessionId: true, orderId: true, createdAt: true, payload: true },
      })
      events.push(...page)
      if (page.length < PAGE) break
      cursor = { createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id }
    }

    // one group per payment
    const groups = new Map<string, Group>()
    for (const event of events) {
      const ids = identifiersOf(event)
      const key = ids.paymentIntentId ?? ids.checkoutSessionId ?? ids.invoiceId ?? `event:${event.id}`
      const group = groups.get(key) ?? { key, paymentIntentId: null, checkoutSessionId: null, invoiceId: null, events: [] }
      group.paymentIntentId ??= ids.paymentIntentId
      group.checkoutSessionId ??= ids.checkoutSessionId
      group.invoiceId ??= ids.invoiceId
      group.events.push(event)
      groups.set(key, group)
    }
    const all = [...groups.values()]
    const intents = [...new Set(all.map((group) => group.paymentIntentId).filter((value): value is string => value !== null))]
    const sessions = [...new Set(all.map((group) => group.checkoutSessionId).filter((value): value is string => value !== null))]
    const invoices = [...new Set(all.map((group) => group.invoiceId).filter((value): value is string => value !== null))]

    // CLAIMS (who points at the payment: reported, never a proof) and PROOFS (the payment's own reference persisted on an order that shows it)
    const claims = new Map<string, Set<string>>() // stripe object id -> ids of the orders that claim it
    const claim = (objectId: string | null, orderId: string | null) => { if (objectId && orderId) claims.set(objectId, (claims.get(objectId) ?? new Set()).add(orderId)) }
    const proved = new Set<string>()                 // stripe object ids whose own reference is persisted on an order that shows the payment
    for (const part of chunks(intents)) {
      const rows = await tx.$queryRaw<Array<{ id: string; paymentStatus: string | null; column: string | null; flat: string | null; nested: string | null }>>`
        SELECT o."id", o."paymentStatus", o."stripePaymentIntentId" AS "column", o."metadata"->>'paymentIntentId' AS "flat", o."metadata"#>>'{stripe,paymentIntentId}' AS "nested"
        FROM "PrintOrder" AS o
        WHERE o."stripePaymentIntentId" = ANY(${part}::text[]) OR o."metadata"->>'paymentIntentId' = ANY(${part}::text[]) OR o."metadata"#>>'{stripe,paymentIntentId}' = ANY(${part}::text[])`
      for (const row of rows) {
        for (const value of [row.column, row.flat, row.nested]) if (value && part.includes(value)) claim(value, row.id)
        if (row.column && part.includes(row.column) && paymentShown(row.paymentStatus)) proved.add(row.column)
      }
      const attempts = await tx.paymentAttempt.findMany({ where: { stripePaymentIntentId: { in: part } }, select: { orderId: true, stripePaymentIntentId: true } })
      for (const attempt of attempts) claim(attempt.stripePaymentIntentId, attempt.orderId)
    }
    for (const part of chunks(sessions)) {
      const rows = await tx.$queryRaw<Array<{ orderId: string; session: string; status: string; attemptIntent: string | null; orderIntent: string | null; paymentStatus: string | null }>>`
        SELECT a."orderId", a."stripeSessionId" AS "session", a."status", a."stripePaymentIntentId" AS "attemptIntent", o."stripePaymentIntentId" AS "orderIntent", o."paymentStatus"
        FROM "PaymentAttempt" AS a JOIN "PrintOrder" AS o ON o."id" = a."orderId"
        WHERE a."stripeSessionId" = ANY(${part}::text[])`
      for (const row of rows) {
        claim(row.session, row.orderId)
        // the session carried the order's own payment: its attempt is paid with the PaymentIntent the order holds, and the order shows the payment
        if (row.status === 'paid' && row.attemptIntent && row.attemptIntent === row.orderIntent && paymentShown(row.paymentStatus)) proved.add(row.session)
      }
    }
    for (const part of chunks(invoices)) {
      const rows = await tx.$queryRaw<Array<{ id: string; paymentStatus: string | null; column: string | null; nested: string | null }>>`
        SELECT o."id", o."paymentStatus", o."stripeInvoiceId" AS "column", o."metadata"#>>'{stripeInvoice,invoiceId}' AS "nested"
        FROM "PrintOrder" AS o
        WHERE o."stripeInvoiceId" = ANY(${part}::text[]) OR o."metadata"#>>'{stripeInvoice,invoiceId}' = ANY(${part}::text[])`
      for (const row of rows) {
        for (const value of [row.column, row.nested]) if (value && part.includes(value)) claim(value, row.id)
        if (row.column && part.includes(row.column) && paymentShown(row.paymentStatus)) proved.add(row.column)
      }
    }

    const candidates: UnmatchedCandidate[] = []
    let reconciled = 0
    for (const group of all) {
      // the payment's OWN reference decides: its PaymentIntent if it has one, else its session, else its invoice
      const reference = group.paymentIntentId ?? group.checkoutSessionId ?? group.invoiceId
      if (reference && proved.has(reference)) { reconciled += 1; continue }
      const orders = [...new Set([
        ...[group.paymentIntentId, group.checkoutSessionId, group.invoiceId].flatMap((objectId) => (objectId ? [...(claims.get(objectId) ?? [])] : [])),
        ...group.events.map((event) => event.orderId).filter((value): value is string => typeof value === 'string' && value.length > 0),
      ])].sort()
      const times = group.events.map((event) => event.createdAt.getTime())
      const first = Math.min(...times)
      const last = Math.max(...times)
      const state: CandidateState = orders.length > 0 ? 'claimed_not_reconciled' : last > now.getTime() - recentMs ? 'recent' : 'orphan'
      candidates.push({
        key: group.key,
        paymentIntentId: group.paymentIntentId,
        checkoutSessionId: group.checkoutSessionId,
        invoiceId: group.invoiceId,
        eventTypes: [...new Set(group.events.map((event) => event.type))].sort(),
        eventIds: group.events.map((event) => event.id).sort(),
        firstSeenAt: new Date(first).toISOString(),
        lastSeenAt: new Date(last).toISOString(),
        origin: originOf(group.events),
        money: moneyOf(group.events),
        state,
        claimedByOrders: orders,
      })
    }
    candidates.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : a.key < b.key ? -1 : 1))
    return {
      generatedAt: now.toISOString(),
      scope: 'database_only' as const,
      recentThresholdMinutes: Math.round(recentMs / 60_000),
      coverage: { moneyEventsStored: stored._count._all, latestMoneyEventAt: stored._max.createdAt ? stored._max.createdAt.toISOString() : null },
      eventsRead: events.length,
      eventsWithoutOrder: events.filter((event) => !event.orderId).length,
      reconciled,
      candidates,
      verdict: candidates.length > 0 ? 'candidates_to_reconcile' as const : 'no_candidate_in_database' as const,
      limits: UNMATCHED_PAYMENTS_LIMITS,
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 60_000 })
}

// The words a person reads: what was found, and - ALWAYS - what this can not say.
export function describeUnmatchedPayments(report: UnmatchedPaymentsReport): string {
  const lines: string[] = []
  lines.push(`Payment events stored by the webhook: ${report.coverage.moneyEventsStored} (latest: ${report.coverage.latestMoneyEventAt ?? 'none'}). Read: ${report.eventsRead} (with no order: ${report.eventsWithoutOrder}); payments reconciled by their own reference: ${report.reconciled}.`)
  if (report.coverage.moneyEventsStored === 0) lines.push('No payment event was ever stored: either nothing was paid, or the webhook is not delivering - this report can not tell which.')
  if (report.candidates.length > 0) {
    lines.push(`${report.candidates.length} payment(s) to look at, in this database:`)
    for (const candidate of report.candidates) lines.push(`  - ${candidate.state} · money ${candidate.money} · ${candidate.origin} · ${candidate.key} · ${candidate.eventTypes.join(', ')} · first seen ${candidate.firstSeenAt}${candidate.claimedByOrders.length ? ` · claimed by ${candidate.claimedByOrders.join(', ')}` : ''}`)
  } else {
    lines.push('No candidate in THIS DATABASE. That is not a statement about Stripe:')
  }
  for (const limit of report.limits) lines.push(`  * ${limit}`)
  return lines.join('\n')
}
