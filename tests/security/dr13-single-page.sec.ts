// DR-13 / F02-bis - ONE payable payment page per order (phase 1: the regression tests, written RED against the code as it is).
//
// What these tests judge is not a particular implementation but the INVARIANTS (docs: DR-13 plan, REVISIONE 1, C3), on the state the faithful stand-in for Stripe really holds
// (tests/security/_stripe-sim.ts) and on what the real routes hand to the customer:
//   V1  an order never has more than one payable session at the provider                          V3  at most one page that was handed out is still payable
//   V2  a page is handed out only if it is registered on a live attempt                           V4  a page is never handed out for an order that is not payable
//   I-3 while a reservation is uncertain nothing is opened next to it: no new attempt, no new session
// "Every payable session is known to the database" is NOT asked: between the provider's `create` and the database write a session unknown to the database exists, and that is accepted;
// what is not accepted is handing it out or opening a second one next to it.
// Time passes by moving the clock (tests/security/_clock.ts), never by editing rows: an edited `expiresAt` would be another request.
//
// The tests that describe behaviour the code ALREADY has are marked "control": they must be green before and after the fix.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, SESSION_TTL_MS, type Kit } from './_dr13-kit'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { allowLegacyTwins } from './_live-page-index'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); checkoutSessionHooks.withoutFollowUp = false; checkoutSessionHooks.afterLoad = null })
test.after(async () => { await k.fresh(); await k.sim.close() })

const MIN = 60_000
const HOUR = 3_600_000
const jsonCode = (r: { json: any }) => r.json?.code ?? null

// the order of what happened at the provider: the old page must be closed there BEFORE the next one is created
function assertClosedBeforeNextOpened(ops: string[], oldSession: string) {
  const created = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.startsWith('create.executed'))
  assert.ok(created.length >= 2, `a second page was expected: ${ops.join(' | ')}`)
  const closed = ops.indexOf(`expire.executed:${oldSession}`)
  assert.ok(closed >= 0 && closed < created[1].index, `the old page ${oldSession} must be closed at the provider before the next one is created: ${ops.join(' | ')}`)
}
const liveAttempts = (attempts: Array<{ status: string }>) => attempts.filter((a) => a.status === 'creating' || a.status === 'open')

// ====================================================================================================================================================================
// T1 - the page is about to expire and is asked for again
// ====================================================================================================================================================================
for (const left of [30_000, 59_000]) {
  test(`T1: a page with ${left / 1000} s left is asked for again -> the old page is closed AT THE PROVIDER before another is opened; never two payable`, async () => {
    const a = await k.startCheckout(k.newBrowser())
    await k.travel(SESSION_TTL_MS - left)
    const r = await k.payAgain(a)
    await k.assertClean(`T1 ${left}`)
    assert.equal(r.status, 200, r.text)
    assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
    assert.equal((await k.sim.payable(a.orderId)).length, 1)
    const attempts = await k.attemptsOf(a.orderId)
    assert.equal(liveAttempts(attempts).length, 1, `one live attempt: ${JSON.stringify(attempts.map((x) => x.status))}`)
    assert.equal(attempts[0].status, 'expired')
  })
}

test('T1 control: a page with 61 s left (more than the 60 s margin) is handed out again: the same page, nothing closed, no second session', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 61_000)
  const r = await k.payAgain(a)
  await k.assertClean('T1 control')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.url, a.url)
  assert.equal(await k.sim.createdSessions(), 1)
  assert.equal(await k.sim.countOps('expire.executed'), 0)
})

test('T1: the database thinks the page is over but the provider still has it open (its expiry is later) -> it is still closed at the provider first', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS + 10_000)
  await k.sim.expiresIn(a.sessionId, 25_000)   // the provider's page lives on: the database is behind
  const r = await k.payAgain(a)
  await k.assertClean('T1 lag')
  assert.equal(r.status, 200, r.text)
  assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
})

// ====================================================================================================================================================================
// T2 - a reservation whose outcome is not known (lost answer, stored 500, request that never arrived)
// ====================================================================================================================================================================
async function lostFirstRequest(fault: 'createLostAnswer' | 'createStored500Created' | 'createStored500NotCreated' | 'createUnreachable') {
  k.sim.faults[fault] = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.ok(first.status === 502 || first.status === 503, `the first request was answered ${first.status} ${JSON.stringify(first.json)}`)
  const order = await k.onlyOrder()
  const attempts = await k.attemptsOf(order.id)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].status, 'creating', 'the reservation is written before the provider is called')
  assert.equal(attempts[0].stripeSessionId, null)
  return { first, order, reservation: attempts[0] }
}

test('T2 control: the answer is lost and the customer retries at once (inside the join window) -> the SAME page comes back', async () => {
  const { first, order } = await lostFirstRequest('createLostAnswer')
  const r = await k.payAgain({ ...first, orderId: order.id })
  await k.assertClean('T2 control')
  assert.equal(r.status, 200, r.text)
  assert.equal(await k.sim.createdSessions(), 1)
  assert.equal(liveAttempts(await k.attemptsOf(order.id)).length, 1)
})

for (const waitMs of [100_000, 5 * MIN]) {
  for (const optimistic of [true, false]) {
    test(`T2: the answer is lost and the customer is back ${waitMs / 1000} s later (replay of a saved result ${optimistic ? 'is honoured' : 'is re-validated'} by the provider) -> the reservation is RESOLVED, never closed by the clock; never a second page`, async () => {
      k.sim.options.replayRevalidatesExpiresAt = !optimistic
      const { first, order } = await lostFirstRequest('createLostAnswer')
      await k.travel(waitMs)
      const r = await k.payAgain({ ...first, orderId: order.id })
      await k.assertClean(`T2 ${waitMs}`)
      // whatever the provider answers, no session is opened next to the one that may exist
      assert.equal(await k.sim.createdSessions(), 1, 'a second session was created next to the one the lost answer may have left')
      const attempts = await k.attemptsOf(order.id)
      assert.equal(attempts.length, 1, `no second attempt: ${JSON.stringify(attempts.map((x) => [x.status, x.failureReason]))}`)
      assert.notEqual(attempts[0].failureReason, 'stale_reservation')
      if (r.status === 200) assert.equal(k.sessionIdOf(r.json.url), (await k.sim.sessionsOf(order.id))[0].id, 'the page that comes back is the one the provider made')
      else { assert.equal(r.status, 503, r.text); assert.equal(attempts[0].status, 'creating') }
      if (optimistic) assert.equal(r.status, 200, 'with a provider that honours the saved result the reservation resolves to its own page')
    })
  }
}

test('T2: the request never reached the provider and the customer is back 5 minutes later -> an uncertain reservation is NOT released without proof (the server cannot know nothing was created)', async () => {
  const { first, order } = await lostFirstRequest('createUnreachable')
  await k.travel(5 * MIN)
  const r = await k.payAgain({ ...first, orderId: order.id })
  await k.assertClean('T2 unreachable')
  const attempts = await k.attemptsOf(order.id)
  assert.equal(attempts.length, 1, `no second attempt: ${JSON.stringify(attempts.map((x) => [x.status, x.failureReason]))}`)
  assert.equal(r.status, 503, r.text)
  assert.equal(jsonCode(r), 'RESERVATION_UNRESOLVED')
  assert.equal(attempts[0].status, 'creating')
})

test('T2: the request never reached the provider and the customer is back 100 s later -> the SAME reservation is replayed (still a valid new request): one attempt, one page', async () => {
  const { first, order } = await lostFirstRequest('createUnreachable')
  await k.travel(100_000)
  const r = await k.payAgain({ ...first, orderId: order.id })
  await k.assertClean('T2 unreachable 100s')
  assert.equal(r.status, 200, r.text)
  const attempts = await k.attemptsOf(order.id)
  assert.equal(attempts.length, 1, `no second attempt: ${JSON.stringify(attempts.map((x) => [x.status, x.failureReason]))}`)
  assert.equal(attempts[0].status, 'open')
})

// the replay horizon: 2 minutes, 35 minutes, 23 hours, 24 hours, days. A stored 500 may or may not have created a session; the key may be gone after a day.
for (const [label, wait, sends] of [['2 minutes', 2 * MIN, 2], ['35 minutes', 35 * MIN, 2], ['23 hours and 1 minute', 23 * HOUR + MIN, 1], ['24 hours', 24 * HOUR, 1], ['3 days', 72 * HOUR, 1]] as const) {
  for (const fault of ['createStored500Created', 'createStored500NotCreated'] as const) {
    test(`T2 horizon: a reservation with a stored 500 (${fault === 'createStored500Created' ? 'a session exists' : 'nothing exists'}) found again after ${label} -> blocked, no second page, ${sends === 1 ? 'NO request is sent at all' : 'one replay at most'}`, async () => {
      const { first, order } = await lostFirstRequest(fault)
      await k.travel(wait)
      const r = await k.payAgain({ ...first, orderId: order.id })
      await k.assertClean(`T2 horizon ${label}`)
      assert.equal(r.status, 503, `${r.status} ${r.text}`)
      assert.equal(jsonCode(r), 'RESERVATION_UNRESOLVED')
      const attempts = await k.attemptsOf(order.id)
      assert.equal(attempts.length, 1)
      assert.equal(attempts[0].status, 'creating')
      assert.equal(await k.sim.createdSessions(), fault === 'createStored500Created' ? 1 : 0)
      assert.ok((await k.sim.countOps('create.call')) <= sends, `at most ${sends} request(s) to the provider, saw ${await k.sim.countOps('create.call')}`)
    })
  }
}

// ====================================================================================================================================================================
// TOCTOU - the world changes between the decision and the hand-out
// ====================================================================================================================================================================
test('TOCTOU: the order is paid WHILE the provider creates its first page -> that page is not handed out, and it is closed at the provider', async () => {
  k.sim.hooks.duringCreate = async () => {
    const order = await k.onlyOrder()
    await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date() } })
  }
  const r = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  await k.assertClean('TOCTOU first')
  assert.notEqual(r.status, 200, 'a payable page was handed out for an order that is already paid')
  assert.deepEqual(await k.sim.payable(order.id), [], 'the page that was created behind the payment is still payable at the provider')
})

test('TOCTOU: the order is paid WHILE the provider creates the replacement of a page at the margin -> the replacement is not handed out and is closed at the provider', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 30_000)
  k.sim.hooks.duringCreate = async () => {
    await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date() } })
  }
  const r = await k.payAgain(a)
  await k.assertClean('TOCTOU margin')
  assert.notEqual(r.status, 200, 'a payable page was handed out for an order that is already paid')
  assert.deepEqual(await k.sim.payable(a.orderId), [])
})

test('TOCTOU: the customer pays the old page at the very moment it is being closed -> the payment wins, no second page, the order is not payable any more', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 30_000)
  k.sim.hooks.duringExpire = async (id) => { await k.customerPays(id) }
  const r = await k.payAgain(a)
  await k.assertClean('TOCTOU pay vs expire')
  assert.equal(r.status, 409, r.text)
  assert.equal(jsonCode(r), 'ORDER_NOT_PAYABLE')
  assert.ok(['paid', 'processing'].includes(r.json.reason), r.text)
  assert.equal(await k.sim.createdSessions(), 1, 'a second page was opened although the first one was paid')
  assert.equal(k.effects.printlab, 1)
})

// ====================================================================================================================================================================
// COUNT - the update that completes a reservation does not say whether it changed anything
// ====================================================================================================================================================================
test('COUNT: a slow request finishes after another one dealt with its reservation -> it must not hand out a page nobody registered; never two pages', async () => {
  const who = k.newBrowser()
  const cart = k.cart()
  const quote = await k.post('quote', cart, who)
  const key = k.newKey('count')
  const body = { checkoutKey: key, expectedTotalCents: quote.json.totalCents, ...cart }
  k.sim.faults.createDelayMs = 700
  k.sim.faults.delayFirstCreateOnly = true
  const slow = k.post('session', body, who)
  await k.sleep(250)                      // the first request is inside the provider call
  await k.travel(100_000)                 // ... and its reservation is now older than the join window
  const second = await k.post('session', body, who)
  const first = await slow
  const order = await k.onlyOrder()
  for (const r of [first, second]) await k.observe(order.id, r)
  await k.assertClean('COUNT')
  assert.equal(await k.sim.createdSessions(), 1, 'a second session was created')
  const delivered = [first, second].filter((r) => r.status === 200).map((r) => k.sessionIdOf(r.json.url))
  assert.equal(new Set(delivered).size, Math.min(1, delivered.length), `two different pages were handed out: ${delivered.join(', ')}`)
})

// ====================================================================================================================================================================
// MISMATCH - a payment that did not match is waiting for a person
// ====================================================================================================================================================================
test('MISMATCH: an attempt that is "mismatch" blocks a new page even when the order carries no review reason', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'mismatch' } })
  const r = await k.payAgain(a)
  assert.equal(r.status, 409, r.text)
  assert.equal(jsonCode(r), 'ORDER_NOT_PAYABLE')
  assert.equal(r.json.reason, 'review')
  assert.equal(await k.sim.createdSessions(), 1, 'a second page was opened next to a payment that waits for a person')
})

// ====================================================================================================================================================================
// WEBHOOK - the provider's announcement of an expiry must not cancel an order that is not over
// ====================================================================================================================================================================
test('WEBHOOK: a page closed EARLY (an operator, or our own replacement) is announced as expired -> the order is NOT cancelled', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.sim.expire(a.sessionId)                // 30 minutes before its natural end
  const delivered = await k.announceExpired(a.sessionId)
  assert.equal(delivered.status, 200)
  const snap = await k.snapshot(a.orderId)
  assert.equal(snap.order.status, 'awaiting_payment', `the order was cancelled for a page that was closed early: ${JSON.stringify(snap.order)}`)
  assert.equal(snap.attempts[0].status, 'expired')
})

test('WEBHOOK control: a page that expires NATURALLY with nothing else live -> the order is cancelled, as before', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const delivered = await k.expireNaturally(a.sessionId)
  assert.equal(delivered?.status, 200)
  const snap = await k.snapshot(a.orderId)
  assert.equal(snap.order.status, 'cancelled')
  assert.equal(snap.order.cancellation, 'checkout_expired')
})

test('WEBHOOK: a page expires naturally while another reservation of the order is still UNRESOLVED -> the order is NOT cancelled (the reservation may hold a page)', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  await allowLegacyTwins(k.prisma) // (an open page AND a reservation of one order: what the old code could leave; the database refuses it otherwise)
  await k.prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: order.totalCents, currency: order.currency, status: 'creating', expiresAt: new Date(Date.now() + SESSION_TTL_MS), createdAt: new Date(Date.now() - 300_000) } })
  await k.expireNaturally(a.sessionId)
  const snap = await k.snapshot(a.orderId)
  assert.equal(snap.order.status, 'awaiting_payment', `the order was cancelled while a reservation was unresolved: ${JSON.stringify(snap.attempts)}`)
})

test('WEBHOOK: the expiry announcement overtakes our own replacement of the page (early close) -> the order is not cancelled, exactly one page is payable afterwards', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 30_000)
  k.sim.hooks.afterExpire = async (id) => { await k.announceExpired(id) }   // the provider's webhook is processed before our own code goes on
  const r = await k.payAgain(a)
  await k.assertClean('WEBHOOK during retire')
  assert.equal(r.status, 200, r.text)
  const snap = await k.snapshot(a.orderId)
  assert.equal(snap.order.status, 'awaiting_payment')
  assert.equal(snap.payable.length, 1)
  assert.ok(await k.sim.countOps('expire.executed') >= 1, 'the old page was never closed by us')
})

test('WEBHOOK: the page is one second from its natural end when it is replaced and the announcement overtakes us -> either the order is over and nothing is payable, or ONE new page exists and the order is alive; never a cancelled order with a live page', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.travel(SESSION_TTL_MS - 1_000)
  k.sim.hooks.afterExpire = async (id) => { await k.announceExpired(id) }
  const r = await k.payAgain(a)
  await k.assertClean('WEBHOOK natural during retire')
  const snap = await k.snapshot(a.orderId)
  if (snap.order.status === 'cancelled') {
    assert.deepEqual(snap.payable, [], 'a cancelled order has a payable page')
    assert.notEqual(r.status, 200)
  } else {
    assert.equal(snap.order.status, 'awaiting_payment')
    assert.equal(snap.payable.length, 1)
    assert.equal(r.status, 200, r.text)
  }
})

// ====================================================================================================================================================================
// LEGACY - what the old code left behind is not automatically safe
// ====================================================================================================================================================================
async function legacyStaleReservation() {
  const a = await k.startCheckout(k.newBrowser())
  // the old code closed a reservation by the clock: "expired / stale_reservation", no identifier; the page it may have held is, in this scenario, one the database never learned about
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: null } })
  return a
}

test('LEGACY: an old "expired / stale_reservation" attempt without a Stripe identifier, long past its TTL and grace, blocks a new page; the row is left exactly as it was', async () => {
  const a = await legacyStaleReservation()
  await k.travel(3 * HOUR)
  const before = await k.attemptsOf(a.orderId)
  const r = await k.payAgain(a)
  await k.assertClean('LEGACY')
  assert.ok(r.status === 503 || r.status === 409, `a new page was opened over a financial state nobody can prove: ${r.status} ${r.text}`)
  assert.equal(await k.sim.createdSessions(), 1, 'a new session was created')
  const after = await k.attemptsOf(a.orderId)
  assert.deepEqual(after.map((x) => [x.id, x.status, x.failureReason, x.stripeSessionId]), before.map((x) => [x.id, x.status, x.failureReason, x.stripeSessionId]), 'the historical row was altered or a row was added')
})

test('LEGACY: the same uncertain row next to a page the database KNOWS and that is nearly over -> that page is handed out again; nothing is closed and nothing new is opened', async () => {
  const a = await legacyStaleReservation()
  await k.sim.expire(a.sessionId)               // the orphan of the old reservation is, in this scenario, closed at the provider
  const order = await k.onlyOrder()
  const successor = await k.prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: order.totalCents, currency: order.currency, status: 'open', expiresAt: new Date(Date.now() + 30_000) } })
  const sessionId = await k.sim.seedSession({ orderId: order.id, attemptId: successor.id, legacy: true, expiresInMs: 30_000, amount: order.totalCents, currency: order.currency.toLowerCase() })
  await k.prisma.paymentAttempt.update({ where: { id: successor.id }, data: { stripeSessionId: sessionId } })
  const r = await k.payAgain({ ...a, orderId: order.id })
  await k.assertClean('LEGACY successor')
  assert.equal(r.status, 200, r.text)
  assert.equal(k.sessionIdOf(r.json.url), sessionId, 'the page the database knows is handed out again')
  assert.equal(await k.sim.countOps('expire.executed'), 1, 'only the orphan was closed (by the test)')
  assert.equal(await k.sim.createdSessions(), 2, 'a new session was opened next to an uncertain row')
})

// ====================================================================================================================================================================
// SIBLINGS - when one page is paid, the others of the order are closed at the provider
// ====================================================================================================================================================================
async function orderWithTwinPage() {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  const { twin, sessionId: twinSession } = await k.addLegacyTwin(order.id)
  return { a, order, twin, twinSession }
}

test('SIBLINGS: an order with two live pages (made by the old code) is paid on one -> the other is closed at the provider, once, and nothing is produced twice', async () => {
  const { a, order, twin, twinSession } = await orderWithTwinPage()
  assert.equal((await k.sim.payable(order.id)).length, 2, 'the premise: two payable pages')
  const paid = await k.customerPays(a.sessionId)
  assert.equal(paid.paid, true)
  assert.equal(paid.delivered?.status, 200)
  const left = await k.waitFor('the twin page to be closed', () => k.sim.payable(order.id), (payable) => payable.length === 0, 4000)
  assert.deepEqual(left, [], `the page ${twinSession} of the paid order is still payable`)
  const closed = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })
  assert.equal(closed.status, 'expired')
  assert.match(closed.failureReason ?? '', /closed_by_us:order_paid/)
  assert.deepEqual({ ...k.effects }, { printlab: 1, discord: 1, push: 1, inventory: 0, receipt: 1 })
})

test('SIBLINGS: closing the twin FAILS (the provider is unreachable) -> the payment is recorded all the same, the twin stays a visible live row, and the next sign of life of the order closes it', async () => {
  const { a, order, twin, twinSession } = await orderWithTwinPage()
  k.sim.faults.expireUnreachable = 50
  const paid = await k.customerPays(a.sessionId)
  assert.equal(paid.delivered?.status, 200)
  const snap = await k.snapshot(order.id)
  assert.equal(snap.order.paymentStatus, 'paid')
  assert.deepEqual({ ...k.effects }, { printlab: 1, discord: 1, push: 1, inventory: 0, receipt: 1 }, 'the main payment must not be affected by the failure of the closure')
  await k.sleep(300)
  const stuck = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })
  assert.equal(stuck.status, 'open', 'the unfinished closure must stay VISIBLE as a live attempt of a paid order (nothing is forgotten)')
  // the provider answers again; the customer lands on the confirmation page (a status read) -> the closure is retried
  k.sim.faults.expireUnreachable = 0
  const status = await k.getStatus(order.id, { ...a.who, cookie: a.accessCookie ?? undefined }, true)
  assert.equal(status.status, 200)
  const left = await k.waitFor('the twin page to be closed', () => k.sim.payable(order.id), (payable) => payable.length === 0, 4000)
  assert.deepEqual(left, [], `the page ${twinSession} is still payable after the retry`)
})

// ====================================================================================================================================================================
// COMPLETE - the provider says the customer paid, and the reservation is still "creating"
// ====================================================================================================================================================================
test('COMPLETE: the page of a reservation that was never registered is found PAID at the provider -> the attempt becomes "processing" with its session id, no page is handed out, no second page', async () => {
  checkoutSessionHooks.withoutFollowUp = true   // this test looks at what the REQUEST leaves behind; the payment sync that follows it has its own tests (dr13-payments)
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  const [orphan] = await k.sim.sessionsOf(order.id)
  assert.equal((await k.sim.pay(orphan.id)).paid, true)   // paid out of band; no webhook has arrived yet
  const r = await k.payAgain({ ...first, orderId: order.id })
  assert.equal(r.status, 409, `a page was handed out for a session that is already paid: ${r.status} ${r.text}`)
  assert.equal(r.json.reason, 'processing')
  const attempts = await k.attemptsOf(order.id)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].status, 'processing')
  assert.equal(attempts[0].stripeSessionId, orphan.id, 'the identifier of the session must not be lost')
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).financialRevision, 1, 'entering "processing" is a financial move: the revision goes up, once')
  assert.equal(await k.sim.createdSessions(), 1)
  // and it is only the verified payment handling that may call it paid
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus, 'pending')
})

test('COMPLETE control: an OPEN attempt whose page is found paid at the provider becomes "processing" (the revision goes up once) and blocks a new page', async () => {
  checkoutSessionHooks.withoutFollowUp = true   // this test looks at what the REQUEST leaves behind; the payment sync that follows it has its own tests (dr13-payments)
  const a = await k.startCheckout(k.newBrowser())
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)
  const r = await k.payAgain(a)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.reason, 'processing')
  const attempts = await k.attemptsOf(a.orderId)
  assert.equal(attempts[0].status, 'processing')
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })).financialRevision, 1)
  assert.equal(await k.sim.createdSessions(), 1)
})
