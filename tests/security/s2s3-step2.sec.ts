// S2/S3 step 2 – the hosted card checkout: quote, order created before payment, Stripe Checkout session.
//
// What must hold:
//   * the server alone decides every price; the total is fixed when the order is created and the browser cannot change it
//   * double clicks, retries, lost answers and simultaneous requests never produce a second order or a second Stripe session
//   * if Stripe creates a session but the server cannot save the answer, a retry recovers the SAME session
//   * no database transaction is open while Stripe is being called
//   * shipping never defaults to "free"; in production nothing is sold without a tax configuration
//   * the guest token only opens the status of its own order and is stored only as a hash
// Fake Stripe (tests/security/_fake-checkout.ts), throw-away database, fake data. Nothing here marks an order paid: that is step 3.
import { db, resetDb, seedShopModel, stripeCalls, writeStorageFile } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { fileRouteGuards } from '../../lib/file-access'
import { consumeFixedWindow } from '../../lib/rate-limit'
import { buildSessionLineItems, sessionProblem, JOIN_WINDOW_MS } from '../../lib/checkout-sessions'
import {
  buildGuestAccessCookieValue, deriveGuestAccessToken, GUEST_ACCESS_COOKIE, GUEST_ACCESS_TTL_MS,
  hashGuestAccessToken, issueGuestAccess, parseGuestAccessCookie, verifyGuestAccess,
} from '../../lib/guest-order-access'
import { getShippingConfig } from '../../lib/shipping'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let privateModelId = ''
let maxIdleSeen = 0
let customerA: { id: string; email: string }
let customerB: { id: string; email: string }
const viewerA = (): Viewer => ({ id: customerA.id, role: 'customer' })
const viewerB = (): Viewer => ({ id: customerB.id, role: 'customer' })

const ENV_KEYS = [
  'CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'SHIPPING_FLAT_RATE_CENTS', 'NODE_ENV', 'BASE_URL',
  'HOSTED_CHECKOUT_ENABLED', 'STRIPE_SECRET_KEY', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX',
] as const
type EnvKey = (typeof ENV_KEYS)[number]
type EnvValues = Partial<Record<EnvKey, string | undefined>>
const snapshotEnv = (): EnvValues => Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
function applyEnv(values: EnvValues) {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
}
// What the harness set (BASE_URL, STRIPE_SECRET_KEY...) is the starting point; each test begins from BASELINE.
const ORIGINAL = snapshotEnv()
const BASELINE: EnvValues = {
  ...ORIGINAL,
  CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700',
  TAX_MODE: undefined, TAX_RATE_PERCENT: undefined, HOSTED_CHECKOUT_ENABLED: undefined,
  CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000',
}
// Change some variables for the duration of one step ("undefined" removes a variable), then put everything back.
async function withEnv<T>(env: EnvValues, fn: () => Promise<T>): Promise<T> {
  const before = snapshotEnv()
  applyEnv({ ...before, ...env })
  try {
    return await fn()
  } finally {
    applyEnv(before)
  }
}

let ipSeq = 0
const nextIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `test-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`

type Call = { viewer?: Viewer | null; ip?: string; headers?: Record<string, string>; contentType?: string | null; raw?: string; url?: string }
async function post(route: 'quote' | 'session', body: unknown, o: Call = {}) {
  viewerGuards.getViewer = async () => o.viewer ?? null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const headers: Record<string, string> = {
    origin: 'http://localhost',
    'x-forwarded-for': o.ip ?? nextIp(),
    ...(o.contentType === null ? {} : { 'content-type': o.contentType ?? 'application/json' }),
    ...(o.headers || {}),
  }
  const request = new NextRequest(o.url ?? `http://localhost/api/checkout/${route}`, {
    method: 'POST',
    headers,
    body: o.raw ?? JSON.stringify(body),
  })
  const res = (await (mod.POST as any)(request, {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { res, json, text }
}

const cart = (over: Record<string, unknown> = {}) => ({
  items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }],
  shipping: { method: 'pickup' as 'pickup' | 'ship' },
  rush: false,
  ...over,
})
const quoteOf = async (c = cart(), o: Call = {}) => {
  const q = await post('quote', c, o)
  assert.equal(q.res.status, 200, q.text)
  return q.json
}
// Quote, then "pay": exactly what the page will do.
async function pay(o: Call & { key?: string; cartOver?: Record<string, unknown>; expected?: number } = {}) {
  const c = cart(o.cartOver)
  const key = o.key ?? newKey()
  const expected = o.expected ?? (await quoteOf(c, o)).totalCents
  const result = await post('session', { checkoutKey: key, expectedTotalCents: expected, ...c }, o)
  return { ...result, key, expected, cart: c }
}

async function counts() {
  const prisma = await db()
  return { orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count() }
}

async function fresh() {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear()
  fake.byKey.clear()
  maxIdleSeen = Math.max(maxIdleSeen, fake.state.maxIdleInTransaction)
  Object.assign(fake.state, {
    createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, unreachableBeforeCreate: 0, lostAnswerAfterCreate: 0,
    rejectCreate: false, delayMs: 0, amountTotalOverride: null, currencyOverride: null, retrieveFails: false, maxIdleInTransaction: 0,
    lastParams: null, allParams: [],
  })
  applyEnv(BASELINE)
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  // minimumOrderSubtotalUsd 0 = the shop has CHOSEN "no minimum" (in production an unset minimum stops card payments: see the test after the production one)
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20, minimumOrderSubtotalUsd: 0 } as any })
  const [a, b] = await Promise.all(['step2a', 'step2b'].map((name) =>
    prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role: 'customer' } })))
  customerA = { id: a.id, email: a.email }
  customerB = { id: b.id, email: b.email }
  modelId = (await seedShopModel()).model.id
  privateModelId = (await prisma.model.create({
    data: { title: 'STEP2 private', filePath: `models/${a.id}/p.stl`, fileType: 'stl', userId: a.id, visibility: 'private', volumeMm3: 100000, priceUsd: 50, sizeXmm: 10, sizeYmm: 10, sizeZmm: 10 } as any,
  })).id
  fake = await installFakeCheckout()
  await fresh()
})

test.after(() => {
  applyEnv(ORIGINAL)
})

// ====================================================================================================================
// quote
// ====================================================================================================================
test('quote: the server prices the cart; nothing is created, Stripe is not called', async () => {
  await fresh()
  const before = await counts()
  const q = await quoteOf()
  assert.equal(q.currency, 'EUR')
  assert.equal(q.canCheckout, true)
  assert.equal(q.unavailableReason, null)
  assert.ok(q.totalCents > 0)
  assert.equal(q.totalCents, q.itemsTotalCents + q.shipping.cents + (q.tax.addedToTotal ? q.tax.cents : 0))
  assert.equal(q.items.reduce((s: number, i: any) => s + i.lineTotalCents, 0), q.itemsTotalCents)
  assert.deepEqual(await counts(), before)
  assert.equal(fake.state.createCalls + fake.state.retrieveCalls + fake.state.expireCalls, 0)
})

test('quote: no file paths, internal ids or personal data in the answer', async () => {
  await fresh()
  const { text } = await post('quote', cart(), { viewer: viewerA() })
  for (const leak of ['storagePath', 'storageUrl', 'filePath', 'models/', modelId, 'sectest.invalid', 'pricingBreakdown', customerA.id]) {
    assert.ok(!text.includes(leak), `the quote leaks "${leak}"`)
  }
})

test('quote: shipping is part of the total and is shown before payment', async () => {
  await fresh()
  const pickup = await quoteOf(cart())
  const ship = await quoteOf(cart({ shipping: { method: 'ship' } }))
  assert.equal(ship.shipping.cents, 700)
  assert.equal(ship.shipping.label, 'Spedizione in Italia')
  assert.equal(ship.totalCents, pickup.totalCents + 700)
  assert.equal(pickup.shipping.cents, 0)
})

test('shipping is never silently free: a missing or invalid rate refuses shipping, "0" is a deliberate choice', async () => {
  await fresh()
  for (const value of [undefined, '', '  ', 'abc', '-5', '7.5', '1e3', '99999999']) {
    await withEnv({ SHIPPING_FLAT_RATE_CENTS: value }, async () => {
      assert.equal(getShippingConfig().configured, false, String(value))
      const q = await post('quote', cart({ shipping: { method: 'ship' } }))
      assert.equal(q.res.status, 503, String(value))
      assert.equal(q.json.code, 'SHIPPING_NOT_CONFIGURED')
      const before = await counts()
      const paid = await post('session', { checkoutKey: newKey(), expectedTotalCents: 100, ...cart({ shipping: { method: 'ship' } }) })
      assert.equal(paid.res.status, 503)
      assert.equal(paid.json.code, 'SHIPPING_NOT_CONFIGURED')
      assert.deepEqual(await counts(), before)
      // picking the order up does not need shipping at all
      assert.equal((await post('quote', cart())).res.status, 200)
    })
  }
  await withEnv({ SHIPPING_FLAT_RATE_CENTS: '0' }, async () => {
    const free = await quoteOf(cart({ shipping: { method: 'ship' } }))
    const pickup = await quoteOf(cart())
    assert.equal(free.shipping.cents, 0)
    assert.equal(free.totalCents, pickup.totalCents)
  })
})

test('tax: exclusive tax is added to the total, inclusive tax is only reported', async () => {
  await fresh()
  const none = await quoteOf(cart({ shipping: { method: 'ship' } }))
  await withEnv({ TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' }, async () => {
    const q = await quoteOf(cart({ shipping: { method: 'ship' } }))
    const taxable = q.itemsTotalCents + q.shipping.cents
    assert.equal(q.tax.cents, Math.round((taxable * 22) / 100))
    assert.equal(q.tax.addedToTotal, true)
    assert.equal(q.totalCents, taxable + q.tax.cents)
  })
  await withEnv({ TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '22' }, async () => {
    const q = await quoteOf(cart({ shipping: { method: 'ship' } }))
    assert.equal(q.totalCents, none.totalCents)
    assert.equal(q.tax.addedToTotal, false)
    assert.equal(q.tax.cents, Math.round((q.totalCents * 22) / 122))
  })
})

test('quote: anything the browser sends about prices, totals, status or payment is refused', async () => {
  await fresh()
  for (const extra of [
    { totalCents: 1 }, { amount: 1 }, { paymentStatus: 'paid' }, { status: 'queued' }, { paymentMethod: 'cash' },
    { shipping: { method: 'pickup', cents: 0 } }, { discountPercent: 100 }, { userId: 'someone-else' },
  ]) {
    const q = await post('quote', cart(extra))
    assert.equal(q.res.status, 400, JSON.stringify(extra))
  }
  assert.equal((await post('quote', { items: [] })).res.status, 400)
  assert.equal((await post('quote', cart({ items: Array.from({ length: 51 }, () => ({ modelId, qty: 1, colors: ['#fff'] })) }))).res.status, 400)
  // a price smuggled into an item is not read
  const honest = await quoteOf(cart())
  const smuggled = await quoteOf(cart({ items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA', unitPrice: 0.01, lineTotal: 0.02, priceCents: 1 }] }))
  assert.equal(smuggled.totalCents, honest.totalCents)
})

test('quote: privacy – a customer model can only be quoted by its owner', async () => {
  await fresh()
  const asGuest = await post('quote', cart({ items: [{ modelId: privateModelId, qty: 1, colors: ['#ffffff'] }] }))
  assert.equal(asGuest.res.status, 404)
  const asOther = await post('quote', cart({ items: [{ modelId: privateModelId, qty: 1, colors: ['#ffffff'] }] }), { viewer: viewerB() })
  assert.equal(asOther.res.status, 404)
  const asOwner = await post('quote', cart({ items: [{ modelId: privateModelId, qty: 1, colors: ['#ffffff'] }] }), { viewer: viewerA() })
  assert.equal(asOwner.res.status, 200)
})

test('quote: wrong media type and oversized bodies are refused', async () => {
  await fresh()
  assert.equal((await post('quote', cart(), { contentType: 'text/plain' })).res.status, 415)
  assert.equal((await post('quote', cart(), { contentType: null })).res.status, 415)
  assert.equal((await post('quote', null, { raw: 'x'.repeat(150_000) })).res.status, 413)
  assert.equal((await post('quote', null, { raw: '{not json' })).res.status, 400)
})

// ====================================================================================================================
// creating the order and the Stripe session
// ====================================================================================================================
test('session: the order exists before payment, awaiting payment, with the total fixed by the server', async () => {
  await fresh()
  const prisma = await db()
  const { res, json, key, expected } = await pay()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.match(json.url, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_FAKE_\d+$/)

  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId }, include: { items: true, paymentAttempts: true } })
  assert.equal(order.status, 'awaiting_payment')
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentMethod, 'card')
  assert.equal(order.currency, 'EUR')
  assert.equal(order.totalCents, expected)
  assert.equal(order.paidAt, null)
  assert.equal(order.userId, null)
  assert.equal(order.stripePaymentIntentId, null)
  assert.equal(order.items.length, 1)
  assert.equal(order.items[0].quantity, 2)
  assert.notEqual(order.checkoutKey, key, 'the raw key must not be stored')
  assert.match(order.checkoutKey || '', /^[0-9a-f]{64}$/)
  assert.equal((order.metadata as any).source, 'stripe_checkout')

  assert.equal(order.paymentAttempts.length, 1)
  const attempt = order.paymentAttempts[0]
  assert.equal(attempt.status, 'open')
  assert.equal(attempt.amountCents, order.totalCents)
  assert.equal(attempt.currency, 'EUR')
  assert.match(attempt.stripeSessionId || '', /^cs_test_FAKE_/)
  assert.ok(attempt.expiresAt.getTime() - Date.now() > 30 * 60_000, 'a Stripe session must live at least 30 minutes')

  // what Stripe was asked
  const params = fake.state.lastParams
  assert.equal(fake.state.createCalls, 1)
  assert.equal(params.mode, 'payment')
  assert.deepEqual(params.payment_method_types, ['card'])
  assert.equal(params.client_reference_id, order.id)
  assert.equal(params.metadata.orderId, order.id)
  assert.equal(params.payment_intent_data.metadata.orderId, order.id)
  assert.equal(params.customer_email, undefined)
  assert.equal(params.shipping_address_collection, undefined)
  assert.equal(params.automatic_tax, undefined)
  assert.equal(params.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0), order.totalCents)
  assert.ok(params.line_items.every((l: any) => l.price_data.currency === 'eur'))
  assert.equal(params.success_url, `${process.env.BASE_URL}/checkout/success?order=${order.id}`)
  assert.equal(params.cancel_url, `${process.env.BASE_URL}/checkout?canceled=1`)
  assert.ok(!params.success_url.includes('token') && !params.success_url.includes('cs_'), 'no secret in the return address')
  assert.equal(params.expires_at, Math.floor(attempt.expiresAt.getTime() / 1000))
  // nothing can be "paid" yet
  assert.equal(await prisma.printOrder.count({ where: { paymentStatus: 'paid' } }), 0)
})

test('session: shipping adds the Italian rate and asks Stripe for an Italian address only', async () => {
  await fresh()
  const { res, json } = await pay({ cartOver: { shipping: { method: 'ship' } } })
  assert.equal(res.status, 200)
  const params = fake.state.lastParams
  assert.deepEqual(params.shipping_address_collection, { allowed_countries: ['IT'] })
  const shippingLine = params.line_items.find((l: any) => l.price_data.product_data.name === 'Spedizione in Italia')
  assert.equal(shippingLine.price_data.unit_amount, 700)
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId } })
  assert.equal(order.shippingCents, 700)
  assert.equal(order.shippingMethod, 'ship')
  assert.equal(order.shippingAddress, null, 'the address comes from Stripe after payment, never from the browser')
  assert.equal(json.shippingCents, 700)
})

test('session: tax shows up in the order and in what Stripe charges', async () => {
  await fresh()
  const prisma = await db()
  await withEnv({ TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' }, async () => {
    const { res, json } = await pay({ cartOver: { shipping: { method: 'ship' } } })
    assert.equal(res.status, 200)
    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId } })
    assert.ok(order.taxCents > 0)
    const taxLine = fake.state.lastParams.line_items.find((l: any) => l.price_data.product_data.name === 'IVA')
    assert.equal(taxLine.price_data.unit_amount, order.taxCents)
    assert.equal(fake.state.lastParams.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0), order.totalCents)
  })
  await fresh()
  await withEnv({ TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '22' }, async () => {
    const { json } = await pay()
    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId } })
    assert.ok(order.taxCents > 0)
    assert.ok(!fake.state.lastParams.line_items.some((l: any) => l.price_data.product_data.name === 'IVA'), 'included tax is not charged twice')
    assert.equal(fake.state.lastParams.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0), order.totalCents)
  })
})

test('session: a registered customer owns the order and gets no guest token', async () => {
  await fresh()
  const prisma = await db()
  const { res, json } = await pay({ viewer: viewerA() })
  assert.equal(res.status, 200)
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId } })
  assert.equal(order.userId, customerA.id)
  assert.equal(order.customerEmail, customerA.email)
  assert.equal(order.guestAccessTokenHash, null)
  assert.equal(order.guestAccessExpiresAt, null)
  assert.equal(res.headers.getSetCookie().length, 0)
  assert.equal(fake.state.lastParams.customer_email, customerA.email)
})

test('session: the browser cannot set prices, totals, status or payment; unknown fields are refused', async () => {
  await fresh()
  const before = await counts()
  const calls = fake.state.createCalls
  const base = { checkoutKey: newKey(), expectedTotalCents: 100, ...cart() }
  for (const extra of [
    { totalCents: 1 }, { amount: 1 }, { paymentStatus: 'paid' }, { status: 'queued' }, { paymentMethod: 'cash' },
    { productionAuthorization: { authorized: true } }, { stripePaymentIntentId: 'pi_x' }, { userId: customerA.id },
  ]) {
    const r = await post('session', { ...base, ...extra })
    assert.equal(r.res.status, 400, JSON.stringify(extra))
  }
  assert.deepEqual(await counts(), before)
  assert.equal(fake.state.createCalls, calls)
  // the key and the shown total are required and checked
  assert.equal((await post('session', { ...cart(), expectedTotalCents: 100 })).res.status, 400)
  assert.equal((await post('session', { ...cart(), checkoutKey: newKey() })).res.status, 400)
  assert.equal((await post('session', { ...base, checkoutKey: 'short' })).res.status, 400)
  assert.equal((await post('session', { ...base, expectedTotalCents: -1 })).res.status, 400)
  assert.equal((await post('session', { ...base, expectedTotalCents: 1.5 })).res.status, 400)
  // a price smuggled into an item is ignored: the order costs what the server says
  const honest = await quoteOf()
  const smuggled = await post('session', {
    checkoutKey: newKey(), expectedTotalCents: honest.totalCents,
    ...cart({ items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA', unitPrice: 0.01, lineTotal: 0.02 }] }),
  })
  assert.equal(smuggled.res.status, 200)
  assert.equal(smuggled.json.totalCents, honest.totalCents)
})

test('session: a different total than the one shown is refused and nothing is created', async () => {
  await fresh()
  const shown = (await quoteOf()).totalCents
  const before = await counts()
  const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: shown - 1, ...cart() })
  assert.equal(r.res.status, 409)
  assert.equal(r.json.code, 'PRICE_CHANGED')
  assert.equal(r.json.currentTotalCents, shown)
  assert.deepEqual(await counts(), before)
  assert.equal(fake.state.createCalls, 0)
})

test('the total is frozen: later price changes do not touch an existing order, and a stale total is refused', async () => {
  await fresh()
  const prisma = await db()
  const first = await pay({ key: 'frozen-key-0000000001' })
  assert.equal(first.res.status, 200)
  const frozen = first.expected
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { machineUsdPerHour: 12 } })
  try {
    const now = (await quoteOf()).totalCents
    assert.ok(now > frozen, 'the price really went up')
    // same checkout again (double click, retry): same order, same total, same payment page
    const again = await post('session', { checkoutKey: 'frozen-key-0000000001', expectedTotalCents: frozen, ...first.cart })
    assert.equal(again.res.status, 200)
    assert.equal(again.json.orderId, first.json.orderId)
    assert.equal(again.json.totalCents, frozen)
    assert.equal(again.json.url, first.json.url)
    assert.equal(fake.state.createCalls, 1)
    assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: first.json.orderId } })).totalCents, frozen)
    // a new checkout that still believes in the old price is refused with the new price...
    const stale = await post('session', { checkoutKey: newKey(), expectedTotalCents: frozen, ...first.cart })
    assert.equal(stale.res.status, 409)
    assert.equal(stale.json.currentTotalCents, now)
    // ...and the same key cannot be reused for a different total
    const reused = await post('session', { checkoutKey: 'frozen-key-0000000001', expectedTotalCents: now, ...first.cart })
    assert.equal(reused.res.status, 409)
    assert.equal(reused.json.code, 'CHECKOUT_KEY_CONFLICT')
    assert.equal(await prisma.printOrder.count(), 1)
  } finally {
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { machineUsdPerHour: 2.5 } })
  }
})

// ====================================================================================================================
// idempotency and concurrency
// ====================================================================================================================
test('double click: the same checkout twice gives one order, one attempt, one Stripe session', async () => {
  await fresh()
  const first = await pay({ key: 'double-click-key-0001' })
  const second = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(first.res.status, 200)
  assert.equal(second.res.status, 200)
  assert.equal(second.json.orderId, first.json.orderId)
  assert.equal(second.json.url, first.json.url)
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
  assert.equal(fake.state.createdSessions, 1)
  assert.equal(fake.state.createCalls, 1)
})

test('simultaneous requests (guest): twelve at once give one order and one Stripe session', async () => {
  await fresh()
  const c = cart()
  const expected = (await quoteOf(c)).totalCents
  fake.state.delayMs = 40
  const key = 'simultaneous-guest-0001'
  const results = await Promise.all(Array.from({ length: 12 }, () => post('session', { checkoutKey: key, expectedTotalCents: expected, ...c })))
  for (const r of results) assert.equal(r.res.status, 200, r.text)
  assert.equal(new Set(results.map((r) => r.json.orderId)).size, 1)
  assert.equal(new Set(results.map((r) => r.json.url)).size, 1)
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
  assert.equal(fake.state.createdSessions, 1)
  // (the open-transaction probe is not asserted here: with simultaneous requests it also sees the short transactions of the others)
  fake.state.maxIdleInTransaction = 0
})

test('simultaneous requests (registered): same cart, different keys, still ONE order', async () => {
  await fresh()
  const c = cart()
  const expected = (await quoteOf(c, { viewer: viewerA() })).totalCents
  fake.state.delayMs = 30
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post('session', { checkoutKey: `registered-key-${String(i).padStart(4, '0')}-xyz`, expectedTotalCents: expected, ...c }, { viewer: viewerA() })))
  for (const r of results) assert.equal(r.res.status, 200, r.text)
  assert.equal(new Set(results.map((r) => r.json.orderId)).size, 1)
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
  assert.equal(fake.state.createdSessions, 1)
  fake.state.maxIdleInTransaction = 0 // see the note in the previous test
  // another cart, or a cart that was paid meanwhile, is a new purchase
  const other = await pay({ viewer: viewerA(), cartOver: { items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] } })
  assert.notEqual(other.json.orderId, results[0].json.orderId)
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: results[0].json.orderId }, data: { paymentStatus: 'paid', status: 'queued' } })
  const again = await post('session', { checkoutKey: newKey(), expectedTotalCents: expected, ...c }, { viewer: viewerA() })
  assert.equal(again.res.status, 200)
  assert.notEqual(again.json.orderId, results[0].json.orderId)
})

test('a checkout key is only good for the same cart; two people never share keys', async () => {
  await fresh()
  const key = 'shared-key-0000000001'
  const mine = await pay({ key, viewer: viewerA() })
  assert.equal(mine.res.status, 200)
  // same key, different cart / shipping / rush
  for (const over of [
    { items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] },
    { shipping: { method: 'ship' } },
    { rush: true },
  ]) {
    const quote = await quoteOf(cart(over), { viewer: viewerA() })
    const r = await post('session', { checkoutKey: key, expectedTotalCents: quote.totalCents, ...cart(over) }, { viewer: viewerA() })
    assert.equal(r.res.status, 409, JSON.stringify(over))
    assert.equal(r.json.code, 'CHECKOUT_KEY_CONFLICT')
  }
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
  // someone else using the same key gets their own order, never mine
  const theirs = await pay({ key, viewer: viewerB() })
  assert.equal(theirs.res.status, 200)
  assert.notEqual(theirs.json.orderId, mine.json.orderId)
  const guest = await pay({ key })
  assert.notEqual(guest.json.orderId, mine.json.orderId)
  assert.notEqual(guest.json.orderId, theirs.json.orderId)
  assert.deepEqual(await counts(), { orders: 3, attempts: 3 })
})

// ====================================================================================================================
// Stripe and database failures
// ====================================================================================================================
test('Stripe unreachable: the order is kept, the answer says "retry", and the retry reuses the reservation', async () => {
  await fresh()
  const prisma = await db()
  fake.state.unreachableBeforeCreate = 1
  const first = await pay({ key: 'unreachable-key-00001' })
  assert.equal(first.res.status, 502)
  assert.equal(first.json.code, 'PAYMENT_PROVIDER_UNAVAILABLE')
  assert.equal(first.json.retry, true)
  assert.ok(!first.text.toLowerCase().includes('fake'), 'provider details must not reach the browser')
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
  const reserved = await prisma.paymentAttempt.findFirstOrThrow()
  assert.equal(reserved.status, 'creating')
  assert.equal(reserved.stripeSessionId, null)

  const retry = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(retry.res.status, 200)
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 }, 'the retry must not open a second attempt')
  const done = await prisma.paymentAttempt.findFirstOrThrow()
  assert.equal(done.id, reserved.id)
  assert.equal(done.status, 'open')
  assert.equal(fake.state.createdSessions, 1)
})

test('Stripe created the session but the answer was lost: the retry gets the SAME session', async () => {
  await fresh()
  const prisma = await db()
  fake.state.lostAnswerAfterCreate = 1
  const first = await pay({ key: 'lost-answer-key-0001' })
  assert.equal(first.res.status, 502)
  assert.equal(fake.state.createdSessions, 1, 'Stripe did create it')
  assert.equal((await prisma.paymentAttempt.findFirstOrThrow()).stripeSessionId, null, 'the server never saw it')

  const retry = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(retry.res.status, 200)
  assert.equal(fake.state.createdSessions, 1, 'no second session at Stripe')
  const attempt = await prisma.paymentAttempt.findFirstOrThrow()
  assert.equal(attempt.status, 'open')
  assert.equal(attempt.stripeSessionId, [...fake.sessions.keys()][0])
  assert.equal(retry.json.url, [...fake.sessions.values()][0].url)
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
})

test('Stripe created the session but the database could not save it: the retry recovers the same session', async () => {
  await fresh()
  const prisma = await db()
  // make the "mark the attempt open" write fail, exactly like a database outage at that moment
  await prisma.$executeRawUnsafe(`ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "tmp_no_open" CHECK (status <> 'open') NOT VALID`)
  let first
  try {
    first = await pay({ key: 'db-down-after-stripe-01' })
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "tmp_no_open"`)
  }
  assert.equal(first.res.status, 503)
  assert.equal(first.json.code, 'TEMPORARY_ERROR')
  assert.equal(first.json.retry, true)
  assert.equal(fake.state.createdSessions, 1)
  assert.equal((await prisma.paymentAttempt.findFirstOrThrow()).status, 'creating')

  const retry = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(retry.res.status, 200)
  assert.equal(fake.state.createdSessions, 1)
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
  assert.equal((await prisma.paymentAttempt.findFirstOrThrow()).stripeSessionId, [...fake.sessions.keys()][0])
})

test('Stripe rejects the request: attempt closed, nothing leaks, a new attempt is possible, attempts are capped', async () => {
  await fresh()
  const prisma = await db()
  fake.state.rejectCreate = true
  const first = await pay({ key: 'rejected-key-000001' })
  assert.equal(first.res.status, 500)
  assert.equal(first.json.code, 'PAYMENT_PROVIDER_ERROR')
  assert.equal(first.json.retry, false)
  assert.ok(!/parameter|invalid_request|stripe/i.test(first.text), 'provider error details must not reach the browser')
  assert.equal((await prisma.paymentAttempt.findFirstOrThrow()).status, 'failed')

  // once Stripe works again the same checkout simply opens a new attempt
  fake.state.rejectCreate = false
  const ok = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(ok.res.status, 200)
  assert.deepEqual(await counts(), { orders: 1, attempts: 2 })

  // a checkout that keeps failing stops after 5 attempts
  await fresh()
  fake.state.rejectCreate = true
  let last
  for (let i = 0; i < 6; i++) last = await pay({ key: 'always-failing-key-01' , expected: undefined })
  assert.equal(last!.res.status, 429)
  assert.equal(last!.json.code, 'TOO_MANY_ATTEMPTS')
  assert.equal(await prisma.paymentAttempt.count(), 5)
})

test('Stripe answers with something that does not match the order: thrown away, no payment page is returned', async () => {
  await fresh()
  const prisma = await db()
  fake.state.amountTotalOverride = 1
  const r = await pay({ key: 'mismatch-key-0000001' })
  assert.equal(r.res.status, 500)
  assert.ok(!r.text.includes('checkout.stripe.test'), 'no payment page may be returned')
  assert.equal(fake.state.expireCalls, 1, 'the mismatching session is closed at Stripe')
  const attempt = await prisma.paymentAttempt.findFirstOrThrow()
  assert.equal(attempt.status, 'failed')
  assert.equal(attempt.failureReason, 'session_mismatch:amount')
})

test('session check: every field Stripe returns is compared with the order', () => {
  const order: any = { id: 'ord_1', totalCents: 5000, currency: 'EUR' }
  const good: any = { mode: 'payment', status: 'open', url: 'https://x', amount_total: 5000, currency: 'eur', client_reference_id: 'ord_1', metadata: { orderId: 'ord_1' } }
  assert.equal(sessionProblem(good, order), null)
  assert.equal(sessionProblem({ ...good, mode: 'subscription' }, order), 'mode')
  assert.equal(sessionProblem({ ...good, status: 'expired' }, order), 'status')
  assert.equal(sessionProblem({ ...good, url: null }, order), 'no_url')
  assert.equal(sessionProblem({ ...good, amount_total: 4999 }, order), 'amount')
  assert.equal(sessionProblem({ ...good, currency: 'usd' }, order), 'currency')
  assert.equal(sessionProblem({ ...good, client_reference_id: 'ord_2' }, order), 'client_reference_id')
  assert.equal(sessionProblem({ ...good, metadata: { orderId: 'ord_2' } }, order), 'metadata')
  assert.equal(sessionProblem({ ...good, metadata: {} }, order), 'metadata')
})

test('lines sent to Stripe: always add up to the order total, never a rounding difference', () => {
  const item = (over: Record<string, unknown>) => ({ modelTitle: 'Part', partName: null, material: 'PLA', colors: ['#fff'], finish: null, quantity: 1, unitPriceCents: 1000, totalCents: 1000, ...over })
  const order = (over: Record<string, unknown>): any => ({ id: 'o', orderNumber: 7, currency: 'EUR', shippingCents: 0, taxCents: 0, totalCents: 1000, items: [item({})], ...over })
  const sum = (lines: any[]) => lines.reduce((s, l) => s + l.price_data.unit_amount * l.quantity, 0)

  assert.equal(sum(buildSessionLineItems(order({}))), 1000)
  // quantity x price when exact...
  const exact = buildSessionLineItems(order({ totalCents: 3000, items: [item({ quantity: 3, unitPriceCents: 1000, totalCents: 3000 })] }))
  assert.equal(exact[0].quantity, 3)
  // ...otherwise the line total as one unit, so the sum cannot drift
  const inexact = buildSessionLineItems(order({ totalCents: 3001, items: [item({ quantity: 3, unitPriceCents: 1000, totalCents: 3001 })] }))
  assert.equal(inexact[0].quantity, 1)
  assert.equal(sum(inexact), 3001)
  assert.equal(sum(buildSessionLineItems(order({ totalCents: 1700, shippingCents: 700 }))), 1700)
  assert.equal(sum(buildSessionLineItems(order({ totalCents: 1220, taxCents: 220 }))), 1220)
  // anything inconsistent is refused instead of being charged
  assert.throws(() => buildSessionLineItems(order({ totalCents: 999 })))
  assert.throws(() => buildSessionLineItems(order({ totalCents: 1500 })), /do not add up/)
  assert.throws(() => buildSessionLineItems(order({ totalCents: 1220, taxCents: 100 })), /do not add up/)
})

// ====================================================================================================================
// reusing, expiring and blocking attempts
// ====================================================================================================================
test('an open payment page is handed out again; an expired one is replaced; a completed one blocks new pages', async () => {
  await fresh()
  const prisma = await db()
  const first = await pay({ key: 'reuse-key-000000001' })
  const again = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(again.json.url, first.json.url)
  assert.equal(fake.state.retrieveCalls, 1)
  assert.equal(fake.state.createdSessions, 1)

  // Stripe says it expired: a new attempt and a new session on the SAME order
  const oldSession = [...fake.sessions.values()][0]
  oldSession.status = 'expired'
  const replaced = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(replaced.res.status, 200)
  assert.equal(replaced.json.orderId, first.json.orderId)
  assert.notEqual(replaced.json.url, first.json.url)
  const attempts = await prisma.paymentAttempt.findMany({ orderBy: { createdAt: 'asc' } })
  assert.deepEqual(attempts.map((a) => a.status), ['expired', 'open'])
  assert.equal(await prisma.printOrder.count(), 1)

  // the customer already paid on Stripe's side: no further payment page, and the attempt is marked as in progress
  const newSession = [...fake.sessions.values()][1]
  newSession.status = 'complete'
  const calls = fake.state.createCalls
  const blocked = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(blocked.res.status, 409)
  assert.equal(blocked.json.code, 'ORDER_NOT_PAYABLE')
  assert.equal(blocked.json.reason, 'processing')
  assert.equal(fake.state.createCalls, calls)
  assert.equal((await prisma.paymentAttempt.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => a.status).join(), 'expired,processing')
  // and it stays blocked
  const still = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(still.res.status, 409)
  assert.equal(fake.state.createCalls, calls)
})

test('if Stripe cannot be asked about an existing page, nothing is changed and the customer is told to retry', async () => {
  await fresh()
  const prisma = await db()
  const first = await pay({ key: 'retrieve-fails-key-001' })
  fake.state.retrieveFails = true
  const r = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(r.res.status, 502)
  assert.equal(r.json.retry, true)
  assert.equal((await prisma.paymentAttempt.findFirstOrThrow()).status, 'open')
  assert.deepEqual(await counts(), { orders: 1, attempts: 1 })
})

test('orders that are paid, being paid or cancelled never get a new payment page', async () => {
  await fresh()
  const prisma = await db()
  const first = await pay({ key: 'blocked-states-key-01' })
  const calls = fake.state.createCalls
  const retry = () => post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  for (const [data, reason] of [
    [{ paymentStatus: 'paid', status: 'queued' }, 'paid'],
    [{ paymentStatus: 'processing', status: 'awaiting_payment' }, 'processing'],
    [{ paymentStatus: 'pending', status: 'cancelled' }, 'cancelled'],
    [{ paymentStatus: 'pending', status: 'printing' }, 'not_payable'],
  ] as const) {
    await prisma.printOrder.update({ where: { id: first.json.orderId }, data })
    const r = await retry()
    assert.equal(r.res.status, 409, reason)
    assert.equal(r.json.code, 'ORDER_NOT_PAYABLE')
    assert.equal(r.json.reason, reason)
  }
  assert.equal(fake.state.createCalls, calls)
  assert.equal(fake.state.retrieveCalls, 0)
})

test('an abandoned reservation is closed, not joined later', async () => {
  await fresh()
  const prisma = await db()
  fake.state.unreachableBeforeCreate = 1
  const first = await pay({ key: 'stale-reservation-001' })
  assert.equal(first.res.status, 502)
  await prisma.paymentAttempt.updateMany({ data: { createdAt: new Date(Date.now() - JOIN_WINDOW_MS - 60_000) } })
  const retry = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart })
  assert.equal(retry.res.status, 200)
  const attempts = await prisma.paymentAttempt.findMany({ orderBy: { createdAt: 'asc' } })
  assert.deepEqual(attempts.map((a) => a.status), ['expired', 'open'])
  assert.equal(attempts[0].failureReason, 'stale_reservation')
  assert.equal(await prisma.printOrder.count(), 1)
})

// ====================================================================================================================
// production guards, return addresses, origin, rate limit
// ====================================================================================================================
test('production: nothing is sold without a tax configuration, without being switched on, or without an https address', async () => {
  await fresh()
  const before = await counts()

  await withEnv({ NODE_ENV: 'production', BASE_URL: 'https://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: undefined }, async () => {
    const q = await post('quote', cart())
    assert.equal(q.res.status, 200)
    assert.equal(q.json.canCheckout, false)
    assert.equal(q.json.unavailableReason, 'TAX_NOT_CONFIGURED')
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...cart() })
    assert.equal(r.res.status, 503)
    assert.equal(r.json.code, 'TAX_NOT_CONFIGURED')
  })
  await withEnv({ NODE_ENV: 'production', BASE_URL: 'https://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: undefined, TAX_MODE: 'none' }, async () => {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: 1000, ...cart() })
    assert.equal(r.res.status, 503)
    assert.equal(r.json.code, 'CHECKOUT_DISABLED')
  })
  await withEnv({ NODE_ENV: 'production', BASE_URL: 'http://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: 1000, ...cart() })
    assert.equal(r.res.status, 503)
    assert.equal(r.json.code, 'CHECKOUT_UNAVAILABLE')
  })
  await withEnv({ NODE_ENV: 'production', BASE_URL: undefined, HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: 1000, ...cart() })
    assert.equal(r.res.status, 503)
  })
  assert.deepEqual(await counts(), before, 'a refused checkout creates nothing')
  assert.equal(fake.state.createCalls, 0)

  // everything in place: it works, over https, with a secure cookie
  await withEnv({ NODE_ENV: 'production', BASE_URL: 'https://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
    const quote = await quoteOf()
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote.totalCents, ...cart() })
    assert.equal(r.res.status, 200, r.text)
    assert.ok(fake.state.lastParams.success_url.startsWith('https://127.0.0.1:9/'))
    assert.match(r.res.headers.getSetCookie().join(';'), /Secure/i)
  })
})

test('production: card payments stay off until the shop has chosen its minimum order (0 = none, on purpose); no amount is made up', async () => {
  await fresh()
  const prisma = await db()
  const before = await counts()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: null } as any })
  try {
    await withEnv({ NODE_ENV: 'production', BASE_URL: 'https://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
      const q = await post('quote', cart())
      assert.equal(q.res.status, 200)
      assert.equal(q.json.canCheckout, false)
      assert.equal(q.json.unavailableReason, 'MINIMUM_ORDER_NOT_CONFIGURED')
      const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...cart() })
      assert.equal(r.res.status, 503)
      assert.equal(r.json.code, 'MINIMUM_ORDER_NOT_CONFIGURED')
    })
    assert.deepEqual(await counts(), before, 'a refused checkout creates nothing')
    assert.equal(fake.state.createCalls, 0)
    // development and tests are not held back by it
    const dev = await post('quote', cart())
    assert.equal(dev.json.canCheckout, true)
  } finally {
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 0 } as any })
  }
  // chosen (0 = none): it works
  await withEnv({ NODE_ENV: 'production', BASE_URL: 'https://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
    const q = await post('quote', cart())
    assert.equal(q.json.canCheckout, true)
  })
})

test('payment not configured, and development stays usable without a tax configuration', async () => {
  await fresh()
  await withEnv({ STRIPE_SECRET_KEY: undefined }, async () => {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: 1000, ...cart() })
    assert.equal(r.res.status, 503)
    assert.equal(r.json.code, 'PAYMENTS_NOT_CONFIGURED')
  })
  // not production, no TAX_MODE: allowed (the module only warns); this is what lets the rest be built first
  assert.equal((await pay()).res.status, 200)
})

test('the return address comes from configuration, never from the Host header', async () => {
  await fresh()
  const quote = await quoteOf()
  const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote.totalCents, ...cart() }, {
    url: 'http://evil.example/api/checkout/session', headers: { origin: 'http://evil.example', host: 'evil.example' },
  })
  assert.equal(r.res.status, 200)
  assert.ok(fake.state.lastParams.success_url.startsWith(process.env.BASE_URL as string))
  assert.ok(!JSON.stringify(fake.state.lastParams).includes('evil.example'))
})

test('the server never connects to an address taken from the Host header (colour palette lookup)', async () => {
  await fresh()
  const realFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => { urls.push(String(input)); throw new Error('no network in tests') }) as typeof fetch
  try {
    const evil = { url: 'http://evil.example/api/checkout/quote', headers: { origin: 'http://evil.example', host: 'evil.example' } }
    // configured address: the lookup goes there, not to the forged host
    assert.equal((await post('quote', cart(), evil)).res.status, 200)
    assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(process.env.BASE_URL as string)), urls.join(' '))
    // production without a usable address: no lookup at all rather than one to a forged host
    urls.length = 0
    await withEnv({ NODE_ENV: 'production', BASE_URL: undefined, HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
      assert.equal((await post('quote', cart(), evil)).res.status, 200)
    })
    assert.ok(urls.every((u) => !u.includes('evil.example')), urls.join(' '))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the quote tells the page when production has no usable https address', async () => {
  await fresh()
  await withEnv({ NODE_ENV: 'production', BASE_URL: 'http://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'true', TAX_MODE: 'none' }, async () => {
    const q = await post('quote', cart())
    assert.equal(q.res.status, 200)
    assert.equal(q.json.canCheckout, false)
    assert.equal(q.json.unavailableReason, 'CHECKOUT_UNAVAILABLE')
  })
})

test('session: requests from another site are refused', async () => {
  await fresh()
  const before = await counts()
  const body = { checkoutKey: newKey(), expectedTotalCents: 1000, ...cart() }
  assert.equal((await post('session', body, { headers: { origin: 'https://attacker.example' } })).res.status, 403)
  // no origin information at all
  viewerGuards.getViewer = async () => null
  const { POST } = await import('../../app/api/checkout/session/route')
  const bare = await (POST as any)(new NextRequest('http://localhost/api/checkout/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})
  assert.equal(bare.status, 403)
  assert.deepEqual(await counts(), before)
})

test('rate limit: one address, and the whole shop, are capped; a blocked request creates nothing', async () => {
  await fresh()
  await withEnv({ CHECKOUT_SESSION_RATE_MAX: '3' }, async () => {
    const ip = '203.0.113.9'
    const quote = (await quoteOf()).totalCents
    const statuses: number[] = []
    let blocked: Awaited<ReturnType<typeof post>> | null = null
    for (let i = 0; i < 5; i++) {
      const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote, ...cart() }, { ip })
      statuses.push(r.res.status)
      if (r.res.status === 429) blocked = r
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429])
    assert.equal(blocked!.json.code, 'RATE_LIMITED')
    assert.ok(Number(blocked!.res.headers.get('retry-after')) >= 1)
    assert.equal((await counts()).orders, 3, 'blocked requests must not create orders')
    // another address is not affected
    assert.equal((await post('session', { checkoutKey: newKey(), expectedTotalCents: quote, ...cart() }, { ip: '203.0.113.10' })).res.status, 200)
  })
  await fresh()
  await withEnv({ CHECKOUT_GLOBAL_RATE_MAX: '4' }, async () => {
    const quote = (await quoteOf()).totalCents // consumes quote budget, not session budget
    const before = (await counts()).orders
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      // a different (forged) address every time: the per-address limit never trips, the shop-wide one does
      const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote, ...cart() }, { ip: `198.51.100.${i + 1}` })
      statuses.push(r.res.status)
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429, 429])
    assert.equal((await counts()).orders - before, 4)
  })
})

test('rate limit counter: exact under simultaneous requests, and the very first request cannot fail', async () => {
  await fresh()
  const cfg = { windowMs: 60_000, max: 10 }
  const results = await Promise.all(Array.from({ length: 40 }, () => consumeFixedWindow('checkout:test:burst', cfg)))
  assert.equal(results.filter((r) => r.allowed).length, 10)
  assert.equal(results.filter((r) => !r.allowed).length, 30)
  assert.ok(results.filter((r) => !r.allowed).every((r) => (r.retryAfterSeconds ?? 0) >= 1))
  // a window that has passed starts again
  const prisma = await db()
  await prisma.rateLimit.update({ where: { key: 'checkout:test:burst' }, data: { resetAt: new Date(Date.now() - 1000) } })
  assert.equal((await consumeFixedWindow('checkout:test:burst', cfg)).allowed, true)
})

// ====================================================================================================================
// guest access token
// ====================================================================================================================
test('guest token: unit behaviour – valid, wrong, other order, expired, missing, account orders', () => {
  const issued = issueGuestAccess('cmorderA0000000000000001')
  const order = { userId: null, guestAccessTokenHash: issued.hash, guestAccessExpiresAt: issued.expiresAt }
  assert.equal(issued.token, deriveGuestAccessToken('cmorderA0000000000000001'))
  assert.notEqual(issued.hash, issued.token, 'only a hash is kept')
  assert.equal(issued.hash, hashGuestAccessToken(issued.token))
  assert.ok(issued.token.length >= 43)
  assert.notEqual(deriveGuestAccessToken('cmorderA0000000000000001'), deriveGuestAccessToken('cmorderB0000000000000002'))
  assert.equal(Math.round((issued.expiresAt.getTime() - Date.now()) / 1000), Math.round(GUEST_ACCESS_TTL_MS / 1000))

  assert.equal(verifyGuestAccess(order, issued.token), true)
  assert.equal(verifyGuestAccess(order, deriveGuestAccessToken('cmorderB0000000000000002')), false, 'the token of another order')
  assert.equal(verifyGuestAccess(order, issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A')), false, 'one character off')
  for (const bad of [null, undefined, '', 'x', 'x'.repeat(500)]) assert.equal(verifyGuestAccess(order, bad as any), false)
  assert.equal(verifyGuestAccess({ ...order, guestAccessExpiresAt: new Date(Date.now() - 1) }, issued.token), false, 'expired')
  assert.equal(verifyGuestAccess({ ...order, guestAccessExpiresAt: null }, issued.token), false)
  assert.equal(verifyGuestAccess({ ...order, guestAccessTokenHash: null }, issued.token), false)
  assert.equal(verifyGuestAccess({ ...order, userId: 'user_1' }, issued.token), false, 'an order of an account is never opened with a token')
  assert.equal(verifyGuestAccess(order, issued.token, new Date(Date.now() + GUEST_ACCESS_TTL_MS + 1000)), false)

  const cookie = buildGuestAccessCookieValue('cmorderA0000000000000001', issued.token)
  assert.deepEqual(parseGuestAccessCookie(cookie), { orderId: 'cmorderA0000000000000001', token: issued.token })
  for (const bad of [null, '', 'nodot', '.token', 'ord.', `${'a'.repeat(400)}.x`, 'ord A.token', `ordA.${'!'.repeat(40)}`]) {
    assert.equal(parseGuestAccessCookie(bad as any), null, String(bad))
  }
})

test('guest token: delivered in an HttpOnly cookie, stored only as a hash, expires', async () => {
  await fresh()
  const prisma = await db()
  const { res, json } = await pay({ key: 'guest-cookie-key-0001' })
  assert.equal(res.status, 200)
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${GUEST_ACCESS_COOKIE}=`))
  assert.ok(header, 'a guest receives the cookie')
  assert.match(header!, /HttpOnly/i)
  assert.match(header!, /SameSite=lax/i)
  assert.match(header!, /Path=\//)
  const maxAge = Number(/Max-Age=(\d+)/i.exec(header!)?.[1])
  assert.ok(maxAge > GUEST_ACCESS_TTL_MS / 1000 - 120 && maxAge <= GUEST_ACCESS_TTL_MS / 1000, `Max-Age ${maxAge}`)

  const value = decodeURIComponent(header!.split(';')[0].split('=').slice(1).join('='))
  const parsed = parseGuestAccessCookie(value)!
  assert.equal(parsed.orderId, json.orderId)
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId } })
  assert.equal(verifyGuestAccess(order, parsed.token), true)
  assert.equal(order.guestAccessTokenHash, hashGuestAccessToken(parsed.token))

  // the token is nowhere in the database or in what Stripe received
  const everything = JSON.stringify([
    await prisma.printOrder.findMany({ include: { items: true } }),
    await prisma.paymentAttempt.findMany(),
    await prisma.stripeEvent.findMany(),
  ])
  assert.ok(!everything.includes(parsed.token), 'the plain token must never be stored')
  assert.ok(!JSON.stringify(fake.state.allParams).includes(parsed.token), 'the token must not be sent to Stripe')

  // same token on every response of the same checkout (no rotation race), and it stops working after the expiry
  const again = await post('session', { checkoutKey: 'guest-cookie-key-0001', expectedTotalCents: json.totalCents, ...cart() })
  const header2 = again.res.headers.getSetCookie().find((c) => c.startsWith(`${GUEST_ACCESS_COOKIE}=`))!
  assert.equal(header2.split(';')[0], header!.split(';')[0])
  await prisma.printOrder.update({ where: { id: json.orderId }, data: { guestAccessExpiresAt: new Date(Date.now() - 1000) } })
  assert.equal(verifyGuestAccess(await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId } }), parsed.token), false)
})

test('guest token: it opens nothing else – no files, no receipts, no order API, nobody else\'s order', async () => {
  await fresh()
  const prisma = await db()
  const { res, json } = await pay({ key: 'guest-scope-key-0001' })
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${GUEST_ACCESS_COOKIE}=`))!
  const cookie = header.split(';')[0]
  const orderId = json.orderId
  writeStorageFile(`orders/${orderId}/receipts/r.pdf`, 'FAKE-RECEIPT')

  // files: the receipt of the very order the token belongs to stays private
  const filesRoute = await import('../../app/files/[...path]/route')
  fileRouteGuards.getViewer = async () => null
  const segments = ['orders', orderId, 'receipts', 'r.pdf']
  const file = await (filesRoute.GET as any)(
    new NextRequest(`http://localhost/files/${segments.join('/')}`, { headers: { cookie } }), { params: Promise.resolve({ path: segments }) })
  assert.equal(file.status, 401)

  // the customer order API and the order messages API
  const orderRoute = await import('../../app/api/customer/orders/[orderId]/route')
  const detail = await (orderRoute.GET as any)(
    new NextRequest(`http://localhost/api/customer/orders/${orderId}`, { headers: { cookie } }), { params: Promise.resolve({ orderId }) })
  assert.ok([401, 403, 404].includes(detail.status), `order API answered ${detail.status}`)
  const messagesRoute = await import('../../app/api/customer/orders/[orderId]/messages/route')
  const message = await (messagesRoute.POST as any)(
    new NextRequest(`http://localhost/api/customer/orders/${orderId}/messages`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello' }),
    }), { params: Promise.resolve({ orderId }) })
  assert.ok([401, 403, 404].includes(message.status), `messages API answered ${message.status}`)

  // another guest order: this token does not verify against it
  const other = await pay({ key: 'guest-scope-key-0002', cartOver: { items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] } })
  const mine = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  const theirs = await prisma.printOrder.findUniqueOrThrow({ where: { id: other.json.orderId } })
  const token = parseGuestAccessCookie(decodeURIComponent(cookie.split('=').slice(1).join('=')))!.token
  assert.equal(verifyGuestAccess(mine, token), true)
  assert.equal(verifyGuestAccess(theirs, token), false)
  // an order that belongs to an account cannot be opened with any token
  const registered = await pay({ viewer: viewerA() })
  const account = await prisma.printOrder.findUniqueOrThrow({ where: { id: registered.json.orderId } })
  assert.equal(verifyGuestAccess(account, deriveGuestAccessToken(account.id)), false)
})

// ====================================================================================================================
// cross-cutting
// ====================================================================================================================
// The probe (in _fake-checkout.ts) looks at every database connection at the moment "Stripe" is called. With one request at a time,
// any open transaction can only be that request's own, so 0 here means the code never calls Stripe inside a transaction.
test('no database transaction was ever open during a Stripe call (requests made one at a time)', () => {
  assert.equal(Math.max(maxIdleSeen, fake.state.maxIdleInTransaction), 0)
})

test('checkout orders cannot start production: the production gate treats them as unpaid', async () => {
  await fresh()
  const prisma = await db()
  const { json } = await pay()
  const { isProductionEligible } = await import('../../lib/order-payment-policy')
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.orderId }, include: { paymentAttempts: true } })
  assert.equal(isProductionEligible(order), false)
  const { checkManualTransition } = await import('../../lib/order-payment-policy')
  assert.equal(checkManualTransition(order, 'queued', { adminId: 'admin_1' }).allowed, false)
  assert.ok(stripeCalls.length > 0)
})
