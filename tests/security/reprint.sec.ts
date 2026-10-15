// Step 4.0a – reprints must not bypass S5 ("no production without verified payment or explicit administrator authorization").
// Before: a customer could copy ANY of their orders; the copy inherited every metadata key (including an administrator's
// `productionAuthorization`), the old total, and was created as `queued`. Now a customer's reprint is a REQUEST FOR A NEW QUOTE:
// `awaiting_review`, payment `quote`, no price, nothing inherited; a free reprint is a recorded administrator decision with a reason.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { isProductionEligible } from '../../lib/order-payment-policy'
import { canRequestReprint, findOpenReprint, isReprintAwaitingQuote } from '../../lib/reprint'

let customerId = ''
let otherId = ''
let staffId = ''
let adminId = ''

function as(viewer: Viewer) {
  viewerGuards.getViewer = async () => viewer
}
const asCustomer = () => as({ id: customerId, role: 'customer' })

async function mkSource(over: Record<string, unknown> = {}, userId = customerId) {
  const prisma = await db()
  return prisma.printOrder.create({
    data: {
      userId,
      status: 'completed',
      paymentStatus: 'paid',
      paymentMethod: 'card',
      paidAt: new Date(),
      subtotalCents: 12000,
      totalCents: 12000,
      shippingCents: 700,
      taxCents: 2160,
      currency: 'EUR',
      stripePaymentIntentId: `pi_src_${Math.random().toString(36).slice(2)}`,
      customerEmail: 'cliente@example.test',
      metadata: {
        paymentIntentId: 'pi_original',
        postPayment: { receipt: { status: 'done' } },
        checkout: { lines: [{ modelId: 'm1' }] },
        artifacts: { manufacturabilityReport: { filePath: '/orders/x/report.pdf' } },
        productionAuthorization: { authorized: true, by: 'some-admin', at: '2026-01-01T00:00:00.000Z', reason: 'cash received' },
      },
      items: {
        create: [{
          modelTitle: 'Bracket', material: 'PLA', colors: ['#ff0000'], infillPct: 25, finish: 'standard', customNotes: 'note', quantity: 3,
          unitPriceCents: 4000, totalCents: 12000, configuration: { scale: 1.2, colors: ['#ff0000'], priceMultiplier: 0.1, finish: 'standard' },
        }],
      },
      ...over,
    },
    include: { items: true },
  })
}

async function requestReprint(orderId: string, headers: Record<string, string> = {}) {
  const { POST } = await import('../../app/api/customer/orders/[orderId]/reprint/route')
  const res = await (POST as any)(new NextRequest(`http://localhost/api/customer/orders/${orderId}/reprint`, { method: 'POST', headers: { Origin: 'http://localhost', ...headers } }), { params: Promise.resolve({ orderId }) }) as Response
  return { res, json: await res.clone().json().catch(() => ({})) }
}

async function patchStatus(orderId: string, body: Record<string, unknown>, who: Viewer = { id: adminId, role: 'admin' }) {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/status/route')
  as(who)
  const res = await (PATCH as any)(new NextRequest(`http://localhost/api/admin/orders/${orderId}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ orderId }) }) as Response
  return { res, json: await res.clone().json().catch(() => ({})) }
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  const mk = (n: string, role: string) => prisma.user.create({ data: { email: `${n}@sectest.invalid`, passwordHash: 'x', name: n, role: role as any } })
  customerId = (await mk('rp-customer', 'customer')).id
  otherId = (await mk('rp-other', 'customer')).id
  staffId = (await mk('rp-staff', 'staff')).id
  adminId = (await mk('rp-admin', 'admin')).id
})

test.beforeEach(async () => {
  const prisma = await db()
  await prisma.rateLimit.deleteMany()
  await prisma.printOrder.deleteMany()
  asCustomer()
})

test('a reprint request is a quote request: awaiting_review, payment "quote", no price, never eligible for production', async () => {
  const prisma = await db()
  const source = await mkSource()
  const { res, json } = await requestReprint(source.id)
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.created, true)
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.order.id }, include: { items: true } })
  assert.equal(order.status, 'awaiting_review')
  assert.equal(order.paymentMethod, 'quote')
  assert.equal(order.paymentStatus, 'quote')
  assert.equal(order.totalCents, 0)
  assert.equal(order.subtotalCents, 0)
  assert.equal(order.shippingCents, 0)
  assert.equal(order.taxCents, 0)
  assert.equal(order.paidAt, null)
  assert.equal(order.stripePaymentIntentId, null)
  assert.equal(order.reprintOfId, source.id)
  assert.equal(order.userId, customerId)
  assert.equal(order.currency, 'EUR')
  assert.equal(isProductionEligible(order), false, 'a reprint request must not be eligible for production')
  assert.equal(isReprintAwaitingQuote(order), true, 'a total of 0 must read as "not priced yet", never as free')
  // what describes the part is kept, the price is not
  assert.equal(order.items.length, 1)
  const item = order.items[0]
  assert.equal(item.modelTitle, 'Bracket')
  assert.equal(item.quantity, 3)
  assert.equal(item.material, 'PLA')
  assert.deepEqual(item.colors, ['#ff0000'])
  assert.equal(item.unitPriceCents, 0)
  assert.equal(item.totalCents, 0)
  const configuration = item.configuration as Record<string, unknown>
  assert.equal(configuration.scale, 1.2)
  assert.equal('priceMultiplier' in configuration, false, 'nothing that influences a price is inherited')
})

test('nothing is inherited from the original: no administrator authorization, no payment data, no artifacts', async () => {
  const prisma = await db()
  // the dangerous case: the original was produced WITHOUT payment, on an administrator's authorization
  const source = await mkSource({ paymentStatus: 'pending', paidAt: null })
  assert.equal(isProductionEligible(source), true, 'the original is eligible only because of the administrator authorization')
  const { json } = await requestReprint(source.id)
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: json.order.id } })
  const metadata = order.metadata as Record<string, unknown>
  for (const key of ['productionAuthorization', 'paymentIntentId', 'postPayment', 'checkout', 'artifacts', 'stripe', 'paymentReview']) {
    assert.equal(key in metadata, false, `metadata.${key} must not be copied`)
  }
  assert.equal(isProductionEligible(order), false)
  assert.equal((metadata.reprint as Record<string, unknown>).sourceOrderId, source.id)
  assert.equal((metadata.reprint as Record<string, unknown>).kind, 'customer_request')
})

test('only an order that was produced can be reprinted, and only the owner can ask', async () => {
  const prisma = await db()
  for (const status of ['awaiting_payment', 'awaiting_review', 'queued', 'printing', 'cancelled']) {
    const source = await mkSource({ status })
    const { res, json } = await requestReprint(source.id)
    assert.equal(res.status, 409, `${status} -> HTTP ${res.status}`)
    assert.equal(json.code, 'REPRINT_NOT_ALLOWED')
  }
  // finished but never paid nor authorized
  const unpaid = await mkSource({ status: 'completed', paymentStatus: 'pending', paidAt: null, metadata: {} })
  assert.equal((await requestReprint(unpaid.id)).res.status, 409)
  // somebody else's order: same answer as a missing order
  const foreign = await mkSource({}, otherId)
  assert.equal((await requestReprint(foreign.id)).res.status, 404)
  assert.equal((await requestReprint('does-not-exist')).res.status, 404)
  // not signed in
  as(null)
  const mine = await mkSource()
  assert.equal((await requestReprint(mine.id)).res.status, 401)
  assert.equal(await prisma.printOrder.count({ where: { reprintOfId: { not: null } } }), 0, 'refused requests create nothing')
})

test('one open request per original, even when several arrive at the same moment; a finished one can be requested again', async () => {
  const prisma = await db()
  const source = await mkSource()
  const results = await Promise.all(Array.from({ length: 6 }, () => requestReprint(source.id)))
  assert.ok(results.every((r) => r.res.status === 200), results.map((r) => r.res.status).join(','))
  assert.equal(results.filter((r) => r.json.created === true).length, 1)
  assert.equal(new Set(results.map((r) => r.json.order.id)).size, 1)
  assert.equal(await prisma.printOrder.count({ where: { reprintOfId: source.id } }), 1)
  // closing the request allows a new one
  await prisma.printOrder.updateMany({ where: { reprintOfId: source.id }, data: { status: 'cancelled' } })
  const again = await requestReprint(source.id)
  assert.equal(again.json.created, true)
  assert.equal(await prisma.printOrder.count({ where: { reprintOfId: source.id } }), 2)
})

test('the route refuses other sites and limits how often a customer can ask', async () => {
  const prisma = await db()
  const source = await mkSource()
  const foreign = await requestReprint(source.id, { Origin: 'https://evil.example' })
  assert.equal(foreign.res.status, 403)
  assert.equal(await prisma.printOrder.count({ where: { reprintOfId: source.id } }), 0)
  const statuses: number[] = []
  for (let i = 0; i < 12; i += 1) statuses.push((await requestReprint(source.id)).res.status)
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200))
  assert.deepEqual(statuses.slice(10), [429, 429])
})

test('a free reprint needs an administrator, the production authorization and a written reason, all recorded', async () => {
  const prisma = await db()
  const source = await mkSource()
  const { json } = await requestReprint(source.id)
  const reprintId = json.order.id as string

  // without authorization: refused (S5), whoever asks
  const plain = await patchStatus(reprintId, { status: 'queued' })
  assert.equal(plain.res.status, 409)
  assert.equal(plain.json.code, 'PAYMENT_NOT_VERIFIED')
  // staff cannot authorize
  assert.equal((await patchStatus(reprintId, { status: 'queued', authorizeUnpaid: true, authorizationReason: 'production defect, photos attached' }, { id: staffId, role: 'staff' })).res.status, 403)
  // an administrator without a reason (or a token one): refused
  for (const reason of [undefined, '', '   ', 'ok']) {
    const refused = await patchStatus(reprintId, { status: 'queued', authorizeUnpaid: true, ...(reason !== undefined ? { authorizationReason: reason } : {}) })
    assert.equal(refused.res.status, 409, `reason ${JSON.stringify(reason)} -> HTTP ${refused.res.status}`)
    assert.equal(refused.json.code, 'AUTHORIZATION_REASON_REQUIRED')
  }
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: reprintId } })).status, 'awaiting_review')
  // with the reason: allowed and recorded; the order is NOT pretended to be paid
  const ok = await patchStatus(reprintId, { status: 'queued', authorizeUnpaid: true, authorizationReason: 'production defect, photos attached' })
  assert.equal(ok.res.status, 200, JSON.stringify(ok.json))
  const after = await prisma.printOrder.findUniqueOrThrow({ where: { id: reprintId } })
  assert.equal(after.status, 'queued')
  assert.equal(after.paymentStatus, 'quote')
  const authorization = (after.metadata as any).productionAuthorization
  assert.equal(authorization.authorized, true)
  assert.equal(authorization.by, adminId)
  assert.equal(authorization.reason, 'production defect, photos attached')
})

test('the reason rule is only for reprints: other administrator authorizations behave as before', async () => {
  const prisma = await db()
  const order = await prisma.printOrder.create({
    data: { userId: customerId, status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'cash', totalCents: 1500, subtotalCents: 1500, items: { create: [{ modelTitle: 'x', material: 'PLA', quantity: 1, unitPriceCents: 1500, totalCents: 1500 }] } },
  })
  const res = await patchStatus(order.id, { status: 'queued', authorizeUnpaid: true })
  assert.equal(res.res.status, 200, JSON.stringify(res.json))
})

test('rules: who can ask, what counts as an open request, what is shown as "to be quoted"', () => {
  assert.equal(canRequestReprint({ status: 'completed', paymentStatus: 'paid', metadata: {} }), true)
  assert.equal(canRequestReprint({ status: 'failed', paymentStatus: 'paid', metadata: {} }), true)
  assert.equal(canRequestReprint({ status: 'completed', paymentStatus: 'pending', metadata: {} }), false)
  assert.equal(canRequestReprint({ status: 'queued', paymentStatus: 'paid', metadata: {} }), false)
  assert.equal(canRequestReprint({ status: 'awaiting_payment', paymentStatus: 'paid', metadata: {} }), false)
  assert.equal(findOpenReprint([{ status: 'cancelled' }, { status: 'completed' }]), null)
  assert.deepEqual(findOpenReprint([{ status: 'cancelled' }, { status: 'awaiting_review' }]), { status: 'awaiting_review' })
  assert.equal(isReprintAwaitingQuote({ paymentStatus: 'quote', metadata: { reprint: { priceStatus: 'to_be_quoted' } } }), true)
  assert.equal(isReprintAwaitingQuote({ paymentStatus: 'paid', metadata: { reprint: { priceStatus: 'to_be_quoted' } } }), false)
  assert.equal(isReprintAwaitingQuote({ paymentStatus: 'quote', metadata: {} }), false)
})
