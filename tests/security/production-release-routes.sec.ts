// Step 4.6, S4 - the administrator routes that change orders and production, against the real handlers and a throw-away database:
//   E  who may call them and FROM WHERE: a request from another site is refused before anything is read or written (not only SameSite=Lax); the callbacks that
//      carry a secret are a different thing and do not depend on the session cookie;
//   F  an order that went to production can not be deleted (its job would be left without an order); cancelling it needs a written reason; nothing is ever
//      sent to a printer from here;
//   G  linking a Stripe PaymentIntent by hand: only if the payment itself says it is for THIS order - the same customer, e-mail or amount are not a substitute;
//   H  the organization approver can answer a quote that is waiting for the answer, and nothing else;
//   I  what the routes write to an order's metadata does not erase what other work wrote a moment before (the markers that keep a job from being sent twice);
//   J  the staff / administrator split on the routes that decide.
// No printer, PrintLab, StockWorks or Stripe account is ever contacted.
import './_harness'
import { db, installFakeStripe } from './_harness'
import {
  as, assertNothingHappened, auditActions, bodyOf, callCallback, callDelete, callLink, callStatus, callSubmit, journalOf, makeOrder, ORIGIN, releasedSpec, resetSeams, setup, sleep, snap, state, teardown, world,
} from './_release-fixtures'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { NextRequest } from 'next/server'
import { stripePaymentAdminOps } from '../../lib/stripe-payments'

test.before(setup)
test.after(teardown)
afterEach(resetSeams)

type Params = Record<string, string>
type RouteSpec = { name: string; load: () => Promise<any>; method: string; url: string; params?: Params; body?: unknown; adminOnly?: boolean }
const O = 'cm_order_for_the_sweep'
const ROUTES: RouteSpec[] = [
  { name: 'order status', load: () => import('../../app/api/admin/orders/[orderId]/status/route'), method: 'PATCH', url: `/api/admin/orders/${O}/status`, params: { orderId: O }, body: { status: 'cancelled' } },
  { name: 'assign printer', load: () => import('../../app/api/admin/orders/[orderId]/assign-printer/route'), method: 'PATCH', url: `/api/admin/orders/${O}/assign-printer`, params: { orderId: O }, body: { printerId: null } },
  { name: 'automatic queue', load: () => import('../../app/api/admin/printers/auto-queue/route'), method: 'POST', url: '/api/admin/printers/auto-queue', body: {} },
  { name: 'send to PrintLab', load: () => import('../../app/api/admin/orders/[orderId]/printlab-submit/route'), method: 'POST', url: `/api/admin/orders/${O}/printlab-submit`, params: { orderId: O }, body: {} },
  { name: 'link a PrintLab record', load: () => import('../../app/api/admin/orders/[orderId]/printlab-link/route'), method: 'POST', url: `/api/admin/orders/${O}/printlab-link`, params: { orderId: O }, body: { mode: 'manual', manual: { printLabJobId: 'job_x' } } },
  { name: 'confirm an outside effect', load: () => import('../../app/api/admin/orders/[orderId]/external-effects/route'), method: 'POST', url: `/api/admin/orders/${O}/external-effects`, params: { orderId: O }, body: { effectKey: 'k', externalId: 'x', reason: 'a long enough reason' }, adminOnly: true },
  { name: 'link a Stripe payment', load: () => import('../../app/api/admin/orders/[orderId]/stripe-attach/route'), method: 'POST', url: `/api/admin/orders/${O}/stripe-attach`, params: { orderId: O }, body: { paymentIntentId: 'pi_abc123', reason: 'a long enough reason' }, adminOnly: true },
  { name: 'packing checklist (generate)', load: () => import('../../app/api/admin/orders/[orderId]/packing-checklist/route'), method: 'POST', url: `/api/admin/orders/${O}/packing-checklist`, params: { orderId: O }, body: {} },
  { name: 'packing checklist (save)', load: () => import('../../app/api/admin/orders/[orderId]/packing-checklist/route'), method: 'PATCH', url: `/api/admin/orders/${O}/packing-checklist`, params: { orderId: O }, body: { items: [] } },
  { name: 'shipping', load: () => import('../../app/api/admin/orders/[orderId]/shipping/route'), method: 'PATCH', url: `/api/admin/orders/${O}/shipping`, params: { orderId: O }, body: {} },
  { name: 'slicer statistics', load: () => import('../../app/api/admin/orders/[orderId]/slicer-stats/route'), method: 'PUT', url: `/api/admin/orders/${O}/slicer-stats`, params: { orderId: O }, body: {} },
  { name: 'slicer profile', load: () => import('../../app/api/admin/orders/[orderId]/slicer-profile/route'), method: 'POST', url: `/api/admin/orders/${O}/slicer-profile`, params: { orderId: O }, body: {} },
  { name: 'approval request', load: () => import('../../app/api/admin/orders/[orderId]/approval-requests/route'), method: 'POST', url: `/api/admin/orders/${O}/approval-requests`, params: { orderId: O }, body: { message: 'hello' } },
  { name: 'message to the customer', load: () => import('../../app/api/admin/orders/[orderId]/messages/route'), method: 'POST', url: `/api/admin/orders/${O}/messages`, params: { orderId: O }, body: { body: 'hello' } },
  { name: 'receipt', load: () => import('../../app/api/admin/orders/[orderId]/receipt/route'), method: 'POST', url: `/api/admin/orders/${O}/receipt`, params: { orderId: O }, body: {} },
  { name: 'refund', load: () => import('../../app/api/admin/orders/[orderId]/refund/route'), method: 'POST', url: `/api/admin/orders/${O}/refund`, params: { orderId: O }, body: {} },
  { name: 'Stripe sync', load: () => import('../../app/api/admin/orders/[orderId]/stripe-sync/route'), method: 'POST', url: `/api/admin/orders/${O}/stripe-sync`, params: { orderId: O }, body: {} },
  { name: 'payment hold', load: () => import('../../app/api/admin/orders/[orderId]/payment-hold/route'), method: 'POST', url: `/api/admin/orders/${O}/payment-hold`, params: { orderId: O }, body: { outcome: 'accepted', reason: 'a long enough reason' }, adminOnly: true },
  { name: 'order line', load: () => import('../../app/api/admin/orders/[orderId]/items/[itemId]/route'), method: 'PATCH', url: `/api/admin/orders/${O}/items/i1`, params: { orderId: O, itemId: 'i1' }, body: { quantity: 2, reason: 'a long enough reason' }, adminOnly: true },
  { name: 'delete an order', load: () => import('../../app/api/admin/orders/[orderId]/route'), method: 'DELETE', url: `/api/admin/orders/${O}`, params: { orderId: O }, body: { reason: 'a long enough reason' }, adminOnly: true },
  { name: 'create an order', load: () => import('../../app/api/admin/orders/route'), method: 'POST', url: '/api/admin/orders', body: {} },
  { name: 'create a printer', load: () => import('../../app/api/admin/printers/route'), method: 'POST', url: '/api/admin/printers', body: { name: 'X' } },
  { name: 'change a printer', load: () => import('../../app/api/admin/printers/[id]/route'), method: 'PATCH', url: '/api/admin/printers/p1', params: { id: 'p1' }, body: {} },
  { name: 'delete a printer', load: () => import('../../app/api/admin/printers/[id]/route'), method: 'DELETE', url: '/api/admin/printers/p1', params: { id: 'p1' } },
  { name: 'sync printers from PrintLab', load: () => import('../../app/api/admin/printers/sync-bambu-view/route'), method: 'POST', url: '/api/admin/printers/sync-bambu-view', body: {} },
  { name: 'create a machine', load: () => import('../../app/api/admin/printer-machines/route'), method: 'POST', url: '/api/admin/printer-machines', body: {}, adminOnly: true },
  { name: 'change a machine', load: () => import('../../app/api/admin/printer-machines/[id]/route'), method: 'PATCH', url: '/api/admin/printer-machines/m1', params: { id: 'm1' }, body: {}, adminOnly: true },
  { name: 'pause / resume / stop a printer', load: () => import('../../app/api/admin/bambu-view/job/route'), method: 'POST', url: '/api/admin/bambu-view/job', body: { printerId: 'p1', action: 'stop' } },
  { name: 'StockWorks movement', load: () => import('../../app/api/stockworks/movements/route'), method: 'POST', url: '/api/stockworks/movements', body: { inventory_item_id: 1, change_grams: -1, movement_type: 'outgoing' } },
  { name: 'OrderWorks job form', load: () => import('../../app/api/jobs/[paymentIntentId]/route'), method: 'PATCH', url: '/api/jobs/pi_x', params: { paymentIntentId: 'pi_x' }, body: { fulfillmentStatus: 'ready' } },
  { name: 'delete an OrderWorks job', load: () => import('../../app/api/admin/orderworks/jobs/[id]/route'), method: 'DELETE', url: '/api/admin/orderworks/jobs/j1', params: { id: 'j1' }, body: { reason: 'a long enough reason' }, adminOnly: true },
]

const callRoute = async (route: RouteSpec, headers: Record<string, string>) => {
  const mod = await route.load()
  const handler = mod[route.method]
  assert.equal(typeof handler, 'function', `${route.name}: no ${route.method} handler`)
  const req = new NextRequest(`${ORIGIN}${route.url}`, {
    method: route.method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  })
  return handler(req, { params: Promise.resolve(route.params ?? {}) }) as Promise<Response>
}
const fingerprint = async () => {
  const prisma = await db()
  const [orders, printers, machines, jobs, audits] = await Promise.all([
    prisma.printOrder.findMany({ select: { id: true, updatedAt: true, status: true, printerId: true }, orderBy: { id: 'asc' } }),
    prisma.printer.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
    prisma.printerMachine.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
    prisma.jobForm.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
    prisma.adminAuditEvent.count(),
  ])
  return JSON.stringify({ orders, printers, machines, jobs, audits, printLab: state.printLab.requests.length, stockWorks: state.stockWorks.requests.length })
}

// ============================================================================================================================================
// E. Where the request comes from
// ============================================================================================================================================
const HOSTILE: Array<[string, Record<string, string>]> = [
  ['another site', { origin: 'https://evil.example' }],
  ['another site (only the referer says so)', { referer: 'https://evil.example/page' }],
  ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }],
  ['an origin of "null"', { origin: 'null' }],
  ['no information about where it comes from', {}],
]
const LEGIT: Array<[string, Record<string, string>]> = [
  ['the origin of this site', { origin: ORIGIN }],
  ['the referer of this site', { referer: `${ORIGIN}/admin/orders/1` }],
  ['same-origin fetch metadata only', { 'sec-fetch-site': 'same-origin' }],
]

test('E1 every route that changes an order, a printer, a machine or the stock refuses a request from another site - before anything happens', async () => {
  await world()
  const prisma = await db()
  await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  await makeOrder(releasedSpec())
  as(state.viewers.admin)
  const before = await fingerprint()
  for (const route of ROUTES) {
    for (const [label, headers] of HOSTILE) {
      const res = await callRoute(route, headers)
      assert.equal(res.status, 403, `${route.name} accepted a request from ${label}: HTTP ${res.status}`)
      assert.equal((await bodyOf(res)).code, 'INVALID_ORIGIN', `${route.name} / ${label}`)
    }
  }
  assert.equal(await fingerprint(), before, 'nothing changed, nothing was asked of PrintLab or StockWorks')
})

test('E2 a request that really comes from this site is not stopped by that check', async () => {
  await world()
  as(state.viewers.admin)
  for (const route of ROUTES) {
    // (the order of these routes does not exist: they answer 404 / 400 / 409 - never "invalid origin")
    for (const [label, headers] of LEGIT) {
      const res = await callRoute(route, headers)
      const code = (await bodyOf(res)).code
      assert.ok(!(res.status === 403 && code === 'INVALID_ORIGIN'), `${route.name} refused ${label}`)
    }
  }
})

test('E3 the protection does not depend on the cookie\'s SameSite: the check is made by the route, for the browser and for any other client', async () => {
  // no route of the list can be reached with a session cookie only: a request without origin information is refused as well
  as(state.viewers.admin)
  for (const route of ROUTES) {
    const res = await callRoute(route, { cookie: 'session=anything' })
    assert.equal(res.status, 403, route.name)
  }
})

test('E4 the callbacks that carry a secret are separate: the session is not involved, and a hostile origin header is not a reason to refuse', async () => {
  await world()
  const order = await makeOrder(releasedSpec())
  // an administrator\'s session does not open the callback...
  as(state.viewers.admin)
  const noSecret = await (await import('../../app/api/printlab/jobs/[jobId]/route')).POST(new NextRequest(`${ORIGIN}/api/printlab/jobs/j`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: 'session=admin' }, body: JSON.stringify({ status: 'started', source_order_id: order.id }),
  }), { params: Promise.resolve({ jobId: 'j' }) } as any)
  assert.equal(noSecret.status, 401)
  const wrong = await (await import('../../app/api/printlab/jobs/[jobId]/route')).POST(new NextRequest(`${ORIGIN}/api/printlab/jobs/j`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-secret' }, body: JSON.stringify({ status: 'started', source_order_id: order.id }),
  }), { params: Promise.resolve({ jobId: 'j' }) } as any)
  assert.equal(wrong.status, 401)
  // ...and the secret does not need the session or the origin
  as(null)
  const res = await callCallback(order.id, 'started')
  assert.equal(res.status, 200)
  assert.equal((await snap(order.id)).row.status, 'printing')
  // the source of the route does not read the session at all
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('app/api/printlab/jobs/[jobId]/route.ts', 'utf8')
  assert.ok(!/requireAdmin|requireRole|viewerGuards|getUserIdFromCookie|cookies\(/.test(source), 'the PrintLab callback must not depend on a session')
  assert.ok(!/isSameOriginRequest|rejectCrossOrigin/.test(source), 'and it is not an origin-checked route')
})

// ============================================================================================================================================
// J. Roles
// ============================================================================================================================================
test('J1 nobody without a session, and no customer, reaches any of these routes', async () => {
  await world()
  for (const [label, viewer, status] of [['anonymous', null, 401], ['customer', state.viewers.customer, 403]] as const) {
    as(viewer)
    for (const route of ROUTES) {
      const res = await callRoute(route, { origin: ORIGIN })
      assert.equal(res.status, status, `${route.name} as ${label}: HTTP ${res.status}`)
    }
  }
})

test('J2 the routes that decide about money or about what is true belong to administrators, not staff', async () => {
  await world()
  as(state.viewers.staff)
  for (const route of ROUTES.filter((entry) => entry.adminOnly)) {
    const res = await callRoute(route, { origin: ORIGIN })
    assert.equal(res.status, 403, `${route.name} was open to staff: HTTP ${res.status}`)
  }
})

// ============================================================================================================================================
// F. Orders that went to production
// ============================================================================================================================================
// (a payment registered by hand: an order with a STRIPE payment on it can not be deleted for that reason - tests/security/admin-order-routes.sec.ts - so the
//  orders here are the ones the production guard is the only thing protecting)
const cashSpec = (over: Record<string, unknown> = {}) => ({ name: 'cash', paymentStatus: 'paid', evidence: 'manual' as const, ...over })
const prodOrder = async (kind: 'confirmed' | 'uncertain' | 'link' | 'printing' | 'material' | 'plain') => {
  if (kind === 'printing') return makeOrder(cashSpec({ status: 'printing' }))
  if (kind === 'material') return makeOrder(cashSpec({ status: 'completed', metadata: { stockworksConsumedAt: new Date().toISOString() } }))
  if (kind === 'plain') return makeOrder({ name: 'plain', status: 'awaiting_payment' })
  const order = await makeOrder(cashSpec())
  if (kind === 'confirmed') assert.equal((await callSubmit(order.id)).status, 200)
  if (kind === 'uncertain') { state.printLab.mode.submit = { kind: 'drop', record: true }; assert.equal((await callSubmit(order.id)).status, 409); state.printLab.mode.submit = { kind: 'ok' } }
  if (kind === 'link') {
    const { callLink } = await import('./_release-fixtures')
    assert.equal((await callLink(order.id, 'started')).status, 200)
  }
  return order
}

for (const kind of ['confirmed', 'uncertain', 'link', 'printing', 'material'] as const) {
  test(`F1 an order with a job in production (${kind}) is not deleted, however it is asked; the order and its job stay together`, async () => {
    await world()
    const order = await prodOrder(kind)
    const before = await snap(order.id)
    const res = await callDelete(order.id)
    assert.equal(res.status, 409, JSON.stringify(await bodyOf(res)))
    const body = await bodyOf(res)
    assert.equal(body.code, 'ORDER_HAS_PRODUCTION_JOB')
    assert.ok(Array.isArray(body.details?.evidence) && body.details.evidence.length > 0)
    const prisma = await db()
    assert.ok(await prisma.printOrder.findUnique({ where: { id: order.id } }), 'the order is still there')
    assert.equal((await snap(order.id)).audits, before.audits, 'no deletion was recorded')
    assert.equal(state.printLab.otherCalls().length, 0, 'nothing was sent to PrintLab or to a printer')
  })
}

test('F2 an order that never went to production, or whose attempt provably did nothing, can still be deleted', async () => {
  await world()
  const prisma = await db()
  const plain = await prodOrder('plain')
  assert.equal((await callDelete(plain.id)).status, 200)
  assert.equal(await prisma.printOrder.findUnique({ where: { id: plain.id } }), null)
  // a request PrintLab refused: it did nothing
  const refused = await makeOrder(cashSpec())
  state.printLab.mode.submit = { kind: 'reject', status: 422, message: 'no' }
  assert.equal((await callSubmit(refused.id)).status, 400)
  assert.equal((await callDelete(refused.id)).status, 200)
})

test('F3 a deletion cannot overtake a job being sent at this very moment', async () => {
  const { releaseHooks } = await import('../../lib/production-release')
  await world()
  const order = await makeOrder(cashSpec())
  let deletion: Response | null = null
  releaseHooks.beforeExternalCall = async () => {
    releaseHooks.beforeExternalCall = undefined
    deletion = await callDelete(order.id)
  }
  assert.equal((await callSubmit(order.id)).status, 200)
  assert.equal(deletion!.status, 409, 'the intent was already written, so the order is seen as sent')
  const prisma = await db()
  assert.ok(await prisma.printOrder.findUnique({ where: { id: order.id } }))
  assert.equal(state.printLab.submissions().length, 1)
})

test('F4 an OrderWorks job form whose order went to production is not deleted with it', async () => {
  await world()
  const prisma = await db()
  const order = await prodOrder('confirmed')
  const job = await prisma.jobForm.create({ data: { paymentIntentId: `ow_f4_${Date.now()}`, lineItems: [], totalCents: 2500, currency: 'EUR' } })
  await prisma.printOrder.update({ where: { id: order.id }, data: { metadata: { ...((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).metadata as object), jobFormId: job.id } as any } })
  const { DELETE } = await import('../../app/api/admin/orderworks/jobs/[id]/route')
  const res = await (DELETE as any)(new NextRequest(`${ORIGIN}/api/admin/orderworks/jobs/${job.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ reason: 'removing a test job form' }) }), { params: Promise.resolve({ id: job.id }) })
  assert.equal(res.status, 409)
  assert.equal((await bodyOf(res)).code, 'ORDER_HAS_PRODUCTION_JOB')
  assert.ok(await prisma.jobForm.findUnique({ where: { id: job.id } }), 'the job form is still there')
  assert.ok(await prisma.printOrder.findUnique({ where: { id: order.id } }), 'and so is the order')
  // one without such an order goes
  const free = await prisma.jobForm.create({ data: { paymentIntentId: `ow_f4b_${Date.now()}`, lineItems: [], totalCents: 100, currency: 'EUR' } })
  const gone = await (DELETE as any)(new NextRequest(`${ORIGIN}/api/admin/orderworks/jobs/${free.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ reason: 'removing a test job form' }) }), { params: Promise.resolve({ id: free.id }) })
  assert.equal(gone.status, 200)
})

test('F5 cancelling an order that went to production needs a written reason, leaves a record, and sends nothing to PrintLab or a printer', async () => {
  await world()
  const prisma = await db()
  const order = await prodOrder('confirmed')
  const sent = state.printLab.requests.length
  for (const extra of [{}, { cancellationReason: '' }, { cancellationReason: 'short' }]) {
    const before = await snap(order.id)
    const res = await callStatus(order.id, 'cancelled', extra)
    assert.equal(res.status, 409, JSON.stringify(extra))
    assert.equal((await bodyOf(res)).code, 'CANCELLATION_REASON_REQUIRED')
    assertNothingHappened(before, await snap(order.id), 'cancel without a reason')
  }
  const ok = await callStatus(order.id, 'cancelled', { cancellationReason: 'customer withdrew; job stopped in PrintLab by the operator' })
  assert.equal(ok.status, 200, JSON.stringify(await bodyOf(ok)))
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(row.status, 'cancelled')
  const cancellation = (row.metadata as any).cancellation
  assert.deepEqual([cancellation.reason, cancellation.by, cancellation.note], ['admin_cancelled_after_production', state.adminId, 'customer withdrew; job stopped in PrintLab by the operator'])
  assert.ok(cancellation.evidence.includes('printlab_job_confirmed'))
  const event = await prisma.adminAuditEvent.findFirst({ where: { targetId: order.id, action: 'admin.order.status.update' }, orderBy: { createdAt: 'desc' } })
  assert.equal((event!.metadata as any).cancellationReason, 'customer withdrew; job stopped in PrintLab by the operator')
  assert.equal(state.printLab.requests.length, sent, 'cancelling the order asked PrintLab nothing')
  assert.equal(state.printLab.otherCalls().length, 0)
  // an order that never went to production is cancelled as before
  const plain = await prodOrder('plain')
  assert.equal((await callStatus(plain.id, 'cancelled')).status, 200)
})

// ============================================================================================================================================
// G. Linking a Stripe PaymentIntent by hand
// ============================================================================================================================================
function intent(over: Record<string, unknown> = {}) {
  return { id: 'pi_attach1', object: 'payment_intent', status: 'succeeded', amount: 4500, amount_received: 4500, currency: 'eur', metadata: {}, customer: 'cus_1', receipt_email: 'buyer@example.com', ...over }
}
async function attach(orderId: string, body: Record<string, unknown>, who: 'admin' | 'staff' = 'admin', headers: Record<string, string> = { origin: ORIGIN }) {
  as(state.viewers[who])
  const { POST } = await import('../../app/api/admin/orders/[orderId]/stripe-attach/route')
  return (POST as any)(new NextRequest(`${ORIGIN}/api/admin/orders/${orderId}/stripe-attach`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ orderId }) }) as Promise<Response>
}
const unpaidOrder = (over: Record<string, unknown> = {}) => makeOrder({ name: 'attach', status: 'awaiting_payment', total: 4500, ...over })

test('G1 a collected payment that names this order is linked; the payment sync then verifies it as for any payment', async () => {
  await world()
  const order = await unpaidOrder()
  let retrieved: string | null = null
  let synced: unknown[] | null = null
  const original = { ...stripePaymentAdminOps }
  stripePaymentAdminOps.retrievePaymentIntent = (async (id: string) => { retrieved = id; return intent({ metadata: { orderId: order.id } }) }) as any
  stripePaymentAdminOps.syncStripePaymentIntent = (async (...args: unknown[]) => { synced = args; return { paymentStatus: 'paid', updatedOrders: 1, orderIds: [order.id] } }) as any
  try {
    const res = await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'the buyer paid from the e-mailed link' })
    assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
    assert.equal(retrieved, 'pi_attach1', 'Stripe was asked, the typed id was not believed')
    assert.deepEqual(synced, ['pi_attach1', 'admin.attach'])
    const row = await (await db()).printOrder.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(row.stripePaymentIntentId, 'pi_attach1')
    assert.equal(row.paymentStatus, 'pending', 'linking is not paying: only the verification marks an order paid')
    assert.equal(row.paidAt, null)
    const events = await (await db()).adminAuditEvent.findMany({ where: { targetId: order.id, action: 'admin.order.stripe_attach' } })
    assert.equal(events.length, 1)
    assert.equal((events[0].metadata as any).proof, 'metadata.orderId')
  } finally {
    Object.assign(stripePaymentAdminOps, original)
  }
})

test('G2 the payment must name THIS order: the same customer, e-mail, amount, currency and date are not a substitute - the order stays unpaid', async () => {
  await world()
  const order = await unpaidOrder({ metadata: { paymentIntentId: 'cash_x', customerEmail: 'buyer@example.com' } })
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: order.id }, data: { customerEmail: 'buyer@example.com' } })
  const original = { ...stripePaymentAdminOps }
  let syncCalls = 0
  stripePaymentAdminOps.syncStripePaymentIntent = (async () => { syncCalls += 1; return { paymentStatus: 'paid', updatedOrders: 1, orderIds: [] } }) as any
  try {
    for (const metadata of [{}, { orderId: 'cm_some_other_order' }, { customerEmail: 'buyer@example.com', orderNumber: '1', email: 'buyer@example.com' }, { orderId: '' }]) {
      stripePaymentAdminOps.retrievePaymentIntent = (async () => intent({ metadata })) as any
      const before = await snap(order.id)
      const res = await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'it is obviously the same customer, same amount' })
      assert.equal(res.status, 409, JSON.stringify(metadata))
      const body = await bodyOf(res)
      assert.equal(body.code, 'STRIPE_ATTACH_REFUSED')
      assert.deepEqual(body.failed.map((entry: any) => entry.check), ['order_association'])
      const after = await snap(order.id)
      assert.deepEqual(after.row, before.row, 'the order is exactly as it was')
      assert.equal(after.row.stripePaymentIntentId, null)
      assert.equal(after.row.paymentStatus, 'pending')
    }
    assert.equal(syncCalls, 0, 'the payment was never handed to the payment sync')
    const actions = await auditActions(order.id)
    assert.ok(actions.includes('admin.order.stripe_attach_refused') && !actions.includes('admin.order.stripe_attach'), 'refusals are recorded, there is no link')
  } finally {
    Object.assign(stripePaymentAdminOps, original)
  }
})

test('G3 the other checks: what Stripe says, reuse, the state of the order, and nothing that skips them', async () => {
  await world()
  const prisma = await db()
  const original = { ...stripePaymentAdminOps }
  stripePaymentAdminOps.syncStripePaymentIntent = (async () => ({ paymentStatus: 'paid', updatedOrders: 1, orderIds: [] })) as any
  try {
    const order = await unpaidOrder()
    const named = (over: Record<string, unknown> = {}) => intent({ metadata: { orderId: order.id }, ...over })
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['not collected', { status: 'processing' }, 'collected'],
      ['collected less', { amount_received: 4400 }, 'amount'],
      ['asked for another amount', { amount: 9000, amount_received: 9000 }, 'amount'],
      ['another currency', { currency: 'usd' }, 'currency'],
      ['another payment returned', { id: 'pi_someone_else' }, 'identity'],
    ]
    for (const [label, over, check] of cases) {
      stripePaymentAdminOps.retrievePaymentIntent = (async () => named(over)) as any
      const res = await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'checking the refusal paths' })
      assert.equal(res.status, 409, label)
      assert.ok((await bodyOf(res)).failed.some((entry: any) => entry.check === check), label)
    }
    // Stripe does not know it / can not be reached: nothing changes, and the second case is not a refusal of the payment
    stripePaymentAdminOps.retrievePaymentIntent = (async () => { throw Object.assign(new Error('No such payment_intent'), { statusCode: 404, code: 'resource_missing' }) }) as any
    assert.equal((await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'checking the refusal paths' })).status, 409)
    stripePaymentAdminOps.retrievePaymentIntent = (async () => { throw new Error('connect ETIMEDOUT') }) as any
    const down = await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'checking the refusal paths' })
    assert.equal(down.status, 502)
    assert.equal((await bodyOf(down)).code, 'STRIPE_UNAVAILABLE')
    assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })).stripePaymentIntentId, null)

    // used by another order or attempt
    stripePaymentAdminOps.retrievePaymentIntent = (async () => named()) as any
    const holder = await makeOrder({ name: 'holder', status: 'awaiting_payment', stripeRef: true })
    await prisma.printOrder.update({ where: { id: holder.id }, data: { stripePaymentIntentId: 'pi_attach1' } })
    assert.ok((await bodyOf(await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'checking the refusal paths' }))).failed.some((entry: any) => entry.check === 'not_reused'))
    await prisma.printOrder.update({ where: { id: holder.id }, data: { stripePaymentIntentId: null } })

    // orders that cannot take a payment this way
    for (const [label, spec] of [
      ['cancelled', { status: 'cancelled' }],
      ['under review', { reason: 'amount' }],
      ['already paid', { paymentStatus: 'paid', evidence: 'stripe' as const }],
      ['with payment pages of the hosted checkout', { attempts: ['expired'] }],
    ] as const) {
      const other = await unpaidOrder(spec as any)
      stripePaymentAdminOps.retrievePaymentIntent = (async () => intent({ metadata: { orderId: other.id } })) as any
      const res = await attach(other.id, { paymentIntentId: 'pi_attach1', reason: 'checking the refusal paths' })
      assert.equal(res.status, 409, label)
      assert.ok((await bodyOf(res)).failed.some((entry: any) => entry.check === 'order_state'), label)
    }
  } finally {
    Object.assign(stripePaymentAdminOps, original)
  }
})

test('G4 who may link a payment, and from where; no field skips a check', async () => {
  await world()
  const order = await unpaidOrder()
  const good = { paymentIntentId: 'pi_attach1', reason: 'the buyer paid from the e-mailed link' }
  assert.equal((await attach(order.id, good, 'staff')).status, 403, 'staff can not link a payment')
  assert.equal((await attach(order.id, good, 'admin', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await attach(order.id, { paymentIntentId: 'pi_attach1' })).status, 400, 'a written reason is required')
  assert.equal((await attach(order.id, { ...good, reason: 'ok' })).status, 400)
  assert.equal((await attach(order.id, { ...good, paymentIntentId: 'not-a-payment' })).status, 400)
  for (const extra of [{ force: true }, { skipChecks: true }, { acknowledgeUnverified: true }, { orderId: order.id }, { metadata: { orderId: order.id } }]) {
    assert.equal((await attach(order.id, { ...good, ...extra })).status, 400, `a field that tries to skip a check: ${JSON.stringify(extra)}`)
  }
  assert.equal((await attach('cm_no_such_order_000000000', good)).status, 404)
})

test('G5 the Stripe client is really asked (through the harness\'s fake Stripe), and a payment for another order is refused', async () => {
  await world()
  const order = await unpaidOrder()
  const seen: string[] = []
  await installFakeStripe({ 'paymentIntents.retrieve': async (id: string) => { seen.push(id); return intent({ id, metadata: { orderId: 'cm_other_order_0000000000' } }) } })
  const res = await attach(order.id, { paymentIntentId: 'pi_attach1', reason: 'checking the default path' })
  assert.equal(res.status, 409)
  assert.deepEqual(seen, ['pi_attach1'])
  assert.equal((await snap(order.id)).row.stripePaymentIntentId, null)
  await installFakeStripe()
})

// ============================================================================================================================================
// H. The organization approver
// ============================================================================================================================================
async function orgFixture() {
  const prisma = await db()
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const [approver, requester, outsider] = await Promise.all(['approver', 'requester', 'outsider'].map((name) => prisma.user.create({ data: { email: `org-${name}-${stamp}@sectest.invalid`, passwordHash: 'x', name, role: 'customer' } as any })))
  const org = await prisma.organization.create({ data: { name: `Org ${stamp}`, slug: `org-${stamp}`, createdById: approver.id } })
  const other = await prisma.organization.create({ data: { name: `Other ${stamp}`, slug: `other-${stamp}`, createdById: outsider.id } })
  await prisma.organizationMember.createMany({ data: [{ organizationId: org.id, userId: approver.id, role: 'approver' }, { organizationId: org.id, userId: requester.id, role: 'requester' }] })
  return { org, other, approver, requester, outsider }
}
async function approve(orgId: string, orderId: string, action: string, viewerId: string | null, headers: Record<string, string> = { origin: ORIGIN }) {
  as(viewerId ? { id: viewerId, role: 'customer' } : null)
  const { POST } = await import('../../app/api/customer/organizations/[organizationId]/orders/[orderId]/approval/route')
  return (POST as any)(new NextRequest(`${ORIGIN}/api/customer/organizations/${orgId}/orders/${orderId}/approval`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, note: 'looks right' }) }), { params: Promise.resolve({ organizationId: orgId, orderId }) }) as Promise<Response>
}
const orgOrder = async (orgId: string, spec: Parameters<typeof makeOrder>[0]) => {
  const order = await makeOrder(spec)
  await (await db()).printOrder.update({ where: { id: order.id }, data: { organizationId: orgId } })
  return order
}

test('H1 an approver answers a quote that is waiting; approving does not start production unless the order is released', async () => {
  await world()
  const f = await orgFixture()
  const prisma = await db()
  const quote = await orgOrder(f.org.id, { name: 'quote', status: 'awaiting_review', paymentStatus: 'quote', metadata: { stockworksConsumedAt: 'marker-kept' } })
  const approved = await approve(f.org.id, quote.id, 'approve', f.approver.id)
  assert.equal(approved.status, 200, JSON.stringify(await bodyOf(approved)))
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: quote.id } })
  assert.equal(row.status, 'awaiting_payment', 'an unpaid quote goes to payment, not into the queue')
  assert.equal((row.metadata as any).orgApproval.action, 'approve')
  assert.equal((row.metadata as any).stockworksConsumedAt, 'marker-kept', 'what was already on the order is kept')
  // a released order (paid with proof) goes to the queue
  const paid = await orgOrder(f.org.id, releasedSpec({ status: 'awaiting_review' }))
  assert.equal((await approve(f.org.id, paid.id, 'approve', f.approver.id)).status, 200)
  assert.equal((await snap(paid.id)).row.status, 'queued')
  // a paid order whose payment is on hold is not released by an approval
  const held = await orgOrder(f.org.id, releasedSpec({ status: 'awaiting_review', reason: 'dispute' }))
  assert.equal((await approve(f.org.id, held.id, 'approve', f.approver.id)).status, 200)
  assert.equal((await snap(held.id)).row.status, 'awaiting_payment')
})

test('H2 an approver can not turn around an order that is not waiting for an answer', async () => {
  await world()
  const f = await orgFixture()
  for (const status of ['completed', 'cancelled', 'printing', 'queued', 'shipped', 'failed']) {
    const order = await orgOrder(f.org.id, releasedSpec({ status }))
    for (const action of ['approve', 'reject']) {
      const before = await snap(order.id)
      const res = await approve(f.org.id, order.id, action, f.approver.id)
      assert.equal(res.status, 409, `${action} on ${status}`)
      assert.equal((await bodyOf(res)).code, 'ORDER_NOT_AWAITING_APPROVAL')
      assertNothingHappened(before, await snap(order.id), `${action} on ${status}`)
    }
  }
})

test('H3 rejecting cancels an order that has no money on it - and refuses one that has, or is being paid, or is under review', async () => {
  await world()
  const f = await orgFixture()
  const quote = await orgOrder(f.org.id, { name: 'quote', status: 'awaiting_review', paymentStatus: 'quote' })
  assert.equal((await approve(f.org.id, quote.id, 'reject', f.approver.id)).status, 200)
  assert.equal((await snap(quote.id)).row.status, 'cancelled')
  for (const spec of [
    releasedSpec({ status: 'awaiting_review' }),
    { name: 'processing', status: 'awaiting_payment', paymentStatus: 'processing', attempts: ['processing'] } as const,
    { name: 'hold', status: 'awaiting_review', reason: 'amount' } as const,
    { name: 'open page', status: 'awaiting_payment', attempts: ['open'] } as const,
  ]) {
    const order = await orgOrder(f.org.id, spec as any)
    const before = await snap(order.id)
    const res = await approve(f.org.id, order.id, 'reject', f.approver.id)
    assert.equal(res.status, 409, JSON.stringify(spec))
    assert.equal((await bodyOf(res)).code, 'ORDER_HAS_PAYMENT')
    assertNothingHappened(before, await snap(order.id), 'reject with money')
  }
})

test('H4 who can answer: an approver of that organization, from this site', async () => {
  await world()
  const f = await orgFixture()
  const order = await orgOrder(f.org.id, { name: 'quote', status: 'awaiting_review', paymentStatus: 'quote' })
  const before = await snap(order.id)
  assert.equal((await approve(f.org.id, order.id, 'approve', null)).status, 401)
  assert.equal((await approve(f.org.id, order.id, 'approve', f.requester.id)).status, 403, 'a requester can not approve')
  assert.equal((await approve(f.org.id, order.id, 'approve', f.outsider.id)).status, 404, 'a member of another organization sees nothing')
  assert.equal((await approve(f.other.id, order.id, 'approve', f.outsider.id)).status, 404, 'a person who is not a member of the organization has nothing to answer')
  assert.equal((await approve(f.org.id, order.id, 'approve', f.approver.id, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await approve(f.org.id, order.id, 'approve', f.approver.id, {})).status, 403)
  assert.equal((await approve(f.org.id, order.id, 'approve-ish', f.approver.id)).status, 400)
  assertNothingHappened(before, await snap(order.id), 'refused approvals')
  // an order of another organization is not found through this one
  const foreign = await orgOrder(f.other.id, { name: 'quote', status: 'awaiting_review', paymentStatus: 'quote' })
  assert.equal((await approve(f.org.id, foreign.id, 'approve', f.approver.id)).status, 404)
})

// ============================================================================================================================================
// I. What the routes write to the metadata does not erase what others wrote
// ============================================================================================================================================
// The row is locked by a transaction that writes a marker after a pause. A route that read the metadata BEFORE waiting for the lock would write its stale copy over
// the marker; one that reads under the lock keeps it.
async function withMarkerWrittenMeanwhile(orderId: string, marker: Record<string, unknown>, run: () => Promise<Response>) {
  const prisma = await db()
  let locked!: () => void
  const lockHeld = new Promise<void>((resolve) => { locked = resolve })
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    locked()
    await sleep(500)
    const current = (await tx.printOrder.findUniqueOrThrow({ where: { id: orderId } })).metadata as Record<string, unknown>
    await tx.printOrder.update({ where: { id: orderId }, data: { metadata: { ...current, ...marker } as any } })
  })
  await lockHeld
  const res = await run()
  await holder
  return res
}

const META_ROUTES: Array<{ name: string; call: (orderId: string) => Promise<Response>; key: string }> = [
  { name: 'packing checklist (generate)', key: 'packingChecklist', call: async (id) => callRoute({ ...ROUTES.find((r) => r.name === 'packing checklist (generate)')!, url: `/api/admin/orders/${id}/packing-checklist`, params: { orderId: id } }, { origin: ORIGIN }) },
  { name: 'packing checklist (save)', key: 'packingChecklist', call: async (id) => callRoute({ ...ROUTES.find((r) => r.name === 'packing checklist (save)')!, body: { items: [{ id: 'a', label: 'Part', qty: 1, status: 'packed' }] }, url: `/api/admin/orders/${id}/packing-checklist`, params: { orderId: id } }, { origin: ORIGIN }) },
  { name: 'shipping', key: 'shippingInfo', call: async (id) => callRoute({ ...ROUTES.find((r) => r.name === 'shipping')!, body: { carrier: 'GLS', trackingNumber: 'T123' }, url: `/api/admin/orders/${id}/shipping`, params: { orderId: id } }, { origin: ORIGIN }) },
  { name: 'slicer statistics', key: 'slicerStats', call: async (id) => callRoute({ ...ROUTES.find((r) => r.name === 'slicer statistics')!, body: { printHours: 2, materials: [{ material: 'PLA', grams: 20 }] }, url: `/api/admin/orders/${id}/slicer-stats`, params: { orderId: id } }, { origin: ORIGIN }) },
]
for (const route of META_ROUTES) {
  test(`I1 ${route.name}: a marker written while the route waits is still there afterwards`, async () => {
    await world()
    const order = await makeOrder(releasedSpec())
    const marker = { stockworksConsumedAt: '2026-10-17T10:00:00.000Z', productionAuthorization: { authorized: true, by: state.adminId, at: '2026-10-17T09:00:00.000Z', reason: 'kept' } }
    const res = await withMarkerWrittenMeanwhile(order.id, marker, () => route.call(order.id))
    assert.equal(res.status, 200, JSON.stringify(await bodyOf(res)))
    const metadata = (await snap(order.id)).row.metadata
    assert.equal(metadata.stockworksConsumedAt, marker.stockworksConsumedAt, 'the "already taken out of stock" marker survived')
    assert.equal(metadata.productionAuthorization.reason, 'kept', 'and so did the authorization')
    assert.ok(metadata[route.key], 'and the route\'s own data was written')
  })
}

test('I2 the legacy checkout writes the order\'s metadata only through the locked writer', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('app/api/checkout/route.ts', 'utf8')
  assert.ok(!/printOrder\.update\(\{[^}]*metadata:/s.test(source), 'no direct update of an order\'s metadata in the legacy checkout')
  assert.ok(source.includes('updateOrderMetadata'))
  const routes = ['packing-checklist', 'shipping', 'slicer-stats', 'slicer-profile', 'stripe-attach']
  for (const name of routes) {
    const text = readFileSync(`app/api/admin/orders/[orderId]/${name}/route.ts`, 'utf8')
    if (name === 'stripe-attach') assert.ok(text.includes('lockOrderRow') && text.includes('FOR UPDATE') === false, 'stripe-attach writes under the lock')
    else assert.ok(text.includes('updateOrderMetadata'), `${name} must use the locked writer`)
  }
})

// ============================================================================================================================================
// K. What PrintLab says moves an order only when the word is one PrintLab is known to send
// ============================================================================================================================================
for (const waiting of ['awaiting_review', 'awaiting_payment'] as const) {
  test(`K1 a PrintLab word nobody knows does not move a paid order that waits for an administrator (${waiting}); a known one does`, async () => {
    await world()
    const order = await makeOrder(releasedSpec({ status: waiting }))
    for (const word of ['something-new', 'paused', 'rerouted']) {
      const viaCallback = await callCallback(order.id, word)
      assert.equal(viaCallback.status, 200, `callback "${word}"`)
      assert.equal((await snap(order.id)).row.status, waiting, `the unknown word "${word}" moved the order out of "${waiting}" (callback)`)
      const viaLink = await callLink(order.id, word)
      assert.equal(viaLink.status, 200, `link "${word}"`)
      assert.equal((await snap(order.id)).row.status, waiting, `the unknown word "${word}" moved the order out of "${waiting}" (link)`)
    }
    // the control: a word PrintLab really sends moves a RELEASED order
    assert.equal((await callCallback(order.id, 'started')).status, 200)
    assert.equal((await snap(order.id)).row.status, 'printing')
  })
}
