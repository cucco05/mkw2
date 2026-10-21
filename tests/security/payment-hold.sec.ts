// Step 4.5 – the administrator's recorded decision about a payment that is on hold (lib/payment-hold.ts, POST /api/admin/orders/<id>/payment-hold).
//
// A payment is on hold when the server does not know whether money was taken, or knows it was and a person has to look. The same cart can not be paid again
// while it is (tests/security/cart-after-payment.sec.ts). Most holds end by themselves; the rest end HERE, and what is asserted is:
//   * only an administrator (not staff, not a customer, not a stranger), from this site, with a written reason;
//   * "no charge" is refused if any payment of the order is collected or on its way at Stripe - and ALSO if Stripe can not be asked (409 STRIPE_UNVERIFIABLE): no declaration
//     of the administrator takes the place of the answer (F01, step 4.6, P4-0: the old `acknowledgeUnverified` is a field the route refuses with 400, and an uncertain check
//     takes no decision); it cancels the order, closes the open payment pages and lets the customer pay again;
//   * "accepted" is for money that is collected; it clears the hold and nothing else;
//   * nothing is taken from the request except the decision and the reason: not the state of the order, not what Stripe said;
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
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, reads: [], failNextReads: 0, retrieveFails: false, afterSnapshot: null, lastParams: null, allParams: [], rejectCreate: false })
}
const order = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id }, include: { paymentAttempts: true } })
const sessionIdOf = () => [...fake.sessions.keys()][0]
const REASON = 'Checked in the Stripe dashboard: no payment was made for this order.'

// Everything a REFUSED decision must leave as it was: every column of the order, every column of its payment attempts, the payment pages Stripe was asked to close, and the audit log
// (no recorded decision).
async function snapshot(id: string) {
  const prisma = await db()
  const { paymentAttempts, ...columns } = await order(id)
  return {
    order: JSON.parse(JSON.stringify(columns)) as Record<string, unknown>,
    attempts: JSON.parse(JSON.stringify([...paymentAttempts].sort((a, b) => a.id.localeCompare(b.id)))) as Array<Record<string, unknown>>,
    expireCalls: fake.state.expireCalls,
    decisions: await prisma.adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }),
  }
}
// The payment sync that runs before every decision is independent of it. When Stripe tells it nothing it keeps only the books of its own work - the lease it takes while it reads and the time
// it last looked (N2 of lib/financial-revision.ts) - and the update time of the row. NOTHING ELSE may differ: no status, no financial fact, no revision, no metadata, no attempt.
// (If the sync finds a REAL payment it records it, and that is a change of the order that does not come from the decision: it is not the case proved here.)
const SYNC_BOOKKEEPING = ['updatedAt', 'paymentSyncLeaseId', 'paymentSyncLeaseUntil', 'paymentSyncedAt']
const without = (row: Record<string, unknown>, columns: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key)))
// (`strict`: for a request that is refused before anything runs - no payment sync, so not even its books may differ)
function assertUntouched(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>, what: string, strict = false) {
  const orderIgnored = strict ? [] : SYNC_BOOKKEEPING
  const attemptIgnored = strict ? [] : ['updatedAt']
  assert.deepEqual(without(after.order, orderIgnored), without(before.order, orderIgnored), `${what}: the order changed`)
  assert.equal(after.order.paymentSyncLeaseId, null, `${what}: the sync left its lease on the order`)
  assert.deepEqual(after.attempts.map((attempt) => without(attempt, attemptIgnored)), before.attempts.map((attempt) => without(attempt, attemptIgnored)), `${what}: a payment attempt changed`)
  assert.equal(after.expireCalls, before.expireCalls, `${what}: a payment page was closed at Stripe`)
  assert.equal(after.decisions, before.decisions, `${what}: a decision was recorded in the audit log`)
}

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
  assert.equal((audit[0].metadata as any).stripeCheck, 'confirmed_no_charge', 'the audit keeps what Stripe said: the only results of a "no charge" are the confirmed one (F01)')
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

test('no charge: if Stripe shows the payment as collected when it is asked again, it is recorded as paid and the "no charge" is refused', async () => {
  await reset()
  const id = await confirming()
  fake.pay(sessionIdOf()) // the customer HAD paid: the confirmation never reached us
  const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAYMENT_COLLECTED')
  assert.equal((await order(id)).paymentStatus, 'paid', 'the sync wrote what Stripe said')
})

// ---- F01 (step 4.6, S6, P4-0): when Stripe can not be asked, nothing - no declaration, no flag - takes the place of its answer ------------------------------------
// It used to be possible: with Stripe unreachable, a request carrying `acknowledgeUnverified: true` cancelled the order ("no charge", result `unreachable_acknowledged`) although the customer
// may have paid. These tests are the regression test of that defect. (The payment sync that runs before the decision is independent: if it finds a REAL payment it records it, and the
// decision is then refused as PAYMENT_COLLECTED - see the test above. What is proved here is the case where Stripe answers nothing, or not enough.)
const stripeAnswersAgain = () => { fake.state.failNextReads = 0; fake.state.retrieveFails = false; fake.state.afterSnapshot = null }
// the ways Stripe may fail to answer while the decision is taken (the order has ONE payment page; the payment sync reads it once, the check of the decision reads it again)
const STRIPE_CAN_NOT_BE_ASKED: Array<{ name: string; arrange: () => void }> = [
  { name: 'Stripe answers nothing at all (the payment sync and the check both fail)', arrange: () => { fake.state.failNextReads = 50; fake.state.retrieveFails = true } },
  { name: 'the payment sync can not run, although the check could read the payment page', arrange: () => { fake.state.failNextReads = 1 } },
  {
    name: 'the payment sync ran, but the check can not read the payment page',
    arrange: () => { const base = fake.state.reads.length; fake.state.afterSnapshot = async () => { if (fake.state.reads.length === base + 1) fake.state.failNextReads = 1 } },
  },
]
for (const scenario of STRIPE_CAN_NOT_BE_ASKED) {
  test(`F01 - no charge when ${scenario.name}: 409 STRIPE_UNVERIFIABLE; the order and its attempts are as they were (but for the sync's own books), no page is closed and no decision is recorded`, async () => {
    await reset()
    const id = await confirming()
    const before = await snapshot(id)
    scenario.arrange()
    try {
      for (let ask = 1; ask <= 2; ask++) { // asking again while Stripe still can not answer gives the same answer
        const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
        assert.equal(refused.status, 409, `ask ${ask}: ${refused.text}`)
        assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE', `ask ${ask}`)
        assert.doesNotMatch(refused.text, /acknowledge/i, 'the refusal does not tell anybody to declare anything')
        if (ask === 1) scenario.arrange() // (the failures of the scenario are used up one read at a time)
      }
    } finally {
      stripeAnswersAgain()
    }
    assertUntouched(before, await snapshot(id), scenario.name)
    const row = await order(id)
    assert.equal(row.status, 'awaiting_payment')
    assert.equal(row.paymentStatus, 'processing')
    assert.equal((row.metadata as any).paymentHoldResolution, undefined, 'no resolution is kept')
    assert.equal((row.metadata as any).cancellation, undefined, 'the order is not cancelled')
    assert.equal(fake.state.expireCalls, 0, 'no payment page is closed')
    // nothing was lost: once Stripe answers, the same request is decided on what Stripe says
    const later = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(later.status, 200, later.text)
    assert.equal(later.json.stripeCheck, 'confirmed_no_charge')
    assert.equal((await order(id)).status, 'cancelled')
  })
}

test('F01 - the acknowledgement that used to take the place of the answer of Stripe is gone: a request that carries it is refused with 400, whether Stripe answers or not, and nothing changes', async () => {
  for (const stripeDown of [true, false]) {
    await reset()
    const id = await confirming()
    const before = await snapshot(id)
    const stripeCallsBefore = { reads: fake.state.reads.length, retrieves: fake.state.retrieveCalls }
    if (stripeDown) STRIPE_CAN_NOT_BE_ASKED[0].arrange()
    try {
      for (const outcome of ['no_charge', 'accepted'] as const) {
        for (const value of [true, false, 'true', 1, null]) {
          const r = await resolve(id, { outcome, reason: REASON, acknowledgeUnverified: value }, admin)
          const what = `${stripeDown ? 'Stripe unreachable' : 'Stripe reachable'} / ${outcome} / acknowledgeUnverified: ${JSON.stringify(value)}`
          assert.equal(r.status, 400, `${what}: ${r.text}`)
          assert.equal(r.json.code, 'INVALID_REQUEST', what)
        }
      }
    } finally {
      stripeAnswersAgain()
    }
    assertUntouched(before, await snapshot(id), stripeDown ? 'Stripe unreachable' : 'Stripe reachable', true)
    assert.deepEqual({ reads: fake.state.reads.length, retrieves: fake.state.retrieveCalls }, stripeCallsBefore, 'the request is refused before Stripe is asked anything')
    assert.equal((await order(id)).status, 'awaiting_payment', 'the order is not cancelled')
  }
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
  assert.equal(r.json.stripeCheck, 'payment_collected', 'the result of "accepted" is the collected payment (nothing else is ever recorded: F01)')
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
