// Step 4.6 - what happens to a COMPLETE MODEL after the quote: the order that is written, the lines Stripe is asked to charge, and the guard that keeps one
// purchase from becoming two orders.
//
//   * quote = order = Stripe, to the cent, for a complete model (the lines of one key) and for the same parts bought one by one;
//   * the order keeps WHAT WAS SOLD on every line (`configuration.unit`, `configuration.pricing`) and the lines of the order keep the price of each part;
//   * the fingerprint of a cart (version 2) does not depend on the random value of the grouping key or on the order of the lines: a cart rebuilt with other keys, in
//     another order, is the SAME purchase (the same unpaid order again, no second order, no second payment page); a different grouping is a different purchase;
//   * the fingerprint of an order made before step 4.6 (version 1) is still recognised, so an old unpaid order is not duplicated by an upgrade.
// Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb } from './_harness'
import { strongTestKey } from './_keys'
import { guestHeaders } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { cartFingerprintV1, checkoutFingerprintV1 } from '../../lib/checkout-orders'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let data: ScenarioData
let customer: Viewer
let ipSeq = 0
const nextIp = () => `10.14.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => strongTestKey(`so-${++keySeq}`)
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', STRIPE_MINIMUM_CHARGE_CENTS: '0', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT

const Q3 = (key: string | undefined, over: Partial<ItemSpec> = {}): ItemSpec[] => ([1, 2, 3] as const).map((part) => ({ model: 'Q', part, ...(key ? { setKey: key } : {}), ...over }))

function requestOf(specs: ItemSpec[], mutate: (items: any[]) => any[] = (items) => items) {
  const request: any = buildQuoteRequest(specs.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
  request.items.forEach((entry: any, i: number) => { if (specs[i].setKey) entry.setKey = specs[i].setKey })
  request.items = mutate(request.items)
  return request
}
async function call(route: 'quote' | 'session', body: unknown, viewer: Viewer | null) {
  viewerGuards.getViewer = async () => viewer
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
// quote, then pay: the way the page does it (the total shown is sent back)
async function pay(request: any, viewer: Viewer | null = customer, key = newKey()) {
  const quote = await call('quote', request, viewer)
  assert.equal(quote.status, 200, quote.text)
  const session = await call('session', { ...request, checkoutKey: key, expectedTotalCents: quote.json.totalCents }, viewer)
  return { quote: quote.json, session }
}
async function reset() {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, lastParams: null, allParams: [], rejectCreate: false })
}
const orderCount = async () => (await db()).printOrder.count()

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  await seedScenarioConfig()
  await configureTestMachine({ buildXmm: 2000, buildYmm: 2000, buildZmm: 2000 })
  data = await seedScenarioModels('so')
  const prisma = await db()
  customer = { id: (await prisma.user.create({ data: { email: 'so-customer@sectest.invalid', passwordHash: 'x', name: 'so-customer', role: 'customer' } })).id, role: 'customer' }
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('a complete model: quote = order = what Stripe is asked to charge, to the cent, and the order remembers what was sold', async () => {
  await reset()
  const { quote, session } = await pay(requestOf(Q3('set-key-0001', { qty: 2 })))
  assert.equal(session.status, 200, session.text)
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: session.json.orderId }, include: { items: { orderBy: { createdAt: 'asc' } } } })
  assert.equal(order.totalCents, quote.totalCents)
  assert.equal(order.subtotalCents, quote.itemsTotalCents)
  // the lines of the order are the lines of the quote
  assert.deepEqual(order.items.map((item) => item.unitPriceCents), quote.items.map((line: any) => line.unitPriceCents))
  assert.equal(order.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0), quote.itemsTotalCents)
  // what Stripe is asked to charge
  const lines = fake.state.lastParams.line_items as any[]
  const stripeTotal = lines.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0)
  assert.equal(stripeTotal, quote.totalCents)
  // what was SOLD, on every line
  for (const item of order.items) {
    const configuration = (item.configuration ?? {}) as any
    assert.deepEqual(configuration.unit, { kind: 'set', setOrdinal: 1, copies: 2, parts: 3 })
    assert.equal(configuration.pricing.minimumUnitCents, 500)
    assert.equal(configuration.pricing.waiverId, null)
    assert.equal(typeof configuration.pricing.floored, 'boolean')
  }
  const metadata = order.metadata as any
  assert.ok(Array.isArray(metadata.checkout.lines) && metadata.checkout.lines.every((line: any) => line.unit?.kind === 'set'), 'the production report knows the lines are one model')
})

test('the same parts bought one by one: three units, each with its own minimum; the order says so', async () => {
  await reset()
  const { quote, session } = await pay(requestOf(Q3(undefined, { scale: 0.3 })))
  assert.equal(session.status, 200, session.text)
  assert.equal(quote.itemsTotalCents, 1500, 'three parts, three minimums')
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: session.json.orderId }, include: { items: true } })
  assert.equal(order.totalCents, 1500)
  assert.ok(order.items.every((item) => (item.configuration as any).unit.kind === 'part' && (item.configuration as any).pricing.floored === true))
})

test('the same purchase rebuilt with other keys and its lines in another order is the SAME purchase: the unpaid order and its payment page again, no second order', async () => {
  await reset()
  const first = await pay(requestOf(Q3('set-key-0001')))
  assert.equal(first.session.status, 200, first.session.text)
  const calls = fake.state.createCalls
  // new random keys, lines reversed, a new repeat-key (another tab with nothing in storage)
  const rebuilt = requestOf(Q3('zzzz-another-key'), (items) => items.slice().reverse())
  const second = await pay(rebuilt, customer, newKey())
  assert.equal(second.session.status, 200, second.session.text)
  assert.equal(second.session.json.orderId, first.session.json.orderId, 'the same order')
  assert.equal(await orderCount(), 1, 'no second order')
  assert.equal(fake.state.createCalls, calls, 'and no second payment page')
})

test('a DIFFERENT grouping is a different purchase: the same parts one by one are not the complete model', async () => {
  await reset()
  const complete = await pay(requestOf(Q3('set-key-0001')))
  const single = await pay(requestOf(Q3(undefined)))
  assert.equal(complete.session.status, 200, complete.session.text)
  assert.equal(single.session.status, 200, single.session.text)
  assert.notEqual(single.session.json.orderId, complete.session.json.orderId)
  assert.notEqual(single.quote.totalCents, complete.quote.totalCents, 'and a different price')
  assert.equal(await orderCount(), 2)
})

test('an order made before step 4.6 (its fingerprint is version 1) is still recognised: the same unpaid order again, not a second one', async () => {
  await reset()
  const request = requestOf(Q3(undefined))
  const first = await pay(request)
  assert.equal(first.session.status, 200, first.session.text)
  // make the stored order look like one written by step 4.5: fingerprints computed the old way, from the lines as sent
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: first.session.json.orderId } })
  const input = { principalId: customer!.id, items: request.items, shippingMethod: 'pickup' as const, rush: false }
  const metadata = order.metadata as any
  metadata.checkout.fingerprint = checkoutFingerprintV1({ ...input, expectedTotalCents: first.quote.totalCents })
  metadata.checkout.cartFingerprint = cartFingerprintV1(input)
  await prisma.printOrder.update({ where: { id: order.id }, data: { metadata, checkoutKey: null } })
  const calls = fake.state.createCalls
  const again = await pay(request, customer, newKey())
  assert.equal(again.session.status, 200, again.session.text)
  assert.equal(again.session.json.orderId, order.id, 'the old unpaid order is reused')
  assert.equal(await orderCount(), 1)
  assert.equal(fake.state.createCalls, calls)
})
