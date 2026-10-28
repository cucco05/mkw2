// R1-1b - ONE PURCHASE KEY, ONE ORDER: the persistent guard against a second guest order for the same purchase (architecture R3 of the R1-0 plan, docs/SESSIONE-OSPITE.md R1).
//
// The browser of a guest chooses a checkout key K (a strong one, from Web Crypto: R1-1a) and sends it with every attempt. Until now the server mixed K with the guest's browser
// session, so two sessions that sent the SAME K were two customers: the case R1 (a browser whose session cookie changed between two requests) made two orders and two payment pages.
// Now the server keeps, for every K that was shown to belong to an order, a row GuestPurchaseKey { keyHash = SHA-256("mw:purchase-key:v1:" + K), orderId } - the fingerprint, never K -
// and the database (the primary key) decides: a K is bound to at most ONE order, for ever.
//   * K only CORRELATES. It is never a proof of ownership: whose order it is is shown by the guest's session (a non-null, equal hash), by the account, or by the order's own access cookie.
//     A request that carries a bound K and no proof is REFUSED - paid / in_doubt / started, nothing else - without an order, an attempt, a payment page, a call to Stripe, a cookie or a word
//     about whose order it is;
//   * three bindings: B1 the order is made (same transaction), B2 an order of the owner is reused (a second K of the same browser), B3 the owner is told a payment is already in doubt;
//   * a refusal never turns into a new order: nothing here unlocks anything by itself (no "closed", no timer, no rotation of K) - that is for the reconciliation work that comes later.
// Fake Stripe, throw-away database, fake data. Two real processes: guest-session-multiprocess.sec.ts. The pure rules: tests/purchase-intent.test.ts.
import { db, resetDb, seedShopModel, stripeCalls } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { strongTestKey } from './_keys'
import { newGuestBrowser, type GuestBrowser } from './_guest'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { format } from 'node:util'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { GUEST_SESSION_COOKIE, GUEST_SESSION_COOKIE_HOST } from '../../lib/guest-session'
import { GUEST_ACCESS_COOKIE } from '../../lib/guest-order-access'
import {
  PurchaseRefusedError, bindGuestPurchaseKey, checkoutOrderHooks, classifyPurchaseOrder, createPendingCardOrder, findGuestPurchaseOrder, findOrderByCheckoutKey, storedCheckoutKey,
} from '../../lib/checkout-orders'
import { SUPPORT_CODE_PATTERN, purchaseKeyFor, supportCodeFor, type PurchaseVerdict } from '../../lib/purchase-intent'
import { buildCardQuote } from '../../lib/checkout-quote'
import { syncPayment } from '../../lib/payment-sync'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import { isStrongCheckoutKey } from '../../lib/checkout-key-format'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let customer: NonNullable<Viewer>

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV), 'COOKIE_SECURE']) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT

let ipSeq = 0
const nextIp = () => `10.21.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => strongTestKey(`pk-${++keySeq}`)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const hashOf = (key: string) => purchaseKeyFor(key) as string

type Item = Record<string, unknown>
const cart = (over: Record<string, unknown> = {}) => ({ items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }] as Item[], shipping: { method: 'pickup' }, rush: false, ...over })
const otherCart = () => cart({ items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] })

type Call = { browser?: GuestBrowser | null; cookie?: string; viewer?: Viewer | null; ip?: string; headers?: Record<string, string> }
let browserA: GuestBrowser
let browserB: GuestBrowser
let browserC: GuestBrowser
async function post(route: 'quote' | 'session', body: unknown, o: Call = {}) {
  viewerGuards.getViewer = async () => o.viewer ?? null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const browser = o.browser === undefined ? browserA : o.browser
  const cookie = [browser?.cookie, o.cookie].filter(Boolean).join('; ')
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-forwarded-for': o.ip ?? nextIp(), origin: 'http://localhost', ...(cookie ? { cookie } : {}), ...(o.headers || {}),
  }
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, { method: 'POST', headers, body: JSON.stringify(body) }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  const setCookie = res.headers.getSetCookie()
  const access = setCookie.find((c) => c.startsWith(`${GUEST_ACCESS_COOKIE}=`)) ?? null
  const accessValue = access ? decodeURIComponent(access.split(';')[0].split('=').slice(1).join('=')) : null
  return { res, status: res.status, json, text, setCookie, accessValue }
}
type Reply = Awaited<ReturnType<typeof post>>

const quoteTotal = async (c = cart(), o: Call = {}) => {
  const q = await post('quote', c, o)
  assert.equal(q.status, 200, q.text)
  return q.json.totalCents as number
}
// What the page does: quote, then "pay" with the total it was shown.
async function pay(o: Call & { key?: string; cartOver?: Record<string, unknown>; cart?: ReturnType<typeof cart> } = {}) {
  const c = o.cart ?? cart(o.cartOver)
  const expected = await quoteTotal(c, o)
  const key = o.key ?? newKey()
  const r = await post('session', { checkoutKey: key, expectedTotalCents: expected, ...c }, o)
  return { ...r, key, expected, cart: c }
}
const withAccess = (accessValue: string | null) => ({ cookie: `${GUEST_ACCESS_COOKIE}=${accessValue}` })

const prismaP = () => db()
async function snapshot() {
  const prisma = await prismaP()
  // (the number the next order would get: a refusal that tried to make an order and rolled it back would have used one up)
  const [sequence] = await prisma.$queryRaw<Array<{ last_value: bigint; is_called: boolean }>>`SELECT last_value, is_called FROM "PrintOrder_orderNumber_seq"`
  return {
    orderSequence: `${sequence.last_value}:${sequence.is_called}`,
    orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), aliases: await prisma.guestPurchaseKey.count(),
    stripeCreates: fake.state.createCalls, stripeSessions: fake.state.createdSessions, stripeReads: fake.state.reads.length, stripeRetrieves: fake.state.retrieveCalls, stripeExpires: fake.state.expireCalls,
    stripeCallsOfAnyKind: stripeCalls.length,
  }
}
// how many order numbers have been used so far (an attempt to make an order that is rolled back still uses one up)
const numbersUsed = (snap: { orderSequence: string }) => { const [value, called] = snap.orderSequence.split(':'); return called === 'true' ? Number(value) : Number(value) - 1 }
const aliasesOf = async (orderId: string) => (await (await prismaP()).guestPurchaseKey.findMany({ where: { orderId }, orderBy: { keyHash: 'asc' } })).map((row) => row.keyHash)
const orderRow = async (id: string) => (await prismaP()).printOrder.findUniqueOrThrow({ where: { id } })
const setOrder = async (id: string, data: Record<string, unknown>) => (await prismaP()).printOrder.update({ where: { id }, data: data as any })
async function reset() {
  const prisma = await prismaP()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany() // the purchase keys go with their orders (ON DELETE CASCADE)
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, {
    createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, lastParams: null, allParams: [], rejectCreate: false, unreachableBeforeCreate: 0, lostAnswerAfterCreate: 0, retrieveFails: false,
    delayMs: 0, reads: [], failNextReads: 0, maxIdleInTransaction: 0,
  })
  stripeCalls.length = 0
  checkoutOrderHooks.afterLock = null
  checkoutOrderHooks.withoutPurchaseKeyLock = false
  checkoutOrderHooks.beforeKeyBind = null
  browserA = newGuestBrowser()
  browserB = newGuestBrowser()
  browserC = newGuestBrowser()
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  delete process.env.COOKIE_SECURE
  const prisma = await prismaP()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  customer = { id: (await prisma.user.create({ data: { email: 'pk-customer@sectest.invalid', passwordHash: 'x', name: 'pk-customer', role: 'customer' } })).id, role: 'customer' }
  fake = await installFakeCheckout()
  await reset()
})
test.after(() => {
  checkoutOrderHooks.afterLock = null
  checkoutOrderHooks.withoutPurchaseKeyLock = false
  checkoutOrderHooks.beforeKeyBind = null
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ---- what a refusal must look like, every time ---------------------------------------------------------------------------------------
const CODE_OF: Record<PurchaseVerdict, string> = { paid: 'PURCHASE_ALREADY_PAID', in_doubt: 'PAYMENT_IN_PROGRESS', started: 'PURCHASE_ALREADY_STARTED' }
// A refused request: the classified answer, with nothing that belongs to somebody, no cookie of any kind, and NOTHING made or asked (orders, attempts, bindings, Stripe).
const headerPairs = (res: Response) => { const pairs: string[][] = []; res.headers.forEach((value, name) => pairs.push([name, value])); return pairs }
async function assertRefused(r: Reply, verdict: PurchaseVerdict, before: Awaited<ReturnType<typeof snapshot>>, secret: { orderIds: string[]; keys: string[]; browsers: GuestBrowser[] }, label: string = verdict) {
  assert.equal(r.status, 409, `${label}: ${r.text}`)
  assert.equal(r.json.code, CODE_OF[verdict], `${label}: ${r.text}`)
  assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error', 'retry', 'supportCode'], `${label}: the answer has these four things and nothing else`)
  assert.equal(r.json.retry, false)
  assert.match(r.json.supportCode, SUPPORT_CODE_PATTERN)
  assert.deepEqual(r.setCookie, [], `${label}: no Set-Cookie of any kind (no access cookie, no session)`)
  const readable = `${r.text}\n${JSON.stringify(headerPairs(r.res))}`
  for (const id of secret.orderIds) assert.ok(!readable.includes(id), `${label}: the order id is not in the answer`)
  for (const key of secret.keys) {
    assert.ok(!readable.includes(key), `${label}: the key is not echoed`)
    assert.ok(!readable.includes(hashOf(key)), `${label}: nor its fingerprint`)
  }
  for (const browser of secret.browsers) {
    assert.ok(!readable.includes(browser.sid) && !readable.includes(browser.hash), `${label}: nothing of any browser session`)
  }
  assert.equal(/orderNumber|"url"|checkout\.stripe|"orderId"|"order"/.test(readable), false, `${label}: no order number, no payment address, no order`)
  const after = await snapshot()
  assert.deepEqual(after, before, `${label}: nothing was made and nothing was asked of Stripe (orders, attempts, bindings, calls of any kind)`)
}

type Secret = { orderIds: string[]; keys: string[]; browsers: GuestBrowser[] }
// Sends the request itself, so that the picture of "before" is really taken before it.
async function refused(verdict: PurchaseVerdict, secret: Secret, send: () => Promise<Reply>, label: string = verdict) {
  const before = await snapshot()
  const r = await send()
  await assertRefused(r, verdict, before, secret, label)
  return r
}

// ---- helpers for states ---------------------------------------------------------------------------------------------------------------
// An order made through the route by browser A with key K, and the facts about it a test needs afterwards.
async function firstPurchase(over: { key?: string; browser?: GuestBrowser; cartOver?: Record<string, unknown> } = {}) {
  const r = await pay({ browser: over.browser ?? browserA, key: over.key, cartOver: over.cartOver })
  assert.equal(r.status, 200, r.text)
  return { ...r, orderId: r.json.orderId as string, orderNumber: r.json.orderNumber as number, browser: over.browser ?? browserA, sessionId: [...fake.sessions.keys()].at(-1) as string }
}
const payOrder = async (orderId: string, sessionId: string) => {
  fake.pay(sessionId)
  await syncPayment({ kind: 'checkout_session', id: sessionId, hint: { orderId } }, { eventType: 'test.paid', effects: 'none' as any })
}

// ====================================================================================================================================
// D1 (server side) - a guest's key that is not a strong key is refused before anything is read or made
// ====================================================================================================================================
test('D1: a guest key that is not a strong key (the broad shape the route used to take) is refused with 400 before anything is read or made - no order, no binding, no Stripe, no cookie', async () => {
  await reset()
  const total = await quoteTotal()
  const strongBody = newKey().slice(1)
  const sixteen = `k${Array.from({ length: 32 }, (_, i) => 'ABCDEFGHIJKLMNOP'[i % 16]).join('')}`
  const fifteen = `k${Array.from({ length: 32 }, (_, i) => 'ABCDEFGHIJKLMNO'[i % 15]).join('')}`
  const weak: Array<[string, string]> = [
    ['the old test shape', 'gs-key-000001-abcdefghij'], ['sixteen characters, any', 'abcdefghijklmnop'], ['64 characters, any', 'a1'.repeat(32)], ['the old random fallback shape (letters and digits, no prefix)', strongBody],
    ['constant body', `k${'a'.repeat(32)}`], ['two letters', `k${'ab'.repeat(16)}`], ['fifteen different characters', fifteen], ['capital prefix', `K${strongBody}`], ['one character short', `k${strongBody.slice(1)}`],
    ['one character long', `k${strongBody}x`], ['a prefix of another kind', `w${strongBody}`], ['a word', 'kKEYKEYKEYKEYKEYKEY'],
  ]
  for (const [label, key] of weak) {
    assert.equal(isStrongCheckoutKey(key), false, `${label} is a weak key`)
    const before = await snapshot()
    const r = await post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() })
    assert.equal(r.status, 400, `${label}: ${r.text}`)
    assert.equal(r.json.code, 'CHECKOUT_KEY_INVALID', label)
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error'], label)
    assert.deepEqual(r.setCookie, [], `${label}: no cookie`)
    assert.match(r.res.headers.get('cache-control') || '', /no-store/)
    assert.deepEqual(await snapshot(), before, `${label}: nothing was made`)
    assert.equal(stripeCalls.length, 0, label)
  }
  // the boundary of the filter is the boundary of the guard: sixteen different characters are a key
  const ok = await post('session', { checkoutKey: sixteen, expectedTotalCents: total, ...cart() })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(await (await prismaP()).guestPurchaseKey.count({ where: { keyHash: hashOf(sixteen) } }), 1)
})

test('D1: the order of the checks is kept - a guest without a session still gets 428 first (nothing made), a bad shape is still 400 INVALID_REQUEST, and a signed-in customer is not held to the strong shape', async () => {
  await reset()
  const total = await quoteTotal()
  const before = await snapshot()
  const weak = 'gs-key-000001-abcdefghij'
  const noSession = await post('session', { checkoutKey: weak, expectedTotalCents: total, ...cart() }, { browser: null })
  assert.equal(noSession.status, 428, noSession.text)
  assert.equal(noSession.json.code, 'SESSION_REQUIRED')
  assert.deepEqual(await snapshot(), before)
  const short = await post('session', { checkoutKey: 'short', expectedTotalCents: total, ...cart() })
  assert.equal(short.status, 400)
  assert.equal(short.json.code, 'INVALID_REQUEST')
  // an account keeps the broad shape of the key (R3.7: the strong-key contract is for guests) and no binding is ever made for it
  const account = await post('session', { checkoutKey: weak, expectedTotalCents: total, ...cart() }, { viewer: customer, browser: null })
  assert.equal(account.status, 200, account.text)
  assert.equal((await orderRow(account.json.orderId)).userId, customer.id)
  assert.equal(await (await prismaP()).guestPurchaseKey.count(), 0, 'nothing is bound for an account')
})

test('D2: a strong key that somebody BUILT by hand is simply a key: it works for its first user and is refused to anybody else without a word about the first - K is a way to correlate, never a way to get in', async () => {
  await reset()
  const key = strongTestKey('built-by-hand-victim-key') // somebody who knows it (or guessed it) can send it: what can they get?
  const first = await firstPurchase({ key, browser: browserA })
  const before = await snapshot()
  const intruder = await post('session', { checkoutKey: key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
  await assertRefused(intruder, 'started', before, { orderIds: [first.orderId], keys: [key], browsers: [browserA, browserB] })
  // even with the exact cart and the exact total there is nothing to learn but "started", and the rightful owner is unharmed
  const mine = await post('session', { checkoutKey: key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
  assert.equal(mine.status, 200, mine.text)
  assert.equal(mine.json.orderId, first.orderId)
  assert.equal((await snapshot()).orders, 1)
})

// ====================================================================================================================================
// B1, B2, B3 - the three bindings
// ====================================================================================================================================
test('B1: the order and the binding of its key are made together - the fingerprint of K points to the new order, the old key of the order is exactly what it was, and K itself is nowhere', async () => {
  await reset()
  const key = newKey()
  const first = await firstPurchase({ key })
  const prisma = await prismaP()
  const rows = await prisma.guestPurchaseKey.findMany()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].keyHash, sha(`mw:purchase-key:v1:${key}`))
  assert.equal(rows[0].orderId, first.orderId)
  assert.ok(rows[0].createdAt instanceof Date)
  const order = await orderRow(first.orderId)
  assert.equal(order.checkoutKey, storedCheckoutKey({ kind: 'guest', sessionHash: browserA.hash }, key), 'PrintOrder.checkoutKey keeps the meaning it had (a code of before R1-1b finds this order)')
  assert.equal((await findOrderByCheckoutKey(storedCheckoutKey({ kind: 'guest', sessionHash: browserA.hash }, key)))?.id, first.orderId)
  assert.equal(order.guestSessionHash, browserA.hash)
  const everything = JSON.stringify([await prisma.printOrder.findMany({ include: { items: true } }), await prisma.paymentAttempt.findMany(), await prisma.guestPurchaseKey.findMany(), await prisma.rateLimit.findMany(), await prisma.stripeEvent.findMany()])
  assert.ok(!everything.includes(key), 'the key itself is stored nowhere')
  assert.ok(!everything.includes(key.slice(1)), 'nor its body')
  assert.equal((await findGuestPurchaseOrder(hashOf(key)))?.id, first.orderId)
  assert.equal(await findGuestPurchaseOrder(hashOf(newKey())), null)
})

test('B1: no transaction is open while Stripe is called - the order, its binding and the payment attempt are all written and closed before the page is asked for', async () => {
  await reset()
  const first = await firstPurchase()
  assert.equal(first.status, 200)
  assert.equal(fake.state.createCalls, 1)
  assert.equal(fake.state.maxIdleInTransaction, 0, 'no database transaction was left open across the call to Stripe')
})

test('B2: a second key of the SAME browser for the same purchase is bound to the same order (the lost-key case: another tab, localStorage not shared)', async () => {
  await reset()
  const k1 = newKey()
  const k2 = newKey()
  const first = await firstPurchase({ key: k1 })
  const second = await pay({ browser: browserA, key: k2 })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json.orderId, first.orderId, 'the same order')
  assert.equal(second.json.url, first.json.url, 'and the same payment page')
  assert.deepEqual(await aliasesOf(first.orderId), [hashOf(k1), hashOf(k2)].sort(), 'both keys are bound to it')
  assert.equal((await snapshot()).orders, 1)
  assert.equal(fake.state.createdSessions, 1)
  // and each of them is now refused to a browser that cannot show the order is its own
  const before = await snapshot()
  for (const key of [k1, k2]) {
    const foreign = await post('session', { checkoutKey: key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
    await assertRefused(foreign, 'started', before, { orderIds: [first.orderId], keys: [k1, k2], browsers: [browserA, browserB] })
  }
})

test('B2: six keys at the same moment from one browser (six tabs) are ONE order and SIX bindings, one request at a time inside the lock', async () => {
  await reset()
  const keys = Array.from({ length: 6 }, () => newKey())
  const total = await quoteTotal()
  let inside = 0
  let most = 0
  checkoutOrderHooks.afterLock = async () => { inside += 1; most = Math.max(most, inside); await new Promise((resolve) => setTimeout(resolve, 50)); inside -= 1 }
  const replies = await Promise.all(keys.map((key) => post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() })))
  checkoutOrderHooks.afterLock = null
  for (const r of replies) assert.equal(r.status, 200, r.text)
  assert.equal(new Set(replies.map((r) => r.json.orderId)).size, 1)
  assert.equal(most, 1, 'never two requests of one browser inside together')
  const orderId = replies[0].json.orderId as string
  assert.deepEqual(await aliasesOf(orderId), keys.map(hashOf).sort())
  assert.equal((await snapshot()).orders, 1)
  assert.equal(fake.state.createdSessions, 1)
})

test('B2: an order made BEFORE the purchase key existed has no binding; when its owner comes back with the same key the order is found as it always was and the key is bound to it', async () => {
  await reset()
  const key = newKey()
  const first = await firstPurchase({ key })
  const prisma = await prismaP()
  await prisma.guestPurchaseKey.deleteMany() // the state of an order made by the code of before R1-1b
  assert.equal(await prisma.guestPurchaseKey.count(), 0)
  const back = await post('session', { checkoutKey: key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
  assert.equal(back.status, 200, back.text)
  assert.equal(back.json.orderId, first.orderId, 'found by the key of the order, as before')
  assert.deepEqual(await aliasesOf(first.orderId), [hashOf(key)], 'and now bound')
  assert.equal((await snapshot()).orders, 1)
  assert.equal(fake.state.createdSessions, 1)
})

test('B2: a key that is bound to ANOTHER order is not taken over by the owner of an older order - it is refused as foreign, and the binding is left exactly as it was', async () => {
  await reset()
  const key = newKey()
  const legacy = await firstPurchase({ key, browser: browserA })
  const prisma = await prismaP()
  await prisma.guestPurchaseKey.deleteMany() // the state of an order made before R1-1b
  const winner = await firstPurchase({ key: newKey(), browser: browserB, cartOver: { rush: true } })
  await prisma.guestPurchaseKey.create({ data: { keyHash: hashOf(key), orderId: winner.orderId } }) // the key was bound to somebody else's order first
  const before = await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: hashOf(key) } })
  await refused('started', { orderIds: [legacy.orderId, winner.orderId], keys: [key], browsers: [browserA, browserB] }, () => post('session', { checkoutKey: key, expectedTotalCents: legacy.expected, ...legacy.cart }, { browser: browserA }))
  const after = await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: hashOf(key) } })
  assert.equal(after.orderId, before.orderId)
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime())
  assert.equal((await snapshot()).orders, 2)
})

// The moment between "the route looked at the key" and "the route binds it": another request can bind the key to another order there. The seam makes it happen on purpose.
test('B2 (race): the old order of a browser is found by its old key, and ANOTHER request binds that key to somebody else\'s order before this one binds it - the old order is NOT served as if the key were free: the browser is refused, nothing is made, the binding of the other stands', async () => {
  await reset()
  const key = newKey()
  const legacy = await firstPurchase({ key, browser: browserA })
  const prisma = await prismaP()
  await prisma.guestPurchaseKey.deleteMany() // the state of an order made before R1-1b
  const winner = await firstPurchase({ key: newKey(), browser: browserB, cartOver: { rush: true } })
  const before = await snapshot()
  let injected = 0
  checkoutOrderHooks.beforeKeyBind = async () => {
    checkoutOrderHooks.beforeKeyBind = null
    injected += 1
    await prisma.guestPurchaseKey.create({ data: { keyHash: hashOf(key), orderId: winner.orderId } })
  }
  try {
    const r = await post('session', { checkoutKey: key, expectedTotalCents: legacy.expected, ...legacy.cart }, { browser: browserA })
    assert.equal(injected, 1, 'the other request bound the key between the look and the binding')
    await assertRefused(r, 'started', { ...before, aliases: before.aliases + 1 }, { orderIds: [legacy.orderId, winner.orderId], keys: [key], browsers: [browserA, browserB] })
  } finally { checkoutOrderHooks.beforeKeyBind = null }
  assert.ok((await aliasesOf(winner.orderId)).includes(hashOf(key)), 'the key is bound to the order that got it first')
  assert.equal((await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: hashOf(key) } })).orderId, winner.orderId)
  assert.deepEqual(await aliasesOf(legacy.orderId), [], 'and the old order has none')
  assert.equal(fake.state.createdSessions, 2, 'no payment page was opened for this request')
})

test('B2 (race): ... and when the order that got the key meanwhile is the browser\'s OWN other order, the old order is still not served: the key was used for something else, as always', async () => {
  await reset()
  const key = newKey()
  const legacy = await firstPurchase({ key, browser: browserA })
  const prisma = await prismaP()
  const other = await firstPurchase({ key: newKey(), browser: browserA, cartOver: { rush: true } })
  assert.notEqual(other.orderId, legacy.orderId)
  await prisma.guestPurchaseKey.deleteMany()
  const before = await snapshot()
  let injected = 0
  checkoutOrderHooks.beforeKeyBind = async () => {
    checkoutOrderHooks.beforeKeyBind = null
    injected += 1
    await prisma.guestPurchaseKey.create({ data: { keyHash: hashOf(key), orderId: other.orderId } })
  }
  try {
    const r = await post('session', { checkoutKey: key, expectedTotalCents: legacy.expected, ...legacy.cart }, { browser: browserA })
    assert.equal(injected, 1)
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.code, 'CHECKOUT_KEY_CONFLICT', r.text)
    assert.equal(/"url"|checkout\.stripe/.test(r.text), false, 'no payment page is handed out')
    assert.deepEqual(r.setCookie, [])
  } finally { checkoutOrderHooks.beforeKeyBind = null }
  const after = await snapshot()
  assert.deepEqual(after, { ...before, aliases: before.aliases + 1 }, 'nothing else was made')
  assert.deepEqual(await aliasesOf(legacy.orderId), [])
})

test('B2 (race, inside the transaction): a SECOND key of a browser falls on its unpaid order, and ANOTHER request binds that key to somebody else\'s order before this one binds it - the unpaid order is NOT served as if the key were free: the browser is refused and nothing is made', async () => {
  await reset()
  const first = await firstPurchase({ browser: browserA })
  const winner = await firstPurchase({ key: newKey(), browser: browserB, cartOver: { rush: true } })
  const second = newKey()
  const prisma = await prismaP()
  const before = await snapshot()
  let injected = 0
  checkoutOrderHooks.beforeKeyBind = async () => {
    checkoutOrderHooks.beforeKeyBind = null
    injected += 1
    await prisma.guestPurchaseKey.create({ data: { keyHash: hashOf(second), orderId: winner.orderId } })
  }
  try {
    const r = await post('session', { checkoutKey: second, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
    assert.equal(injected, 1, 'the other request bound the key between the look and the binding, inside the transaction of this one')
    await assertRefused(r, 'started', { ...before, aliases: before.aliases + 1 }, { orderIds: [first.orderId, winner.orderId], keys: [first.key, second], browsers: [browserA, browserB] })
  } finally { checkoutOrderHooks.beforeKeyBind = null }
  assert.equal((await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: hashOf(second) } })).orderId, winner.orderId, 'the key stays with the order that got it first')
  assert.deepEqual(await aliasesOf(first.orderId), [hashOf(first.key)], 'and the unpaid order of the browser has only its own key')
  assert.equal((await snapshot()).orders, 2)
})

test('B2 (race, inside the transaction): ... and when the order that got the key meanwhile is the browser\'s OWN other order, the unpaid order is still not served: the key was used for something else', async () => {
  await reset()
  const first = await firstPurchase({ browser: browserA })
  const other = await firstPurchase({ key: newKey(), browser: browserA, cartOver: { rush: true } })
  assert.notEqual(other.orderId, first.orderId)
  const second = newKey()
  const prisma = await prismaP()
  const before = await snapshot()
  let injected = 0
  checkoutOrderHooks.beforeKeyBind = async () => {
    checkoutOrderHooks.beforeKeyBind = null
    injected += 1
    await prisma.guestPurchaseKey.create({ data: { keyHash: hashOf(second), orderId: other.orderId } })
  }
  try {
    const r = await post('session', { checkoutKey: second, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
    assert.equal(injected, 1)
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.code, 'CHECKOUT_KEY_CONFLICT', r.text)
    assert.equal(/"url"|checkout\.stripe/.test(r.text), false, 'no payment page is handed out')
    assert.deepEqual(r.setCookie, [])
  } finally { checkoutOrderHooks.beforeKeyBind = null }
  assert.deepEqual(await snapshot(), { ...before, aliases: before.aliases + 1 }, 'nothing else was made')
  assert.deepEqual(await aliasesOf(first.orderId), [hashOf(first.key)])
})

test('B2: the access cookie of the order, from ANOTHER session, with a NEW key: the order is reused (no second order) and the new key is bound to it', async () => {
  await reset()
  const first = await firstPurchase()
  const fresh = newKey()
  const r = await post('session', { checkoutKey: fresh, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB, ...withAccess(first.accessValue) })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.orderId, first.orderId)
  assert.deepEqual(await aliasesOf(first.orderId), [hashOf(first.key), hashOf(fresh)].sort())
  assert.equal((await snapshot()).orders, 1)
  assert.equal(fake.state.createdSessions, 1)
})

test('J1/J2 (the choice): a browser that can reach TWO unpaid orders of the same cart (the double order R1 leaves behind) is given, for a key, the order that key is bound to - not the newest one', async () => {
  await reset()
  const older = await firstPurchase({ browser: browserA }) // key K1 -> order 1, session A
  const newer = await firstPurchase({ browser: browserB }) // another session, another key -> order 2 (the residual R1)
  assert.notEqual(older.orderId, newer.orderId)
  // browser A now also holds the access cookie of the newer order (its jar has converged with B's), and asks again with ITS key
  const r = await post('session', { checkoutKey: older.key, expectedTotalCents: older.expected, ...older.cart }, { browser: browserA, ...withAccess(newer.accessValue) })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.orderId, older.orderId, 'the order of the key, as the key is bound to exactly one order')
  assert.deepEqual(await aliasesOf(older.orderId), [hashOf(older.key)])
  assert.equal((await snapshot()).orders, 2, 'no third order')
  // and with the key of the newer order, shown with ITS access cookie from A's session: that key belongs to the newer order, and A shows its cookie
  const other = await post('session', { checkoutKey: newer.key, expectedTotalCents: newer.expected, ...newer.cart }, { browser: browserA, ...withAccess(newer.accessValue) })
  assert.equal(other.status, 200, other.text)
  assert.equal(other.json.orderId, newer.orderId)
})

test('B3: a payment already in doubt is refused as before, the key is bound to that order (so a browser that cannot show it is not served by it either), and no new page is made', async () => {
  await reset()
  const k1 = newKey()
  const k2 = newKey()
  const first = await firstPurchase({ key: k1 })
  await setOrder(first.orderId, { paymentStatus: 'processing' })
  const before = await snapshot()
  const again = await post('session', { checkoutKey: k2, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
  assert.equal(again.status, 409, again.text)
  assert.equal(again.json.code, 'PAYMENT_IN_PROGRESS')
  assert.deepEqual(Object.keys(again.json).sort(), ['code', 'error'], 'what a browser known only by its session has always been told: no order, no number')
  const after = await snapshot()
  const makes = (x: typeof after) => ({ orders: x.orders, attempts: x.attempts, stripeCreates: x.stripeCreates, stripeSessions: x.stripeSessions, stripeExpires: x.stripeExpires })
  assert.deepEqual(makes(after), makes(before), 'no order, no attempt, no payment page made or closed (the question to Stripe about a payment in doubt is the one that was always asked)')
  assert.equal(after.aliases, before.aliases + 1, 'one binding more: the only thing a refusal may write')
  assert.deepEqual(await aliasesOf(first.orderId), [hashOf(k1), hashOf(k2)].sort())
  // the browser that holds the order's access cookie is still told which order (as before)
  const named = await post('session', { checkoutKey: newKey(), expectedTotalCents: first.expected, ...first.cart }, { browser: browserA, ...withAccess(first.accessValue) })
  assert.equal(named.status, 409)
  assert.deepEqual(Object.keys(named.json).sort(), ['code', 'error', 'orderId', 'orderNumber'])
  assert.equal(named.json.orderId, first.orderId)
  assert.equal((await aliasesOf(first.orderId)).length, 3)
  // and somebody else with k2 gets the classified refusal, in doubt, and nothing about the order
  await refused('in_doubt', { orderIds: [first.orderId], keys: [k1, k2], browsers: [browserA, browserB] }, () => post('session', { checkoutKey: k2, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }))
})

test('B3: an account\'s refusal binds nothing (the purchase key is for guests: an account is never asked about it)', async () => {
  await reset()
  const first = await pay({ viewer: customer, browser: null })
  assert.equal(first.status, 200, first.text)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const again = await post('session', { checkoutKey: newKey(), expectedTotalCents: first.expected, ...first.cart }, { viewer: customer, browser: null })
  assert.equal(again.status, 409)
  assert.equal(again.json.code, 'PAYMENT_IN_PROGRESS')
  assert.equal(await (await prismaP()).guestPurchaseKey.count(), 0)
})

// ====================================================================================================================================
// A1, A2, A3 - the cases that were open
// ====================================================================================================================================
test('A1: K1 then K2 from one browser (the second reuses the first order), then ANOTHER session with K2 or with K1 and no access cookie: refused, one order, one Stripe page - the case HEAD made two of', async () => {
  await reset()
  const k1 = newKey()
  const k2 = newKey()
  const first = await firstPurchase({ key: k1 })
  const second = await pay({ browser: browserA, key: k2 })
  assert.equal(second.json.orderId, first.orderId)
  const before = await snapshot()
  assert.equal(before.orders, 1)
  assert.equal(before.stripeSessions, 1)
  for (const key of [k2, k1]) {
    const r = await post('session', { checkoutKey: key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
    await assertRefused(r, 'started', before, { orderIds: [first.orderId], keys: [k1, k2], browsers: [browserA, browserB] }, `session B with ${key === k1 ? 'K1' : 'K2'}`)
  }
  assert.equal((await snapshot()).orders, 1)
  assert.equal(fake.state.createdSessions, 1)
})

test('A1: the same holds for a session that has no row at all behind it (a third browser, a session minted a moment ago) and for a request that comes without the session cookie being renewed', async () => {
  await reset()
  const first = await firstPurchase()
  const before = await snapshot()
  for (const browser of [browserB, browserC, newGuestBrowser()]) {
    const r = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser })
    await assertRefused(r, 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browser] })
  }
})

test('A2: K1 and K2 at the same moment from one browser, then both from another session: ONE order, both keys bound, both refused to the other session', async () => {
  await reset()
  const k1 = newKey()
  const k2 = newKey()
  const total = await quoteTotal()
  const lockHolders: number[] = []
  let inside = 0
  checkoutOrderHooks.afterLock = async () => { inside += 1; lockHolders.push(inside); await new Promise((resolve) => setTimeout(resolve, 120)); inside -= 1 }
  const [a, b] = await Promise.all([post('session', { checkoutKey: k1, expectedTotalCents: total, ...cart() }), post('session', { checkoutKey: k2, expectedTotalCents: total, ...cart() })])
  checkoutOrderHooks.afterLock = null
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.equal(a.json.orderId, b.json.orderId)
  assert.deepEqual(lockHolders, [1, 1], 'one after the other: the second one found the first one\'s order')
  assert.deepEqual(await aliasesOf(a.json.orderId), [hashOf(k1), hashOf(k2)].sort())
  const before = await snapshot()
  assert.equal(before.orders, 1)
  for (const key of [k1, k2]) {
    const r = await post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser: browserB })
    await assertRefused(r, 'started', before, { orderIds: [a.json.orderId], keys: [k1, k2], browsers: [browserA, browserB] })
  }
})

test('A2: the SAME key at the same moment from two different sessions: one of them makes the order, the other is refused - one order, one attempt, one page, whoever arrives first', async () => {
  await reset()
  const key = newKey()
  const total = await quoteTotal()
  const used = numbersUsed(await snapshot())
  let inside = 0
  let most = 0
  checkoutOrderHooks.afterLock = async () => { inside += 1; most = Math.max(most, inside); await new Promise((resolve) => setTimeout(resolve, 150)); inside -= 1 }
  const replies = await Promise.all([
    post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser: browserA }),
    post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser: browserB }),
  ])
  checkoutOrderHooks.afterLock = null
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409], replies.map((r) => r.text).join(' | '))
  assert.equal(most, 1, 'the two sessions took turns at the lock of the KEY, although their own session locks are different')
  const winner = replies.find((r) => r.status === 200)!
  const loser = replies.find((r) => r.status === 409)!
  assert.equal(loser.json.code, 'PURCHASE_ALREADY_STARTED')
  assert.deepEqual(Object.keys(loser.json).sort(), ['code', 'error', 'retry', 'supportCode'])
  assert.deepEqual(loser.setCookie, [])
  assert.ok(!loser.text.includes(winner.json.orderId))
  const snap = await snapshot()
  assert.deepEqual({ orders: snap.orders, attempts: snap.attempts, aliases: snap.aliases, sessions: snap.stripeSessions, creates: snap.stripeCreates }, { orders: 1, attempts: 1, aliases: 1, sessions: 1, creates: 1 })
  assert.equal(numbersUsed(snap) - used, 1, 'only the winner used an order number: the other one found the key inside the lock and never tried to make an order')
  assert.equal((await findGuestPurchaseOrder(hashOf(key)))?.id, winner.json.orderId)
})

test('A2: EIGHT sessions send the same key at the same moment: ONE order, ONE attempt, ONE payment page - and seven refusals that carry nothing of it, whoever arrives first', async () => {
  await reset()
  const key = newKey()
  const total = await quoteTotal()
  const browsers = Array.from({ length: 8 }, () => newGuestBrowser())
  const used = numbersUsed(await snapshot())
  let inside = 0
  let most = 0
  checkoutOrderHooks.afterLock = async () => { inside += 1; most = Math.max(most, inside); await new Promise((resolve) => setTimeout(resolve, 40)); inside -= 1 }
  const replies = await Promise.all(browsers.map((browser) => post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser })))
  checkoutOrderHooks.afterLock = null
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409], replies.map((r) => `${r.status} ${r.json?.code}`).join(' | '))
  assert.equal(most, 1, 'eight sessions, eight session locks - and ONE lock of the key that they all took turns at')
  const winner = replies.find((r) => r.status === 200)!
  const losers = replies.filter((r) => r.status === 409)
  for (const loser of losers) {
    assert.equal(loser.json.code, 'PURCHASE_ALREADY_STARTED', loser.text)
    assert.deepEqual(Object.keys(loser.json).sort(), ['code', 'error', 'retry', 'supportCode'])
    assert.deepEqual(loser.setCookie, [])
    assert.ok(!loser.text.includes(winner.json.orderId) && !loser.text.includes(key) && !loser.text.includes(hashOf(key)))
  }
  const snap = await snapshot()
  assert.deepEqual({ orders: snap.orders, attempts: snap.attempts, aliases: snap.aliases, sessions: snap.stripeSessions, creates: snap.stripeCreates }, { orders: 1, attempts: 1, aliases: 1, sessions: 1, creates: 1 })
  assert.equal(numbersUsed(snap) - used, 1, 'seven refusals, and not one of them tried to make an order')
  assert.equal((await findGuestPurchaseOrder(hashOf(key)))?.id, winner.json.orderId)
  // the winner's browser, asking again, is given the very same order, and nothing more is made
  const again = await post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser: browsers[replies.indexOf(winner)] })
  assert.equal(again.status, 200, again.text)
  assert.equal(again.json.orderId, winner.json.orderId)
  assert.equal((await snapshot()).orders, 1)
})

test('A2: different keys of different sessions do not wait for each other (the lock is per key): both are inside at the same time, and make two orders', async () => {
  await reset()
  const total = await quoteTotal()
  let inside = 0
  let most = 0
  checkoutOrderHooks.afterLock = async () => { inside += 1; most = Math.max(most, inside); await new Promise((resolve) => setTimeout(resolve, 300)); inside -= 1 }
  const replies = await Promise.all([
    post('session', { checkoutKey: newKey(), expectedTotalCents: total, ...cart() }, { browser: browserA }),
    post('session', { checkoutKey: newKey(), expectedTotalCents: total, ...cart() }, { browser: browserB }),
  ])
  checkoutOrderHooks.afterLock = null
  for (const r of replies) assert.equal(r.status, 200, r.text)
  assert.notEqual(replies[0].json.orderId, replies[1].json.orderId)
  assert.equal(most, 2, 'one customer\'s purchase never holds up another\'s')
})

test('A3: the first purchase was PAID, the answer was lost, the session changed: the same key is refused as PAID - never a second order, never a second payment page', async () => {
  await reset()
  const k1 = newKey()
  const k2 = newKey()
  const first = await firstPurchase({ key: k1 })
  await pay({ browser: browserA, key: k2 })
  await payOrder(first.orderId, first.sessionId)
  assert.equal((await orderRow(first.orderId)).paymentStatus, 'paid')
  const before = await snapshot()
  for (const key of [k1, k2]) {
    const r = await post('session', { checkoutKey: key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
    await assertRefused(r, 'paid', before, { orderIds: [first.orderId], keys: [k1, k2], browsers: [browserA, browserB] }, `paid, key ${key === k1 ? 'K1' : 'K2'}`)
  }
  // a key that never met this order is what it always was: a new purchase - paying the same things again is allowed (cart-after-payment.sec.ts)
  const again = await pay({ browser: browserB, key: newKey() })
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, first.orderId)
})

test('A3: the owner of a paid order asking again is told what it has always been told - the order can not be paid - and not a new order', async () => {
  await reset()
  const first = await firstPurchase()
  await payOrder(first.orderId, first.sessionId)
  const before = await snapshot()
  const mine = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
  assert.equal(mine.status, 409, mine.text)
  assert.equal(mine.json.code, 'ORDER_NOT_PAYABLE')
  assert.deepEqual(await snapshot(), before)
})

test('A (lost answer): the answer with the access cookie never arrives and the next request comes from another session - refused; the first browser coming back is served with the same page', async () => {
  await reset()
  const first = await firstPurchase()
  // the answer (and its Set-Cookie for mw_checkout) is lost: the test keeps nothing of it
  const before = await snapshot()
  const other = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
  await assertRefused(other, 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] })
  const back = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
  assert.equal(back.status, 200, back.text)
  assert.equal(back.json.orderId, first.orderId)
  assert.equal(back.json.url, first.json.url)
  assert.equal(fake.state.createdSessions, 1)
})

// ====================================================================================================================================
// who is the owner - the key is never the proof
// ====================================================================================================================================
test('J4: the proof is the browser session or the order\'s own access cookie - with the cookie of the order another session is served, with a cookie for ANOTHER order it is refused', async () => {
  await reset()
  const first = await firstPurchase()
  const second = await firstPurchase({ browser: browserC, cartOver: { rush: true } }) // another customer's order, with a cookie that is perfectly valid - for THAT order
  const before = await snapshot()
  const wrongCookie = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB, ...withAccess(second.accessValue) })
  await assertRefused(wrongCookie, 'started', before, { orderIds: [first.orderId, second.orderId], keys: [first.key], browsers: [browserA, browserB, browserC] }, 'a valid cookie for another order')
  const forged = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB, cookie: `${GUEST_ACCESS_COOKIE}=${first.orderId}.${'A'.repeat(43)}` })
  await assertRefused(forged, 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserB] }, 'a forged cookie')
  // the order's own access cookie, from a session that is not the order's: the owner is served - the same order, no second one
  const owner = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB, ...withAccess(first.accessValue) })
  assert.equal(owner.status, 200, owner.text)
  assert.equal(owner.json.orderId, first.orderId)
  assert.equal((await snapshot()).orders, 2, 'no third order')
  assert.equal(fake.state.createdSessions, 2)
})

test('J4: an order whose session hash was emptied (the retention job does that after 45 days) is not proved by ANY session - not even the one that made it - only by its access cookie', async () => {
  await reset()
  const first = await firstPurchase()
  await setOrder(first.orderId, { guestSessionHash: null })
  const before = await snapshot()
  const sameBrowser = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA })
  await assertRefused(sameBrowser, 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA] }, 'the session that made it, hash emptied')
  const someone = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
  await assertRefused(someone, 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserB] }, 'another session')
  const withCookie = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB, ...withAccess(first.accessValue) })
  assert.equal(withCookie.status, 200, withCookie.text)
  assert.equal(withCookie.json.orderId, first.orderId)
})

test('J4: an order that belongs to an ACCOUNT is not proved by a guest session or a guest cookie - the guard looks at nothing but the order\'s own owner', async () => {
  await reset()
  const first = await firstPurchase()
  await setOrder(first.orderId, { userId: customer.id })
  const before = await snapshot()
  const r = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserA, ...withAccess(first.accessValue) })
  await assertRefused(r, 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA] })
})

test('J4: a signed-in customer is not asked about the purchase key at all - the same K gives the account its own order, and the guest\'s binding is untouched', async () => {
  await reset()
  const key = newKey()
  const guest = await firstPurchase({ key })
  const account = await post('session', { checkoutKey: key, expectedTotalCents: guest.expected, ...guest.cart }, { viewer: customer, browser: null })
  assert.equal(account.status, 200, account.text)
  assert.notEqual(account.json.orderId, guest.orderId)
  assert.equal((await orderRow(account.json.orderId)).userId, customer.id)
  assert.deepEqual(await aliasesOf(guest.orderId), [hashOf(key)])
  assert.equal(await (await prismaP()).guestPurchaseKey.count(), 1, 'and none was made for the account')
})

test('J4: the owner who asks again for the SAME key with another cart or another total is told the key was used for something else (as always) - the key does not make a second order for the owner either', async () => {
  await reset()
  const first = await firstPurchase()
  const before = await snapshot()
  const total = await quoteTotal(otherCart())
  const r = await post('session', { checkoutKey: first.key, expectedTotalCents: total, ...otherCart() }, { browser: browserA })
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'CHECKOUT_KEY_CONFLICT')
  assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error'])
  assert.deepEqual(await snapshot(), before)
  // ...and the same through the access cookie from another session
  const viaCookie = await post('session', { checkoutKey: first.key, expectedTotalCents: total, ...otherCart() }, { browser: browserB, ...withAccess(first.accessValue) })
  assert.equal(viaCookie.status, 409, viaCookie.text)
  assert.equal(viaCookie.json.code, 'CHECKOUT_KEY_CONFLICT')
  assert.deepEqual(await snapshot(), before)
})

// ====================================================================================================================================
// the verdict - default-deny (J5)
// ====================================================================================================================================
// the spec, written out again here on purpose: it must not be read from the code that is being tested
const oracle = (order: { paymentStatus: string; paymentReviewReason: string | null; status: string; paidAt: Date | null }, attempts: string[]): PurchaseVerdict => {
  const inDoubt = order.paymentStatus === 'processing' || order.paymentReviewReason !== null || (order.status === 'awaiting_review' && ['paid', 'free'].includes(order.paymentStatus)) || attempts.some((status) => ['processing', 'mismatch'].includes(status))
  if (inDoubt) return 'in_doubt'
  return ['paid', 'free'].includes(order.paymentStatus) || order.paidAt !== null ? 'paid' : 'started'
}

test('J5: every state of an order and of its attempts gives exactly the verdict of the specification - in doubt, paid, or started - and nothing ever gives a way to buy again', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: first.orderId } })
  const orderStates: Array<Record<string, unknown>> = [
    { status: 'awaiting_payment', paymentStatus: 'pending' }, { status: 'awaiting_payment', paymentStatus: 'processing' }, { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: 'amount' },
    { status: 'queued', paymentStatus: 'paid', paidAt: new Date() }, { status: 'queued', paymentStatus: 'paid' }, { status: 'awaiting_review', paymentStatus: 'paid', paidAt: new Date() }, { status: 'awaiting_review', paymentStatus: 'free' },
    { status: 'queued', paymentStatus: 'free' }, { status: 'cancelled', paymentStatus: 'canceled' }, { status: 'cancelled', paymentStatus: 'canceled', paymentReviewReason: 'paid_after_cancel' }, { status: 'cancelled', paymentStatus: 'paid', paidAt: new Date() },
    { status: 'awaiting_payment', paymentStatus: 'failed' }, { status: 'awaiting_review', paymentStatus: 'pending' }, { status: 'queued', paymentStatus: 'pending' }, { status: 'completed', paymentStatus: 'paid', paidAt: new Date() },
    { status: 'cancelled', paymentStatus: 'refunded', paidAt: new Date() }, { status: 'awaiting_payment', paymentStatus: 'unpaid' },
  ]
  const attemptStates: Array<[string, string | null]> = [['creating', null], ['open', null], ['processing', null], ['paid', null], ['expired', 'stale_reservation'], ['expired', 'provider_status:expired'], ['failed', 'payment_failed'], ['failed', 'admin_released'], ['mismatch', null]]
  const seen = new Set<string>()
  let checked = 0
  for (const orderState of orderStates) {
    for (const [attemptStatus, reason] of attemptStates) {
      await prisma.printOrder.update({ where: { id: first.orderId }, data: { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, paidAt: null, ...orderState } as any })
      await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: attemptStatus, failureReason: reason } })
      const row = await orderRow(first.orderId)
      const expected = oracle(row, [attemptStatus])
      assert.equal(await classifyPurchaseOrder(first.orderId), expected, `${JSON.stringify(orderState)} / attempt ${attemptStatus}`)
      seen.add(expected)
      checked += 1
    }
  }
  assert.deepEqual([...seen].sort(), ['in_doubt', 'paid', 'started'], 'all three verdicts occur in the grid and no other')
  assert.equal(checked, orderStates.length * attemptStates.length)
  // two attempts at once: one in doubt is enough
  await prisma.printOrder.update({ where: { id: first.orderId }, data: { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, paidAt: null } })
  await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'expired', failureReason: 'provider_status:expired' } })
  await prisma.paymentAttempt.create({ data: { orderId: first.orderId, amountCents: first.expected, currency: 'EUR', status: 'mismatch', expiresAt: new Date(Date.now() + 60_000) } })
  assert.equal(await classifyPurchaseOrder(first.orderId), 'in_doubt')
  assert.equal(await classifyPurchaseOrder('clnoorderwiththisidatall0000'), 'started', 'an order that is not there is no reason to open anything')
})

test('J5: through the route - the three verdicts reach the answer, each with its own code', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: first.orderId } })
  const secret = { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] }
  const ask = () => post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
  await refused('started', secret, ask)
  await setOrder(first.orderId, { paymentStatus: 'processing' })
  await refused('in_doubt', secret, ask)
  await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'mismatch' } })
  await setOrder(first.orderId, { paymentStatus: 'pending' })
  await refused('in_doubt', secret, ask, 'a mismatching attempt')
  await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'paid' } })
  await setOrder(first.orderId, { paymentStatus: 'paid', status: 'queued', paidAt: new Date() })
  await refused('paid', secret, ask)
  await setOrder(first.orderId, { status: 'awaiting_review', paymentReviewReason: 'amount' })
  await refused('in_doubt', secret, ask, 'paid but under review')
})

test('B1 (R3): a cancelled order is NOT a closed purchase - not after the administrator decided "no charge", not when the page expired, not when an attempt failed: the verdict is "started" and nothing unlocks', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: first.orderId } })
  // what the payment hold leaves behind after "no charge": the order cancelled, the attempt released - while the page at Stripe may still be open and payable
  await prisma.printOrder.update({ where: { id: first.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled', metadata: { cancellation: { reason: 'admin_payment_hold_release' }, paymentHoldResolution: [{ outcome: 'no_charge', stripeCheck: 'confirmed_no_charge' }] } as any } })
  await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'failed', failureReason: 'admin_released' } })
  const before = await snapshot()
  const open = fake.sessions.get(first.sessionId)!
  assert.equal(open.status, 'open', 'the page at the provider is still open and payable')
  await assertRefused(await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }), 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] })
  // the closing at Stripe fails and the customer pays on the page that was thought closed: the money lands on a cancelled order (paid_after_cancel) - which is "in doubt", never closed
  fake.pay(first.sessionId)
  await prisma.printOrder.update({ where: { id: first.orderId }, data: { paymentStatus: 'paid', paymentReviewReason: 'paid_after_cancel', paidAt: new Date() } })
  await refused('in_doubt', { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] }, () => post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }))
})

test('B2 (R3): an order cancelled because "the page expired" while one attempt failed on a card that was refused (that page may still be open) is "started" - an expiry or a failure is not proof that nothing can be paid', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const a1 = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: first.orderId } })
  await prisma.paymentAttempt.update({ where: { id: a1.id }, data: { status: 'expired', failureReason: 'provider_status:expired' } })
  await prisma.paymentAttempt.create({ data: { orderId: first.orderId, amountCents: first.expected, currency: 'EUR', status: 'failed', failureReason: 'payment_failed', stripeSessionId: 'cs_test_FAKE_second_page_still_open', expiresAt: new Date(Date.now() + 60_000) } })
  await prisma.printOrder.update({ where: { id: first.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled', metadata: { cancellation: { reason: 'checkout_expired' } } as any } })
  const before = await snapshot()
  await assertRefused(await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }), 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] })
})

test('B3 (R3): there is no way to a "closed" purchase - for any world of orders and attempts the verdict is one of three, and the code that decides has no other', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: first.orderId } })
  const verdicts = new Set<string>()
  const statuses = ['awaiting_payment', 'awaiting_review', 'queued', 'cancelled', 'completed', 'failed', 'on_hold']
  const payments = ['pending', 'processing', 'paid', 'free', 'canceled', 'failed', 'refunded', 'requires_action']
  const attempts = ['creating', 'open', 'processing', 'paid', 'expired', 'failed', 'mismatch']
  for (const status of statuses) for (const paymentStatus of payments) for (const attemptStatus of attempts) {
    await prisma.printOrder.update({ where: { id: first.orderId }, data: { status, paymentStatus, paymentReviewReason: null, paidAt: null } })
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: attemptStatus } })
    verdicts.add(await classifyPurchaseOrder(first.orderId))
  }
  assert.deepEqual([...verdicts].sort(), ['in_doubt', 'paid', 'started'])
})

// ====================================================================================================================================
// the crash points A-F of the payment (what the guard sees at each, and that it never asks Stripe)
// ====================================================================================================================================
test('crash A-D: the order exists but the payment page may or may not exist yet - the other session is told "started", and Stripe is not asked anything', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['A: the order exists, no attempt yet', async () => { await prisma.paymentAttempt.deleteMany({ where: { orderId: first.orderId } }) }],
    ['B: an attempt is being reserved, no page asked for', async () => { await prisma.paymentAttempt.create({ data: { orderId: first.orderId, amountCents: first.expected, currency: 'EUR', status: 'creating', expiresAt: new Date(Date.now() + 60_000) } }) }],
    ['C/D: the call to Stripe is in progress, the page was made but its id not saved', async () => { await prisma.paymentAttempt.updateMany({ where: { orderId: first.orderId }, data: { status: 'creating', stripeSessionId: null, createdAt: new Date(Date.now() - 10 * 60_000), expiresAt: new Date(Date.now() - 5 * 60_000) } }) }],
    ['D2: the reservation went stale (a timer of ours is not proof of anything)', async () => { await prisma.paymentAttempt.updateMany({ where: { orderId: first.orderId }, data: { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: null } }) }],
  ]
  for (const [label, seed] of cases) {
    await seed()
    const before = await snapshot()
    await assertRefused(await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }), 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] }, label)
    assert.deepEqual(fake.state.reads, [], `${label}: the guard reads nothing from Stripe`)
  }
})

test('crash E: the customer paid, our database does not know yet and the local timer of the attempt has run out - "started" (never "free"), no question to Stripe; after the sync it is "paid"', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  await prisma.paymentAttempt.updateMany({ where: { orderId: first.orderId }, data: { expiresAt: new Date(Date.now() - 60 * 60_000) } })
  fake.pay(first.sessionId) // paid at the provider; nothing recorded here
  assert.equal((await orderRow(first.orderId)).paymentStatus, 'pending')
  const before = await snapshot()
  await assertRefused(await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }), 'started', before, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] })
  assert.deepEqual(fake.state.reads, [], 'and the guard asked Stripe nothing')
  await syncPayment({ kind: 'checkout_session', id: first.sessionId, hint: { orderId: first.orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  assert.equal((await orderRow(first.orderId)).paymentStatus, 'paid')
  const after = await snapshot()
  await assertRefused(await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB }), 'paid', after, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] })
})

test('crash F: paid and recorded, the browser does not know - "paid"', async () => {
  await reset()
  const first = await firstPurchase()
  await payOrder(first.orderId, first.sessionId)
  await refused('paid', { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserC] }, () => post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserC }))
})

// ====================================================================================================================================
// the database is the arbiter (J2, J6) - with the lock taken away, and with the key bound underneath a running request
// ====================================================================================================================================
async function bothInside(count: number, body: () => Promise<unknown>) {
  let arrived = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  checkoutOrderHooks.afterLock = async () => { arrived += 1; if (arrived >= count) release(); await gate }
  try { return await body() } finally { checkoutOrderHooks.afterLock = null }
}

test('J2/J6: with the lock of the key taken away, two sessions with the same key reach the creation together - the PRIMARY KEY of the table still lets only ONE order stand, and the other session is refused', async () => {
  await reset()
  checkoutOrderHooks.withoutPurchaseKeyLock = true
  const key = newKey()
  const total = await quoteTotal()
  const replies = await bothInside(2, () => Promise.all([
    post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser: browserA }),
    post('session', { checkoutKey: key, expectedTotalCents: total, ...cart() }, { browser: browserB }),
  ])) as Reply[]
  checkoutOrderHooks.withoutPurchaseKeyLock = false
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409], replies.map((r) => r.text).join(' | '))
  const loser = replies.find((r) => r.status === 409)!
  assert.equal(loser.json.code, 'PURCHASE_ALREADY_STARTED')
  assert.deepEqual(loser.setCookie, [])
  const snap = await snapshot()
  assert.deepEqual({ orders: snap.orders, attempts: snap.attempts, aliases: snap.aliases, sessions: snap.stripeSessions }, { orders: 1, attempts: 1, aliases: 1, sessions: 1 }, 'the order of the loser was never kept')
  assert.equal((await findGuestPurchaseOrder(hashOf(key)))?.id, replies.find((r) => r.status === 200)!.json.orderId)
})

test('J2/J6: ... and the same with the lock and with the session lock taken away together (two different carts of one browser with the same key) - the loser is the OWNER and is told the key was used for another cart', async () => {
  await reset()
  checkoutOrderHooks.withoutPurchaseKeyLock = true
  const key = newKey()
  const totalA = await quoteTotal(cart())
  const totalB = await quoteTotal(otherCart())
  const replies = await bothInside(2, () => Promise.all([
    post('session', { checkoutKey: key, expectedTotalCents: totalA, ...cart() }, { browser: browserA }),
    post('session', { checkoutKey: key, expectedTotalCents: totalB, ...otherCart() }, { browser: browserA }),
  ])) as Reply[]
  checkoutOrderHooks.withoutPurchaseKeyLock = false
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409], replies.map((r) => r.text).join(' | '))
  const loser = replies.find((r) => r.status === 409)!
  assert.equal(loser.json.code, 'CHECKOUT_KEY_CONFLICT', 'the same browser: the order is its own, the cart is not the same')
  const snap = await snapshot()
  assert.deepEqual({ orders: snap.orders, attempts: snap.attempts, aliases: snap.aliases, sessions: snap.stripeSessions }, { orders: 1, attempts: 1, aliases: 1, sessions: 1 })
})

test('J2: a key that is bound is bound for good - binding it again to the same order changes nothing, binding it to another order changes nothing and says so, and the row is never rewritten', async () => {
  await reset()
  const key = newKey()
  const first = await firstPurchase({ key })
  const other = await firstPurchase({ browser: browserB, key: newKey() })
  const prisma = await prismaP()
  const row = await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: hashOf(key) } })
  assert.equal(await bindGuestPurchaseKey({ purchaseKeyHash: hashOf(key), orderId: first.orderId }), 'already')
  assert.equal(await bindGuestPurchaseKey({ purchaseKeyHash: hashOf(key), orderId: other.orderId }), 'other')
  const after = await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: hashOf(key) } })
  assert.deepEqual(after, row)
  const fresh = hashOf(newKey())
  assert.equal(await bindGuestPurchaseKey({ purchaseKeyHash: fresh, orderId: first.orderId }), 'bound')
  assert.equal(await bindGuestPurchaseKey({ purchaseKeyHash: fresh, orderId: first.orderId }), 'already')
  // junk is not bound: a fingerprint has one shape, an order has to exist
  await assert.rejects(() => bindGuestPurchaseKey({ purchaseKeyHash: 'not-a-fingerprint', orderId: first.orderId }))
  await assert.rejects(() => bindGuestPurchaseKey({ purchaseKeyHash: key, orderId: first.orderId }), 'the key itself is not a fingerprint')
  assert.equal(await bindGuestPurchaseKey({ purchaseKeyHash: hashOf(newKey()), orderId: 'clnoorderwiththisidatall0000' }), 'other', 'an order that is not there: nothing is bound')
  assert.equal(await prisma.guestPurchaseKey.count({ where: { orderId: 'clnoorderwiththisidatall0000' } }), 0)
  // many at the same moment, every one for a different order: exactly one wins and it keeps the key
  const contested = hashOf(newKey())
  const outcomes = await Promise.all([first.orderId, other.orderId, first.orderId, other.orderId].map((orderId) => bindGuestPurchaseKey({ purchaseKeyHash: contested, orderId })))
  assert.equal(outcomes.filter((outcome) => outcome === 'bound').length, 1)
  const winner = (await prisma.guestPurchaseKey.findUniqueOrThrow({ where: { keyHash: contested } })).orderId
  assert.equal(outcomes.filter((outcome) => outcome === 'already').length, [first.orderId, other.orderId, first.orderId, other.orderId].filter((id) => id === winner).length - 1)
  assert.equal(outcomes.filter((outcome) => outcome === 'other').length, [first.orderId, other.orderId, first.orderId, other.orderId].filter((id) => id !== winner).length)
})

test('J2: the table is the arbiter even for a writer that knows nothing of the rules - a second row for the same fingerprint, or a fingerprint that is not one, is refused by the database itself', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  await assert.rejects(() => prisma.guestPurchaseKey.create({ data: { keyHash: hashOf(first.key), orderId: first.orderId } }), /Unique constraint/)
  await assert.rejects(() => prisma.guestPurchaseKey.create({ data: { keyHash: first.key, orderId: first.orderId } }), /check|constraint|violat/i, 'a raw key can not be stored')
  await assert.rejects(() => prisma.guestPurchaseKey.create({ data: { keyHash: sha('x').toUpperCase(), orderId: first.orderId } }), /check|constraint|violat/i)
  await assert.rejects(() => prisma.guestPurchaseKey.create({ data: { keyHash: sha('y'), orderId: 'clnoorderwiththisidatall0000' } }), /Foreign key/)
})

test('re-read after the collision: the order layer re-reads the key after a lost race and answers by who is asking (refused, or served) - and never leaves the new order behind', async () => {
  await reset()
  const key = newKey()
  const winner = await firstPurchase({ key, browser: browserA })
  const prisma = await prismaP()
  const items = cart().items as any
  const quote = await buildCardQuote({ items, shippingMethod: 'pickup', rush: false, publicBaseUrl: null })
  const base = { storedKey: sha(`direct-${key}`), fingerprint: 'f'.repeat(64), cartFingerprint: 'c'.repeat(64), quote, items, rush: false }
  const ordersBefore = await prisma.printOrder.count()
  // a request from a session without proof: the layer itself refuses, with the classification and the support code - and writes nothing
  await assert.rejects(() => createPendingCardOrder({ ...base, guestSessionHash: browserB.hash, purchaseKeyHash: hashOf(key) }), (error: unknown) => {
    assert.ok(error instanceof PurchaseRefusedError)
    assert.equal(error.verdict, 'started')
    assert.equal(error.supportCode, supportCodeFor(hashOf(key)))
    assert.equal(/clorder|[0-9a-f]{20}/.test(error.message), false, 'no identifier in the message')
    return true
  })
  assert.equal(await prisma.printOrder.count(), ordersBefore)
  // the session that owns the order is given the order (no new one)
  const mine = await createPendingCardOrder({ ...base, guestSessionHash: browserA.hash, purchaseKeyHash: hashOf(key) })
  assert.equal(mine.created, false)
  assert.equal(mine.order.id, winner.orderId)
  // the order's access cookie is a proof too
  const viaCookie = await createPendingCardOrder({ ...base, guestSessionHash: browserB.hash, guestOrderIds: [winner.orderId], purchaseKeyHash: hashOf(key) })
  assert.equal(viaCookie.created, false)
  assert.equal(viaCookie.order.id, winner.orderId)
  assert.equal(await prisma.printOrder.count(), ordersBefore)
})

test('the order layer has the rule too, not only the route: a guest order can not be made without a purchase key (nothing is written), and a session is still asked for first', async () => {
  await reset()
  const prisma = await prismaP()
  const items = cart().items as any
  const quote = await buildCardQuote({ items, shippingMethod: 'pickup', rush: false, publicBaseUrl: null })
  const base = { fingerprint: 'f'.repeat(64), cartFingerprint: 'c'.repeat(64), quote, items, rush: false }
  const before = await prisma.printOrder.count()
  for (const missing of [undefined, null, '', 'k' + 'a'.repeat(32), sha('x').toUpperCase(), sha('x').slice(1)]) {
    await assert.rejects(() => createPendingCardOrder({ ...base, storedKey: sha(`direct-${String(missing)}`), guestSessionHash: browserA.hash, purchaseKeyHash: missing as any }), /needs a purchase key; order not created/)
  }
  // (the rule is the layer's own: it does not lean on the lock of the key failing to be named)
  checkoutOrderHooks.withoutPurchaseKeyLock = true
  try {
    await assert.rejects(() => createPendingCardOrder({ ...base, storedKey: sha('direct-without-the-lock'), guestSessionHash: browserA.hash, purchaseKeyHash: null }), /needs a purchase key; order not created/)
  } finally { checkoutOrderHooks.withoutPurchaseKeyLock = false }
  await assert.rejects(() => createPendingCardOrder({ ...base, storedKey: sha('direct-no-session'), guestSessionHash: null, purchaseKeyHash: hashOf(newKey()) }), /guest session/)
  await assert.rejects(() => createPendingCardOrder({ ...base, storedKey: sha('direct-nothing') }), /guest session/, 'with neither, the session is the first thing asked for')
  assert.equal(await prisma.printOrder.count(), before)
  assert.equal(await prisma.guestPurchaseKey.count(), 0)
  const key = newKey()
  const made = await createPendingCardOrder({ ...base, storedKey: sha('direct-ok'), guestSessionHash: browserA.hash, purchaseKeyHash: hashOf(key) })
  assert.equal(made.created, true)
  assert.deepEqual(await aliasesOf(made.order.id), [hashOf(key)], 'order and binding were made together')
})

// ====================================================================================================================================
// nothing is disclosed (J3) - answers, headers, logs, metrics
// ====================================================================================================================================
test('J3: a refusal says nothing that belongs to the order or to anybody - not in the body, the headers, the log lines or the counters - and the counter is by verdict only', async () => {
  await reset()
  const first = await firstPurchase()
  const beforeRefusal = await snapshot()
  const lines: string[] = []
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  const sink = (...args: unknown[]) => { lines.push(format(...args)) }
  console.log = sink; console.info = sink; console.warn = sink; console.error = sink
  let r: Reply
  try {
    r = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
  } finally { Object.assign(console, original) }
  await assertRefused(r, 'started', beforeRefusal, { orderIds: [first.orderId], keys: [first.key], browsers: [browserA, browserB] })
  const logged = lines.join('\n')
  assert.ok(logged.includes('/api/checkout/session'), 'the request was logged...')
  for (const secret of [first.orderId, first.key, first.key.slice(1), hashOf(first.key), browserA.sid, browserA.hash, browserB.sid, browserB.hash, String(first.json.url)]) {
    assert.ok(!logged.includes(secret), `...but not with ${secret.slice(0, 8)}...`)
  }
  const snapshotText = JSON.stringify(getInMemoryMetricsSnapshot())
  for (const secret of [first.orderId, first.key, hashOf(first.key), browserA.hash, browserB.hash]) assert.ok(!snapshotText.includes(secret), 'nor in a counter')
  const refused = getInMemoryMetricsSnapshot().counters.filter((c) => c.name === 'checkout_purchase_key_refused_total')
  assert.ok(refused.length >= 1)
  for (const counter of refused) assert.deepEqual(Object.keys(counter.labels).sort(), ['verdict'], 'labelled by verdict and by nothing else')
  assert.ok(refused.some((c) => (c.labels as any).verdict === 'started' && c.value >= 1))
})

test('J3: the three refusals look alike - the same four things, in the same form - so that the answer does not teach more than the verdict (and no verdict makes the next request any different)', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const shape = (r: Reply) => ({ keys: Object.keys(r.json).sort().join(','), retry: r.json.retry, cookies: r.setCookie.length, cache: r.res.headers.get('cache-control'), vary: r.res.headers.get('vary'), type: (r.res.headers.get('content-type') || '').split(';')[0] })
  const ask = () => post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: browserB })
  const started = await ask()
  await setOrder(first.orderId, { paymentStatus: 'processing' })
  const doubt = await ask()
  await prisma.printOrder.update({ where: { id: first.orderId }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date(), paymentReviewReason: null } })
  const paid = await ask()
  assert.deepEqual([started.status, doubt.status, paid.status], [409, 409, 409])
  assert.deepEqual(shape(started), shape(doubt))
  assert.deepEqual(shape(started), shape(paid))
  assert.equal(started.json.supportCode, doubt.json.supportCode, 'the code belongs to the key, not to the state')
  assert.equal(started.json.supportCode, paid.json.supportCode)
  assert.match(started.res.headers.get('cache-control') || '', /no-store/)
  assert.match(started.res.headers.get('cache-control') || '', /private/)
})

// ====================================================================================================================================
// C1 - compatibility with the code of before, and the way back (R3.6: the checkout is suspended, the table stays)
// ====================================================================================================================================
test('C1: what the code of before R1-1b needs is still there - every new order is found by the key of HEAD, with the session in it, exactly as it was written then', async () => {
  await reset()
  const keys = [newKey(), newKey(), newKey()]
  const made: string[] = []
  for (const key of keys) made.push((await firstPurchase({ key, browser: newGuestBrowser(), cartOver: { rush: made.length === 1 } })).orderId)
  const prisma = await prismaP()
  for (const orderId of made) {
    const order = await orderRow(orderId)
    const key = keys[made.indexOf(orderId)]
    assert.equal(order.checkoutKey, storedCheckoutKey({ kind: 'guest', sessionHash: order.guestSessionHash as string }, key))
    assert.equal((await findOrderByCheckoutKey(order.checkoutKey as string))?.id, orderId)
    assert.equal(order.userId, null)
    assert.ok(order.guestAccessTokenHash && order.guestAccessExpiresAt && order.guestSessionHash)
  }
  assert.equal(await prisma.printOrder.count({ where: { checkoutKey: null } }), 0)
})

test('C1: the table stays behind a rolled-back code and a suspended checkout - the check for a rollback counts what a DROP TABLE would destroy (paid, in doubt, still open) and refuses to call it safe', async () => {
  await reset()
  const paid = await firstPurchase({ browser: browserA })
  await payOrder(paid.orderId, paid.sessionId)
  const doubt = await firstPurchase({ browser: browserB, cartOver: { rush: true } })
  await setOrder(doubt.orderId, { paymentStatus: 'processing' })
  const open = await firstPurchase({ browser: browserC, cartOver: { items: [{ modelId, qty: 4, colors: ['#ffffff'], material: 'PLA' }] } })
  const sql = readFileSync(path.resolve(__dirname, '../../scripts/guest-purchase-keys-check.sql'), 'utf8')
  assert.match(sql, /GuestPurchaseKey/)
  assert.equal(/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql.replace(/--.*$/gm, '')), false, 'the check only reads')
  const prisma = await prismaP()
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, bigint | number>>>(sql)
  const n = (name: string) => Number(row[name])
  assert.equal(n('bindings'), 3)
  assert.equal(n('tied_to_paid'), 1, 'the paid order')
  assert.equal(n('tied_to_in_doubt'), 1, 'the order whose payment is being confirmed')
  assert.equal(n('tied_to_unpaid_orders'), 1, 'the order that still waits for its payment')
  assert.equal(n('tied_to_open_attempts'), 2, 'two orders have a payment page that may still lead to a payment')
  assert.equal(n('safe_to_drop'), 0, 'with any binding the table is not to be dropped')
  await prisma.printOrder.deleteMany()
  const [empty] = await prisma.$queryRawUnsafe<Array<Record<string, bigint | number>>>(sql)
  assert.equal(Number(empty.bindings), 0)
  assert.equal(Number(empty.safe_to_drop), 1, 'an empty table may be dropped')
  assert.ok(open.orderId)
})

async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {}
  for (const key of Object.keys(over)) before[key] = process.env[key]
  const set = (values: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  set(over)
  try { return await fn() } finally { set(before) }
}

test('C1: with the hosted checkout switched off (HOSTED_CHECKOUT_ENABLED=false, how the code of before is put back) the route answers 503 and makes nothing, whoever asks - while the status of a payment under way and the sync of it keep working', async () => {
  await reset()
  const first = await firstPurchase()
  const prisma = await prismaP()
  const config = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 'main' } })
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 0 } as any })
  try {
    await withEnv({ NODE_ENV: 'production', BASE_URL: 'https://127.0.0.1:9', HOSTED_CHECKOUT_ENABLED: 'false', TAX_MODE: 'none', COOKIE_SECURE: undefined }, async () => {
      const hostBrowser = { ...browserA, cookie: `${GUEST_SESSION_COOKIE_HOST}=${browserA.value}` }
      const before = await snapshot()
      const owner = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: hostBrowser, headers: { 'x-forwarded-proto': 'https' } })
      assert.equal(owner.status, 503, owner.text)
      assert.equal(owner.json.code, 'CHECKOUT_DISABLED')
      const stranger = await post('session', { checkoutKey: first.key, expectedTotalCents: first.expected, ...first.cart }, { browser: { ...browserB, cookie: `${GUEST_SESSION_COOKIE_HOST}=${browserB.value}` }, headers: { 'x-forwarded-proto': 'https' } })
      assert.equal(stranger.status, 503, stranger.text)
      assert.equal(stranger.json.code, 'CHECKOUT_DISABLED')
      assert.deepEqual(await snapshot(), before)
      // the status of the order under way is not behind the switch
      const status = await import('../../app/api/checkout/status/route')
      viewerGuards.getViewer = async () => null
      const st = (await (status.GET as any)(new NextRequest(`http://localhost/api/checkout/status?order=${first.orderId}`, { headers: { cookie: `${GUEST_ACCESS_COOKIE}=${first.accessValue}`, 'x-forwarded-for': nextIp() } }), {})) as Response
      assert.equal(st.status, 200)
    })
    // ...nor is the sync of a payment: the customer who was already on Stripe's page is still recorded
    await payOrder(first.orderId, first.sessionId)
    assert.equal((await orderRow(first.orderId)).paymentStatus, 'paid')
  } finally {
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: (config as any).minimumOrderSubtotalUsd } as any })
  }
})

test('C1: deleting an order takes its bindings with it (they follow the order), and nothing else is touched', async () => {
  await reset()
  const first = await firstPurchase()
  const second = await firstPurchase({ browser: browserB, cartOver: { rush: true } })
  const prisma = await prismaP()
  await pay({ browser: browserA, key: newKey() })
  assert.equal(await prisma.guestPurchaseKey.count(), 3)
  await prisma.paymentAttempt.deleteMany({ where: { orderId: first.orderId } })
  await prisma.printOrder.delete({ where: { id: first.orderId } })
  assert.equal(await prisma.guestPurchaseKey.count(), 1)
  assert.deepEqual((await prisma.guestPurchaseKey.findMany()).map((row) => row.orderId), [second.orderId])
})

// ====================================================================================================================================
// the table, as the migration makes it
// ====================================================================================================================================
test('the table is what the architecture says: the fingerprint is the primary key, one index on the order, a cascading foreign key, a check on the shape - and nothing else', async () => {
  const prisma = await prismaP()
  const columns = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
    SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'GuestPurchaseKey' ORDER BY column_name`
  assert.deepEqual(columns.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}:${c.column_default ?? ''}`), ['createdAt:timestamp without time zone:NO:CURRENT_TIMESTAMP', 'keyHash:text:NO:', 'orderId:text:NO:'])
  const constraints = await prisma.$queryRaw<Array<{ conname: string; contype: string; def: string }>>`
    SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"GuestPurchaseKey"'::regclass ORDER BY conname`
  assert.ok(constraints.some((c) => c.contype === 'p' && /PRIMARY KEY \("keyHash"\)/.test(c.def)))
  assert.ok(constraints.some((c) => c.contype === 'f' && /FOREIGN KEY \("orderId"\) REFERENCES "PrintOrder"\(id\) ON UPDATE CASCADE ON DELETE CASCADE/.test(c.def)))
  assert.ok(constraints.some((c) => c.contype === 'c' && /keyHash/.test(c.def) && /\[0-9a-f\]\{64\}/.test(c.def)), 'the check on the shape of a fingerprint')
  const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'GuestPurchaseKey' ORDER BY indexname`
  assert.deepEqual(indexes.map((i) => i.indexname), ['GuestPurchaseKey_orderId_idx', 'GuestPurchaseKey_pkey'])
  // the lookup by fingerprint is a lookup by primary key
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
    return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN SELECT "orderId" FROM "GuestPurchaseKey" WHERE "keyHash" = '${sha('plan')}'`)
  })
  assert.match(plan.map((row) => row['QUERY PLAN']).join('\n'), /GuestPurchaseKey_pkey/)
  // PrintOrder has not been touched: the columns that existed are the columns that exist
  const printOrderColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PrintOrder'`
  assert.ok(!printOrderColumns.some((c) => /purchase/i.test(c.column_name)), 'no column was added to PrintOrder')
})

// ====================================================================================================================================
// what the code is not allowed to do (read from the source, so that a later change has to say it on purpose)
// ====================================================================================================================================
const root = path.resolve(__dirname, '../..')
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.git'].includes(entry)) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full)
    }
  }
  for (const dir of dirs) walk(path.join(root, dir))
  return out
}

test('the code never rewrites or deletes a binding: only creation and reading touch the table (rows leave it only with their order, by the cascade of the database)', () => {
  const offenders: string[] = []
  for (const file of sourceFiles(['app', 'lib', 'components', 'scripts'])) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    if (/guestPurchaseKey\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(code) || /"GuestPurchaseKey"\s+SET\b|DELETE\s+FROM\s+"GuestPurchaseKey"|UPDATE\s+"GuestPurchaseKey"/i.test(code)) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [])
})

test('the key itself is never written on purpose: the route turns it into its fingerprint before anything else and hands it to nothing that logs or stores it', () => {
  const route = readFileSync(path.join(root, 'app/api/checkout/session/route.ts'), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(route, /purchaseKeyFor\(checkoutKey\)/)
  assert.equal(/(logEvent|captureError|console\.\w+|incrementMetric)\([^)]*checkoutKey/.test(route), false, 'the key is not logged, captured or counted')
  assert.equal(/Math\.random/.test(route + readFileSync(path.join(root, 'lib/checkout-orders.ts'), 'utf8')), false)
})

test('the test seams of the purchase key are seams: nothing in app, lib, components or scripts sets them (only the declaration), and both are off by default', () => {
  const orders = readFileSync(path.join(root, 'lib/checkout-orders.ts'), 'utf8')
  const ordersCode = orders.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const seam of ['withoutPurchaseKeyLock', 'beforeKeyBind']) {
    const offenders: string[] = []
    for (const file of sourceFiles(['app', 'lib', 'components', 'scripts'])) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      if (new RegExp(`${seam}\\s*=(?!=)`).test(code)) offenders.push(path.relative(root, file))
    }
    assert.deepEqual(offenders, [], `${seam}: set by no file of the application`)
    assert.equal(new RegExp(`\\.${seam}\\s*=\\s*(true|async|\\()`).test(ordersCode), false, `${seam}: not even by the module that declares it`)
  }
  assert.match(orders, /withoutPurchaseKeyLock: false/, 'the lock is on by default')
  assert.match(orders, /beforeKeyBind: null \}/, 'no pause before the binding by default')
})

// ====================================================================================================================================
// E1 - what did not change
// ====================================================================================================================================
test('E1: one browser, one purchase, any number of keys and clicks = one order and one payment page; two customers = two orders; another cart = another order; an account is as before', async () => {
  await reset()
  const total = await quoteTotal()
  const twelve = await Promise.all(Array.from({ length: 12 }, () => post('session', { checkoutKey: newKey(), expectedTotalCents: total, ...cart() })))
  for (const r of twelve) assert.equal(r.status, 200, r.text)
  assert.equal(new Set(twelve.map((r) => r.json.orderId)).size, 1)
  assert.equal((await snapshot()).orders, 1)
  assert.equal(fake.state.createdSessions, 1)
  const other = await pay({ browser: browserB })
  assert.equal(other.status, 200, other.text)
  assert.notEqual(other.json.orderId, twelve[0].json.orderId)
  const changed = await pay({ browser: browserA, cart: otherCart() })
  assert.equal(changed.status, 200, changed.text)
  assert.notEqual(changed.json.orderId, twelve[0].json.orderId)
  const account = await pay({ viewer: customer, browser: null })
  assert.equal(account.status, 200)
  const account2 = await pay({ viewer: customer, browser: null })
  assert.equal(account2.json.orderId, account.json.orderId, 'an account\'s second key for the same cart is still the same order')
  assert.equal((await snapshot()).orders, 4)
  assert.equal(fake.state.createdSessions, 4)
})
