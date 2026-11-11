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
import { strongTestKey } from './_keys'
import { guestHeaders, newGuestBrowser, type GuestBrowser } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { GUEST_ACCESS_COOKIE } from '../../lib/guest-order-access'
import { syncPayment } from '../../lib/payment-sync'
import { pageJobsSettled } from '../../lib/checkout-pages'
import { REASON_CLOSED_BY_US, REASON_PROVIDER_EXPIRED } from '../../lib/checkout-session-plan'
import { REPEAT_CONTEXT_FORMAT, REPEAT_PROPOSAL_KEYS, withCheckoutFlags } from './_checkout-flags'

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
const newKey = () => strongTestKey(`cap-${++keySeq}`)
const cartOf = (qty = 1) => ({ items: [{ modelId, qty, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false })

async function session(viewer: Viewer | null, opts: { qty?: number; key?: string; cookie?: string | null; browser?: GuestBrowser; extra?: Record<string, unknown> } = {}) {
  viewerGuards.getViewer = async () => viewer
  const quoteMod = await import('../../app/api/checkout/quote/route')
  const sessionMod = await import('../../app/api/checkout/session/route')
  const body = cartOf(opts.qty)
  const quote = (await (quoteMod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const total = (await quote.json()).totalCents as number
  const headers: Record<string, string> = { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders({}, opts.browser) }
  if (opts.cookie) headers.cookie = `${headers.cookie}; ${GUEST_ACCESS_COOKIE}=${opts.cookie}`
  const res = (await (sessionMod.POST as any)(new NextRequest('http://localhost/api/checkout/session', {
    method: 'POST', headers, body: JSON.stringify({ ...body, checkoutKey: opts.key ?? newKey(), expectedTotalCents: total, ...(opts.extra ?? {}) }),
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

// What a payment really leaves (A): the customer pays on the provider's page and the server verifies it, as a webhook does (lib/payment-sync.ts) - the order is paid, released to production
// (`queued`) and its page is the one that carried the payment. What a page that really ran out leaves: the provider expired it, the server read that, closed the page with the provider's proof and
// the order with it. (Until R1-3 these tests MARKED the order paid / cancelled by hand and left its page open at the provider: that is not what a payment leaves - it is the anomalous state the owner
// guard holds, with its own tests below.)
const sessionIdOfOrder = async (orderId: string) => ((await (await db()).paymentAttempt.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'asc' } })).stripeSessionId as string)
async function paidAtProvider(orderId: string) {
  const sessionId = await sessionIdOfOrder(orderId)
  fake.pay(sessionId)
  await syncPayment({ kind: 'checkout_session', id: sessionId, hint: { orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  await pageJobsSettled()
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: true } })
  assert.deepEqual(
    { status: row.status, paymentStatus: row.paymentStatus, paidAt: row.paidAt instanceof Date, carrier: row.paymentAttempts.map((a) => `${a.status}:${a.stripePaymentIntentId === row.stripePaymentIntentId && row.stripePaymentIntentId !== null}`) },
    { status: 'queued', paymentStatus: 'paid', paidAt: true, carrier: ['paid:true'] },
    'premise: the payment was verified by the server from the provider, the order is in production, its one page carried the payment',
  )
}
async function expiredAtProvider(orderId: string) {
  const sessionId = await sessionIdOfOrder(orderId)
  await endOfPage(sessionId)
  await syncPayment({ kind: 'checkout_session', id: sessionId, hint: { orderId } }, { eventType: 'test.expired', effects: 'none' as any })
  await pageJobsSettled()
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: true } })
  assert.deepEqual(
    { status: row.status, paymentStatus: row.paymentStatus, pages: row.paymentAttempts.map((a) => `${a.status}:${a.failureReason}`) },
    { status: 'cancelled', paymentStatus: 'canceled', pages: [`expired:${REASON_PROVIDER_EXPIRED}`] },
    'premise: the provider said the page ran out, the server closed it with that proof and the order with it',
  )
}
// (B) the rows of an order that was MARKED paid or cancelled while its page was never shown closed: the page may still be paid at the provider
async function markedWithPageOpen(orderId: string, data: Record<string, unknown>) {
  await setOrder(orderId, data)
  const [attempt] = await (await db()).paymentAttempt.findMany({ where: { orderId } })
  assert.deepEqual({ row: attempt.status, provider: fake.sessions.get(attempt.stripeSessionId as string)?.status }, { row: 'open', provider: 'open' }, 'premise: its page is open at the provider and nothing proved it closed')
  return attempt
}
const HOLD_NAMED = ['code', 'error', 'orderId', 'orderNumber']
const confirmation = (value: unknown) => ({ confirmRepeat: true, repeatContext: value })

test('customer: once the payment is verified at the provider and the order is in production, the same things can be ordered again - a new order (repeat gate off; either owner guard)', async () => {
  await reset()
  await withCheckoutFlags({ repeat: 'off' }, async () => {
    const first = await session(customer)
    assert.equal(first.status, 200, first.text)
    await paidAtProvider(first.json.orderId)
    const calls = { creates: fake.state.createCalls, expires: fake.state.expireCalls }
    const again = await session(customer, { key: newKey() })
    assert.equal(again.status, 200, again.text)
    assert.notEqual(again.json.orderId, first.json.orderId)
    assert.equal(await orderCount(), 2)
    await pageJobsSettled()
    assert.deepEqual({ creates: fake.state.createCalls, expires: fake.state.expireCalls }, { creates: calls.creates + 1, expires: calls.expires }, 'one new page, for the new order; the page that carried the payment is not touched')
  })
})

test('customer (owner guard on, repeat gate on): the same cart bought again within the hour of a verified payment is asked a confirmation first - nothing is made before it; the context sent back makes the new order and its page; a retry, with the same key or another, gets the same order and page', async () => {
  await reset()
  await withCheckoutFlags({ owner: 'on', repeat: 'on' }, async () => {
    const first = await session(customer)
    await paidAtProvider(first.json.orderId)
    const creates = fake.state.createCalls
    const key = newKey()
    const asked = await session(customer, { key })
    assert.deepEqual({ status: asked.status, code: asked.json?.code, orderId: asked.json?.orderId, count: asked.json?.repeatCount, keys: Object.keys(asked.json ?? {}).sort() },
      { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', orderId: first.json.orderId, count: 1, keys: REPEAT_PROPOSAL_KEYS }, asked.text)
    assert.match(asked.json.repeatContext, REPEAT_CONTEXT_FORMAT)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 1, creates }, 'the proposal makes no order and no page')
    const made = await session(customer, { key, extra: confirmation(asked.json.repeatContext) })
    assert.equal(made.status, 200, made.text)
    assert.notEqual(made.json.orderId, first.json.orderId)
    assert.deepEqual((await order(made.json.orderId) as any).metadata.checkout.repeatOf, [first.json.orderId], 'the new order says which purchase it repeats')
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 2, creates: creates + 1 })
    const sameKey = await session(customer, { key, extra: confirmation(asked.json.repeatContext) })
    const otherKey = await session(customer, { key: newKey() })
    for (const retry of [sameKey, otherKey]) assert.deepEqual({ status: retry.status, orderId: retry.json?.orderId, url: retry.json?.url }, { status: 200, orderId: made.json.orderId, url: made.json.url }, retry.text)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 2, creates: creates + 1 }, 'no second order, no second page')
  })
})

test('customer (owner guard on): an order MARKED paid while its page was never shown closed (the page may still be paid) holds the same cart, whatever key; after the hold the page is closed AT THE PROVIDER with the proof on its row, and then the same things can be ordered again (repeat gate off)', async () => {
  await reset()
  await withCheckoutFlags({ owner: 'on', repeat: 'off' }, async () => {
    const first = await session(customer)
    const attempt = await markedWithPageOpen(first.json.orderId, { paymentStatus: 'paid', status: 'queued', paidAt: new Date() })
    const calls = { creates: fake.state.createCalls, expires: fake.state.expireCalls }
    const held = await session(customer, { key: newKey() })
    assert.deepEqual({ status: held.status, code: held.json?.code, orderId: held.json?.orderId, keys: Object.keys(held.json ?? {}).sort() }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: first.json.orderId, keys: HOLD_NAMED }, held.text)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 1, creates: calls.creates }, 'no order, no page')
    await pageJobsSettled()
    const closed = await (await db()).paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
    assert.deepEqual({ row: closed.status, proof: (closed.failureReason ?? '').startsWith(REASON_CLOSED_BY_US), provider: fake.sessions.get(attempt.stripeSessionId as string)?.status, expires: fake.state.expireCalls },
      { row: 'expired', proof: true, provider: 'expired', expires: calls.expires + 1 }, 'the page was closed at the provider after the hold, and the proof is on its row')
    const again = await session(customer, { key: newKey() })
    assert.equal(again.status, 200, again.text)
    assert.notEqual(again.json.orderId, first.json.orderId)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 2, creates: calls.creates + 1 })
  })
})

test('customer (owner guard on, repeat gate on): the same anomalous order - MARKED paid, page never shown closed - is held before anything is asked (a confirmation sent with it changes nothing); once the page is closed with proof the purchase made again is asked a confirmation, and the confirmed one is made', async () => {
  await reset()
  await withCheckoutFlags({ owner: 'on', repeat: 'on' }, async () => {
    const first = await session(customer)
    await markedWithPageOpen(first.json.orderId, { paymentStatus: 'paid', status: 'queued', paidAt: new Date() })
    const creates = fake.state.createCalls
    const key = newKey()
    const held = await session(customer, { key, extra: confirmation(`rc1_${'0'.repeat(64)}`) })
    assert.deepEqual({ status: held.status, code: held.json?.code, orderId: held.json?.orderId }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: first.json.orderId }, held.text)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 1, creates })
    await pageJobsSettled()
    const asked = await session(customer, { key })
    assert.deepEqual({ status: asked.status, code: asked.json?.code, orderId: asked.json?.orderId }, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', orderId: first.json.orderId }, asked.text)
    assert.equal(await orderCount(), 1)
    const made = await session(customer, { key, extra: confirmation(asked.json.repeatContext) })
    assert.equal(made.status, 200, made.text)
    assert.notEqual(made.json.orderId, first.json.orderId)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 2, creates: creates + 1 })
  })
})

test('customer: a payment page that EXPIRED at the provider - the server learned it: the page closed with the provider\'s proof, the order closed, nothing charged - does not block a new attempt: a new order (every flag)', async () => {
  await reset()
  const first = await session(customer)
  await expiredAtProvider(first.json.orderId)
  const again = await session(customer, { key: newKey() })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.json.orderId)
  assert.equal(await orderCount(), 2)
})

test('customer (owner guard on): an order MARKED cancelled while its page is still open at the provider holds the same cart; after the hold the page is closed at the provider with proof, and the next attempt is a new order (either repeat gate: nothing was paid)', async () => {
  await reset()
  await withCheckoutFlags({ owner: 'on' }, async () => {
    const first = await session(customer)
    const attempt = await markedWithPageOpen(first.json.orderId, { status: 'cancelled', paymentStatus: 'canceled' })
    const creates = fake.state.createCalls
    const held = await session(customer, { key: newKey() })
    assert.deepEqual({ status: held.status, code: held.json?.code, orderId: held.json?.orderId, keys: Object.keys(held.json ?? {}).sort() }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: first.json.orderId, keys: HOLD_NAMED }, held.text)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 1, creates })
    await pageJobsSettled()
    const closed = await (await db()).paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
    assert.deepEqual({ row: closed.status, proof: (closed.failureReason ?? '').startsWith(REASON_CLOSED_BY_US), provider: fake.sessions.get(attempt.stripeSessionId as string)?.status }, { row: 'expired', proof: true, provider: 'expired' })
    const again = await session(customer, { key: newKey() })
    assert.equal(again.status, 200, again.text)
    assert.notEqual(again.json.orderId, first.json.orderId)
    assert.deepEqual({ orders: await orderCount(), creates: fake.state.createCalls }, { orders: 2, creates: creates + 1 })
  })
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

// The provider expires a page when ITS time is over, so a page it reports as expired is one whose end has come. (A page closed EARLY - by an operator, or by our own replacement of it - is another
// thing: it does not end the order, DR-13 / lib/payment-verification.ts mayCancelAfterExpiry; tests/dr13-cancel-rule.test.ts and dr13-single-page.sec.ts judge that.)
async function endOfPage(sessionId: string) {
  fake.sessions.get(sessionId)!.status = 'expired'
  await (await db()).paymentAttempt.updateMany({ where: { stripeSessionId: sessionId }, data: { expiresAt: new Date(Date.now() - 60_000) } })
}

test('4.5 confirming + Stripe says the payment page expired (no money is moving): the order is closed and the customer may pay again', async () => {
  await reset()
  const first = await inDoubt(customer)
  await endOfPage(firstSessionId())
  const again = await session(customer, { key: newKey() })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.json.orderId, 'a new order')
  const old = await order(first.json.orderId)
  assert.equal(old.status, 'cancelled')
  assert.equal(old.paymentStatus, 'canceled')
  assert.equal(await (await db()).paymentAttempt.count({ where: { orderId: first.json.orderId, status: 'expired' } }), 1)
})

test('4.5 confirming + Stripe says paid: the customer has paid - answered as in progress once more, then the same things can be ordered again (repeat gate off; either owner guard)', async () => {
  await reset()
  await withCheckoutFlags({ repeat: 'off' }, async () => {
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
})

test('4.5 (owner guard on, repeat gate on) confirming + Stripe says paid: in progress once more - also to a request that says it confirms - and nothing made; then the same things bought again are asked a confirmation, and the confirmed purchase is a new order', async () => {
  await reset()
  await withCheckoutFlags({ owner: 'on', repeat: 'on' }, async () => {
    const first = await inDoubt(customer)
    fake.pay(firstSessionId())
    const calls = fake.state.createCalls
    const key = newKey()
    const again = await session(customer, { key, extra: confirmation(`rc1_${'0'.repeat(64)}`) })
    assert.deepEqual({ status: again.status, code: again.json?.code, orderId: again.json?.orderId }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: first.json.orderId }, again.text)
    assert.deepEqual({ creates: fake.state.createCalls, orders: await orderCount() }, { creates: calls, orders: 1 })
    assert.equal((await order(first.json.orderId)).paymentStatus, 'paid', 'the server recorded the payment, from Stripe')
    await (await db()).rateLimit.deleteMany()
    const asked = await session(customer, { key })
    assert.deepEqual({ status: asked.status, code: asked.json?.code, orderId: asked.json?.orderId, count: asked.json?.repeatCount }, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', orderId: first.json.orderId, count: 1 }, asked.text)
    assert.deepEqual({ creates: fake.state.createCalls, orders: await orderCount() }, { creates: calls, orders: 1 })
    const later = await session(customer, { key, extra: confirmation(asked.json.repeatContext) })
    assert.equal(later.status, 200, later.text)
    assert.notEqual(later.json.orderId, first.json.orderId)
    assert.deepEqual({ creates: fake.state.createCalls, orders: await orderCount() }, { creates: calls + 1, orders: 2 })
  })
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
  await endOfPage(firstSessionId())
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

test('guest: two requests at the same moment with different keys from ONE browser session make ONE order - step 4.6 (S5) closes the limit that was written down here', async () => {
  await reset()
  // (until step 4.5 the first request of a browser had no identity, so two of them could not know each other; now the browser is given a session with the quote)
  const [a, b] = await Promise.all([session(null, { key: newKey() }), session(null, { key: newKey() })])
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.equal(a.json.orderId, b.json.orderId, 'one order for the one browser')
  assert.equal(a.json.url, b.json.url, 'and one payment page')
  assert.equal(await orderCount(), 1)
  // and the next attempt, whatever the key, is the same purchase again
  const third = await session(null, { key: newKey(), cookie: a.cookie })
  assert.equal(third.status, 200, third.text)
  assert.equal(third.json.orderId, a.json.orderId)
  // what stays open - two first requests that were handed DIFFERENT new sessions (R1) - is written down in guest-session.sec.ts
  const [c, d] = await Promise.all([session(null, { key: newKey(), browser: newGuestBrowser() }), session(null, { key: newKey(), browser: newGuestBrowser() })])
  assert.notEqual(c.json.orderId, d.json.orderId, 'two browsers are two purchases')
})

test('guest: a cookie that opens nothing (forged token, another order\'s token, expired access) is ignored: never reused, and it reveals nothing', async () => {
  await reset()
  const first = await session(null)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const real = first.cookie as string
  const [orderId] = real.split('.')
  const forged = `${orderId}.${'A'.repeat(43)}`
  // another browser that presents a forged token for the order: not blocked, not handed the order
  const wrong = await session(null, { key: newKey(), cookie: forged, browser: newGuestBrowser() })
  assert.equal(wrong.status, 200, `a forged token must not reveal or reuse the order: ${wrong.text}`)
  assert.notEqual(wrong.json.orderId, first.json.orderId)
  // the SAME browser (its session made the order) is told a payment is under way - but not which one: the forged token proves nothing about it
  const sameBrowser = await session(null, { key: newKey(), cookie: forged })
  assert.equal(sameBrowser.status, 409, sameBrowser.text)
  assert.deepEqual(Object.keys(sameBrowser.json).sort(), ['code', 'error'])
  await reset()
  const second = await session(null)
  await setOrder(second.json.orderId, { paymentStatus: 'processing', guestAccessExpiresAt: new Date(Date.now() - 1000) })
  const expired = await session(null, { key: newKey(), cookie: second.cookie, browser: newGuestBrowser() })
  assert.equal(expired.status, 200, `access that has expired opens nothing: ${expired.text}`)
})

test('guest: the access cookie cleared, the session kept = the earlier payment is still known (but not named); another browser can not know it - the limit, written down', async () => {
  await reset()
  const first = await session(null)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  // the browser lost the access cookie of the order but still holds its session: the payment under way is still refused, without a word about which order
  const cleared = await session(null, { key: newKey(), cookie: null })
  assert.equal(cleared.status, 409, cleared.text)
  assert.equal(cleared.json.code, 'PAYMENT_IN_PROGRESS')
  assert.deepEqual(Object.keys(cleared.json).sort(), ['code', 'error'])
  assert.equal(await orderCount(), 1)
  // another browser (another device, a cleared jar): nothing links it to the earlier order, a new one is made (R2/R4)
  const second = await session(null, { key: newKey(), cookie: null, browser: newGuestBrowser() })
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
