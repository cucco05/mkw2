// Step 4.4 – the same cart is not paid twice, whatever tab, key or memory the browser has.
//
// The browser keeps the cart (and the repeat-key) in localStorage and, since step 4.4, empties the cart only when the server has verified the payment.
// That memory can be lost, copied to another tab or cleared. So the SERVER refuses to start a second payment for a cart whose payment is being confirmed
// or waits for a person, deciding from its own orders - the signed-in customer's, or the ones the guest's access cookie really opens:
//   * confirming / "received, under check"  -> 409 PAYMENT_IN_PROGRESS (the order id of the customer's OWN order, nothing else), no order, no Stripe call;
//   * not paid yet (an open payment page)   -> the same order and the same payment page again, also for a guest (second tab, lost key);
//   * paid and in production                -> the customer may order the same things again (a new order);
//   * closed (the payment page expired)     -> a new order;
//   * another cart / another customer / a forged cookie / an entry older than the guest's access -> never blocked, never reused.
// Step 4.5 – a payment in doubt is NOT let through because time has passed (it used to be after 72 hours). It is let through when the SERVER learns from Stripe
// that no money is moving, and not before:
//   * confirming + Stripe says the payment page expired / no money is moving   -> the order waits for its payment again (or is closed): the customer may pay again;
//   * confirming + Stripe says paid                                          -> the customer HAS paid: answered as in progress once more (no second payment right after);
//   * confirming + Stripe can not be asked / still processing                  -> blocked, however old;
//   * under review (money arrived, a person decides)                           -> blocked, however old, until an administrator resolves it (payment-hold.sec.ts).
// Fake Stripe, throw-away database, fake data.
import { db, resetDb, seedShopModel } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { GUEST_ACCESS_COOKIE } from '../../lib/guest-order-access'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let customer: Viewer
let otherCustomer: Viewer

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT

let ipSeq = 0
const nextIp = () => `10.8.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `cap-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const cartOf = (qty = 1) => ({ items: [{ modelId, qty, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false })

async function session(viewer: Viewer | null, opts: { qty?: number; key?: string; cookie?: string | null } = {}) {
  viewerGuards.getViewer = async () => viewer
  const quoteMod = await import('../../app/api/checkout/quote/route')
  const sessionMod = await import('../../app/api/checkout/session/route')
  const body = cartOf(opts.qty)
  const quote = (await (quoteMod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const total = (await quote.json()).totalCents as number
  const headers: Record<string, string> = { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }
  if (opts.cookie) headers.cookie = `${GUEST_ACCESS_COOKIE}=${opts.cookie}`
  const res = (await (sessionMod.POST as any)(new NextRequest('http://localhost/api/checkout/session', {
    method: 'POST', headers, body: JSON.stringify({ ...body, checkoutKey: opts.key ?? newKey(), expectedTotalCents: total }),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  const setCookie = res.headers.get('set-cookie') || ''
  const cookie = new RegExp(`${GUEST_ACCESS_COOKIE}=([^;]+)`).exec(setCookie)?.[1] ?? null
  return { status: res.status, json, text, cookie }
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
const setOrder = async (id: string, data: Record<string, unknown>) => (await db()).printOrder.update({ where: { id }, data: data as any })

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}@sectest.invalid`, passwordHash: 'x', name: n, role: 'customer' } })
  customer = { id: (await mk('cap-customer')).id, role: 'customer' }
  otherCustomer = { id: (await mk('cap-other')).id, role: 'customer' }
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ---- a signed-in customer ------------------------------------------------------------------------------------------------------------------
test('customer: a payment for this cart that is being confirmed can not be started again, with another key or from another tab', async () => {
  await reset()
  const first = await session(customer)
  assert.equal(first.status, 200, first.text)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const calls = fake.state.createCalls
  const second = await session(customer, { key: newKey() })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.code, 'PAYMENT_IN_PROGRESS')
  assert.equal(second.json.orderId, first.json.orderId, 'the customer\'s own order is named, so the page can lead to it')
  assert.deepEqual(Object.keys(second.json).sort(), ['code', 'error', 'orderId', 'orderNumber'], 'and nothing else about it')
  assert.equal(await orderCount(), 1, 'no second order')
  assert.equal(fake.state.createCalls, calls, 'and no second payment page')
})

test('customer: a payment that arrived and waits for a person (paid + review) blocks the same cart too', async () => {
  await reset()
  const first = await session(customer)
  await setOrder(first.json.orderId, { paymentStatus: 'paid', status: 'awaiting_review', paymentReviewReason: 'amount_mismatch', paidAt: new Date() })
  const second = await session(customer, { key: newKey() })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.code, 'PAYMENT_IN_PROGRESS')
  assert.equal(await orderCount(), 1)
})

test('customer: the attempt being "processing" at Stripe (the customer finished paying, the confirmation is not in yet) blocks as well', async () => {
  await reset()
  const first = await session(customer)
  const prisma = await db()
  await prisma.paymentAttempt.updateMany({ where: { orderId: first.json.orderId }, data: { status: 'processing' } })
  const second = await session(customer, { key: newKey() })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.code, 'PAYMENT_IN_PROGRESS')
})

test('customer: not paid yet (the payment page is open in another tab) -> the same order and the same payment page, not a second order', async () => {
  await reset()
  const first = await session(customer)
  const second = await session(customer, { key: newKey() })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json.orderId, first.json.orderId)
  assert.equal(second.json.url, first.json.url, 'the payment page that is already open')
  assert.equal(await orderCount(), 1)
})

test('customer: once the payment is verified and the order is in production, the same things can be ordered again (a new order)', async () => {
  await reset()
  const first = await session(customer)
  await setOrder(first.json.orderId, { paymentStatus: 'paid', status: 'queued', paidAt: new Date() })
  const again = await session(customer, { key: newKey() })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.json.orderId)
  assert.equal(await orderCount(), 2)
})

test('customer: a payment page that expired (order closed, nothing charged) does not block a new attempt', async () => {
  await reset()
  const first = await session(customer)
  await setOrder(first.json.orderId, { status: 'cancelled', paymentStatus: 'canceled' })
  const again = await session(customer, { key: newKey() })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.json.orderId)
})

test('another cart is never blocked, and neither is another customer buying the same things', async () => {
  await reset()
  const first = await session(customer)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const bigger = await session(customer, { qty: 2, key: newKey() })
  assert.equal(bigger.status, 200, `a different cart (2 pieces): ${bigger.text}`)
  const stranger = await session(otherCustomer, { key: newKey() })
  assert.equal(stranger.status, 200, `another customer, the same cart: ${stranger.text}`)
  assert.notEqual(stranger.json.orderId, first.json.orderId)
})

const DAY = 24 * 3600 * 1000
const firstSessionId = () => [...fake.sessions.keys()][0]
async function inDoubt(viewer: Viewer | null, opts: { ageMs?: number } = {}) {
  const first = await session(viewer)
  assert.equal(first.status, 200, first.text)
  const prisma = await db()
  await setOrder(first.json.orderId, { paymentStatus: 'processing', ...(opts.ageMs ? { createdAt: new Date(Date.now() - opts.ageMs) } : {}) })
  await prisma.paymentAttempt.updateMany({ where: { orderId: first.json.orderId }, data: { status: 'processing' } })
  await prisma.rateLimit.deleteMany()
  return first
}
const order = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id } })

test('4.5 a payment in doubt keeps blocking however old the order is: time alone never lets a second payment through', async () => {
  await reset()
  const first = await inDoubt(customer, { ageMs: 30 * DAY })
  const second = await session(customer, { key: newKey() })
  assert.equal(second.status, 409, `30 days old, Stripe says it is still being processed: ${second.text}`)
  assert.equal(second.json.code, 'PAYMENT_IN_PROGRESS')
  assert.equal(await orderCount(), 1)
  // under review: the same, and Stripe is not even asked (nothing it can say settles it: a person decides)
  await setOrder(first.json.orderId, { paymentStatus: 'paid', status: 'awaiting_review', paymentReviewReason: 'amount', paidAt: new Date(), createdAt: new Date(Date.now() - 90 * DAY) })
  const reads = fake.state.reads.length
  const third = await session(customer, { key: newKey() })
  assert.equal(third.status, 409, third.text)
  assert.equal(fake.state.reads.length, reads, 'no read of Stripe for a payment that waits for a person')
  assert.equal(await orderCount(), 1)
})

test('4.5 confirming + Stripe says the payment page expired (no money is moving): the order is closed and the customer may pay again', async () => {
  await reset()
  const first = await inDoubt(customer)
  fake.sessions.get(firstSessionId())!.status = 'expired'
  const again = await session(customer, { key: newKey() })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.json.orderId, 'a new order')
  const old = await order(first.json.orderId)
  assert.equal(old.status, 'cancelled')
  assert.equal(old.paymentStatus, 'canceled')
  assert.equal(await (await db()).paymentAttempt.count({ where: { orderId: first.json.orderId, status: 'expired' } }), 1)
})

test('4.5 confirming + Stripe says paid: the customer has paid - answered as in progress once more, then the same things can be ordered again', async () => {
  await reset()
  const first = await inDoubt(customer)
  fake.pay(firstSessionId())
  const calls = fake.state.createCalls
  const again = await session(customer, { key: newKey() })
  assert.equal(again.status, 409, `a second payment right after the first would be a double charge: ${again.text}`)
  assert.equal(again.json.code, 'PAYMENT_IN_PROGRESS')
  assert.equal(again.json.orderId, first.json.orderId)
  assert.equal(fake.state.createCalls, calls)
  const paid = await order(first.json.orderId)
  assert.equal(paid.paymentStatus, 'paid', 'and the server recorded it, from Stripe')
  await (await db()).rateLimit.deleteMany()
  const later = await session(customer, { key: newKey() })
  assert.equal(later.status, 200, `paid and in production: a new order is allowed: ${later.text}`)
  assert.notEqual(later.json.orderId, first.json.orderId)
})

test('4.5 confirming + Stripe can not be asked: it stays blocked, nothing is changed', async () => {
  await reset()
  const first = await inDoubt(customer)
  fake.sessions.get(firstSessionId())!.status = 'expired'
  fake.state.failNextReads = 5
  const again = await session(customer, { key: newKey() })
  fake.state.failNextReads = 0
  assert.equal(again.status, 409, again.text)
  assert.equal(await orderCount(), 1)
  assert.equal((await order(first.json.orderId)).paymentStatus, 'processing')
})

test('4.5 the server asks Stripe about a payment in doubt at most every few seconds per order (no storm of reads from a customer pressing Pay)', async () => {
  await reset()
  await inDoubt(customer)
  const reads = fake.state.reads.length
  await session(customer, { key: newKey() })
  const afterFirst = fake.state.reads.length
  assert.ok(afterFirst > reads, 'asked once')
  await session(customer, { key: newKey() })
  await session(customer, { key: newKey() })
  assert.equal(fake.state.reads.length, afterFirst, 'the next requests, a moment later, are answered from what is held')
})

test('4.5 a guest with the cookie is checked the same way: Stripe says it expired -> may pay again', async () => {
  await reset()
  const first = await inDoubt(null)
  fake.sessions.get(firstSessionId())!.status = 'expired'
  const again = await session(null, { key: newKey(), cookie: first.cookie })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.json.orderId)
})

test('the same key and cart still lead to the same order (the old protection is untouched)', async () => {
  await reset()
  const key = newKey()
  const first = await session(customer, { key })
  const again = await session(customer, { key })
  assert.equal(again.status, 200, again.text)
  assert.equal(again.json.orderId, first.json.orderId)
  assert.equal(await orderCount(), 1)
})

// ---- a guest: the browser holds the access cookie of its own orders ---------------------------------------------------------------------------
test('guest: with the cookie of the order, a payment being confirmed blocks the same cart, from another tab and with another key', async () => {
  await reset()
  const first = await session(null)
  assert.equal(first.status, 200, first.text)
  assert.ok(first.cookie, 'the guest got the access cookie of the order')
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const calls = fake.state.createCalls
  const second = await session(null, { key: newKey(), cookie: first.cookie })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.code, 'PAYMENT_IN_PROGRESS')
  assert.equal(second.json.orderId, first.json.orderId)
  assert.equal(await orderCount(), 1)
  assert.equal(fake.state.createCalls, calls)
})

test('guest: with the cookie, an order not paid yet is the same purchase: the second tab opens the same payment page', async () => {
  await reset()
  const first = await session(null)
  const second = await session(null, { key: newKey(), cookie: first.cookie })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json.orderId, first.json.orderId)
  assert.equal(second.json.url, first.json.url)
  assert.equal(await orderCount(), 1)
  assert.ok(second.cookie, 'and the cookie is sent again')
})

test('guest: two tabs asking at the same moment with the SAME key (the browser shares it between its tabs) make ONE order', async () => {
  await reset()
  const key = newKey()
  const [a, b] = await Promise.all([session(null, { key }), session(null, { key })])
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.equal(a.json.orderId, b.json.orderId, 'one order for the two tabs')
  assert.equal(await orderCount(), 1)
  assert.equal(a.json.url, b.json.url, 'and one payment page')
})

test('guest: two FIRST requests at the same moment with different keys and no cookie yet can not know each other - the limit, written down (the shared key above is what covers it)', async () => {
  await reset()
  const [a, b] = await Promise.all([session(null, { key: newKey() }), session(null, { key: newKey() })])
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.notEqual(a.json.orderId, b.json.orderId)
  // and when the cookie of the first one reaches the browser, the next attempt is the same purchase again
  const third = await session(null, { key: newKey(), cookie: a.cookie })
  assert.equal(third.status, 200, third.text)
  assert.equal(third.json.orderId, a.json.orderId)
})

test('guest: a cookie that opens nothing (forged token, another order\'s token, expired access) is ignored: never blocked, never reused', async () => {
  await reset()
  const first = await session(null)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const real = first.cookie as string
  const [orderId] = real.split('.')
  const forged = `${orderId}.${'A'.repeat(43)}`
  const wrong = await session(null, { key: newKey(), cookie: forged })
  assert.equal(wrong.status, 200, `a forged token must not reveal or reuse the order: ${wrong.text}`)
  assert.notEqual(wrong.json.orderId, first.json.orderId)
  await reset()
  const second = await session(null)
  await setOrder(second.json.orderId, { paymentStatus: 'processing', guestAccessExpiresAt: new Date(Date.now() - 1000) })
  const expired = await session(null, { key: newKey(), cookie: second.cookie })
  assert.equal(expired.status, 200, `access that has expired opens nothing: ${expired.text}`)
})

test('guest: without the cookie (cleared, or another browser) the server can not know the earlier order and a new one is made - the limit, written down', async () => {
  await reset()
  const first = await session(null)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const second = await session(null, { key: newKey(), cookie: null })
  assert.equal(second.status, 200, second.text)
  assert.notEqual(second.json.orderId, first.json.orderId)
})

test('a guest\'s cookie never lets them see or block anything of a registered customer', async () => {
  await reset()
  const first = await session(customer)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  // a guest cannot hold a cookie for an account order (verifyGuestAccess is false for those), whatever they send
  const guest = await session(null, { key: newKey(), cookie: `${first.json.orderId}.${'B'.repeat(43)}` })
  assert.equal(guest.status, 200, guest.text)
  assert.notEqual(guest.json.orderId, first.json.orderId)
})
