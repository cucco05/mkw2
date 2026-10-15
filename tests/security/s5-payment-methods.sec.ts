// S5 regression tests – payment methods by role, and "no production without verified payment / authorization".
//   * guests and customers: card (Stripe) or a quote request only; cash/invoice/PO/no-charge/PayPal are admin-only
//   * an order enters production only with a VERIFIED payment (paid / free) or an explicit administrator authorization,
//     and that is enforced on EVERY status transition (checkout, admin routes, approvals, webhooks, external services,
//     printer assignment, auto-queue, PrintLab submission), not only at checkout.
// Originally these tests reproduced the problem (todo); they now guard the fixed behaviour.
import { cartBody, db, installFakeStripe, postJson, resetDb, seedShopModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import {
  allowedPaymentMethods, checkManualTransition, checkoutRoleOf, gateAutomaticStatus, getProductionAuthorization,
  isPaymentMethodAllowed, isPaymentVerified, isProductionEligible, isProductionStatus,
} from '../../lib/order-payment-policy'

type Key = 'guest' | 'customer' | 'staff' | 'admin'
let viewers: Record<Key, Viewer>
let adminId = ''
let modelId = ''

// A PaymentIntent counts only for an order of EXACTLY its amount (lib/payment-verification.ts): by default it is the price of
// the cart these tests order (measured in test.before); a succeeded intent says how much was received, like the real thing.
let cardTotal = 0
const PI = (id: string, status: string, amount?: number) => {
  const cents = amount ?? cardTotal
  return {
    id, object: 'payment_intent', status, amount: cents, amount_received: status === 'succeeded' ? cents : 0, currency: 'usd',
    metadata: {}, customer: null, latest_charge: null, client_secret: 'secret_FAKE',
  }
}
const intents: Record<string, any> = {}

function as(viewer: Viewer) {
  viewerGuards.getViewer = async () => viewer
}

async function checkout(who: Key, body: Record<string, unknown>) {
  const { POST } = await import('../../app/api/checkout/route')
  as(viewers[who])
  const res = await postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { commit: true, ...body }))
  const json = await res.clone().json().catch(() => ({}))
  return { res, json }
}

async function orders() {
  return (await db()).printOrder.findMany({ orderBy: { createdAt: 'asc' } })
}

async function mkOrder(over: Record<string, unknown> = {}) {
  const prisma = await db()
  return prisma.printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'cash', subtotalCents: 1000, totalCents: 1000,
      metadata: { paymentIntentId: `cash_${Math.random().toString(36).slice(2)}` },
      ...over,
    } as any,
  })
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  const mk = (name: string, role: 'customer' | 'staff' | 'admin') =>
    prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role } })
  const [customer, staff, admin] = await Promise.all([mk('s5customer', 'customer'), mk('s5staff', 'staff'), mk('s5admin', 'admin')])
  adminId = admin.id
  viewers = {
    guest: null,
    customer: { id: customer.id, role: 'customer' },
    staff: { id: staff.id, role: 'staff' },
    admin: { id: admin.id, role: 'admin' },
  }
  modelId = (await seedShopModel()).model.id
  await installFakeStripe() // default stubs, enough for a preview; the real stubs of these tests are installed below
  {
    const { POST } = await import('../../app/api/checkout/route')
    viewerGuards.getViewer = async () => null
    const preview = await postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { paymentMethod: 'card' }))
    cardTotal = ((await preview.json()) as any).amount
    assert.ok(cardTotal > 0, 'could not measure the price of the test cart')
  }
  await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => {
      if (!intents[id]) throw new Error(`unknown fake intent ${id}`)
      return intents[id]
    },
  })
})

// ---- Policy (unit) ---------------------------------------------------------------------------------
test('policy: only administrators get cash/invoice/PO/no-charge/PayPal; everyone else card or quote', () => {
  assert.deepEqual([...allowedPaymentMethods('guest')], ['card', 'quote'])
  assert.deepEqual([...allowedPaymentMethods('customer')], ['card', 'quote'])
  assert.deepEqual([...allowedPaymentMethods('staff')], ['card', 'quote'])
  for (const m of ['cash', 'invoice', 'po', 'comped', 'paypal', 'card', 'quote']) assert.equal(isPaymentMethodAllowed(m, 'admin'), true, m)
  for (const role of ['guest', 'customer', 'staff'] as const) {
    for (const m of ['cash', 'invoice', 'po', 'comped', 'paypal']) assert.equal(isPaymentMethodAllowed(m, role), false, `${role}/${m}`)
  }
  assert.equal(checkoutRoleOf(null), 'guest')
  assert.equal(checkoutRoleOf({ isAdmin: false, role: 'customer' }), 'customer')
  assert.equal(checkoutRoleOf({ isAdmin: false, role: 'staff' }), 'staff')
  assert.equal(checkoutRoleOf({ isAdmin: true, role: 'customer' }), 'admin')
  assert.equal(checkoutRoleOf({ isAdmin: false, role: 'admin' }), 'admin')
})

test('policy: "verified" is strict – only paid / free', () => {
  for (const s of ['paid', 'succeeded', 'free', 'PAID']) assert.equal(isPaymentVerified(s), true, s)
  for (const s of ['pending', 'processing', 'requires_capture', 'authorized', 'failed', 'canceled', 'quote', '', null, undefined]) {
    assert.equal(isPaymentVerified(s as any), false, String(s))
  }
})

test('policy: production gate for manual and automatic transitions', () => {
  const unpaid = { paymentStatus: 'pending', metadata: {} }
  const paid = { paymentStatus: 'paid', metadata: {} }
  for (const next of ['queued', 'printing', 'post_process', 'shipped', 'completed']) {
    assert.equal(isProductionStatus(next), true)
    assert.equal(checkManualTransition(unpaid, next, { adminId: 'a' }).allowed, false, next)
    assert.equal(checkManualTransition(paid, next, { adminId: 'a' }).allowed, true, next)
    assert.equal(gateAutomaticStatus(unpaid, next), 'awaiting_payment', next)
    assert.equal(gateAutomaticStatus(paid, next), next, next)
  }
  for (const next of ['cancelled', 'failed', 'awaiting_payment', 'awaiting_review']) {
    assert.equal(checkManualTransition(unpaid, next, { adminId: 'a' }).allowed, true, next)
  }
  const auth = checkManualTransition(unpaid, 'queued', { adminId: 'admin_1', authorizeUnpaid: true, reason: 'cash received' })
  assert.equal(auth.allowed, true)
  const metadata = (auth as any).metadata
  assert.equal(getProductionAuthorization(metadata)?.by, 'admin_1')
  assert.equal(isProductionEligible({ paymentStatus: 'pending', metadata }), true)
  // a forged authorization shape does not count
  assert.equal(isProductionEligible({ paymentStatus: 'pending', metadata: { productionAuthorization: { by: 'x' } } }), false)
  assert.equal(isProductionEligible({ paymentStatus: 'pending', metadata: { productionAuthorization: { authorized: true } } }), false)
})

// ---- Checkout: roles --------------------------------------------------------------------------------
for (const who of ['guest', 'customer', 'staff'] as const) {
  for (const method of ['cash', 'po', 'invoice', 'comped', 'paypal'] as const) {
    test(`checkout: ${who} cannot use "${method}" (403, no order created)`, async () => {
      await resetOrders()
      const extra = method === 'invoice'
        ? { paymentDetails: { billingEmail: 'buyer@sectest.invalid', billingContact: 'Fake Buyer' } }
        : method === 'po' ? { paymentDetails: { purchaseOrderNumber: 'PO-FAKE-1' } } : {}
      const { res, json } = await checkout(who, { paymentMethod: method, ...extra })
      assert.equal(res.status, 403, `${who}/${method} -> HTTP ${res.status}`)
      assert.deepEqual(json.allowedPaymentMethods, ['card', 'quote'])
      assert.equal((await orders()).length, 0)
    })
  }
}

async function resetOrders() {
  const prisma = await db()
  await prisma.printOrder.deleteMany()
  for (const k of Object.keys(intents)) delete intents[k]
}

test('checkout: tampering with the request cannot unlock payment methods or statuses', async () => {
  await resetOrders()
  const attempts: Record<string, unknown>[] = [
    { paymentMethod: 'cash', adminFreeCheckout: true, isAdmin: true, role: 'admin', status: 'queued', paymentStatus: 'paid' },
    { paymentMethod: 'comped', isAdmin: true, role: 'admin' },
    { paymentMethod: 'po', paymentStatus: 'paid', status: 'printing', productionAuthorization: { authorized: true, by: 'x' } },
    { paymentMethod: 'invoice', metadata: { productionAuthorization: { authorized: true, by: 'x' } }, paymentDetails: { billingEmail: 'a@sectest.invalid' } },
  ]
  for (const body of attempts) {
    for (const who of ['guest', 'customer', 'staff'] as const) {
      const { res } = await checkout(who, body)
      assert.equal(res.status, 403, `${who} ${JSON.stringify(body).slice(0, 60)} -> HTTP ${res.status}`)
    }
  }
  // enum look-alikes are rejected by validation, not interpreted
  for (const method of ['CASH', ' cash', 'cash ', 'Comped', 'free', 'admin']) {
    const { res } = await checkout('guest', { paymentMethod: method })
    assert.equal(res.status, 400, `"${method}" -> HTTP ${res.status}`)
  }
  assert.equal((await orders()).length, 0)
})

test('checkout: a card payment confirmed by Stripe enters production; unconfirmed ones wait', async () => {
  for (const [stripeStatus, expectedOrderStatus, expectedPayment] of [
    ['succeeded', 'queued', 'paid'],
    ['processing', 'awaiting_payment', 'processing'],
    ['requires_capture', 'awaiting_payment', 'requires_capture'],
  ] as const) {
    await resetOrders()
    intents[`pi_${stripeStatus}`] = PI(`pi_${stripeStatus}`, stripeStatus)
    for (const who of ['guest', 'customer'] as const) {
      await resetOrders()
      intents[`pi_${stripeStatus}`] = PI(`pi_${stripeStatus}`, stripeStatus)
      const { res } = await checkout(who, { paymentMethod: 'card', paymentIntentId: `pi_${stripeStatus}` })
      assert.equal(res.status, 200, `${who}/${stripeStatus} -> HTTP ${res.status}`)
      const [order] = await orders()
      // "authorized" and "requires_capture" are two names of the same unverified state (checkout vs Stripe sync).
      const sameState = expectedPayment === 'requires_capture' ? ['requires_capture', 'authorized'] : [expectedPayment]
      assert.ok(sameState.includes(order.paymentStatus), `${who}/${stripeStatus} paymentStatus=${order.paymentStatus}`)
      assert.equal(order.status, expectedOrderStatus, `${who}/${stripeStatus} status`)
    }
  }
})

test('checkout: a quote request is never an order in production (guest and customer)', async () => {
  for (const who of ['guest', 'customer'] as const) {
    await resetOrders()
    const { res } = await checkout(who, { paymentMethod: 'quote' })
    assert.equal(res.status, 200)
    const [order] = await orders()
    assert.equal(order.status, 'awaiting_review')
    assert.equal(order.paymentStatus, 'quote')
    assert.equal(isProductionStatus(order.status), false)
    assert.equal(isProductionEligible(order), false)
    const prisma = await db()
    assert.equal(await prisma.printOrderApprovalRequest.count({ where: { orderId: order.id } }), 1)
  }
})

test('checkout: an administrator checkout is an explicit no-charge order, recorded as such', async () => {
  // By design an administrator placing an order through the checkout creates a no-charge ("free") order, whatever
  // method is selected. It is an explicit administrator action and the order says so; it is never marked "paid".
  const cases: Array<[string, Record<string, unknown>]> = [
    ['cash', {}],
    ['po', { paymentDetails: { purchaseOrderNumber: 'PO-FAKE-1' } }],
    ['invoice', { paymentDetails: { billingEmail: 'buyer@sectest.invalid', billingContact: 'Fake Buyer' } }],
    ['comped', {}],
  ]
  for (const [method, extra] of cases) {
    await resetOrders()
    const { res } = await checkout('admin', { paymentMethod: method, ...extra })
    assert.equal(res.status, 200, `admin/${method} -> HTTP ${res.status}`)
    const [order] = await orders()
    assert.equal(order.paymentStatus, 'free', method)
    assert.equal(order.totalCents, 0, method)
    assert.equal((order.metadata as any).adminFreeCheckout, true, method)
    assert.equal(order.status, 'queued', method)
  }
  // an admin quote request is still just a quote
  await resetOrders()
  assert.equal((await checkout('admin', { paymentMethod: 'quote' })).res.status, 200)
  assert.equal((await orders())[0].status, 'awaiting_review')
})

test('checkout: a zero total from a non-administrator (100% discount) is rejected, no free production order', async () => {
  await resetOrders()
  const prisma = await db()
  const customerId = viewers.customer!.id
  await prisma.user.update({ where: { id: customerId }, data: { discountPercent: 100 } })
  try {
    intents.pi_zero = PI('pi_zero', 'succeeded', 0)
    for (const method of ['card', 'quote']) {
      const { res, json } = await checkout('customer', { paymentMethod: method, paymentIntentId: 'pi_zero' })
      assert.equal(res.status, 400, `${method} -> HTTP ${res.status}`)
      assert.match(String(json.error), /greater than zero/)
    }
    assert.equal((await orders()).length, 0)
  } finally {
    await prisma.user.update({ where: { id: customerId }, data: { discountPercent: 0 } })
  }
})

// ---- Status transitions: admin route ---------------------------------------------------------------
async function patchStatus(who: Key, orderId: string, body: Record<string, unknown>) {
  const { PATCH } = await import('../../app/api/admin/orders/[orderId]/status/route')
  as(viewers[who])
  const res = await (PATCH as any)(new NextRequest(`http://localhost/api/admin/orders/${orderId}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ orderId }) }) as Response
  return { res, json: await res.clone().json().catch(() => ({})) }
}

test('admin status route: every production status needs verified payment or explicit admin authorization', async () => {
  const prisma = await db()
  for (const next of ['queued', 'printing', 'post_process', 'shipped', 'completed']) {
    const order = await mkOrder()
    // guest / customer cannot even reach the route
    assert.equal((await patchStatus('guest', order.id, { status: next })).res.status, 401)
    assert.equal((await patchStatus('customer', order.id, { status: next })).res.status, 403)
    // staff / admin without authorization: refused
    for (const who of ['staff', 'admin'] as const) {
      const { res, json } = await patchStatus(who, order.id, { status: next })
      assert.equal(res.status, 409, `${who}/${next} -> HTTP ${res.status}`)
      assert.equal(json.code, 'PAYMENT_NOT_VERIFIED')
    }
    // forging payment data in the body does not help
    const forged = await patchStatus('admin', order.id, { status: next, paymentStatus: 'paid', metadata: { productionAuthorization: { authorized: true, by: 'x' } } })
    assert.equal(forged.res.status, 409)
    // staff cannot authorize; only an administrator can
    assert.equal((await patchStatus('staff', order.id, { status: next, authorizeUnpaid: true })).res.status, 403)
    assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'awaiting_payment', `${next}: order changed without authorization`)
    const ok = await patchStatus('admin', order.id, { status: next, authorizeUnpaid: true, authorizationReason: 'cash received at pickup' })
    // NOTE (pre-existing, not S5): for shipped/completed the route answers 400 "StockWorks is not configured" AFTER saving the
    // state, because inventory consumption is not optional. The state change itself is what this test checks.
    const stockworksOnly = ok.res.status === 400 && /StockWorks is not configured/.test(String(ok.json.error))
    assert.ok(ok.res.status === 200 || stockworksOnly, `admin authorized ${next} -> HTTP ${ok.res.status} ${JSON.stringify(ok.json)}`)
    const after = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(after.status, next)
    assert.equal(after.paymentStatus, 'pending', 'authorization must not pretend the order is paid')
    const auth = getProductionAuthorization(after.metadata)
    assert.equal(auth?.by, adminId)
    assert.equal(auth?.reason, 'cash received at pickup')
  }
})

test('admin status route: non-production states stay free; paid orders move without authorization', async () => {
  const unpaid = await mkOrder()
  for (const next of ['cancelled', 'failed']) {
    assert.equal((await patchStatus('staff', unpaid.id, { status: next })).res.status, 200, next)
  }
  const paid = await mkOrder({ status: 'queued', paymentStatus: 'paid', paymentMethod: 'card' })
  assert.equal((await patchStatus('staff', paid.id, { status: 'printing' })).res.status, 200)
  assert.equal((await patchStatus('staff', 'cm0000000000000000000000x', { status: 'queued' })).res.status, 404)
})

// ---- Status transitions: admin order creation ------------------------------------------------------
async function createAdminOrder(who: Key, body: Record<string, unknown>) {
  const { POST } = await import('../../app/api/admin/orders/route')
  as(viewers[who])
  const customerId = viewers.customer!.id
  const res = await (POST as any)(new NextRequest('http://localhost/api/admin/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: customerId, items: [{ modelTitle: 'FAKE', material: 'PLA', quantity: 1, unitPriceCents: 1500 }], ...body }),
  })) as Response
  return { res, json: await res.clone().json().catch(() => ({})) }
}

test('admin order creation: unpaid production orders need explicit administrator authorization', async () => {
  await resetOrders()
  assert.equal((await createAdminOrder('guest', { paymentMethod: 'cash' })).res.status, 401)
  assert.equal((await createAdminOrder('customer', { paymentMethod: 'cash' })).res.status, 403)

  // default status is queued -> refused without authorization
  for (const who of ['staff', 'admin'] as const) {
    const r = await createAdminOrder(who, { paymentMethod: 'cash' })
    assert.equal(r.res.status, 409, `${who} -> HTTP ${r.res.status}`)
    assert.equal(r.json.code, 'PAYMENT_NOT_VERIFIED')
  }
  assert.equal((await orders()).length, 0)

  // waiting for payment is always allowed
  assert.equal((await createAdminOrder('staff', { paymentMethod: 'cash', status: 'awaiting_payment' })).res.status, 200)
  // staff cannot authorize or create no-charge production orders
  assert.equal((await createAdminOrder('staff', { paymentMethod: 'cash', authorizeUnpaid: true })).res.status, 403)
  assert.equal((await createAdminOrder('staff', { paymentMethod: 'comped', items: [{ modelTitle: 'FAKE', material: 'PLA', quantity: 1, unitPriceCents: 0 }] })).res.status, 403)
  // an administrator can, explicitly
  const ok = await createAdminOrder('admin', { paymentMethod: 'cash', authorizeUnpaid: true, authorizationReason: 'cash at pickup' })
  assert.equal(ok.res.status, 200)
  const created = (await orders()).find((o) => o.id === ok.json.order.id)!
  assert.equal(created.status, 'queued')
  assert.equal(created.paymentStatus, 'pending')
  assert.equal(getProductionAuthorization(created.metadata)?.by, adminId)
})

// ---- Other automatic transitions ------------------------------------------------------------------
test('webhook: only a Stripe-confirmed payment releases an order waiting for payment', async () => {
  const stripe: any = await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => intents[id],
  })
  const deliver = async (eventId: string, intentId: string, type: string) => {
    const { POST } = await import('../../app/api/stripe/webhook/route')
    const payload = JSON.stringify({ id: eventId, object: 'event', type, data: { object: { id: intentId, object: 'payment_intent' } } })
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string })
    return (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload }), {}) as Promise<Response>
  }
  const prisma = await db()
  const order = await mkOrder({ stripePaymentIntentId: 'pi_wait_FAKE', paymentMethod: 'card' })
  intents.pi_wait_FAKE = PI('pi_wait_FAKE', 'processing', 1000) // the order below is worth 10.00
  await deliver('evt_s5_1', 'pi_wait_FAKE', 'payment_intent.processing')
  let current = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(current.status, 'awaiting_payment', 'processing must not release the order')
  intents.pi_wait_FAKE = PI('pi_wait_FAKE', 'requires_payment_method', 1000)
  await deliver('evt_s5_2', 'pi_wait_FAKE', 'payment_intent.payment_failed')
  current = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(current.status, 'awaiting_payment', 'a failed payment must not release the order')
  intents.pi_wait_FAKE = PI('pi_wait_FAKE', 'succeeded', 1000)
  await deliver('evt_s5_3', 'pi_wait_FAKE', 'payment_intent.succeeded')
  current = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(current.paymentStatus, 'paid')
  assert.equal(current.status, 'queued', 'a confirmed payment releases the order')
})

test('OrderWorks fulfilment sync cannot move an unpaid order into production', async () => {
  const { syncOrderStatusFromFulfillment } = await import('../../lib/orderworks-sync')
  const prisma = await db()
  const unpaid = await mkOrder({ metadata: { paymentIntentId: 'cash_ow_unpaid' } })
  const paid = await mkOrder({ status: 'queued', paymentStatus: 'paid', paymentMethod: 'card', metadata: { paymentIntentId: 'pi_ow_paid' } })
  for (const fulfilment of ['ready', 'shipped', 'picked_up'] as const) {
    assert.equal(await syncOrderStatusFromFulfillment('cash_ow_unpaid', fulfilment), null, fulfilment)
  }
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: unpaid.id } })).status, 'awaiting_payment')
  const moved = await syncOrderStatusFromFulfillment('pi_ow_paid', 'ready')
  assert.equal(moved?.status, 'post_process')
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: paid.id } })).status, 'post_process')
})

test('PrintLab callback cannot start production on an unpaid order', async () => {
  process.env.PRINTLAB_WEBHOOK_SECRET = 'printlab-test-secret'
  const { POST } = await import('../../app/api/printlab/jobs/[jobId]/route')
  const prisma = await db()
  const call = async (orderId: string, status: string) => (POST as any)(new NextRequest('http://localhost/api/printlab/jobs/job1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer printlab-test-secret' },
    body: JSON.stringify({ status, source_order_id: orderId }),
  }), { params: Promise.resolve({ jobId: 'job1' }) }) as Promise<Response>
  const unpaid = await mkOrder()
  const paid = await mkOrder({ status: 'queued', paymentStatus: 'paid', paymentMethod: 'card' })
  assert.equal((await call(unpaid.id, 'started')).status, 200)
  assert.equal((await call(unpaid.id, 'completed')).status, 200)
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: unpaid.id } })).status, 'awaiting_payment')
  assert.equal((await call(paid.id, 'started')).status, 200)
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: paid.id } })).status, 'printing')
  // an unauthenticated callback is still refused
  const noAuth = await (POST as any)(new NextRequest('http://localhost/api/printlab/jobs/job1', { method: 'POST', body: JSON.stringify({ status: 'started', source_order_id: paid.id }) }), { params: Promise.resolve({ jobId: 'job1' }) }) as Response
  assert.equal(noAuth.status, 401)
})

test('printer assignment, auto-queue and PrintLab submission skip orders that are not payable-eligible', async () => {
  await resetOrders()
  const prisma = await db()
  await prisma.printer.deleteMany()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })

  // legacy rows: queued although unpaid (created before this policy) must still never get a printer
  const legacyUnpaid = await mkOrder({ status: 'queued' })
  const paid = await mkOrder({ status: 'queued', paymentStatus: 'paid', paymentMethod: 'card' })

  const { POST: autoQueue } = await import('../../app/api/admin/printers/auto-queue/route')
  as(viewers.admin)
  const aq = await (autoQueue as any)() as Response
  assert.equal(aq.status, 200)
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: legacyUnpaid.id } })).printerId, null, 'unpaid order got a printer')
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: paid.id } })).printerId, printer.id)

  const { PATCH: assign } = await import('../../app/api/admin/orders/[orderId]/assign-printer/route')
  const call = async (orderId: string) => (assign as any)(new NextRequest(`http://localhost/api/admin/orders/${orderId}/assign-printer`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printerId: printer.id }),
  }), { params: Promise.resolve({ orderId }) }) as Promise<Response>
  const refused = await call(legacyUnpaid.id)
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).code, 'PAYMENT_NOT_VERIFIED')
  assert.equal((await call(paid.id)).status, 200)

  const { submitOrderToPrintLab } = await import('../../lib/printlab-order-submit')
  await assert.rejects(() => submitOrderToPrintLab(legacyUnpaid.id, { actor: 'test' }), (err: any) => err?.status === 409)
})

// ---- Existing data: scripts/hold-unpaid-orders.js --------------------------------------------------
function runHold(args: string[]) {
  return execFileSync(process.execPath, ['scripts/hold-unpaid-orders.js', ...args], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL as string },
    encoding: 'utf8',
  })
}

test('data cleanup: queued orders without verified payment go back on hold; everything else is untouched', async () => {
  await resetOrders()
  const prisma = await db()
  const outDir = path.join(process.env.STORAGE_DIR as string, 'backups-s5')
  const legacy = await mkOrder({ status: 'queued' })
  const paid = await mkOrder({ status: 'queued', paymentStatus: 'paid', paymentMethod: 'card' })
  const authorized = await mkOrder({ status: 'queued', metadata: { productionAuthorization: { authorized: true, by: adminId, at: new Date().toISOString() } } })
  const printingUnpaid = await mkOrder({ status: 'printing' })
  const quote = await mkOrder({ status: 'awaiting_review', paymentStatus: 'quote', paymentMethod: 'quote' })
  const waiting = await mkOrder()
  const statusOf = async (id: string) => (await prisma.printOrder.findUniqueOrThrow({ where: { id } })).status

  const dry = runHold([])
  assert.match(dry, /DRY RUN/)
  assert.match(dry, /still queued \(will be put on hold\):\s+1/)
  assert.match(dry, /already in progress \/ finished \(report only\):\s+1/)
  assert.equal(await statusOf(legacy.id), 'queued')
  assert.ok(!existsSync(outDir), 'dry run wrote a record')

  const applied = runHold(['--apply', '--out', outDir])
  assert.match(applied, /Moved 1 order\(s\) to awaiting_payment/)
  assert.equal(await statusOf(legacy.id), 'awaiting_payment')
  assert.equal(await statusOf(paid.id), 'queued')
  assert.equal(await statusOf(authorized.id), 'queued')
  assert.equal(await statusOf(printingUnpaid.id), 'printing', 'in-progress orders are reported, never changed')
  assert.equal(await statusOf(quote.id), 'awaiting_review')
  assert.equal(await statusOf(waiting.id), 'awaiting_payment')
  assert.equal(readdirSync(outDir).filter((f) => f.startsWith('hold-unpaid-orders-')).length, 1)
  assert.equal(await prisma.printOrder.count(), 6, 'no order was deleted')
})
