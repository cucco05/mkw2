// DR-13 phase 3: the parts of the orchestrator (lib/checkout-sessions.ts) that the scenario tests of dr13-single-page do not reach one by one:
//   * the hash of the exact request is written WITH the reservation, and a reservation is sent again only if the request as it would be built now is that request;
//   * the answer to a replay is the first answer as it was: the session is read again before anything is decided;
//   * "complete" in every state an attempt can be in, with no regression and no lost identifier;
//   * a unique violation (the index that allows one live page per order, a session id already held) and the count of every update;
//   * no database transaction is open while the provider is called; a refusal made here leaves no trace.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Prisma } from '@prisma/client'
import { bootKit, SESSION_TTL_MS, type Kit } from './_dr13-kit'
import { ACTIVE_ATTEMPT_GRACE_MS, releaseDecision, type ReleaseFacts } from '../../lib/order-payment-policy'
import { buildCheckoutSessionParams, checkoutSessionHooks, idempotencyKeyOf, requestHashOf } from '../../lib/checkout-sessions'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'

let k: Kit
// a way to make ONE statement of the database fail the way the database would, without touching the code under test
const inject: { create?: Error | null; sessionIdUpdate?: Error | null } = {}
const realViolations: Array<{ action: string; meta: unknown; message: string }> = []
const counter = (name: string) => getInMemoryMetricsSnapshot().counters.filter((c) => c.name === name).reduce((n, c) => n + c.value, 0)
test.before(async () => {
  k = await bootKit()
  ;(k.prisma as any).$use(async (params: any, next: (p: any) => Promise<any>) => {
    if (params.model === 'PaymentAttempt' && params.action === 'create' && inject.create) { const e = inject.create; inject.create = null; throw e }
    if (params.model === 'PaymentAttempt' && params.action === 'updateMany' && params.args?.data?.stripeSessionId && inject.sessionIdUpdate) { const e = inject.sessionIdUpdate; inject.sessionIdUpdate = null; throw e }
    try {
      return await next(params)
    } catch (error: any) {
      // a violation that really comes from the database (nothing was injected for it): kept, so that a test can show it was real
      if (params.model === 'PaymentAttempt' && error?.code === 'P2002') realViolations.push({ action: params.action, meta: error.meta, message: String(error.message).slice(-160) })
      throw error
    }
  })
})
test.beforeEach(async () => { await k.fresh(); realViolations.length = 0; inject.create = null; inject.sessionIdUpdate = null; checkoutSessionHooks.afterLock = null; checkoutSessionHooks.afterLoad = null; checkoutSessionHooks.afterPlan = null; checkoutSessionHooks.withoutFollowUp = false })
test.after(async () => { await k.fresh(); await k.sim.close() })

const MIN = 60_000
const HOUR = 3_600_000
const jsonCode = (r: { json: any }) => r.json?.code ?? null
const unique = (target: string | string[]) => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: Prisma.prismaVersion.client, meta: { target } })
async function lostFirst() {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.ok(first.status === 502 || first.status === 503)
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  return { first: { ...first, orderId: order.id }, order, reservation }
}

// ====================================================================================================================================================================
// the hash of the exact request
// ====================================================================================================================================================================
test('the hash of the exact request is written WITH the reservation (one insert) and is the hash of the request that is sent', async () => {
  const creates: any[] = []
  ;(k.prisma as any).$use(async (params: any, next: (p: any) => Promise<any>) => { if (params.model === 'PaymentAttempt' && params.action === 'create') creates.push(params.args.data); return next(params) })
  const a = await k.startCheckout(k.newBrowser())
  const mine = creates.filter((data) => data.orderId === a.orderId)
  assert.equal(mine.length, 1, 'one insert for the reservation')
  assert.match(mine[0].requestHash, /^[0-9a-f]{64}$/, 'and the hash is in it')
  assert.equal(mine[0].status, 'creating')
  const attempt = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId }, include: { items: { orderBy: { createdAt: 'asc' } } } })
  const params = buildCheckoutSessionParams({ order, attempt, returnBaseUrl: process.env.BASE_URL as string })
  assert.equal(attempt.requestHash, requestHashOf(params, idempotencyKeyOf(attempt.id)))
  assert.equal(attempt.id, mine[0].id, 'the id the request names is the id of the row')
})

test('the hash notices everything that makes a request another request: the key, the parameters, the return address, test or live', () => {
  const order: any = { id: 'ord1', orderNumber: 7, currency: 'EUR', totalCents: 1000, taxCents: 0, shippingCents: 0, shippingMethod: 'pickup', userId: null, customerEmail: null, items: [{ modelTitle: 'x', partName: null, material: 'PLA', colors: [], finish: null, quantity: 1, unitPriceCents: 1000, totalCents: 1000 }] }
  const attempt = { id: 'cattempt0001', expiresAt: new Date(Date.UTC(2026, 10, 4, 12, 32, 0)) }
  const base = requestHashOf(buildCheckoutSessionParams({ order, attempt, returnBaseUrl: 'https://shop.test' }), idempotencyKeyOf(attempt.id))
  assert.equal(base, requestHashOf(buildCheckoutSessionParams({ order, attempt, returnBaseUrl: 'https://shop.test' }), idempotencyKeyOf(attempt.id)), 'the same request, the same hash')
  const differs = (hash: string, why: string) => assert.notEqual(hash, base, why)
  differs(requestHashOf(buildCheckoutSessionParams({ order, attempt, returnBaseUrl: 'https://other.test' }), idempotencyKeyOf(attempt.id)), 'the return address')
  differs(requestHashOf(buildCheckoutSessionParams({ order, attempt: { ...attempt, expiresAt: new Date(attempt.expiresAt.getTime() + 1000) }, returnBaseUrl: 'https://shop.test' }), idempotencyKeyOf(attempt.id)), 'the expiry')
  differs(requestHashOf(buildCheckoutSessionParams({ order: { ...order, items: [{ ...order.items[0], modelTitle: 'y' }] }, attempt, returnBaseUrl: 'https://shop.test' }), idempotencyKeyOf(attempt.id)), 'a line')
  differs(requestHashOf(buildCheckoutSessionParams({ order, attempt, returnBaseUrl: 'https://shop.test' }), idempotencyKeyOf('cattempt0002')), 'the key')
  const key = process.env.STRIPE_SECRET_KEY
  try {
    process.env.STRIPE_SECRET_KEY = 'sk_live_FAKE_not_a_real_key_000000000000'
    differs(requestHashOf(buildCheckoutSessionParams({ order, attempt, returnBaseUrl: 'https://shop.test' }), idempotencyKeyOf(attempt.id)), 'test or live')
  } finally { process.env.STRIPE_SECRET_KEY = key }
})

for (const [what, change] of [
  ['the return address (configuration) has changed', async () => { process.env.BASE_URL = 'http://127.0.0.1:19' }],
  ['a line of the order was edited', async (orderId: string) => { await k.prisma.printOrderItem.updateMany({ where: { orderId }, data: { modelTitle: 'EDITED after the reservation' } }) }],
  ['the reservation was made by the old code (no stored request)', async (orderId: string) => { await k.prisma.paymentAttempt.updateMany({ where: { orderId }, data: { requestHash: null } }) }],
] as Array<[string, (orderId: string) => Promise<void>]>) {
  test(`DRIFT: ${what} between the reservation and the replay -> the request is NOT sent; the reservation waits, exactly as it was`, async () => {
    const original = process.env.BASE_URL
    try {
      const { first, order, reservation } = await lostFirst()
      await change(order.id)
      const calls = await k.sim.countOps('create.call')
      const r = await k.payAgain(first)
      await k.assertClean('DRIFT')
      assert.equal(r.status, 503, r.text)
      assert.equal(jsonCode(r), 'RESERVATION_UNRESOLVED')
      assert.equal(await k.sim.countOps('create.call'), calls, 'a request that is not the stored one was sent')
      const after = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: reservation.id } })
      assert.equal(after.status, 'creating')
      assert.equal(after.stripeSessionId, null)
      assert.equal((await k.attemptsOf(order.id)).length, 1)
      assert.equal(await k.sim.createdSessions(), 1)
    } finally { process.env.BASE_URL = original }
  })
}

// ====================================================================================================================================================================
// the answer to a replay is the first answer as it was
// ====================================================================================================================================================================
for (const optimistic of [true, false]) {
  test(`SNAPSHOT: the replay (${optimistic ? 'honoured' : 're-validated'} by the provider) of a reservation whose page has since EXPIRED -> the session is read again: closed with proof, then a new page; never the stale "open"`, async () => {
    k.sim.options.replayRevalidatesExpiresAt = !optimistic
    const { first, order, reservation } = await lostFirst()
    await k.travel(35 * MIN)    // the page the lost answer left is over at the provider (32 minutes)
    const r = await k.payAgain(first)
    await k.assertClean('SNAPSHOT')
    const attempts = await k.attemptsOf(order.id)
    if (!optimistic) {
      // the provider refuses the replay (its expiry is no longer valid for a new request): nothing is concluded
      assert.equal(r.status, 503, r.text)
      assert.deepEqual(attempts.map((a) => a.status), ['creating'])
      return
    }
    assert.equal(r.status, 200, r.text)
    assert.equal(attempts[0].id, reservation.id)
    assert.equal(attempts[0].status, 'expired')
    assert.equal(attempts[0].failureReason, 'provider_status:expired')
    assert.ok(attempts[0].stripeSessionId, 'the identifier of the old page is recorded')
    assert.equal(attempts[1].status, 'open')
    assert.equal((await k.sim.payable(order.id)).length, 1)
  })
}

test('IDENTIFIED: the replay of a reservation brings the session back but READING it fails -> its identifier is written on the reservation (still "creating"), the customer is told to try again, and the next request ASKS about that session and sends nothing', async () => {
  const { first, order, reservation } = await lostFirst()
  const [orphan] = await k.sim.sessionsOf(order.id)
  k.sim.faults.retrieveUnreachable = 1
  const r = await k.payAgain(first)
  assert.equal(r.status, 502, r.text)
  const mid = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: reservation.id } })
  assert.equal(mid.status, 'creating', 'a session that was named but not read is not an open page')
  assert.equal(mid.stripeSessionId, orphan.id, 'the name of the session the provider gave is not lost')
  const sent = await k.sim.countOps('create.call')
  const again = await k.payAgain(first)
  await k.assertClean('IDENTIFIED')
  assert.equal(again.status, 200, again.text)
  assert.equal(k.sessionIdOf(again.json.url), orphan.id, 'the page that was created is the page that is handed out')
  assert.equal(await k.sim.countOps('create.call'), sent, 'nothing was sent the second time: the session was asked about')
  assert.equal(await k.sim.createdSessions(), 1)
  assert.deepEqual((await k.attemptsOf(order.id)).map((a) => [a.id, a.status, a.stripeSessionId]), [[reservation.id, 'open', orphan.id]])
})

test('IDENTIFIED: the identifier can not be written either (the database fails) -> still an error for the customer, still nothing handed out, and the next request replays the same request and gets the same session', async () => {
  const { first, order, reservation } = await lostFirst()
  const [orphan] = await k.sim.sessionsOf(order.id)
  k.sim.faults.retrieveUnreachable = 1
  inject.sessionIdUpdate = new Error('connection terminated')
  const r = await k.payAgain(first)
  assert.equal(r.status, 502, r.text)
  const mid = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: reservation.id } })
  assert.deepEqual([mid.status, mid.stripeSessionId], ['creating', null])
  const again = await k.payAgain(first)
  await k.assertClean('IDENTIFIED (not written)')
  assert.equal(again.status, 200, again.text)
  assert.equal(k.sessionIdOf(again.json.url), orphan.id)
  assert.equal(await k.sim.createdSessions(), 1)
})

test('an OPEN page with no identifier can not be asked about nor closed -> nothing is sent, nothing is concluded, the row is left as it is (the planner says "unresolved"; retirePages refuses it as well)', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  await k.prisma.paymentAttempt.update({ where: { id: row.id }, data: { stripeSessionId: null } })
  const expiresBefore = await k.sim.countOps('expire.executed')
  const r = await k.payAgain({ ...a, orderId: order.id })
  assert.equal(r.status, 503, r.text)
  assert.equal(jsonCode(r), 'RESERVATION_UNRESOLVED')
  assert.equal(await k.sim.countOps('expire.executed'), expiresBefore)
  assert.equal(await k.sim.createdSessions(), 1)
  assert.deepEqual((await k.attemptsOf(order.id)).map((x) => [x.status, x.stripeSessionId]), [['open', null]])
})

// ====================================================================================================================================================================
// "complete", in every state an attempt can be in
// ====================================================================================================================================================================
test('COMPLETE: a reservation that already carries an identifier (recorded by a webhook) and whose page is found paid -> "processing", nothing is sent', async () => {
  checkoutSessionHooks.withoutFollowUp = true   // (what the request itself leaves behind; the follow-up has its own tests in dr13-payments)
  const { first, order, reservation } = await lostFirst()
  const [orphan] = await k.sim.sessionsOf(order.id)
  await k.prisma.paymentAttempt.update({ where: { id: reservation.id }, data: { stripeSessionId: orphan.id } })
  assert.equal((await k.sim.pay(orphan.id)).paid, true)
  const calls = await k.sim.countOps('create.call')
  const r = await k.payAgain(first)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.reason, 'processing')
  const after = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: reservation.id } })
  assert.equal(after.status, 'processing')
  assert.equal(after.stripeSessionId, orphan.id)
  assert.equal(await k.sim.countOps('create.call'), calls, 'the identifier was known: the session was asked about, nothing was sent')
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).financialRevision, 1)
})

test('COMPLETE: the payment has already been recorded (the attempt is "paid") -> nothing is regressed, nothing is asked of the provider', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.customerPays(a.sessionId)
  const before = await k.snapshot(a.orderId)
  assert.equal(before.order.paymentStatus, 'paid')
  const retrieves = await k.sim.countOps('retrieve')
  const r = await k.payAgain(a)
  assert.equal(r.status, 409)
  assert.equal(r.json.reason, 'paid')
  const after = await k.snapshot(a.orderId)
  assert.deepEqual(after.attempts.map((x) => x.status), ['paid'])
  assert.equal(after.order.revision, before.order.revision)
  assert.equal(await k.sim.countOps('retrieve'), retrieves)
})

test('COMPLETE: the webhook is processed between our decision and our reading of the page -> the attempt stays "paid" (never moved back to "processing"), the revision does not go up a second time', async () => {
  const a = await k.startCheckout(k.newBrowser())
  let fired = false
  k.sim.hooks.beforeRetrieve = async (id) => { if (!fired) { fired = true; await k.customerPays(id) } }
  const r = await k.payAgain(a)
  assert.equal(r.status, 409, r.text)
  assert.ok(['paid', 'processing'].includes(r.json.reason))
  const snap = await k.snapshot(a.orderId)
  assert.deepEqual(snap.attempts.map((x) => x.status), ['paid'])
  assert.equal(snap.order.paymentStatus, 'paid')
  assert.deepEqual({ ...k.effects }, { printlab: 1, discord: 1, push: 1, inventory: 0, receipt: 1 })
})

test('COMPLETE: a page the database had already CLOSED is found paid at the provider -> nothing is reopened or moved, the identifier is kept, this request opens nothing', async () => {
  checkoutSessionHooks.withoutFollowUp = true   // (what the request itself leaves behind; the follow-up has its own tests in dr13-payments)
  const a = await k.startCheckout(k.newBrowser())
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)      // paid; no webhook yet
  // between the decision and the reading, another actor closes the row (the contradiction this test is about)
  checkoutSessionHooks.afterPlan = async (step) => { if (step === 'reuse') await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'failed', failureReason: 'closed by somebody else', stripeSessionId: null } }) }
  const r = await k.payAgain(a)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.reason, 'processing')
  const after = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  assert.equal(after.status, 'failed', 'not reopened, not moved to "processing"')
  assert.equal(after.stripeSessionId, a.sessionId, 'the identifier of the session is recorded')
  assert.equal(await k.sim.createdSessions(), 1, 'no other page')
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })).paymentStatus, 'pending', 'and nothing is called paid here')
})

// ====================================================================================================================================================================
// unique violations and counts
// ====================================================================================================================================================================
test('P2002 on the index that allows one live page per order (somebody got there first) -> the request decides again; no error, one reservation, one page', async () => {
  inject.create = unique('PaymentAttempt_orderId_live_page_key')
  const a = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  await k.assertClean('P2002 index')
  assert.equal(a.status, 200, JSON.stringify(a.json))
  assert.equal((await k.attemptsOf(a.orderId)).length, 1)
  assert.equal(await k.sim.createdSessions(), 1)
})

// An order that exists and has no attempt: its first request died before it reserved anything.
async function orderWithoutAttempt() {
  checkoutSessionHooks.afterLock = async () => { throw new Error('the first request died before it reserved anything') }
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  checkoutSessionHooks.afterLock = null
  const order = await k.onlyOrder()
  assert.equal((await k.attemptsOf(order.id)).length, 0)
  return { first: { ...first, orderId: order.id }, order }
}

// A REAL violation of the index can not come from an INSERT of another writer: PostgreSQL makes the insert of an attempt (a child row of the order) wait for the lock the transaction holds
// on the order (the foreign key takes FOR KEY SHARE on the parent, which conflicts with FOR UPDATE) - a first version of this test inserted from the hook and blocked until the transaction
// timed out (15 s). What the index can still catch is a writer that turns a CLOSED row into a live one with an UPDATE (no lock on the order is taken by an update that does not touch
// the foreign key): that is the adversary used here. Nothing is injected: the violation is raised by PostgreSQL.
async function orderWithAClosedAttempt() {
  const { first, order } = await orderWithoutAttempt()
  const closed = await k.prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: order.totalCents, currency: order.currency, status: 'expired', failureReason: 'local_refusal:test fixture (nothing was ever sent)', expiresAt: new Date(Date.now() - 60_000) } })
  return { first, order, closed }
}

test('REAL unique violation (PostgreSQL 23505 raised by the index - nothing is injected): a writer that does NOT take the lock of the order REOPENS a closed row between the decision and the reservation -> the DATABASE refuses the insert, the request decides again and hands out THAT page; no 500, one live attempt, and the counter of lost races goes up', async () => {
  const { first, order, closed } = await orderWithAClosedAttempt()
  const injected: { sessionId?: string } = {}
  checkoutSessionHooks.afterLoad = async () => {
    if (injected.sessionId) return
    // from ANOTHER connection and without the lock of the order: the row the request read as closed becomes an open page
    injected.sessionId = await k.sim.seedSession({ orderId: order.id, attemptId: closed.id, amount: order.totalCents, currency: order.currency.toLowerCase() })
    await k.prisma.paymentAttempt.update({ where: { id: closed.id }, data: { status: 'open', failureReason: null, stripeSessionId: injected.sessionId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
  }
  const races = counter('checkout_session_race_total')
  const r = await k.payAgain(first)
  await k.assertClean('REAL P2002')
  assert.ok(injected.sessionId, 'the other writer did act')
  assert.equal(r.status, 200, `a lost race must not be an error for the customer: ${r.status} ${r.text}`)
  assert.equal(k.sessionIdOf(r.json.url), injected.sessionId, 'the page that was handed out is the one the other writer registered')
  // the violation came from PostgreSQL, on the attempt table, and not from an injection
  const mine = realViolations.filter((v) => v.action === 'create')
  assert.equal(mine.length, 1, `exactly one real unique violation was expected: ${JSON.stringify(realViolations)}`)
  assert.match(JSON.stringify(mine[0].meta) + mine[0].message, /orderId/, 'and it is the one-live-page index (on "orderId")')
  assert.equal(counter('checkout_session_race_total'), races + 1, 'the lost race was counted')
  assert.deepEqual((await k.attemptsOf(order.id)).map((a) => [a.id, a.status]), [[closed.id, 'open']], 'the reservation of the lost race was rolled back with its transaction: one attempt, one page')
  assert.equal(await k.sim.createdSessions(), 1, 'the request did not create a page of its own')
})

test('REAL unique violation, the other writer reopens the row as a RESERVATION (no stored request) -> the database refuses the insert, the request decides again, finds the reservation, and - with no stored request to send again - answers "being checked": nothing new is opened', async () => {
  const { first, order, closed } = await orderWithAClosedAttempt()
  let injected = false
  checkoutSessionHooks.afterLoad = async () => {
    if (injected) return
    injected = true
    await k.prisma.paymentAttempt.update({ where: { id: closed.id }, data: { status: 'creating', failureReason: null, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
  }
  const races = counter('checkout_session_race_total')
  const r = await k.payAgain(first)
  await k.assertClean('REAL P2002 (reservation)')
  assert.equal(r.status, 503, r.text)
  assert.equal(jsonCode(r), 'RESERVATION_UNRESOLVED')
  assert.equal(realViolations.filter((v) => v.action === 'create').length, 1, JSON.stringify(realViolations))
  assert.equal(counter('checkout_session_race_total'), races + 1)
  assert.deepEqual((await k.attemptsOf(order.id)).map((a) => [a.id, a.status, a.requestHash]), [[closed.id, 'creating', null]], 'the other writer\'s reservation is exactly as it was: nothing was added to it, nothing was sent')
  assert.equal(await k.sim.createdSessions(), 0)
})

test('P2002 on a session id another attempt already holds -> never overwritten, never shared: the request answers "being checked" and hands nothing out', async () => {
  inject.sessionIdUpdate = unique(['stripeSessionId'])
  const a = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.equal(a.status, 503)
  assert.equal(a.json.code, 'RESERVATION_UNRESOLVED')
  assert.equal(JSON.stringify(a.json).includes('checkout.stripe.test'), false)
  const order = await k.onlyOrder()
  const rows = await k.attemptsOf(order.id)
  assert.deepEqual(rows.map((x) => [x.status, x.stripeSessionId]), [['creating', null]], 'the transaction rolled back as a whole')
})

test('the index itself: two live attempts for one order are refused by the database; a closed one next to a live one is not', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  const data = { orderId: order.id, amountCents: order.totalCents, currency: order.currency, expiresAt: new Date(Date.now() + 60_000) }
  await assert.rejects(() => k.prisma.paymentAttempt.create({ data: { ...data, status: 'creating' } }), (error: any) => error.code === 'P2002')
  await assert.rejects(() => k.prisma.paymentAttempt.create({ data: { ...data, status: 'open', stripeSessionId: 'cs_test_dup_1' } }), (error: any) => error.code === 'P2002')
  for (const status of ['expired', 'failed', 'processing', 'paid', 'mismatch']) await k.prisma.paymentAttempt.create({ data: { ...data, status, stripeSessionId: `cs_test_dup_${status}` } })
  await k.prisma.paymentAttempt.deleteMany({ where: { id: { not: a.attemptId }, orderId: order.id } })
  assert.equal((await k.attemptsOf(order.id)).length, 1)
})

test('COUNT: a writer that does NOT take the lock of the order closes the row between the moment it is read and the moment it is written, while the provider shows the page PAID -> the update moves nothing, the revision does not go up, nothing is opened, the customer is told "processing"', async () => {
  checkoutSessionHooks.withoutFollowUp = true   // (what the request itself leaves behind)
  const a = await k.startCheckout(k.newBrowser())
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)      // paid out of band; no webhook yet
  const revision = (await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })).financialRevision
  let settles = 0
  checkoutSessionHooks.afterLoad = async () => {
    // the first settlement only decides to read the page; the second one carries the evidence "this page is paid" - and finds the row closed by somebody else
    if (++settles === 2) await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'expired', failureReason: 'closed by a writer that does not take the lock' } })
  }
  const r = await k.payAgain(a)
  assert.equal(settles >= 2, true)
  assert.equal(r.status, 409, `a page was handed out or a new one opened for a session that is paid: ${r.status} ${r.text}`)
  assert.equal(r.json.reason, 'processing')
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  assert.equal(row.status, 'expired', 'not reopened, not moved to "processing"')
  assert.equal(row.stripeSessionId, a.sessionId)
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })).financialRevision, revision, 'nothing entered "processing": the revision does not move')
  assert.equal(await k.sim.createdSessions(), 1, 'a new page was opened next to a page that was paid')
  assert.equal((await k.attemptsOf(a.orderId)).length, 1)
})

test('TOCTOU: a second live page appears (written by an instance of the old code) between the decision and the registration -> the page that was decided on is NOT handed out next to it; the extra one is closed at the provider first; never two payable pages', async () => {
  const a = await k.startCheckout(k.newBrowser())
  let injected = false
  checkoutSessionHooks.afterPlan = async (step) => {
    if (step === 'reuse' && !injected) { injected = true; await k.addLegacyTwin(a.orderId) }
  }
  const r = await k.payAgain(a)
  assert.equal(injected, true)
  assert.equal(r.status, 200, r.text)
  const payable = await k.sim.payable(a.orderId)
  assert.equal(payable.length, 1, `two pages are payable: ${payable.join(', ')}`)
  assert.equal(k.sessionIdOf(r.json.url), payable[0], 'the page that was handed out is the one that is left')
  const live = (await k.attemptsOf(a.orderId)).filter((x) => x.status === 'open' || x.status === 'creating')
  assert.equal(live.length, 1)
  assert.ok((await k.sim.countOps('expire.executed')) >= 1, 'the extra page was closed at the provider')
})

// ====================================================================================================================================================================
// what is not allowed to happen
// ====================================================================================================================================================================
test('NO TRANSACTION: no database transaction of the application is open while the provider is called - first page, reuse, replacement at the margin, replay of a reservation', async () => {
  k.sim.options.probeTransactions = true
  const a = await k.startCheckout(k.newBrowser())
  await k.payAgain(a)                                  // reuse (a read)
  await k.travel(SESSION_TTL_MS - 30_000)
  await k.payAgain(a)                                  // close + open
  await k.fresh()
  k.sim.options.probeTransactions = true
  const { first } = await lostFirst()
  await k.payAgain(first)                              // replay
  await k.assertClean('NO TRANSACTION')
  assert.ok(await k.sim.countOps('create.call') >= 1)
})

test('NO TRANSACTION (source): no call to the provider appears inside a database transaction of lib/checkout-sessions.ts', () => {
  const source = readFileSync(new URL('../../lib/checkout-sessions.ts', import.meta.url), 'utf8')
  const start = source.indexOf('prisma.$transaction(')
  assert.ok(start > 0)
  // the body of the transaction callback ends at its option object
  const end = source.indexOf('}, { maxWait: 10_000, timeout: 15_000 })', start)
  assert.ok(end > start)
  const body = source.slice(start, end)
  for (const forbidden of ['getStripe(', '.checkout.sessions.', 'closeAtProvider(', 'readSession(', 'sendReservation(', 'retirePages(', 'fetch(']) assert.equal(body.includes(forbidden), false, `${forbidden} inside a transaction`)
  assert.equal(source.split('prisma.$transaction(').length - 1, 1, 'one transaction, the one that settles')
  assert.equal(/\$transaction\(\s*async \(tx\) => \{[\s\S]*\$transaction\(/.test(body), false, 'no nested transaction')
  // and the test seams are null in production
  assert.match(source, /checkoutSessionHooks: \{[^}]*\} = \{ afterLock: null, afterLoad: null, afterPlan: null, withoutFollowUp: false \}/)
})

test('LOCAL REFUSAL: an order whose lines do not add up leaves NO trace - no reservation, no call to the provider', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.sim.expire(a.sessionId)
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'expired', failureReason: 'provider_status:expired' } })
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { shippingCents: 99_999 } })    // the lines no longer add up to the total
  const calls = await k.sim.countOps('create.call')
  const r = await k.payAgain(a)
  assert.equal(r.status, 500, r.text)
  assert.equal((await k.attemptsOf(a.orderId)).length, 1, 'no reservation was written')
  assert.equal(await k.sim.countOps('create.call'), calls)
})

test('TOCTOU cleanup that can NOT be confirmed: the order is paid while the page is created, the provider cannot be reached to close it -> nothing is handed out, the page stays a registered live attempt', async () => {
  k.sim.hooks.duringCreate = async () => {
    const order = await k.onlyOrder()
    await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date() } })
    k.sim.faults.expireUnreachable = 99
  }
  const r = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.notEqual(r.status, 200)
  const order = await k.onlyOrder()
  const [row] = await k.attemptsOf(order.id)
  assert.equal(row.status, 'open', 'not closed without proof')
  assert.ok(row.stripeSessionId, 'but registered: it is not unknown')
  assert.deepEqual(await k.sim.payable(order.id), [row.stripeSessionId], 'it is still payable at the provider - and it is the ONLY one, never handed out')
  assert.deepEqual(await k.sim.deliveries(order.id), [], 'nobody was given its address')
})

test('LATE COMPLETION of a request that was slow: the other request meets the reservation 10 hours later (the first page is over by then) -> at most ONE new page, handed out once; the page of the slow request is never handed out unregistered', async () => {
  const who = k.newBrowser()
  const cart = k.cart()
  const quote = await k.post('quote', cart, who)
  const body = { checkoutKey: k.newKey('late'), expectedTotalCents: quote.json.totalCents, ...cart }
  k.sim.faults.createDelayMs = 600
  k.sim.faults.delayFirstCreateOnly = true
  const slow = k.post('session', body, who)
  await k.sleep(200)
  await k.travel(10 * HOUR)       // the other request meets the reservation 10 hours later
  const second = await k.post('session', body, who)
  const first = await slow
  const order = await k.onlyOrder()
  for (const r of [first, second]) await k.observe(order.id, r)
  await k.assertClean('LATE')
  const sessions = await k.sim.sessionsOf(order.id)
  assert.ok(sessions.length <= 2, `${sessions.length} sessions`)
  assert.ok((await k.sim.payable(order.id)).length <= 1)
  const pages = [first, second].filter((r) => r.status === 200).map((r) => k.sessionIdOf(r.json.url))
  assert.ok(new Set(pages).size <= 1, `different pages were handed out: ${pages.join(', ')}`)
  const live = (await k.attemptsOf(order.id)).filter((a) => a.status === 'creating' || a.status === 'open')
  assert.ok(live.length <= 1)
})

// ====================================================================================================================================================================
// the operator's report
// ====================================================================================================================================================================
class Rollback extends Error { constructor(readonly rows: unknown) { super('rollback') } }
test('scripts/checkout-pages-check.sql: it is READ ONLY, its six queries run, and each lists what it says it lists', async () => {
  const sql = readFileSync(new URL('../../scripts/checkout-pages-check.sql', import.meta.url), 'utf8')
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|VACUUM)\b/i, 'the report must not be able to change anything')
  const queries = code.split(/;\s*\n/).map((q) => q.trim()).filter(Boolean)
  assert.equal(queries.length, 6)
  const run = (index: number) => k.prisma.$queryRawUnsafe(queries[index]) as Promise<any[]>

  // six orders, each in the situation one query is about
  const orders: Awaited<ReturnType<Kit['startCheckout']>>[] = []
  for (let i = 0; i < 6; i++) orders.push(await k.startCheckout(k.newBrowser()))
  const [reserved, pastExpiry, twice, unproved, paidWithLive, bystander] = orders
  await k.prisma.paymentAttempt.update({ where: { id: reserved.attemptId }, data: { status: 'creating', stripeSessionId: null, createdAt: new Date(Date.now() - 3 * HOUR) } })
  await k.prisma.paymentAttempt.update({ where: { id: pastExpiry.attemptId }, data: { expiresAt: new Date(Date.now() - 10 * MIN) } })
  await k.prisma.printOrder.update({ where: { id: twice.orderId }, data: { paymentStatus: 'paid', status: 'queued', paymentReviewReason: 'duplicate_payment' } })
  await k.prisma.paymentAttempt.update({ where: { id: twice.attemptId }, data: { status: 'paid' } })
  await k.prisma.paymentAttempt.update({ where: { id: unproved.attemptId }, data: { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: null } })
  await k.prisma.printOrder.update({ where: { id: paidWithLive.orderId }, data: { paymentStatus: 'paid', status: 'queued' } })

  assert.deepEqual(await run(0), [], 'Q1: the index makes it impossible')
  const q2 = await run(1)
  assert.deepEqual(q2.map((r) => r.attempt), [reserved.attemptId])
  assert.ok(q2[0].age_minutes >= 179 && q2[0].has_stored_request === true && q2[0].has_session_id === false)
  assert.ok((await run(2)).map((r) => r.attempt).includes(pastExpiry.attemptId), 'Q3')
  assert.deepEqual((await run(3)).map((r) => r.orderId), [twice.orderId], 'Q4')
  const q5 = await run(4)
  assert.deepEqual(q5.map((r) => r.attempt), [unproved.attemptId], 'Q5')
  assert.equal(q5[0].order_status, 'awaiting_payment')
  assert.equal(q5[0].carries_a_payment, false)
  const q6 = (await run(5)).map((r) => r.attempt)
  assert.ok(q6.includes(paidWithLive.attemptId), 'Q6: the live page of a paid order')
  assert.ok(!q6.includes(bystander.attemptId), 'Q6 leaves out the order that can still be paid')

  // Q1 itself: the index is taken away INSIDE a transaction that is rolled back, so that a second live attempt can exist for a moment
  const q1 = await k.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DROP INDEX "PaymentAttempt_orderId_live_page_key"')
    const order = await tx.printOrder.findUniqueOrThrow({ where: { id: bystander.orderId } })
    await tx.paymentAttempt.create({ data: { orderId: bystander.orderId, amountCents: order.totalCents, currency: order.currency, status: 'creating', expiresAt: new Date(Date.now() + 60_000) } })
    throw new Rollback(await tx.$queryRawUnsafe(queries[0]))
  }).catch((error) => { if (error instanceof Rollback) return error.rows as any[]; throw error })
  assert.deepEqual(q1.map((r: any) => r.orderId), [bystander.orderId], 'Q1 lists an order with two live attempts')
  assert.equal(q1[0].live_attempts, 2)
  const index = await k.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'PaymentAttempt_orderId_live_page_key'`)
  assert.equal(index[0].n, 1, 'the index is back (the transaction was rolled back)')
})

test('scripts/checkout-pages-check.sql (follow-up P0-B): a closed row WITH an identifier and no proof is listed by Q5 - and by Q6 when the order can not be paid; a closed row WITH proof, by neither', async () => {
  const sql = readFileSync(new URL('../../scripts/checkout-pages-check.sql', import.meta.url), 'utf8')
  const queries = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((q) => q.trim()).filter(Boolean)
  const run = (index: number) => k.prisma.$queryRawUnsafe(queries[index]) as Promise<any[]>
  const [waiting, paid, proved, bystander] = [await k.startCheckout(k.newBrowser()), await k.startCheckout(k.newBrowser()), await k.startCheckout(k.newBrowser()), await k.startCheckout(k.newBrowser())]
  await k.prisma.paymentAttempt.update({ where: { id: waiting.attemptId }, data: { status: 'failed', failureReason: 'payment_canceled' } })              // closed, identifier, no proof - the order can still be paid
  await k.prisma.paymentAttempt.update({ where: { id: paid.attemptId }, data: { status: 'expired', failureReason: null } })                           // closed, identifier, no proof - ...
  await k.prisma.printOrder.update({ where: { id: paid.orderId }, data: { paymentStatus: 'paid', status: 'queued' } })                                 // ... and the order is paid
  await k.prisma.paymentAttempt.update({ where: { id: proved.attemptId }, data: { status: 'expired', failureReason: 'closed_by_us:replaced' } })      // closed WITH proof
  await k.prisma.printOrder.update({ where: { id: proved.orderId }, data: { paymentStatus: 'paid', status: 'queued' } })
  const q5 = (await run(4)).map((r) => r.attempt).sort()
  assert.deepEqual(q5, [waiting.attemptId, paid.attemptId].sort(), 'Q5: the two closed rows that never showed their page closed')
  const q5rows = await run(4)
  assert.ok(q5rows.every((r) => r.has_session_id === true))
  const q6 = (await run(5)).map((r) => r.attempt)
  assert.ok(q6.includes(paid.attemptId), 'Q6: the closed row without proof, on an order that is paid')
  assert.ok(!q6.includes(waiting.attemptId), 'Q6 leaves out an order that can still be paid (the customer\'s next request deals with it)')
  assert.ok(!q6.includes(proved.attemptId), 'a row with proof is listed by neither')
  assert.ok(!q5.includes(proved.attemptId) && !q6.includes(bystander.attemptId))
})

test('LEGACY DATA: the pure release rule still reads an order with SEVERAL live attempts (made before DR-13): payment_active until the LATEST of them is over, plus the grace', () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0)
  const facts = (attempts: ReleaseFacts['paymentAttempts']): ReleaseFacts => ({
    paymentStatus: 'pending', paymentReviewReason: null, metadata: {}, totalCents: 2500, currency: 'EUR', paymentMethod: 'card', stripePaymentIntentId: null, stripeInvoiceId: null,
    paidAt: null, refundedCents: 0, financialRevision: 0, paymentAttempts: attempts, refundOperations: [],
  })
  const twins = facts([{ status: 'open', expiresAt: new Date(now - HOUR) }, { status: 'open', expiresAt: new Date(now + 5 * MIN) }])
  const decision = releaseDecision(twins, { now })
  assert.equal(decision.state, 'payment_active')
  assert.equal(decision.activeUntil, new Date(now + 5 * MIN + ACTIVE_ATTEMPT_GRACE_MS).toISOString())
  assert.equal(releaseDecision(facts([{ status: 'open', expiresAt: new Date(now - HOUR) }, { status: 'creating', expiresAt: new Date(now - 2 * HOUR) }]), { now }).state, 'payment_pending')
})
