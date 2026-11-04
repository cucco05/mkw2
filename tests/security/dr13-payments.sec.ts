// DR-13 phase 4: what happens to the OTHER pages of an order when one of them is paid (lib/checkout-pages.ts, called by lib/payment-sync.ts and by the confirmation page), the double
// payment that can still happen, and what the payments of old rows do. Against the faithful stand-in for Stripe (tests/security/_stripe-sim.ts).
//   * the closing is idempotent, never recurses, never stops the main payment from being recorded, and never repeats the effects of a payment;
//   * a closing that fails is not forgotten: the row of the unclosed page is the record, and the next sign of life of the order takes it up again;
//   * a page found PAID while it was being closed is money: it goes to the verified payment handling, which records a duplicate - never a lost payment;
//   * no refund is made here or anywhere in DR-13.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, SESSION_TTL_MS, type Kit } from './_dr13-kit'
import { closePagesOfOrder } from '../../lib/checkout-pages'
import { allowLegacyTwins } from './_live-page-index'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh() })
test.after(async () => { await k.fresh(); await k.sim.close() })

const ONCE = { printlab: 1, discord: 1, push: 1, inventory: 0, receipt: 1 }

// an order with two live pages, the situation the old code could leave (the new code never makes it)
async function orderWithTwinPage() {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  const { twin, sessionId: twinSession } = await k.addLegacyTwin(order.id)
  return { a, order, twin, twinSession }
}

test('DOUBLE PAYMENT that the closing could not prevent: both pages are paid at the provider before any webhook -> both payments are recorded, the second as a duplicate waiting for a person; nothing is produced twice; nothing loops', async () => {
  const { a, order, twin, twinSession } = await orderWithTwinPage()
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)
  assert.equal((await k.sim.pay(twinSession)).paid, true)
  const delivered = await k.deliver(await k.sim.sessionEvent('checkout.session.completed', a.sessionId))
  assert.equal(delivered.status, 200)
  const second = await k.waitFor('the second payment to be recorded', async () => (await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })).status, (status) => status === 'paid', 6000)
  assert.equal(second, 'paid')
  const snap = await k.snapshot(order.id)
  assert.equal(snap.order.paymentStatus, 'paid')
  assert.equal(snap.order.review, 'duplicate_payment', 'the second payment waits for a person')
  assert.deepEqual(snap.attempts.map((x) => x.status), ['paid', 'paid'])
  assert.deepEqual({ ...k.effects }, ONCE, 'production, notifications and receipt happen once')
  await k.sleep(400)   // whatever could still be running in the background
  const reads = (await k.opNames()).filter((op) => op === `retrieve:${twinSession}`).length
  assert.ok(reads <= 8, `the second page was read ${reads} times: something loops`)
  assert.equal(await k.prisma.refundOperation.count({ where: { orderId: order.id } }), 0, 'no refund is made, here or anywhere')
  assert.deepEqual({ ...k.effects }, ONCE)
})

test('IDEMPOTENT: closing the pages of a paid order twice, and at the same time, closes each page once and changes nothing the second time', async () => {
  const { a, order, twin, twinSession } = await orderWithTwinPage()
  await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date(), stripePaymentIntentId: 'pi_test_other_means' } })
  const [one, two] = await Promise.all([closePagesOfOrder(order.id), closePagesOfOrder(order.id)])
  assert.equal([one, two].filter((r) => r.skipped === 'reentrant').length, 1, 'the second, nested call returns at once')
  assert.deepEqual(await k.sim.payable(order.id), [])
  const rows = await k.prisma.paymentAttempt.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(rows.map((r) => r.status), ['expired', 'expired'])
  assert.ok(rows.every((r) => /^closed_by_us:order_/.test(r.failureReason ?? '')))
  const closedOnce = await k.sim.countOps('expire.executed')
  assert.equal(closedOnce, 2, 'each page was closed once')
  const third = await closePagesOfOrder(order.id)
  assert.deepEqual({ closed: third.closed, complete: third.complete, unconfirmed: third.unconfirmed }, { closed: 0, complete: 0, unconfirmed: 0 })
  assert.equal(await k.sim.countOps('expire.executed'), closedOnce, 'nothing more was asked of the provider')
  void a; void twin; void twinSession
})

test('ISOLATION: an unexpected error while closing the twin does not touch the payment; the twin stays a visible live row; the next sign of life closes it', async () => {
  const { a, order, twin, twinSession } = await orderWithTwinPage()
  k.sim.hooks.duringExpire = async () => { throw new TypeError('boom: something nobody expected') }
  const paid = await k.customerPays(a.sessionId)
  assert.equal(paid.delivered?.status, 200)
  await k.sleep(300)
  const snap = await k.snapshot(order.id)
  assert.equal(snap.order.paymentStatus, 'paid')
  assert.deepEqual({ ...k.effects }, ONCE)
  const stuck = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: twin.id } })
  assert.equal(stuck.status, 'open', 'not forgotten: it is a live row of a paid order')
  assert.deepEqual(await k.sim.payable(order.id), [twinSession])
  k.sim.hooks.duringExpire = undefined
  const again = await closePagesOfOrder(order.id)
  assert.equal(again.closed, 1)
  assert.deepEqual(await k.sim.payable(order.id), [])
})

test('A CANCELLED order with a live page: the page is closed at the next sign of life of the order (the confirmation page reads it)', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId], 'the premise: a cancelled order whose page is still payable')
  const status = await k.getStatus(a.orderId, { ...a.who, cookie: a.accessCookie ?? undefined })
  assert.equal(status.status, 200)
  const left = await k.waitFor('the page to be closed', () => k.sim.payable(a.orderId), (payable) => payable.length === 0, 4000)
  assert.deepEqual(left, [])
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  assert.equal(row.status, 'expired')
  assert.equal(row.failureReason, 'closed_by_us:order_cancelled')
})

test('A RESERVATION with no identifier on a paid order can not be closed: it is left exactly as it is, visible, and nothing is sent', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  await allowLegacyTwins(k.prisma) // (an open page AND a reservation of one order: what the old code could leave)
  const reservation = await k.prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: order.totalCents, currency: order.currency, status: 'creating', expiresAt: new Date(Date.now() + SESSION_TTL_MS), createdAt: new Date(Date.now() - 600_000) } })
  await k.customerPays(a.sessionId)
  await k.sleep(300)
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: reservation.id } })
  assert.deepEqual([row.status, row.stripeSessionId, row.failureReason], ['creating', null, null])
  const result = await closePagesOfOrder(order.id)
  assert.equal(result.reservationsWithoutIdentifier, 1)
  assert.equal(await k.sim.countOps('create.call'), 1, 'nothing was sent for it')
})

test('HISTORICAL: the payment of a page the old code had closed by the clock (the database never learned its identifier) is recorded on that row, the order is paid, the other page is closed, nothing is produced twice', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const order = await k.onlyOrder()
  const old = await k.prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: order.totalCents, currency: order.currency, status: 'expired', failureReason: 'stale_reservation', expiresAt: new Date(Date.now() - 3_600_000), createdAt: new Date(Date.now() - 7_200_000) } })
  const orphan = await k.sim.seedSession({ orderId: order.id, attemptId: old.id, legacy: true, amount: order.totalCents, currency: order.currency.toLowerCase() })
  const paid = await k.customerPays(orphan)
  assert.equal(paid.delivered?.status, 200)
  const left = await k.waitFor('the other page to be closed', () => k.sim.payable(order.id), (payable) => payable.length === 0, 4000)
  assert.deepEqual(left, [], 'the page the customer was given is closed')
  const snap = await k.snapshot(order.id)
  assert.equal(snap.order.paymentStatus, 'paid')
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: old.id } })
  assert.equal(row.stripeSessionId, orphan, 'the identifier is recorded on the row it belongs to')
  assert.equal(row.status, 'expired', 'the row is not reopened')
  assert.ok(row.stripePaymentIntentId, 'but the payment is recorded on it')
  assert.deepEqual({ ...k.effects }, ONCE)
  void a
})

// ====================================================================================================================================================================
// FOLLOW-UP - a page that a REQUEST finds paid is verified and recorded by the payment sync, never by the request
// ====================================================================================================================================================================
test('FOLLOW-UP: a page the request finds PAID at the provider (no webhook yet) is verified and recorded by the payment sync, once -> the order is paid, nothing is produced twice, no new page', async () => {
  const a = await k.startCheckout(k.newBrowser())
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)      // paid out of band: no webhook has arrived
  const r = await k.payAgain(a)                                  // (returns when what it started in the background has ended)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.reason, 'processing', 'the answer is about the moment of the request; the money is not called paid by the request')
  const snap = await k.snapshot(a.orderId)
  assert.equal(snap.order.paymentStatus, 'paid', 'the sync verified the payment against the order')
  assert.deepEqual(snap.attempts.map((x) => x.status), ['paid'])
  assert.deepEqual({ ...k.effects }, ONCE)
  assert.equal(await k.sim.createdSessions(), 1)
  await k.assertClean('FOLLOW-UP')
  // the webhook that arrives afterwards finds everything done: nothing is repeated
  const late = await k.deliver(await k.sim.sessionEvent('checkout.session.completed', a.sessionId))
  assert.equal(late.status, 200)
  assert.deepEqual({ ...k.effects }, ONCE)
  assert.equal((await k.snapshot(a.orderId)).order.review, null, 'the same payment arriving twice is not a duplicate payment')
})

test('FOLLOW-UP: the reservation of a lost answer, whose page was paid: the identifier is written, the payment sync finds the attempt by it and records the payment on THAT attempt', async () => {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  const [orphan] = await k.sim.sessionsOf(order.id)
  assert.equal((await k.sim.pay(orphan.id)).paid, true)
  const r = await k.payAgain({ ...first, orderId: order.id })
  assert.equal(r.status, 409, r.text)
  const attempts = await k.attemptsOf(order.id)
  assert.equal(attempts.length, 1)
  assert.deepEqual([attempts[0].status, attempts[0].stripeSessionId], ['paid', orphan.id])
  assert.equal((await k.snapshot(order.id)).order.paymentStatus, 'paid')
  assert.deepEqual({ ...k.effects }, ONCE)
  assert.equal(await k.sim.createdSessions(), 1)
})

test('FOLLOW-UP fails (the provider is unreachable for the sync) -> the request is answered all the same, the attempt stays "processing" with its identifier (visible, not forgotten), and the next read of the order settles it', async () => {
  const a = await k.startCheckout(k.newBrowser())
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)
  let reads = 0
  k.sim.hooks.beforeRetrieve = async () => { reads++; if (reads === 2) throw new Error('connection reset') }   // the 1st read is the request's own; the 2nd is the sync's
  const r = await k.payAgain(a)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.reason, 'processing')
  const mid = await k.snapshot(a.orderId)
  assert.equal(mid.order.paymentStatus, 'pending', 'nothing is called paid without a verification')
  assert.deepEqual(mid.attempts.map((x) => [x.status, x.session]), [['processing', a.sessionId]])
  assert.deepEqual({ ...k.effects }, { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 })
  k.sim.hooks.beforeRetrieve = undefined
  const status = await k.getStatus(a.orderId, { ...a.who, cookie: a.accessCookie ?? undefined }, true)
  assert.equal(status.status, 200)
  const snap = await k.snapshot(a.orderId)
  assert.equal(snap.order.paymentStatus, 'paid')
  // (the status read starts the after-payment effects in the background)
  assert.deepEqual(await k.waitFor('the effects of the payment', async () => ({ ...k.effects }), (e) => e.printlab === 1 && e.discord === 1 && e.push === 1 && e.receipt === 1), ONCE)
})

// ====================================================================================================================================================================
// WHICH page carries the money - the pages that are closed are the OTHER ones
// ====================================================================================================================================================================
test('PROCESSING with an attempt that carries the payment: the other live page is closed, the carrier is never touched', async () => {
  const { a, order, twin, twinSession } = await orderWithTwinPage()
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'processing' } })
  await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentStatus: 'processing' } })
  const result = await closePagesOfOrder(order.id)
  assert.equal(result.closed, 1)
  assert.deepEqual(await k.sim.payable(order.id), [a.sessionId], 'the page the money is moving on stays exactly as it was')
  const rows = await k.attemptsOf(order.id)
  assert.deepEqual(rows.map((r) => r.status).sort(), ['expired', 'processing'])
  assert.equal(rows.find((r) => r.id === twin.id)!.failureReason, 'closed_by_us:order_processing')
  void twinSession
})

test('PROCESSING, but no attempt says it carries the payment: the page the money is moving on could be ANY live one -> nothing is closed, nothing is sent, the pages stay visible', async () => {
  const { order } = await orderWithTwinPage()
  await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentStatus: 'processing' } })
  const calls = (await k.opNames()).filter((op) => op.startsWith('expire')).length
  const result = await closePagesOfOrder(order.id)
  assert.equal(result.skipped, 'carrier_unknown')
  assert.equal(result.closed, 0)
  assert.equal((await k.sim.payable(order.id)).length, 2)
  assert.equal((await k.opNames()).filter((op) => op.startsWith('expire')).length, calls)
  assert.deepEqual((await k.attemptsOf(order.id)).map((r) => r.status), ['open', 'open'])
})

test('a page that carries the very PaymentIntent the order is tied to is never one of the "other" pages, whatever the order says', async () => {
  const { a, order, twin } = await orderWithTwinPage()
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { stripePaymentIntentId: 'pi_test_the_order_payment' } })
  await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date(), stripePaymentIntentId: 'pi_test_the_order_payment' } })
  const result = await closePagesOfOrder(order.id)
  assert.equal(result.closed, 1)
  const rows = await k.attemptsOf(order.id)
  assert.equal(rows.find((r) => r.id === a.attemptId)!.status, 'open', 'the payment page of the order itself')
  assert.equal(rows.find((r) => r.id === twin.id)!.status, 'expired')
})

test('a REVIEW without any attempt that waits for a person (an order flagged by hand) is the same: nothing is closed', async () => {
  const { order } = await orderWithTwinPage()
  await k.prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: 'amount' } })
  const result = await closePagesOfOrder(order.id)
  assert.equal(result.skipped, 'carrier_unknown')
  assert.equal((await k.sim.payable(order.id)).length, 2)
})

test('an order that can still be paid keeps its page: the closer looks, decides "payable", and closes nothing', async () => {
  const a = await k.startCheckout(k.newBrowser())
  const calls = (await k.opNames()).filter((op) => op.startsWith('expire')).length
  const result = await closePagesOfOrder(a.orderId)
  assert.equal(result.skipped, 'payable')
  assert.equal(result.closed, 0)
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId])
  assert.equal((await k.opNames()).filter((op) => op.startsWith('expire')).length, calls, 'nothing was asked of the provider')
  assert.equal((await k.attemptsOf(a.orderId))[0].status, 'open')
})
