// Step 4.6 (S3, D5 and D8) - the admin routes that used to change or erase an order's money without a trace.
//
//   * DELETE /api/admin/orders/<id>, PATCH /api/admin/orders/<id>/items/<id>, DELETE /api/admin/orderworks/jobs/<id>: administrators ONLY (staff is refused),
//     same origin, a written reason, an audit event in the same transaction - and an order that carries PROOF OF A STRIPE PAYMENT (an attempt, a Stripe id, a
//     payment date, a refund, Stripe data, a payment on hold) is neither changed nor deleted by anyone;
//   * POST /api/admin/orders: a line priced under the shop's minimum needs an administrator and a written reason (recorded on the order and in the audit log);
//     every order made by hand leaves an audit event;
//   * PATCH /api/jobs/<id> (D8): the payment of a job can no longer be "declared paid" by a typed identifier. Three states stay DISTINCT -
//       1. a payment VERIFIED with Stripe (paidAt, a payment attempt, metadata.stripe): only the payment verification writes them;
//       2. a payment REGISTERED BY AN ADMINISTRATOR (cash, invoice, ...): metadata.manualPayment { by, at, reason, method }, never a Stripe id / date / data;
//       3. an EXCEPTIONAL AUTHORISATION to produce: metadata.productionAuthorization (not touched here).
//     A CARD payment is confirmed by Stripe or it is not paid.
// Fake Stripe, throw-away database, fake data.
import { db, installFakeStripe, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { loadStripeEvidence, stripeEvidenceReasons } from '../../lib/order-payment-evidence'
import { sanitizeExternalMetadata } from '../../lib/order-payment-policy'

type Actor = NonNullable<Viewer>
let admin: Actor
let staff: Actor
let customer: Actor
let customerId = ''
let seq = 0

const REASON = 'Checked with the customer on the phone'

async function call(handler: any, method: string, url: string, body: unknown, viewer: Viewer | null, opts: { origin?: string | null; params?: Record<string, string> } = {}) {
  viewerGuards.getViewer = async () => viewer
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost'
  const res = (await handler(new NextRequest(url, { method, headers, body: body === undefined || body === null ? undefined : JSON.stringify(body) }), { params: Promise.resolve(opts.params ?? {}) })) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function mkOrder(over: Record<string, unknown> = {}, items = 1) {
  const prisma = await db()
  seq += 1
  return prisma.printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'cash', subtotalCents: 1000 * items, totalCents: 1000 * items, currency: 'EUR',
      metadata: { paymentIntentId: `cash_ar_${seq}` },
      items: { create: Array.from({ length: items }, (_, i) => ({ modelTitle: `Part ${i}`, material: 'PLA', quantity: 2, unitPriceCents: 500, totalCents: 1000 })) },
      ...over,
    } as any,
    include: { items: true },
  })
}
const auditCount = async (action: string) => (await db()).adminAuditEvent.count({ where: { action } })
const lastAudit = async (action: string) => (await db()).adminAuditEvent.findFirst({ where: { action }, orderBy: { createdAt: 'desc' } })

test.before(async () => {
  await resetDb()
  await installFakeStripe()
  const prisma = await db()
  const mk = (name: string, role: 'admin' | 'staff' | 'customer') => prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role } })
  admin = { id: (await mk('ar-admin', 'admin')).id, role: 'admin' } as Actor
  staff = { id: (await mk('ar-staff', 'staff')).id, role: 'staff' } as Actor
  customerId = (await mk('ar-customer', 'customer')).id
  customer = { id: customerId, role: 'customer' } as Actor
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
})

// ---- the pure rule: what counts as proof of a Stripe payment ---------------------------------------------------------------------------------------
test('proof of a Stripe payment: each of the signs counts, a payment registered by hand does not', () => {
  assert.deepEqual(stripeEvidenceReasons({}, 0), [])
  assert.deepEqual(stripeEvidenceReasons({ metadata: { manualPayment: { by: 'a', at: 'x', reason: 'cash in hand', method: 'cash' }, productionAuthorization: { authorized: true, by: 'a' } } }, 0), [])
  assert.deepEqual(stripeEvidenceReasons({}, 1), ['stripe_attempts'])
  assert.deepEqual(stripeEvidenceReasons({ stripePaymentIntentId: 'pi_1' }, 0), ['stripe_payment_intent'])
  assert.deepEqual(stripeEvidenceReasons({ stripeChargeId: 'ch_1' }, 0), ['stripe_charge'])
  assert.deepEqual(stripeEvidenceReasons({ paidAt: new Date() }, 0), ['paid_at'])
  assert.deepEqual(stripeEvidenceReasons({ refundedCents: 100 }, 0), ['refund'])
  assert.deepEqual(stripeEvidenceReasons({ paymentReviewReason: 'amount_mismatch' }, 0), ['payment_review'])
  assert.deepEqual(stripeEvidenceReasons({ metadata: { stripe: { paymentIntentId: 'pi_1' } } }, 0), ['stripe_metadata'])
  assert.deepEqual(stripeEvidenceReasons({ metadata: { stripe: {} } }, 0), [], 'an empty object is not Stripe data')
  assert.deepEqual(stripeEvidenceReasons({ stripeInvoiceId: 'in_1' }, 0), ['invoice'])
})

test('an outside service can not write the markers of a payment registered by hand or of a price set by hand', () => {
  const cleaned = sanitizeExternalMetadata({ note: 'kept', manualPayment: { by: 'x' }, adminPricing: { by: 'x' }, productionAuthorization: { authorized: true } })
  assert.deepEqual(cleaned, { note: 'kept' })
})

// ---- DELETE /api/admin/orders/<id> -----------------------------------------------------------------------------------------------------------------
const deleteOrder = async (id: string, viewer: Viewer | null, body: unknown = { reason: REASON }, opts: { origin?: string | null } = {}) => {
  const { DELETE } = await import('../../app/api/admin/orders/[orderId]/route')
  return call(DELETE, 'DELETE', `http://localhost/api/admin/orders/${id}`, body, viewer, { params: { orderId: id }, ...opts })
}

test('DELETE order: anonymous 401, customer 403, STAFF 403, another origin 403 - and the order stays', async () => {
  const order = await mkOrder()
  assert.equal((await deleteOrder(order.id, null)).status, 401)
  assert.equal((await deleteOrder(order.id, customer)).status, 403)
  assert.equal((await deleteOrder(order.id, staff)).status, 403)
  assert.equal((await deleteOrder(order.id, admin, { reason: REASON }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await deleteOrder(order.id, admin, { reason: REASON }, { origin: null })).status, 403)
  assert.ok(await (await db()).printOrder.findUnique({ where: { id: order.id } }))
})

test('DELETE order: a written reason is required, and nothing happens without it', async () => {
  const order = await mkOrder()
  for (const body of [null, {}, { reason: '' }, { reason: 'too short' }, { reason: 42 }, { reason: 'x'.repeat(301) }]) {
    const res = await deleteOrder(order.id, admin, body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.ok(await (await db()).printOrder.findUnique({ where: { id: order.id } }))
})

test('DELETE order: an administrator deletes an order with no Stripe proof, with a reason, and the audit event says who, why and what', async () => {
  const before = await auditCount('admin.order.delete')
  const order = await mkOrder({ metadata: { paymentIntentId: 'cash_del_1', manualPayment: { by: admin.id, at: new Date().toISOString(), reason: 'cash in hand', method: 'cash' } }, paymentStatus: 'paid' })
  const prisma = await db()
  await prisma.jobForm.create({ data: { paymentIntentId: 'cash_del_1', totalCents: 1000, currency: 'EUR', lineItems: [], status: 'pending' } })
  const res = await deleteOrder(order.id, admin)
  assert.equal(res.status, 200, res.text)
  assert.equal(await prisma.printOrder.findUnique({ where: { id: order.id } }), null)
  assert.equal(await prisma.jobForm.count({ where: { paymentIntentId: 'cash_del_1' } }), 0, 'the job form made for it goes too')
  assert.equal(await auditCount('admin.order.delete'), before + 1)
  const event = await lastAudit('admin.order.delete')
  assert.equal(event?.adminId, admin.id)
  assert.equal(event?.targetId, order.id)
  assert.equal((event?.metadata as any).reason, REASON)
  assert.equal((event?.metadata as any).orderNumber, order.orderNumber)
  assert.equal((event?.metadata as any).totalCents, 1000)
})

test('DELETE order: an order with ANY proof of a Stripe payment can not be deleted by anyone - the row, its lines and the audit log stay as they were', async () => {
  const prisma = await db()
  const variants: Array<[string, (id: string) => Promise<unknown>, Record<string, unknown>]> = [
    ['a payment attempt', (id) => prisma.paymentAttempt.create({ data: { orderId: id, amountCents: 1000, currency: 'EUR', status: 'expired', expiresAt: new Date() } }), {}],
    ['a Stripe payment id', async () => undefined, { stripePaymentIntentId: `pi_del_${Math.random().toString(36).slice(2)}` }],
    ['a Stripe charge id', async () => undefined, { stripeChargeId: 'ch_del' }],
    ['a recorded payment date', async () => undefined, { paidAt: new Date(), paymentStatus: 'paid' }],
    ['a refund', async () => undefined, { refundedCents: 100 }],
    ['a payment on hold', async () => undefined, { paymentReviewReason: 'amount_mismatch' }],
    ['Stripe data in the metadata', async () => undefined, { metadata: { paymentIntentId: 'x', stripe: { paymentIntentId: 'pi_meta' } } }],
    ['an invoice', async () => undefined, { stripeInvoiceId: `in_del_${Math.random().toString(36).slice(2)}` }],
  ]
  for (const [label, prepare, over] of variants) {
    const order = await mkOrder(over)
    await prepare(order.id)
    const eventsBefore = await auditCount('admin.order.delete')
    const res = await deleteOrder(order.id, admin)
    assert.equal(res.status, 409, `${label}: ${res.text}`)
    assert.equal(res.json.code, 'ORDER_HAS_PAYMENT_EVIDENCE', label)
    assert.ok(Array.isArray(res.json.details?.reasons) && res.json.details.reasons.length > 0, label)
    assert.ok(await prisma.printOrder.findUnique({ where: { id: order.id } }), `${label}: the order stays`)
    assert.equal(await prisma.printOrderItem.count({ where: { orderId: order.id } }), 1, `${label}: and its lines`)
    assert.equal(await auditCount('admin.order.delete'), eventsBefore, `${label}: nothing was recorded as deleted`)
    assert.ok(await loadStripeEvidence(prisma, order.id), label)
  }
})

// ---- PATCH /api/admin/orders/<id>/items/<id> ----------------------------------------------------------------------------------------------------
const patchItem = async (orderId: string, itemId: string, viewer: Viewer | null, body: unknown, opts: { origin?: string | null } = {}) => {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/items/[itemId]/route')
  return call(PATCH, 'PATCH', `http://localhost/api/admin/orders/${orderId}/items/${itemId}`, body, viewer, { params: { orderId, itemId }, ...opts })
}

test('PATCH item quantity: staff 403, another origin 403, a reason is required - the order is not touched', async () => {
  const order = await mkOrder()
  const item = order.items[0]
  assert.equal((await patchItem(order.id, item.id, null, { quantity: 5, reason: REASON })).status, 401)
  assert.equal((await patchItem(order.id, item.id, staff, { quantity: 5, reason: REASON })).status, 403)
  assert.equal((await patchItem(order.id, item.id, admin, { quantity: 5, reason: REASON }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await patchItem(order.id, item.id, admin, { quantity: 5 })).status, 400)
  assert.equal((await patchItem(order.id, item.id, admin, { quantity: 5, reason: 'short' })).status, 400)
  const after = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
  assert.equal(after.totalCents, 1000)
  assert.equal(after.items[0].quantity, 2)
})

test('PATCH item quantity: an administrator changes it with a reason; the total follows and the audit event keeps before and after', async () => {
  const order = await mkOrder()
  const item = order.items[0]
  const res = await patchItem(order.id, item.id, admin, { quantity: 3, reason: REASON })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.order.totalCents, 1500)
  const event = await lastAudit('admin.order.item_quantity')
  assert.equal(event?.targetId, order.id)
  assert.deepEqual((event?.metadata as any).quantity, { from: 2, to: 3 })
  assert.deepEqual((event?.metadata as any).totalCents, { from: 1000, to: 1500 })
  assert.equal((event?.metadata as any).reason, REASON)
})

test('PATCH item quantity: an order with proof of a Stripe payment can not be changed - quantity, totals and audit log are as they were', async () => {
  const prisma = await db()
  const order = await mkOrder({ paidAt: new Date(), paymentStatus: 'paid' })
  const item = order.items[0]
  const eventsBefore = await prisma.adminAuditEvent.count()
  const res = await patchItem(order.id, item.id, admin, { quantity: 9, reason: REASON })
  assert.equal(res.status, 409, res.text)
  assert.equal(res.json.code, 'ORDER_HAS_PAYMENT_EVIDENCE')
  const after = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
  assert.equal(after.totalCents, 1000)
  assert.equal(after.items[0].quantity, 2)
  assert.equal(await prisma.adminAuditEvent.count(), eventsBefore)
  assert.equal((await patchItem('does-not-exist', 'nope', admin, { quantity: 2, reason: REASON })).status, 404)
})

// ---- POST /api/admin/orders --------------------------------------------------------------------------------------------------------------------------
const createOrder = async (viewer: Viewer | null, body: Record<string, unknown>) => {
  const { POST } = await import('../../app/api/admin/orders/route')
  return call(POST, 'POST', 'http://localhost/api/admin/orders', { userId: customerId, currency: 'EUR', ...body }, viewer)
}
const line = (unitPriceCents: number, over: Record<string, unknown> = {}) => ({ modelTitle: 'By hand', material: 'PLA', quantity: 1, unitPriceCents, ...over })

test('POST order: a line at or over the shop minimum needs no reason, even for staff - and the order leaves an audit event', async () => {
  const before = await auditCount('admin.order.create')
  const res = await createOrder(staff, { paymentMethod: 'cash', status: 'awaiting_payment', items: [line(500), line(1200)] })
  assert.equal(res.status, 200, res.text)
  assert.equal(await auditCount('admin.order.create'), before + 1)
  const event = await lastAudit('admin.order.create')
  assert.equal(event?.adminId, staff.id)
  assert.equal(event?.targetId, res.json.order.id)
  assert.equal((event?.metadata as any).adminPricing, undefined)
  const order = await (await db()).printOrder.findUniqueOrThrow({ where: { id: res.json.order.id } })
  assert.equal((order.metadata as any).adminPricing, undefined)
})

test('POST order: a line UNDER the shop minimum is refused for staff, and for an administrator without a written reason', async () => {
  const prisma = await db()
  const count = await prisma.printOrder.count()
  const asStaff = await createOrder(staff, { paymentMethod: 'cash', status: 'awaiting_payment', items: [line(499)], belowMinimumReason: REASON })
  assert.equal(asStaff.status, 403, asStaff.text)
  assert.equal(asStaff.json.code, 'BELOW_MINIMUM_ADMIN_ONLY')
  for (const belowMinimumReason of [undefined, '', 'short']) {
    const res = await createOrder(admin, { paymentMethod: 'cash', status: 'awaiting_payment', items: [line(1200), line(499)], belowMinimumReason })
    assert.equal(res.status, 400, res.text)
    assert.equal(res.json.code, 'BELOW_MINIMUM_REASON_REQUIRED')
    assert.equal(res.json.details.minimumCents, 500)
    assert.deepEqual(res.json.details.lines, [{ index: 1, unitPriceCents: 499 }])
  }
  assert.equal(await prisma.printOrder.count(), count, 'no order was made')
})

test('POST order: an administrator prices a line under the minimum WITH a reason: it is kept on the order and in the audit log', async () => {
  const res = await createOrder(admin, { paymentMethod: 'cash', status: 'awaiting_payment', items: [line(1200), line(100)], belowMinimumReason: REASON })
  assert.equal(res.status, 200, res.text)
  const order = await (await db()).printOrder.findUniqueOrThrow({ where: { id: res.json.order.id } })
  const pricing = (order.metadata as any).adminPricing
  assert.equal(pricing.by, admin.id)
  assert.equal(pricing.reason, REASON)
  assert.equal(pricing.commonMinimumCents, 500)
  assert.deepEqual(pricing.lines, [{ index: 1, unitPriceCents: 100 }])
  const event = await lastAudit('admin.order.create')
  assert.deepEqual((event?.metadata as any).adminPricing.lines, [{ index: 1, unitPriceCents: 100 }])
  // and it is a price exception, not a payment or a production decision
  assert.equal(order.paymentStatus, 'pending')
  assert.equal((order.metadata as any).productionAuthorization, undefined)
})

test('POST order: the no-charge order (total 0) keeps its own rule - administrators only, with a written reason (step 4.6, S6) - and is audited too', async () => {
  assert.equal((await createOrder(staff, { items: [line(0)] })).status, 403)
  const before = await auditCount('admin.order.create')
  const noReason = await createOrder(admin, { items: [line(0)] })
  assert.equal(noReason.status, 400, noReason.text)
  assert.equal(noReason.json.code, 'REASON_REQUIRED')
  assert.equal(await auditCount('admin.order.create'), before, 'refused: nothing is made, nothing is audited')
  const res = await createOrder(admin, { items: [line(0)], authorizationReason: 'gift for the school fair, agreed with the owner' })
  assert.equal(res.status, 200, res.text)
  assert.equal(await auditCount('admin.order.create'), before + 1)
})

// ---- PATCH /api/jobs/<paymentIntentId> (D8) -----------------------------------------------------------------------------------------------------------
async function mkJob(paymentIntentId: string, over: Record<string, unknown> = {}) {
  const prisma = await db()
  return prisma.jobForm.create({
    data: {
      paymentIntentId, totalCents: 9000, currency: 'EUR', status: 'pending', paymentMethod: 'card', paymentStatus: 'pending',
      lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 90, lineTotal: 90, material: 'PLA' }], shipping: { method: 'pickup' }, ...over,
    } as any,
  })
}
const patchJob = async (paymentIntentId: string, viewer: Viewer | null, body: unknown, opts: { origin?: string | null } = {}) => {
  const { PATCH } = await import('../../app/api/jobs/[paymentIntentId]/route')
  return call(PATCH, 'PATCH', `http://localhost/api/jobs/${paymentIntentId}`, body, viewer, { params: { paymentIntentId }, ...opts })
}
const ordersOf = async (paymentIntentId: string) => (await db()).printOrder.findMany({ where: { metadata: { path: ['paymentIntentId'], equals: paymentIntentId } } })

test('job PATCH: fulfilment and job status stay open to staff, and need no reason - only the PAYMENT fields are accountable', async () => {
  await mkJob('cash_job_open')
  const before = await auditCount('admin.job.payment')
  const res = await patchJob('cash_job_open', staff, { status: 'sent', fulfillmentStatus: 'ready' })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.job.fulfillmentStatus, 'ready')
  assert.equal(await auditCount('admin.job.payment'), before)
  assert.equal((await ordersOf('cash_job_open')).length, 0, 'and no order is made by a fulfilment change')
})

test('job PATCH: a change of the payment is for administrators only, same origin, with a written reason - otherwise the job is untouched', async () => {
  await mkJob('cash_job_gate', { paymentMethod: 'cash' })
  const prisma = await db()
  const body = { paymentStatus: 'paid', reason: REASON }
  assert.equal((await patchJob('cash_job_gate', null, body)).status, 401)
  const asStaff = await patchJob('cash_job_gate', staff, body)
  assert.equal(asStaff.status, 403, asStaff.text)
  assert.equal(asStaff.json.code, 'ADMIN_ONLY')
  assert.equal((await patchJob('cash_job_gate', customer, body)).status, 403)
  assert.equal((await patchJob('cash_job_gate', admin, body, { origin: 'https://evil.example' })).status, 403)
  for (const reason of [undefined, '', 'short']) assert.equal((await patchJob('cash_job_gate', admin, { paymentStatus: 'paid', reason })).status, 400)
  const job = await prisma.jobForm.findUniqueOrThrow({ where: { paymentIntentId: 'cash_job_gate' } })
  assert.equal(job.paymentStatus, 'pending')
  assert.equal((await ordersOf('cash_job_gate')).length, 0)
})

test('job PATCH, D8: a CARD job with an identifier typed by hand can not be declared paid - by an administrator either - and no order is made', async () => {
  await mkJob('typed_by_hand_123')
  const prisma = await db()
  const eventsBefore = await prisma.adminAuditEvent.count()
  const res = await patchJob('typed_by_hand_123', admin, { paymentStatus: 'paid', reason: REASON })
  assert.equal(res.status, 409, res.text)
  assert.equal(res.json.code, 'CARD_PAYMENT_NOT_VERIFIABLE')
  assert.equal((await ordersOf('typed_by_hand_123')).length, 0)
  assert.equal((await prisma.jobForm.findUniqueOrThrow({ where: { paymentIntentId: 'typed_by_hand_123' } })).paymentStatus, 'pending')
  assert.equal(await prisma.adminAuditEvent.count(), eventsBefore, 'a refused declaration leaves no half-written trace')
  // a job with no payment method at all is a card job too
  await mkJob('typed_no_method', { paymentMethod: null })
  assert.equal((await patchJob('typed_no_method', admin, { paymentStatus: 'paid', reason: REASON })).status, 409)
  assert.equal((await ordersOf('typed_no_method')).length, 0)
})

test('job PATCH, D8: a CARD job with a Stripe identifier is declared paid -> the order starts UNPAID: only Stripe\'s own confirmation can make it paid', async () => {
  await mkJob('pi_declared_not_paid')
  const prisma = await db()
  const res = await patchJob('pi_declared_not_paid', admin, { paymentStatus: 'paid', reason: REASON })
  assert.equal(res.status, 200, res.text)
  const [order] = await ordersOf('pi_declared_not_paid')
  assert.ok(order, 'the order exists')
  assert.equal(order.paymentStatus, 'pending', 'the declaration is not the payment')
  assert.notEqual(order.status, 'queued')
  assert.equal(order.paidAt, null)
  assert.equal((order.metadata as any).manualPayment, undefined, 'and it is not a payment registered by hand either')
  assert.equal((order.metadata as any).productionAuthorization, undefined)
  // the job shows what the order says, never what was typed
  assert.equal(res.json.job.paymentStatus, 'pending')
  assert.equal((await prisma.jobForm.findUniqueOrThrow({ where: { paymentIntentId: 'pi_declared_not_paid' } })).paymentStatus, 'pending')
  const event = await lastAudit('admin.job.payment')
  assert.equal((event?.metadata as any).decision, 'stripe')
  assert.equal((event?.metadata as any).reason, REASON)
})

test('job PATCH, D8: a payment taken outside Stripe is REGISTERED by the administrator - accountable, and never dressed up as a Stripe payment', async () => {
  await mkJob('cash_job_manual', { paymentMethod: 'cash' })
  const prisma = await db()
  const before = await auditCount('admin.job.payment')
  const res = await patchJob('cash_job_manual', admin, { paymentStatus: 'paid', reason: REASON })
  assert.equal(res.status, 200, res.text)
  const [order] = await ordersOf('cash_job_manual')
  assert.equal(order.paymentStatus, 'paid', 'the manual flow is unchanged: the order can go to production')
  assert.equal(order.status, 'queued')
  const manual = (order.metadata as any).manualPayment
  assert.equal(manual.by, admin.id)
  assert.equal(manual.reason, REASON)
  assert.equal(manual.method, 'cash')
  assert.ok(Date.parse(manual.at) > 0)
  // none of the signs of a VERIFIED Stripe payment
  assert.equal(order.paidAt, null)
  assert.equal(order.stripePaymentIntentId, null)
  assert.equal(order.stripeChargeId, null)
  assert.equal((order.metadata as any).stripe, undefined)
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: order.id } }), 0)
  assert.deepEqual((await loadStripeEvidence(prisma, order.id))?.reasons, [])
  assert.equal(await auditCount('admin.job.payment'), before + 1)
  assert.equal((await lastAudit('admin.job.payment'))?.adminId, admin.id)
  assert.equal(((await lastAudit('admin.job.payment'))?.metadata as any).decision, 'manual')
})

test('job PATCH, D8: a payment registered by hand can not carry a Stripe identifier, and can only be "paid" (or no-charge)', async () => {
  await mkJob('pi_manual_with_stripe_id', { paymentMethod: 'cash' })
  const withStripeId = await patchJob('pi_manual_with_stripe_id', admin, { paymentStatus: 'paid', reason: REASON })
  assert.equal(withStripeId.status, 409, withStripeId.text)
  assert.equal(withStripeId.json.code, 'MANUAL_PAYMENT_WITH_STRIPE_ID')
  assert.equal((await ordersOf('pi_manual_with_stripe_id')).length, 0)
  await mkJob('cash_job_processing', { paymentMethod: 'cash' })
  const processing = await patchJob('cash_job_processing', admin, { paymentStatus: 'processing', reason: REASON })
  assert.equal(processing.status, 409, processing.text)
  assert.equal(processing.json.code, 'PAYMENT_STATUS_NOT_MANUAL')
  assert.equal((await ordersOf('cash_job_processing')).length, 0)
})

test('job PATCH, D8: markers planted in the job form by an outside service do not become a payment registered by hand', async () => {
  await mkJob('pi_forged_manual', { metadata: { manualPayment: { by: 'attacker', at: 'x', reason: 'forged', method: 'cash' }, productionAuthorization: { authorized: true, by: 'attacker' } } })
  const res = await patchJob('pi_forged_manual', admin, { paymentStatus: 'paid', reason: REASON })
  assert.equal(res.status, 200, res.text)
  const [order] = await ordersOf('pi_forged_manual')
  assert.equal((order.metadata as any).manualPayment, undefined)
  assert.equal((order.metadata as any).productionAuthorization, undefined)
  assert.equal(order.paymentStatus, 'pending')
})

test('job PATCH, D8: a job whose order already has proof of a Stripe payment can not have its payment fields changed from here', async () => {
  await mkJob('cash_job_evidence', { paymentMethod: 'cash' })
  const order = await mkOrder({ metadata: { paymentIntentId: 'cash_job_evidence' }, paidAt: new Date(), paymentStatus: 'paid' })
  const prisma = await db()
  const eventsBefore = await prisma.adminAuditEvent.count()
  const res = await patchJob('cash_job_evidence', admin, { paymentStatus: 'refunded', reason: REASON })
  assert.equal(res.status, 409, res.text)
  assert.equal(res.json.code, 'ORDER_HAS_PAYMENT_EVIDENCE')
  assert.equal((await prisma.jobForm.findUniqueOrThrow({ where: { paymentIntentId: 'cash_job_evidence' } })).paymentStatus, 'pending')
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus, 'paid')
  assert.equal(await prisma.adminAuditEvent.count(), eventsBefore)
})

// ---- DELETE /api/admin/orderworks/jobs/<id> (D8) --------------------------------------------------------------------------------------------------
const deleteJob = async (id: string, viewer: Viewer | null, body: unknown = { reason: REASON }, opts: { origin?: string | null } = {}) => {
  const { DELETE } = await import('../../app/api/admin/orderworks/jobs/[id]/route')
  return call(DELETE, 'DELETE', `http://localhost/api/admin/orderworks/jobs/${id}`, body, viewer, { params: { id }, ...opts })
}

test('DELETE job: staff 403, another origin 403, a reason is required - the job and its order stay', async () => {
  const job = await mkJob('cash_job_del_gate', { paymentMethod: 'cash' })
  const order = await mkOrder({ metadata: { paymentIntentId: 'cash_job_del_gate', jobFormId: job.id } })
  assert.equal((await deleteJob(job.id, null)).status, 401)
  assert.equal((await deleteJob(job.id, staff)).status, 403)
  assert.equal((await deleteJob(job.id, customer)).status, 403)
  assert.equal((await deleteJob(job.id, admin, { reason: REASON }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await deleteJob(job.id, admin, {})).status, 400)
  assert.equal((await deleteJob(job.id, admin, { reason: 'short' })).status, 400)
  const prisma = await db()
  assert.ok(await prisma.jobForm.findUnique({ where: { id: job.id } }))
  assert.ok(await prisma.printOrder.findUnique({ where: { id: order.id } }))
})

test('DELETE job: an administrator removes a job and the order made from it when there is no Stripe proof; the audit event lists what went', async () => {
  const job = await mkJob('cash_job_del_ok', { paymentMethod: 'cash' })
  const order = await mkOrder({ metadata: { paymentIntentId: 'cash_job_del_ok', jobFormId: job.id } })
  const res = await deleteJob(job.id, admin)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.deletedOrderCount, 1)
  const prisma = await db()
  assert.equal(await prisma.jobForm.findUnique({ where: { id: job.id } }), null)
  assert.equal(await prisma.printOrder.findUnique({ where: { id: order.id } }), null)
  const event = await lastAudit('admin.orderworks_job.delete')
  assert.equal(event?.targetId, job.id)
  assert.equal((event?.metadata as any).reason, REASON)
  assert.deepEqual((event?.metadata as any).deletedOrders.map((entry: any) => entry.id), [order.id])
})

test('DELETE job: if ANY order made from it has proof of a Stripe payment, NOTHING is deleted - not the job, not the other orders', async () => {
  const job = await mkJob('cash_job_del_evidence', { paymentMethod: 'cash' })
  const plain = await mkOrder({ metadata: { paymentIntentId: 'cash_job_del_evidence', jobFormId: job.id } })
  const paid = await mkOrder({ metadata: { jobFormId: job.id }, stripeChargeId: 'ch_job_del', paymentStatus: 'paid' })
  const prisma = await db()
  const eventsBefore = await auditCount('admin.orderworks_job.delete')
  const res = await deleteJob(job.id, admin)
  assert.equal(res.status, 409, res.text)
  assert.equal(res.json.code, 'ORDER_HAS_PAYMENT_EVIDENCE')
  assert.ok(await prisma.jobForm.findUnique({ where: { id: job.id } }), 'the job stays')
  assert.ok(await prisma.printOrder.findUnique({ where: { id: plain.id } }), 'and the order with no proof is not deleted behind the refusal')
  assert.ok(await prisma.printOrder.findUnique({ where: { id: paid.id } }))
  assert.equal(await auditCount('admin.orderworks_job.delete'), eventsBefore)
  assert.equal((await deleteJob('does-not-exist', admin)).status, 404)
})

// ---- the library itself (defence in depth): a job form that SAYS "paid" is not a payment unless an administrator registered it --------------------------
test('createOrderFromJobForm: whatever the job form says, only a payment REGISTERED by an administrator makes an order paid - the default, and the Stripe mode, start unpaid', async () => {
  const { createOrderFromJobForm } = await import('../../lib/orders')
  const prisma = await db()
  const jobSays = async (id: string) => prisma.jobForm.create({
    data: {
      paymentIntentId: id, totalCents: 9000, currency: 'EUR', status: 'pending', paymentMethod: 'card', paymentStatus: 'paid',
      lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 90, lineTotal: 90, material: 'PLA' }], shipping: { method: 'pickup' },
    } as any,
  })
  const byDefault = (await createOrderFromJobForm(await jobSays('pi_lib_default')))!
  assert.equal(byDefault.paymentStatus, 'pending', 'no mode given: the job\'s own word is not enough')
  const byStripe = (await createOrderFromJobForm(await jobSays('pi_lib_stripe'), { payment: { kind: 'stripe' } }))!
  assert.equal(byStripe.paymentStatus, 'pending')
  assert.notEqual(byStripe.status, 'queued')
  const outside = (await createOrderFromJobForm(await jobSays('pi_lib_outside'), { trusted: false }))!
  assert.equal(outside.paymentStatus, 'pending')
  assert.equal(outside.paymentReviewReason, 'external_order')
  const manualJob = await prisma.jobForm.create({
    data: { paymentIntentId: 'cash_lib_manual', totalCents: 9000, currency: 'EUR', status: 'pending', paymentMethod: 'cash', paymentStatus: 'paid', lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 90, lineTotal: 90, material: 'PLA' }], shipping: { method: 'pickup' } } as any,
  })
  const manual = (await createOrderFromJobForm(manualJob, { payment: { kind: 'manual', by: admin.id, at: new Date().toISOString(), reason: REASON, method: 'cash', receivedVia: 'cash' } }))!
  assert.equal(manual.paymentStatus, 'paid')
  assert.equal((manual.metadata as any).manualPayment.by, admin.id)
  // a payment registered by hand can not carry a Stripe identifier, even when called straight from code
  const stripeIdJob = await prisma.jobForm.create({
    data: { paymentIntentId: 'pi_lib_manual_bad', totalCents: 9000, currency: 'EUR', status: 'pending', paymentMethod: 'cash', paymentStatus: 'paid', lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 90, lineTotal: 90, material: 'PLA' }], shipping: { method: 'pickup' } } as any,
  })
  await assert.rejects(() => createOrderFromJobForm(stripeIdJob, { payment: { kind: 'manual', by: admin.id, at: new Date().toISOString(), reason: REASON, method: 'cash', receivedVia: 'cash' } }))
})
