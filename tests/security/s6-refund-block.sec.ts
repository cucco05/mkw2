// Step 4.6, S6 (P2c) - while a refund requested from the application is not over, NOTHING is produced, and nothing overrides it.
//
// What is proven here, on the REAL routes and a throw-away database (the refund operations are written directly: the protocol that makes them comes with the refund work
// itself, and no Stripe account - real or test - is ever contacted):
//   * the state matrix of tests/security/_release-fixtures.ts (RELEASE_MATRIX) carries one entry for every state of a refund operation, so tests/security/production-release.sec.ts
//     runs EVERY effect (status, assignment, automatic queue, PrintLab send / link / callback, OrderWorks sync, stock) against each of them;
//   * here, the rest: the approval by an organization, the decisions about the payment itself (a hold resolved, a commercial credit, an authorization), the edits and the
//     deletion of an order that carries a refund, an operation of ANOTHER order, what the administrator reads, and a claim that lands while an effect is running.
// The lock is the one S4 already uses; there is no second gate.
import './_harness'
import { db, stripeCalls } from './_harness'
import {
  addRefundOperations, as, asKey, assertNothingHappened, auditActions, bodyOf, callAssign, callDelete, callStatus, makeOrder, ORIGIN, releasedSpec, request, resetSeams, setup, sleep, snap, state, teardown, world,
} from './_release-fixtures'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { releaseHooks } from '../../lib/production-release'
import { getProductionSnapshot } from '../../lib/production'
import { syncHooks } from '../../lib/payment-sync'
import { endFlow, freshFlow, initFlow, startCheckout } from './_s6-flow'

test.before(async () => {
  await setup()
  await initFlow({ reset: false })
})
test.after(async () => {
  endFlow()
  await teardown()
})
afterEach(() => {
  syncHooks.afterRead = undefined
  resetSeams()
})

const BLOCKING = ['requested', 'sending', 'unknown', 'pending', 'requires_action', 'unresolved'] as const

async function callHold(orderId: string, outcome: 'accepted' | 'no_charge', reason = 'checked with the bank this morning') {
  const { POST } = await import('../../app/api/admin/orders/[orderId]/payment-hold/route')
  return (POST as any)(request(`/api/admin/orders/${orderId}/payment-hold`, 'POST', { outcome, reason }), { params: Promise.resolve({ orderId }) }) as Promise<Response>
}
async function callItem(orderId: string, itemId: string, body: Record<string, unknown>) {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/items/[itemId]/route')
  return (PATCH as any)(request(`/api/admin/orders/${orderId}/items/${itemId}`, 'PATCH', body), { params: Promise.resolve({ orderId, itemId }) }) as Promise<Response>
}
async function orgFixture() {
  const prisma = await db()
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const [approver, requester] = await Promise.all(['approver', 'requester'].map((name) => prisma.user.create({ data: { email: `rb-${name}-${stamp}@sectest.invalid`, passwordHash: 'x', name, role: 'customer' } as any })))
  const org = await prisma.organization.create({ data: { name: `Org ${stamp}`, slug: `org-${stamp}`, createdById: approver.id } })
  await prisma.organizationMember.createMany({ data: [{ organizationId: org.id, userId: approver.id, role: 'approver' }, { organizationId: org.id, userId: requester.id, role: 'requester' }] })
  return { org, approver }
}
async function approve(orgId: string, orderId: string, viewerId: string) {
  as({ id: viewerId, role: 'customer' })
  const { POST } = await import('../../app/api/customer/organizations/[organizationId]/orders/[orderId]/approval/route')
  return (POST as any)(new NextRequest(`${ORIGIN}/api/customer/organizations/${orgId}/orders/${orderId}/approval`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ action: 'approve', note: 'looks right' }) }), { params: Promise.resolve({ organizationId: orgId, orderId }) }) as Promise<Response>
}

// ============================================================================================================================================
// 1. The approval by an organization
// ============================================================================================================================================
test('R1 an approver can not send into the queue an order whose refund is not over: it waits for payment, like an order on hold', async () => {
  const f = await orgFixture()
  for (const status of BLOCKING) {
    await world()
    const order = await makeOrder(releasedSpec({ status: 'awaiting_review', refunds: [{ status }] }))
    await (await db()).printOrder.update({ where: { id: order.id }, data: { organizationId: f.org.id } })
    const res = await approve(f.org.id, order.id, f.approver.id)
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(await bodyOf(res))}`)
    assert.equal((await snap(order.id)).row.status, 'awaiting_payment', `${status}: the approval started production while a refund was open`)
  }
  // once the refund is over and applied, the same approval releases it
  await world()
  const done = await makeOrder(releasedSpec({ status: 'awaiting_review', refunds: [{ status: 'succeeded', applied: true }] }))
  await (await db()).printOrder.update({ where: { id: done.id }, data: { organizationId: f.org.id } })
  assert.equal((await approve(f.org.id, done.id, f.approver.id)).status, 200)
  assert.equal((await snap(done.id)).row.status, 'queued')
})

// ============================================================================================================================================
// 2. Decisions about the payment itself, while the money is leaving
// ============================================================================================================================================
test('R2 a hold can not be resolved while a refund is open: refused BEFORE Stripe is asked anything, the order and the attempts untouched', async () => {
  for (const status of [...BLOCKING, 'succeeded']) {
    await world()
    const prisma = await db()
    // a duplicate payment on hold: the case a refund is made for
    const order = await makeOrder(releasedSpec({ reason: 'duplicate_payment', attempts: ['paid', 'mismatch'], refunds: [{ status, applied: false }] }))
    // (a payment page with a Stripe session: without the refund guard the decision would ask Stripe about it)
    for (const [index, attempt] of (await prisma.paymentAttempt.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } })).entries()) {
      await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { stripeSessionId: `cs_test_fixture_${order.id}_${index}`, stripePaymentIntentId: `pi_fixture_${order.id}_${index}` } })
    }
    // (the fake checkout of ./_s6-flow is in place: any question put to Stripe is counted in `stripeCalls`)
    const calls = stripeCalls.length
    for (const outcome of ['accepted', 'no_charge'] as const) {
      const before = await snap(order.id)
      const res = await callHold(order.id, outcome)
      assert.equal(res.status, 409, `${status}/${outcome}: ${JSON.stringify(await bodyOf(res))}`)
      assert.equal((await bodyOf(res)).code, 'REFUND_IN_PROGRESS', `${status}/${outcome}`)
      assertNothingHappened(before, await snap(order.id), `hold ${outcome} during a ${status} refund`)
    }
    assert.equal(stripeCalls.length, calls, `${status}: Stripe was called by a decision that had to be refused`)
    assert.equal(await prisma.refundOperation.count({ where: { orderId: order.id } }), 1, `${status}: a refund operation was added or removed by a refused decision`)
  }
})

test('R2c a refund CLAIMED while the decision is reading Stripe stops the decision under the lock: the order is not cancelled, nothing is written', async () => {
  // ("no charge" is the decision that cancels the order; "accepted" goes through the same guard, in the same place, but needs a paid order whose open page the decision reads)
  for (const outcome of ['no_charge'] as const) {
    await freshFlow()
    await world()
    asKey('admin')
    const started = await startCheckout()
    asKey('admin')
    const prisma = await db()
    // a hold on the order (so that there is something to resolve) with an open payment page: the decision reads that page at Stripe
    await prisma.printOrder.update({ where: { id: started.orderId }, data: { paymentReviewReason: 'amount' } })
    await prisma.paymentAttempt.update({ where: { id: started.attemptId }, data: { status: 'mismatch' } })
    let claimed = false
    syncHooks.afterRead = async () => {
      if (claimed) return
      claimed = true
      await addRefundOperations(started.orderId, 'pi_claimed_during_the_read', [{ status: 'requested' }])
    }
    const before = await snap(started.orderId)
    const res = await callHold(started.orderId, outcome)
    assert.equal(claimed, true, 'the decision never read Stripe, so the claim never landed in the middle of it')
    assert.equal(res.status, 409, `${outcome}: ${JSON.stringify(await bodyOf(res))}`)
    assert.equal((await bodyOf(res)).code, 'REFUND_IN_PROGRESS', outcome)
    // (reading Stripe is allowed to note WHEN the order was synchronised; nothing that decides anything may differ)
    const after = await snap(started.orderId)
    const decisive = (row: Record<string, unknown>) => { const { paymentSyncedAt: _synced, updatedAt: _updated, ...rest } = row; void _synced; void _updated; return rest }
    assert.deepEqual(decisive(after.row), decisive(before.row), `hold ${outcome}: the order changed although a refund was claimed`)
    assert.deepEqual(after.attempts.map(decisive), before.attempts.map(decisive), `hold ${outcome}: an attempt changed`)
    assert.equal(after.audits, before.audits, `hold ${outcome}: an audit event was written`)
    syncHooks.afterRead = undefined
  }
})

test('R2b once the refund is closed (applied, or never sent) the same decision is taken again', async () => {
  for (const refund of [{ status: 'succeeded', applied: true }, { status: 'failed', applied: true }, { status: 'abandoned' }]) {
    await world()
    const order = await makeOrder(releasedSpec({ reason: 'duplicate_payment', attempts: ['paid', 'mismatch'], refunds: [refund] }))
    const res = await callHold(order.id, 'accepted')
    assert.notEqual((await bodyOf(res)).code, 'REFUND_IN_PROGRESS', `${refund.status}: still blocked by a closed refund`)
  }
})

test('R3 neither an authorization nor a commercial credit is granted on an order whose refund is open - the refusal says so, nothing is written', async () => {
  for (const status of BLOCKING) {
    await world()
    const unpaid = await makeOrder({ status: 'awaiting_payment', refunds: [{ status }] })
    const credit = await makeOrder({ status: 'awaiting_payment', refunds: [{ status }] })
    await (await db()).printOrder.update({ where: { id: credit.id }, data: { paymentMethod: 'invoice' } })
    for (const [order, extra] of [
      [unpaid, { authorizeUnpaid: true, authorizationReason: 'agreed by phone with the customer' }],
      [credit, { authorizeUnpaid: true, authorizationReason: 'agreed by phone with the customer', authorizationKind: 'commercial_credit', creditReference: 'INV-2026-0042' }],
    ] as const) {
      const before = await snap(order.id)
      const res = await callStatus(order.id, 'printing', { ...extra })
      assert.equal(res.status, 409, `${status}: ${JSON.stringify(await bodyOf(res))}`)
      assert.equal((await bodyOf(res)).code, 'REFUND_IN_PROGRESS', status)
      assertNothingHappened(before, await snap(order.id), `authorization during a ${status} refund`)
      assert.ok(!(await auditActions(order.id)).includes('admin.order.commercial_credit.authorize'), 'a credit decision was recorded')
    }
  }
})

test('R4 an order that carries a refund operation - in any state - is not edited and not deleted from the order routes', async () => {
  for (const status of [...BLOCKING, 'succeeded', 'failed', 'abandoned']) {
    await world()
    const prisma = await db()
    // no other proof of a Stripe payment on this order: the refund operation alone is what stops the edit
    const order = await makeOrder({ status: 'awaiting_payment', refunds: [{ status, applied: status === 'failed' }] })
    const item = await prisma.printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
    const before = await snap(order.id)
    const edit = await callItem(order.id, item.id, { quantity: 5, reason: 'the customer asked for five pieces' })
    assert.equal(edit.status, 409, `${status}: ${JSON.stringify(await bodyOf(edit))}`)
    assert.equal((await bodyOf(edit)).code, 'ORDER_HAS_PAYMENT_EVIDENCE', status)
    assert.ok(((await bodyOf(edit)).details?.reasons ?? []).includes('refund_operation'), `${status}: the refusal does not name the refund`)
    const gone = await callDelete(order.id)
    assert.equal(gone.status, 409, `${status}: ${JSON.stringify(await bodyOf(gone))}`)
    assert.equal((await bodyOf(gone)).code, 'ORDER_HAS_PAYMENT_EVIDENCE', status)
    assertNothingHappened(before, await snap(order.id), `edit / delete with a ${status} refund`)
    assert.equal(await prisma.refundOperation.count({ where: { orderId: order.id } }), 1, 'the record of the refund is still there')
  }
})

// ============================================================================================================================================
// 3. Scope: an operation blocks ITS order, and a closed one blocks nothing
// ============================================================================================================================================
test('R5 the operation of one order does not block another order', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const blocked = await makeOrder(releasedSpec({ refunds: [{ status: 'unknown' }] }))
  const other = await makeOrder(releasedSpec())
  assert.equal((await callAssign(blocked.id, printer.id)).status, 409)
  assert.equal((await callAssign(other.id, printer.id)).status, 200, 'an order with no refund of its own was held back by someone else\'s')
})

test('R6 two operations on one order: the open one keeps the block, and closing the other does not lift it', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder(releasedSpec({ refunds: [{ status: 'succeeded', applied: true }, { status: 'pending' }] }))
  const res = await callAssign(order.id, printer.id)
  assert.equal(res.status, 409)
  assert.equal((await bodyOf(res)).code, 'REFUND_IN_PROGRESS')
  await prisma.refundOperation.updateMany({ where: { orderId: order.id, status: 'pending' }, data: { status: 'succeeded', appliedAt: new Date() } })
  assert.equal((await callAssign(order.id, printer.id)).status, 200, 'the block did not lift when the last open operation was applied')
})

// ============================================================================================================================================
// 4. What the administrator reads
// ============================================================================================================================================
test('R7 the production page lists the order as held back by a refund in progress - not in the queue, with the reason in words', async () => {
  await world()
  const order = await makeOrder(releasedSpec({ refunds: [{ status: 'unknown' }] }))
  const clear = await makeOrder(releasedSpec())
  const snapshot = await getProductionSnapshot({ includeRelease: true })
  assert.ok(!snapshot.orders.some((entry) => entry.id === order.id), 'an order with a refund open is in the production queue')
  assert.ok(snapshot.orders.some((entry) => entry.id === clear.id), 'the order without a refund is not')
  const line = snapshot.notReleased!.find((entry) => entry.id === order.id)!
  assert.ok(line, 'the order is not listed among the ones held back')
  assert.equal(line.release.state, 'payment_refund_pending')
  assert.equal(line.release.code, 'REFUND_IN_PROGRESS')
  assert.match(`${line.release.label} ${line.release.detail}`, /refund/i, 'the page does not say, in words, that a refund is under way')
})

// ============================================================================================================================================
// 5. A claim that lands while an effect is running
// ============================================================================================================================================
// (The claim of the real protocol is a later piece of work; this is its lock behavior: the row lock first, the operation inserted under it.)
async function claimLikeTheProtocolWill(orderId: string) {
  const prisma = await db()
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    await tx.refundOperation.create({ data: { orderId, paymentIntentId: 'pi_claim_fixture', amountCents: 500, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate', note: 'claimed by the test', status: 'requested', id: randomUUID() } })
  })
}

test('R8 a claim made while an assignment holds the order WAITS for it: the assignment was decided on the facts as they were, and the next one is refused', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder(releasedSpec())
  let claimSettled = false
  let claim: Promise<void> | null = null
  releaseHooks.afterLock = async ({ action }) => {
    if (action !== 'assign-printer') return
    releaseHooks.afterLock = undefined
    claim = claimLikeTheProtocolWill(order.id).then(() => { claimSettled = true })
    await sleep(500)
    assert.equal(claimSettled, false, 'the claim could be written while the assignment held the order')
  }
  const res = await callAssign(order.id, printer.id)
  assert.equal(res.status, 200, 'the effect decided before the claim completes')
  await claim
  assert.equal(claimSettled, true)
  assert.equal((await snap(order.id)).row.printerId, printer.id)
  // from the commit of the claim on, every effect is refused
  const next = await prisma.printer.create({ data: { name: 'FAKE A1 mini 2' } })
  const refused = await callAssign(order.id, next.id)
  assert.equal(refused.status, 409)
  assert.equal((await bodyOf(refused)).code, 'REFUND_IN_PROGRESS')
  // nothing was said to a printer or to PrintLab to stop what had been decided
  assert.deepEqual(state.printLab.otherCalls(), [])
})

test('R9 a claim committed first refuses the assignment, and nothing about the order moves', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder(releasedSpec())
  await claimLikeTheProtocolWill(order.id)
  const before = await snap(order.id)
  const res = await callAssign(order.id, printer.id)
  assert.equal(res.status, 409)
  assert.equal((await bodyOf(res)).code, 'REFUND_IN_PROGRESS')
  assertNothingHappened(before, await snap(order.id), 'assign after a claim')
})

// a refund operation can be put in every state the fixtures name, and the fixture helper is the same one the matrix uses
test('R10 the fixture writes the rows it says it writes (guards the guard)', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  await addRefundOperations(order.id, 'pi_x', [{ status: 'abandoned' }, { status: 'unknown' }, { status: 'succeeded', applied: true }])
  const rows = await (await db()).refundOperation.findMany({ where: { orderId: order.id } })
  assert.deepEqual(rows.map((row) => [row.status, row.firstSentAt === null, row.appliedAt !== null]).sort(), [['abandoned', true, false], ['succeeded', false, true], ['unknown', false, false]])
})
