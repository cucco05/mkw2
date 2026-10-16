// Step 4.5 – the administrator's recorded decision about a payment that is on hold (lib/payment-hold.ts, POST /api/admin/orders/<id>/payment-hold).
//
// A payment is on hold when the server does not know whether money was taken, or knows it was and a person has to look. The same cart can not be paid again
// while it is (tests/security/cart-after-payment.sec.ts). Most holds end by themselves; the rest end HERE, and what is asserted is:
//   * only an administrator (not staff, not a customer, not a stranger), from this site, with a written reason;
//   * "no charge" is refused if any payment of the order is collected or on its way at Stripe, and if Stripe can not be asked it needs an explicit
//     acknowledgement that is recorded; it cancels the order, closes the open payment pages and lets the customer pay again;
//   * "accepted" is for money that is collected; it clears the hold and nothing else;
//   * nothing is taken from the request except the decision, the reason and the acknowledgement: not the state of the order, not what Stripe said;
//   * the decision, who took it, when, why and what Stripe said are kept on the order and in the audit log, and a resolved hold can not be resolved twice.
// Fake Stripe, throw-away database, fake data.
import { db, resetDb, seedShopModel } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { syncPayment } from '../../lib/payment-sync'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let customer: NonNullable<Viewer>
let admin: NonNullable<Viewer>
let staff: NonNullable<Viewer>

const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT

let ipSeq = 0
const nextIp = () => `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `hold-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const cartOf = () => ({ items: [{ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false })

async function startPayment(viewer: NonNullable<Viewer>) {
  viewerGuards.getViewer = async () => viewer
  const quoteMod = await import('../../app/api/checkout/quote/route')
  const sessionMod = await import('../../app/api/checkout/session/route')
  const body = cartOf()
  const quote = (await (quoteMod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const total = (await quote.json()).totalCents as number
  const res = (await (sessionMod.POST as any)(new NextRequest('http://localhost/api/checkout/session', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify({ ...body, checkoutKey: newKey(), expectedTotalCents: total }),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function resolve(orderId: string, body: unknown, viewer: Viewer | null, opts: { origin?: string } = {}) {
  viewerGuards.getViewer = async () => viewer
  const mod = await import('../../app/api/admin/orders/[orderId]/payment-hold/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/admin/orders/${orderId}/payment-hold`, {
    method: 'POST',
    headers: { origin: opts.origin ?? 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), 'user-agent': 'sectest' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ orderId }) })) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function reset() {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  await prisma.adminAuditEvent.deleteMany()
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, reads: [], failNextReads: 0, retrieveFails: false, lastParams: null, allParams: [], rejectCreate: false })
}
const order = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id }, include: { paymentAttempts: true } })
const sessionIdOf = () => [...fake.sessions.keys()][0]
const REASON = 'Checked in the Stripe dashboard: no payment was made for this order.'

// an order whose payment is being confirmed (the state an earlier sync of a payment that is processing leaves)
async function confirming() {
  const first = await startPayment(customer)
  assert.equal(first.status, 200, first.text)
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentStatus: 'processing' } })
  await prisma.paymentAttempt.updateMany({ where: { orderId: first.json.orderId }, data: { status: 'processing' } })
  return first.json.orderId as string
}
// a payment that arrived and did not match the order (a wrong amount): paid at Stripe, held here
async function mismatched() {
  const first = await startPayment(customer)
  assert.equal(first.status, 200, first.text)
  const sessionId = sessionIdOf()
  fake.pay(sessionId, { amount: (first.json.totalCents as number) + 100 })
  await syncPayment({ kind: 'checkout_session', id: sessionId, hint: { orderId: first.json.orderId } }, { eventType: 'test.mismatch', effects: 'none' as any })
  const row = await order(first.json.orderId)
  assert.ok(row.paymentReviewReason, 'the wrong amount put the order under review')
  return first.json.orderId as string
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  const mk = (n: string, role: string, extra: Record<string, unknown> = {}) => prisma.user.create({ data: { email: `${n}@sectest.invalid`, passwordHash: 'x', name: n, role, ...extra } as any })
  customer = { id: (await mk('hold-customer', 'customer')).id, role: 'customer' }
  admin = { id: (await mk('hold-admin', 'admin', { isAdmin: true })).id, role: 'admin' }
  staff = { id: (await mk('hold-staff', 'staff')).id, role: 'staff' }
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ---- who, from where, with what ---------------------------------------------------------------------------------------------------------------------
test('only an administrator may resolve a hold: nobody, a customer, and staff are refused, and nothing changes', async () => {
  await reset()
  const id = await confirming()
  for (const [viewer, status] of [[null, 401], [customer, 403], [staff, 403]] as const) {
    const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, viewer)
    assert.equal(r.status, status, `${viewer?.role ?? 'nobody'}: ${r.text}`)
  }
  const row = await order(id)
  assert.equal(row.paymentStatus, 'processing')
  assert.equal(row.status, 'awaiting_payment')
  assert.equal(await (await db()).adminAuditEvent.count(), 0)
})

test('a request from another site is refused', async () => {
  await reset()
  const id = await confirming()
  const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin, { origin: 'https://evil.example' })
  assert.equal(r.status, 403)
  assert.equal((await order(id)).paymentStatus, 'processing')
})

test('a written reason of at least 10 characters is needed, and only the three known fields are read', async () => {
  await reset()
  const id = await confirming()
  for (const reason of ['', 'ok', '         ', 'too short']) {
    const r = await resolve(id, { outcome: 'no_charge', reason }, admin)
    assert.equal(r.status, 400, `"${reason}": ${r.text}`)
    assert.equal(r.json.code, 'REASON_REQUIRED')
  }
  for (const body of [{ outcome: 'refund', reason: REASON }, { reason: REASON }, { outcome: 'no_charge' }, { outcome: 'no_charge', reason: REASON, paymentStatus: 'paid' }, { outcome: 'no_charge', reason: REASON, status: 'queued' }, { outcome: 'accepted', reason: REASON, paymentReviewReason: null }]) {
    const r = await resolve(id, body, admin)
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal((await order(id)).paymentStatus, 'processing')
})

test('an order whose payment is not on hold has nothing to resolve', async () => {
  await reset()
  const first = await startPayment(customer)
  const r = await resolve(first.json.orderId, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'NOT_ON_HOLD')
  assert.equal((await order(first.json.orderId)).status, 'awaiting_payment')
  const missing = await resolve('does-not-exist-0000', { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(missing.status, 404)
})

// ---- "no charge" ---------------------------------------------------------------------------------------------------------------------------------
test('no charge: Stripe is asked, nothing is collected -> the order is cancelled, the open page is closed, the decision is kept, and the customer may pay again', async () => {
  await reset()
  const id = await confirming()
  const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.stripeCheck, 'confirmed_no_charge')
  const row = await order(id)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.paymentStatus, 'canceled')
  assert.equal(row.paymentReviewReason, null)
  assert.ok(row.paymentAttempts.every((attempt) => attempt.status === 'failed' && attempt.failureReason === 'admin_released'))
  assert.equal(fake.state.expireCalls, 1, 'the payment page that was open is closed at Stripe')
  const meta = row.metadata as any
  assert.equal(meta.paymentHoldResolution.length, 1)
  const entry = meta.paymentHoldResolution[0]
  assert.equal(entry.outcome, 'no_charge')
  assert.equal(entry.by, admin.id)
  assert.equal(entry.reason, REASON)
  assert.equal(entry.stripeCheck, 'confirmed_no_charge')
  assert.equal(entry.previousPaymentStatus, 'processing')
  assert.ok(!Number.isNaN(Date.parse(entry.at)))
  assert.equal(meta.cancellation.reason, 'admin_payment_hold_release')
  const audit = await (await db()).adminAuditEvent.findMany({ where: { action: 'admin.order.payment_hold.resolve' } })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].targetId, id)
  assert.equal(audit[0].adminId, admin.id)
  assert.equal((audit[0].metadata as any).outcome, 'no_charge')
  // the customer may pay again
  const again = await startPayment(customer)
  assert.equal(again.status, 200, again.text)
  assert.notEqual(again.json.orderId, id)
})

test('no charge is refused when a payment of the order is collected at Stripe (a wrong amount: the money is there, the order is held)', async () => {
  await reset()
  const id = await mismatched()
  const before = await order(id)
  const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'CHARGE_EXISTS')
  const after = await order(id)
  assert.equal(after.status, before.status)
  assert.equal(after.paymentReviewReason, before.paymentReviewReason)
  assert.equal((after.metadata as any).paymentHoldResolution, undefined)
  assert.equal(fake.state.expireCalls, 0)
})

test('no charge is refused for an order that is paid', async () => {
  await reset()
  const first = await startPayment(customer)
  fake.pay(sessionIdOf())
  await syncPayment({ kind: 'checkout_session', id: sessionIdOf(), hint: { orderId: first.json.orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  await (await db()).printOrder.update({ where: { id: first.json.orderId }, data: { paymentReviewReason: 'dispute' } })
  const r = await resolve(first.json.orderId, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAYMENT_COLLECTED')
  assert.equal((await order(first.json.orderId)).paymentStatus, 'paid')
})

test('no charge when Stripe can not be asked: refused, unless the administrator acknowledges it - and then it is recorded', async () => {
  await reset()
  const id = await confirming()
  fake.state.failNextReads = 50
  fake.state.retrieveFails = true
  const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'STRIPE_UNREACHABLE')
  assert.equal((await order(id)).paymentStatus, 'processing', 'unchanged')
  const accepted = await resolve(id, { outcome: 'no_charge', reason: REASON, acknowledgeUnverified: true }, admin)
  assert.equal(accepted.status, 200, accepted.text)
  assert.equal(accepted.json.stripeCheck, 'unreachable_acknowledged')
  assert.equal(((await order(id)).metadata as any).paymentHoldResolution[0].stripeCheck, 'unreachable_acknowledged')
  fake.state.failNextReads = 0
  fake.state.retrieveFails = false
})

test('no charge: if Stripe shows the payment as collected when it is asked again, it is recorded as paid and the "no charge" is refused', async () => {
  await reset()
  const id = await confirming()
  fake.pay(sessionIdOf()) // the customer HAD paid: the confirmation never reached us
  const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAYMENT_COLLECTED')
  assert.equal((await order(id)).paymentStatus, 'paid', 'the sync wrote what Stripe said')
})

// ---- "accepted" ------------------------------------------------------------------------------------------------------------------------------------
test('accepted: the money is collected and the hold is cleared (status untouched); the same cart is no longer blocked', async () => {
  await reset()
  const first = await startPayment(customer)
  fake.pay(sessionIdOf())
  await syncPayment({ kind: 'checkout_session', id: sessionIdOf(), hint: { orderId: first.json.orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentReviewReason: 'duplicate_payment', status: 'awaiting_review' } })
  const blocked = await startPayment(customer)
  assert.equal(blocked.status, 409, 'a paid order under review blocks the same cart')
  const r = await resolve(first.json.orderId, { outcome: 'accepted', reason: 'The duplicate was refunded; the order stands.' }, admin)
  assert.equal(r.status, 200, r.text)
  const row = await order(first.json.orderId)
  assert.equal(row.paymentReviewReason, null)
  assert.equal(row.status, 'awaiting_review', 'moving the order on is a separate, usual step')
  assert.equal(row.paymentStatus, 'paid')
  const entry = (row.metadata as any).paymentHoldResolution[0]
  assert.equal(entry.outcome, 'accepted')
  assert.equal(entry.previousReviewReason, 'duplicate_payment')
  // still waiting for a person to move it out of review: still not a payment to repeat
  assert.equal((await startPayment(customer)).status, 409)
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { status: 'queued' } })
  const again = await startPayment(customer)
  assert.equal(again.status, 200, `resolved and in production: ${again.text}`)
})

test('accepted is refused for a payment that is not collected', async () => {
  await reset()
  const id = await confirming()
  const r = await resolve(id, { outcome: 'accepted', reason: REASON }, admin)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'NOT_PAID')
  assert.equal((await order(id)).paymentStatus, 'processing')
})

test('a resolved hold can not be resolved twice, and the second try changes nothing', async () => {
  await reset()
  const id = await confirming()
  assert.equal((await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)).status, 200)
  const again = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(again.status, 409, again.text)
  assert.equal(again.json.code, 'NOT_ON_HOLD')
  assert.equal(((await order(id)).metadata as any).paymentHoldResolution.length, 1)
  assert.equal(await (await db()).adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }), 1)
})

test('simultaneous decisions on one order: one wins, the other changes nothing', async () => {
  await reset()
  const id = await confirming()
  const [a, b] = await Promise.all([
    resolve(id, { outcome: 'no_charge', reason: REASON }, admin),
    resolve(id, { outcome: 'no_charge', reason: REASON }, admin),
  ])
  const statuses = [a.status, b.status].sort()
  assert.ok(statuses[0] === 200 && statuses[1] === 409, `${a.status} ${b.status}: ${a.text} ${b.text}`)
  assert.equal(((await order(id)).metadata as any).paymentHoldResolution.length, 1)
})
