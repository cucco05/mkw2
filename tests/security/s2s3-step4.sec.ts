// S2/S3 step 4.1 – the order status endpoint behind the payment pages (GET /api/checkout/status).
//
// What must hold:
//   * only the signed-in owner, or the guest whose browser holds THAT order's access token, learns anything about an order;
//     the order id alone, being signed in as somebody else, staff/admin, a token of another order, an expired or forged token,
//     and the fact that the confirmation page can be opened without signing in, give nothing - and every refusal looks the same;
//   * the answer holds an order number, a state, the total and currency: no personal data, address, Stripe identifier, review
//     reason or metadata; it is never stored by any cache;
//   * the browser can not declare a payment (nothing in the request makes an order paid; the endpoint only reads);
//   * a payment is seen even when the webhook is late (the server asks Stripe, at a limited pace) and never lost when Stripe is down;
//   * polling can not release an order twice, can not hammer Stripe, and has its own budget;
//   * the old flow's orders, unknown ids and malformed ids are not served.
// Fake Stripe (tests/security/_fake-checkout.ts), throw-away database, fake data.
import { db, resetDb, seedShopModel } from './_harness'
import { installFakeCheckout, type FakeSession } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { effectHooks } from '../../lib/order-effects'
import { deriveGuestAccessToken, GUEST_ACCESS_COOKIE, mergeGuestAccessCookie } from '../../lib/guest-order-access'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let stripe: any
let modelId = ''
let customerA: { id: string }
let customerB: { id: string }
let staff: { id: string }
let admin: { id: string }

// ---- environment ----------------------------------------------------------------------------------------------------------------
const ENV: Record<string, string> = {
  CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', PAYMENT_SYNC_MAX_WAIT_MS: '3000',
  CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000',
}
const savedEnv: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV), 'CHECKOUT_STATUS_RATE_MAX', 'CHECKOUT_STATUS_GLOBAL_RATE_MAX']) savedEnv[key] = process.env[key]
function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
}

// ---- spies on the services used after a payment ----------------------------------------------------------------------------------
const calls = { receipt: 0, notify: 0, printlab: 0 }
const original = { ...effectHooks }
function installSpies() {
  effectHooks.receipt = (async () => { calls.receipt++ }) as any
  effectHooks.consumeInventory = (async () => ({ ok: true, movements: 0 })) as any
  effectHooks.printLabConfigured = (async () => true) as any
  effectHooks.submitToPrintLab = (async () => { calls.printlab++; return { ok: true, submitted: [], errors: [] } }) as any
  effectHooks.notifyDiscord = (async () => { calls.notify++; return true }) as any
  effectHooks.notifyPush = (async () => true) as any
}

// ---- calling the endpoints -------------------------------------------------------------------------------------------------------
let ipSeq = 0
let keySeq = 0
const nextIp = () => `10.4.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
const newKey = () => `step4-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const cart = (over: Record<string, unknown> = {}) => ({
  items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' as 'pickup' | 'ship' }, rush: false, ...over,
})
async function post(route: 'quote' | 'session', body: unknown, viewer: Viewer | null = null) {
  viewerGuards.getViewer = async () => viewer
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { res, json, text }
}
const customerViewer = (user: { id: string }): Viewer => ({ id: user.id, role: 'customer' })

// Quote, then "Pay": an order of the hosted checkout waiting for its payment. A guest gets the access cookie, like a browser would.
async function startCheckout(o: { viewer?: Viewer | null; cartOver?: Record<string, unknown> } = {}) {
  const viewer = o.viewer ?? null
  const c = cart(o.cartOver)
  const quote = await post('quote', c, viewer)
  assert.equal(quote.res.status, 200, quote.text)
  const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote.json.totalCents, ...c }, viewer)
  assert.equal(r.res.status, 200, r.text)
  const prisma = await db()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: r.json.orderId }, orderBy: { createdAt: 'desc' } })
  const setCookie = r.res.headers.get('set-cookie') || ''
  const cookie = new RegExp(`${GUEST_ACCESS_COOKIE}=([^;]+)`).exec(setCookie)?.[1] ?? null
  return { orderId: r.json.orderId as string, total: quote.json.totalCents as number, attemptId: attempt.id, sessionId: attempt.stripeSessionId as string, cookie: cookie ? decodeURIComponent(cookie) : null }
}

const seenResponses: Array<{ label: string; res: Response }> = []
async function getStatus(orderId: string, o: { viewer?: Viewer | null; cookie?: string | null; query?: string; ip?: string; label?: string } = {}) {
  viewerGuards.getViewer = async () => o.viewer ?? null
  const { GET } = await import('../../app/api/checkout/status/route')
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? nextIp() }
  if (o.cookie) headers.cookie = `${GUEST_ACCESS_COOKIE}=${o.cookie}`
  const res = (await (GET as any)(new NextRequest(`http://localhost/api/checkout/status?order=${encodeURIComponent(orderId)}${o.query ?? ''}`, { headers }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  seenResponses.push({ label: o.label ?? `${res.status} ${orderId.slice(0, 8)}`, res: res.clone() })
  return { res, json, text }
}

// Lets the next status request ask Stripe again (the pace limit is real, the tests would otherwise have to wait seconds).
async function allowRefreshAgain(orderId?: string) {
  const prisma = await db()
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: 'checkout:status-sync' } } })
  if (orderId) await prisma.printOrder.update({ where: { id: orderId }, data: { paymentSyncedAt: null } })
}
const orderOf = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id }, include: { paymentAttempts: { orderBy: { createdAt: 'asc' } } } })
const sessionReads = () => fake.state.reads.filter((r) => r.startsWith('session:')).length
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await sleep(25) }
  return false
}

// ---- webhook (for "the webhook arrives later") -----------------------------------------------------------------------------------
let eventSeq = 0
async function deliverSessionCompleted(sessionId: string) {
  const s: FakeSession | undefined = fake.sessions.get(sessionId)
  const event = { id: `evt_s4_${++eventSeq}`, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: sessionId, object: 'checkout.session', metadata: s?.metadata ?? {}, payment_intent: s?.payment_intent ?? null } } }
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const payload = JSON.stringify(event)
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string })
  return (await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload,
  }), {})) as Response
}

async function fresh() {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.stripeEvent.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, {
    createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, unreachableBeforeCreate: 0, lostAnswerAfterCreate: 0, rejectCreate: false,
    delayMs: 0, amountTotalOverride: null, currencyOverride: null, retrieveFails: false, reads: [], failNextReads: 0, afterSnapshot: null, maxIdleInTransaction: 0,
    lastParams: null, allParams: [],
  })
  Object.assign(calls, { receipt: 0, notify: 0, printlab: 0 })
  Object.assign(effectHooks, original)
  installSpies()
  setEnv({ ...ENV, CHECKOUT_STATUS_RATE_MAX: undefined, CHECKOUT_STATUS_GLOBAL_RATE_MAX: undefined })
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  const mk = (n: string, role: string) => prisma.user.create({ data: { email: `${n}@sectest.invalid`, passwordHash: 'x', name: n, role: role as any } })
  customerA = await mk('step4a', 'customer')
  customerB = await mk('step4b', 'customer')
  staff = await mk('step4staff', 'staff')
  admin = await mk('step4admin', 'admin')
  modelId = (await seedShopModel()).model.id
  fake = await installFakeCheckout()
  stripe = fake.stripe
  await fresh()
})
test.after(() => {
  Object.assign(effectHooks, original)
  setEnv(savedEnv)
})

// ====================================================================================================================================
// who may see an order
// ====================================================================================================================================
test('the owner and the guest see their own order: five fields, nothing else, never cached', async () => {
  await fresh()
  const mine = await startCheckout({ viewer: customerViewer(customerA) })
  const asOwner = await getStatus(mine.orderId, { viewer: customerViewer(customerA) })
  assert.equal(asOwner.res.status, 200, asOwner.text)
  assert.deepEqual(Object.keys(asOwner.json).sort(), ['currency', 'final', 'orderNumber', 'pollAfterMs', 'state', 'totalCents'])
  assert.equal(asOwner.json.state, 'pending')
  assert.equal(asOwner.json.totalCents, mine.total)
  assert.equal(asOwner.json.currency, 'EUR')
  assert.equal(asOwner.json.final, false)
  assert.equal(asOwner.json.pollAfterMs, null)
  const cacheControl = asOwner.res.headers.get('cache-control') || ''
  assert.match(cacheControl, /no-store/)
  assert.match(cacheControl, /private/)
  assert.match(asOwner.res.headers.get('vary') || '', /cookie/i)
  assert.equal(asOwner.res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(asOwner.res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(asOwner.res.headers.get('x-robots-tag') || '', /noindex/)

  const guest = await startCheckout()
  assert.ok(guest.cookie, 'the guest got an access cookie')
  const asGuest = await getStatus(guest.orderId, { cookie: guest.cookie })
  assert.equal(asGuest.res.status, 200, asGuest.text)
  assert.equal(asGuest.json.state, 'pending')
})

test('nobody else learns anything: other customers, staff, administrators, no cookie, another order\'s token, a forged or expired token', async () => {
  await fresh()
  const prisma = await db()
  const account = await startCheckout({ viewer: customerViewer(customerA) })
  const g1 = await startCheckout()
  const g2 = await startCheckout()
  const refused = async (label: string, r: Promise<{ res: Response }>) => assert.equal((await r).res.status, 404, label)

  // an account order
  assert.equal((await getStatus(account.orderId, { viewer: customerViewer(customerA) })).res.status, 200)
  await refused('other customer', getStatus(account.orderId, { viewer: customerViewer(customerB) }))
  await refused('staff', getStatus(account.orderId, { viewer: { id: staff.id, role: 'staff' } }))
  await refused('administrator', getStatus(account.orderId, { viewer: { id: admin.id, role: 'admin' } }))
  await refused('nobody', getStatus(account.orderId))
  // a guest token never opens an order that belongs to an account, even a correct-looking one
  await refused('guest token on an account order', getStatus(account.orderId, { cookie: mergeGuestAccessCookie(null, account.orderId, deriveGuestAccessToken(account.orderId)) }))

  // a guest order
  assert.equal((await getStatus(g1.orderId, { cookie: g1.cookie })).res.status, 200)
  await refused('no cookie', getStatus(g1.orderId))
  await refused('signed in but without the cookie', getStatus(g1.orderId, { viewer: customerViewer(customerB) }))
  await refused('the cookie of another order', getStatus(g1.orderId, { cookie: g2.cookie }))
  await refused('a forged token', getStatus(g1.orderId, { cookie: mergeGuestAccessCookie(null, g1.orderId, 'A'.repeat(43)) }))
  await refused('a token for the wrong order id', getStatus(g1.orderId, { cookie: mergeGuestAccessCookie(null, g1.orderId, deriveGuestAccessToken(g2.orderId)) }))
  // several orders in one browser: each opens its own
  const both = mergeGuestAccessCookie(g2.cookie, g1.orderId, deriveGuestAccessToken(g1.orderId))
  assert.equal((await getStatus(g1.orderId, { cookie: both })).res.status, 200)
  assert.equal((await getStatus(g2.orderId, { cookie: both })).res.status, 200)
  // a signed-in person who holds the cookie may see it (it is their browser)
  assert.equal((await getStatus(g1.orderId, { viewer: customerViewer(customerB), cookie: g1.cookie })).res.status, 200)
  // expiry
  await prisma.printOrder.update({ where: { id: g1.orderId }, data: { guestAccessExpiresAt: new Date(Date.now() - 1000) } })
  await refused('expired token', getStatus(g1.orderId, { cookie: g1.cookie }))
})

test('every refusal looks exactly the same, also for orders that do not exist, malformed ids and the old flow\'s orders', async () => {
  await fresh()
  const prisma = await db()
  const account = await startCheckout({ viewer: customerViewer(customerA) })
  const guest = await startCheckout()
  const oldFlow = await prisma.printOrder.create({
    data: { userId: customerA.id, status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', subtotalCents: 1000, totalCents: 1000, currency: 'EUR', stripePaymentIntentId: 'pi_old_flow_1', metadata: { paymentIntentId: 'pi_old_flow_1' } },
  })
  const bodies = new Set<string>()
  const statuses = new Set<number>()
  // one at a time: each call sets who is asking (viewerGuards) and must finish before the next one starts
  const causes: Array<[string, () => Promise<{ res: Response; text: string }>]> = [
    ['unknown id', () => getStatus('cmunknown000000000000000000')],
    ['other customer', () => getStatus(account.orderId, { viewer: customerViewer(customerB) })],
    ['guest without cookie', () => getStatus(guest.orderId)],
    ['old flow, even for its owner', () => getStatus(oldFlow.id, { viewer: customerViewer(customerA) })],
    ['empty id', () => getStatus('')],
    ['malformed id', () => getStatus('../../etc/passwd')],
    ['too short', () => getStatus('abc')],
    ['too long', () => getStatus('x'.repeat(200))],
  ]
  for (const [label, ask] of causes) {
    const { res, text } = await ask()
    statuses.add(res.status)
    bodies.add(text)
    assert.equal(res.status, 404, label)
    assert.match(res.headers.get('cache-control') || '', /no-store/, `${label}: 404 must not be cached either`)
  }
  assert.equal(bodies.size, 1, `the refusals differ: ${[...bodies].join(' | ')}`)
  assert.deepEqual([...statuses], [404])
})

// ====================================================================================================================================
// what is (not) in the answer, and what the browser can not do
// ====================================================================================================================================
test('the answer never contains personal data, addresses, Stripe identifiers, review reasons or internal ids - also after payment and when a person must look', async () => {
  await fresh()
  const forbidden = /pi_|cs_test|ch_|buyer@example|Mario|Rossi|Via Roma|Milano|20100|@|shipping|amount|currency_mismatch|external_order|paymentIntent|stripe|metadata|token|hash/i
  // paid
  const paid = await startCheckout({ viewer: customerViewer(customerA) })
  fake.pay(paid.sessionId)
  const r1 = await getStatus(paid.orderId, { viewer: customerViewer(customerA), query: '&return=1' })
  assert.equal(r1.json.state, 'paid', r1.text)
  assert.doesNotMatch(r1.text, forbidden)
  assert.ok(!r1.text.includes(paid.orderId) && !r1.text.includes(paid.sessionId))
  // paid, but delivery outside the country we serve: a person looks, and the page says nothing about why
  const far = await startCheckout({ viewer: customerViewer(customerA), cartOver: { shipping: { method: 'ship' } } })
  fake.pay(far.sessionId, { address: { name: 'Mario Rossi', address: { line1: 'Rue 1', city: 'Paris', postal_code: '75000', country: 'FR' } } })
  const r2 = await getStatus(far.orderId, { viewer: customerViewer(customerA), query: '&return=1' })
  assert.equal(r2.json.state, 'attention', r2.text)
  assert.doesNotMatch(r2.text, forbidden)
  assert.equal((await orderOf(far.orderId)).paymentReviewReason, 'shipping_country')
  // a payment of the wrong amount: nothing is paid, a person looks
  const wrong = await startCheckout({ viewer: customerViewer(customerA) })
  fake.pay(wrong.sessionId, { amount: wrong.total - 100 })
  const r3 = await getStatus(wrong.orderId, { viewer: customerViewer(customerA), query: '&return=1' })
  assert.equal(r3.json.state, 'attention', r3.text)
  assert.doesNotMatch(r3.text, forbidden)
  assert.notEqual((await orderOf(wrong.orderId)).paymentStatus, 'paid')
})

test('the browser can not declare a payment: nothing in the request makes an order paid, and the endpoint only reads', async () => {
  await fresh()
  const mine = await startCheckout({ viewer: customerViewer(customerA) })
  const viewer = customerViewer(customerA)
  const claims = [
    '&return=1', '&status=paid', '&state=paid', '&paid=1&payment_status=paid', `&session_id=${mine.sessionId}&payment_intent=pi_x`,
    '&amount=1&total=1', '&return=1&status=succeeded&redirect_status=succeeded', '&order=other',
  ]
  for (const query of claims) {
    const { res, json } = await getStatus(mine.orderId, { viewer, query })
    assert.equal(res.status, 200, query)
    assert.notEqual(json.state, 'paid', `"${query}" must not produce "paid"`)
  }
  const after = await orderOf(mine.orderId)
  assert.equal(after.paymentStatus, 'pending')
  assert.equal(after.status, 'awaiting_payment')
  assert.equal(after.paidAt, null)
  assert.equal(after.paymentAttempts.every((a) => a.status !== 'paid'), true)
  // nothing but GET exists
  const mod: any = await import('../../app/api/checkout/status/route')
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(typeof mod[method], 'undefined', `${method} must not exist`)
})

// ====================================================================================================================================
// the payment is seen: late webhook, Stripe down, concurrency, expiry
// ====================================================================================================================================
test('webhook still on its way: the customer who paid sees "paid" at once; production starts once; the webhook that arrives later changes nothing', async () => {
  await fresh()
  const mine = await startCheckout()
  fake.pay(mine.sessionId) // paid at Stripe; no webhook has arrived
  const before = await orderOf(mine.orderId)
  assert.equal(before.paymentStatus, 'pending')

  const { res, json } = await getStatus(mine.orderId, { cookie: mine.cookie, query: '&return=1' })
  assert.equal(res.status, 200)
  assert.equal(json.state, 'paid')
  assert.equal(json.final, true)
  let order = await orderOf(mine.orderId)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
  assert.ok(order.paidAt)
  const paidAt = order.paidAt!.getTime()
  assert.ok(await until(() => calls.receipt >= 1 && calls.notify >= 1), 'the after-payment effects run in the background')

  // the webhook arrives afterwards
  const hook = await deliverSessionCompleted(mine.sessionId)
  assert.equal(hook.status, 200)
  order = await orderOf(mine.orderId)
  assert.equal(order.paidAt!.getTime(), paidAt)
  assert.equal(order.status, 'queued')
  await sleep(150)
  assert.equal(calls.receipt, 1, 'effects are not run again')
  assert.equal(calls.printlab, 1)
})

test('Stripe unreachable: the answer comes from what we hold, never an error - "confirming" for someone back from the payment page - and the next ask works', async () => {
  await fresh()
  const mine = await startCheckout()
  fake.pay(mine.sessionId)
  fake.state.failNextReads = 1
  const back = await getStatus(mine.orderId, { cookie: mine.cookie, query: '&return=1' })
  assert.equal(back.res.status, 200, back.text)
  assert.equal(back.json.state, 'confirming', 'we cannot tell yet: not "not paid", and certainly not "paid"')
  assert.equal(back.json.pollAfterMs, 2500)
  assert.equal((await orderOf(mine.orderId)).paymentStatus, 'pending', 'nothing was applied')

  // somebody who did not come from the payment page is not told "we are confirming"
  await allowRefreshAgain(mine.orderId)
  fake.state.failNextReads = 1
  const visitor = await getStatus(mine.orderId, { cookie: mine.cookie })
  assert.equal(visitor.json.state, 'pending')

  // Stripe is back: the next ask completes the job
  await allowRefreshAgain(mine.orderId)
  const again = await getStatus(mine.orderId, { cookie: mine.cookie, query: '&return=1' })
  assert.equal(again.json.state, 'paid')
  assert.equal((await orderOf(mine.orderId)).status, 'queued')
})

test('polling does not hammer Stripe and can not release an order twice: simultaneous asks cause one read; a paid order is released once', async () => {
  await fresh()
  const waiting = await startCheckout()
  const readsBefore = sessionReads()
  const many = await Promise.all(Array.from({ length: 10 }, () => getStatus(waiting.orderId, { cookie: waiting.cookie })))
  assert.ok(many.every((r) => r.res.status === 200))
  assert.equal(sessionReads() - readsBefore, 1, 'ten simultaneous asks, one question to Stripe')

  const payer = await startCheckout()
  fake.pay(payer.sessionId)
  const burst = await Promise.all(Array.from({ length: 8 }, () => getStatus(payer.orderId, { cookie: payer.cookie, query: '&return=1' })))
  assert.ok(burst.every((r) => r.res.status === 200 && ['pending', 'confirming', 'paid'].includes(r.json.state)), burst.map((r) => r.text).join(' '))
  assert.ok(burst.some((r) => r.json.state === 'paid'))
  const order = await orderOf(payer.orderId)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
  assert.ok(await until(() => calls.receipt >= 1))
  await sleep(150)
  assert.equal(calls.receipt, 1)
  assert.equal(calls.printlab, 1)
  // the next asks (after the pace limit) just read the answer: no second release
  await allowRefreshAgain()
  const later = await getStatus(payer.orderId, { cookie: payer.cookie })
  assert.equal(later.json.state, 'paid')
  assert.equal((await orderOf(payer.orderId)).paidAt!.getTime(), order.paidAt!.getTime())
})

test('an expired payment page closes the order only when nothing was paid; a payment that won the race is a payment', async () => {
  await fresh()
  const abandoned = await startCheckout()
  fake.sessions.get(abandoned.sessionId)!.status = 'expired'
  const r1 = await getStatus(abandoned.orderId, { cookie: abandoned.cookie, query: '&return=1' })
  assert.equal(r1.json.state, 'canceled', r1.text)
  assert.equal((await orderOf(abandoned.orderId)).status, 'cancelled')

  const raced = await startCheckout()
  fake.pay(raced.sessionId, { status: 'expired' }) // the page is reported expired but the payment went through
  const r2 = await getStatus(raced.orderId, { cookie: raced.cookie, query: '&return=1' })
  assert.equal(r2.json.state, 'paid', r2.text)
  assert.equal((await orderOf(raced.orderId)).status, 'queued')
})

test('an order that is already paid is not asked about again, and a flagged one is a person\'s', async () => {
  await fresh()
  const mine = await startCheckout()
  fake.pay(mine.sessionId)
  await getStatus(mine.orderId, { cookie: mine.cookie })
  const reads = sessionReads()
  await allowRefreshAgain()
  assert.equal((await getStatus(mine.orderId, { cookie: mine.cookie })).json.state, 'paid')
  assert.equal(sessionReads(), reads, 'a paid order costs no question to Stripe')

  // an order a person must look at (wrong amount) is not asked about either: it waits for that person
  const wrong = await startCheckout()
  fake.pay(wrong.sessionId, { amount: wrong.total - 100 })
  assert.equal((await getStatus(wrong.orderId, { cookie: wrong.cookie, query: '&return=1' })).json.state, 'attention')
  const flaggedReads = sessionReads()
  await allowRefreshAgain()
  assert.equal((await getStatus(wrong.orderId, { cookie: wrong.cookie, query: '&return=1' })).json.state, 'attention')
  assert.equal(sessionReads(), flaggedReads, 'a flagged order costs no question to Stripe')
})

// ====================================================================================================================================
// budgets
// ====================================================================================================================================
test('the status endpoint has its own budget: limited per order and per address, counted before anything is looked up, and separate from quotes and checkouts', async () => {
  await fresh()
  const mine = await startCheckout()
  setEnv({ CHECKOUT_STATUS_RATE_MAX: '5' })
  // five asks from five addresses use up the ORDER's budget...
  for (let i = 0; i < 5; i += 1) assert.equal((await getStatus(mine.orderId, { cookie: mine.cookie })).res.status, 200)
  const sixth = await getStatus(mine.orderId, { cookie: mine.cookie })
  assert.equal(sixth.res.status, 429)
  assert.equal(sixth.json.code, 'RATE_LIMITED')
  assert.ok(Number(sixth.res.headers.get('retry-after')) >= 1)
  assert.match(sixth.res.headers.get('cache-control') || '', /no-store/)
  // ...also for somebody who is not allowed to see it (the limit does not depend on who asks)
  assert.equal((await getStatus(mine.orderId, { cookie: null })).res.status, 429)
  // one ADDRESS asking about many orders is limited too
  await fresh()
  setEnv({ CHECKOUT_STATUS_RATE_MAX: '5' })
  const results: number[] = []
  for (let i = 0; i < 7; i += 1) results.push((await getStatus(`cmnoorder${String(i).padStart(10, '0')}`, { ip: '10.99.99.99' })).res.status)
  assert.deepEqual(results, [404, 404, 404, 404, 404, 429, 429])
  // quotes and checkouts are not affected by the status budget
  assert.equal((await post('quote', cart())).res.status, 200)
})

// ====================================================================================================================================
// the quote carries the lead time
// ====================================================================================================================================
test('the quote includes the server\'s estimate of the time each item takes (hours or null), still without internals', async () => {
  await fresh()
  const quote = await post('quote', cart())
  assert.equal(quote.res.status, 200, quote.text)
  for (const item of quote.json.items) {
    assert.ok('leadTimeHours' in item)
    assert.ok(item.leadTimeHours === null || (typeof item.leadTimeHours === 'number' && item.leadTimeHours >= 0), String(item.leadTimeHours))
  }
  assert.doesNotMatch(quote.text, /storagePath|filePath|pricingBreakdown|modelId/)
})

// ====================================================================================================================================
// every answer of the endpoint, seen from the outside
// ====================================================================================================================================
test('no answer of the endpoint (found, refused, limited) can be stored by a cache', () => {
  assert.ok(seenResponses.length > 40, `only ${seenResponses.length} answers were collected`)
  const statuses = new Set(seenResponses.map((r) => r.res.status))
  for (const expected of [200, 404, 429]) assert.ok(statuses.has(expected), `no ${expected} answer was collected`)
  for (const { label, res } of seenResponses) {
    const cacheControl = res.headers.get('cache-control') || ''
    assert.match(cacheControl, /no-store/, `${label}: ${cacheControl}`)
    assert.match(cacheControl, /private/, `${label}: ${cacheControl}`)
    assert.match(res.headers.get('vary') || '', /cookie/i, label)
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', label)
    assert.ok(!res.headers.get('set-cookie'), `${label}: the status endpoint sets no cookie`)
    assert.ok(!res.headers.get('etag') && !res.headers.get('last-modified'), `${label}: nothing to revalidate`)
  }
})
