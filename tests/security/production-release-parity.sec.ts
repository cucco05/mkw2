// Step 4.6, S4 -
//   P  the Prisma PREFILTER `releasedOrderWhere` (used to PICK orders: the automatic queue, the planners) against the rule `releaseDecision` (used to ALLOW an
//      effect), on rows in a real database. The prefilter may never admit an order the rule refuses, except in the one documented case; and it must not leave out
//      an order the rule releases. Matrix rows first, then 400 random combinations from a fixed seed.
//   H  a payment hold that lands on an order that was ALREADY sent to PrintLab: nothing is undone and nothing is sent, but nothing moves either, and everything is
//      visible to the administrator (the case the plan calls "blocco dopo l'invio").
// No printer, PrintLab, StockWorks or Stripe account is ever contacted (PrintLab and StockWorks are local fake servers).
import './_harness'
import { db } from './_harness'
import {
  RELEASE_MATRIX, as, assertOnlyMetadataMayChange, bodyOf, callAssign, callAutoQueue, callCallback, callStatus, callSubmit, makeOrder, releasedSpec, resetSeams, setup, snap, state, teardown, world,
} from './_release-fixtures'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { REFUND_OPERATION_STATUSES, RELEASE_FACTS_SELECT, refundOperationBlocks, releaseDecision, releasedOrderWhere } from '../../lib/order-payment-policy'
import { getProductionSnapshot, printLabSignalOrderStatus } from '../../lib/production'
import { maybeConsumeStockForOrder } from '../../lib/stockworks-consumption'

test.before(setup)
test.after(teardown)
afterEach(resetSeams)

// ---------------------------------------------------------------------------------------------------------------------------------------------
// P. The prefilter against the rule
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function judge(orderId: string) {
  const prisma = await db()
  const facts = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, select: RELEASE_FACTS_SELECT })
  const decision = releaseDecision(facts)
  const picked = (await prisma.printOrder.count({ where: { AND: [{ id: orderId }, releasedOrderWhere()] } })) === 1
  return { decision, picked, facts }
}
// The one case where the prefilter is wider than the rule (documented in lib/order-payment-policy.ts): an outside order that an administrator authorized and that
// LATER got a money problem recorded only in the review log. The prefilter can not read that log; every effect re-decides under the lock.
const explainedByTheLog = (row: { reason: string | null }, decision: { state: string }) => row.reason === 'external_order' && decision.state === 'payment_hold'
// (step 4.6, S6) the second documented exception, in two parts. The prefilter is a Prisma filter: it can read that a key is PRESENT in a JSON value, not what the value
// MEANS. So it admits (and the rule, under the lock, refuses):
//   (a) an order whose `productionAuthorization` has the shape of one (authorized, by, a revision present) when the rule finds it not valid: the revision is not the order's
//       (a value inside a JSON can not be compared with the revision COLUMN), it is not a revision at all, or a commercial credit lacks its amount due;
//   (b) an order whose attested payment has all its keys when the rule finds it does not hold: the amount does not cover the total, the currency is another, the method
//       can not be attested (PayPal), the receipt method does not fit - checks that compare two fields or list values.
// Everything else is exact: an order WITHOUT one of these two shapes is never admitted when the rule refuses it.
const filled = (value: unknown) => value !== undefined && value !== null && value !== ''
const authorizationShape = (metadata: Record<string, any>) => {
  const a = metadata.productionAuthorization
  return Boolean(a) && a.authorized === true && filled(a.by) && filled(a.financialRevision)
}
const attestedShape = (metadata: Record<string, any>, paymentStatus: string) =>
  ['paid', 'success', 'succeeded', 'free'].includes(paymentStatus) && ['by', 'at', 'reason', 'method', 'receivedVia', 'amountCents', 'currency'].every((key) => filled(metadata.manualPayment?.[key]))
const explainedByShapeOnly = (metadata: Record<string, unknown>, paymentStatus: string) => authorizationShape(metadata as any) || attestedShape(metadata as any, paymentStatus)

test('P1 on every row of the state matrix the prefilter and the rule agree (the one documented exception aside)', async () => {
  await world()
  const disagreements: string[] = []
  for (const fx of RELEASE_MATRIX) {
    const order = await makeOrder(fx)
    const { decision, picked } = await judge(order.id)
    if (decision.released !== fx.expect.released) disagreements.push(`${fx.name}: the rule says released=${decision.released}, expected ${fx.expect.released}`)
    if (decision.released && !picked) disagreements.push(`${fx.name}: the rule releases it but the prefilter leaves it out (it would never be picked)`)
    if (!decision.released && picked && !explainedByTheLog({ reason: fx.reason ?? null }, decision)) disagreements.push(`${fx.name}: the prefilter admits an order the rule refuses`)
  }
  assert.deepEqual(disagreements, [])
})

test('P2 the documented exception is exactly that: an authorized outside order with a money problem found later and written only in the review log', async () => {
  await world()
  const order = await makeOrder({ status: 'awaiting_review', reason: 'external_order', authorization: true, metadata: { paymentReview: [{ reason: 'duplicate_payment', at: new Date().toISOString() }] } })
  const { decision, picked } = await judge(order.id)
  assert.equal(decision.released, false, 'the rule sees the log')
  assert.equal(decision.state, 'payment_hold')
  assert.equal(picked, true, 'the prefilter can not see the log (so every effect re-decides)')
  // and the effect itself refuses it
  const prisma = await db()
  await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  as(state.viewers.admin)
  const before = await snap(order.id)
  await (await callAutoQueue()).text()
  assert.equal((await snap(order.id)).row.printerId, before.row.printerId, 'the automatic queue picked it up and assigned it')
})

test('P3 whitespace-only proof fields: the prefilter admits what the rule refuses (declared); the effect refuses', async () => {
  await world()
  const prisma = await db()
  await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder({ paymentStatus: 'paid', metadata: { manualPayment: { by: state.adminId, at: new Date().toISOString(), reason: '   ', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR' } } })
  const { decision, picked } = await judge(order.id)
  assert.equal(decision.released, false, 'a manual payment with a blank reason is not a record')
  assert.equal(decision.state, 'payment_unproven')
  // Prisma can not trim inside a JSON value, so the prefilter is wider here; the effect re-decides and refuses
  assert.equal(picked, true)
  as(state.viewers.admin)
  const res = await callAutoQueue()
  assert.equal(res.status, 200)
  assert.equal((await snap(order.id)).row.printerId, null, 'an order the rule refuses was assigned')
})

// ---- random combinations --------------------------------------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('P4 400 random combinations of payment facts: the prefilter never admits what the rule refuses, and never leaves out what it releases', async () => {
  await world()
  const prisma = await db()
  const random = mulberry32(20261017)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
  const chance = (p: number) => random() < p
  const HOUR = 3600_000
  const problems: string[] = []
  const counts = { released: 0, refused: 0, explained: 0 }

  for (let index = 0; index < 400; index++) {
    const paymentStatus = pick(['pending', 'paid', 'paid', 'succeeded', 'success', 'free', 'processing', 'requires_capture', 'canceled', 'quote', 'failed', ''])
    const reason = pick([null, null, null, '', 'external_order', 'external_order', 'dispute', 'amount', 'duplicate_payment', 'a_code_nobody_knows'])
    const total = pick([0, 2500, 2500])
    const withPi = chance(0.5)
    const withInvoice = chance(0.2)
    const metadata: Record<string, unknown> = { fuzz: index }
    if (chance(0.4)) metadata.stripe = { paymentIntentId: 'pi_x', paymentStatus: pick(['paid', 'processing', 'requires_payment_method']) }
    if (chance(0.15)) metadata.stripeInvoice = { paymentStatus: pick(['paid', 'open']) }
    if (chance(0.25)) metadata.paypal = { ...(chance(0.7) ? { captureId: 'cap_1' } : {}), ...(chance(0.7) ? { paymentStatus: pick(['paid', 'pending']) } : {}) }
    if (chance(0.4)) {
      // (step 4.6, S6) the shape of a payment attested by an administrator, with the ways it can be wrong
      const manual: Record<string, unknown> = {
        by: 'admin_1', at: new Date().toISOString(), reason: 'cash at the counter', method: pick(['cash', 'cash', 'cash', 'cash', 'invoice', 'po', 'paypal', 'comped']),
        receivedVia: pick(['cash', 'cash', 'cash', 'cash', 'bank_transfer', 'none', 'barter']), amountCents: pick([0, 2499, 2500, 2500, 2500, 2501, '2500']), currency: pick(['EUR', 'EUR', 'EUR', 'USD']),
        ...(chance(0.6) ? { reference: 'CRO 1' } : {}),
      }
      if (chance(0.15)) delete manual[pick(['by', 'at', 'reason', 'method', 'receivedVia', 'amountCents', 'currency'])]
      metadata.manualPayment = manual
    }
    if (chance(0.3)) {
      const authorization: Record<string, unknown> = { authorized: pick([true, true, false]), at: new Date().toISOString(), reason: 'agreed', kind: pick(['exceptional', 'exceptional', 'commercial_credit', undefined]) }
      if (chance(0.8)) authorization.by = 'admin_1'
      // the revision the authorization was given at: the order's own (0 or 1), or something that is not a revision
      authorization.financialRevision = pick([0, 0, 0, 1, undefined, '0', -1, 0.5])
      if (chance(0.5)) authorization.credit = pick([{ method: 'invoice', reference: 'INV-1', amountDueCents: 2500, currency: 'EUR' }, { method: 'invoice' }, 'x'])
      metadata.productionAuthorization = authorization
    }
    if (chance(0.2)) metadata.paymentReview = pick([[], [{ reason: 'external_order' }], [{ reason: 'duplicate_payment' }], [{ reason: 'external_order' }, { reason: 'dispute' }], ['garbage'], 'garbage'])
    const attempts = Array.from({ length: pick([0, 0, 1, 1, 2, 3]) }, () => ({
      amountCents: total, currency: 'EUR', status: pick(['creating', 'open', 'processing', 'paid', 'expired', 'failed', 'mismatch']),
      expiresAt: new Date(Date.now() + pick([-2 * HOUR, -5 * 60_000, -9 * 60_000, 60_000, HOUR])),
    }))
    // (step 4.6, S6) refunds: a refunded amount, refund operations in every state, and the revision of the order
    const refundedCents = pick([0, 0, 0, 0, 500, 2500])
    const financialRevision = pick([0, 0, 0, 1])
    const operations = chance(0.2)
      ? Array.from({ length: pick([1, 1, 2]) }, () => ({
        paymentIntentId: 'pi_fuzz_op', amountCents: 100, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate', note: 'a fuzz operation',
        status: pick([...REFUND_OPERATION_STATUSES, 'something_nobody_knows']), appliedAt: chance(0.5) ? new Date() : null,
        // (the CHECK constraint of the migration: an abandoned operation has no firstSentAt)
        ...(chance(0.5) ? {} : {}),
      }))
      : []
    const order = await prisma.printOrder.create({
      data: {
        status: 'queued', paymentMethod: 'card', paymentStatus, paymentReviewReason: reason, subtotalCents: total, totalCents: total, currency: 'EUR', refundedCents, financialRevision,
        ...(withPi ? { stripePaymentIntentId: `pi_fuzz_${index}_${Date.now()}` } : {}),
        ...(withInvoice ? { stripeInvoiceId: `in_fuzz_${index}_${Date.now()}` } : {}),
        ...(chance(0.4) ? { paidAt: new Date() } : {}),
        metadata: metadata as any,
        paymentAttempts: { create: attempts },
        ...(operations.length > 0 ? { refundOperations: { create: operations.map((operation, opIndex) => ({ id: `op_fuzz_${index}_${opIndex}_${Date.now()}`, ...operation })) } } : {}),
      } as any,
    })
    const { decision, picked } = await judge(order.id)
    const label = `#${index} ${JSON.stringify({ paymentStatus, reason, total, withPi, withInvoice, refundedCents, financialRevision, operations: operations.map((o) => `${o.status}/${o.appliedAt ? 'applied' : 'open'}`), metadata, attempts: attempts.map((a) => a.status) })}`
    // on ONE point the prefilter is exact, not just wide enough: an order with a refund operation that blocks is never picked
    if (operations.some((operation) => refundOperationBlocks(operation)) && picked) problems.push(`a refund operation blocks it but the prefilter admits it: ${label}`)
    if (decision.released) {
      counts.released++
      if (!picked) problems.push(`released but left out by the prefilter: ${label}`)
    } else {
      counts.refused++
      if (picked) {
        if (explainedByTheLog({ reason }, decision)) counts.explained++
        else if (explainedByShapeOnly(metadata, paymentStatus)) counts.explained++
        else problems.push(`refused (${decision.state}) but admitted by the prefilter: ${label}`)
      }
    }
  }
  // the sample must be worth something: it has both kinds
  assert.ok(counts.released >= 20 && counts.refused >= 100, `the random sample is too one-sided: ${JSON.stringify(counts)}`)
  assert.deepEqual(problems, [])
})

test('P5 refund operations (S6): for every status, applied or not, and every way an order is released, the prefilter and the rule say the same thing', async () => {
  await world()
  const prisma = await db()
  const bases: Array<[string, Parameters<typeof makeOrder>[0]]> = [
    ['Stripe payment', releasedSpec()],
    ['authorization', { status: 'queued', paymentStatus: 'pending', authorization: true }],
    ['attested payment', { paymentStatus: 'paid', evidence: 'manual' }],
  ]
  let seq = 0
  const problems: string[] = []
  for (const [name, spec] of bases) {
    for (const status of [...REFUND_OPERATION_STATUSES, 'something_nobody_knows']) {
      for (const applied of [false, true]) {
        const order = await makeOrder(spec)
        const appliedAt = applied ? new Date() : null
        await prisma.refundOperation.create({
          data: { id: `op_p5_${++seq}_${Date.now()}`, orderId: order.id, paymentIntentId: 'pi_p5', amountCents: 100, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate', note: 'parity', status, appliedAt },
        })
        const { decision, picked } = await judge(order.id)
        const blocks = refundOperationBlocks({ status, appliedAt })
        const label = `${name} / ${status} / ${applied ? 'applied' : 'not applied'}`
        if (decision.released === blocks) problems.push(`${label}: the rule says released=${decision.released}, the operation ${blocks ? 'blocks' : 'does not block'}`)
        if (picked === blocks) problems.push(`${label}: the prefilter picked=${picked}, the operation ${blocks ? 'blocks' : 'does not block'}`)
        if (blocks && decision.state !== 'payment_refund_pending') problems.push(`${label}: state ${decision.state}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// H. A payment hold that lands on an order already sent to PrintLab
// ---------------------------------------------------------------------------------------------------------------------------------------------
test('H1 a hold after the order was sent to PrintLab: nothing is undone and nothing is sent, nothing moves, everything is visible; once accepted the administrator aligns it', async () => {
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  const order = await makeOrder(releasedSpec({ items: 2, metadata: { slicerStats: { materials: [{ material: 'PLA', grams: 20, colors: ['black'] }] } } }))
  as(state.viewers.admin)

  // 1. released and sent: one job per line
  const sent = await callSubmit(order.id)
  assert.equal(sent.status, 200, JSON.stringify(await bodyOf(sent)))
  assert.equal(state.printLab.submissions().length, 2)
  const heard = state.printLab.requests.length

  // 2. the dispute: what the payment verification records - a review reason and a log entry; the status and the payment status stay as they were
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  await prisma.printOrder.update({
    where: { id: order.id },
    data: { paymentReviewReason: 'dispute', metadata: { ...(row.metadata as any), paymentReview: [{ reason: 'dispute', at: new Date().toISOString() }] } },
  })
  const held = await snap(order.id)
  assert.equal(held.row.status, 'queued')
  assert.equal(held.row.paymentStatus, 'paid')

  // 3. nothing new may happen
  assert.equal((await callStatus(order.id, 'printing')).status, 409, 'the order advanced while on hold')
  const again = await callSubmit(order.id)
  assert.equal(again.status, 409, 'the order was sent again while on hold')
  assert.equal((await bodyOf(again)).code, 'PAYMENT_ON_HOLD')
  assert.equal((await callAssign(order.id, printer.id)).status, 409, 'a printer was assigned while on hold')
  assert.equal((await callAutoQueue()).status, 200)
  assert.equal((await snap(order.id)).row.printerId, null, 'the automatic queue picked up a held order')
  assert.equal(state.printLab.requests.length, heard, 'PrintLab heard something new about a held order')

  // 4. what PrintLab says is recorded, and does not move the order
  for (const [signal, recorded] of [['started', 'started'], ['completed', 'completed']] as const) {
    const before = await snap(order.id)
    const res = await callCallback(order.id, signal)
    assert.equal(res.status, 200, 'PrintLab is always answered')
    const after = await snap(order.id)
    assertOnlyMetadataMayChange(before, after, `callback ${signal}`)
    assert.equal(after.row.status, 'queued', `a PrintLab "${signal}" moved a held order`)
    assert.equal(after.row.metadata.lastPrintLabSubmission.status, recorded, 'the signal is recorded')
  }

  // 5. the material is not taken out of stock while it is held (even when PrintLab says completed and the status is later aligned by hand)
  await prisma.printOrder.update({ where: { id: order.id }, data: { status: 'completed' } }) // a stand-in for a status that was aligned some other way
  const stock = await maybeConsumeStockForOrder(order.id, 'hold-test')
  assert.equal(stock.ok, false)
  assert.equal((stock as any).reason, 'not_released')
  assert.equal(state.stockWorks.posts().length, 0, 'stock was moved for a held order')
  await prisma.printOrder.update({ where: { id: order.id }, data: { status: 'queued' } })

  // 6. the administrator sees it: not in the queue, in "not in production", with what PrintLab said and what already went to production
  const snapshot = await getProductionSnapshot({ includeRelease: true })
  assert.ok(!snapshot.orders.some((entry) => entry.id === order.id))
  const line = snapshot.notReleased!.find((entry) => entry.id === order.id)!
  assert.equal(line.release.state, 'payment_hold')
  assert.equal(line.release.reviewReason, 'dispute')
  assert.equal(line.printLabStatus, 'completed')
  assert.ok(line.productionEvidence.includes('printlab_job_confirmed') && line.productionEvidence.includes('printlab_submission_recorded'), line.productionEvidence.join(', '))

  // 7. nothing commanded a printer, nothing was cancelled at PrintLab
  assert.deepEqual(state.printLab.otherCalls(), [], 'something other than the first submission was asked of PrintLab')

  // 8. the hold is accepted (what `accepted` does: the review reason is cleared). The order is released again - and is NOT moved by itself.
  await prisma.printOrder.update({ where: { id: order.id }, data: { paymentReviewReason: null } })
  const released = await snap(order.id)
  assert.equal(released.row.status, 'queued', 'accepting the hold moved the order')
  assert.equal(printLabSignalOrderStatus(released.row.metadata.lastPrintLabSubmission.status, released.row.status), 'completed', 'the page can tell the administrator what PrintLab says')
  assert.equal(state.stockWorks.posts().length, 0)

  // 9. the administrator aligns it: the status moves, and only now is the material taken out of stock
  const aligned = await callStatus(order.id, 'completed')
  assert.equal(aligned.status, 200, JSON.stringify(await bodyOf(aligned)))
  assert.ok(state.stockWorks.posts().length >= 1, 'once released and completed, the material is taken out of stock')
})
