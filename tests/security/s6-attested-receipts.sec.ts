// Step 4.6, S6a (P6) - what counts as a payment taken OUTSIDE Stripe, and what is only a credit.
// Written BEFORE the fixes (red on the code of step S5, b464d04), green after. Matrix numbers refer to the S6 plan, revision 3.1.
//   F09  a job paid by "invoice" or "purchase order" is registered as PAID (it is a credit, not money); PayPal is "attested" by a word; the record has no amount   M31-M34 M68-M73
//   F21  the old checkout keeps a PaymentIntent id chosen by the browser; an outside sender can overwrite the ids the server wrote                              M45 M46
//   F22  the metadata helper accepts ANY column of the order                                                                                                    M48
//   The commercial credit (an invoice / PO order produced before the money arrives) is a different authorization, with the amount still due always visible       M69-M71 M74
// Fake Stripe, throw-away database, fake data. Nothing reaches a real service.
import { db } from './_harness'
import { ORIGIN, as, asKey, bodyOf, callStatus, makeOrder, request, resetSeams, setup, state, teardown, world } from './_release-fixtures'
import { cart, flow, freshFlow, initFlow, decisionOf } from './_s6-flow'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'

test.before(async () => {
  await setup()
  await initFlow({ reset: false })
})
test.after(async () => {
  const { endFlow } = await import('./_s6-flow')
  endFlow()
  await teardown()
})
test.beforeEach(async () => {
  resetSeams()
  await freshFlow()
  await world()
  asKey('admin')
})

const REASON = 'Checked with the customer on the phone'
let seq = 0

async function mkJob(paymentIntentId: string, over: Record<string, unknown> = {}) {
  const prisma = await db()
  return prisma.jobForm.create({
    data: {
      paymentIntentId, totalCents: 9000, currency: 'EUR', status: 'pending', paymentMethod: 'cash', paymentStatus: 'pending',
      lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 90, lineTotal: 90, material: 'PLA' }], shipping: { method: 'pickup' }, ...over,
    } as any,
  })
}
const patchJob = async (paymentIntentId: string, body: Record<string, unknown>) => {
  const { PATCH } = await import('../../app/api/jobs/[paymentIntentId]/route')
  const res = (await (PATCH as any)(new NextRequest(`${ORIGIN}/api/jobs/${paymentIntentId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ paymentIntentId }) })) as Response
  return { res, json: await bodyOf(res) }
}
const ordersOf = async (paymentIntentId: string) => (await db()).printOrder.findMany({ where: { metadata: { path: ['paymentIntentId'], equals: paymentIntentId } } })
const nextId = (prefix: string) => `${prefix}_s6_${++seq}_${Date.now()}`
const decisionFor = (orderId: string) => decisionOf(orderId)

// ======================================================================================================================================
// F09 - a payment attested by an administrator: cash or bank transfer, the amount from the server
// ======================================================================================================================================
test('M31 cash: registered as paid, the amount and the currency are the ORDER\'s (never typed), the receipt method and the reason are kept', async () => {
  const id = nextId('cash')
  await mkJob(id, { paymentMethod: 'cash' })
  const { res, json } = await patchJob(id, { paymentStatus: 'paid', reason: REASON, amountCents: 1, currency: 'USD' })
  assert.equal(res.status, 200, JSON.stringify(json))
  const [order] = await ordersOf(id)
  assert.equal(order.paymentStatus, 'paid')
  const manual = (order.metadata as any).manualPayment
  assert.equal(manual.method, 'cash')
  assert.equal(manual.receivedVia, 'cash')
  assert.equal(manual.amountCents, order.totalCents, 'the amount is the order total, not what the browser typed')
  assert.equal(manual.currency, order.currency)
  assert.equal(manual.by, state.adminId)
  const decision = await decisionFor(order.id)
  assert.equal(decision.basis, 'manual_payment')
})

test('M72 a bank transfer for an invoice: needs the bank reference; with it the order is paid and released as a manual payment', async () => {
  const id = nextId('invoice')
  await mkJob(id, { paymentMethod: 'invoice' })
  const noReference = await patchJob(id, { paymentStatus: 'paid', receivedVia: 'bank_transfer', reason: REASON })
  assert.equal(noReference.res.status, 400, JSON.stringify(noReference.json))
  assert.equal(noReference.json.code, 'RECEIPT_REFERENCE_REQUIRED')
  assert.equal((await ordersOf(id)).length, 0, 'nothing is registered without the reference')
  const ok = await patchJob(id, { paymentStatus: 'paid', receivedVia: 'bank_transfer', reference: 'CRO 0123456789', reason: REASON })
  assert.equal(ok.res.status, 200, JSON.stringify(ok.json))
  const [order] = await ordersOf(id)
  assert.equal(order.paymentStatus, 'paid')
  const manual = (order.metadata as any).manualPayment
  assert.equal(manual.method, 'invoice')
  assert.equal(manual.receivedVia, 'bank_transfer')
  assert.equal(manual.reference, 'CRO 0123456789')
  assert.equal(manual.amountCents, 9000)
  assert.equal((await decisionFor(order.id)).basis, 'manual_payment')
})

for (const method of ['invoice', 'po']) {
  test(`M68 a ${method} job marked "paid" with no receipt: refused - it is a CREDIT, not money; nothing is created, the job stays unpaid`, async () => {
    const id = nextId(method)
    await mkJob(id, { paymentMethod: method })
    const { res, json } = await patchJob(id, { paymentStatus: 'paid', reason: REASON })
    assert.equal(res.status, 409, JSON.stringify(json))
    assert.equal(json.code, 'INVOICE_OR_PO_IS_CREDIT')
    assert.equal((await ordersOf(id)).length, 0)
    assert.equal((await (await db()).jobForm.findUniqueOrThrow({ where: { paymentIntentId: id } })).paymentStatus, 'pending')
  })
}

test('M32 PayPal is not a payment an administrator can "attest" by a word (the PayPal capture is verified by the server or it is not paid)', async () => {
  const id = nextId('paypal')
  await mkJob(id, { paymentMethod: 'paypal' })
  const { res, json } = await patchJob(id, { paymentStatus: 'paid', reason: REASON })
  assert.equal(res.status, 409, JSON.stringify(json))
  assert.equal(json.code, 'PAYPAL_NOT_ATTESTABLE')
  assert.equal((await ordersOf(id)).length, 0)
})

test('M31/M72 the order already exists (made earlier from the job): the attested receipt is recorded on it, in one transaction with its audit event', async () => {
  const id = nextId('invoice')
  const job = await mkJob(id, { paymentMethod: 'invoice' })
  // the order made from the job before the money arrived (what an outside order or an earlier flow leaves behind)
  const existing = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending', total: 9000 }, { metadata: { paymentIntentId: id, jobFormId: job.id, source: 'orderworks' } })
  await (await db()).printOrder.update({ where: { id: existing.id }, data: { paymentMethod: 'invoice' } })
  const { res, json } = await patchJob(id, { paymentStatus: 'paid', receivedVia: 'bank_transfer', reference: 'CRO 55', reason: REASON })
  assert.equal(res.status, 200, JSON.stringify(json))
  const order = await (await db()).printOrder.findUniqueOrThrow({ where: { id: existing.id } })
  assert.equal(order.paymentStatus, 'paid', 'the receipt must reach the order that already exists, not be silently dropped')
  assert.equal((order.metadata as any).manualPayment.receivedVia, 'bank_transfer')
  assert.equal(order.paidAt, null, 'an attested receipt never looks like a Stripe payment date')
  assert.equal(order.stripePaymentIntentId, null)
  assert.equal((await decisionFor(order.id)).basis, 'manual_payment')
  const audit = await (await db()).adminAuditEvent.findFirst({ where: { action: 'admin.job.payment' }, orderBy: { createdAt: 'desc' } })
  assert.match(JSON.stringify(audit?.metadata ?? {}), /CRO 55|bank_transfer/)
})

test('M31d a receipt that was registered is not changed or erased from here: registering it again (another way of receiving, another reason) is refused with 409, and the order, its record and the audit trail stay exactly as they were', async () => {
  const id = nextId('cash')
  await mkJob(id, { paymentMethod: 'cash' })
  assert.equal((await patchJob(id, { paymentStatus: 'paid', reason: REASON })).res.status, 200)
  const [order] = await ordersOf(id)
  const prisma = await db()
  const job = await prisma.jobForm.findUniqueOrThrow({ where: { paymentIntentId: id } })
  const look = async () => ({
    order: JSON.parse(JSON.stringify(await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } }))),
    audits: await prisma.adminAuditEvent.count({ where: { targetId: { in: [order.id, job.id] } } }),
  })
  const before = await look()
  assert.equal(before.order.metadata.manualPayment.reason, REASON)
  const again = await patchJob(id, { paymentStatus: 'paid', paymentMethod: 'invoice', receivedVia: 'bank_transfer', reference: 'CRO 99', reason: 'a different story told later on' })
  assert.equal(again.res.status, 409, JSON.stringify(again.json))
  assert.equal(again.json.code, 'RECEIPT_ALREADY_REGISTERED')
  const after = await look()
  assert.deepEqual(after.order, before.order, 'a registered receipt was changed by a second registration')
  assert.equal(after.audits, before.audits, 'a refused registration left a trace as if it had happened')
  assert.equal((await prisma.jobForm.findUniqueOrThrow({ where: { paymentIntentId: id } })).paymentMethod, 'cash', 'the job followed a registration the order refused')
})

test('M33 the total changes after a payment was registered: the record no longer covers it, the order is "paid" with no proof until the receipt is registered again', async () => {
  const id = nextId('cash')
  await mkJob(id, { paymentMethod: 'cash' })
  assert.equal((await patchJob(id, { paymentStatus: 'paid', reason: REASON })).res.status, 200)
  const [order] = await ordersOf(id)
  assert.equal((await decisionFor(order.id)).released, true)
  const item = await (await db()).printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/items/[itemId]/route')
  const changed = await (PATCH as any)(request(`/api/admin/orders/${order.id}/items/${item.id}`, 'PATCH', { quantity: item.quantity + 1, reason: 'one more part, agreed at the counter' }), { params: Promise.resolve({ orderId: order.id, itemId: item.id }) })
  assert.equal(changed.status, 200, JSON.stringify(await bodyOf(changed)))
  const decision = await decisionFor(order.id)
  assert.equal(decision.released, false)
  assert.equal(decision.state, 'payment_unproven', 'the registered amount no longer covers the order total')
})

test('M73 records from before S6 are NOT valid proof: PayPal, a missing amount, a missing receipt method, or an amount that does not cover the total (an invoice / purchase order counts only through the money that arrived)', async () => {
  const valid = { by: state.adminId, at: new Date().toISOString(), reason: 'cash received at the counter', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR' }
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['a complete record', valid, true],
    ['the old shape (no amount, no receipt method)', { by: valid.by, at: valid.at, reason: valid.reason, method: 'cash' }, false],
    ['invoice paid in cash (the money arrived)', { ...valid, method: 'invoice' }, true],
    ['purchase order paid in cash (the money arrived)', { ...valid, method: 'po' }, true],
    ['an invoice record of the old shape (nothing says the money arrived)', { by: valid.by, at: valid.at, reason: valid.reason, method: 'invoice' }, false],
    ['method paypal', { ...valid, method: 'paypal' }, false],
    ['receipt method nobody knows', { ...valid, receivedVia: 'barter' }, false],
    ['amount lower than the total', { ...valid, amountCents: 2499 }, false],
    ['amount not a number', { ...valid, amountCents: '2500' }, false],
    ['another currency', { ...valid, currency: 'USD' }, false],
    ['a bank transfer without its reference', { ...valid, method: 'invoice', receivedVia: 'bank_transfer' }, false],
    ['a bank transfer with its reference', { ...valid, method: 'invoice', receivedVia: 'bank_transfer', reference: 'CRO 1' }, true],
  ]
  for (const [name, manualPayment, ok] of cases) {
    const order = await makeOrder({ paymentStatus: 'paid', total: 2500, metadata: { manualPayment } })
    const decision = await decisionFor(order.id)
    assert.equal(decision.released, ok, `${name}: ${decision.state}`)
    if (ok) assert.equal(decision.basis, 'manual_payment', name)
    else assert.equal(decision.state, 'payment_unproven', name)
  }
})

// ======================================================================================================================================
// The commercial credit: an invoice / purchase order is produced on credit, with a written decision, and the amount still due stays visible
// ======================================================================================================================================
async function creditOrder(method: 'invoice' | 'po' | 'cash', total = 12000) {
  const order = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending', total })
  await (await db()).printOrder.update({ where: { id: order.id }, data: { paymentMethod: method } })
  return order
}
test('M69 commercial credit: an invoice order is released on a written decision, stays "pending", and the amount still due is in the decision and the audit trail', async () => {
  const order = await creditOrder('invoice')
  const res = await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationKind: 'commercial_credit', creditReference: 'INV-2026-0042', authorizationReason: 'agreed 30 days, trusted customer' })
  assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.paymentStatus, 'pending', 'a credit is not a payment')
  const decision = await decisionFor(order.id)
  assert.equal(decision.released, true)
  assert.equal(decision.basis, 'commercial_credit')
  assert.deepEqual({ ...(decision as any).credit }, { method: 'invoice', reference: 'INV-2026-0042', amountDueCents: 12000, currency: 'EUR', dueAt: null })
  const audit = await (await db()).adminAuditEvent.findFirst({ where: { targetId: order.id, action: 'admin.order.commercial_credit.authorize' } })
  assert.ok(audit, 'the credit decision has its own audit event')
  assert.match(JSON.stringify(audit?.metadata ?? {}), /12000/)
})

test('M70 the two kinds of authorization are not interchangeable: an exceptional one on an invoice order, a commercial one on a cash order', async () => {
  const invoice = await creditOrder('invoice')
  const exceptional = await callStatus(invoice.id, 'queued', { authorizeUnpaid: true, authorizationReason: 'agreed 30 days, trusted customer' })
  assert.equal(exceptional.status, 409, JSON.stringify(await bodyOf(exceptional)))
  assert.equal((await bodyOf(exceptional)).code, 'CREDIT_KIND_MISMATCH')
  const cash = await creditOrder('cash')
  const wrong = await callStatus(cash.id, 'queued', { authorizeUnpaid: true, authorizationKind: 'commercial_credit', creditReference: 'INV-1', authorizationReason: 'agreed 30 days, trusted customer' })
  assert.equal(wrong.status, 409, JSON.stringify(await bodyOf(wrong)))
  assert.equal((await bodyOf(wrong)).code, 'CREDIT_KIND_MISMATCH')
  for (const order of [invoice, cash]) assert.equal((await decisionFor(order.id)).released, false)
})

test('M74 a credit is suspended when the total changes: the decision was for another amount due', async () => {
  const order = await creditOrder('po', 8000)
  assert.equal((await callStatus(order.id, 'queued', { authorizeUnpaid: true, authorizationKind: 'commercial_credit', creditReference: 'PO-77', authorizationReason: 'purchase order received' })).status, 200)
  const item = await (await db()).printOrderItem.findFirstOrThrow({ where: { orderId: order.id } })
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/items/[itemId]/route')
  const changed = await (PATCH as any)(request(`/api/admin/orders/${order.id}/items/${item.id}`, 'PATCH', { quantity: 2, reason: 'the purchase order was amended' }), { params: Promise.resolve({ orderId: order.id, itemId: item.id }) })
  assert.equal(changed.status, 200, JSON.stringify(await bodyOf(changed)))
  assert.equal((await decisionFor(order.id)).released, false)
})

// ======================================================================================================================================
// F21 - ids that only the server may write
// ======================================================================================================================================
test('M45 the old checkout ignores a PaymentIntent id chosen by the browser for a quote request: no Stripe column, no Stripe read, an id made by the server', async () => {
  const { POST } = await import('../../app/api/checkout/route')
  viewerGuards.getViewer = async () => null
  const victim = 'pi_someone_elses_real_payment_123'
  const res = (await (POST as any)(new NextRequest('http://localhost/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-forwarded-for': '10.66.0.1' },
    body: JSON.stringify({ ...cart(), paymentMethod: 'quote', commit: true, paymentIntentId: victim }),
  }), {})) as Response
  assert.equal(res.status, 200, await res.clone().text())
  const body = await res.json()
  assert.notEqual(body.paymentIntentId, victim, 'the id of the order is made by the server')
  const prisma = await db()
  const orders = await prisma.printOrder.findMany({ where: { OR: [{ stripePaymentIntentId: victim }, { metadata: { path: ['paymentIntentId'], equals: victim } }] } })
  assert.equal(orders.length, 0, 'the browser\'s id must not be linked to any order')
  const made = await prisma.printOrder.findMany({ where: { paymentMethod: 'quote' }, orderBy: { createdAt: 'desc' }, take: 1 })
  assert.equal(made[0]?.stripePaymentIntentId, null)
})

test('M46 an outside sender\'s metadata can not overwrite the ids the server wrote (paymentIntentId, source, jobFormId)', async () => {
  const { createOrderFromJobForm } = await import('../../lib/orders')
  const prisma = await db()
  const id = nextId('ow')
  const job = await prisma.jobForm.create({
    data: {
      paymentIntentId: id, totalCents: 4000, currency: 'EUR', status: 'pending', paymentMethod: 'card', paymentStatus: 'pending',
      lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 40, lineTotal: 40, material: 'PLA' }], shipping: { method: 'pickup' },
      metadata: { paymentIntentId: 'pi_attacker_choice', source: 'evil', jobFormId: 'someone_elses_job', orderId: 'someone_elses_order' },
    } as any,
  })
  const order = (await createOrderFromJobForm(job, { trusted: false }))!
  const metadata = order.metadata as any
  assert.equal(metadata.paymentIntentId, id)
  assert.equal(metadata.source, 'orderworks')
  assert.equal(metadata.jobFormId, job.id)
  assert.equal(metadata.orderId, undefined, 'the order id is not a key an outside sender may set')
  assert.equal(order.stripePaymentIntentId, null)
})

// ======================================================================================================================================
// F22 - the metadata helper writes metadata and the six receipt / invoice columns, nothing else
// ======================================================================================================================================
test('M48 updateOrderMetadata refuses any column that is not one of the receipt / invoice columns (status, payment, totals, ...)', async () => {
  const { updateOrderMetadata } = await import('../../lib/order-metadata')
  const order = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending' })
  for (const columns of [{ paymentStatus: 'paid' }, { status: 'queued' }, { paidAt: new Date() }, { totalCents: 1 }, { refundedCents: 5 }, { paymentReviewReason: null }, { stripePaymentIntentId: 'pi_x' }]) {
    await assert.rejects(
      () => updateOrderMetadata(order.id, (metadata) => ({ metadata, columns: columns as any, result: undefined })),
      /not allowed|column/i,
      `columns ${JSON.stringify(columns)} must be refused`,
    )
  }
  const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.paymentStatus, 'pending')
  assert.equal(row.status, 'awaiting_payment')
  // the columns it was made for still work
  await updateOrderMetadata(order.id, (metadata) => ({ metadata: { ...metadata, receipt: { ok: true } }, columns: { receiptUrl: '/orders/x/receipt.pdf', receiptStatus: 'received' }, result: undefined }))
  assert.equal((await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })).receiptStatus, 'received')
})

void as
void flow
