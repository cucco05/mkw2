// Step 4.6, S4 - the VIEWS of production (the queue, the hours of work ahead, the delivery time a customer is told, the planners) against a throw-away database:
//   V1 the queue and the hours ahead hold only orders that are RELEASED to production - an unpaid, held, being-confirmed, open-page or unchecked outside order is not work ahead;
//   V2 the administrator sees what is held back, and why - one line per order, in the right state;
//   V3 the delivery time offered to customers does not grow with orders that are not released;
//   V4 nothing that explains WHY an order is held back (review codes, release state, outside-call journal, authorization) reaches a customer: not the order API, not the snapshot;
//   V5 the planners that look AHEAD (batches, StockWorks predictions) ignore orders that are not released; the ones that look BACK (fleet history, waste) do not count
//      an order that is still waiting for a payment or a review as printed.
// No printer, PrintLab, StockWorks or Stripe account is ever contacted (PrintLab and StockWorks are local fake servers).
import './_harness'
import { db } from './_harness'
import { as, makeOrder, releasedSpec, resetSeams, setup, state, teardown, world, type Spec } from './_release-fixtures'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { NextRequest } from 'next/server'
import { getProductionSnapshot, getOrderProductionDetail } from '../../lib/production'
import { estimateLeadTimeHours } from '../../lib/lead-time-estimator'
import { buildBatchGroups } from '../../lib/batch-optimization'
import { buildFleetIntelligence } from '../../lib/fleet-intelligence'
import { buildWasteReport } from '../../lib/material-optimization'

test.before(setup)
test.after(teardown)
afterEach(resetSeams)

type Case = { key: string; spec: Spec; releaseState: string; reviewReason?: string }
// orders that are in a production STATUS (or look as if they were) but are not released
const HELD: Case[] = [
  { key: 'awaiting', spec: { status: 'awaiting_payment', paymentStatus: 'pending' }, releaseState: 'payment_pending' },
  { key: 'queuedUnpaid', spec: { status: 'queued', paymentStatus: 'pending' }, releaseState: 'payment_pending' },
  { key: 'unproven', spec: { status: 'queued', paymentStatus: 'paid' }, releaseState: 'payment_unproven' },
  { key: 'dispute', spec: releasedSpec({ reason: 'dispute' }), releaseState: 'payment_hold', reviewReason: 'dispute' },
  { key: 'processing', spec: releasedSpec({ paymentStatus: 'processing', attempts: ['processing'], evidence: null }), releaseState: 'payment_processing' },
  { key: 'external', spec: { status: 'awaiting_review', paymentStatus: 'pending', reason: 'external_order' }, releaseState: 'external_review', reviewReason: 'external_order' },
  { key: 'openPage', spec: { status: 'queued', paymentStatus: 'pending', attempts: ['open'] }, releaseState: 'payment_active' },
]
const RELEASED: Array<{ key: string; spec: Spec }> = [
  { key: 'stripe', spec: releasedSpec() },
  { key: 'manual', spec: { status: 'printing', paymentStatus: 'paid', evidence: 'manual' } },
  { key: 'authorized', spec: { status: 'queued', paymentStatus: 'pending', authorization: true } },
]

async function build<T extends { key: string; spec: Spec }>(cases: T[]) {
  const made: Array<T & { id: string }> = []
  for (const entry of cases) made.push({ ...entry, id: (await makeOrder(entry.spec)).id })
  return made
}
const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id).sort()

// every key anywhere in a JSON value
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => keysOf(entry, into))
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { into.add(key); keysOf(entry, into) }
  return into
}
const REASON_KEYS = ['release', 'notReleased', 'paymentReviewReason', 'reviewReason', 'releaseState', 'externalEffects', 'productionAuthorization', 'unresolvedEffects', 'productionEvidence', 'paymentReview']
const REASON_VALUES = /payment_hold|payment_pending|payment_processing|payment_unproven|payment_active|external_review|external_order|"dispute"|duplicate_payment|status_regression/

// ============================================================================================================================================
// V1. The queue and the hours ahead
// ============================================================================================================================================
test('V1 the queue and the hours of work ahead hold only released orders, whatever else exists', async () => {
  await world()
  const released = await build(RELEASED)
  const alone = await getProductionSnapshot()
  assert.deepEqual(ids(alone.orders), ids(released), 'the released orders are the whole queue')
  assert.ok(alone.queueHours > 0, 'sanity: the released orders carry hours of work')

  const held = await build(HELD)
  const withHeld = await getProductionSnapshot()
  assert.deepEqual(ids(withHeld.orders), ids(released), `held-back orders got into the queue: ${ids(withHeld.orders).filter((id) => held.some((entry) => entry.id === id)).join(', ')}`)
  assert.equal(withHeld.queueHours, alone.queueHours, 'orders that are not released add hours to the work ahead')
  for (const [index, entry] of withHeld.orders.entries()) assert.equal(entry.queuePosition, index + 1, 'positions are consecutive: nobody holds a place that is not theirs')
})

test('V1b the snapshot for customers carries no explanation of why anything is held back', async () => {
  await world()
  await build(RELEASED)
  await build(HELD)
  const snapshot = await getProductionSnapshot()
  assert.equal('notReleased' in snapshot, false, 'without `includeRelease` the snapshot has no held-back list at all')
  const found = [...keysOf(JSON.parse(JSON.stringify(snapshot)))].filter((key) => REASON_KEYS.includes(key))
  assert.deepEqual(found, [], `keys that explain a hold are in the customer snapshot: ${found.join(', ')}`)
  assert.ok(!REASON_VALUES.test(JSON.stringify(snapshot)), 'a review code or a release state is in the customer snapshot')
})

// ============================================================================================================================================
// V2. What the administrator sees
// ============================================================================================================================================
test('V2 the administrator sees every held-back order once, with the reason', async () => {
  await world()
  const released = await build(RELEASED)
  const held = await build(HELD)
  // a paid, released order that still says "awaiting review": it waits for an administrator to move it, it is not in the queue
  const [waiting] = await build([{ key: 'waiting', spec: releasedSpec({ status: 'awaiting_review' }) }])

  const snapshot = await getProductionSnapshot({ includeCustomer: true, includeRelease: true })
  assert.deepEqual(ids(snapshot.orders), ids(released), 'the queue is the same with or without the explanation')
  const list = snapshot.notReleased ?? []
  assert.deepEqual(ids(list), ids([...held, waiting]), 'every held-back order is listed, and only those')
  for (const entry of held) {
    const line = list.find((item) => item.id === entry.id)!
    assert.equal(line.release.state, entry.releaseState, `${entry.key}: state`)
    assert.ok(line.release.label.length > 0 && line.release.detail.length > 0, `${entry.key}: the line says why`)
    if (entry.reviewReason) assert.equal(line.release.reviewReason, entry.reviewReason, `${entry.key}: review code`)
  }
  const waitingLine = list.find((item) => item.id === waiting.id)!
  assert.equal(waitingLine.release.state, 'awaiting_admin', 'a paid order that was not moved says it waits for an administrator')
  assert.equal(list.find((item) => item.id === held.find((entry) => entry.key === 'openPage')!.id)!.release.activeUntil != null, true, 'an open payment page says until when')
})

test('V2b an order held after it was sent to production says so and is not offered as work', async () => {
  await world()
  const prisma = await db()
  const order = await makeOrder(releasedSpec({ reason: 'dispute', metadata: { lastPrintLabSubmission: { status: 'started', printLabJobId: 'pl_1' }, printLabSubmissions: [{ printLabJobId: 'pl_1' }], stockworksConsumedAt: new Date().toISOString() } }))
  const snapshot = await getProductionSnapshot({ includeRelease: true })
  assert.ok(!snapshot.orders.some((entry) => entry.id === order.id), 'a held order is not in the queue')
  const line = snapshot.notReleased!.find((entry) => entry.id === order.id)!
  assert.equal(line.printLabStatus, 'started', 'PrintLab said it started: the line says so')
  assert.ok(line.productionEvidence.includes('printlab_submission_recorded') && line.productionEvidence.includes('material_consumed'), `what already went to production is listed: ${line.productionEvidence.join(', ')}`)
  // the row itself is untouched by looking at it
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'queued')
})

// ============================================================================================================================================
// V3. The delivery time customers are told
// ============================================================================================================================================
test('V3 the delivery time offered to customers does not grow with orders that are not released', async () => {
  await world()
  await build(RELEASED)
  const alone = await estimateLeadTimeHours({ baseHours: 2, material: 'PLA' })
  await build(HELD)
  const withHeld = await estimateLeadTimeHours({ baseHours: 2, material: 'PLA' })
  assert.equal(withHeld.signals.queueHours, alone.signals.queueHours, 'queue hours')
  assert.equal(withHeld.signals.queueDelayHours, alone.signals.queueDelayHours, 'queue delay')
  assert.equal(withHeld.hours, alone.hours, 'the estimate')
})

// ============================================================================================================================================
// V4. Nothing that explains a hold reaches a customer
// ============================================================================================================================================
test('V4 a customer reading their own order - whatever its state - is never told the internal reason', async () => {
  await world()
  const prisma = await db()
  const all = await build([...RELEASED, ...HELD, { key: 'waiting', spec: releasedSpec({ status: 'awaiting_review' }) }])
  await prisma.printOrder.updateMany({ where: { id: { in: all.map((entry) => entry.id) } }, data: { userId: state.customerId } })
  // an outside-call journal and an authorization, the two things that must stay inside
  const journaled = await makeOrder(releasedSpec({ reason: 'dispute', metadata: { externalEffects: { 'printlab:item:x': { kind: 'printlab_submit', state: 'uncertain' } }, productionAuthorization: { authorized: true, by: state.adminId, at: new Date().toISOString(), reason: 'x' } } }))
  await prisma.printOrder.update({ where: { id: journaled.id }, data: { userId: state.customerId } })

  as(state.viewers.customer)
  const { GET } = await import('../../app/api/customer/orders/[orderId]/route')
  for (const entry of [...all, { key: 'journaled', id: journaled.id }]) {
    const res = await (GET as any)(new NextRequest(`http://localhost/api/customer/orders/${entry.id}`, { method: 'GET' }), { params: Promise.resolve({ orderId: entry.id }) }) as Response
    assert.equal(res.status, 200, `${entry.key}: the customer can read their order`)
    const body = await res.json()
    const leaked = [...keysOf(body)].filter((key) => REASON_KEYS.includes(key))
    assert.deepEqual(leaked, [], `${entry.key}: keys that explain a hold are in the order API: ${leaked.join(', ')}`)
    assert.ok(!REASON_VALUES.test(JSON.stringify(body)), `${entry.key}: a review code or release state is in the order API`)
  }
})

test('V4b the production detail of an order (customer page and ticket) carries no hold information either', async () => {
  await world()
  const all = await build([...RELEASED, ...HELD])
  const prisma = await db()
  for (const entry of all) {
    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: entry.id }, include: { items: true } })
    const detail = await getOrderProductionDetail({ id: order.id, status: order.status, createdAt: order.createdAt, metadata: order.metadata, items: order.items })
    const leaked = [...keysOf(JSON.parse(JSON.stringify(detail)))].filter((key) => REASON_KEYS.includes(key))
    assert.deepEqual(leaked, [], `${entry.key}: ${leaked.join(', ')}`)
    // an order that is not released has no place in a queue
    if (HELD.some((held) => held.key === entry.key)) assert.equal(detail?.queuePosition ?? null, null, `${entry.key}: a held-back order was given a queue position`)
  }
})

// ============================================================================================================================================
// V5. The planners
// ============================================================================================================================================
test('V5 the batch planner and the StockWorks prediction look only at released orders', async () => {
  await world()
  const released = await build(RELEASED)
  const planned = async () => (await buildBatchGroups()).groups.flatMap((group) => group.orders.map((order) => order.id)).sort()
  assert.deepEqual(await planned(), ids(released), 'sanity: the released orders are planned')

  const { GET } = await import('../../app/api/stockworks/predictions/route')
  as(state.viewers.admin)
  const usage = async () => {
    const res = await (GET as any)() as Response
    assert.equal(res.status, 200)
    return ((await res.json()).inventory as Array<{ id: number; projectedUsage: number }>).map((item) => [item.id, item.projectedUsage])
  }
  const usageAlone = await usage()
  assert.ok(usageAlone.some(([, grams]) => (grams as number) > 0), 'sanity: the released orders are expected to use material')

  const held = await build(HELD)
  assert.deepEqual(await planned(), ids(released), `held-back orders were planned: ${(await planned()).filter((id) => held.some((entry) => entry.id === id)).join(', ')}`)
  assert.deepEqual(await usage(), usageAlone, 'orders that are not released are expected to use material')
})

test('V5b the history readers do not count an order that waits for a payment or a review as printed', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini', dailyCapacityHours: 20 } })
  const hoursOf = async () => {
    const row = (await buildFleetIntelligence()).find((entry) => entry.id === printer.id)!
    return row.utilization.reduce((sum, cell) => sum + cell.hours, 0)
  }
  const ordersCounted = async () => (await buildWasteReport()).reduce((sum, entry) => sum + entry.totalOrders, 0)

  const waiting = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending' })
  const review = await makeOrder({ status: 'awaiting_review', paymentStatus: 'paid', evidence: 'stripe' })
  await prisma.printOrder.updateMany({ where: { id: { in: [waiting.id, review.id] } }, data: { printerId: printer.id } })
  assert.equal(await hoursOf(), 0, 'the fleet history counted hours for orders that never printed')
  assert.equal(await ordersCounted(), 0, 'the waste report counted orders that never printed')

  // control: an order that really printed is counted by both
  const printed = await makeOrder(releasedSpec({ status: 'completed' }))
  await prisma.printOrder.update({ where: { id: printed.id }, data: { printerId: printer.id } })
  assert.ok((await hoursOf()) > 0, 'sanity: a completed order counts in the fleet history')
  assert.equal(await ordersCounted(), 1, 'sanity: a completed order counts in the waste report')
})
