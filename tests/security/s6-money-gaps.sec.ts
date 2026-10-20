// Step 4.6, S6a - the money gaps of the production release, each proved on the REAL routes and the REAL payment sync (fake Stripe, throw-away database).
// Written BEFORE the fixes (red on the code of step S5, b464d04), green after. Matrix numbers refer to docs/VERIFICA-4.6.md (S6) / the S6 plan.
//   F04  a refund of the order's own payment does not stop production                                   M18 M19 M23
//   F25  an authorization stays valid for ever, whatever happens to the money afterwards                 M63 M65
//   F05  a second (duplicate) payment overwrites the order's own payment data                            M13 M15
//   F13  a payment attempt left "processing" on a paid order blocks it for ever                          M43
//   F08  an authorization / a no-charge order without a written reason                                   M28 M34
// What each test asserts is the DECISION (lib/order-payment-policy.ts `releaseDecision`) on the facts the application reads under its lock, and the routes
// that apply it - never a field that the fix itself introduces, so that every test can run (and fail) on the old code.
import { db } from './_harness'
import { ORIGIN, as, asKey, bodyOf, callAssign, callStatus, makeOrder, releasedSpec, request, resetSeams, setup, state, teardown, world } from './_release-fixtures'
import { chargeEvent, decisionOf, deliver, endFlow, flow, freshFlow, initFlow, legacyIntent, legacyOrder, orderOf, piEvent, sessionEvent, startCheckout, addTwinSession } from './_s6-flow'
import assert from 'node:assert/strict'
import test from 'node:test'

test.before(async () => {
  await setup()
  await initFlow({ reset: false })
})
test.after(async () => {
  endFlow()
  await teardown()
})
test.beforeEach(async () => {
  resetSeams()
  await freshFlow()
  await world()
  asKey('admin')
})

const itemsPatch = async (orderId: string, itemId: string, body: Record<string, unknown>) => {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/items/[itemId]/route')
  return (PATCH as any)(request(`/api/admin/orders/${orderId}/items/${itemId}`, 'PATCH', body), { params: Promise.resolve({ orderId, itemId }) }) as Promise<Response>
}
const createByHand = async (body: Record<string, unknown>) => {
  const { POST } = await import('../../app/api/admin/orders/route')
  return (POST as any)(request('/api/admin/orders', 'POST', body)) as Promise<Response>
}
const AUTH_REASON = 'agreed on the phone, pays on pickup'

// ======================================================================================================================================
// F04 - a refund of the order's own payment
// ======================================================================================================================================
for (const [label, refunded] of [['partial', 500], ['total', 2500]] as const) {
  test(`M18/M19 a ${label} refund of the order's own Stripe payment: not released, an administrator may authorize it with a reason, no effect runs`, async () => {
    const order = await makeOrder(releasedSpec({ total: 2500 }))
    assert.equal((await decisionOf(order.id)).released, true, 'before the refund the paid order is released')
    await (await db()).printOrder.update({ where: { id: order.id }, data: { refundedCents: refunded } })
    const decision = await decisionOf(order.id)
    assert.equal(decision.released, false, 'the refunded order must not stay released')
    assert.equal(decision.state, 'payment_refunded')
    assert.equal(decision.code, 'PAYMENT_REFUNDED')
    assert.equal(decision.authorizable, true, 'money that came back is not a payment hold: a person may decide, with a reason')
    // the effects: nothing moves it into production, nothing puts it on a printer
    const advanced = await callStatus(order.id, 'printing')
    assert.equal(advanced.status, 409, JSON.stringify(await bodyOf(advanced)))
    assert.equal((await bodyOf(advanced)).code, 'PAYMENT_REFUNDED')
    const printer = await (await db()).printer.create({ data: { name: 'S6 printer', dailyCapacityHours: 8 } })
    const assigned = await callAssign(order.id, printer.id)
    assert.equal(assigned.status, 409)
    assert.equal((await db().then((prisma) => prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } }))).printerId, null)
  })
}

test('M23 a refund that FAILS afterwards gives the order back: refunded then not refunded again, released again by its payment proof', async () => {
  const { orderId, sessionId } = await startCheckout()
  const { piId } = flow.fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  assert.equal((await decisionOf(orderId)).released, true)
  const charge = flow.fake.intents.get(piId)!.latest_charge
  charge.amount_refunded = 1500
  await deliver(chargeEvent('charge.refunded', piId))
  assert.equal((await orderOf(orderId)).refundedCents, 1500)
  assert.equal((await decisionOf(orderId)).state, 'payment_refunded', 'refunded: not released')
  charge.amount_refunded = 0
  await deliver(chargeEvent('charge.refund.updated', piId))
  assert.equal((await orderOf(orderId)).refundedCents, 0)
  const decision = await decisionOf(orderId)
  assert.equal(decision.released, true, 'the refund failed: the payment proof is whole again')
  assert.equal(decision.basis, 'stripe_verified')
})

// ======================================================================================================================================
// F25 - an authorization must not outlive the money situation it was given for
// ======================================================================================================================================
test('M63 authorized while unpaid, then paid, then refunded: the old authorization does not bring the refunded order back', async () => {
  const order = await legacyOrder('pi_s6_f25')
  legacyIntent('pi_s6_f25', 'requires_payment_method')
  assert.equal((await deliver(piEvent('payment_intent.payment_failed', 'pi_s6_f25'))).status, 200)
  assert.equal((await decisionOf(order.id)).state, 'payment_pending')
  // an administrator authorizes production before the money arrives, with a reason
  const authorized = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: AUTH_REASON })
  assert.equal(authorized.status, 200, JSON.stringify(await bodyOf(authorized)))
  assert.equal((await decisionOf(order.id)).basis, 'admin_authorization')
  // the customer pays after all (verified by the payment sync)...
  legacyIntent('pi_s6_f25', 'succeeded')
  assert.equal((await deliver(piEvent('payment_intent.succeeded', 'pi_s6_f25'))).status, 200)
  assert.equal((await decisionOf(order.id)).basis, 'stripe_verified')
  // ...and the money goes back
  flow.fake.intents.get('pi_s6_f25')!.latest_charge.amount_refunded = 1000
  assert.equal((await deliver(chargeEvent('charge.refunded', 'pi_s6_f25'))).status, 200)
  assert.equal((await orderOf(order.id)).refundedCents, 1000)
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false, 'the authorization given before the payment and the refund must not release the refunded order')
  assert.equal(decision.state, 'payment_refunded')
  assert.equal(decision.authorizable, true, 'a NEW explicit decision with a reason is still possible')
})

test('M65 authorized while unpaid, then the total changes: the old authorization is no longer valid, a new decision is needed', async () => {
  const order = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending', total: 3000, items: 1 })
  await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentMethod: 'cash' } })
  const authorized = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: AUTH_REASON })
  assert.equal(authorized.status, 200, JSON.stringify(await bodyOf(authorized)))
  assert.equal((await decisionOf(order.id)).released, true)
  const item = await (await db()).printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
  const changed = await itemsPatch(order.id, item.id, { quantity: 3, reason: 'the customer asked for two more of them' })
  assert.equal(changed.status, 200, JSON.stringify(await bodyOf(changed)))
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false, 'what was authorized was another total')
  assert.equal(decision.authorizable, true)
  // a new decision, with a reason, works
  const again = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: 'new total agreed with the customer' })
  assert.equal(again.status, 200, JSON.stringify(await bodyOf(again)))
  assert.equal((await decisionOf(order.id)).released, true)
})

// ======================================================================================================================================
// F05 - the second payment of an order is the duplicate's, not the order's
// ======================================================================================================================================
async function paidThenDuplicate() {
  const { orderId, sessionId, total } = await startCheckout()
  const { piId } = flow.fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  const first = await orderOf(orderId)
  const attempt2 = await addTwinSession(orderId, total, 'cs_test_S6_TWIN_1')
  const { piId: dupPiId } = flow.fake.pay('cs_test_S6_TWIN_1')
  const dupCharge = flow.fake.intents.get(dupPiId)!.latest_charge
  dupCharge.id = 'ch_S6_DUPLICATE'
  dupCharge.receipt_url = 'https://pay.stripe.test/receipt-of-the-duplicate'
  await deliver(sessionEvent('checkout.session.completed', 'cs_test_S6_TWIN_1'))
  return { orderId, piId, dupPiId, dupCharge, first, total, attempt2 }
}

test('M13 a second paid page for an order already paid: held for a person, and the order keeps ITS OWN payment data', async () => {
  const { orderId, piId, first } = await paidThenDuplicate()
  const order = await orderOf(orderId)
  assert.equal(order.paymentReviewReason, 'duplicate_payment')
  assert.equal(order.stripePaymentIntentId, piId)
  assert.equal(order.stripeChargeId, first.stripeChargeId, 'the charge of the order is not replaced by the duplicate\'s')
  assert.equal(order.receiptUrl, first.receiptUrl, 'the receipt of the order is not replaced by the duplicate\'s')
  assert.deepEqual((order.metadata as any).stripe, (first.metadata as any).stripe, 'metadata.stripe keeps describing the order\'s own payment')
  assert.equal(order.refundedCents, first.refundedCents)
})

test('M15 the duplicate is refunded in full: the ORDER\'s refunded amount stays 0 and its own payment is untouched', async () => {
  const { orderId, dupPiId, dupCharge, total, first } = await paidThenDuplicate()
  dupCharge.amount_refunded = total
  assert.equal((await deliver(chargeEvent('charge.refunded', dupPiId))).status, 200)
  const order = await orderOf(orderId)
  assert.equal(order.refundedCents, 0, 'refunding the duplicate is the way OUT of the hold; it is not a refund of the order')
  assert.equal(order.stripeChargeId, first.stripeChargeId)
  assert.equal(order.receiptUrl, first.receiptUrl)
  assert.equal((order.metadata as any).stripe.paymentIntentId, (first.metadata as any).stripe.paymentIntentId)
})

// ======================================================================================================================================
// F13 - an attempt left "processing" on a paid order
// ======================================================================================================================================
test('M43 a payment attempt left "processing" on an order already paid is closed when Stripe says it ended without money', async () => {
  const { orderId, sessionId } = await startCheckout()
  flow.fake.pay(sessionId)
  await deliver(sessionEvent('checkout.session.completed', sessionId))
  assert.equal((await decisionOf(orderId)).released, true)
  // another payment of the same order started (a slow method) and is recorded as being confirmed...
  const prisma = await db()
  const stuck = await prisma.paymentAttempt.create({
    data: { orderId, amountCents: 1000, currency: 'EUR', status: 'processing', stripePaymentIntentId: 'pi_s6_stuck', expiresAt: new Date(Date.now() + 600_000) },
  })
  flow.fake.intents.set('pi_s6_stuck', {
    id: 'pi_s6_stuck', object: 'payment_intent', status: 'canceled', amount: 1000, amount_received: 0, currency: 'eur',
    metadata: { orderId, attemptId: stuck.id }, customer: null, latest_charge: null,
  })
  assert.equal((await decisionOf(orderId)).state, 'payment_processing', 'while an attempt is being confirmed nothing is released')
  // ...and then it is cancelled
  assert.equal((await deliver(piEvent('payment_intent.canceled', 'pi_s6_stuck'))).status, 200)
  const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: stuck.id } })
  assert.equal(after.status, 'failed', 'a cancelled payment is a finished payment')
  const decision = await decisionOf(orderId)
  assert.equal(decision.released, true, 'the paid order is producible again')
  assert.equal(decision.basis, 'stripe_verified')
})

// ======================================================================================================================================
// F08 - production without a payment is a decision with a written reason
// ======================================================================================================================================
test('M28 an authorization to produce without a verified payment needs a written reason (at least 10 characters): without it, nothing is written', async () => {
  const order = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending', total: 1500 })
  for (const reason of [undefined, '', '   ', 'ok', 'too short']) {
    const before = await db().then((prisma) => prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } }))
    const refused = await callStatus(order.id, 'queued', { authorizeUnpaid: true, ...(reason !== undefined ? { authorizationReason: reason } : {}) })
    assert.equal(refused.status, 400, `reason ${JSON.stringify(reason)} -> HTTP ${refused.status} ${JSON.stringify(await bodyOf(refused))}`)
    assert.equal((await bodyOf(refused)).code, 'REASON_REQUIRED')
    const after = await db().then((prisma) => prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } }))
    assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)), `reason ${JSON.stringify(reason)}: the order must not change`)
  }
  const ok = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: AUTH_REASON })
  assert.equal(ok.status, 200, JSON.stringify(await bodyOf(ok)))
  const stored = (await db().then((prisma) => prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } }))).metadata as any
  assert.equal(stored.productionAuthorization.reason, AUTH_REASON)
  assert.equal(stored.productionAuthorization.by, state.adminId)
})

test('M28/M34 an order made by hand: authorizing production without payment, or making it at no charge, both need a written reason', async () => {
  const base = {
    userId: state.customerId, paymentMethod: 'cash', shippingMethod: 'pickup',
    items: [{ modelTitle: 'Hand made part', material: 'PLA', quantity: 1, unitPriceCents: 2000 }],
  }
  const unpaid = await createByHand({ ...base, authorizeUnpaid: true })
  assert.equal(unpaid.status, 400, JSON.stringify(await bodyOf(unpaid)))
  assert.equal((await bodyOf(unpaid)).code, 'REASON_REQUIRED')
  const unpaidOk = await createByHand({ ...base, authorizeUnpaid: true, authorizationReason: AUTH_REASON })
  assert.equal(unpaidOk.status, 200, JSON.stringify(await bodyOf(unpaidOk)))

  const free = { ...base, paymentMethod: 'comped', items: [{ modelTitle: 'Gift part', material: 'PLA', quantity: 1, unitPriceCents: 0 }] }
  const freeNoReason = await createByHand(free)
  assert.equal(freeNoReason.status, 400, JSON.stringify(await bodyOf(freeNoReason)))
  assert.equal((await bodyOf(freeNoReason)).code, 'REASON_REQUIRED')
  const freeOk = await createByHand({ ...free, authorizationReason: 'gift for the school fair, agreed with the owner' })
  assert.equal(freeOk.status, 200, JSON.stringify(await bodyOf(freeOk)))
  const made = (await bodyOf(freeOk)).order
  const row = await db().then((prisma) => prisma.printOrder.findUniqueOrThrow({ where: { id: made.id } }))
  assert.equal(row.paymentStatus, 'free')
  assert.equal(row.status, 'queued')
  const audit = await db().then((prisma) => prisma.adminAuditEvent.findFirst({ where: { targetId: made.id, action: 'admin.order.create' } }))
  assert.match(JSON.stringify(audit?.metadata ?? {}), /gift for the school fair/, 'the reason is in the audit event')
})

void ORIGIN
void as
