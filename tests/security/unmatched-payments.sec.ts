// R1-3 / KLOSS hardening C (fix) - the read-only diagnostic of the payments that Stripe told us about (lib/unmatched-payments.ts), on the rows that real payments leave.
//
// A payment is RECONCILED only when the financial reference it is is persisted on an order that shows the payment: the order's own PaymentIntent column (a PaymentIntent), the attempt that
// carried the order's payment (a Checkout session without a PaymentIntent), the order's invoice column (an invoice). Nothing less proves it:
//   * C1 - a second PaymentIntent carried by an attempt of an order that was paid with ANOTHER one is not reconciled because the order says "paid": it is a payment to look at;
//   * C2 - an event the webhook stored WITH an order (orderId set) is looked at too: being tied to an order is not having its money recorded;
//   * C3 - what the event says about the money is kept apart: collected, not confirmed (a Checkout session completed whose payment is not paid, a PaymentIntent still processing), unknown.
// Isolated PostgreSQL, rows written the way the payment sync leaves them; nothing is called outside the database.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { describeUnmatchedPayments, diagnoseUnmatchedPayments, unmatchedPaymentsHooks } from '../../lib/unmatched-payments'
import { spawnSync } from 'node:child_process'

let seq = 0
const id = (prefix: string) => `${prefix}_FAKE_${Date.now().toString(36)}_${++seq}`
async function order(data: Record<string, unknown>) {
  return (await db()).printOrder.create({ data: { status: 'queued', paymentStatus: 'paid', paymentMethod: 'card', subtotalCents: 1000, totalCents: 1000, currency: 'EUR', paidAt: new Date(), ...data } as any })
}
async function attempt(orderId: string, data: Record<string, unknown>) {
  return (await db()).paymentAttempt.create({ data: { orderId, amountCents: 1000, currency: 'eur', status: 'paid', expiresAt: new Date(Date.now() + 3_600_000), ...data } as any })
}
// a stored webhook event, its object as Stripe signed it
async function event(type: string, object: Record<string, unknown>, data: { orderId?: string | null; paymentIntentId?: string | null; checkoutSessionId?: string | null } = {}) {
  const eventId = id('evt')
  await (await db()).stripeEvent.create({ data: { id: eventId, type, paymentIntentId: data.paymentIntentId ?? null, checkoutSessionId: data.checkoutSessionId ?? null, orderId: data.orderId ?? null, payload: { id: eventId, type, data: { object } } as any } })
  return eventId
}
const succeededIntent = (intentId: string, metadata: Record<string, string> = {}) => ({ id: intentId, object: 'payment_intent', status: 'succeeded', amount: 1000, amount_received: 1000, currency: 'eur', metadata })

test.beforeEach(async () => {
  await resetDb()
})

test('[HC-fix-C1] an order paid with PaymentIntent A, whose other attempt carries PaymentIntent B: B is NOT reconciled because the order is paid - it is a payment to look at', async () => {
  const a = id('pi')
  const b = id('pi')
  const paid = await order({ stripePaymentIntentId: a })
  await attempt(paid.id, { stripeSessionId: id('cs'), stripePaymentIntentId: a })
  await attempt(paid.id, { stripeSessionId: id('cs'), stripePaymentIntentId: b, status: 'mismatch' })
  await event('payment_intent.succeeded', succeededIntent(b, { orderId: paid.id }), { paymentIntentId: b })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual(report.candidates.map((candidate) => candidate.key), [b], 'B is reported: no order carries it as its payment')
})

test('[HC-fix-C2] an event stored WITH an order (orderId set) whose order does not show the payment (still processing) is looked at - tied to an order is not reconciled', async () => {
  const pi = id('pi')
  const waiting = await order({ status: 'awaiting_payment', paymentStatus: 'processing', paidAt: null, stripePaymentIntentId: pi })
  await event('payment_intent.succeeded', succeededIntent(pi, { orderId: waiting.id }), { paymentIntentId: pi, orderId: waiting.id })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual(report.candidates.map((candidate) => candidate.key), [pi], 'the payment is reported although its event names the order')
})

const keysOf = (report: Awaited<ReturnType<typeof diagnoseUnmatchedPayments>>) => report.candidates.map((candidate) => candidate.key)
const shapeOf = (report: Awaited<ReturnType<typeof diagnoseUnmatchedPayments>>) => report.candidates.map((candidate) => ({ key: candidate.key, state: candidate.state, money: candidate.money, claimed: candidate.claimedByOrders.length }))

test('[HC-fix-two-payments] A and B are two payments of the same order: A, the order\'s own (its column), is reconciled; B, carried only by another attempt, is a candidate claimed but not reconciled, its money collected', async () => {
  const a = id('pi')
  const b = id('pi')
  const paid = await order({ stripePaymentIntentId: a })
  await attempt(paid.id, { stripeSessionId: id('cs'), stripePaymentIntentId: a })
  await attempt(paid.id, { stripeSessionId: id('cs'), stripePaymentIntentId: b, status: 'mismatch' })
  await event('payment_intent.succeeded', succeededIntent(a, { orderId: paid.id }), { paymentIntentId: a, orderId: paid.id })
  await event('payment_intent.succeeded', succeededIntent(b, { orderId: paid.id }), { paymentIntentId: b, orderId: paid.id })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual(shapeOf(report), [{ key: b, state: 'claimed_not_reconciled', money: 'collected', claimed: 1 }])
  assert.deepEqual({ reconciled: report.reconciled, read: report.eventsRead, withoutOrder: report.eventsWithoutOrder }, { reconciled: 1, read: 2, withoutOrder: 0 })
})

test('[HC-fix-event-order-claim] the order the webhook tied an event to (its orderId) is a CLAIM even when nothing else on that order names the payment: claimed but not reconciled, never "recent" or "orphan"', async () => {
  const pi = id('pi')
  const named = await order({ status: 'awaiting_payment', paymentStatus: 'pending', paidAt: null, stripePaymentIntentId: null })
  await event('payment_intent.succeeded', succeededIntent(pi, { orderId: named.id }), { paymentIntentId: pi, orderId: named.id })
  const report = await diagnoseUnmatchedPayments({ now: new Date(Date.now() + 2 * 3_600_000) })
  assert.deepEqual(report.candidates.map((candidate) => ({ key: candidate.key, state: candidate.state, money: candidate.money, orders: candidate.claimedByOrders })), [{ key: pi, state: 'claimed_not_reconciled', money: 'collected', orders: [named.id] }])
})

test('[HC-fix-reference-only] what proves a reconciliation is the column, not a claim: a paid order that names the PaymentIntent or the invoice only in its metadata, or an attempt of an unpaid order, does not reconcile it', async () => {
  const flat = id('pi')
  const nested = id('pi')
  const invoice = id('in')
  const onAttempt = id('pi')
  await order({ stripePaymentIntentId: null, metadata: { paymentIntentId: flat } })
  await order({ stripePaymentIntentId: null, metadata: { stripe: { paymentIntentId: nested } } })
  await order({ paymentMethod: 'invoice', stripeInvoiceId: null, metadata: { stripeInvoice: { invoiceId: invoice } } })
  const unpaid = await order({ status: 'awaiting_payment', paymentStatus: 'pending', paidAt: null })
  await attempt(unpaid.id, { stripeSessionId: id('cs'), stripePaymentIntentId: onAttempt, status: 'paid' })
  await event('payment_intent.succeeded', succeededIntent(flat), { paymentIntentId: flat })
  await event('payment_intent.succeeded', succeededIntent(nested), { paymentIntentId: nested })
  await event('invoice.paid', { id: invoice, object: 'invoice', status: 'paid' })
  await event('payment_intent.succeeded', succeededIntent(onAttempt, { orderId: unpaid.id }), { paymentIntentId: onAttempt })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual(keysOf(report).sort(), [flat, nested, invoice, onAttempt].sort())
  assert.equal(report.reconciled, 0)
  assert.ok(report.candidates.every((candidate) => candidate.state === 'claimed_not_reconciled'))
})

test('[HC-fix-reconciled] reconciled by their own reference: a PaymentIntent on the column of a paid order, a Checkout session (no PaymentIntent in the event) whose attempt carried the order\'s payment, an invoice on the column of a paid order - counted, not reported; a refunded order counts too', async () => {
  const pi = id('pi')
  const session = id('cs')
  const sessionIntent = id('pi')
  const invoice = id('in')
  const refundedIntent = id('pi')
  await order({ stripePaymentIntentId: pi })
  const hosted = await order({ stripePaymentIntentId: sessionIntent })
  await attempt(hosted.id, { stripeSessionId: session, stripePaymentIntentId: sessionIntent })
  await order({ paymentMethod: 'invoice', stripeInvoiceId: invoice })
  await order({ stripePaymentIntentId: refundedIntent, paymentStatus: 'refunded', refundedCents: 1000 })
  await event('payment_intent.succeeded', succeededIntent(pi), { paymentIntentId: pi })
  await event('checkout.session.completed', { id: session, object: 'checkout.session', payment_status: 'paid', metadata: { orderId: hosted.id } }, { checkoutSessionId: session, orderId: hosted.id })
  await event('invoice.paid', { id: invoice, object: 'invoice', status: 'paid' })
  await event('payment_intent.succeeded', succeededIntent(refundedIntent), { paymentIntentId: refundedIntent })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual({ candidates: report.candidates.length, reconciled: report.reconciled, verdict: report.verdict }, { candidates: 0, reconciled: 4, verdict: 'no_candidate_in_database' })
})

test('[HC-fix-session-attempt-not-carrier] a Checkout session whose attempt is NOT the one that carried the order\'s payment (another PaymentIntent, or not paid) is not reconciled by it', async () => {
  const paidWith = id('pi')
  const session = id('cs')
  const paid = await order({ stripePaymentIntentId: paidWith })
  await attempt(paid.id, { stripeSessionId: session, stripePaymentIntentId: id('pi'), status: 'paid' })
  await event('checkout.session.completed', { id: session, object: 'checkout.session', payment_status: 'paid', metadata: { orderId: paid.id } }, { checkoutSessionId: session, orderId: paid.id })
  assert.deepEqual(shapeOf(await diagnoseUnmatchedPayments()), [{ key: session, state: 'claimed_not_reconciled', money: 'collected', claimed: 1 }])
})

test('[HC-fix-money] what the event says about the money is kept apart: a session completed with a delayed payment (unpaid) is "not_confirmed", a PaymentIntent still processing is "not_confirmed", an invoice not paid is "not_confirmed", a PaymentIntent "succeeded" with no amount received and an event that says nothing are "unknown", a payment one of whose events shows the money is "collected" - all reported, none as an income', async () => {
  const delayed = id('cs')
  const processing = id('pi')
  await event('checkout.session.completed', { id: delayed, object: 'checkout.session', payment_status: 'unpaid', metadata: {} }, { checkoutSessionId: delayed })
  await event('payment_intent.succeeded', { id: processing, object: 'payment_intent', status: 'processing', amount: 1000, amount_received: 0, metadata: {} }, { paymentIntentId: processing })
  const bare = await event('payment_intent.succeeded', { object: 'payment_intent' })
  const noAmount = id('pi')
  const openInvoice = id('in')
  const later = id('pi')
  await event('payment_intent.succeeded', { id: noAmount, object: 'payment_intent', status: 'succeeded', amount: 1000, metadata: {} }, { paymentIntentId: noAmount })
  await event('invoice.paid', { id: openInvoice, object: 'invoice', status: 'open', paid: false })
  await event('payment_intent.succeeded', { id: later, object: 'payment_intent', status: 'processing', amount: 1000, amount_received: 0, metadata: {} }, { paymentIntentId: later })
  await event('payment_intent.succeeded', succeededIntent(later), { paymentIntentId: later })
  const report = await diagnoseUnmatchedPayments()
  const byKey = Object.fromEntries(report.candidates.map((candidate) => [candidate.key, candidate.money]))
  assert.deepEqual(byKey, { [delayed]: 'not_confirmed', [processing]: 'not_confirmed', [`event:${bare}`]: 'unknown', [noAmount]: 'unknown', [openInvoice]: 'not_confirmed', [later]: 'collected' })
  const words = describeUnmatchedPayments(report)
  assert.match(words, /money not_confirmed/)
  assert.match(words, /not an income/)
})

test('[HC-fix-grouping] several events of ONE payment (its PaymentIntent, the session that carried it) are one candidate; a payment with no order at all is recent, then an orphan', async () => {
  const pi = id('pi')
  const session = id('cs')
  await event('payment_intent.succeeded', succeededIntent(pi, { checkoutId: 'legacy' }), { paymentIntentId: pi })
  await event('checkout.session.completed', { id: session, object: 'checkout.session', payment_intent: pi, payment_status: 'paid', metadata: {} }, { checkoutSessionId: session })
  await event('payment_intent.succeeded', succeededIntent(pi, { checkoutId: 'legacy' }), { paymentIntentId: pi })
  const now = await diagnoseUnmatchedPayments()
  assert.deepEqual(now.candidates.map((candidate) => ({ key: candidate.key, events: candidate.eventIds.length, types: candidate.eventTypes, state: candidate.state, origin: candidate.origin })), [{ key: pi, events: 3, types: ['checkout.session.completed', 'payment_intent.succeeded'], state: 'recent', origin: 'legacy_checkout' }])
  assert.deepEqual((await diagnoseUnmatchedPayments({ now: new Date(Date.now() + 2 * 3_600_000) })).candidates.map((candidate) => candidate.state), ['orphan'])
})

test('[HC-fix-no-webhook] a payment whose webhook never arrived leaves nothing here: the database says nothing of it - and the report says that this is not a statement about Stripe', async () => {
  await order({ stripePaymentIntentId: null, status: 'awaiting_payment', paymentStatus: 'pending', paidAt: null })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual({ candidates: report.candidates.length, stored: report.coverage.moneyEventsStored, verdict: report.verdict }, { candidates: 0, stored: 0, verdict: 'no_candidate_in_database' })
  const words = describeUnmatchedPayments(report)
  assert.match(words, /does NOT show that every Stripe payment is reconciled/)
  assert.match(words, /not a statement about Stripe/)
})

test('[HC-fix-read-only] the transaction of the diagnostic is REALLY read-only: a write attempted inside it is refused by PostgreSQL, and nothing changes', async () => {
  const pi = id('pi')
  const row = await order({ stripePaymentIntentId: pi })
  await event('payment_intent.succeeded', succeededIntent(pi), { paymentIntentId: pi })
  const before = JSON.stringify(await (await db()).printOrder.findMany({ orderBy: { id: 'asc' } }))
  unmatchedPaymentsHooks.insideTransaction = async (tx) => { await tx.printOrder.update({ where: { id: row.id }, data: { notes: 'written by the diagnostic' } }) }
  try {
    await assert.rejects(diagnoseUnmatchedPayments(), /read-only transaction|25006/)
  } finally {
    unmatchedPaymentsHooks.insideTransaction = null
  }
  assert.equal(JSON.stringify(await (await db()).printOrder.findMany({ orderBy: { id: 'asc' } })), before, 'nothing changed')
  assert.equal((await diagnoseUnmatchedPayments()).reconciled, 1, 'and without the seam it reads as before')
})

test('[HC-fix-command] the command: 1 with candidates (an event with an order included), 0 with none - with the limits said every time; 64 for a wrong use; 2 when it can not read', async () => {
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = process.env) => { const r = spawnSync('npx', ['tsx', 'scripts/unmatched-payments-check.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr } }
  const none = run()
  assert.equal(none.code, 0, none.err)
  assert.match(none.err, /does NOT show that every Stripe payment is reconciled/)
  const pi = id('pi')
  const waiting = await order({ status: 'awaiting_payment', paymentStatus: 'processing', paidAt: null, stripePaymentIntentId: pi })
  await event('payment_intent.succeeded', succeededIntent(pi, { orderId: waiting.id }), { paymentIntentId: pi, orderId: waiting.id })
  const some = run()
  assert.equal(some.code, 1, some.err)
  assert.deepEqual(JSON.parse(some.out).candidates.map((candidate: any) => [candidate.key, candidate.state, candidate.money]), [[pi, 'claimed_not_reconciled', 'collected']])
  assert.equal(run(['--recent-minutes', 'x']).code, 64)
  assert.equal(run([], { ...process.env, DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/does_not_exist_sectest' }).code, 2)
})
