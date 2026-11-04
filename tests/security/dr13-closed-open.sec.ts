// DR-13 follow-up P0-B - "the attempt is CLOSED, the Stripe session is OPEN".
//
// An attempt row says what the DATABASE believes; the session says what the PROVIDER will accept. A row can be closed (`failed`, `expired`) while its session is still open and payable:
//   * a payment event that touches the attempt and not the page (a PaymentIntent that was cancelled while the Checkout session stays open: `failed / payment_canceled`),
//   * a row closed by somebody else while the request that made its page had the answer in flight,
//   * a row the OLD code closed by the clock (`stale_reservation`) or that was written without any proof.
// `stripeSessionId` on such a row is NOT proof that the page is closed - it only says which page to ask about. The rule these tests judge, on the state the faithful stand-in for Stripe really
// holds (tests/security/_stripe-sim.ts):
//   * no successor page is opened while a closed row's page has not been PROVED closed by the provider;
//   * an open page is closed (and proved) first, then replaced; a page that turns out to be PAID is money - nothing is opened, the payment is recorded; a page whose state can not be read
//     leaves everything as it is (503) - nothing is opened;
//   * the proof is written on the row (`closed_by_us:` / `provider_status:expired`); the row keeps its status and never loses the identifier of its session;
//   * at no moment is there more than one payable page for the order (the monitor of the stand-in), and a page that was made for a row that is closed is not left open.
// Paid / processing / mismatch attempts are not touched by any of this (controls at the end).
//
// Every race here is a BARRIER (tests/security/_dr13-barrier.ts), not a pause: the order of the steps is the order of the awaits.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit, type Started } from './_dr13-kit'
import { gate, type Gate } from './_dr13-barrier'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { checkoutPagesHooks } from '../../lib/checkout-pages'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); checkoutSessionHooks.withoutFollowUp = false; checkoutSessionHooks.afterLoad = null; checkoutSessionHooks.afterLock = null; k.sim.hooks = {} })
test.afterEach(() => { k.sim.hooks = {} })
test.after(async () => { await k.fresh(); await k.sim.close() })

const liveAttempts = (attempts: Array<{ status: string }>) => attempts.filter((a) => a.status === 'creating' || a.status === 'open')

// the order of what happened at the provider: the old page must be closed there BEFORE the next one is created
function assertClosedBeforeNextOpened(ops: string[], oldSession: string) {
  const created = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.startsWith('create.executed'))
  assert.ok(created.length >= 2, `a second page was expected: ${ops.join(' | ')}`)
  const closed = ops.indexOf(`expire.executed:${oldSession}`)
  assert.ok(closed >= 0 && closed < created[1].index, `the old page ${oldSession} must be closed at the provider before the next one is created: ${ops.join(' | ')}`)
}

// The test goes on when the request is at the barrier. If it never gets there (the code under test does not do the step the barrier is on) the request is let go and finished first, so that nothing
// of it is left running into the next test, and the test fails with the name of the barrier.
async function holdUntilReached(held: Gate, request: Promise<unknown>) {
  try { await held.arrive() } catch (error) { held.release(); await request.catch(() => undefined); throw error }
}

// An order with ONE page that the database holds as CLOSED and the provider still has OPEN
async function closedRowOpenSession(status: 'failed' | 'expired', reason: string | null): Promise<Started> {
  const a = await k.startCheckout(k.newBrowser())
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status, failureReason: reason } })
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId], 'premise: the page is payable at the provider')
  return a
}

// what must be true afterwards for a closed row whose page was open and was closed by us
async function assertReplacedWithProof(a: Started, status: string, label: string) {
  const attempts = await k.attemptsOf(a.orderId)
  const old = attempts.find((x) => x.id === a.attemptId)!
  assert.equal(old.stripeSessionId, a.sessionId, `${label}: the identifier of the closed row is not lost`)
  assert.equal(old.status, status, `${label}: the row keeps its status`)
  assert.match(old.failureReason ?? '', /^closed_by_us:/, `${label}: the proof of the closing is written on the row (${old.failureReason})`)
  assert.equal(liveAttempts(attempts).length, 1, `${label}: one live attempt: ${JSON.stringify(attempts.map((x) => [x.status, x.failureReason]))}`)
  assert.equal(attempts.length, 2, `${label}: the closed row and its successor`)
  assert.equal((await k.sim.payable(a.orderId)).length, 1, `${label}: one payable page at the provider`)
}

// ====================================================================================================================================================================
// B1 - the adversarial fixture: a closed row, an open page
// ====================================================================================================================================================================
for (const [status, reason] of [['failed', 'payment_failed'], ['failed', 'payment_canceled'], ['expired', null], ['expired', 'stale_reservation']] as const) {
  test(`B1: a ${status} attempt (${reason ?? 'no reason'}) with an identifier whose page is still OPEN at the provider is closed there, with proof, BEFORE another page is made`, async () => {
    const a = await closedRowOpenSession(status, reason)
    const r = await k.payAgain(a)
    await k.assertClean(`B1 ${status}/${reason}`)
    assert.equal(r.status, 200, r.text)
    assert.notEqual(k.sessionIdOf(r.json.url), a.sessionId, 'the customer is handed the NEW page')
    assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
    await assertReplacedWithProof(a, status, `B1 ${status}/${reason}`)
  })
}

test('B1: a closed row whose page the provider ALREADY shows as expired: the provider\'s own word is the proof (nothing is expired by us), written on the row; then the next page', async () => {
  const a = await closedRowOpenSession('expired', null)
  await k.sim.expire(a.sessionId)                         // the page really is closed at the provider
  const expiredBefore = await k.sim.countOps('expire.executed')
  const r = await k.payAgain(a)
  await k.assertClean('B1 already expired')
  assert.equal(r.status, 200, r.text)
  assert.equal(await k.sim.countOps('expire.executed'), expiredBefore, 'nothing was closed by us: it was closed already')
  const old = (await k.attemptsOf(a.orderId)).find((x) => x.id === a.attemptId)!
  assert.equal(old.failureReason, 'provider_status:expired')
  assert.equal(old.stripeSessionId, a.sessionId)
  assert.equal((await k.sim.payable(a.orderId)).length, 1)
})

// ====================================================================================================================================================================
// B2 - the REAL transitions of the payment sync: which of them can make "a closed row and an open page"? (documented, not assumed)
// ====================================================================================================================================================================
// What the code does today, read from lib/payment-sync.ts and shown here:
//   * an event for a page whose identifier the row KNOWS is verified against the SESSION (readFromStripe reads it): a cancelled PaymentIntent of a session that is still open says "unpaid, open"
//     and moves nothing - this path does NOT produce a closed row next to an open page;
//   * the PaymentIntent is read alone only for a row WITHOUT identifier; there `payment_intent.canceled` closes the row (`failed`) with no identifier - a closed row without an identifier and
//     without proof that nothing was created is IN DOUBT for the planner, and nothing is opened next to it.
// Neither path is a reason to treat "closed row + open page" as safe: the same combination comes from the other writers (the administrator's decision on a payment, rows the old code closed by the
// clock, a row closed by somebody else while the answer was in flight - B3), and B1 / B3 / B4 close it for all of them.
test('B2 (documented): payment_intent.canceled for a page whose session is KNOWN is verified against the SESSION, which is still open: the row stays open and the same page is handed out - no closed row, no second page', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const pi = await k.sim.seedIntent({ orderId: a.orderId, attemptId: a.attemptId, status: 'canceled', amount: a.total })
  const delivered = await k.deliver({ id: 'evt_SIM_b2_canceled', object: 'event', type: 'payment_intent.canceled', livemode: false, data: { object: { id: pi, object: 'payment_intent', metadata: { orderId: a.orderId, attemptId: a.attemptId } } } })
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json))
  const [row] = await k.attemptsOf(a.orderId)
  assert.deepEqual([row.status, row.stripeSessionId], ['open', a.sessionId], 'the sync did not close the row: the session it verified against is open')
  const r = await k.payAgain(a)
  await k.assertClean('B2 known session')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.url, a.url, 'the same page')
  assert.equal(await k.sim.createdSessions(), 1)
})

test('B2 (documented, control): payment_intent.canceled for a reservation WITHOUT identifier closes the row `failed` - still without identifier - and the planner is in doubt: no page is opened next to it', async () => {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  assert.deepEqual([reservation.status, reservation.stripeSessionId], ['creating', null])
  const [orphan] = await k.sim.sessionsOf(order.id)
  const pi = await k.sim.seedIntent({ orderId: order.id, attemptId: reservation.id, status: 'canceled', amount: first.total })
  const delivered = await k.deliver({ id: 'evt_SIM_b2_orphan', object: 'event', type: 'payment_intent.canceled', livemode: false, data: { object: { id: pi, object: 'payment_intent', metadata: { orderId: order.id, attemptId: reservation.id } } } })
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json))
  const [row] = await k.attemptsOf(order.id)
  assert.deepEqual([row.status, row.stripeSessionId, row.failureReason], ['failed', null, 'payment_canceled'])
  const r = await k.payAgain({ ...first, orderId: order.id })
  assert.equal(r.status, 503, r.text)
  assert.equal(r.json?.code, 'RESERVATION_UNRESOLVED')
  assert.equal(await k.sim.createdSessions(), 1, 'nothing is opened next to the page nobody can name')
  assert.deepEqual(await k.sim.payable(order.id), [orphan.id], 'the orphan is still payable at the provider - and nobody was ever handed its address')
})

// ====================================================================================================================================================================
// B3 - the row changes WHILE the request is talking to the provider
// ====================================================================================================================================================================
test('B3: the row is moved to failed WHILE the request reads the page (retrieve in flight): the page it read is open - it is closed with proof before any other page is made', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const held = gate('retrieve in flight', { timeoutMs: 5000 })
  k.sim.hooks.beforeRetrieve = (_id, params) => ((params as any)?.expand?.length ? Promise.resolve() : held.pass())
  const request = k.payAgain(a)
  await holdUntilReached(held, request)
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'failed', failureReason: 'payment_canceled' } })   // a transition that touches the row and not the page
  held.release()
  const r = await request
  k.sim.hooks = {}
  await k.assertClean('B3')
  assert.equal(r.status, 200, r.text)
  assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
  await assertReplacedWithProof(a, 'failed', 'B3')
})

test('B3: the row is closed AND the order is cancelled WHILE the request reads the page: the answer is "not payable", and the page it read - open at the provider - is closed with proof BEFORE the answer', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const held = gate('retrieve in flight', { timeoutMs: 5000 })
  k.sim.hooks.beforeRetrieve = (_id, params) => ((params as any)?.expand?.length ? Promise.resolve() : held.pass())
  const request = k.payAgain(a)
  await holdUntilReached(held, request)
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'failed', failureReason: 'payment_canceled' } })
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  held.release()
  const r = await request
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'the page that was read is not left payable on an order that is cancelled')
  assert.equal(await k.sim.createdSessions(), 1, 'no other page was made')
  const [row] = await k.attemptsOf(a.orderId)
  assert.equal(row.stripeSessionId, a.sessionId)
  assert.match(row.failureReason ?? '', /^closed_by_us:/, 'and its row carries the proof')
})

test('B3 control: the row is moved to PROCESSING (money may be moving) WHILE the request reads the page: the page is NOT closed, nothing is opened, the identifier is kept', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const held = gate('retrieve in flight', { timeoutMs: 5000 })
  k.sim.hooks.beforeRetrieve = (_id, params) => ((params as any)?.expand?.length ? Promise.resolve() : held.pass())
  const request = k.payAgain(a)
  await holdUntilReached(held, request)
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'processing' } })
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { paymentStatus: 'processing' } })
  held.release()
  const r = await request
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  assert.equal(await k.sim.countOps('expire.call'), 0, 'the page of a payment that may be moving is not closed')
  assert.equal(await k.sim.createdSessions(), 1)
  const [row] = await k.attemptsOf(a.orderId)
  assert.deepEqual([row.status, row.stripeSessionId], ['processing', a.sessionId])
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId])
})

test('B3: the reservation row is closed WHILE the provider makes its page (the answer is in flight): the page that was made is closed with proof before the next one; never two payable', async () => {
  const held = gate('answer in flight', { timeoutMs: 5000 })
  k.sim.hooks.duringCreate = () => held.pass()
  const first = k.startCheckout(k.newBrowser(), { allowFailure: true })
  await holdUntilReached(held, first)
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  await k.prisma.paymentAttempt.update({ where: { id: reservation.id }, data: { status: 'failed', failureReason: 'payment_canceled' } })   // closed by somebody else while the answer was in flight
  held.release()
  const r = await first
  k.sim.hooks = {}
  await k.assertClean('B3 create')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const attempts = await k.attemptsOf(order.id)
  const old = attempts.find((x) => x.id === reservation.id)!
  assert.ok(old.stripeSessionId, 'the identifier of the page that was made is recorded on the closed row')
  assert.match(old.failureReason ?? '', /^closed_by_us:/, 'and the page is proved closed')
  assert.equal((await k.sim.payable(order.id)).length, 1, 'one payable page - the successor')
  assert.notEqual(k.sessionIdOf(r.json.url), old.stripeSessionId, 'the customer is handed the successor, not the page of the closed row')
  assert.equal(liveAttempts(attempts).length, 1)
})

// ====================================================================================================================================================================
// B4 - money, and what can not be read
// ====================================================================================================================================================================
test('B4: the page of a closed row has been PAID (the database does not know): nothing is opened, the payment is recorded by the payment sync, once', async () => {
  const a = await closedRowOpenSession('failed', 'payment_canceled')
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)            // the customer paid; the webhook has not arrived
  const r = await k.payAgain(a)
  await k.assertClean('B4')
  assert.equal(r.status, 409, r.text)
  assert.equal(await k.sim.createdSessions(), 1, 'no other page was made')
  assert.equal(await k.sim.countOps('create.call'), 1)
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
  assert.equal(order.paymentStatus, 'paid', 'the payment was verified and recorded')
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  assert.ok(Object.values(k.effects).every((n) => n <= 1), `the effects of a payment ran at most once: ${JSON.stringify(k.effects)}`)
  const old = (await k.attemptsOf(a.orderId))[0]
  assert.equal(old.stripeSessionId, a.sessionId, 'the identifier is not lost')
})

test('B4: the closing of the page can not be PROVED (the provider is unreachable): 503, nothing is opened, nothing is written on the row; the next request, with the provider back, closes it and goes on', async () => {
  const a = await closedRowOpenSession('failed', 'payment_failed')
  k.sim.faults.expireUnreachable = 5
  k.sim.faults.retrieveUnreachable = 5
  const down = await k.payAgain(a)
  assert.equal(down.status, 503, down.text)
  assert.equal(down.json?.code, 'PAYMENT_PAGE_CLOSE_UNCONFIRMED')
  assert.equal(await k.sim.countOps('create.call'), 1, 'no other page was made')
  const [row] = await k.attemptsOf(a.orderId)
  assert.deepEqual([row.status, row.failureReason, row.stripeSessionId], ['failed', 'payment_failed', a.sessionId], 'the row is exactly as it was')
  k.sim.faults.expireUnreachable = 0
  k.sim.faults.retrieveUnreachable = 0
  const up = await k.payAgain(a)
  await k.assertClean('B4 unreachable')
  assert.equal(up.status, 200, up.text)
  assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
  await assertReplacedWithProof(a, 'failed', 'B4 unreachable')
})

test('B4: the provider says "open" after a failed expire (an inconclusive read): the closing is NOT proved - nothing is opened', async () => {
  const a = await closedRowOpenSession('failed', 'payment_failed')
  k.sim.faults.expireUnreachable = 5
  k.sim.faults.retrieveInconclusive = 5           // the read answers `open` whatever the session is
  const r = await k.payAgain(a)
  assert.equal(r.status, 503, r.text)
  assert.equal(await k.sim.countOps('create.call'), 1)
  const [row] = await k.attemptsOf(a.orderId)
  assert.deepEqual([row.status, row.failureReason], ['failed', 'payment_failed'])
})

test('B4: the customer PAYS the page while its closing is in flight (expire not yet executed): the expire is refused, the read shows "complete" - nothing is opened, the payment is recorded once', async () => {
  const a = await closedRowOpenSession('failed', 'payment_canceled')
  const held = gate('expire in flight', { timeoutMs: 5000 })
  k.sim.hooks.duringExpire = () => held.pass()
  const request = k.payAgain(a)
  await holdUntilReached(held, request)
  await k.customerPays(a.sessionId)                  // pays and the webhook arrives
  held.release()
  const r = await request
  k.sim.hooks = {}
  await k.assertClean('B4 race')
  assert.equal(r.status, 409, r.text)
  assert.equal(await k.sim.createdSessions(), 1, 'no other page was made')
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
  assert.equal(order.paymentStatus, 'paid')
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  assert.ok(Object.values(k.effects).every((n) => n <= 1), `the effects of a payment ran at most once: ${JSON.stringify(k.effects)}`)
})

// ====================================================================================================================================================================
// B5 - the places that must NOTICE such a row: the confirmation page, the webhook
// ====================================================================================================================================================================
test('B5: the customer looks at the confirmation page of an order that was CANCELLED and holds a closed row with an open page: the page is closed at the provider, with proof', async () => {
  const a = await closedRowOpenSession('failed', 'payment_canceled')
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { status: 'cancelled' } })
  await k.getStatus(a.orderId, { ...a.who, cookie: a.accessCookie ?? undefined })
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'the page is no longer payable')
  const old = (await k.attemptsOf(a.orderId))[0]
  assert.equal(old.status, 'failed')
  assert.match(old.failureReason ?? '', /^closed_by_us:/)
  assert.equal(old.stripeSessionId, a.sessionId)
})

test('B5: the provider announces that the page expired (checkout.session.expired) for a row the database had closed without proof: the announcement is verified against the provider and the PROOF is written on the row', async () => {
  const a = await closedRowOpenSession('failed', 'payment_failed')
  await k.sim.expire(a.sessionId)
  const delivered = await k.announceExpired(a.sessionId)
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json))
  const [row] = await k.attemptsOf(a.orderId)
  assert.equal(row.status, 'failed', 'the row keeps its status')
  assert.equal(row.failureReason, 'provider_status:expired (was payment_failed)', 'the proof first - that is what is looked for - and what the row said before after it: nothing is lost')
  assert.equal(row.stripeSessionId, a.sessionId)
})

test('B5: a page that runs out of time and is announced (checkout.session.expired): the payment sync moves the row to expired and writes the provider\'s PROOF on it, so that nothing asks about it again', async () => {
  const a = await k.startCheckout(k.newBrowser())
  // (the closing of the other pages, which would also ask about the row, is switched off: what is judged here is what the SYNC writes)
  checkoutPagesHooks.runJob = async () => undefined
  try {
    const delivered = await k.expireNaturally(a.sessionId)
    assert.equal(delivered?.status, 200, JSON.stringify(delivered?.json))
  } finally { checkoutPagesHooks.runJob = null }
  const [row] = await k.attemptsOf(a.orderId)
  assert.deepEqual([row.status, row.failureReason, row.stripeSessionId], ['expired', 'provider_status:expired', a.sessionId])
})

// ====================================================================================================================================================================
// B6 - controls: what must not change
// ====================================================================================================================================================================
for (const status of ['processing', 'mismatch'] as const) {
  test(`B6 control: a ${status} attempt keeps the order blocked: no call to the provider, the identifier is kept`, async () => {
    const a = await k.startCheckout(k.newBrowser())
    await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status } })
    const before = (await k.sim.oplog()).length
    const r = await k.payAgain(a)
    assert.ok(r.status === 409, `${r.status} ${r.text}`)
    assert.equal((await k.sim.oplog()).length, before, 'nothing was asked of the provider')
    const [row] = await k.attemptsOf(a.orderId)
    assert.deepEqual([row.status, row.stripeSessionId], [status, a.sessionId])
  })
}

test('B6 control: a closed row WITH proof (closed_by_us / provider_status:expired) is not asked about again: the next page is made at once', async () => {
  const a = await closedRowOpenSession('expired', 'closed_by_us:replaced')
  await k.sim.expire(a.sessionId)                    // (the premise of the proof: it IS closed)
  const retrievesBefore = await k.sim.countOps('retrieve')
  const expiresBefore = await k.sim.countOps('expire.call')
  const r = await k.payAgain(a)
  await k.assertClean('B6 proven')
  assert.equal(r.status, 200, r.text)
  assert.equal(await k.sim.countOps('retrieve'), retrievesBefore, 'no read of the closed page')
  assert.equal(await k.sim.countOps('expire.call'), expiresBefore, 'no expire of the closed page')
})
