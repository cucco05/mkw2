// DR-13 phase 5: the process dies - for real: a separate Node process that exits with 137 and leaves no answer - at each point of a request for a payment page, and the next request
// finds the world in a state it can finish from. The provider is the shared stand-in (its state lives in the database, so the dead process's pages are still there for everybody), the
// judge is its monitor (tests/security/_stripe-sim.ts: at no instant more than ONE payable session for an order, the unknown ones included).
//
// The points (docs: DR-13 plan, REVISIONE 1, C3-CRASH):
//   P0  after the reservation is written, before the provider is called            (CHILD_CRASH=send)
//   P1  right after the provider created the session, before anything is written   (SIM_FAULTS createCrashAfter)  - and just before it did anything (createCrashBefore)
//   P2  inside the transaction that registers the answer, before it commits         (CHILD_CRASH=before_registration)
//   P3  after the answer is registered and the page is open, before it is handed out (CHILD_CRASH=registered)
//   P4  right after the provider closed the old page, before its row is closed       (SIM_FAULTS expireCrashAfter)
//   P5  after the old page is closed and the successor reserved, before it is sent    (CHILD_CRASH=send, in a replacement)
// What must hold at every point: I-1 (a page is handed out only if registered), I-2 (at most one handed-out page is payable), I-3 (nothing is opened next to an uncertain reservation), I-4
// (a session that may exist is not forgotten), and - the accepted window, I-5 - a session the database never learned about may exist for a while but is NEVER handed out and is NEVER joined by
// a second payable one.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, SESSION_TTL_MS, type Kit } from './_dr13-kit'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { killChildren, runOne } from './_dr13-procs'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); checkoutSessionHooks.afterLock = null; checkoutSessionHooks.afterLoad = null; checkoutSessionHooks.afterPlan = null; checkoutSessionHooks.withoutFollowUp = false })
test.afterEach(() => killChildren())
test.after(async () => { await k.fresh(); await k.sim.close() })

// an order that exists and has no payment attempt: its first request died before it reserved anything
async function orderWithoutPage() {
  checkoutSessionHooks.afterLock = async () => { throw new Error('the first request died before it reserved anything') }
  const started = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  checkoutSessionHooks.afterLock = null
  const order = await k.onlyOrder()
  assert.equal((await k.attemptsOf(order.id)).length, 0)
  assert.equal(await k.sim.createdSessions(), 0)
  return { ...started, orderId: order.id }
}
const died = (r: { exit: number | null; kind?: string }) => { assert.equal(r.exit, 137, `the process was supposed to die: ${JSON.stringify(r)}`); assert.equal(r.kind, 'no_result') }
// the accepted window: at most ONE payable session, whatever the database knows
async function atMostOnePayable(orderId: string, label: string) {
  const payable = await k.sim.payable(orderId)
  assert.ok(payable.length <= 1, `${label}: ${payable.length} payable sessions at the provider`)
  return payable
}

test('P0 the process dies after the reservation is written and before the provider is called -> nothing exists at the provider; the next request sends the SAME request and gets one page', async () => {
  const s = await orderWithoutPage()
  died(await runOne(k, 'p0', s.orderId, { CHILD_CRASH: 'send' }))
  const [reservation] = await k.attemptsOf(s.orderId)
  assert.deepEqual([reservation.status, reservation.stripeSessionId], ['creating', null])
  assert.match(reservation.requestHash ?? '', /^[0-9a-f]{64}$/, 'the exact request is stored with the reservation')
  assert.equal(await k.sim.createdSessions(), 0, 'the provider was never called')
  await atMostOnePayable(s.orderId, 'after the crash')
  const r = await k.payAgain(s)
  assert.equal(r.status, 200, r.text)
  await k.assertClean('P0')
  const attempts = await k.attemptsOf(s.orderId)
  assert.deepEqual(attempts.map((a) => [a.id, a.status]), [[reservation.id, 'open']], 'the reservation was resolved, not replaced')
  assert.equal(await k.sim.createdSessions(), 1)
})

test('P1 the process dies right after the provider CREATED the session -> the page exists, unknown to the database, never handed out; the next request gets THE SAME page (same key), and there is never a second', async () => {
  const s = await orderWithoutPage()
  died(await runOne(k, 'p1', s.orderId, { SIM_FAULTS: JSON.stringify({ createCrashAfter: 1 }) }))
  const [reservation] = await k.attemptsOf(s.orderId)
  assert.deepEqual([reservation.status, reservation.stripeSessionId], ['creating', null], 'the database never learned about the session')
  assert.equal(await k.sim.createdSessions(), 1, 'but it exists')
  const [orphan] = await k.sim.sessionsOf(s.orderId)
  assert.equal((await atMostOnePayable(s.orderId, 'after the crash')).length, 1, 'the accepted window (I-5): one payable session the database does not know')
  const r = await k.payAgain(s)
  assert.equal(r.status, 200, r.text)
  assert.equal(k.sessionIdOf(r.json.url), orphan.id, 'the page that was created is the page that is handed out')
  await k.assertClean('P1')
  assert.equal(await k.sim.createdSessions(), 1, 'the replay of the same key created nothing')
  assert.deepEqual((await k.attemptsOf(s.orderId)).map((a) => [a.id, a.status, a.stripeSessionId]), [[reservation.id, 'open', orphan.id]])
})

test('P1b the process dies as the call to the provider starts (nothing happened there) -> the next request sends the same request; one page', async () => {
  const s = await orderWithoutPage()
  died(await runOne(k, 'p1b', s.orderId, { SIM_FAULTS: JSON.stringify({ createCrashBefore: 1 }) }))
  assert.equal(await k.sim.createdSessions(), 0)
  const r = await k.payAgain(s)
  assert.equal(r.status, 200, r.text)
  await k.assertClean('P1b')
  assert.equal(await k.sim.createdSessions(), 1)
  assert.equal((await k.attemptsOf(s.orderId)).length, 1)
})

test('P2 the process dies INSIDE the transaction that registers the answer -> the transaction is lost with it; the next request replays the reservation and registers the SAME session', async () => {
  const s = await orderWithoutPage()
  died(await runOne(k, 'p2', s.orderId, { CHILD_CRASH: 'before_registration' }))
  const [reservation] = await k.attemptsOf(s.orderId)
  assert.deepEqual([reservation.status, reservation.stripeSessionId], ['creating', null], 'nothing of the lost transaction is in the database')
  assert.equal(await k.sim.createdSessions(), 1)
  const [orphan] = await k.sim.sessionsOf(s.orderId)
  const r = await k.payAgain(s)
  assert.equal(r.status, 200, r.text)
  assert.equal(k.sessionIdOf(r.json.url), orphan.id)
  await k.assertClean('P2')
  assert.equal(await k.sim.createdSessions(), 1)
})

test('P3 the process dies after the page is registered and open and before it is handed out -> the next request hands out THAT page; no other is created', async () => {
  const s = await orderWithoutPage()
  died(await runOne(k, 'p3', s.orderId, { CHILD_CRASH: 'registered' }))
  const [row] = await k.attemptsOf(s.orderId)
  assert.equal(row.status, 'open')
  assert.ok(row.stripeSessionId)
  const r = await k.payAgain(s)
  assert.equal(r.status, 200, r.text)
  assert.equal(k.sessionIdOf(r.json.url), row.stripeSessionId)
  await k.assertClean('P3')
  assert.equal(await k.sim.createdSessions(), 1)
})

test('P4 the process dies right after the provider closed the OLD page, before its row is closed -> the next request finds the old page expired at the provider (proof), closes the row, and opens ONE new page', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 30_000)                 // 30 seconds left: the page can not be handed out again
  died(await runOne(k, 'p4', a.orderId, { SIM_FAULTS: JSON.stringify({ expireCrashAfter: 1 }) }))
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'the old page is closed at the provider')
  const [still] = await k.attemptsOf(a.orderId)
  assert.equal(still.status, 'open', 'its row does not know yet')
  const r = await k.payAgain(a)
  assert.equal(r.status, 200, r.text)
  await k.assertClean('P4')
  const attempts = await k.attemptsOf(a.orderId)
  assert.deepEqual(attempts.map((x) => x.status), ['expired', 'open'])
  assert.equal(attempts[0].failureReason, 'provider_status:expired', 'closed on the provider\'s own word')
  assert.equal((await k.sim.payable(a.orderId)).length, 1)
  assert.equal(await k.sim.createdSessions(), 2)
})

test('P5 the process dies after the old page was closed and the successor RESERVED, before it was sent -> the successor is resolved by the next request; one new page', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 30_000)
  died(await runOne(k, 'p5', a.orderId, { CHILD_CRASH: 'send' }))
  const mid = await k.attemptsOf(a.orderId)
  assert.deepEqual(mid.map((x) => x.status), ['expired', 'creating'], 'the old row was closed and the successor reserved in ONE commit')
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  const r = await k.payAgain(a)
  assert.equal(r.status, 200, r.text)
  await k.assertClean('P5')
  assert.deepEqual((await k.attemptsOf(a.orderId)).map((x) => x.status), ['expired', 'open'])
  assert.equal((await k.sim.payable(a.orderId)).length, 1)
  assert.equal(await k.sim.createdSessions(), 2)
})

test('P0 then P2: two processes die in a row at different points -> still one reservation, one session, one page', async () => {
  const s = await orderWithoutPage()
  died(await runOne(k, 'p0', s.orderId, { CHILD_CRASH: 'send' }))
  died(await runOne(k, 'p2', s.orderId, { CHILD_CRASH: 'before_registration' }))
  assert.equal((await k.attemptsOf(s.orderId)).length, 1)
  assert.equal(await k.sim.createdSessions(), 1)
  const r = await k.payAgain(s)
  assert.equal(r.status, 200, r.text)
  await k.assertClean('P0+P2')
  assert.equal(await k.sim.createdSessions(), 1)
  assert.deepEqual((await k.attemptsOf(s.orderId)).map((x) => x.status), ['open'])
})

test('CRASH while the other pages of a paid order are being closed: the process dies right after the provider closed the twin -> the payment was already recorded; the twin\'s row is settled by the next sign of life', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  const { twin, sessionId: twinSession } = await k.addLegacyTwin(order.id)
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)
  // a process records the payment - what a webhook does - and starts closing the twin; it dies right after the provider closed it
  const r = await runOne(k, 'sync', order.id, { CHILD_MODE: 'sync', CHILD_SESSION: a.sessionId, CHILD_ATTEMPT: a.attemptId, SIM_FAULTS: JSON.stringify({ expireCrashAfter: 1 }) })
  died(r)
  const snap = await k.snapshot(order.id)
  assert.equal(snap.order.paymentStatus, 'paid', 'the payment was committed before the closing started')
  assert.deepEqual(snap.payable, [], `the twin ${twinSession} is closed at the provider`)
  assert.equal((await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })).status, 'open', 'its row does not know yet')
  const status = await k.getStatus(order.id, { ...a.who, cookie: a.accessCookie ?? undefined }, true)
  assert.equal(status.status, 200)
  const row = await k.waitFor('the row of the twin to be settled', () => k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } }), (x) => x.status !== 'open')
  assert.equal(row.status, 'expired')
  assert.equal(row.failureReason, 'provider_status:expired')
})
