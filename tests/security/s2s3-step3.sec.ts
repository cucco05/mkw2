// S2/S3 step 3 – recognising the payment: webhook for Stripe Checkout sessions, one verification for every payment path,
// Stripe read outside the database transaction, production started exactly once.
//
// What must hold:
//   * a payment counts only if it is for THIS order: right reference, money collected, EXACT amount, right currency;
//     anything else never marks the order paid and never releases it to production (and is shown to a person);
//   * the same holds for the old PaymentIntent flow and for administrator invoices (no way round the check);
//   * a paid order is recognised even if the customer's browser never comes back;
//   * duplicates, concurrent events and out-of-order events can not release an order twice and can not apply an older Stripe
//     state over a newer one - including states that go back and forth (failed -> retried, refund removed);
//   * an expired payment page cancels the order only if nothing could still pay it; a late payment is recorded, not lost;
//   * Stripe or PostgreSQL failing halfway leaves nothing behind and the retry completes the job;
//   * what happens after the payment (receipt, report, PrintLab, notifications) is retryable and never done twice.
// Fake Stripe (tests/security/_fake-checkout.ts), throw-away database, fake data.
import { db, resetDb, seedShopModel } from './_harness'
import { strongTestKey } from './_keys'
import { guestHeaders } from './_guest'
import { installFakeCheckout, type FakeSession } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { isProductionEligible } from '../../lib/order-payment-policy'
import { findUnmatchedPaymentEvents } from '../../lib/payment-sync'
import { syncStripePaymentIntent } from '../../lib/stripe-payments'
import { effectHooks, recoverPostPaymentEffects, runPostPaymentEffects } from '../../lib/order-effects'
import { findGuestToken, GUEST_ACCESS_COOKIE, GUEST_COOKIE_MAX_ORDERS, mergeGuestAccessCookie, parseGuestAccessCookieList, verifyGuestAccess } from '../../lib/guest-order-access'
import { buildEnvChecks } from '../../app/api/admin/env-check/route'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let stripe: any
let modelId = ''
let customerA: { id: string; email: string }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const viewerA = (): Viewer => ({ id: customerA.id, role: 'customer' })

// ---- environment --------------------------------------------------------------------------------------------------------------
const ENV_KEYS = ['CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'SHIPPING_FLAT_RATE_CENTS', 'NODE_ENV', 'BASE_URL',
  'HOSTED_CHECKOUT_ENABLED', 'LEGACY_CARD_CHECKOUT_ENABLED', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX',
  'PAYMENT_SYNC_MAX_WAIT_MS'] as const
type EnvValues = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>
const snapshotEnv = (): EnvValues => Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
function applyEnv(values: EnvValues) {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = values[key]
  }
}
const ORIGINAL = snapshotEnv()
const BASELINE: EnvValues = {
  ...ORIGINAL, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', TAX_MODE: undefined, TAX_RATE_PERCENT: undefined,
  HOSTED_CHECKOUT_ENABLED: undefined, LEGACY_CARD_CHECKOUT_ENABLED: undefined, PAYMENT_SYNC_MAX_WAIT_MS: '3000',
  CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000',
}
async function withEnv<T>(env: EnvValues, fn: () => Promise<T>): Promise<T> {
  const before = snapshotEnv()
  applyEnv({ ...before, ...env })
  try { return await fn() } finally { applyEnv(before) }
}

// ---- spies on the outside services the effects use ---------------------------------------------------------------------------------
const calls = { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 }
const original = { ...effectHooks }
let printlabFailures = 0
function installSpies() {
  effectHooks.printLabConfigured = (() => true) as any
  effectHooks.submitToPrintLab = (async () => {
    calls.printlab++
    if (printlabFailures > 0) { printlabFailures--; return { ok: false, submitted: [], errors: [{ message: 'PrintLab is down' }] } }
    return { ok: true, submitted: [], errors: [] }
  }) as any
  effectHooks.notifyDiscord = (async () => { calls.discord++; return true }) as any
  effectHooks.notifyPush = (async () => { calls.push++; return true }) as any
  effectHooks.consumeInventory = (async () => { calls.inventory++; return { ok: true, movements: 0 } }) as any
  effectHooks.receipt = (async (id: string) => { calls.receipt++; return original.receipt(id) }) as any
}

// ---- calling the checkout endpoints ----------------------------------------------------------------------------------------------
let ipSeq = 0
let keySeq = 0
const nextIp = () => `10.3.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
const newKey = () => strongTestKey(`step3-${++keySeq}`)
async function post(route: 'quote' | 'session', body: unknown, o: { viewer?: Viewer; headers?: Record<string, string> } = {}) {
  viewerGuards.getViewer = async () => o.viewer ?? null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const request = new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders(o.headers) },
    body: JSON.stringify(body),
  })
  const res = (await (mod.POST as any)(request, {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { res, json, text }
}
const cart = (over: Record<string, unknown> = {}) => ({
  items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' as 'pickup' | 'ship' }, rush: false, ...over,
})

// Quote, then "Pay": returns the order, its attempt and the Stripe session, exactly as the customer's browser would leave them.
async function startCheckout(o: { viewer?: Viewer; cartOver?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  const c = cart(o.cartOver)
  const quote = await post('quote', c, o)
  assert.equal(quote.res.status, 200, quote.text)
  const key = newKey()
  const r = await post('session', { checkoutKey: key, expectedTotalCents: quote.json.totalCents, ...c }, o)
  assert.equal(r.res.status, 200, r.text)
  const prisma = await db()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: r.json.orderId }, orderBy: { createdAt: 'desc' } })
  return { ...r, key, cart: c, orderId: r.json.orderId as string, total: quote.json.totalCents as number, attemptId: attempt.id, sessionId: attempt.stripeSessionId as string }
}

// ---- webhook delivery ----------------------------------------------------------------------------------------------------------------
let eventSeq = 0
const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_s3_${++eventSeq}_${Math.random().toString(36).slice(2, 8)}`, object: 'event', type, livemode: false, data: { object } })
const sessionEvent = (type: string, sessionId: string) => {
  const s: FakeSession | undefined = fake.sessions.get(sessionId)
  return evt(type, { id: sessionId, object: 'checkout.session', metadata: s?.metadata ?? {}, payment_intent: s?.payment_intent ?? null })
}
const piEvent = (type: string, piId: string) => evt(type, { id: piId, object: 'payment_intent', metadata: fake.intents.get(piId)?.metadata ?? {} })
const chargeEvent = (type: string, piId: string) => evt(type, { id: 'ch_x', object: 'charge', payment_intent: piId })

async function deliver(event: Record<string, unknown>) {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const payload = JSON.stringify(event)
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string })
  const res = (await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload,
  }), {})) as Response
  const text = await res.text()
  let json: any = {}
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

const orderOf = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id }, include: { paymentAttempts: { orderBy: { createdAt: 'asc' } } } })
const eventRows = async () => (await db()).stripeEvent.count()
const effectStatus = (order: { metadata: unknown }, kind: string) => (order.metadata as any)?.postPayment?.[kind]?.status

// An order of the OLD flow (no payment page, tied to a PaymentIntent), worth 10.00.
async function legacyOrder(piId: string, over: Record<string, unknown> = {}) {
  return (await db()).printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', subtotalCents: 1000, totalCents: 1000, currency: 'EUR',
      stripePaymentIntentId: piId, metadata: { paymentIntentId: piId }, ...over,
    } as any,
  })
}
const legacyIntent = (id: string, status: string, over: Record<string, unknown> = {}) => {
  const pi = {
    id, object: 'payment_intent', status, amount: 1000, amount_received: status === 'succeeded' ? 1000 : 0, currency: 'eur', metadata: {}, customer: null,
    latest_charge: { id: 'ch_legacy', receipt_url: 'https://pay.stripe.test/r', amount_refunded: 0, disputed: false }, ...over,
  }
  fake.intents.set(id, pi)
  return pi
}

let maxIdleSeen = 0
async function fresh() {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.stripeEvent.deleteMany()
  await prisma.rateLimit.deleteMany()
  maxIdleSeen = Math.max(maxIdleSeen, fake.state.maxIdleInTransaction)
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, {
    createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, unreachableBeforeCreate: 0, lostAnswerAfterCreate: 0, rejectCreate: false,
    delayMs: 0, amountTotalOverride: null, currencyOverride: null, retrieveFails: false, reads: [], failNextReads: 0, afterSnapshot: null, maxIdleInTransaction: 0,
    lastParams: null, allParams: [],
  })
  Object.assign(calls, { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 })
  printlabFailures = 0
  Object.assign(effectHooks, original)
  installSpies()
  applyEnv(BASELINE)
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  const a = await prisma.user.create({ data: { email: 'step3a@sectest.invalid', passwordHash: 'x', name: 'step3a', role: 'customer' } })
  customerA = { id: a.id, email: a.email }
  modelId = (await seedShopModel()).model.id
  fake = await installFakeCheckout()
  stripe = fake.stripe
  await fresh()
})
test.after(() => {
  Object.assign(effectHooks, original)
  applyEnv(ORIGINAL)
})

// ====================================================================================================================================
// the right payment
// ====================================================================================================================================
test('a payment is recognised even if the browser never comes back: paid, released once, details taken from Stripe, effects done', async () => {
  await fresh()
  const { orderId, sessionId, attemptId, total } = await startCheckout({ cartOver: { shipping: { method: 'ship' } } })
  assert.equal((await orderOf(orderId)).paymentStatus, 'pending')

  // the customer pays on Stripe's page and closes the browser: only the webhook tells us
  const { piId } = fake.pay(sessionId)
  const res = await deliver(sessionEvent('checkout.session.completed', sessionId))
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.outcome, 'processed')
  assert.equal(res.json.updatedOrders, 1)

  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
  assert.ok(order.paidAt)
  assert.equal(order.totalCents, total)
  assert.equal(order.stripePaymentIntentId, piId)
  assert.equal(order.paymentReviewReason, null)
  assert.equal(order.paymentSyncLeaseId, null)
  assert.ok(order.paymentSyncedAt)
  assert.equal(order.customerEmail, 'buyer@example.test')
  assert.equal(order.customerName, 'Mario Rossi')
  assert.deepEqual(order.shippingAddress, { name: 'Mario Rossi', line1: 'Via Roma 1', line2: null, city: 'Milano', state: 'MI', postalCode: '20100', country: 'IT' })
  assert.equal(isProductionEligible(order), true)

  const attempt = order.paymentAttempts.find((a) => a.id === attemptId)!
  assert.equal(attempt.status, 'paid')
  assert.equal(attempt.stripePaymentIntentId, piId)
  assert.equal(attempt.amountReceivedCents, total)
  assert.ok(attempt.completedAt)

  const stored = await (await db()).stripeEvent.findFirstOrThrow()
  assert.equal(stored.orderId, orderId)
  assert.equal(stored.checkoutSessionId, sessionId)

  assert.deepEqual(['receipt', 'report', 'inventory', 'printlab', 'notify'].map((k) => effectStatus(order, k)), ['done', 'done', 'skipped', 'done', 'done'])
  assert.equal(calls.printlab, 1)
  assert.equal(calls.discord, 1)
  assert.ok((order.metadata as any).artifacts?.manufacturabilityReport?.filePath, 'the production report is created at payment time')
})

test('the delivery address of a pickup order is not used; a registered customer keeps their own details', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout({ viewer: viewerA() })
  fake.pay(sessionId, { email: 'someone-else@example.test' })
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  const order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.shippingAddress, null)
  assert.equal(order.customerEmail, customerA.email, 'the account email is not replaced')
})

// ====================================================================================================================================
// a payment that is not the right one
// ====================================================================================================================================
type Ctx = { total: number; attemptId: string; orderId: string }
const WRONG: Array<[string, (c: Ctx) => Parameters<Fake['pay']>[1], string]> = [
  ['received less than the total', (c) => ({ received: c.total - 1 }), 'amount'],
  ['payment intent for less than the order', (c) => ({ amount: c.total - 100 }), 'amount'],
  ['received more than the total', (c) => ({ amount: c.total + 1 }), 'amount'],
  ['payment intent asked for more than the order but only the total was collected', (c) => ({ amount: c.total + 100, received: c.total }), 'amount'],
  ['payment in another currency', () => ({ currency: 'usd' }), 'currency'],
  ['payment intent of another order and another attempt', () => ({ piMetadata: { orderId: 'cm_some_other_order_0001', attemptId: 'whatever' } }), 'order_reference'],
  ['payment intent of another order, with the right attempt id', (c) => ({ piMetadata: { orderId: 'cm_some_other_order_0001', attemptId: c.attemptId } }), 'order_reference'],
  ['payment intent of this order, with another attempt id', (c) => ({ piMetadata: { orderId: c.orderId, attemptId: 'cm_some_other_attempt_01' } }), 'order_reference'],
  ['payment that Stripe only authorised, not collected', () => ({ piStatus: 'requires_capture', paymentStatus: 'paid' }), 'authorized'],
]
for (const [name, build, reason] of WRONG) {
  test(`not paid, not released, shown to a person: ${name}`, async () => {
    await fresh()
    const { orderId, sessionId, attemptId, total } = await startCheckout()
    const { piId } = fake.pay(sessionId, build({ total, attemptId, orderId }))
    // via the checkout session event AND via the payment intent event: no way round the check
    for (const event of [sessionEvent('checkout.session.completed', sessionId), piEvent('payment_intent.succeeded', piId), chargeEvent('charge.refunded', piId)]) {
      const res = await deliver(event)
      assert.equal(res.status, 200, res.text)
    }
    const order = await orderOf(orderId)
    assert.notEqual(order.paymentStatus, 'paid', name)
    assert.notEqual(order.status, 'queued', name)
    assert.equal(order.paidAt, null)
    assert.equal(isProductionEligible(order), false)
    assert.equal(calls.printlab, 0)
    assert.equal(calls.discord, 0)
    if (reason !== 'authorized') {
      assert.equal(order.paymentReviewReason, reason, name)
      assert.equal(order.paymentAttempts.find((a) => a.id === attemptId)!.status, 'mismatch')
      assert.ok((order.metadata as any).paymentReview.length >= 1, 'the details are on the order')
    }
  })
}

test('an order that already waits for a person is not released automatically, even by a correct payment', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  await (await db()).printOrder.update({ where: { id: orderId }, data: { paymentReviewReason: 'duplicate_payment' } })
  fake.pay(sessionId)
  assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'paid', 'the money is recorded')
  assert.equal(order.status, 'awaiting_payment', 'but production waits for the person who has to look at it')
  assert.equal(order.paymentReviewReason, 'duplicate_payment')
  assert.equal(calls.printlab, 0)
})

test('old-style payment that is still being processed for the wrong amount is flagged before it ever succeeds', async () => {
  await fresh()
  const order = await legacyOrder('pi_proc_wrong')
  legacyIntent('pi_proc_wrong', 'processing', { amount: 900 })
  assert.equal((await deliver(piEvent('payment_intent.processing', 'pi_proc_wrong'))).status, 200)
  const current = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(current.paymentReviewReason, 'amount')
  assert.equal(current.paymentStatus, 'pending')
  assert.equal(current.status, 'awaiting_payment')
})

test('what the checkout session itself says is compared too: amount, currency, reference', async () => {
  await fresh()
  for (const [tamper, reason] of [
    [(s: FakeSession) => { s.amount_total = s.amount_total - 1 }, 'amount'],
    [(s: FakeSession) => { s.currency = 'usd' }, 'currency'],
    [(s: FakeSession) => { s.client_reference_id = 'cm_another_order_000000001' }, 'session_reference'],
    [(s: FakeSession) => { s.metadata = { ...s.metadata, orderId: 'cm_another_order_000000001' } }, 'session_reference'],
    [(s: FakeSession) => { s.mode = 'subscription' }, 'mode'],
  ] as Array<[(s: FakeSession) => void, string]>) {
    await fresh()
    const { orderId, sessionId } = await startCheckout()
    fake.pay(sessionId)
    tamper(fake.sessions.get(sessionId)!)
    assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).status, 200)
    const order = await orderOf(orderId)
    assert.equal(order.paymentReviewReason, reason)
    assert.equal(order.paymentStatus, 'pending')
    assert.equal(order.status, 'awaiting_payment')
  }
})

test('a session that finishes without the money (a delayed payment method) is an anomaly, never a payment', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId, { piStatus: 'processing', paymentStatus: 'unpaid' })
  assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.status, 'awaiting_payment')
  assert.equal(order.paymentReviewReason, 'unpaid_completion')
  assert.equal(calls.printlab, 0)
})

test('a payment waiting for a person blocks new payment pages for that order', async () => {
  await fresh()
  const { orderId, sessionId, total, key, cart: c } = await startCheckout()
  fake.pay(sessionId, { received: total - 1 })
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  const calls0 = fake.state.createCalls
  // the customer presses "Pay" again with the same checkout
  const retry = await post('session', { checkoutKey: key, expectedTotalCents: total, ...c })
  assert.equal(retry.res.status, 409)
  assert.equal(retry.json.code, 'ORDER_NOT_PAYABLE')
  assert.equal(retry.json.reason, 'review')
  assert.equal(fake.state.createCalls, calls0, 'no new Stripe session')
})

test('a payment made with a session that is not ours is not accepted, even if it names our order and attempt', async () => {
  await fresh()
  const { orderId, attemptId, total } = await startCheckout()
  fake.sessions.set('cs_test_OTHER_1', {
    id: 'cs_test_OTHER_1', object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: total, currency: 'eur',
    client_reference_id: orderId, metadata: { orderId, attemptId }, payment_intent: null,
  })
  fake.pay('cs_test_OTHER_1')
  assert.equal((await deliver(sessionEvent('checkout.session.completed', 'cs_test_OTHER_1'))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.status, 'awaiting_payment')
  assert.equal(order.paymentReviewReason, 'session_reference')
})

test('a payment that belongs to another order cannot be counted twice', async () => {
  await fresh()
  const one = await startCheckout()
  const { piId } = fake.pay(one.sessionId)
  await deliver(sessionEvent('checkout.session.completed', one.sessionId))
  assert.equal((await orderOf(one.orderId)).paymentStatus, 'paid')
  // a second order whose session claims the very same PaymentIntent
  const two = await startCheckout({ cartOver: { items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] } })
  const stolen = fake.sessions.get(two.sessionId)!
  stolen.status = 'complete'; stolen.payment_status = 'paid'; stolen.payment_intent = piId
  const pi = fake.intents.get(piId)!
  pi.metadata = { orderId: two.orderId, attemptId: two.attemptId }
  pi.amount = stolen.amount_total; pi.amount_received = stolen.amount_total
  await deliver(sessionEvent('checkout.session.completed', two.sessionId))
  const second = await orderOf(two.orderId)
  assert.equal(second.paymentStatus, 'pending')
  assert.equal(second.paymentReviewReason, 'payment_already_used')
  assert.equal(second.status, 'awaiting_payment')
})

test('administrator invoices: a paid invoice of another amount or currency never releases an order', async () => {
  await fresh()
  const order = await legacyOrder('pi_unused', { stripePaymentIntentId: null, paymentMethod: 'invoice', stripeInvoiceId: 'in_s3_FAKE', metadata: { stripeInvoice: { invoiceId: 'in_s3_FAKE' } } })
  const invoice = (over: Record<string, unknown>) => (stripe.invoices.retrieve = async () => ({
    id: 'in_s3_FAKE', object: 'invoice', status: 'paid', customer: null, hosted_invoice_url: null, invoice_pdf: null, payment_intent: null,
    amount_paid: 1000, amount_due: 1000, currency: 'eur', ...over,
  }))
  for (const over of [{ amount_paid: 999 }, { amount_paid: 1001 }, { currency: 'usd' }]) {
    invoice(over)
    assert.equal((await deliver(evt('invoice.paid', { id: 'in_s3_FAKE', object: 'invoice' }))).status, 200)
    const current = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(current.status, 'awaiting_payment', JSON.stringify(over))
    assert.equal(current.paymentStatus, 'pending')
    assert.ok(current.paymentReviewReason)
    await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: null } })
  }
  invoice({})
  assert.equal((await deliver(evt('invoice.paid', { id: 'in_s3_FAKE', object: 'invoice' }))).status, 200)
  const done = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(done.paymentStatus, 'paid')
  assert.equal(done.status, 'queued')
})

// ====================================================================================================================================
// the delivery address
// ====================================================================================================================================
test('a paid order to an address outside Italy, or without an address, is paid but held for a person', async () => {
  for (const [address, reason] of [
    [{ name: 'Jean', address: { line1: '1 Rue X', city: 'Paris', postal_code: '75001', country: 'FR' } }, 'shipping_country'],
    [null, 'shipping_address_missing'],
  ] as Array<[Record<string, unknown> | null, string]>) {
    await fresh()
    const { orderId, sessionId } = await startCheckout({ cartOver: { shipping: { method: 'ship' } } })
    fake.pay(sessionId, { address })
    assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).status, 200)
    const order = await orderOf(orderId)
    assert.equal(order.paymentStatus, 'paid', 'the money was received and is recorded')
    assert.equal(order.status, 'awaiting_review', `held: ${reason}`)
    assert.equal(order.paymentReviewReason, reason)
    assert.equal(order.shippingAddress, null)
    assert.equal(calls.printlab, 0, 'production is not started')
  }
})

// ====================================================================================================================================
// exactly once
// ====================================================================================================================================
test('the same event delivered many times at once: one release, one set of effects, the rest are duplicates', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  const event = sessionEvent('checkout.session.completed', sessionId)
  const results = await Promise.all(Array.from({ length: 8 }, () => deliver(event)))
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)))
  assert.equal(results.filter((r) => r.json.outcome === 'processed').length, 1)
  assert.equal(results.filter((r) => r.json.outcome === 'duplicate').length, 7)
  assert.equal(await eventRows(), 1)
  const order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(calls.printlab, 1)
  assert.equal(calls.discord, 1)
  assert.equal(calls.receipt, 1)
})

test('different events for the same payment at once (session completed, payment succeeded, charge update, replays): released ONCE', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  const { piId } = fake.pay(sessionId)
  const events = [
    sessionEvent('checkout.session.completed', sessionId), piEvent('payment_intent.succeeded', piId), chargeEvent('charge.refund.updated', piId),
    sessionEvent('checkout.session.completed', sessionId), piEvent('payment_intent.succeeded', piId), sessionEvent('checkout.session.expired', sessionId),
  ]
  const results = await Promise.all(events.map((e) => deliver(e)))
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => [r.status, r.text.slice(0, 80)])))
  const order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(calls.printlab, 1, 'production must start once')
  assert.equal(calls.discord, 1)
  assert.equal(order.paymentAttempts.filter((a) => a.status === 'paid').length, 1)
  assert.equal(order.paymentSyncLeaseId, null)
})

test('events out of order: the payment intent first, then the session; stale "processing" and "expired" events after the payment', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  const { piId } = fake.pay(sessionId)
  // the intent is announced BEFORE the session (hint: the attempt id in its metadata)
  assert.equal((await deliver(piEvent('payment_intent.succeeded', piId))).json.outcome, 'processed')
  assert.equal((await orderOf(orderId)).status, 'queued')
  // late events that describe older moments: Stripe is asked again, so they change nothing
  assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).status, 200)
  assert.equal((await deliver(piEvent('payment_intent.processing', piId))).status, 200)
  assert.equal((await deliver(sessionEvent('checkout.session.expired', sessionId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentReviewReason, null)
  assert.equal(calls.printlab, 1)
})

test('a payment already held as paid is never turned back by a Stripe state that says otherwise; a person is told', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  const { piId } = fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  fake.intents.get(piId)!.status = 'processing' // impossible at Stripe; if it ever happens the order must not follow it
  fake.intents.get(piId)!.amount_received = 0
  await deliver(piEvent('payment_intent.processing', piId))
  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentReviewReason, 'status_regression')
})

// ====================================================================================================================================
// an older Stripe state can not overwrite a newer one
// ====================================================================================================================================
test('states that go back and forth: a slow read of an OLD state can not overwrite the NEWER one (failed, then retried)', async () => {
  await fresh()
  const order = await legacyOrder('pi_flap')
  legacyIntent('pi_flap', 'processing')
  let first = true
  let slowReadStarted = () => {}
  const started = new Promise<void>((resolve) => { slowReadStarted = resolve })
  // A reads "processing", then its answer is held back
  fake.state.afterSnapshot = async () => {
    if (!first) return
    first = false
    slowReadStarted()
    await sleep(300)
  }
  const a = deliver(piEvent('payment_intent.processing', 'pi_flap'))
  await started
  // meanwhile the payment fails, and a second event is processed
  fake.intents.get('pi_flap')!.status = 'requires_payment_method'
  const b = deliver(piEvent('payment_intent.payment_failed', 'pi_flap'))
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.status, 200, ra.text)
  assert.equal(rb.status, 200, rb.text)
  const current = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(current.paymentStatus, 'failed', 'the order must show what Stripe said LAST, not what was read first')
  assert.equal(fake.state.reads.length, 2)
  assert.equal(current.paymentSyncLeaseId, null)
})

test('the refunded amount can go DOWN (a refund fails): the later state wins, not the larger number', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  const { piId } = fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  const charge = fake.intents.get(piId)!.latest_charge
  charge.amount_refunded = 1500 // a refund is announced...
  let first = true
  let slowReadStarted = () => {}
  const started = new Promise<void>((resolve) => { slowReadStarted = resolve })
  fake.state.afterSnapshot = async () => { if (first) { first = false; slowReadStarted(); await sleep(300) } }
  const a = deliver(chargeEvent('charge.refunded', piId))
  await started
  charge.amount_refunded = 0 // ...and then it fails, before the first answer was even applied
  const b = deliver(chargeEvent('charge.refund.updated', piId))
  await Promise.all([a, b])
  assert.equal((await orderOf(orderId)).refundedCents, 0)
  // and the opposite direction
  fake.state.afterSnapshot = null
  charge.amount_refunded = 700
  await deliver(chargeEvent('charge.refunded', piId))
  assert.equal((await orderOf(orderId)).refundedCents, 700)
  charge.amount_refunded = 200
  await deliver(chargeEvent('charge.refund.updated', piId))
  assert.equal((await orderOf(orderId)).refundedCents, 200)
  assert.equal((await orderOf(orderId)).status, 'queued', 'a refund does not touch the production state')
})

test('while one update for an order runs, another for the same order waits; for another order it does not', async () => {
  await fresh()
  const one = await startCheckout()
  const two = await startCheckout({ cartOver: { items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] } })
  fake.pay(one.sessionId); fake.pay(two.sessionId)
  const timeline: string[] = []
  fake.state.afterSnapshot = async (_kind, id) => {
    timeline.push(`read:${id}`)
    if (id === one.sessionId && timeline.filter((e) => e === `read:${id}`).length === 1) await sleep(700)
  }
  const e1 = sessionEvent('checkout.session.completed', one.sessionId)
  const e1b = sessionEvent('checkout.session.expired', one.sessionId)
  const e2 = sessionEvent('checkout.session.completed', two.sessionId)
  const started = Date.now()
  const p1 = deliver(e1)
  await sleep(60)
  const p1b = deliver(e1b) // same order: must wait for p1
  const p2 = deliver(e2) // another order: must NOT wait
  const r2 = await p2
  const otherOrderTook = Date.now() - started
  await Promise.all([p1, p1b])
  assert.equal(r2.status, 200)
  assert.ok(otherOrderTook < 600, `an update for another order waited ${otherOrderTook} ms`)
  assert.equal(timeline.filter((e) => e === `read:${one.sessionId}`).length, 2, 'the second update read Stripe again, after the first had finished')
  assert.equal((await orderOf(one.orderId)).status, 'queued')
  assert.equal((await orderOf(two.orderId)).status, 'queued')
})

// ====================================================================================================================================
// expiry, late payments, a second payment
// ====================================================================================================================================
test('an expired payment page cancels the order only after Stripe confirms it expired and nothing else could pay', async () => {
  await fresh()
  const { orderId, sessionId, attemptId } = await startCheckout()
  fake.sessions.get(sessionId)!.status = 'expired'
  assert.equal((await deliver(sessionEvent('checkout.session.expired', sessionId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.paymentStatus, 'canceled')
  assert.equal(order.paymentAttempts.find((a) => a.id === attemptId)!.status, 'expired')
  assert.equal((order.metadata as any).cancellation.reason, 'checkout_expired')
  assert.equal(isProductionEligible(order), false)
})

test('an "expired" event for a page that Stripe now shows as PAID pays the order, it does not cancel it', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId) // the customer paid just before the expiry event arrived
  assert.equal((await deliver(sessionEvent('checkout.session.expired', sessionId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentStatus, 'paid')
})

test('an expired page does not cancel an order that has another page open, or a payment in progress', async () => {
  await fresh()
  const prisma = await db()
  // page 1 ends at Stripe; the same checkout asked again opens page 2 on the same order
  const first = await startCheckout()
  fake.sessions.get(first.sessionId)!.status = 'expired'
  const again = await post('session', { checkoutKey: first.key, expectedTotalCents: first.total, ...first.cart })
  assert.equal(again.res.status, 200)
  assert.equal(again.json.orderId, first.orderId)
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: first.orderId } }), 2)
  // ...and then the "expired" event for page 1 arrives while page 2 is open
  assert.equal((await deliver(sessionEvent('checkout.session.expired', first.sessionId))).status, 200)
  assert.equal((await orderOf(first.orderId)).status, 'awaiting_payment')

  // a payment in progress on another attempt of the same order
  const c = await startCheckout()
  await prisma.paymentAttempt.create({ data: { orderId: c.orderId, amountCents: c.total, currency: 'EUR', status: 'processing', expiresAt: new Date(Date.now() + 600_000) } })
  fake.sessions.get(c.sessionId)!.status = 'expired'
  await deliver(sessionEvent('checkout.session.expired', c.sessionId))
  assert.equal((await orderOf(c.orderId)).status, 'awaiting_payment')
})

test('a payment that arrives AFTER the order was cancelled is recorded and shown to a person; it never restarts production', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  await (await db()).printOrder.update({ where: { id: orderId }, data: { status: 'cancelled' } }) // cancelled by a person while the page was still open
  const { piId } = fake.pay(sessionId)
  assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'paid', 'the money is not lost: it is recorded')
  assert.ok(order.paidAt)
  assert.equal(order.stripePaymentIntentId, piId)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.paymentReviewReason, 'paid_after_cancel')
  assert.equal(calls.printlab, 0)
})

test('a second payment for an order already paid is recorded and flagged; production does not start twice', async () => {
  await fresh()
  const { orderId, sessionId, total } = await startCheckout()
  fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  // a second page for the same order, paid as well
  const prisma = await db()
  const attempt2 = await prisma.paymentAttempt.create({
    data: { orderId, amountCents: total, currency: 'EUR', status: 'open', stripeSessionId: 'cs_test_SECOND_1', expiresAt: new Date(Date.now() + 600_000) },
  })
  fake.sessions.set('cs_test_SECOND_1', {
    id: 'cs_test_SECOND_1', object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: total, currency: 'eur',
    client_reference_id: orderId, metadata: { orderId, attemptId: attempt2.id }, payment_intent: null,
  })
  fake.pay('cs_test_SECOND_1')
  await deliver(sessionEvent('checkout.session.completed', 'cs_test_SECOND_1'))
  const order = await orderOf(orderId)
  assert.equal(order.paymentReviewReason, 'duplicate_payment')
  assert.equal(order.status, 'queued')
  assert.equal(calls.printlab, 1)
  assert.equal(order.paymentAttempts.filter((a) => a.status === 'paid').length, 2)
})

test('a dispute is flagged for a person and changes nothing else', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  const { piId } = fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  fake.intents.get(piId)!.latest_charge.disputed = true
  await deliver(chargeEvent('charge.dispute.created', piId))
  const order = await orderOf(orderId)
  assert.equal(order.paymentReviewReason, 'dispute')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
})

// ====================================================================================================================================
// failures and recovery
// ====================================================================================================================================
test('Stripe unreachable while reading: 500, nothing recorded, no lease left behind; the retry completes the job', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  const event = sessionEvent('checkout.session.completed', sessionId)
  fake.state.failNextReads = 1
  const failed = await deliver(event)
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error, 'processing_failed')
  assert.ok(!failed.text.toLowerCase().includes('fake'), 'no provider details leak')
  assert.equal(await eventRows(), 0)
  let order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.status, 'awaiting_payment')
  assert.equal(order.paymentSyncLeaseId, null, 'the lease is released after a failure')
  const retry = await deliver(event)
  assert.equal(retry.json.outcome, 'processed')
  order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(calls.printlab, 1)
})

test('PostgreSQL failing while the result is written: everything rolls back, the lease is released, the retry completes', async () => {
  await fresh()
  const prisma = await db()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  const event = sessionEvent('checkout.session.completed', sessionId)
  await prisma.$executeRawUnsafe(`ALTER TABLE "PrintOrder" ADD CONSTRAINT "tmp_no_paid" CHECK ("paymentStatus" <> 'paid') NOT VALID`)
  try {
    const failed = await deliver(event)
    assert.equal(failed.status, 500)
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "PrintOrder" DROP CONSTRAINT "tmp_no_paid"`)
  }
  assert.equal(await eventRows(), 0, 'the event must not be recorded when its effects were not')
  let order = await orderOf(orderId)
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentSyncLeaseId, null)
  assert.equal(order.paymentAttempts[0].status, 'open', 'no half-applied attempt')
  assert.equal((await deliver(event)).json.outcome, 'processed')
  order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(await eventRows(), 1)
})

test('leases: an expired lease is taken over; a live one makes the update wait and then fail safely (Stripe retries)', async () => {
  await fresh()
  const prisma = await db()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  // left behind by a crash long ago
  await prisma.printOrder.update({ where: { id: orderId }, data: { paymentSyncLeaseId: 'crashed-worker', paymentSyncLeaseUntil: new Date(Date.now() - 1000) } })
  assert.equal((await deliver(sessionEvent('checkout.session.completed', sessionId))).json.outcome, 'processed')
  assert.equal((await orderOf(orderId)).status, 'queued')

  await fresh()
  const second = await startCheckout()
  fake.pay(second.sessionId)
  await prisma.printOrder.update({ where: { id: second.orderId }, data: { paymentSyncLeaseId: 'busy-worker', paymentSyncLeaseUntil: new Date(Date.now() + 60_000) } })
  const started = Date.now()
  const refused = await withEnv({ PAYMENT_SYNC_MAX_WAIT_MS: '300' }, () => deliver(sessionEvent('checkout.session.completed', second.sessionId)))
  assert.equal(refused.status, 500)
  assert.ok(Date.now() - started < 3000)
  let order = await orderOf(second.orderId)
  assert.equal(order.status, 'awaiting_payment')
  assert.equal(order.paymentSyncLeaseId, 'busy-worker', 'somebody else\'s lease is never touched')
  assert.equal(fake.state.reads.length, 0, 'Stripe was not even asked')
  await prisma.printOrder.update({ where: { id: second.orderId }, data: { paymentSyncLeaseId: null, paymentSyncLeaseUntil: null } })
  assert.equal((await deliver(sessionEvent('checkout.session.completed', second.sessionId))).json.outcome, 'processed')
  order = await orderOf(second.orderId)
  assert.equal(order.status, 'queued')
})

test('a cycle that lost its lease while waiting for Stripe applies nothing', async () => {
  await fresh()
  const prisma = await db()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  fake.state.afterSnapshot = async () => {
    // the lease expired and another worker took over while this one was still reading
    await prisma.printOrder.update({ where: { id: orderId }, data: { paymentSyncLeaseId: 'other-worker', paymentSyncLeaseUntil: new Date(Date.now() + 60_000) } })
  }
  const res = await deliver(sessionEvent('checkout.session.completed', sessionId))
  assert.equal(res.status, 500)
  const order = await orderOf(orderId)
  assert.equal(order.status, 'awaiting_payment')
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentSyncLeaseId, 'other-worker', 'the other worker keeps its lease')
  assert.equal(await eventRows(), 0)
})

test('nothing is ever held in a database transaction while Stripe is being read (requests made one at a time)', async () => {
  await fresh()
  const { sessionId } = await startCheckout()
  fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  assert.ok(fake.state.reads.length >= 1)
  assert.equal(Math.max(maxIdleSeen, fake.state.maxIdleInTransaction), 0)
})

// ====================================================================================================================================
// production is never started by an unverified payment
// ====================================================================================================================================
test('every Stripe state that is not "collected, exact amount" leaves the order out of production', async () => {
  const states: Array<[string, Parameters<Fake['pay']>[1]]> = [
    ['page still open, nothing paid', { status: 'open', piStatus: 'requires_payment_method', paymentStatus: 'unpaid' }],
    ['card needs authentication', { status: 'open', piStatus: 'requires_action', paymentStatus: 'unpaid' }],
    ['payment processing', { piStatus: 'processing', paymentStatus: 'unpaid' }],
    ['payment cancelled', { piStatus: 'canceled', paymentStatus: 'unpaid', status: 'open' }],
    ['authorised only', { piStatus: 'requires_capture', paymentStatus: 'unpaid', status: 'open' }],
  ]
  for (const [name, over] of states) {
    await fresh()
    const { orderId, sessionId } = await startCheckout()
    const { piId } = fake.pay(sessionId, over)
    for (const event of [sessionEvent('checkout.session.completed', sessionId), piEvent('payment_intent.processing', piId), piEvent('payment_intent.canceled', piId), piEvent('payment_intent.payment_failed', piId)]) {
      assert.equal((await deliver(event)).status, 200, name)
    }
    const order = await orderOf(orderId)
    assert.notEqual(order.status, 'queued', name)
    assert.notEqual(order.paymentStatus, 'paid', name)
    assert.equal(isProductionEligible(order), false, name)
    assert.equal(calls.printlab, 0, name)
  }
})

// ====================================================================================================================================
// what happens after the payment
// ====================================================================================================================================
test('after-payment steps that fail are recorded and retried; none runs twice', async () => {
  await fresh()
  printlabFailures = 1
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  const res = await deliver(sessionEvent('checkout.session.completed', sessionId))
  assert.equal(res.status, 200, 'a failing step never turns a verified payment into an error')
  let order = await orderOf(orderId)
  assert.equal(order.status, 'queued')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(effectStatus(order, 'printlab'), 'failed')
  assert.match((order.metadata as any).postPayment.printlab.error, /PrintLab is down/)
  assert.equal((order.metadata as any).postPayment.printlab.attempts, 1)
  assert.equal(effectStatus(order, 'receipt'), 'done')
  assert.equal(calls.printlab, 1)

  const recovered = await recoverPostPaymentEffects()
  assert.deepEqual(recovered.rerun, [orderId])
  order = await orderOf(orderId)
  assert.equal(effectStatus(order, 'printlab'), 'done')
  assert.equal((order.metadata as any).postPayment.printlab.attempts, 2)
  assert.equal(calls.printlab, 2)
  assert.equal(calls.receipt, 1, 'finished steps are not repeated')
  assert.equal(calls.discord, 1)
  // nothing left to do
  assert.deepEqual((await recoverPostPaymentEffects()).rerun, [])
  assert.equal(calls.printlab, 2)
})

test('after-payment steps started at the same moment run once', async () => {
  await fresh()
  const { orderId, sessionId } = await startCheckout()
  fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  const prisma = await db()
  // pretend nothing was done yet, then run the steps from five places at once
  await prisma.printOrder.update({ where: { id: orderId }, data: { metadata: { ...((await orderOf(orderId)).metadata as object), postPayment: {} } } })
  Object.assign(calls, { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 })
  effectHooks.submitToPrintLab = (async () => { calls.printlab++; await sleep(80); return { ok: true, submitted: [], errors: [] } }) as any
  await Promise.all(Array.from({ length: 5 }, () => runPostPaymentEffects(orderId)))
  assert.equal(calls.printlab, 1)
  assert.equal(calls.discord, 1)
  assert.equal(calls.receipt, 1)
  assert.equal(effectStatus(await orderOf(orderId), 'printlab'), 'done')
})

// ====================================================================================================================================
// payments nobody claims; the admin sync tool
// ====================================================================================================================================
test('a payment for a checkout session we do not know is stored without an order and listed', async () => {
  await fresh()
  fake.sessions.set('cs_test_UNKNOWN_1', { id: 'cs_test_UNKNOWN_1', object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', metadata: {}, payment_intent: null })
  const res = await deliver(evt('checkout.session.completed', { id: 'cs_test_UNKNOWN_1', object: 'checkout.session', metadata: {} }))
  assert.equal(res.status, 200)
  const stored = await (await db()).stripeEvent.findFirstOrThrow()
  assert.equal(stored.orderId, null)
  assert.equal(stored.checkoutSessionId, 'cs_test_UNKNOWN_1')
  assert.equal(fake.state.reads.length, 0, 'there is nothing to update, so Stripe is not asked')
  const unmatched = await findUnmatchedPaymentEvents()
  assert.deepEqual(unmatched.map((e) => e.checkoutSessionId), ['cs_test_UNKNOWN_1'])
})

test('the administrator "sync" tool goes through the same verification and never releases an order twice', async () => {
  await fresh()
  // old-style order whose PaymentIntent is linked: a payment of the wrong amount is flagged, not accepted
  const order = await legacyOrder('pi_admin_sync')
  legacyIntent('pi_admin_sync', 'succeeded', { amount: 1000, amount_received: 995 })
  const bad = await syncStripePaymentIntent('pi_admin_sync', 'admin.sync')
  assert.equal(bad.updatedOrders, 1)
  const flagged = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(flagged.paymentReviewReason, 'amount')
  assert.equal(flagged.status, 'awaiting_payment')
  assert.equal(flagged.paymentStatus, 'pending')

  // hosted order, paid: asking again and again changes nothing and starts nothing twice
  await fresh()
  const ok = await startCheckout()
  const paid = fake.pay(ok.sessionId)
  await deliver(sessionEvent('checkout.session.completed', ok.sessionId))
  const again = await syncStripePaymentIntent(paid.piId, 'admin.sync')
  assert.equal(again.updatedOrders, 1)
  await syncStripePaymentIntent(paid.piId, 'admin.sync')
  const done = await orderOf(ok.orderId)
  assert.equal(done.status, 'queued')
  assert.equal(done.paymentStatus, 'paid')
  assert.equal(done.paymentReviewReason, null)
  assert.equal(calls.printlab, 1)
})

// ====================================================================================================================================
// the old card path
// ====================================================================================================================================
test('the old card checkout cannot take money in production unless switched on on purpose; other methods are not affected', async () => {
  await fresh()
  const { POST } = await import('../../app/api/checkout/route')
  const body = (extra: Record<string, unknown>) => ({ ...cart(), ...extra })
  const call = async (extra: Record<string, unknown>, viewer: Viewer = null) => {
    viewerGuards.getViewer = async () => viewer
    const res = await (POST as any)(new NextRequest('http://localhost/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(extra)),
    }), {}) as Response
    return { status: res.status, json: await res.json().catch(() => ({})) as any }
  }
  const admin = await (await db()).user.create({ data: { email: `s3admin${Date.now()}@sectest.invalid`, passwordHash: 'x', name: 'admin', role: 'admin' } })
  const prisma = await db()
  const before = await prisma.printOrder.count()

  await withEnv({ NODE_ENV: 'production', LEGACY_CARD_CHECKOUT_ENABLED: undefined }, async () => {
    for (const commit of [false, true]) {
      const r = await call({ paymentMethod: 'card', commit, paymentIntentId: 'pi_whatever' })
      assert.equal(r.status, 503, `commit=${commit}`)
      assert.equal(r.json.code, 'LEGACY_CARD_CHECKOUT_DISABLED')
    }
    for (const value of ['false', '0', 'yes', '']) {
      await withEnv({ LEGACY_CARD_CHECKOUT_ENABLED: value }, async () => {
        assert.equal((await call({ paymentMethod: 'card' })).status, 503, `value "${value}"`)
      })
    }
    // a quote request and an administrator's own orders do not use the card path
    assert.equal((await call({ paymentMethod: 'quote', commit: true }, { id: customerA.id, role: 'customer' })).status, 200)
    assert.equal((await call({ paymentMethod: 'comped', commit: true }, { id: admin.id, role: 'admin' })).status, 200)
    // the admin environment check calls it out
    const checks = buildEnvChecks({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'a-valid-test-jwt-secret-with-32-chars', LEGACY_CARD_CHECKOUT_ENABLED: 'true' })
    const legacy = checks.find((c) => c.key === 'LEGACY_CARD_CHECKOUT_ENABLED')!
    assert.equal(legacy.required, true)
    assert.equal(legacy.ok, false)
    const off = buildEnvChecks({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'a-valid-test-jwt-secret-with-32-chars' })
    assert.equal(off.find((c) => c.key === 'LEGACY_CARD_CHECKOUT_ENABLED')!.ok, true)
  })
  assert.equal(await prisma.printOrder.count(), before + 2, 'only the two non-card orders were created')

  // switched on on purpose, or outside production (development, tests): the preview works again
  await withEnv({ NODE_ENV: 'production', LEGACY_CARD_CHECKOUT_ENABLED: 'true' }, async () => {
    assert.notEqual((await call({ paymentMethod: 'card' })).status, 503)
  })
  assert.notEqual((await call({ paymentMethod: 'card' })).json.code, 'LEGACY_CARD_CHECKOUT_DISABLED')
})

// ====================================================================================================================================
// guest access: several orders from the same browser
// ====================================================================================================================================
test('a guest who orders again keeps access to the earlier orders (the cookie holds a short list, newest first)', async () => {
  await fresh()
  const prisma = await db()
  const cookieOf = (res: Response) => {
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${GUEST_ACCESS_COOKIE}=`))!
    return decodeURIComponent(header.split(';')[0].split('=').slice(1).join('='))
  }
  const ids: string[] = []
  let cookie: string | null = null
  for (let i = 0; i < GUEST_COOKIE_MAX_ORDERS + 2; i++) {
    const c = cart({ items: [{ modelId, qty: i + 1, colors: ['#ffffff'], material: 'PLA' }] })
    const quote = await post('quote', c)
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote.json.totalCents, ...c }, { headers: cookie ? { cookie: `${GUEST_ACCESS_COOKIE}=${encodeURIComponent(cookie)}` } : {} })
    assert.equal(r.res.status, 200, r.text)
    ids.push(r.json.orderId)
    cookie = cookieOf(r.res)
    const held = parseGuestAccessCookieList(cookie).map((e) => e.orderId)
    assert.equal(held[0], r.json.orderId, 'the newest order comes first')
    assert.equal(held.length, Math.min(i + 1, GUEST_COOKIE_MAX_ORDERS))
  }
  // the browser can still open the last five, and each token verifies against ITS order only
  const held = parseGuestAccessCookieList(cookie)
  assert.deepEqual(held.map((e) => e.orderId), ids.slice(-GUEST_COOKIE_MAX_ORDERS).reverse())
  for (const entry of held) {
    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: entry.orderId } })
    assert.equal(verifyGuestAccess(order, findGuestToken(cookie, entry.orderId)), true)
    const other = await prisma.printOrder.findUniqueOrThrow({ where: { id: held.find((e) => e.orderId !== entry.orderId)!.orderId } })
    assert.equal(verifyGuestAccess(other, entry.token), false, 'a token opens only its own order')
  }
  assert.equal(findGuestToken(cookie, ids[0]), null, 'the oldest fell off the list')
  // asking again for an order already in the list moves it to the front without duplicating it
  const merged = mergeGuestAccessCookie(cookie, ids[3], held.find((e) => e.orderId === ids[3])!.token)
  assert.equal(parseGuestAccessCookieList(merged)[0].orderId, ids[3])
  assert.equal(parseGuestAccessCookieList(merged).length, GUEST_COOKIE_MAX_ORDERS)
  // a cookie with junk or forged entries yields nothing useful
  assert.deepEqual(parseGuestAccessCookieList('~~.~a.b~'.repeat(20)), [])
  assert.deepEqual(parseGuestAccessCookieList('x'.repeat(5000)), [])
  const forged = mergeGuestAccessCookie('cmforgedorder0000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ids[6], held[0].token)
  const forgedOrder = await prisma.printOrder.findUnique({ where: { id: 'cmforgedorder0000000001' } })
  assert.equal(forgedOrder, null)
  assert.ok(findGuestToken(forged, 'cmforgedorder0000000001'))
})
