// Step 4.5 – an order whose payment WAS being confirmed returns to "waiting for its payment" when Stripe, asked through the payment sync, shows that the payment
// page ended without money moving - and only then (lib/payment-verification.ts decidePaymentUpdate + lib/payment-sync.ts). Without it the order stays
// "confirming" for ever. The rules of the decision itself are tests/payment-processing-ended.test.ts; here it is the sync that is tested, against the database:
//   * the attempt that was being confirmed ends (expired) and the order goes back to pending - and, when nothing else could bring money, is closed;
//   * if ANOTHER attempt of the order could still bring money or waits for a person (processing / paid / mismatch), the order is left as it is;
//   * a payment page that is merely open, or a payment that Stripe shows as collected, never ends anything.
// Fake Stripe, throw-away database, fake data.
import { db, resetDb, seedShopModel } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { syncPayment } from '../../lib/payment-sync'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let customer: Viewer

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT

let ipSeq = 0
const nextIp = () => `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `end-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`

async function startPayment() {
  viewerGuards.getViewer = async () => customer
  const quoteMod = await import('../../app/api/checkout/quote/route')
  const sessionMod = await import('../../app/api/checkout/session/route')
  const body = { items: [{ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false }
  const quote = (await (quoteMod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const total = (await quote.json()).totalCents as number
  const res = (await (sessionMod.POST as any)(new NextRequest('http://localhost/api/checkout/session', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ ...body, checkoutKey: newKey(), expectedTotalCents: total }),
  }), {})) as Response
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as { orderId: string }
}
async function reset() {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, reads: [], failNextReads: 0, retrieveFails: false })
}
const row = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id }, include: { paymentAttempts: { orderBy: { createdAt: 'asc' } } } })
const sync = (orderId: string, attemptId: string, sessionId: string) => syncPayment({ kind: 'checkout_session', id: sessionId, hint: { orderId, attemptId } }, { eventType: 'test.end' })

// an order being confirmed: its payment page is open at Stripe and the attempt is "processing"
async function confirming() {
  const { orderId } = await startPayment()
  const prisma = await db()
  const order = await row(orderId)
  await prisma.printOrder.update({ where: { id: orderId }, data: { paymentStatus: 'processing' } })
  await prisma.paymentAttempt.update({ where: { id: order.paymentAttempts[0].id }, data: { status: 'processing' } })
  return { orderId, attemptId: order.paymentAttempts[0].id, sessionId: order.paymentAttempts[0].stripeSessionId as string }
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  customer = { id: (await prisma.user.create({ data: { email: 'end-customer@sectest.invalid', passwordHash: 'x', name: 'end', role: 'customer' } })).id, role: 'customer' }
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('the page Stripe reports as expired, with no money on it: the confirmation ends, the attempt is expired, the order is closed (nothing could bring money)', async () => {
  await reset()
  const c = await confirming()
  fake.sessions.get(c.sessionId)!.status = 'expired'
  await sync(c.orderId, c.attemptId, c.sessionId)
  const order = await row(c.orderId)
  assert.equal(order.paymentStatus, 'canceled')
  assert.equal(order.status, 'cancelled')
  assert.deepEqual(order.paymentAttempts.map((a) => a.status), ['expired'])
  assert.equal((order.metadata as any).cancellation.reason, 'checkout_expired')
})

test('a page that is merely OPEN says nothing about the money: the order stays "confirming"', async () => {
  await reset()
  const c = await confirming()
  await sync(c.orderId, c.attemptId, c.sessionId)
  const order = await row(c.orderId)
  assert.equal(order.paymentStatus, 'processing')
  assert.equal(order.status, 'awaiting_payment')
  assert.deepEqual(order.paymentAttempts.map((a) => a.status), ['processing'])
})

test('an expired page whose payment is collected is PAID, not ended', async () => {
  await reset()
  const c = await confirming()
  fake.pay(c.sessionId, { status: 'expired' })
  await sync(c.orderId, c.attemptId, c.sessionId)
  const order = await row(c.orderId)
  assert.equal(order.paymentStatus, 'paid')
  assert.notEqual(order.status, 'cancelled')
})

test('ANOTHER attempt that waits for a person keeps the order as it is: the confirmation does not end', async () => {
  await reset()
  const c = await confirming()
  const prisma = await db()
  await prisma.paymentAttempt.create({ data: { orderId: c.orderId, amountCents: 1000, currency: 'EUR', status: 'mismatch', expiresAt: new Date(Date.now() + 3600_000), stripeSessionId: 'cs_test_FAKE_other' } })
  fake.sessions.get(c.sessionId)!.status = 'expired'
  await sync(c.orderId, c.attemptId, c.sessionId)
  const order = await row(c.orderId)
  assert.equal(order.paymentStatus, 'processing', 'unchanged: the other attempt could still be money')
  assert.equal(order.status, 'awaiting_payment')
})

test('ANOTHER attempt that is also being confirmed keeps the order as it is', async () => {
  await reset()
  const c = await confirming()
  const prisma = await db()
  await prisma.paymentAttempt.create({ data: { orderId: c.orderId, amountCents: 1000, currency: 'EUR', status: 'processing', expiresAt: new Date(Date.now() + 3600_000), stripeSessionId: 'cs_test_FAKE_other2' } })
  fake.sessions.get(c.sessionId)!.status = 'expired'
  await sync(c.orderId, c.attemptId, c.sessionId)
  assert.equal((await row(c.orderId)).paymentStatus, 'processing')
})

test('an attempt that was not being confirmed is not turned into an ended confirmation by its own expiry', async () => {
  await reset()
  const c = await confirming()
  const prisma = await db()
  // the OTHER attempt is the one being confirmed; this one (a plain open page) expires
  await prisma.paymentAttempt.update({ where: { id: c.attemptId }, data: { status: 'open' } })
  const other = await prisma.paymentAttempt.create({ data: { orderId: c.orderId, amountCents: 1000, currency: 'EUR', status: 'processing', expiresAt: new Date(Date.now() + 3600_000), stripeSessionId: 'cs_test_FAKE_third' } })
  void other
  fake.sessions.get(c.sessionId)!.status = 'expired'
  await sync(c.orderId, c.attemptId, c.sessionId)
  const order = await row(c.orderId)
  assert.equal(order.paymentStatus, 'processing')
  assert.notEqual(order.status, 'cancelled')
})
