// Step 4.6, S6a - ORDERS THAT EXISTED BEFORE S6: what the new code does with rows written by the code of step S5.
// The migrations add a table and a column and touch no row. The rules did change, though, so a row written under the old rules is read under the new ones. This file proves, on
// the real routes and a throw-away database, that the change only ever TIGHTENS and that every case has a way forward:
//   * an order released on a verified Stripe payment stays released - nothing a customer paid for is stopped;
//   * an authorization from before S6 carries no revision: it releases nothing ("no revision"), the order is authorizable again, and a new authorization with a reason works;
//   * a payment "registered" before S6 without the way the money was received or its amount, or by a method that is not a receipt (invoice, purchase order, PayPal), is not proof:
//     the order is "paid with no proof", an administrator can register the receipt properly;
//   * an order refunded before S6 is no longer released on the strength of its payment;
//   * the prefilter that picks orders still contains every order the decision releases.
// (A read-only comparison of the old and the new decision over a copy migrated from the S5 schema was run outside the repository and is reported in docs/VERIFICA-4.6.md.)
// No Stripe, PayPal, PrintLab, StockWorks or printer is ever contacted.
import './_harness'
import { db } from './_harness'
import { asKey, assertNothingHappened, bodyOf, callAssign, callStatus, makeOrder, releasedSpec, resetSeams, setup, snap, state, teardown, world } from './_release-fixtures'
import { decisionOf } from './_s6-flow'
import { getProductionAuthorization, releasedOrderWhere } from '../../lib/order-payment-policy'
import { recordAttestedReceipt } from '../../lib/orders'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

test.before(setup)
test.after(teardown)
afterEach(resetSeams)
test.beforeEach(async () => {
  await world()
  asKey('admin')
})

const REASON = 'agreed with the customer on the phone'
const legacyAuthorization = () => ({ authorized: true, by: state.adminId, at: '2026-05-02T10:00:00.000Z', reason: 'Agreed with the customer on the phone' }) // exactly what step S5 wrote
const legacyManual = (over: Record<string, unknown> = {}) => ({ by: state.adminId, at: '2026-05-02T10:00:00.000Z', reason: 'Cash received at the counter', method: 'cash', ...over }) // no way received, no amount

test('L1 an order released on a verified Stripe payment before S6 is still released: nothing a customer paid for is stopped', async () => {
  const order = await makeOrder(releasedSpec())
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.financialRevision, 0, 'an order that existed before the migration starts at revision 0')
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, true)
  assert.equal(decision.basis, 'stripe_verified')
  const printer = await (await db()).printer.create({ data: { name: 'FAKE A1 mini' } })
  assert.equal((await callAssign(order.id, printer.id)).status, 200)
})

test('L2 an authorization from before S6 has no revision: it releases nothing, the order can be authorized again, and the new record replaces the old one', async () => {
  const order = await makeOrder({ status: 'queued', paymentStatus: 'pending' }, { metadata: { productionAuthorization: legacyAuthorization() } })
  await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentMethod: 'cash' } })
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false, 'an authorization with no revision released the order')
  assert.equal(decision.authorizationStale, 'no_revision')
  assert.equal(decision.authorizable, true, 'there must be a way forward')
  const printer = await (await db()).printer.create({ data: { name: 'FAKE A1 mini' } })
  const before = await snap(order.id)
  const refused = await callStatus(order.id, 'printing')
  assert.equal(refused.status, 409, JSON.stringify(await bodyOf(refused)))
  assert.equal((await bodyOf(refused)).code, 'PAYMENT_NOT_VERIFIED')
  assert.equal((await callAssign(order.id, printer.id)).status, 409)
  assertNothingHappened(before, await snap(order.id), 'legacy authorization')
  // a new decision, with a reason, works - and it is a real record
  const again = await callStatus(order.id, 'printing', { authorizeUnpaid: true, authorizationReason: REASON })
  assert.equal(again.status, 200, JSON.stringify(await bodyOf(again)))
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  const record = getProductionAuthorization(row.metadata)!
  assert.equal(record.financialRevision, row.financialRevision)
  assert.equal(record.kind, 'exceptional')
  assert.equal(record.reason, REASON, 'the new record replaced the old one')
})

test('L3 a payment "registered" before S6 (no way received, no amount) is not proof: the order is paid with no proof, and the receipt can be registered properly', async () => {
  const order = await makeOrder({ status: 'queued', paymentStatus: 'paid' }, { metadata: { manualPayment: legacyManual() } })
  await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentMethod: 'cash' } })
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false)
  assert.equal(decision.state, 'payment_unproven')
  assert.equal(decision.authorizable, true)
  const printer = await (await db()).printer.create({ data: { name: 'FAKE A1 mini' } })
  const before = await snap(order.id)
  assert.equal((await callAssign(order.id, printer.id)).status, 409)
  assertNothingHappened(before, await snap(order.id), 'legacy manual payment')
  // the receipt registered the way S6 asks: how the money was received, the amount and the currency from the order
  await recordAttestedReceipt({
    orderId: order.id, adminId: state.adminId, reason: REASON, method: 'cash', receivedVia: 'cash',
    audit: { requestMethod: 'PATCH', requestPath: '/api/jobs/legacy', requestIp: null, userAgent: null },
  })
  const proven = await decisionOf(order.id)
  assert.equal(proven.released, true, JSON.stringify(proven))
  assert.equal(proven.basis, 'manual_payment')
  assert.equal((await callAssign(order.id, printer.id)).status, 200)
})

for (const method of ['invoice', 'po', 'paypal']) {
  test(`L4 a "${method}" registered as a payment before S6 (no way received, no amount) is not a receipt: held as paid with no proof, never released on that record`, async () => {
    const order = await makeOrder({ status: 'queued', paymentStatus: 'paid' }, { metadata: { manualPayment: legacyManual({ method }) } })
    await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentMethod: method } })
    const decision = await decisionOf(order.id)
    assert.equal(decision.released, false, `a ${method} record released the order`)
    assert.equal(decision.state, 'payment_unproven')
    assert.equal(decision.authorizable, true, 'there must be a way forward')
  })
}

test('L4b written in the NEW shape, PayPal is still never a receipt an administrator can attest; an invoice or a purchase order settled in cash with the amount is (M72)', async () => {
  const shape = (method: string, over: Record<string, unknown> = {}) => legacyManual({ method, receivedVia: 'cash', amountCents: 2500, currency: 'EUR', ...over })
  const paypal = await makeOrder({ status: 'queued', paymentStatus: 'paid' }, { metadata: { manualPayment: shape('paypal') } })
  assert.equal((await decisionOf(paypal.id)).state, 'payment_unproven', 'a PayPal record released the order')
  for (const method of ['invoice', 'po']) {
    const settled = await makeOrder({ status: 'queued', paymentStatus: 'paid' }, { metadata: { manualPayment: shape(method) } })
    await (await db()).printOrder.update({ where: { id: settled.id }, data: { paymentMethod: method } })
    const decision = await decisionOf(settled.id)
    assert.equal(decision.released, true, `a ${method} settled in cash, with the amount, is a receipt: ${JSON.stringify(decision)}`)
    assert.equal(decision.basis, 'manual_payment')
    // the amount must cover the order and be in its currency
    const short = await makeOrder({ status: 'queued', paymentStatus: 'paid' }, { metadata: { manualPayment: shape(method, { amountCents: 100 }) } })
    assert.equal((await decisionOf(short.id)).state, 'payment_unproven', 'a receipt of less than the total released the order')
  }
})

test('L5 an outside order authorized before S6 is held again until a new authorization (the money anomaly rule is unchanged)', async () => {
  const order = await makeOrder({ status: 'awaiting_review', reason: 'external_order' }, { metadata: { productionAuthorization: legacyAuthorization() } })
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false)
  assert.equal(decision.state, 'external_review')
  assert.equal(decision.authorizationStale, 'no_revision')
  assert.equal(decision.authorizable, true)
  const again = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationReason: REASON })
  assert.equal(again.status, 200, JSON.stringify(await bodyOf(again)))
  const after = await decisionOf(order.id)
  assert.equal(after.released, true)
  assert.equal(after.basis, 'admin_authorization')
})

test('L6 an order refunded before S6 was released on the strength of its payment; now it is held, and an administrator can decide with a reason', async () => {
  const order = await makeOrder(releasedSpec({ total: 2500 }))
  await (await db()).printOrder.update({ where: { id: order.id }, data: { refundedCents: 2500 } })
  const decision = await decisionOf(order.id)
  assert.equal(decision.released, false)
  assert.equal(decision.state, 'payment_refunded')
  assert.equal(decision.authorizable, true)
})

test('L7 the prefilter that picks orders still contains every order the decision releases (it may contain more: the decision is made again under the lock on every effect)', async () => {
  const specs = [
    releasedSpec(),
    releasedSpec({ evidence: 'manual', attempts: [] }),
    { status: 'queued', paymentStatus: 'paid' } as const,
    { status: 'queued', paymentStatus: 'pending', authorization: true } as const,
    { status: 'queued', paymentStatus: 'pending', metadata: { productionAuthorization: legacyAuthorization() } } as const,
    { status: 'queued', paymentStatus: 'paid', metadata: { manualPayment: legacyManual() } } as const,
    releasedSpec({ reason: 'dispute' }),
    { status: 'queued', paymentStatus: 'free', total: 0 } as const,
  ]
  const orders = [] as Array<{ id: string; released: boolean }>
  for (const spec of specs) {
    const order = await makeOrder(spec as any)
    orders.push({ id: order.id, released: (await decisionOf(order.id)).released })
  }
  assert.ok(orders.some((entry) => entry.released) && orders.some((entry) => !entry.released), 'the fixture must hold both kinds')
  const picked = new Set((await (await db()).printOrder.findMany({ where: releasedOrderWhere(), select: { id: true } })).map((row) => row.id))
  for (const entry of orders.filter((o) => o.released)) assert.ok(picked.has(entry.id), 'the prefilter left out an order the decision releases')
  // and the two shapes that S6 made worthless are not picked
  const [legacyAuth, legacyManualOrder] = [orders[4], orders[5]]
  assert.ok(!picked.has(legacyAuth.id), 'an authorization with no revision was picked by the prefilter')
  assert.ok(!picked.has(legacyManualOrder.id) || !legacyManualOrder.released)
})
