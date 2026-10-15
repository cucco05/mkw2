// Step 4.0c (P4) – what the customer order APIs return. Before: the whole database row (Stripe identifiers, the guest access hash, the
// checkout key, the payment-sync lease, accounting fields and the internal `metadata` with production authorizations and effect
// bookkeeping). Now: an allow list (lib/customer-order-view.ts); clients get what they need from `derived`.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'

let ownerId = ''
let otherId = ''
let orderId = ''

const FORBIDDEN_KEYS = [
  'stripePaymentIntentId', 'stripeChargeId', 'stripeCustomerId', 'stripeInvoiceId', 'checkoutKey', 'guestAccessTokenHash', 'guestAccessExpiresAt',
  'paymentSyncLeaseId', 'paymentSyncLeaseUntil', 'paymentSyncedAt', 'paymentReviewReason', 'metadata', 'printerId', 'printerAssignedAt',
  'printerAssignedBy', 'contributionType', 'donatedAmountCents', 'materialCostCents', 'machineTimeMinutes', 'contributionNotes',
]
const SECRET_MARKERS = ['pi_secret_marker', 'ch_secret_marker', 'cus_secret_marker', 'in_secret_marker', 'secret-checkout-key', 'secret-hash', 'planted-admin', 'secret-review-reason']

function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => keysDeep(entry, out))
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) { out.add(key); keysDeep(entry, out) }
  }
  return out
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  ownerId = (await prisma.user.create({ data: { email: 'co-owner@sectest.invalid', passwordHash: 'x', name: 'owner' } })).id
  otherId = (await prisma.user.create({ data: { email: 'co-other@sectest.invalid', passwordHash: 'x', name: 'other' } })).id
  orderId = (await prisma.printOrder.create({
    data: {
      userId: ownerId, status: 'queued', paymentStatus: 'paid', paymentMethod: 'card', currency: 'EUR', subtotalCents: 5000, totalCents: 5000, paidAt: new Date(),
      stripePaymentIntentId: 'pi_secret_marker', stripeChargeId: 'ch_secret_marker', stripeCustomerId: 'cus_secret_marker', stripeInvoiceId: 'in_secret_marker',
      checkoutKey: 'secret-checkout-key', guestAccessTokenHash: 'secret-hash', paymentReviewReason: 'secret-review-reason',
      paymentSyncLeaseId: 'secret-hash', paymentSyncLeaseUntil: new Date(), paymentSyncedAt: new Date(),
      receiptUrl: 'https://pay.stripe.com/receipts/visible', materialCostCents: 1234, donatedAmountCents: 99,
      metadata: { productionAuthorization: { authorized: true, by: 'planted-admin' }, postPayment: { receipt: { status: 'done' } }, artifacts: { manufacturabilityReport: { filePath: '/orders/x/report.pdf' } } },
      items: { create: [{ modelTitle: 'Part', material: 'PLA', quantity: 1, unitPriceCents: 5000, totalCents: 5000 }] },
    },
  })).id
})

async function getDetail(userId: string | null) {
  const { GET } = await import('../../app/api/customer/orders/[orderId]/route')
  viewerGuards.getViewer = async () => (userId ? { id: userId, role: 'customer' } : null)
  const res = await (GET as any)(new NextRequest(`http://localhost/api/customer/orders/${orderId}`), { params: Promise.resolve({ orderId }) }) as Response
  return { res, text: await res.clone().text(), json: await res.clone().json().catch(() => ({})) }
}
async function getList(userId: string | null) {
  const { GET } = await import('../../app/api/customer/orders/route')
  viewerGuards.getViewer = async () => (userId ? { id: userId, role: 'customer' } : null)
  const res = await (GET as any)(new NextRequest('http://localhost/api/customer/orders?limit=10')) as Response
  return { res, text: await res.clone().text(), json: await res.clone().json().catch(() => ({})) }
}

test('the order detail API returns what the customer needs and nothing internal', async () => {
  const { res, text, json } = await getDetail(ownerId)
  assert.equal(res.status, 200, text)
  assert.equal(json.order.id, orderId)
  assert.equal(json.order.status, 'queued')
  assert.equal(json.order.paymentStatus, 'paid')
  assert.equal(json.order.totalCents, 5000)
  assert.equal(json.order.receiptUrl, 'https://pay.stripe.com/receipts/visible')
  assert.equal(json.order.items.length, 1)
  assert.ok('derived' in json && 'production' in json)
  const keys = keysDeep(json.order)
  for (const key of FORBIDDEN_KEYS) assert.equal(keys.has(key), false, `"${key}" must not be returned`)
  for (const marker of SECRET_MARKERS) assert.equal(text.includes(marker), false, `"${marker}" leaked in the response`)
  // what clients need from the metadata is still there, computed on the server
  assert.deepEqual(json.derived.manufacturabilityReport, { filePath: '/orders/x/report.pdf', generatedAt: null })
})

test('the order list API returns the same restricted view', async () => {
  const { res, text, json } = await getList(ownerId)
  assert.equal(res.status, 200, text)
  assert.equal(json.orders.length, 1)
  const keys = keysDeep(json.orders)
  for (const key of FORBIDDEN_KEYS) assert.equal(keys.has(key), false, `"${key}" must not be returned in the list`)
  for (const marker of SECRET_MARKERS) assert.equal(text.includes(marker), false, `"${marker}" leaked in the list`)
  assert.equal(json.orders[0].totalCents, 5000)
})

test('somebody else, or nobody, gets nothing', async () => {
  assert.equal((await getDetail(otherId)).res.status, 404)
  assert.equal((await getDetail(null)).res.status, 401)
  assert.equal((await getList(null)).res.status, 401)
  assert.equal((await getList(otherId)).json.orders.length, 0)
})
