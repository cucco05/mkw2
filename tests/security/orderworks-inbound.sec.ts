// Step 4.0b – the inbound OrderWorks webhook (POST /api/makerworks/jobs) must not be a way around S5.
// Before: whoever held the shared secret could post a job with any total, any line items, `paymentStatus: "paid"` and metadata of
// their choice (even a ready-made `productionAuthorization`) and get an order that went straight to production; the secret was also
// accepted in the address. Now: the route is OFF in production unless enabled on purpose; the secret is read from headers only;
// the orders it creates are unpaid, in review and flagged, ignore the declared payment, cannot carry our own metadata markers and
// are not moved by outside fulfilment updates. The shared secret, the PrintLab/G-code routes and the administrator's own
// job-form route keep working.
import { db, installFakeStripe, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { isProductionEligible } from '../../lib/order-payment-policy'
import { isOrderWorksInboundEnabled } from '../../lib/orderworks-inbound'
import { buildEnvChecks } from '../../app/api/admin/env-check/route'
import { buildOrderCreateData } from '../../lib/orders'

const SECRET = 'inbound-secret-for-tests-0123456789abcdef'
let adminId = ''

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {}
  for (const key of Object.keys(env)) before[key] = process.env[key]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
  try { return await fn() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete (process.env as any)[key]
      else (process.env as any)[key] = value
    }
  }
}

const jobBody = (over: Record<string, unknown> = {}) => ({
  paymentIntentId: 'pi_ow_attack_1',
  totalCents: 100,
  currency: 'eur',
  paymentStatus: 'paid',
  paymentMethod: 'card',
  lineItems: [{ modelId: 'm1', title: 'Expensive part', qty: 5, scale: 1, unitPrice: 1000, lineTotal: 5000, material: 'PLA' }],
  shipping: { method: 'pickup' },
  metadata: { note: 'from outside', productionAuthorization: { authorized: true, by: 'attacker', reason: 'trust me' } },
  ...over,
})

async function postJob(body: unknown, opts: { headers?: Record<string, string>; query?: string; raw?: string } = {}) {
  const { POST } = await import('../../app/api/makerworks/jobs/route')
  const req = new NextRequest(`http://localhost/api/makerworks/jobs${opts.query ?? ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.raw ?? JSON.stringify(body),
  })
  const res = await (POST as any)(req, {}) as Response
  return { res, json: await res.clone().json().catch(() => ({})) }
}
const bearer = { Authorization: `Bearer ${SECRET}` }

const counts = async () => {
  const prisma = await db()
  return { jobs: await prisma.jobForm.count(), orders: await prisma.printOrder.count() }
}

test.before(async () => {
  process.env.MAKERWORKS_INBOUND_SECRET = SECRET
  await resetDb()
  const prisma = await db()
  adminId = (await prisma.user.create({ data: { email: 'ow-admin@sectest.invalid', passwordHash: 'x', name: 'ow-admin', role: 'admin' } })).id
})

test.beforeEach(async () => {
  const prisma = await db()
  await prisma.printOrder.deleteMany()
  await prisma.jobForm.deleteMany()
  await prisma.stripeEvent.deleteMany()
  await prisma.rateLimit.deleteMany()
})

test('the switch: off in production unless enabled on purpose, on elsewhere', () => {
  assert.equal(isOrderWorksInboundEnabled({ NODE_ENV: 'production' }), false)
  for (const value of ['', 'false', '0', 'TRUE ', 'yes', '1']) {
    assert.equal(isOrderWorksInboundEnabled({ NODE_ENV: 'production', ORDERWORKS_INBOUND_ENABLED: value }), value.trim().toLowerCase() === 'true', JSON.stringify(value))
  }
  assert.equal(isOrderWorksInboundEnabled({ NODE_ENV: 'development' }), true)
  assert.equal(isOrderWorksInboundEnabled({ NODE_ENV: 'test' }), true)
})

test('in production the route is OFF by default: answered before anything is read, nothing is written, with or without the secret', async () => {
  await withEnv({ NODE_ENV: 'production', ORDERWORKS_INBOUND_ENABLED: undefined }, async () => {
    for (const attempt of [
      { body: jobBody(), opts: { headers: bearer } },
      { body: jobBody(), opts: { headers: { Authorization: 'Bearer wrong-secret' } } },
      { body: jobBody(), opts: {} },
      { body: null, opts: { headers: bearer, raw: '{not json' } },
    ]) {
      const { res, json } = await postJob(attempt.body, attempt.opts)
      assert.equal(res.status, 503)
      assert.equal(json.code, 'ORDERWORKS_INBOUND_DISABLED')
    }
    assert.deepEqual(await counts(), { jobs: 0, orders: 0 })
  })
})

test('when enabled, the secret is read from headers only, never from the address', async () => {
  await withEnv({ NODE_ENV: 'production', ORDERWORKS_INBOUND_ENABLED: 'true' }, async () => {
    const inAddress = await postJob(jobBody(), { query: `?secret=${SECRET}` })
    assert.equal(inAddress.res.status, 401)
    assert.deepEqual(await counts(), { jobs: 0, orders: 0 })
    assert.equal((await postJob(jobBody(), { headers: { Authorization: 'Bearer nope' } })).res.status, 401)
    const ok = await postJob(jobBody({ paymentStatus: undefined }), { headers: { 'x-makerworks-secret': SECRET } })
    assert.equal(ok.res.status, 200, JSON.stringify(ok.json))
  })
})

test('an order created from the webhook ignores the declared payment, cannot carry our markers and waits for an administrator', async () => {
  const prisma = await db()
  await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => ({
      id, object: 'payment_intent', status: 'requires_payment_method', amount: 100, amount_received: 0, currency: 'eur', metadata: {}, customer: null, latest_charge: null,
    }),
  })
  const { res, json } = await postJob(jobBody(), { headers: bearer })
  assert.equal(res.status, 200, JSON.stringify(json))
  const order = await prisma.printOrder.findFirstOrThrow({ include: { items: true } })
  // the sender said "paid"; Stripe says the payment does not exist yet (the old flow labels that "failed"): never paid
  assert.ok(!['paid', 'free'].includes(order.paymentStatus), `payment status ${order.paymentStatus}`)
  assert.equal(order.status, 'awaiting_review')
  assert.equal(order.paymentReviewReason, 'external_order')
  assert.equal(isProductionEligible(order), false, 'the sender cannot make the order eligible')
  const metadata = order.metadata as Record<string, unknown>
  assert.equal('productionAuthorization' in metadata, false, 'a production authorization cannot be injected from outside')
  assert.equal(metadata.note, 'from outside', 'harmless metadata is kept')
  assert.equal(metadata.source, 'orderworks')
})

test('even when Stripe confirms exactly the declared (low) amount, the order is paid but is NOT released; outside fulfilment updates do not move it', async () => {
  const prisma = await db()
  await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => ({
      id, object: 'payment_intent', status: 'succeeded', amount: 100, amount_received: 100, currency: 'eur', metadata: {}, customer: null,
      latest_charge: { id: 'ch_ow', receipt_url: null, amount_refunded: 0 },
    }),
  })
  assert.equal((await postJob(jobBody({ fulfillmentStatus: 'ready' }), { headers: bearer })).res.status, 200)
  let order = await prisma.printOrder.findFirstOrThrow()
  assert.equal(order.paymentStatus, 'paid', 'Stripe really received 1.00 for this payment')
  assert.equal(order.status, 'awaiting_review', 'a cheap real payment must not release an expensive order claimed from outside')
  assert.equal(order.paymentReviewReason, 'external_order')
  // the outside service keeps pushing the order forward: ignored
  for (const fulfillmentStatus of ['ready', 'shipped', 'picked_up']) {
    assert.equal((await postJob(jobBody({ fulfillmentStatus }), { headers: bearer })).res.status, 200)
    order = await prisma.printOrder.findFirstOrThrow()
    assert.equal(order.status, 'awaiting_review', `fulfilment ${fulfillmentStatus} moved the order`)
  }
  assert.equal(await prisma.printOrder.count(), 1, 'repeated posts do not create more orders')
})

test('the administrator\'s own job-form route keeps working (explicit admin decision), but outside metadata is still stripped of our markers', async () => {
  const prisma = await db()
  await prisma.jobForm.create({
    data: {
      paymentIntentId: 'cash_ow_admin_1', totalCents: 4500, currency: 'EUR', status: 'pending', paymentMethod: 'cash', paymentStatus: 'pending',
      lineItems: [{ modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 45, lineTotal: 45, material: 'PLA' }],
      shipping: { method: 'pickup' },
      metadata: { note: 'kept', productionAuthorization: { authorized: true, by: 'planted-earlier' } },
    },
  })
  const { PATCH } = await import('../../app/api/jobs/[paymentIntentId]/route')
  viewerGuards.getViewer = async () => ({ id: adminId, role: 'admin' } as Viewer)
  const res = await (PATCH as any)(new NextRequest('http://localhost/api/jobs/cash_ow_admin_1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentStatus: 'paid' }),
  }), { params: Promise.resolve({ paymentIntentId: 'cash_ow_admin_1' }) }) as Response
  assert.equal(res.status, 200, await res.clone().text())
  const order = await prisma.printOrder.findFirstOrThrow()
  assert.equal(order.paymentStatus, 'paid', 'the administrator said paid: explicit and accountable')
  assert.equal(order.status, 'queued')
  const metadata = order.metadata as Record<string, unknown>
  assert.equal(metadata.note, 'kept')
  assert.equal('productionAuthorization' in metadata, false, 'a marker planted in the job form earlier does not survive')
})

test('the admin environment check flags the webhook when it is on in production', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'a-valid-test-jwt-secret-with-32-chars' }
  const on = buildEnvChecks({ ...base, ORDERWORKS_INBOUND_ENABLED: 'true' }).find((c) => c.key === 'ORDERWORKS_INBOUND_ENABLED')!
  assert.equal(on.required, true)
  assert.equal(on.ok, false)
  assert.equal(buildEnvChecks(base).find((c) => c.key === 'ORDERWORKS_INBOUND_ENABLED')!.ok, true)
  assert.equal(buildEnvChecks({ ...base, NODE_ENV: 'development' }).some((c) => c.key === 'ORDERWORKS_INBOUND_ENABLED'), false)
})

test('shared things stay: the switch touches only the webhook; the PrintLab and G-code routes keep using the shared secret', () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')
  for (const rel of ['app/api/printlab/jobs/[jobId]/route.ts', 'app/api/models/[id]/gcodes/route.ts', 'app/api/jobs/[paymentIntentId]/route.ts']) {
    assert.equal(read(rel).includes('orderworks-inbound'), false, `${rel} must not depend on the webhook switch`)
  }
  assert.ok(read('app/api/printlab/jobs/[jobId]/route.ts').includes('MAKERWORKS_INBOUND_SECRET'))
  assert.ok(read('app/api/models/[id]/gcodes/route.ts').includes('MAKERWORKS_INBOUND_SECRET'))
})

test('defence in depth: the order builder itself refuses our markers and a declared payment when the source is untrusted', () => {
  const data = buildOrderCreateData({
    paymentIntentId: 'pi_direct', amountCents: 100, currency: 'EUR', paymentMethod: 'card', paymentStatus: 'paid', untrustedSource: true,
    lineItems: [{ modelId: 'm', title: 'x', qty: 1, scale: 1, unitPrice: 1, lineTotal: 1, material: 'PLA' } as any],
    shipping: { method: 'pickup' },
    metadata: { productionAuthorization: { authorized: true, by: 'x' }, reprint: { priceStatus: 'to_be_quoted' }, harmless: 1 },
  })
  assert.equal(data.status, 'awaiting_review')
  assert.equal(data.paymentStatus, 'pending')
  assert.equal(data.paymentReviewReason, 'external_order')
  const metadata = data.metadata as Record<string, unknown>
  assert.deepEqual(Object.keys(metadata).sort(), ['harmless', 'paymentIntentId'])
  assert.equal(isProductionEligible({ paymentStatus: data.paymentStatus, metadata }), false)
})
