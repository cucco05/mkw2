// S4 regression tests – Stripe webhook reliability: idempotent, retry-safe, concurrency-safe.
// Stripe is a fake and the database is an isolated throw-away one: no network, no real payment.
//
// What must hold:
//   * an event is applied once, however many times it is delivered (also when delivered at the same time);
//   * if processing fails NOTHING is left behind (no "processed" record) and the retry processes the event for real;
//   * the HTTP answer is 2xx only when the event was processed, already processed, or is not relevant;
//   * out-of-order / concurrent events converge on Stripe's latest state; an unverified payment never releases production (S5).
import { db, installFakeStripe, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { recordCustomerOrder } from '../../lib/orders'
import { syncStripePaymentIntent } from '../../lib/stripe-payments'

// ---- Fake Stripe state -----------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const stripeState = {
  intents: {} as Record<string, any>,
  invoices: {} as Record<string, any>,
  piReads: 0,
  invoiceReads: 0,
  delayMs: 0,
  failures: 0, // the next N reads fail with a temporary error
}
let stripe: any
let eventCounter = 0

// Like the real thing, a succeeded intent says how much was actually received.
const intent = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, object: 'payment_intent', status, amount: 5000, amount_received: status === 'succeeded' ? 5000 : 0, currency: 'usd', metadata: { checkoutId: 'chk_FAKE' },
  customer: null, latest_charge: { id: 'ch_FAKE', receipt_url: 'https://pay.stripe.test/receipt', amount_refunded: 0 }, ...extra,
})

async function stripeRead(kind: 'pi' | 'invoice', id: string) {
  if (kind === 'pi') stripeState.piReads += 1
  else stripeState.invoiceReads += 1
  if (stripeState.delayMs) await sleep(stripeState.delayMs)
  if (stripeState.failures > 0) {
    stripeState.failures -= 1
    throw new Error('simulated temporary Stripe outage: secret-internal-detail')
  }
  const found = kind === 'pi' ? stripeState.intents[id] : stripeState.invoices[id]
  if (!found) throw new Error(`unknown fake ${kind} ${id}`)
  return found
}

function event(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  eventCounter += 1
  return { id: `evt_s4_${eventCounter}_${Math.random().toString(36).slice(2, 8)}`, object: 'event', type, data: { object }, ...extra }
}
const piEvent = (type: string, id: string, extra: Record<string, unknown> = {}) =>
  event(type, { id, object: 'payment_intent' }, extra)
const chargeEvent = (type: string, paymentIntent: string) =>
  event(type, { id: 'ch_FAKE', object: type === 'charge.refund.updated' ? 'refund' : 'charge', payment_intent: paymentIntent })
const invoiceEvent = (type: string, id: string) => event(type, { id, object: 'invoice' })

async function deliver(payloadObject: Record<string, unknown>, opts: { secret?: string; signed?: boolean } = {}) {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const payload = JSON.stringify(payloadObject)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.signed !== false) {
    headers['stripe-signature'] = stripe.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? (process.env.STRIPE_WEBHOOK_SECRET as string) })
  }
  const res = await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', headers, body: payload }), {}) as Response
  const text = await res.text()
  let json: any = {}
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text }
}

async function mkOrder(over: Record<string, unknown> = {}) {
  const prisma = await db()
  return prisma.printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', subtotalCents: 5000, totalCents: 5000,
      stripePaymentIntentId: 'pi_s4_FAKE', metadata: { paymentIntentId: 'pi_s4_FAKE' }, ...over,
    } as any,
  })
}
const orderNow = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id } })
const eventRows = async () => (await db()).stripeEvent.count()

async function reset() {
  const prisma = await db()
  await prisma.stripeEvent.deleteMany()
  await prisma.jobForm.deleteMany()
  await prisma.printOrder.deleteMany()
  stripeState.intents = {}
  stripeState.invoices = {}
  stripeState.piReads = 0
  stripeState.invoiceReads = 0
  stripeState.delayMs = 0
  stripeState.failures = 0
}

test.before(async () => {
  await resetDb()
  stripe = await installFakeStripe({
    'paymentIntents.retrieve': (id: string) => stripeRead('pi', id),
    'invoices.retrieve': (id: string) => stripeRead('invoice', id),
  })
})

// ---- Verification and relevance ---------------------------------------------------------------------
test('signature: missing, wrong or tampered signatures are rejected (400) and nothing is stored or read', async () => {
  await reset()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  assert.equal((await deliver(ev, { signed: false })).status, 400)
  assert.equal((await deliver(ev, { secret: 'whsec_WRONG' })).status, 400)
  // valid signature for a different body
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const header = stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(ev), secret: process.env.STRIPE_WEBHOOK_SECRET })
  const tampered = await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': header }, body: JSON.stringify({ ...ev, id: 'evt_tampered' }),
  }), {}) as Response
  assert.equal(tampered.status, 400)
  assert.equal(await eventRows(), 0)
  assert.equal(stripeState.piReads, 0)
})

test('relevance: unsupported events, malformed ids and live/test mismatches are acknowledged (200) but ignored', async () => {
  await reset()
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['unsupported type', event('customer.created', { id: 'cus_1', object: 'customer' }), 'unsupported_event_type'],
    ['unsupported but similar type', piEvent('payment_intent.created', 'pi_s4_FAKE'), 'unsupported_event_type'],
    ['malformed payment intent id', piEvent('payment_intent.succeeded', "pi_x'; DROP TABLE \"PrintOrder\";--"), 'invalid_payment_intent_id'],
    ['id of another kind', piEvent('payment_intent.succeeded', 'cus_123'), 'invalid_payment_intent_id'],
    ['malformed invoice id', invoiceEvent('invoice.paid', 'not-an-invoice'), 'invalid_invoice_id'],
    ['charge without payment intent', event('charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: null }), 'no_payment_intent'],
    ['live event on a test key', piEvent('payment_intent.succeeded', 'pi_s4_FAKE', { livemode: true }), 'livemode_mismatch'],
  ]
  for (const [label, ev, reason] of cases) {
    const res = await deliver(ev)
    assert.equal(res.status, 200, `${label} -> HTTP ${res.status}`)
    assert.equal(res.json.outcome, 'ignored', label)
    assert.equal(res.json.reason, reason, label)
  }
  assert.equal(await eventRows(), 0, 'ignored events must not be stored')
  assert.equal(stripeState.piReads + stripeState.invoiceReads, 0, 'ignored events must not call Stripe')
})

// ---- Processing, duplicates -------------------------------------------------------------------------
test('processed: the event record and the order update are committed together', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  const res = await deliver(ev)
  assert.equal(res.status, 200)
  assert.equal(res.json.outcome, 'processed')
  assert.equal(res.json.updatedOrders, 1)
  const after = await orderNow(order.id)
  assert.equal(after.paymentStatus, 'paid')
  assert.equal(after.status, 'queued', 'a Stripe-confirmed payment releases the order (S5 gate)')
  assert.equal((after.metadata as any).stripe.lastEventType, 'payment_intent.succeeded')
  assert.equal(await eventRows(), 1)
})

test('idempotent: the same event delivered again changes nothing and does not read Stripe again', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  await deliver(ev)
  const first = await orderNow(order.id)
  for (let i = 0; i < 3; i++) {
    const again = await deliver(ev)
    assert.equal(again.status, 200)
    assert.equal(again.json.outcome, 'duplicate')
    assert.equal(again.json.duplicate, true)
  }
  const last = await orderNow(order.id)
  assert.equal(last.updatedAt.getTime(), first.updatedAt.getTime(), 'a duplicate must not touch the order')
  assert.equal(stripeState.piReads, 1)
  assert.equal(await eventRows(), 1)
})

// ---- Failures and retries (the S4 bug) --------------------------------------------------------------
test('S4: a failed processing leaves nothing behind and the retry of the SAME event processes it', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')

  stripeState.failures = 1
  const failed = await deliver(ev)
  assert.equal(failed.status, 500, 'a failure must be answered with a non-2xx so Stripe retries')
  assert.deepEqual({ received: failed.json.received, error: failed.json.error, retry: failed.json.retry }, { received: false, error: 'processing_failed', retry: true })
  assert.ok(!failed.text.includes('secret-internal-detail'), 'internal error details must not be returned')
  assert.equal(await eventRows(), 0, 'a failed event must NOT be recorded as processed')
  assert.equal((await orderNow(order.id)).paymentStatus, 'pending')

  const retried = await deliver(ev) // Stripe re-sends the same event id
  assert.equal(retried.status, 200)
  assert.equal(retried.json.outcome, 'processed', 'the retry must do the work, not be called a duplicate')
  const after = await orderNow(order.id)
  assert.equal(after.paymentStatus, 'paid')
  assert.equal(after.status, 'queued')
  assert.equal(await eventRows(), 1)
  assert.equal(stripeState.piReads, 2)
})

test('transaction: a failure after partial writes rolls EVERYTHING back (no half-applied event)', async () => {
  await reset()
  const prisma = await db()
  const order = await mkOrder()
  await prisma.jobForm.create({ data: { paymentIntentId: 'pi_s4_FAKE', lineItems: [], totalCents: 5000, currency: 'usd', paymentStatus: 'pending' } })
  // The job record is updated first; the order update then fails on this invalid value -> must undo the job update too.
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded', { latest_charge: { id: 'ch_FAKE', receipt_url: null, amount_refunded: 'not-a-number' } })
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  const failed = await deliver(ev)
  assert.equal(failed.status, 500)
  assert.equal((await prisma.jobForm.findFirstOrThrow({ where: { paymentIntentId: 'pi_s4_FAKE' } })).paymentStatus, 'pending', 'job update was not rolled back')
  assert.equal((await orderNow(order.id)).paymentStatus, 'pending')
  assert.equal(await eventRows(), 0)

  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  const ok = await deliver(ev)
  assert.equal(ok.status, 200)
  assert.equal((await prisma.jobForm.findFirstOrThrow({ where: { paymentIntentId: 'pi_s4_FAKE' } })).paymentStatus, 'paid')
  assert.equal((await orderNow(order.id)).paymentStatus, 'paid')
  assert.equal(await eventRows(), 1)
})

test('repeated failures keep being retryable; the first success ends it', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  stripeState.failures = 3
  for (let i = 0; i < 3; i++) assert.equal((await deliver(ev)).status, 500, `attempt ${i + 1}`)
  assert.equal(await eventRows(), 0)
  assert.equal((await deliver(ev)).json.outcome, 'processed')
  assert.equal((await deliver(ev)).json.outcome, 'duplicate')
  assert.equal((await orderNow(order.id)).status, 'queued')
})

// ---- Concurrency ------------------------------------------------------------------------------------
test('concurrency: identical events at the same moment are applied exactly once', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  stripeState.delayMs = 300 // widen the race window
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  const results = await Promise.all(Array.from({ length: 5 }, () => deliver(ev)))
  assert.ok(results.every((r) => r.status === 200), `statuses: ${results.map((r) => r.status).join(',')}`)
  const outcomes = results.map((r) => r.json.outcome).sort()
  assert.deepEqual(outcomes, ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed'])
  assert.equal(stripeState.piReads, 1, 'only the winner may do the work')
  assert.equal(await eventRows(), 1)
  assert.equal((await orderNow(order.id)).status, 'queued')
})

test('concurrency + failure: if the winner fails, a waiting identical request takes over and succeeds', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  stripeState.delayMs = 300
  stripeState.failures = 1
  const ev = piEvent('payment_intent.succeeded', 'pi_s4_FAKE')
  const results = await Promise.all([deliver(ev), deliver(ev)])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 500])
  assert.equal(results.find((r) => r.status === 200)!.json.outcome, 'processed')
  assert.equal(stripeState.piReads, 2)
  assert.equal(await eventRows(), 1)
  assert.equal((await orderNow(order.id)).paymentStatus, 'paid')
})

test('concurrency: different events for the same payment converge on Stripe’s latest state', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  stripeState.delayMs = 150
  const results = await Promise.all([
    deliver(piEvent('payment_intent.processing', 'pi_s4_FAKE')),
    deliver(piEvent('payment_intent.succeeded', 'pi_s4_FAKE')),
    deliver(chargeEvent('charge.refunded', 'pi_s4_FAKE')),
  ])
  assert.ok(results.every((r) => r.status === 200 && r.json.outcome === 'processed'))
  const after = await orderNow(order.id)
  assert.equal(after.paymentStatus, 'paid')
  assert.equal(after.status, 'queued')
  assert.equal(await eventRows(), 3)
})

// ---- Out of order, other event kinds ----------------------------------------------------------------
test('out of order: a late "processing" event cannot regress an order that Stripe already shows as paid', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  await deliver(piEvent('payment_intent.succeeded', 'pi_s4_FAKE'))
  // an older event shows up late; the handler applies Stripe's CURRENT state, not the event's
  const late = await deliver(piEvent('payment_intent.processing', 'pi_s4_FAKE'))
  assert.equal(late.status, 200)
  const after = await orderNow(order.id)
  assert.equal(after.paymentStatus, 'paid')
  assert.equal(after.status, 'queued')
})

test('refund events update the refunded amount, once', async () => {
  await reset()
  const order = await mkOrder({ status: 'queued', paymentStatus: 'paid' })
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded', { latest_charge: { id: 'ch_FAKE', receipt_url: null, amount_refunded: 1200 } })
  const ev = chargeEvent('charge.refunded', 'pi_s4_FAKE')
  assert.equal((await deliver(ev)).json.outcome, 'processed')
  assert.equal((await orderNow(order.id)).refundedCents, 1200)
  assert.equal((await deliver(ev)).json.outcome, 'duplicate')
  const dispute = await deliver(event('charge.dispute.created', { id: 'dp_1', object: 'dispute', payment_intent: 'pi_s4_FAKE' }))
  assert.equal(dispute.json.outcome, 'processed')
})

test('invoice events: a paid invoice releases a waiting order; duplicates and failures behave like payments', async () => {
  await reset()
  const order = await mkOrder({ stripePaymentIntentId: null, paymentMethod: 'invoice', stripeInvoiceId: 'in_s4_FAKE', metadata: { stripeInvoice: { invoiceId: 'in_s4_FAKE' } } })
  stripeState.invoices.in_s4_FAKE = {
    id: 'in_s4_FAKE', object: 'invoice', status: 'open', customer: null, hosted_invoice_url: 'https://invoice.stripe.test/i', invoice_pdf: null, payment_intent: null,
  }
  assert.equal((await deliver(invoiceEvent('invoice.sent', 'in_s4_FAKE'))).json.outcome, 'processed')
  let current = await orderNow(order.id)
  assert.equal(current.status, 'awaiting_payment', 'an open invoice must not release production')
  assert.equal(current.paymentStatus, 'pending')

  // a paid invoice states what was paid, in which currency: that is what is compared with the order
  stripeState.invoices.in_s4_FAKE = { ...stripeState.invoices.in_s4_FAKE, status: 'paid', amount_paid: 5000, amount_due: 5000, currency: 'usd' }
  const paid = invoiceEvent('invoice.paid', 'in_s4_FAKE')
  stripeState.failures = 1
  assert.equal((await deliver(paid)).status, 500)
  assert.equal((await orderNow(order.id)).status, 'awaiting_payment', 'failed invoice event left a trace')
  assert.equal((await deliver(paid)).json.outcome, 'processed')
  current = await orderNow(order.id)
  assert.equal(current.paymentStatus, 'paid')
  assert.equal(current.status, 'queued')
  assert.equal((await deliver(paid)).json.outcome, 'duplicate')
})

// ---- S5 compatibility -------------------------------------------------------------------------------
test('S5 gate: no webhook event for an unverified payment can release production', async () => {
  for (const [type, stripeStatus] of [
    ['payment_intent.processing', 'processing'],
    ['payment_intent.payment_failed', 'requires_payment_method'],
    ['payment_intent.canceled', 'canceled'],
    ['payment_intent.processing', 'requires_capture'],
  ] as const) {
    await reset()
    const order = await mkOrder()
    stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', stripeStatus)
    assert.equal((await deliver(piEvent(type, 'pi_s4_FAKE'))).status, 200)
    const after = await orderNow(order.id)
    assert.equal(after.status, 'awaiting_payment', `${type}/${stripeStatus} released the order`)
    assert.notEqual(after.paymentStatus, 'paid')
  }
})

test('S5 gate: a quote or an administrator-authorized order is not changed into something else by a payment event', async () => {
  await reset()
  const quote = await mkOrder({ status: 'awaiting_review', paymentMethod: 'quote', paymentStatus: 'quote', stripePaymentIntentId: 'pi_s4_quote', metadata: { paymentIntentId: 'pi_s4_quote' } })
  stripeState.intents.pi_s4_quote = intent('pi_s4_quote', 'processing')
  await deliver(piEvent('payment_intent.processing', 'pi_s4_quote'))
  assert.equal((await orderNow(quote.id)).status, 'awaiting_review')
})

// ---- Webhook faster than the order ------------------------------------------------------------------
test('event before the order exists: acknowledged, and the order is reconciled with Stripe when it is created', async () => {
  await reset()
  stripeState.intents.pi_s4_early = intent('pi_s4_early', 'succeeded')
  const early = await deliver(piEvent('payment_intent.succeeded', 'pi_s4_early'))
  assert.equal(early.status, 200)
  assert.equal(early.json.outcome, 'processed')
  assert.equal(early.json.updatedOrders, 0, 'nothing to update yet')

  // The browser then creates the order from a payment status it read BEFORE the payment finished.
  const order = await recordCustomerOrder({
    paymentIntentId: 'pi_s4_early', amountCents: 5000, currency: 'usd', lineItems: [], shipping: { method: 'pickup' },
    paymentMethod: 'card', paymentStatus: 'processing',
  })
  const after = await orderNow(order.id)
  assert.equal(after.paymentStatus, 'paid', 'the missed event must be recovered at order creation')
  assert.equal(after.status, 'queued')
})

test('order creation does not fail if Stripe cannot be reached for the reconciliation', async () => {
  await reset()
  stripeState.failures = 1
  stripeState.intents.pi_s4_down = intent('pi_s4_down', 'processing')
  const order = await recordCustomerOrder({
    paymentIntentId: 'pi_s4_down', amountCents: 5000, currency: 'usd', lineItems: [], shipping: { method: 'pickup' },
    paymentMethod: 'card', paymentStatus: 'processing',
  })
  assert.equal((await orderNow(order.id)).status, 'awaiting_payment')
})

// ---- Other callers of the sync ----------------------------------------------------------------------
test('admin/refund sync is transactional too: a failure changes nothing, success updates the order', async () => {
  await reset()
  const order = await mkOrder()
  stripeState.intents.pi_s4_FAKE = intent('pi_s4_FAKE', 'succeeded')
  stripeState.failures = 1
  await assert.rejects(() => syncStripePaymentIntent('pi_s4_FAKE', 'admin.sync'))
  assert.equal((await orderNow(order.id)).paymentStatus, 'pending')
  const ok = await syncStripePaymentIntent('pi_s4_FAKE', 'admin.sync')
  assert.equal(ok.updatedOrders, 1)
  assert.equal((await orderNow(order.id)).status, 'queued')
})
