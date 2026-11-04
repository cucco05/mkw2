// The kit the DR-13 tests share (phase 1): a customer's browser calling the REAL routes (quote, session, status, webhook), the faithful stand-in for Stripe (tests/security/_stripe-sim.ts) and
// the monitor that judges every scenario on what the stand-in really holds. Import './_harness' FIRST in the test file (it sets the environment).
//
// The invariants a scenario is judged by (docs: DR-13 plan, REVISIONE 1, C3):
//   V1  no order ever has more than ONE payable session at the provider                         (recorded by the stand-in at every mutation, in every process)
//   V2  a page is HANDED OUT only if it is registered on a live attempt of the order            (I-1)
//   V3  at most one page that was handed out is still payable                                  (I-2)
//   V4  a page is never handed out for an order that is not payable (paid, being confirmed, cancelled, under review, with an attempt that is paid / confirming / mismatch)
// "every payable session is known to the database" is NOT an invariant: between the provider's `create` and the database write a session unknown to the database exists, and that is
// accepted - what is not accepted is handing it out, or opening a second one next to it (V1, V2).
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { db, resetDb, seedShopModel } from './_harness'
import { strongTestKey } from './_keys'
import { guestHeaders, newGuestBrowser, type GuestBrowser } from './_guest'
import { StripeSim } from './_stripe-sim'
import { clock, coherentCreatedAt } from './_clock'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { effectHooks } from '../../lib/order-effects'
import { GUEST_ACCESS_COOKIE } from '../../lib/guest-order-access'
import { pageJobsSettled } from '../../lib/checkout-pages'
import { allowLegacyTwins, restoreLivePageIndex } from './_live-page-index'

// the same baseline the repository's step-3 suite uses
Object.assign(process.env, {
  CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', PAYMENT_SYNC_MAX_WAIT_MS: '3000',
  CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000', CHECKOUT_STATUS_RATE_MAX: '1000000',
})
for (const k of ['TAX_MODE', 'TAX_RATE_PERCENT', 'HOSTED_CHECKOUT_ENABLED', 'LEGACY_CARD_CHECKOUT_ENABLED']) delete (process.env as any)[k]

export type Who = { browser?: GuestBrowser; viewer?: Viewer; cookie?: string }
export type Started = { key: string; cart: any; total: number; orderId: string; attemptId: string; sessionId: string; url: string; accessCookie: string | null; who: Who; status: number; json: any }

export const SESSION_TTL_MS = 32 * 60_000
const HOUR = 3_600_000

export async function bootKit() {
  await resetDb()
  const prisma = await db()
  coherentCreatedAt(prisma as any)
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  const customer = await prisma.user.create({ data: { email: 'dr13kit@sectest.invalid', passwordHash: 'x', name: 'dr13kit', role: 'customer' } })
  const modelId = (await seedShopModel()).model.id
  const sim = new StripeSim()
  const stripe = await sim.install()

  // ---- the outside services after a payment: counted, never called ---------------------------------------------------------------------------------------------------
  const effects = { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 }
  const original = { ...effectHooks }
  const installSpies = () => {
    Object.assign(effectHooks, original)
    effectHooks.printLabConfigured = (() => true) as any
    effectHooks.submitToPrintLab = (async () => { effects.printlab++; return { ok: true, submitted: [], errors: [] } }) as any
    effectHooks.notifyDiscord = (async () => { effects.discord++; return true }) as any
    effectHooks.notifyPush = (async () => { effects.push++; return true }) as any
    effectHooks.consumeInventory = (async () => { effects.inventory++; return { ok: true, movements: 0 } }) as any
    effectHooks.receipt = (async (id: string) => { effects.receipt++; return original.receipt(id) }) as any
  }

  // ---- calling the endpoints as a browser would -------------------------------------------------------------------------------------------------------------------------
  // What the code under test starts AFTER its answer (the closing of the other pages of an order, the verification of a page found paid) belongs to the call that started it: a call of the kit
  // returns when that has ended too, so that the next assertion looks at a settled world. A call made from inside another (a hook of the stand-in announcing an expiry while a request is
  // going on) does not wait: it would be waiting for something that waits for it.
  let depth = 0
  async function settled<T>(call: () => Promise<T>): Promise<T> {
    depth++
    try { return await call() } finally { depth--; if (depth === 0) await pageJobsSettled() }
  }
  let ipSeq = 0
  const nextIp = () => `10.13.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}`
  const viewerOf = (who: Who) => who.viewer ?? null
  const post = (route: 'quote' | 'session', body: unknown, who: Who = {}) => settled(() => postNow(route, body, who))
  async function postNow(route: 'quote' | 'session', body: unknown, who: Who) {
    viewerGuards.getViewer = async () => viewerOf(who)
    const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
    const request = new NextRequest(`http://localhost/api/checkout/${route}`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders(who.cookie ? { cookie: who.cookie } : {}, who.browser) },
      body: JSON.stringify(body),
    })
    const res = (await (mod.POST as any)(request, {})) as Response
    const text = await res.clone().text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? []
    return { res, status: res.status, json, text, setCookies }
  }
  const getStatus = (orderId: string, who: Who = {}, returned = false) => settled(() => getStatusNow(orderId, who, returned))
  async function getStatusNow(orderId: string, who: Who, returned: boolean) {
    viewerGuards.getViewer = async () => viewerOf(who)
    const { GET } = await import('../../app/api/checkout/status/route')
    const request = new NextRequest(`http://localhost/api/checkout/status?order=${orderId}${returned ? '&return=1' : ''}`, {
      headers: { 'x-forwarded-for': nextIp(), ...guestHeaders(who.cookie ? { cookie: who.cookie } : {}, who.browser) },
    })
    const res = (await (GET as any)(request, {})) as Response
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const cart = (over: Record<string, unknown> = {}) => ({ items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' as const }, rush: false, ...over })
  let keySeq = 0
  const newKey = (label = 'k') => strongTestKey(`dr13-${label}-${process.pid}-${++keySeq}`)
  const sessionIdOf = (url: string | null | undefined) => (url ? /\/(cs_[A-Za-z0-9_]+)$/.exec(url)?.[1] ?? null : null)

  // ---- the monitor, on the test's side of the line ---------------------------------------------------------------------------------------------------------------------
  const problems: string[] = []
  // `observe` judges a page at the moment it looks at it, which is right when one request is going on at a time. A test with SEVERAL actors acting at once (the seeded interleavings) says
  // `strict = false`: a page that was handed out may legitimately be closed, or the order paid, a moment later, so the state of the attempt and of the order is judged by that test at
  // the moment of the decision (it reads the order under the lock) and not here.
  const observing = { strict: true }
  async function orderIsPayable(orderId: string) {
    const o = await prisma.printOrder.findUnique({ where: { id: orderId }, include: { paymentAttempts: true } })
    if (!o) return 'the order does not exist'
    if (['paid', 'free'].includes(o.paymentStatus)) return `paymentStatus ${o.paymentStatus}`
    if (o.paymentStatus === 'processing') return 'paymentStatus processing'
    if (o.status !== 'awaiting_payment') return `status ${o.status}`
    if (o.paymentReviewReason) return `under review (${o.paymentReviewReason})`
    const bad = o.paymentAttempts.find((a) => ['paid', 'processing', 'mismatch'].includes(a.status))
    return bad ? `an attempt is ${bad.status}` : null
  }
  // call this on EVERY answer of the session route (and of anything that hands a page out)
  async function observe(orderId: string, res: { status: number; json: any }, via = 'session') {
    if (res.status !== 200) return null
    const sessionId = sessionIdOf(res.json?.url)
    if (!sessionId) { problems.push(`a 200 answer without a page for ${orderId}`); return null }
    await sim.recordDelivery(orderId, sessionId, via)
    const attempt = await prisma.paymentAttempt.findFirst({ where: { stripeSessionId: sessionId } })
    if (!attempt) problems.push(`V2 handed out ${sessionId} which no attempt of the database holds`)
    else if (attempt.orderId !== orderId) problems.push(`V2 handed out ${sessionId} which belongs to another order`)
    else if (observing.strict && attempt.status !== 'open') problems.push(`V2 handed out ${sessionId} while its attempt is "${attempt.status}"`)
    const why = observing.strict ? await orderIsPayable(orderId) : null
    if (why) problems.push(`V4 handed out ${sessionId} for an order that is not payable (${why})`)
    const delivered = await sim.deliveries(orderId)
    const payable = new Set(await sim.payable(orderId))
    const live = delivered.filter((id) => payable.has(id))
    if (live.length > 1) problems.push(`V3 ${live.length} pages that were handed out are payable: ${live.join(', ')}`)
    return sessionId
  }
  async function assertClean(label = '') {
    const found = await sim.violations()
    const messages = [...problems.map((p) => `[${label}] ${p}`), ...found.map((v) => `[${label}] provider ${v.kind} ${JSON.stringify(v.detail)}`)]
    assert.deepEqual(messages, [], `the invariants were violated:\n  ${messages.join('\n  ')}`)
  }

  // ---- a checkout, exactly as the browser does it -------------------------------------------------------------------------------------------------------------------------
  async function startCheckout(who: Who, o: { key?: string; allowFailure?: boolean } = {}): Promise<Started> {
    const c = cart()
    const quote = await post('quote', c, who)
    assert.equal(quote.status, 200, quote.text)
    const key = o.key ?? newKey()
    const r = await post('session', { checkoutKey: key, expectedTotalCents: quote.json.totalCents, ...c }, who)
    if (!o.allowFailure) assert.equal(r.status, 200, r.text)
    const attempt = r.json?.orderId ? await prisma.paymentAttempt.findFirst({ where: { orderId: r.json.orderId }, orderBy: { createdAt: 'desc' } }) : null
    const access = r.setCookies.find((cookie) => cookie.startsWith(`${GUEST_ACCESS_COOKIE}=`))?.split(';')[0] ?? null
    const started: Started = { key, cart: c, total: quote.json.totalCents, orderId: r.json?.orderId, attemptId: attempt?.id as string, sessionId: attempt?.stripeSessionId as string, url: r.json?.url, accessCookie: access, who, status: r.status, json: r.json }
    if (started.orderId) await observe(started.orderId, r)
    return started
  }
  // the customer presses "Pay" again with the same key (a reload, another tab, a retry after a lost answer)
  async function payAgain(s: Started, who: Who = s.who, key: string = s.key) {
    const r = await post('session', { checkoutKey: key, expectedTotalCents: s.total, ...s.cart }, who)
    const orderId = r.json?.orderId ?? s.orderId
    if (orderId) await observe(orderId, r)
    return r
  }

  // ---- webhooks --------------------------------------------------------------------------------------------------------------------------------------------------------
  const deliver = (event: Record<string, unknown>) => settled(() => deliverNow(event))
  async function deliverNow(event: Record<string, unknown>) {
    const { POST } = await import('../../app/api/stripe/webhook/route')
    const payload = JSON.stringify(event)
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string })
    const res = (await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload }), {})) as Response
    const text = await res.text()
    let json: any = {}
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json }
  }
  async function customerPays(sessionId: string, over: Parameters<StripeSim['pay']>[1] = {}) {
    const paid = await sim.pay(sessionId, over)
    const delivered = paid.paid ? await deliver(await sim.sessionEvent('checkout.session.completed', sessionId)) : null
    return { ...paid, delivered }
  }
  // the provider closes the page at its `expires_at` (naturally) and says so: time passes (the clock moves; no row is edited), then the announcement arrives
  async function expireNaturally(sessionId: string, announce = true) {
    const [row] = (await sim.sessionsOf((await sim.orderOfSession(sessionId)) as string)).filter((s) => s.id === sessionId)
    clock.shift(Math.max(0, (row?.expiresInS ?? 0) * 1000) + 2000)
    await sim.retrieve(sessionId) // looking at it is what moves it to "expired" in the stand-in
    return announce ? deliver(await sim.sessionEvent('checkout.session.expired', sessionId)) : null
  }
  // time passes
  const travel = async (ms: number) => { clock.shift(ms) }
  // a page that was closed EARLY (by an operator, or by our own `expire`) and the provider's announcement of it
  async function announceExpired(sessionId: string) { return deliver(await sim.sessionEvent('checkout.session.expired', sessionId)) }

  // ---- time travel: the rows are moved, the clock is not -----------------------------------------------------------------------------------------------------------------
  // The attempt is `ageMs` old and its page has `expiresInMs` left (both at the database and at the provider)
  async function setAttemptTimes(attemptId: string, o: { ageMs?: number; expiresInMs?: number; sessionId?: string | null }) {
    const data: Record<string, Date> = {}
    if (o.ageMs !== undefined) data.createdAt = new Date(Date.now() - o.ageMs)
    if (o.expiresInMs !== undefined) data.expiresAt = new Date(Date.now() + o.expiresInMs)
    if (Object.keys(data).length) await prisma.paymentAttempt.update({ where: { id: attemptId }, data })
    if (o.expiresInMs !== undefined && o.sessionId) await sim.expiresIn(o.sessionId, o.expiresInMs)
  }
  async function snapshot(orderId: string) {
    const o = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: { orderBy: { createdAt: 'asc' } } } })
    return {
      order: { status: o.status, paymentStatus: o.paymentStatus, review: o.paymentReviewReason, revision: o.financialRevision, cancellation: (o.metadata as any)?.cancellation?.reason ?? null },
      attempts: o.paymentAttempts.map((a) => ({ id: a.id, status: a.status, session: a.stripeSessionId, failure: a.failureReason, ageS: Math.round((Date.now() - a.createdAt.getTime()) / 1000), expiresInS: Math.round((a.expiresAt.getTime() - Date.now()) / 1000) })),
      sessions: await sim.sessionsOf(orderId),
      payable: await sim.payable(orderId),
      effects: { ...effects },
    }
  }
  async function fresh() {
    await prisma.refundOperation.deleteMany()
    await prisma.paymentAttempt.deleteMany()
    await prisma.printOrder.deleteMany()
    await prisma.stripeEvent.deleteMany()
    await prisma.rateLimit.deleteMany()
    await restoreLivePageIndex(prisma) // (a test that modelled data made before DR-13 took the index away)
    clock.reset()
    await sim.reset()
    Object.assign(effects, { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 })
    problems.length = 0
    observing.strict = true
    installSpies()
  }
  async function waitFor<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 4000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await read()
      if (ok(value) || Date.now() > deadline) return value
      await new Promise((resolve) => setTimeout(resolve, 40))
      void what
    }
  }
  async function opNames() { return (await sim.oplog()).map((o) => `${o.op}${o.detail?.sessionId ? `:${o.detail.sessionId}` : o.detail?.id ? `:${o.detail.id}` : ''}`) }
  // What the OLD code could leave behind: a second live page for an order that already has one - registered, open, payable at the provider. The database of a test refuses it (the unique index of
  // live pages), so the index is taken away for this test; the next reset puts it back.
  async function addLegacyTwin(orderId: string, o: { expiresInMs?: number } = {}) {
    await allowLegacyTwins(prisma)
    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
    const expiresInMs = o.expiresInMs ?? SESSION_TTL_MS
    const twin = await prisma.paymentAttempt.create({ data: { orderId, amountCents: order.totalCents, currency: order.currency, status: 'open', expiresAt: new Date(Date.now() + expiresInMs) } })
    const sessionId = await sim.seedSession({ orderId, attemptId: twin.id, legacy: true, expiresInMs, amount: order.totalCents, currency: order.currency.toLowerCase() })
    await prisma.paymentAttempt.update({ where: { id: twin.id }, data: { stripeSessionId: sessionId } })
    return { twin, sessionId }
  }
  const onlyOrder = () => prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  const attemptsOf = (orderId: string) => prisma.paymentAttempt.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  await fresh()
  return {
    prisma, sim, stripe, modelId, customer, effects, problems, HOUR,
    post, getStatus, cart, newKey, sessionIdOf, observe, observing, orderIsPayable, assertClean, startCheckout, payAgain, deliver, customerPays, expireNaturally, announceExpired, setAttemptTimes, travel, clock, snapshot, fresh, waitFor, opNames, onlyOrder, attemptsOf, sleep, addLegacyTwin,
    newBrowser: () => ({ browser: newGuestBrowser() }) as Who,
  }
}
export type Kit = Awaited<ReturnType<typeof bootKit>>
