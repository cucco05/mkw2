// Step 4.6 (S5) – WHO is paying: the browser session of a guest (lib/guest-session.ts), and what the server does with it.
//
// What must hold (each point is a test below; fake Stripe, throw-away database, fake data):
//   * a guest gets a signed session cookie with the quote, before any payment exists; its attributes are the strict ones (HttpOnly, SameSite=Lax, Path=/, 30 days,
//     Secure on https) and the answers that carry it, and every other answer of the two checkout routes, are never cached;
//   * a guest without a VALID session - none, forged, expired, signed with another secret - gets 428 and NOTHING is made: no order, no payment attempt, no call to
//     Stripe; asked again without a cookie it is 428 again, for ever (the page repeats the request once, then says the browser keeps no cookies);
//   * the repeat-key is kept inside the session: two guests that send the SAME key (same cart or not) get two orders, two payment pages, and never see each
//     other's; a key that finds an order of another session is refused without saying why;
//   * the same purchase made twice by the same browser is ONE order and ONE payment page, whatever the keys: double click, two tabs, a lost key, simultaneous
//     requests (in this process here; with two real processes in guest-session-multiprocess.sec.ts);
//   * the session is never an authorization: it opens no status page, no order API, no file, no list; a payment in progress recognised ONLY by the session is
//     refused without naming the order;
//   * what is stored is a hash, in the same step that creates the order; the session itself is nowhere in the database or at Stripe;
//   * accounts are untouched; the economic result (quote = order = Stripe) is the same as without sessions.
// And what is NOT closed, written down so that a future change has to update it: RESIDUO R1 (two first requests with different new sessions).
import { db, resetDb, seedShopModel, stripeCalls } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { guestHeaders, newGuestBrowser, type GuestBrowser } from './_guest'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import {
  GUEST_SESSION_COOKIE, GUEST_SESSION_RENEW_AFTER_MS, GUEST_SESSION_TTL_MS, hashGuestSession, mintGuestSession, verifyGuestSession,
} from '../../lib/guest-session'
import { GUEST_ACCESS_COOKIE, parseGuestAccessCookie } from '../../lib/guest-order-access'
import { checkoutOrderHooks, createPendingCardOrder, storedCheckoutKey } from '../../lib/checkout-orders'
import { buildCardQuote } from '../../lib/checkout-quote'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let customer: NonNullable<Viewer>

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV), 'COOKIE_SECURE']) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT
const DAY = 24 * 60 * 60 * 1000

let ipSeq = 0
const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `gs-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`

type Item = Record<string, unknown>
const cart = (over: Record<string, unknown> = {}) => ({
  items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }] as Item[], shipping: { method: 'pickup' }, rush: false, ...over,
})

// `browser`: whose cookie jar sends this (undefined = browser A of the test, null = no session cookie at all); `cookie`: other cookies to add as they are.
type Call = { browser?: GuestBrowser | null; cookie?: string; viewer?: Viewer | null; ip?: string; origin?: string | null; headers?: Record<string, string> }
let browserA: GuestBrowser
let browserB: GuestBrowser
async function post(route: 'quote' | 'session', body: unknown, o: Call = {}) {
  viewerGuards.getViewer = async () => o.viewer ?? null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const browser = o.browser === undefined ? browserA : o.browser
  const cookie = [browser?.cookie, o.cookie].filter(Boolean).join('; ')
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-forwarded-for': o.ip ?? nextIp(),
    ...(o.origin === null ? {} : { origin: o.origin ?? 'http://localhost' }),
    ...(cookie ? { cookie } : {}),
    ...(o.headers || {}),
  }
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, { method: 'POST', headers, body: JSON.stringify(body) }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  const setCookie = res.headers.getSetCookie()
  const named = (name: string) => setCookie.find((c) => c.startsWith(`${name}=`)) ?? null
  const value = (header: string | null) => (header ? decodeURIComponent(header.split(';')[0].split('=').slice(1).join('=')) : null)
  const sidHeader = named(GUEST_SESSION_COOKIE)
  const accessHeader = named(GUEST_ACCESS_COOKIE)
  return { res, status: res.status, json, text, setCookie, sidHeader, sidValue: value(sidHeader), accessHeader, accessValue: value(accessHeader) }
}
type Reply = Awaited<ReturnType<typeof post>>

const quoteTotal = async (c = cart(), o: Call = {}) => {
  const q = await post('quote', c, o)
  assert.equal(q.status, 200, q.text)
  return q.json.totalCents as number
}
// What the page does: quote, then "pay" (with the total it was shown).
async function pay(o: Call & { key?: string; cartOver?: Record<string, unknown> } = {}) {
  const c = cart(o.cartOver)
  const expected = await quoteTotal(c, o)
  const key = o.key ?? newKey()
  const r = await post('session', { checkoutKey: key, expectedTotalCents: expected, ...c }, o)
  return { ...r, key, expected, cart: c }
}
const payBody = (total: number, key = newKey(), c = cart()) => ({ checkoutKey: key, expectedTotalCents: total, ...c })

const prismaPromise = () => db()
const orderCount = async () => (await prismaPromise()).printOrder.count()
const attemptCount = async () => (await prismaPromise()).paymentAttempt.count()
const counts = async () => ({ orders: await orderCount(), attempts: await attemptCount(), stripeCreates: fake.state.createCalls, stripeSessions: fake.state.createdSessions })
const setOrder = async (id: string, data: Record<string, unknown>) => (await prismaPromise()).printOrder.update({ where: { id }, data: data as any })
async function reset() {
  const prisma = await prismaPromise()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, lastParams: null, allParams: [], rejectCreate: false, unreachableBeforeCreate: 0, lostAnswerAfterCreate: 0, retrieveFails: false })
  stripeCalls.length = 0
  browserA = newGuestBrowser()
  browserB = newGuestBrowser()
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  delete process.env.COOKIE_SECURE
  const prisma = await prismaPromise()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  customer = { id: (await prisma.user.create({ data: { email: 'gs-customer@sectest.invalid', passwordHash: 'x', name: 'gs-customer', role: 'customer' } })).id, role: 'customer' }
  fake = await installFakeCheckout()
  await reset()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ====================================================================================================================================
// 1. the cookie, and the answers that carry it
// ====================================================================================================================================
test('quote: a guest with no session is given one, with the strict attributes; the answer is never cached', async () => {
  await reset()
  const q = await post('quote', cart(), { browser: null })
  assert.equal(q.status, 200, q.text)
  assert.ok(q.sidHeader, 'a Set-Cookie for mw_sid')
  assert.equal(q.setCookie.filter((c) => c.startsWith('mw_sid=')).length, 1)
  assert.match(q.sidHeader!, /HttpOnly/i)
  assert.match(q.sidHeader!, /SameSite=lax/i)
  assert.match(q.sidHeader!, /Path=\//)
  assert.doesNotMatch(q.sidHeader!, /Domain=/i, 'no Domain: only this host')
  assert.doesNotMatch(q.sidHeader!, /;\s*Secure/i, 'plain http (local tests): not Secure')
  assert.equal(Number(/Max-Age=(\d+)/i.exec(q.sidHeader!)?.[1]), GUEST_SESSION_TTL_MS / 1000)
  const session = verifyGuestSession(q.sidValue)
  assert.ok(session, 'a valid, signed session')
  assert.equal(session!.hash, hashGuestSession(session!.sid))
  // never cached, by anything that reads any of the lines
  const cacheControl = q.res.headers.get('cache-control') || ''
  assert.match(cacheControl, /no-store/)
  assert.match(cacheControl, /private/)
  assert.equal(q.res.headers.get('pragma'), 'no-cache')
  assert.match(q.res.headers.get('vary') || '', /cookie/i)
  // and the session is in the Set-Cookie only: nowhere in what the page reads
  assert.ok(!q.text.includes(session!.sid), 'the session is not in the body')
  assert.ok(!q.text.includes(session!.hash))
})

test('quote: Secure wherever the site is served over https (COOKIE_SECURE), and not where it is plain http', async () => {
  await reset()
  process.env.COOKIE_SECURE = 'true'
  try {
    const secure = await post('quote', cart(), { browser: null })
    assert.match(secure.sidHeader!, /;\s*Secure/i)
    assert.match(secure.sidHeader!, /HttpOnly/i)
    // behind the proxy: the forwarded protocol decides, as for the sign-in cookie
    process.env.COOKIE_SECURE = 'false'
    const off = await post('quote', cart(), { browser: null })
    assert.doesNotMatch(off.sidHeader!, /;\s*Secure/i)
  } finally {
    delete process.env.COOKIE_SECURE
  }
})

test('quote: a young session is left alone; an old one keeps its identity and gets a new date; a forged or expired one is replaced by a new identity', async () => {
  await reset()
  const keep = await post('quote', cart(), { browser: browserA })
  assert.equal(keep.status, 200)
  assert.equal(keep.sidHeader, null, 'nothing to send for a session that is a few seconds old')

  const old = newGuestBrowserAt(new Date(Date.now() - 2 * DAY))
  const renewed = await post('quote', cart(), { browser: old })
  assert.ok(renewed.sidHeader, 'a session older than a day is renewed')
  assert.equal(verifyGuestSession(renewed.sidValue)!.hash, old.hash, 'same identity')
  assert.notEqual(renewed.sidValue, old.value)
  assert.ok(Date.now() - verifyGuestSession(renewed.sidValue)!.issuedAt.getTime() < GUEST_SESSION_RENEW_AFTER_MS)

  const expired = newGuestBrowserAt(new Date(Date.now() - 31 * DAY))
  const fresh = await post('quote', cart(), { browser: expired })
  assert.ok(fresh.sidHeader)
  assert.notEqual(verifyGuestSession(fresh.sidValue)!.hash, expired.hash, 'an expired session is not adopted: a new identity')

  const forged = { ...browserA, cookie: `${GUEST_SESSION_COOKIE}=${browserA.value.slice(0, -1)}${browserA.value.endsWith('A') ? 'B' : 'A'}` }
  const replaced = await post('quote', cart(), { browser: forged })
  assert.ok(replaced.sidHeader)
  assert.notEqual(verifyGuestSession(replaced.sidValue)!.hash, browserA.hash)
})

test('quote: answers without a quote (a bad request, a model that can not be sold) hand out no session; a signed-in customer never gets one', async () => {
  await reset()
  const bad = await post('quote', { items: [] }, { browser: null })
  assert.equal(bad.status, 400)
  assert.equal(bad.sidHeader, null)
  const missing = await post('quote', cart({ items: [{ modelId: 'clmissingmissingmissing0000', qty: 1, colors: ['#ffffff'], material: 'PLA' }] }), { browser: null })
  assert.equal(missing.status, 404)
  assert.equal(missing.sidHeader, null)
  const signedIn = await post('quote', cart(), { browser: null, viewer: customer })
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.sidHeader, null)
})

function newGuestBrowserAt(when: Date): GuestBrowser {
  const sealed = mintGuestSession(when)
  return { cookie: `${GUEST_SESSION_COOKIE}=${sealed.value}`, value: sealed.value, sid: sealed.session.sid, hash: sealed.session.hash }
}

// ====================================================================================================================================
// 2. without a valid session nothing is made (428)
// ====================================================================================================================================
test('session: with no session cookie the answer is 428 and NOTHING is made - no order, no attempt, no call to Stripe - and the browser is handed a session', async () => {
  await reset()
  const total = await quoteTotal()
  const before = await counts()
  const r = await post('session', payBody(total), { browser: null })
  assert.equal(r.status, 428, r.text)
  assert.equal(r.json.code, 'SESSION_REQUIRED')
  assert.equal(r.json.retry, true)
  assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error', 'retry'], 'and nothing else is said')
  assert.deepEqual(await counts(), before)
  assert.equal(stripeCalls.length, 0)
  assert.ok(r.sidHeader, 'the session comes with the answer')
  assert.match(r.sidHeader!, /HttpOnly/i)
  assert.match(r.sidHeader!, /SameSite=lax/i)
  assert.match(r.res.headers.get('cache-control') || '', /no-store/)
  assert.equal(r.accessHeader, null, 'and no access cookie: there is no order')

  // the repeat, now carrying that cookie, goes through: ONE order, tied to the session that was handed out
  const handed = verifyGuestSession(r.sidValue)!
  const again = await post('session', payBody(total), { browser: { cookie: `${GUEST_SESSION_COOKIE}=${r.sidValue}`, value: r.sidValue!, sid: handed.sid, hash: handed.hash } })
  assert.equal(again.status, 200, again.text)
  assert.equal(await orderCount(), 1)
  const order = await (await prismaPromise()).printOrder.findUniqueOrThrow({ where: { id: again.json.orderId } })
  assert.equal(order.guestSessionHash, handed.hash)
})

test('session: forged, altered, expired, from another secret, or in the wrong shape = no session: 428, nothing made, the bad cookie is replaced', async () => {
  await reset()
  const total = await quoteTotal()
  const valid = browserA.value
  const [v, sid, issued, mac] = valid.split('.')
  const other = (() => {
    const saveSecret = process.env.JWT_SECRET
    process.env.JWT_SECRET = 'another-secret-0123456789abcdefghijklmnop'
    try { return mintGuestSession().value } finally { process.env.JWT_SECRET = saveSecret }
  })()
  const bad: Array<[string, string]> = [
    ['mac altered', [v, sid, issued, mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA')].join('.')],
    ['sid altered', [v, sid.slice(0, -1) + (sid.endsWith('A') ? 'B' : 'A'), issued, mac].join('.')],
    ['date pushed forward', [v, sid, String(Number(issued) + 3600), mac].join('.')],
    ['mac of another session', [v, sid, issued, mintGuestSession().value.split('.')[3]].join('.')],
    ['expired', mintGuestSession(new Date(Date.now() - 31 * DAY)).value],
    ['from the future', mintGuestSession(new Date(Date.now() + 3 * 3600_000)).value],
    ['another secret', other],
    ['only the sid', sid],
    ['empty value', ''],
    ['a token of the other cookie', `${'a'.repeat(30)}.${'b'.repeat(43)}`],
    ['too long', 'v1.' + 'a'.repeat(400)],
  ]
  for (const [label, value] of bad) {
    const before = await counts()
    const r = await post('session', payBody(total), { browser: null, cookie: `${GUEST_SESSION_COOKIE}=${value}` })
    assert.equal(r.status, 428, `${label}: ${r.text}`)
    assert.equal(r.json.code, 'SESSION_REQUIRED', label)
    assert.deepEqual(await counts(), before, `${label}: nothing may be made`)
    const handed = verifyGuestSession(r.sidValue)
    assert.ok(handed, `${label}: a good session is handed out`)
    assert.notEqual(handed!.sid, sid, `${label}: the bad one is not adopted`)
  }
  assert.equal(await orderCount(), 0)
  assert.equal(stripeCalls.length, 0)
})

test('session: a browser that keeps no cookies is told so every time - never an order, never a payment page, however often it asks (no loop is possible on the server)', async () => {
  await reset()
  const total = await quoteTotal()
  for (let i = 0; i < 6; i++) {
    const r = await post('session', payBody(total, 'same-key-all-the-time-0001'), { browser: null })
    assert.equal(r.status, 428)
  }
  assert.equal(await orderCount(), 0)
  assert.equal(await attemptCount(), 0)
  assert.equal(stripeCalls.length, 0)
})

test('session: a bad request is still a bad request (400), a foreign origin is still refused (403), a blocker is still said (503): before the session is looked at', async () => {
  await reset()
  const total = await quoteTotal()
  assert.equal((await post('session', { checkoutKey: 'short', expectedTotalCents: total, ...cart() }, { browser: null })).status, 400)
  assert.equal((await post('session', payBody(total), { browser: null, origin: 'https://attacker.example' })).status, 403)
  assert.equal((await post('session', payBody(total), { browser: null, origin: null })).status, 403)
  const saveKey = process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_SECRET_KEY
  try {
    const r = await post('session', payBody(total), { browser: null })
    assert.equal(r.status, 503)
    assert.equal(r.json.code, 'PAYMENTS_NOT_CONFIGURED')
    assert.equal(r.sidHeader, null, 'no session is handed out for a payment that can not start')
  } finally {
    process.env.STRIPE_SECRET_KEY = saveKey
  }
  assert.equal(await orderCount(), 0)
})

test('session: a signed-in customer needs no session cookie and is never given one; the order is the account\'s and carries no session hash', async () => {
  await reset()
  const r = await pay({ browser: null, viewer: customer })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.sidHeader, null)
  const order = await (await prismaPromise()).printOrder.findUniqueOrThrow({ where: { id: r.json.orderId } })
  assert.equal(order.userId, customer.id)
  assert.equal(order.guestSessionHash, null)
  assert.equal(order.guestAccessTokenHash, null)
  // and a session cookie that happens to be there changes nothing for the account
  const withCookie = await pay({ browser: browserA, viewer: customer, key: r.key })
  assert.equal(withCookie.json.orderId, r.json.orderId)
  assert.equal((await (await prismaPromise()).printOrder.findUniqueOrThrow({ where: { id: r.json.orderId } })).guestSessionHash, null)
})

// ====================================================================================================================================
// 3. two guests never reach each other
// ====================================================================================================================================
test('two guests with the SAME checkout key and the same cart get two orders, two payment pages, and never the other\'s', async () => {
  await reset()
  const key = 'both-browsers-chose-this-key-0001'
  const total = await quoteTotal(cart(), { browser: browserA })
  const a = await post('session', payBody(total, key), { browser: browserA })
  const b = await post('session', payBody(total, key), { browser: browserB })
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.notEqual(a.json.orderId, b.json.orderId, 'two orders')
  assert.notEqual(a.json.url, b.json.url, 'two payment pages')
  assert.notEqual(a.json.orderNumber, b.json.orderNumber)
  assert.equal(await orderCount(), 2)
  assert.equal(fake.state.createdSessions, 2, 'Stripe was asked for two sessions')
  // each got the cookie of ITS order only
  assert.equal(parseGuestAccessCookie(a.accessValue)?.orderId, a.json.orderId)
  assert.equal(parseGuestAccessCookie(b.accessValue)?.orderId, b.json.orderId)
  assert.ok(!(b.text + (b.accessValue ?? '')).includes(a.json.orderId), 'nothing of the first order reaches the second guest')
  assert.ok(!(a.text + (a.accessValue ?? '')).includes(b.json.orderId))
  // the stored keys differ (the plain key is nowhere), each order is tied to its own session
  const prisma = await prismaPromise()
  const orderA = await prisma.printOrder.findUniqueOrThrow({ where: { id: a.json.orderId } })
  const orderB = await prisma.printOrder.findUniqueOrThrow({ where: { id: b.json.orderId } })
  assert.equal(orderA.guestSessionHash, browserA.hash)
  assert.equal(orderB.guestSessionHash, browserB.hash)
  assert.notEqual(orderA.checkoutKey, orderB.checkoutKey)
  assert.equal(orderA.checkoutKey, storedCheckoutKey({ kind: 'guest', sessionHash: browserA.hash }, key))
  assert.equal(orderB.checkoutKey, storedCheckoutKey({ kind: 'guest', sessionHash: browserB.hash }, key))
  assert.notEqual(orderA.checkoutKey, sha(`mw:checkout-key:v1:guest:${key}`), 'not the old shared namespace of every guest')
  // a repeat finds its own order again, each in its own session
  const a2 = await post('session', payBody(total, key), { browser: browserA, cookie: `${GUEST_ACCESS_COOKIE}=${a.accessValue}` })
  const b2 = await post('session', payBody(total, key), { browser: browserB, cookie: `${GUEST_ACCESS_COOKIE}=${b.accessValue}` })
  assert.equal(a2.json.orderId, a.json.orderId)
  assert.equal(b2.json.orderId, b.json.orderId)
  assert.equal(await orderCount(), 2)
})

test('the same key with ANOTHER cart: in another session it is simply that guest\'s key (two orders); in the same session it is refused (CHECKOUT_KEY_CONFLICT) and nothing is made', async () => {
  await reset()
  const key = 'both-browsers-chose-this-key-0002'
  const totalA = await quoteTotal(cart(), { browser: browserA })
  const otherCart = cart({ items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] })
  const totalB = await quoteTotal(otherCart, { browser: browserB })
  const a = await post('session', payBody(totalA, key), { browser: browserA })
  const b = await post('session', payBody(totalB, key, otherCart), { browser: browserB })
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.notEqual(a.json.orderId, b.json.orderId)
  const before = await counts()
  const clash = await post('session', payBody(totalB, key, otherCart), { browser: browserA })
  assert.equal(clash.status, 409, clash.text)
  assert.equal(clash.json.code, 'CHECKOUT_KEY_CONFLICT')
  assert.deepEqual(Object.keys(clash.json).sort(), ['code', 'error'])
  assert.deepEqual(await counts(), before)
})

test('defence in depth: a key that finds an order of ANOTHER session (or of an account, or one with no session) is refused without a word about why', async () => {
  await reset()
  const key = 'a-key-that-finds-the-wrong-order-0001'
  const first = await pay({ browser: browserA, key })
  assert.equal(first.status, 200, first.text)
  const prisma = await prismaPromise()
  const foreign = [
    { guestSessionHash: browserB.hash },
    { guestSessionHash: null },
    { userId: customer.id, guestSessionHash: null },
  ]
  for (const damage of foreign) {
    await prisma.printOrder.update({ where: { id: first.json.orderId }, data: damage as any })
    const before = await counts()
    const r = await post('session', payBody(first.expected, key), { browser: browserA })
    assert.equal(r.status, 409, `${JSON.stringify(damage)}: ${r.text}`)
    assert.equal(r.json.code, 'CHECKOUT_KEY_CONFLICT')
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error'], 'no details')
    assert.equal(r.accessHeader, null, 'and no access cookie for an order that is not this browser\'s')
    assert.deepEqual(await counts(), before)
    await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { guestSessionHash: browserA.hash, userId: null } })
  }
  assert.equal((await post('session', payBody(first.expected, key), { browser: browserA })).status, 200, 'restored: the owner is served again')
})

// ====================================================================================================================================
// 4. one purchase attempt = one order (the same browser session)
// ====================================================================================================================================
test('double click: two requests at the same moment, same session, same key = ONE order and ONE payment page', async () => {
  await reset()
  const total = await quoteTotal()
  const key = newKey()
  const [a, b] = await Promise.all([post('session', payBody(total, key)), post('session', payBody(total, key))])
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.equal(a.json.orderId, b.json.orderId)
  assert.equal(a.json.url, b.json.url)
  assert.equal(await orderCount(), 1)
  assert.equal(await attemptCount(), 1)
  assert.equal(fake.state.createdSessions, 1)
})

test('two tabs: several requests at the same moment, same session, DIFFERENT keys (localStorage not shared) = still ONE order and ONE payment page', async () => {
  await reset()
  const total = await quoteTotal()
  const replies = await Promise.all(Array.from({ length: 6 }, () => post('session', payBody(total, newKey()))))
  for (const r of replies) assert.equal(r.status, 200, r.text)
  assert.equal(new Set(replies.map((r) => r.json.orderId)).size, 1, 'one order')
  assert.equal(new Set(replies.map((r) => r.json.url)).size, 1, 'one payment page')
  assert.equal(await orderCount(), 1)
  assert.equal(await attemptCount(), 1)
  assert.equal(fake.state.createdSessions, 1, 'and Stripe was asked for ONE session')
  const order = await (await prismaPromise()).printOrder.findFirstOrThrow()
  assert.equal(order.guestSessionHash, browserA.hash)
})

test('a second request with another key, a moment later (the key was lost): the same order and the same payment page', async () => {
  await reset()
  const first = await pay()
  const second = await pay({ key: newKey() })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json.orderId, first.json.orderId)
  assert.equal(second.json.url, first.json.url)
  assert.equal(await orderCount(), 1)
  assert.equal(fake.state.createdSessions, 1)
  // paying the same things AGAIN once the first purchase is over is a new purchase: a paid order does not swallow the next one
  const prisma = await prismaPromise()
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date() } })
  const next = await pay({ key: newKey() })
  assert.equal(next.status, 200, next.text)
  assert.notEqual(next.json.orderId, first.json.orderId)
})

test('requests at the same moment from two DIFFERENT guests, same cart, are two purchases: two orders (never merged by what is in the cart)', async () => {
  await reset()
  const totalA = await quoteTotal(cart(), { browser: browserA })
  const [a, b] = await Promise.all([post('session', payBody(totalA, newKey()), { browser: browserA }), post('session', payBody(totalA, newKey()), { browser: browserB })])
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.notEqual(a.json.orderId, b.json.orderId)
  assert.equal(await orderCount(), 2)
  assert.equal(fake.state.createdSessions, 2)
})

test('requests at the same moment with no session at all: all 428, nothing made', async () => {
  await reset()
  const total = await quoteTotal()
  const replies = await Promise.all(Array.from({ length: 8 }, () => post('session', payBody(total, newKey()), { browser: null })))
  for (const r of replies) assert.equal(r.status, 428)
  assert.deepEqual(await counts(), { orders: 0, attempts: 0, stripeCreates: 0, stripeSessions: 0 })
})

test('the same cart with another delivery or another total shown is another purchase attempt: the session does not merge it', async () => {
  await reset()
  const pickup = await pay()
  const ship = await pay({ cartOver: { shipping: { method: 'ship' } } })
  assert.equal(pickup.status, 200, pickup.text)
  assert.equal(ship.status, 200, ship.text)
  assert.notEqual(ship.json.orderId, pickup.json.orderId)
  assert.equal(await orderCount(), 2)
})

test('RESIDUO R1 (not closed): two FIRST requests that were handed DIFFERENT new sessions cannot know each other - two orders. Written down so that a future closing of R1 must change this test', async () => {
  await reset()
  const total = await quoteTotal()
  // what two tabs of a browser with an empty cookie jar get when both ask at the very same moment: each a session of its own, the browser keeps one
  const tabOne = newGuestBrowser()
  const tabTwo = newGuestBrowser()
  const [a, b] = await Promise.all([post('session', payBody(total, newKey()), { browser: tabOne }), post('session', payBody(total, newKey()), { browser: tabTwo })])
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.notEqual(a.json.orderId, b.json.orderId, 'R1: with two different sessions the server can not tell that it is one browser')
  assert.equal(await orderCount(), 2)
  // what holds all the same: once the browser keeps ONE session (the one it kept), every later attempt is the same purchase again
  const later = await post('session', payBody(total, newKey()), { browser: tabOne })
  assert.equal(later.json.orderId, a.json.orderId)
  assert.equal(await orderCount(), 2)
})

// The tests above let requests race by chance; here every request is HELD inside the lock for a while, so that they certainly meet at it: what decides is the
// lock, not the timing.
async function heldInside<T>(ms: number, body: () => Promise<T>) {
  let inside = 0
  let most = 0
  checkoutOrderHooks.afterLock = async () => {
    inside += 1
    most = Math.max(most, inside)
    await new Promise((resolve) => setTimeout(resolve, ms))
    inside -= 1
  }
  try { return { value: await body(), most: () => most } } finally { checkoutOrderHooks.afterLock = null }
}

test('made certain: with every request held inside the lock, six requests of one session (six keys) are still ONE order - and they went through the lock one at a time', async () => {
  await reset()
  const total = await quoteTotal()
  const { value: replies, most } = await heldInside(60, () => Promise.all(Array.from({ length: 6 }, () => post('session', payBody(total, newKey())))))
  for (const r of replies) assert.equal(r.status, 200, r.text)
  assert.equal(new Set(replies.map((r) => r.json.orderId)).size, 1)
  assert.equal(await orderCount(), 1)
  assert.equal(fake.state.createdSessions, 1)
  assert.equal(most(), 1, 'never two requests of the same session inside the lock together')
})

test('made certain: guests do not wait for each other - two sessions are inside at the same time, and make two orders', async () => {
  await reset()
  const total = await quoteTotal()
  const { value: replies, most } = await heldInside(300, () => Promise.all([
    post('session', payBody(total, newKey()), { browser: browserA }),
    post('session', payBody(total, newKey()), { browser: browserB }),
  ]))
  for (const r of replies) assert.equal(r.status, 200, r.text)
  assert.notEqual(replies[0].json.orderId, replies[1].json.orderId)
  assert.equal(most(), 2, 'one guest\'s purchase never holds up another\'s')
})

test('made certain, for an account: with every request held inside the lock, six requests (six keys) are ONE order, one at a time - as before the guest session existed', async () => {
  await reset()
  const total = await quoteTotal(cart(), { viewer: customer, browser: null })
  const { value: replies, most } = await heldInside(60, () => Promise.all(Array.from({ length: 6 }, () => post('session', payBody(total, newKey()), { viewer: customer, browser: null }))))
  for (const r of replies) assert.equal(r.status, 200, r.text)
  assert.equal(new Set(replies.map((r) => r.json.orderId)).size, 1)
  assert.equal(await orderCount(), 1)
  assert.equal(most(), 1)
})

// ====================================================================================================================================
// 5. a payment in doubt: refused, and never named to a browser that is only known by its session
// ====================================================================================================================================
test('a payment being confirmed for this cart blocks the same browser session with ANY key - and the refusal names no order when only the session recognised it', async () => {
  await reset()
  const first = await pay()
  assert.equal(first.status, 200, first.text)
  await setOrder(first.json.orderId, { paymentStatus: 'processing' })
  const before = await counts()

  // only the session (the access cookie is gone, the key is new)
  const bySession = await post('session', payBody(first.expected, newKey()))
  assert.equal(bySession.status, 409, bySession.text)
  assert.equal(bySession.json.code, 'PAYMENT_IN_PROGRESS')
  assert.deepEqual(Object.keys(bySession.json).sort(), ['code', 'error'], 'no order id, no order number, nothing')
  assert.ok(!bySession.text.includes(first.json.orderId))
  assert.ok(!bySession.text.includes(String(first.json.orderNumber)) || String(first.json.orderNumber).length < 2)
  assert.equal(bySession.accessHeader, null)
  assert.deepEqual(await counts(), before)

  // the session AND the access cookie of the order: the order's own owner is told which order, as before
  const withAccess = await post('session', payBody(first.expected, newKey()), { cookie: `${GUEST_ACCESS_COOKIE}=${first.accessValue}` })
  assert.equal(withAccess.status, 409, withAccess.text)
  assert.deepEqual(Object.keys(withAccess.json).sort(), ['code', 'error', 'orderId', 'orderNumber'])
  assert.equal(withAccess.json.orderId, first.json.orderId)

  // another browser (another customer) with the same cart is not blocked: it is not the same purchase
  const other = await post('session', payBody(first.expected, newKey()), { browser: browserB })
  assert.equal(other.status, 200, other.text)
  assert.notEqual(other.json.orderId, first.json.orderId)

  // and a payment being confirmed is NOT the browser's to learn by guessing: a forged access cookie from another browser reveals and reuses nothing
  const forged = await post('session', payBody(first.expected, newKey()), { browser: newGuestBrowser(), cookie: `${GUEST_ACCESS_COOKIE}=${first.json.orderId}.${'A'.repeat(43)}` })
  assert.equal(forged.status, 200, forged.text)
  assert.notEqual(forged.json.orderId, first.json.orderId)
})

test('a payment that arrived and waits for a person (paid + review) blocks the same session too, without naming the order', async () => {
  await reset()
  const first = await pay()
  await setOrder(first.json.orderId, { paymentStatus: 'paid', status: 'awaiting_review', paymentReviewReason: 'amount_mismatch', paidAt: new Date() })
  const second = await post('session', payBody(first.expected, newKey()))
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.code, 'PAYMENT_IN_PROGRESS')
  assert.deepEqual(Object.keys(second.json).sort(), ['code', 'error'])
  assert.equal(await orderCount(), 1)
})

// ====================================================================================================================================
// 6. network errors and repeated requests
// ====================================================================================================================================
test('Stripe unreachable, then the same request again: the same order, and Stripe is asked for ONE session in the end', async () => {
  await reset()
  const total = await quoteTotal()
  const key = newKey()
  fake.state.unreachableBeforeCreate = 1
  const failed = await post('session', payBody(total, key))
  assert.ok(failed.status >= 500 || failed.status === 503 || failed.status === 502, `got ${failed.status}: ${failed.text}`)
  assert.equal(await orderCount(), 1, 'the order exists: it waits for its payment page')
  const again = await post('session', payBody(total, key))
  assert.equal(again.status, 200, again.text)
  assert.equal(await orderCount(), 1)
  assert.equal(fake.state.createdSessions, 1)
  // even with a new key (the response never reached the browser, the key was lost with it): the same order again
  const third = await post('session', payBody(total, newKey()))
  assert.equal(third.status, 200, third.text)
  assert.equal(third.json.orderId, again.json.orderId)
  assert.equal(await orderCount(), 1)
})

test('the answer is lost after Stripe made the page: the repeat gets the SAME page (idempotency key), not a second one', async () => {
  await reset()
  const total = await quoteTotal()
  const key = newKey()
  fake.state.lostAnswerAfterCreate = 1
  const lost = await post('session', payBody(total, key))
  assert.notEqual(lost.status, 200)
  const again = await post('session', payBody(total, key))
  assert.equal(again.status, 200, again.text)
  assert.equal(fake.state.createdSessions, 1, 'Stripe made ONE session for the two calls')
  assert.equal(await orderCount(), 1)
})

test('R2 (written down): the session cookie is lost between two attempts - without the access cookie a second order is made; with it, the first order is reused', async () => {
  await reset()
  const first = await pay({ browser: browserA })
  assert.equal(first.status, 200, first.text)
  // the browser forgot the session cookie AND the access cookie: a new browser as far as the server can tell
  const lost = await post('session', payBody(first.expected, first.key), { browser: browserB })
  assert.equal(lost.status, 200, lost.text)
  assert.notEqual(lost.json.orderId, first.json.orderId, 'R2: nothing links the new session to the old order')
  // the browser lost only the session cookie but still holds the access cookie of the order (valid 72 h): the earlier unpaid order is found and reused
  await reset()
  const kept = await pay({ browser: browserA })
  const newSession = await post('session', payBody(kept.expected, newKey()), { browser: browserB, cookie: `${GUEST_ACCESS_COOKIE}=${kept.accessValue}` })
  assert.equal(newSession.status, 200, newSession.text)
  assert.equal(newSession.json.orderId, kept.json.orderId)
  assert.equal(await orderCount(), 1)
})

// ====================================================================================================================================
// 7. the session is NEVER an authorization
// ====================================================================================================================================
test('a session cookie alone opens nothing: not the status of an order, not the order API, not a file, not the messages - not even of the order it made', async () => {
  await reset()
  const first = await pay()
  assert.equal(first.status, 200, first.text)
  const orderId = first.json.orderId as string
  const onlySession = { cookie: browserA.cookie }

  const status = await import('../../app/api/checkout/status/route')
  viewerGuards.getViewer = async () => null
  const st = (await (status.GET as any)(new NextRequest(`http://localhost/api/checkout/status?order=${orderId}`, { headers: { ...onlySession, 'x-forwarded-for': nextIp() } }), {})) as Response
  assert.equal(st.status, 404, 'the status page needs the access cookie of the order')
  const withAccess = (await (status.GET as any)(new NextRequest(`http://localhost/api/checkout/status?order=${orderId}`, { headers: { cookie: `${browserA.cookie}; ${GUEST_ACCESS_COOKIE}=${first.accessValue}`, 'x-forwarded-for': nextIp() } }), {})) as Response
  assert.equal(withAccess.status, 200, 'with the access cookie it opens (unchanged)')

  const detail = await import('../../app/api/customer/orders/[orderId]/route')
  const d = await (detail.GET as any)(new NextRequest(`http://localhost/api/customer/orders/${orderId}`, { headers: onlySession }), { params: Promise.resolve({ orderId }) })
  assert.ok([401, 403, 404].includes(d.status), `order API answered ${d.status}`)
  const messages = await import('../../app/api/customer/orders/[orderId]/messages/route')
  const m = await (messages.POST as any)(new NextRequest(`http://localhost/api/customer/orders/${orderId}/messages`, {
    method: 'POST', headers: { ...onlySession, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello' }),
  }), { params: Promise.resolve({ orderId }) })
  assert.ok([401, 403, 404].includes(m.status), `messages API answered ${m.status}`)
  const list = await import('../../app/api/customer/orders/route')
  const l = await (list.GET as any)(new NextRequest('http://localhost/api/customer/orders', { headers: onlySession }), {})
  assert.ok([401, 403].includes(l.status), `orders list answered ${l.status}`)
})

test('another guest\'s session (even a copy of it) opens no order, and the session itself is only ever read by the two checkout routes', async () => {
  await reset()
  const first = await pay()
  // somebody holding a COPY of the session, with another key, another cart: nothing of the order comes back
  const copy = await post('session', payBody(await quoteTotal(cart({ items: [{ modelId, qty: 5, colors: ['#ffffff'], material: 'PLA' }] })), newKey(), cart({ items: [{ modelId, qty: 5, colors: ['#ffffff'], material: 'PLA' }] })), { browser: browserA })
  assert.equal(copy.status, 200, copy.text)
  assert.notEqual(copy.json.orderId, first.json.orderId)
  assert.ok(!copy.text.includes(first.json.orderId))
  // the only source files that read the cookie
  const root = path.resolve(__dirname, '../..')
  const readers: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.git', 'tests', 'docs', 'public', 'prisma'].includes(entry)) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      // (an import of the module, the cookie's name as text, or its constant: a comment that names the file does not read the cookie)
      else if (/\.(ts|tsx|js|mjs)$/.test(entry) && /from\s+['"][^'"]*guest-session['"]|['"]mw_sid['"]|GUEST_SESSION_COOKIE/.test(readFileSync(full, 'utf8'))) readers.push(path.relative(root, full).replace(/\\/g, '/'))
    }
  }
  for (const dir of ['app', 'lib', 'components', 'scripts']) walk(path.join(root, dir))
  assert.deepEqual(readers.sort(), ['app/api/checkout/quote/route.ts', 'app/api/checkout/session/route.ts', 'lib/guest-session.ts'])
})

// ====================================================================================================================================
// 8. what is stored, and what is not
// ====================================================================================================================================
test('the order stores a hash of the session, from the moment it exists; the session itself is nowhere - not in the database, not at Stripe, not in a counter', async () => {
  await reset()
  const first = await pay()
  assert.equal(first.status, 200, first.text)
  const prisma = await prismaPromise()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: first.json.orderId } })
  assert.equal(order.guestSessionHash, hashGuestSession(browserA.sid))
  assert.equal(order.guestSessionHash, sha(`mw:guest-session:hash:v1:${browserA.sid}`))
  // every guest order made through the route has one (none was ever written without it)
  assert.equal(await prisma.printOrder.count({ where: { userId: null, checkoutKey: { not: null }, guestSessionHash: null } }), 0)
  const everything = JSON.stringify([
    await prisma.printOrder.findMany({ include: { items: true } }),
    await prisma.paymentAttempt.findMany(),
    await prisma.stripeEvent.findMany(),
    await prisma.rateLimit.findMany(),
  ])
  assert.ok(!everything.includes(browserA.sid), 'the session (the random part) is never stored')
  assert.ok(!everything.includes(browserA.value), 'nor the cookie value')
  assert.ok(!JSON.stringify(fake.state.allParams).includes(browserA.sid), 'Stripe never receives it')
  assert.ok(!JSON.stringify(fake.state.allParams).includes(browserA.hash), 'nor its hash')
  // the counters are kept under the hash
  assert.ok((await prisma.rateLimit.findMany()).some((row) => row.key.includes(browserA.hash)), 'a per-session counter exists, named by the hash')
})

test('limits count per session as well as per address: one browser can not spend the budget of others, and a new address does not give it a new one', async () => {
  await reset()
  const saveMax = process.env.CHECKOUT_SESSION_RATE_MAX
  process.env.CHECKOUT_SESSION_RATE_MAX = '3'
  try {
    const total = await quoteTotal()
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await post('session', payBody(total, newKey()), { browser: browserA, ip: `203.0.113.${10 + i}` })).status)
    assert.deepEqual(statuses, [200, 200, 200, 429, 429], 'from five different addresses, the same browser session is capped')
    assert.equal(await orderCount(), 1, 'and the capped requests made nothing (all the same purchase anyway)')
    const other = await post('session', payBody(total, newKey()), { browser: browserB, ip: '203.0.113.99' })
    assert.equal(other.status, 200, 'another browser is not affected')
  } finally {
    if (saveMax === undefined) delete process.env.CHECKOUT_SESSION_RATE_MAX
    else process.env.CHECKOUT_SESSION_RATE_MAX = saveMax
  }
})

test('every answer of the two routes - success, 428, 409, 400, 403, 429 - is private and never cached', async () => {
  await reset()
  const total = await quoteTotal()
  const checks: Reply[] = []
  checks.push(await post('quote', cart(), { browser: null }))
  checks.push(await post('quote', { items: [] }))
  checks.push(await post('session', payBody(total), { browser: null }))
  checks.push(await post('session', payBody(total, 'x')))
  checks.push(await post('session', payBody(total), { origin: 'https://attacker.example' }))
  const ok = await post('session', payBody(total))
  checks.push(ok)
  await setOrder(ok.json.orderId, { paymentStatus: 'processing' })
  checks.push(await post('session', payBody(total, newKey())))
  const saveMax = process.env.CHECKOUT_SESSION_RATE_MAX
  process.env.CHECKOUT_SESSION_RATE_MAX = '1'
  try {
    await post('session', payBody(total), { browser: browserB })
    checks.push(await post('session', payBody(total), { browser: browserB }))
  } finally {
    if (saveMax === undefined) delete process.env.CHECKOUT_SESSION_RATE_MAX
    else process.env.CHECKOUT_SESSION_RATE_MAX = saveMax
  }
  assert.deepEqual(checks.map((c) => c.status), [200, 400, 428, 400, 403, 200, 409, 429])
  for (const c of checks) {
    assert.match(c.res.headers.get('cache-control') || '', /no-store/, `${c.status}`)
    assert.match(c.res.headers.get('cache-control') || '', /private/, `${c.status}`)
    assert.match(c.res.headers.get('vary') || '', /cookie/i, `${c.status}`)
  }
})

test('the economics do not move: the quote, the order and what Stripe is asked to collect are the same figure, for a guest with a session as for an account', async () => {
  await reset()
  for (const variant of [{}, { shipping: { method: 'ship' } }, { items: [{ modelId, qty: 5, colors: ['#ffffff'], material: 'PLA' }] }] as Array<Record<string, unknown>>) {
    const guest = await pay({ cartOver: variant, browser: newGuestBrowser() })
    const account = await pay({ cartOver: variant, viewer: customer, browser: null })
    assert.equal(guest.status, 200, guest.text)
    assert.equal(account.status, 200, account.text)
    const prisma = await prismaPromise()
    const guestOrder = await prisma.printOrder.findUniqueOrThrow({ where: { id: guest.json.orderId } })
    const accountOrder = await prisma.printOrder.findUniqueOrThrow({ where: { id: account.json.orderId } })
    assert.equal(guest.expected, account.expected)
    assert.equal(guestOrder.totalCents, guest.expected)
    assert.equal(accountOrder.totalCents, account.expected)
    assert.equal(guest.json.totalCents, guest.expected)
    const stripeTotal = (params: any) => params.line_items.reduce((sum: number, line: any) => sum + line.price_data.unit_amount * line.quantity, 0)
    const guestParams = fake.state.allParams.find((p) => p.client_reference_id === guest.json.orderId)
    const accountParams = fake.state.allParams.find((p) => p.client_reference_id === account.json.orderId)
    assert.equal(stripeTotal(guestParams), guest.expected)
    assert.equal(stripeTotal(accountParams), account.expected)
    // a guest's payment page and an account's differ in who is known to Stripe, not in what is charged
    assert.deepEqual(guestParams.line_items, accountParams.line_items)
  }
})

test('"pay" keeps a session in use alive: an old session gets a new date with the SAME identity, a young one is left alone', async () => {
  await reset()
  const old = newGuestBrowserAt(new Date(Date.now() - 2 * DAY))
  const total = await quoteTotal(cart(), { browser: old })
  const first = await post('session', payBody(total), { browser: old })
  assert.equal(first.status, 200, first.text)
  assert.ok(first.sidHeader, 'a session older than a day is renewed by "pay" as well')
  assert.equal(verifyGuestSession(first.sidValue)!.hash, old.hash, 'same identity: the order is tied to it')
  assert.ok(Date.now() - verifyGuestSession(first.sidValue)!.issuedAt.getTime() < GUEST_SESSION_RENEW_AFTER_MS)
  assert.equal((await (await prismaPromise()).printOrder.findUniqueOrThrow({ where: { id: first.json.orderId } })).guestSessionHash, old.hash)
  const young = await post('session', payBody(total, newKey()), { browser: browserA })
  assert.equal(young.status, 200, young.text)
  assert.equal(young.sidHeader, null, 'nothing to send for a young session')
})

test('the order layer has the rule too, not only the route: a guest order can not be created without a session (nothing is written)', async () => {
  await reset()
  viewerGuards.getViewer = async () => null
  const items = cart().items as any
  const quote = await buildCardQuote({ items, shippingMethod: 'pickup', rush: false, publicBaseUrl: null })
  const before = await orderCount()
  for (const missing of [undefined, null, '']) {
    await assert.rejects(
      () => createPendingCardOrder({ storedKey: sha(`direct-${String(missing)}`), fingerprint: 'f'.repeat(64), cartFingerprint: 'c'.repeat(64), guestSessionHash: missing as any, quote, items, rush: false }),
      /guest session/,
    )
  }
  assert.equal(await orderCount(), before)
  // and with a session it works, and the hash is on the order from the first moment
  const made = await createPendingCardOrder({ storedKey: sha('direct-ok'), fingerprint: 'f'.repeat(64), cartFingerprint: 'c'.repeat(64), guestSessionHash: browserA.hash, quote, items, rush: false })
  assert.equal(made.created, true)
  assert.equal(made.order.guestSessionHash, browserA.hash)
})
