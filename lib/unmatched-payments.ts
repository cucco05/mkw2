// R1-3 / KLOSS hardening C - the payments that Stripe TOLD us about and that no order shows: a READ-ONLY diagnostic (scripts/unmatched-payments-check.ts prints it).
//
// What it can say, and what it can NOT say:
//   * it reads ONLY this database - the webhook events the application stored (StripeEvent) and the orders and payment attempts that may claim them. A payment whose webhook never arrived
//     (the endpoint not subscribed, failing, not delivered yet) left NO row here: finding no candidate here proves NOTHING about Stripe. The payments themselves are checked at Stripe,
//     separately and with authorization (docs/RILASCIO-PRODUZIONE.md, "Checkout legacy accanto al guard del proprietario");
//   * it never decides who a payment belongs to, and it never changes anything: every query runs in ONE transaction that PostgreSQL itself keeps READ ONLY (a write in it is an error);
//   * a payment is reported ONCE, whatever number of events it has (a PaymentIntent, then the Checkout session that carried it, ...): grouped by the PaymentIntent, else the Checkout
//     session, else the invoice, else the event;
//   * the states:
//       - `orphan`            nothing in the database claims it, and it is older than the threshold;
//       - `recent`            nothing claims it YET: younger than the threshold, so an order of the old flow (which writes the order after the payment) may still claim it;
//       - `claimed_not_paid`  an order or a payment attempt claims it, but no claiming order shows a verified payment: it still has to be reconciled (the payment sync, D10);
//       - reconciled          a claiming order shows the payment (paid, free or refunded): not a candidate, only counted;
//   * where it comes from, read from the event Stripe signed (the keys of the object's metadata, never their values): `hosted_checkout` (orderId), `legacy_checkout` (checkoutId, the
//     old card checkout), `invoice`, `unknown`. That is a lead for a person, not a proof of whose the payment is.
// Nothing personal is reported: identifiers of Stripe objects and of events, types, times, counts.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { isPaymentVerified } from '@/lib/order-payment-policy'
import { normalizePaymentStatus } from '@/lib/orderworks-status'

// the payment events that mean "money was collected" - the list findUnmatchedPaymentEvents (lib/payment-sync.ts) looks at
export const MONEY_EVENT_TYPES = ['payment_intent.succeeded', 'checkout.session.completed', 'invoice.paid'] as const
export const RECENT_DEFAULT_MS = 60 * 60 * 1000

export const UNMATCHED_PAYMENTS_LIMITS: readonly string[] = [
  'Only the payment events stored by the webhook are looked at. A payment whose webhook never arrived leaves no event here: finding no candidate does NOT show that every Stripe payment is reconciled.',
  'The payments themselves (above all the PaymentIntents of the old card checkout) are checked at Stripe, separately and with authorization, before the owner guard goes on (docs/RILASCIO-PRODUZIONE.md).',
  'Nothing here assigns a payment to anybody: who a payment belongs to is shown only by its proof, never by its amount, its currency or its customer.',
  '"recent" candidates are younger than the threshold and may still be claimed by an order of the old flow; "orphan" ones are older and nothing claims them; "claimed_not_paid" ones are claimed by an order or an attempt that does not show the payment.',
]

export type CandidateState = 'orphan' | 'recent' | 'claimed_not_paid'
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
  state: CandidateState
  claimedByOrders: string[]
}
export type UnmatchedPaymentsReport = {
  generatedAt: string
  scope: 'database_only'
  recentThresholdMinutes: number
  coverage: { moneyEventsStored: number; latestMoneyEventAt: string | null }
  eventsWithoutOrder: number
  reconciled: number
  candidates: UnmatchedCandidate[]
  verdict: 'candidates_to_reconcile' | 'no_candidate_in_database'
  limits: readonly string[]
}

type StoredEvent = { id: string; type: string; paymentIntentId: string | null; checkoutSessionId: string | null; createdAt: Date; payload: Prisma.JsonValue | null }
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
    const types = [...MONEY_EVENT_TYPES]
    const stored = await tx.stripeEvent.aggregate({ where: { type: { in: types } }, _count: { _all: true }, _max: { createdAt: true } })

    // every money event that was stored with no order (all of them: a page at a time, never a cut list)
    const events: StoredEvent[] = []
    for (let cursor: { createdAt: Date; id: string } | null = null; ;) {
      const page: StoredEvent[] = await tx.stripeEvent.findMany({
        where: {
          orderId: null,
          type: { in: types },
          ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE,
        select: { id: true, type: true, paymentIntentId: true, checkoutSessionId: true, createdAt: true, payload: true },
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

    // who claims them: the same links the payment sync follows (lib/payment-sync.ts, findMatches) - an order's PaymentIntent (column or metadata), an attempt's PaymentIntent or Checkout
    // session, an order's invoice (column or metadata)
    const intents = [...new Set([...groups.values()].map((group) => group.paymentIntentId).filter((value): value is string => value !== null))]
    const sessions = [...new Set([...groups.values()].map((group) => group.checkoutSessionId).filter((value): value is string => value !== null))]
    const invoices = [...new Set([...groups.values()].map((group) => group.invoiceId).filter((value): value is string => value !== null))]
    const claims = new Map<string, Set<string>>() // stripe object id -> ids of the orders that claim it
    const claim = (objectId: string | null, orderId: string) => { if (objectId) claims.set(objectId, (claims.get(objectId) ?? new Set()).add(orderId)) }
    for (const part of chunks(intents)) {
      const rows = await tx.$queryRaw<Array<{ id: string; column: string | null; flat: string | null; nested: string | null }>>`
        SELECT o."id", o."stripePaymentIntentId" AS "column", o."metadata"->>'paymentIntentId' AS "flat", o."metadata"#>>'{stripe,paymentIntentId}' AS "nested"
        FROM "PrintOrder" AS o
        WHERE o."stripePaymentIntentId" = ANY(${part}::text[]) OR o."metadata"->>'paymentIntentId' = ANY(${part}::text[]) OR o."metadata"#>>'{stripe,paymentIntentId}' = ANY(${part}::text[])`
      for (const row of rows) for (const value of [row.column, row.flat, row.nested]) if (value && part.includes(value)) claim(value, row.id)
      const attempts = await tx.paymentAttempt.findMany({ where: { stripePaymentIntentId: { in: part } }, select: { orderId: true, stripePaymentIntentId: true } })
      for (const attempt of attempts) claim(attempt.stripePaymentIntentId, attempt.orderId)
    }
    for (const part of chunks(sessions)) {
      const attempts = await tx.paymentAttempt.findMany({ where: { stripeSessionId: { in: part } }, select: { orderId: true, stripeSessionId: true } })
      for (const attempt of attempts) claim(attempt.stripeSessionId, attempt.orderId)
    }
    for (const part of chunks(invoices)) {
      const rows = await tx.$queryRaw<Array<{ id: string; column: string | null; nested: string | null }>>`
        SELECT o."id", o."stripeInvoiceId" AS "column", o."metadata"#>>'{stripeInvoice,invoiceId}' AS "nested"
        FROM "PrintOrder" AS o
        WHERE o."stripeInvoiceId" = ANY(${part}::text[]) OR o."metadata"#>>'{stripeInvoice,invoiceId}' = ANY(${part}::text[])`
      for (const row of rows) for (const value of [row.column, row.nested]) if (value && part.includes(value)) claim(value, row.id)
    }
    const claimingOrders = [...new Set([...claims.values()].flatMap((set) => [...set]))]
    const shown = new Set<string>()
    for (const part of chunks(claimingOrders)) {
      const rows = await tx.printOrder.findMany({ where: { id: { in: part } }, select: { id: true, paymentStatus: true } })
      for (const row of rows) if (paymentShown(row.paymentStatus)) shown.add(row.id)
    }

    const candidates: UnmatchedCandidate[] = []
    let reconciled = 0
    for (const group of groups.values()) {
      const orders = [...new Set([group.paymentIntentId, group.checkoutSessionId, group.invoiceId].flatMap((id) => (id ? [...(claims.get(id) ?? [])] : [])))].sort()
      if (orders.some((orderId) => shown.has(orderId))) { reconciled += 1; continue }
      const times = group.events.map((event) => event.createdAt.getTime())
      const first = Math.min(...times)
      const last = Math.max(...times)
      const state: CandidateState = orders.length > 0 ? 'claimed_not_paid' : last > now.getTime() - recentMs ? 'recent' : 'orphan'
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
      eventsWithoutOrder: events.length,
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
  lines.push(`Payment events stored by the webhook: ${report.coverage.moneyEventsStored} (latest: ${report.coverage.latestMoneyEventAt ?? 'none'}). Stored with no order: ${report.eventsWithoutOrder}; reconciled since: ${report.reconciled}.`)
  if (report.coverage.moneyEventsStored === 0) lines.push('No payment event was ever stored: either nothing was paid, or the webhook is not delivering - this report can not tell which.')
  if (report.candidates.length > 0) {
    lines.push(`${report.candidates.length} payment(s) to reconcile, in this database:`)
    for (const candidate of report.candidates) lines.push(`  - ${candidate.state} · ${candidate.origin} · ${candidate.key} · ${candidate.eventTypes.join(', ')} · first seen ${candidate.firstSeenAt}${candidate.claimedByOrders.length ? ` · claimed by ${candidate.claimedByOrders.join(', ')}` : ''}`)
  } else {
    lines.push('No candidate in THIS DATABASE. That is not a statement about Stripe:')
  }
  for (const limit of report.limits) lines.push(`  * ${limit}`)
  return lines.join('\n')
}
