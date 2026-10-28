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
import { strongTestKey } from './_keys'
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
const newKey = () => strongTestKey(`hold-${++keySeq}`)
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

// ---- F02 (step 4.6, S6, P3b-1): an attempt with no Stripe identifier is NOT evidence that nothing was charged -------------------------------------------------------------
// It used to be skipped: the check of "no charge" asked Stripe about the attempts that had a session id or a payment intent id, said nothing about the others, and - if nothing it
// had asked showed money - answered "no money" and recorded `confirmed_no_charge`, a confirmation nobody had asked Stripe for. Now an attempt that cannot be asked about makes the
// decision UNVERIFIABLE (409 STRIPE_UNVERIFIABLE, nothing decided, nothing written), unless another attempt shows money (then it is CHARGE_EXISTS, as before). There is no exception: not
// for an expired reservation, not for a failure with a reason, not for an attempt that expired long ago.
// And the decision is protected from a change of the SET of attempts while Stripe is being read: the attempts that were examined are kept as an immutable copy, and under the lock of the
// order they are compared - ids, Stripe identifiers, status; not the number of rows - with the attempts found there. What was read is then used only if it still covers them. This does
// NOT stop anything that happens at Stripe: the lock is ours (see docs/VERIFICA-4.6.md, S6a.23).
// Deterministic: the changes of the attempts are made by the hook of the fake Stripe (`afterSnapshot`) while the decision reads its evidence, never by a delay.
const addAttempt = async (orderId: string, over: Record<string, unknown> = {}) => {
  const prisma = await db()
  const row = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, select: { totalCents: true, currency: true } })
  return prisma.paymentAttempt.create({ data: { orderId, amountCents: row.totalCents, currency: row.currency, status: 'creating', expiresAt: new Date(Date.now() + 600_000), ...over } as any })
}
// a payment page that exists at (fake) Stripe and shows no money - for an attempt that CAN be asked about
const registerQuietSession = (id: string) => { fake.sessions.set(id, { id, object: 'checkout.session', status: 'expired', payment_status: 'unpaid', payment_intent: null }); return id }
const attemptsOf = async (orderId: string) => (await order(orderId)).paymentAttempts
// the way to change something while the decision reads its evidence: the payment sync of the decision reads first (read 1), the check reads next (read 2) and the change is made right
// after that read, before the answer comes back - so before the transaction of the decision is opened
function duringTheEvidenceRead(change: () => Promise<void>) {
  const base = fake.state.reads.length
  let done = false
  fake.state.afterSnapshot = async () => {
    if (done || fake.state.reads.length < base + 2) return
    done = true
    await change()
  }
  return () => done
}
// What a REFUSED decision must leave as it was when the attempts are themselves what the test changes: the order (but for the sync's own books), the pages closed at Stripe, the audit
// log, no resolution kept, no cancellation, no attempt closed by the decision ("admin_released").
async function assertDecisionWroteNothing(orderId: string, before: Awaited<ReturnType<typeof snapshot>>, what: string) {
  const after = await snapshot(orderId)
  assert.deepEqual(without(after.order, SYNC_BOOKKEEPING), without(before.order, SYNC_BOOKKEEPING), `${what}: the order changed`)
  assert.equal(after.order.paymentSyncLeaseId, null, `${what}: the sync left its lease on the order`)
  assert.equal(after.expireCalls, before.expireCalls, `${what}: a payment page was closed at Stripe`)
  assert.equal(after.decisions, before.decisions, `${what}: a decision was recorded in the audit log`)
  assert.ok(after.attempts.every((attempt) => attempt.failureReason !== 'admin_released'), `${what}: a payment attempt was closed by the decision`)
  const row = await order(orderId)
  assert.equal((row.metadata as any).paymentHoldResolution, undefined, `${what}: a resolution was kept`)
  assert.equal((row.metadata as any).cancellation, undefined, `${what}: the order was cancelled`)
  assert.equal(row.status, before.order.status, `${what}: the status moved`)
  assert.equal(row.paymentStatus, before.order.paymentStatus, `${what}: the payment status moved`)
}

const ATTEMPTS_WITHOUT_IDENTIFIER: Array<{ name: string; over: Record<string, unknown> }> = [
  { name: 'a reservation no answer of Stripe completed (creating)', over: { status: 'creating' } },
  { name: 'a stale reservation (expired / stale_reservation)', over: { status: 'expired', failureReason: 'stale_reservation' } },
  { name: 'a page Stripe refused to create (failed, a provider error that is not retried)', over: { status: 'failed', failureReason: 'StripeInvalidRequestError:parameter_invalid_integer' } },
  { name: 'a page whose session did not match the order (failed / session_mismatch)', over: { status: 'failed', failureReason: 'session_mismatch:amount' } },
  { name: 'an open attempt that lost its session (failed / open_without_session)', over: { status: 'failed', failureReason: 'open_without_session' } },
  { name: 'an attempt that expired a day ago', over: { status: 'expired', expiresAt: new Date(Date.now() - 86_400_000) } },
]
for (const scenario of ATTEMPTS_WITHOUT_IDENTIFIER) {
  test(`H1-H4 F02 - no charge when the only payment attempt is ${scenario.name} and has no Stripe identifier: it is NOT "no money" - 409 STRIPE_UNVERIFIABLE, nothing asked, nothing decided`, async () => {
    await reset()
    const id = await confirming()
    const prisma = await db()
    await prisma.paymentAttempt.updateMany({ where: { orderId: id }, data: { stripeSessionId: null, stripePaymentIntentId: null, ...scenario.over } as any })
    const before = await snapshot(id)
    const reads = fake.state.reads.length
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
    assert.match(refused.json.error, /no Stripe identifier/, 'the refusal says why: an attempt nothing can be asked about')
    assert.doesNotMatch(refused.text, /acknowledge/i, 'the refusal does not tell anybody to declare anything')
    assert.equal(fake.state.reads.length, reads, 'there was nothing to ask Stripe about: no call')
    assertUntouched(before, await snapshot(id), scenario.name)
    await assertDecisionWroteNothing(id, before, scenario.name)
    assert.equal(fake.state.expireCalls, 0)
  })
}

test('H5 F02 - no charge when one payment attempt shows no money and another has no Stripe identifier: 409 STRIPE_UNVERIFIABLE (what was asked says nothing about what cannot be asked)', async () => {
  await reset()
  const id = await confirming()
  await addAttempt(id, { status: 'creating' })
  const before = await snapshot(id)
  const reads = fake.state.reads.length
  const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  assert.match(refused.json.error, /no Stripe identifier/)
  assert.equal(fake.state.reads.length, reads + 2, 'the attempt that can be asked about was asked twice (the sync of the decision, the check) - nothing more, nothing under the lock')
  assertUntouched(before, await snapshot(id), 'one asked, one not')
  await assertDecisionWroteNothing(id, before, 'one asked, one not')
})

test('H6 C5 F02 - money on one attempt and no identifier on another: the answer stays CHARGE_EXISTS (the money is the news), not a generic refusal', async () => {
  await reset()
  const id = await mismatched()
  await addAttempt(id, { status: 'creating' })
  const before = await order(id)
  const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'CHARGE_EXISTS')
  assert.match(refused.json.error, /collected or on its way at Stripe/, 'the message is the one of the money, not the generic one')
  assert.doesNotMatch(refused.json.error, /no Stripe identifier/, 'the attempt without an identifier does not take the place of the news')
  // (the sync that precedes the decision finds a REAL payment and records it again: that is its own book-keeping, not the decision - as in the test of the wrong amount above)
  const after = await order(id)
  assert.equal(after.status, before.status)
  assert.equal(after.paymentReviewReason, before.paymentReviewReason)
  assert.equal((after.metadata as any).paymentHoldResolution, undefined)
  assert.equal((after.metadata as any).cancellation, undefined)
  assert.equal(fake.state.expireCalls, 0)
  assert.equal(await (await db()).adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }), 0)
})

test('H7 C4 F02 - every attempt can be asked about and none shows money: "no charge" works as before (200, confirmed_no_charge), and the closed attempt is left as it was', async () => {
  await reset()
  const id = await confirming()
  const quiet = registerQuietSession('cs_test_FAKE_H7')
  await addAttempt(id, { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: quiet })
  const reads = fake.state.reads.length
  const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.stripeCheck, 'confirmed_no_charge')
  assert.equal(fake.state.reads.length, reads + 3, 'the sync of the decision reads the open page once; the check reads the two pages: three reads, as before')
  const row = await order(id)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.paymentStatus, 'canceled')
  const closed = row.paymentAttempts.find((attempt) => attempt.stripeSessionId === quiet)!
  assert.equal(closed.status, 'expired')
  assert.equal(closed.failureReason, 'stale_reservation')
  assert.equal(fake.state.expireCalls, 1)
})

test('H8 C6 accepted is not touched by P3b-1: with an attempt that has no Stripe identifier the money that is collected is still accepted (200, payment_collected)', async () => {
  await reset()
  const first = await startPayment(customer)
  fake.pay(sessionIdOf())
  await syncPayment({ kind: 'checkout_session', id: sessionIdOf(), hint: { orderId: first.json.orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentReviewReason: 'duplicate_payment', status: 'awaiting_review' } })
  await addAttempt(first.json.orderId, { status: 'creating' })
  const r = await resolve(first.json.orderId, { outcome: 'accepted', reason: 'The duplicate was refunded; the order stands.' }, admin)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.stripeCheck, 'payment_collected')
  assert.equal((await order(first.json.orderId)).paymentReviewReason, null)
})

test('C6b F03 stays OPEN (known limit, pinned): "accepted" still rests on the database alone - a hold for a dispute is cleared by it and the result is still labelled payment_collected. P3b-1 does not change that; a package that does will change this test on purpose', async () => {
  await reset()
  const first = await startPayment(customer)
  fake.pay(sessionIdOf())
  await syncPayment({ kind: 'checkout_session', id: sessionIdOf(), hint: { orderId: first.json.orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentReviewReason: 'dispute' } })
  const reads = fake.state.reads.length
  const r = await resolve(first.json.orderId, { outcome: 'accepted', reason: 'The dispute was dealt with elsewhere.' }, admin)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.stripeCheck, 'payment_collected')
  assert.equal(fake.state.reads.length, reads, 'nothing was read from Stripe for "accepted" at the time of the decision')
  assert.equal((await order(first.json.orderId)).paymentReviewReason, null)
})

test('H9 F02 - an attempt that can be asked about while Stripe answers nothing, next to an attempt with no identifier: still 409 STRIPE_UNVERIFIABLE, nothing decided', async () => {
  await reset()
  const id = await confirming()
  await addAttempt(id, { status: 'creating' })
  const before = await snapshot(id)
  fake.state.failNextReads = 50
  fake.state.retrieveFails = true
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  } finally {
    stripeAnswersAgain()
  }
  assertUntouched(before, await snapshot(id), 'Stripe unreachable and an attempt without identifier')
})

test('H10 F02 - two simultaneous decisions on an order with an attempt that has no identifier: both are refused, neither decides anything', async () => {
  await reset()
  const id = await confirming()
  await addAttempt(id, { status: 'creating' })
  const before = await snapshot(id)
  const [a, b] = await Promise.all([
    resolve(id, { outcome: 'no_charge', reason: REASON }, admin),
    resolve(id, { outcome: 'no_charge', reason: REASON }, admin),
  ])
  assert.deepEqual([a.status, b.status], [409, 409], `${a.text} ${b.text}`)
  assert.deepEqual([a.json.code, b.json.code], ['STRIPE_UNVERIFIABLE', 'STRIPE_UNVERIFIABLE'])
  await assertDecisionWroteNothing(id, before, 'two simultaneous decisions, one attempt without identifier')
})

test('H11 F02 - nothing is lost by the refusal: once the attempt has its identifier, the same request is decided on what Stripe says', async () => {
  await reset()
  const id = await confirming()
  const prisma = await db()
  const [only] = await attemptsOf(id)
  await prisma.paymentAttempt.update({ where: { id: only.id }, data: { stripeSessionId: null } })
  const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  await prisma.paymentAttempt.update({ where: { id: only.id }, data: { stripeSessionId: only.stripeSessionId } })
  const later = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
  assert.equal(later.status, 200, later.text)
  assert.equal(later.json.stripeCheck, 'confirmed_no_charge')
  assert.equal((await order(id)).status, 'cancelled')
})

// ---- the set of attempts that was examined must still be the set of the order when the decision is taken (the correction of the independent audit) -----------------------------
test('C1 F02 - an attempt WITHOUT identifiers appears while the evidence is being read: what was read no longer covers the order - "no charge" is refused under the lock, nothing is written, no Stripe call is made after the read', async () => {
  await reset()
  const id = await confirming()
  const before = await snapshot(id)
  const [original] = await attemptsOf(id)
  const fired = duringTheEvidenceRead(async () => { await addAttempt(id, { status: 'creating' }) })
  const reads = fake.state.reads.length
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
    assert.match(refused.json.error, /changed while Stripe was being asked/)
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired(), 'the attempt really appeared during the read')
  assert.equal(fake.state.reads.length, reads + 2, 'two reads (the sync, the check) and none under the lock or after it')
  await assertDecisionWroteNothing(id, before, 'C1')
  const now = await attemptsOf(id)
  assert.equal(now.length, 2)
  assert.equal(now.find((attempt) => attempt.id === original.id)!.status, 'processing', 'the attempt that was examined was not closed')
  assert.equal(await (await db()).adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }), 0)
})

test('C1b F02 - the attempt that was examined disappears while the evidence is being read: refused under the lock, the order is not cancelled', async () => {
  await reset()
  const id = await confirming()
  const before = await snapshot(id)
  const [original] = await attemptsOf(id)
  const prisma = await db()
  const fired = duringTheEvidenceRead(async () => { await prisma.paymentAttempt.delete({ where: { id: original.id } }) })
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired())
  await assertDecisionWroteNothing(id, before, 'C1b')
  assert.equal((await attemptsOf(id)).length, 0)
})

test('C2 F02 - the Stripe session id of the attempt changes between the read and the commit: the evidence of the OLD identifier is not used - refused under the lock', async () => {
  await reset()
  const id = await confirming()
  const before = await snapshot(id)
  const [original] = await attemptsOf(id)
  const replacement = registerQuietSession('cs_test_FAKE_C2')
  const prisma = await db()
  const fired = duringTheEvidenceRead(async () => { await prisma.paymentAttempt.update({ where: { id: original.id }, data: { stripeSessionId: replacement } }) })
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired())
  await assertDecisionWroteNothing(id, before, 'C2 session id')
  assert.equal((await attemptsOf(id))[0].stripeSessionId, replacement, 'the change made during the read is still there: it was refused, not undone')
})

test('C2b F02 - a payment intent id appears on the attempt between the read and the commit: refused under the lock', async () => {
  await reset()
  const id = await confirming()
  const before = await snapshot(id)
  const [original] = await attemptsOf(id)
  const prisma = await db()
  const fired = duringTheEvidenceRead(async () => { await prisma.paymentAttempt.update({ where: { id: original.id }, data: { stripePaymentIntentId: 'pi_test_FAKE_C2b' } }) })
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired())
  await assertDecisionWroteNothing(id, before, 'C2b payment intent id')
})

test('C3 F02 - the SAME NUMBER of attempts but not the same attempts (one is replaced by another): the count of rows proves nothing - refused under the lock', async () => {
  await reset()
  const id = await confirming()
  const first = registerQuietSession('cs_test_FAKE_C3a')
  const second = registerQuietSession('cs_test_FAKE_C3b')
  const replaced = await addAttempt(id, { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: first })
  const before = await snapshot(id)
  const prisma = await db()
  const fired = duringTheEvidenceRead(async () => {
    await prisma.paymentAttempt.delete({ where: { id: replaced.id } })
    await addAttempt(id, { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: second })
  })
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired())
  assert.equal((await attemptsOf(id)).length, 2, 'the count is the same')
  await assertDecisionWroteNothing(id, before, 'C3 same count, other attempts')
})

test('C3b F02 - the status of an attempt that was examined changes between the read and the commit (it started to be confirmed): refused under the lock', async () => {
  await reset()
  const id = await confirming()
  const before = await snapshot(id)
  const [original] = await attemptsOf(id)
  const prisma = await db()
  const fired = duringTheEvidenceRead(async () => { await prisma.paymentAttempt.update({ where: { id: original.id }, data: { status: 'mismatch' } }) })
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired())
  await assertDecisionWroteNothing(id, before, 'C3b status')
  assert.equal((await attemptsOf(id))[0].status, 'mismatch')
})

test('C4 the normal path is unchanged: while the evidence is read, columns that are not part of the examination change (a note, an expiry) and the set of attempts stays the same - "no charge" is decided (200)', async () => {
  await reset()
  const id = await confirming()
  const [original] = await attemptsOf(id)
  const prisma = await db()
  const fired = duringTheEvidenceRead(async () => {
    await prisma.paymentAttempt.update({ where: { id: original.id }, data: { expiresAt: new Date(Date.now() + 1_200_000), failureReason: 'noted' } })
  })
  const reads = fake.state.reads.length
  try {
    const r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.stripeCheck, 'confirmed_no_charge')
  } finally {
    stripeAnswersAgain()
  }
  assert.ok(fired())
  assert.equal(fake.state.reads.length, reads + 2)
  assert.equal((await order(id)).status, 'cancelled')
})

// A writer that does NOT take the lock of the order: the save of a session id and the closing of an attempt (lib/checkout-sessions.ts) only touch the row of the attempt. Whatever the speed of
// the machine, it takes the row of the attempt DURING the read of the evidence and keeps it until the test lets it go, so the transaction of the decision starts AFTER the writer holds it.
function holdAttemptDuringTheRead(prisma: Awaited<ReturnType<typeof db>>, attemptId: string, change: Record<string, unknown>) {
  let release!: () => void
  const released = new Promise<void>((resolveRelease) => { release = resolveRelease })
  let held!: () => void
  const holding = new Promise<void>((resolveHeld) => { held = resolveHeld })
  const holder: { writer: Promise<unknown> | null } = { writer: null }
  const fired = duringTheEvidenceRead(async () => {
    holder.writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attemptId} FOR UPDATE`
      held()
      await released
      await tx.paymentAttempt.update({ where: { id: attemptId }, data: change })
    }, { maxWait: 10_000, timeout: 60_000 })
    await holding
  })
  return { release, fired, holder }
}
// wait - by polling a CONDITION, never by a fixed delay - until a transaction is blocked on a lock in this database
async function untilSomeoneWaitsForALock(prisma: Awaited<ReturnType<typeof db>>, isSettled: () => boolean) {
  let blocked = 0
  const deadline = Date.now() + 30_000
  while (!isSettled() && blocked === 0 && Date.now() < deadline) {
    blocked = (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]?.n ?? 0
    if (blocked === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return blocked
}

for (const which of ['the attempt that was asked about first (the newest)', 'the other attempt (the older one)'] as const) {
  test(`C7 F02 - a writer that does NOT take the lock of the order holds ${which}: it can not slip a change in between the re-read and the commit - the decision waits for the attempts of the order, then sees the change and refuses`, async () => {
    await reset()
    const id = await confirming()
    const prisma = await db()
    const [newest] = await attemptsOf(id)
    const older = await addAttempt(id, { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: registerQuietSession('cs_test_FAKE_C7'), createdAt: new Date(Date.now() - 600_000) })
    const before = await snapshot(id)
    const target = which.startsWith('the attempt that was asked about first') ? newest : older
    const writer = holdAttemptDuringTheRead(prisma, target.id, { status: target.id === newest.id ? 'mismatch' : 'failed' })
    let settled = false
    const decision = resolve(id, { outcome: 'no_charge', reason: REASON }, admin).finally(() => { settled = true })
    const blocked = await untilSomeoneWaitsForALock(prisma, () => settled)
    writer.release()
    await writer.holder.writer
    const refused = await decision
    stripeAnswersAgain()
    assert.ok(writer.fired(), 'the writer took the attempt during the read')
    assert.ok(blocked > 0, 'the decision waited for the attempts of the order instead of reading them while a writer held them')
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
    assert.match(refused.json.error, /changed while Stripe was being asked/)
    await assertDecisionWroteNothing(id, before, 'C7')
    assert.equal((await attemptsOf(id)).find((attempt) => attempt.id === target.id)!.status, target.id === newest.id ? 'mismatch' : 'failed', 'the writer\'s change is there: the decision was refused, the change was not undone')
  })
}

test('C7b "accepted" is not touched: it takes no lock on the attempts, so a writer that holds an attempt does not make it wait', async () => {
  await reset()
  const first = await startPayment(customer)
  fake.pay(sessionIdOf())
  await syncPayment({ kind: 'checkout_session', id: sessionIdOf(), hint: { orderId: first.json.orderId } }, { eventType: 'test.paid', effects: 'none' as any })
  const prisma = await db()
  await prisma.printOrder.update({ where: { id: first.json.orderId }, data: { paymentReviewReason: 'duplicate_payment', status: 'awaiting_review' } })
  const [only] = await attemptsOf(first.json.orderId)
  let release!: () => void
  const released = new Promise<void>((resolveRelease) => { release = resolveRelease })
  let held!: () => void
  const holding = new Promise<void>((resolveHeld) => { held = resolveHeld })
  const writer = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${only.id} FOR UPDATE`
    held()
    await released
  }, { maxWait: 10_000, timeout: 60_000 })
  await holding
  let settled = false
  const decision = resolve(first.json.orderId, { outcome: 'accepted', reason: 'The duplicate was refunded; the order stands.' }, admin).finally(() => { settled = true })
  const deadline = Date.now() + 20_000
  while (!settled && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  const settledWhileHeld = settled
  release()
  await writer
  const r = await decision
  assert.ok(settledWhileHeld, '"accepted" finished while a writer still held the attempt: it did not wait for it')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.stripeCheck, 'payment_collected')
})

test('C8 the lock order is the one of every other writer - the order first, then its attempts - so a writer that follows it never deadlocks with the decision', async () => {
  await reset()
  const id = await confirming()
  const before = await snapshot(id)
  const [original] = await attemptsOf(id)
  const prisma = await db()
  let release!: () => void
  const released = new Promise<void>((resolveRelease) => { release = resolveRelease })
  let held!: () => void
  const holding = new Promise<void>((resolveHeld) => { held = resolveHeld })
  const holder: { writer: Promise<unknown> | null } = { writer: null }
  // during the read a writer takes the lock of the ORDER and keeps it; when it is let go it takes the attempts of the order (in that order, as the application's writers do) and changes one
  const fired = duringTheEvidenceRead(async () => {
    holder.writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${id} FOR UPDATE`
      held()
      await released
      await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "orderId" = ${id} FOR UPDATE`
      await tx.paymentAttempt.update({ where: { id: original.id }, data: { status: 'mismatch' } })
    }, { maxWait: 10_000, timeout: 60_000 })
    await holding
  })
  let settled = false
  const decision = resolve(id, { outcome: 'no_charge', reason: REASON }, admin).finally(() => { settled = true })
  const blocked = await untilSomeoneWaitsForALock(prisma, () => settled)
  release()
  const written = await (holder.writer as Promise<unknown>).then(() => 'committed', (error: unknown) => `failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`)
  const refused = await decision
  stripeAnswersAgain()
  assert.ok(fired())
  assert.ok(blocked > 0, 'the decision waited for the lock of the order')
  assert.equal(written, 'committed', 'the writer that follows the lock order was not made the victim of a deadlock')
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
  assert.match(refused.json.error, /changed while Stripe was being asked/)
  await assertDecisionWroteNothing(id, before, 'C8')
})

// ---- the checks that were there before the package stay, under the lock, whatever the attempts do ----------------------------------------------------------------------------------
// (what changes while the evidence is read is what a recorded payment or a requested refund really do, and the check on the attempts must not take the place of the older ones)
for (const attemptChanges of [true, false]) {
  test(`C9 the payment is collected while the evidence is being read ${attemptChanges ? '(the attempt that was being confirmed is closed too, as the recording of a payment does)' : '(only the order changes)'}: PAYMENT_COLLECTED, not a generic refusal - and the order is NEVER cancelled`, async () => {
    await reset()
    const id = await confirming()
    const prisma = await db()
    const [original] = await attemptsOf(id)
    const before = await snapshot(id)
    const fired = duringTheEvidenceRead(async () => {
      await prisma.printOrder.update({ where: { id }, data: { paymentStatus: 'paid', paymentReviewReason: 'duplicate_payment' } })
      if (attemptChanges) await prisma.paymentAttempt.update({ where: { id: original.id }, data: { status: 'mismatch' } })
    })
    try {
      const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
      assert.equal(refused.status, 409, refused.text)
      assert.equal(refused.json.code, 'PAYMENT_COLLECTED')
      assert.match(refused.json.error, /collected while this was being decided/)
    } finally {
      stripeAnswersAgain()
    }
    assert.ok(fired())
    const row = await order(id)
    assert.equal(row.status, before.order.status, 'the order is not cancelled')
    assert.equal(row.paymentStatus, 'paid', 'what the payment wrote is there')
    assert.equal((row.metadata as any).paymentHoldResolution, undefined)
    assert.equal((row.metadata as any).cancellation, undefined)
    assert.ok(row.paymentAttempts.every((attempt) => attempt.failureReason !== 'admin_released'), 'no attempt was closed by the decision')
    assert.equal(fake.state.expireCalls, 0)
    assert.equal(await prisma.adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }), 0)
  })
}

test('C10 a refund is requested by the application while the evidence is being read: REFUND_IN_PROGRESS under the lock - the older check stays, and the order is not cancelled', async () => {
  await reset()
  const id = await confirming()
  const prisma = await db()
  const before = await snapshot(id)
  const fired = duringTheEvidenceRead(async () => {
    await prisma.refundOperation.create({ data: { id: `rop-c10-${Date.now()}`, orderId: id, paymentIntentId: 'pi_test_FAKE_C10', amountCents: 500, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate', note: 'requested by the test', status: 'requested' } })
  })
  try {
    const refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'REFUND_IN_PROGRESS')
    assert.ok(fired())
    await assertDecisionWroteNothing(id, before, 'C10')
  } finally {
    stripeAnswersAgain()
    await prisma.refundOperation.deleteMany({ where: { orderId: id } })
  }
})

// ---- the reads of the check are the ones it has always made (the package moved them into a function of their own; this pins what they ask, in what order, with which options) ------
// Stripe is SCRIPTED here: the sessions and payment intents of the table are not in the fake. Every attempt is closed (expired), so the payment sync that precedes the decision has nothing to read
// and every call recorded below is a call of the check. The attempts are listed newest first: the order in which the check reads them.
type Scripted = 'fail' | Record<string, unknown>
function recordStripeReads(script?: { sessions?: Record<string, Scripted>; intents?: Record<string, Scripted> }) {
  const stripe: any = fake.stripe
  const original = { session: stripe.checkout.sessions.retrieve, intent: stripe.paymentIntents.retrieve }
  const calls: string[] = []
  const ids: string[] = []
  stripe.checkout.sessions.retrieve = async (id: string, params?: any, options?: any) => {
    calls.push(`session:${String(id)}${params?.expand ? `[expand=${params.expand.join(',')}]` : ''}[timeout=${options?.timeout}]`)
    ids.push(String(id))
    if (!script) return original.session(id, params, options)
    const answer = script.sessions?.[id]
    if (answer === undefined || answer === 'fail') throw new Error('Stripe could not be reached (scripted)')
    return JSON.parse(JSON.stringify(answer))
  }
  stripe.paymentIntents.retrieve = async (id: string, params?: any, options?: any) => {
    calls.push(`intent:${String(id)}${params?.expand ? `[expand=${params.expand.join(',')}]` : ''}[timeout=${options?.timeout}]`)
    ids.push(String(id))
    if (!script) return original.intent(id, params, options)
    const answer = script.intents?.[id]
    if (answer === undefined || answer === 'fail') throw new Error('Stripe could not be reached (scripted)')
    return JSON.parse(JSON.stringify(answer))
  }
  return { calls, ids, restore: () => { stripe.checkout.sessions.retrieve = original.session; stripe.paymentIntents.retrieve = original.intent } }
}
type ReadCase = { name: string; attempts: Array<{ session?: string; intent?: string }>; sessions?: Record<string, Scripted>; intents?: Record<string, Scripted>; expect: { status: 200 | 409; code?: string; calls: string[] } }
const S = (id: string) => `session:${id}[expand=payment_intent][timeout=8000]`
const P = (id: string) => `intent:${id}[timeout=8000]`
const unpaid = (paymentIntent: unknown = null, over: Record<string, unknown> = {}) => ({ object: 'checkout.session', status: 'open', payment_status: 'unpaid', payment_intent: paymentIntent, ...over })
const MONEY = { status: 409, code: 'CHARGE_EXISTS' } as const
const NO_MONEY = { status: 200 } as const
const CAN_NOT_BE_ASKED = { status: 409, code: 'STRIPE_UNVERIFIABLE' } as const
const READ_CASES: ReadCase[] = [
  { name: 'R1 a session that is paid is money', attempts: [{ session: 'cs_test_R1' }], sessions: { cs_test_R1: unpaid(null, { payment_status: 'paid' }) }, expect: { ...MONEY, calls: [S('cs_test_R1')] } },
  { name: 'R2 a payment intent that is processing (expanded in the session) is money', attempts: [{ session: 'cs_test_R2' }], sessions: { cs_test_R2: unpaid({ id: 'pi_test_R2', status: 'processing' }) }, expect: { ...MONEY, calls: [S('cs_test_R2')] } },
  { name: 'R3 a payment intent that requires capture (expanded) is money', attempts: [{ session: 'cs_test_R3' }], sessions: { cs_test_R3: unpaid({ id: 'pi_test_R3', status: 'requires_capture' }) }, expect: { ...MONEY, calls: [S('cs_test_R3')] } },
  { name: 'R4 a payment intent that succeeded (expanded) is money even if the session says unpaid', attempts: [{ session: 'cs_test_R4' }], sessions: { cs_test_R4: unpaid({ id: 'pi_test_R4', status: 'succeeded' }) }, expect: { ...MONEY, calls: [S('cs_test_R4')] } },
  { name: 'R5 a payment intent that is canceled (expanded) is no money', attempts: [{ session: 'cs_test_R5' }], sessions: { cs_test_R5: unpaid({ id: 'pi_test_R5', status: 'canceled' }) }, expect: { ...NO_MONEY, calls: [S('cs_test_R5')] } },
  { name: 'R6 a payment intent that is only an id in the session is read directly: succeeded is money', attempts: [{ session: 'cs_test_R6' }], sessions: { cs_test_R6: unpaid('pi_test_R6') }, intents: { pi_test_R6: { status: 'succeeded' } }, expect: { ...MONEY, calls: [S('cs_test_R6'), P('pi_test_R6')] } },
  { name: 'R7 ... processing is money', attempts: [{ session: 'cs_test_R7' }], sessions: { cs_test_R7: unpaid('pi_test_R7') }, intents: { pi_test_R7: { status: 'processing' } }, expect: { ...MONEY, calls: [S('cs_test_R7'), P('pi_test_R7')] } },
  { name: 'R8 ... requires_capture is money', attempts: [{ session: 'cs_test_R8' }], sessions: { cs_test_R8: unpaid('pi_test_R8') }, intents: { pi_test_R8: { status: 'requires_capture' } }, expect: { ...MONEY, calls: [S('cs_test_R8'), P('pi_test_R8')] } },
  { name: 'R9 ... requires_payment_method is no money', attempts: [{ session: 'cs_test_R9' }], sessions: { cs_test_R9: unpaid('pi_test_R9') }, intents: { pi_test_R9: { status: 'requires_payment_method' } }, expect: { ...NO_MONEY, calls: [S('cs_test_R9'), P('pi_test_R9')] } },
  { name: 'R10 an attempt with only a payment intent id: requires_capture is money', attempts: [{ intent: 'pi_test_R10' }], intents: { pi_test_R10: { status: 'requires_capture' } }, expect: { ...MONEY, calls: [P('pi_test_R10')] } },
  { name: 'R11 an attempt with only a payment intent id: succeeded is money', attempts: [{ intent: 'pi_test_R11' }], intents: { pi_test_R11: { status: 'succeeded' } }, expect: { ...MONEY, calls: [P('pi_test_R11')] } },
  { name: 'R12 an attempt with only a payment intent id: processing is money', attempts: [{ intent: 'pi_test_R12' }], intents: { pi_test_R12: { status: 'processing' } }, expect: { ...MONEY, calls: [P('pi_test_R12')] } },
  { name: 'R13 an attempt with only a payment intent id: canceled is no money', attempts: [{ intent: 'pi_test_R13' }], intents: { pi_test_R13: { status: 'canceled' } }, expect: { ...NO_MONEY, calls: [P('pi_test_R13')] } },
  { name: 'R14 an attempt with BOTH ids is read through its session only', attempts: [{ session: 'cs_test_R14', intent: 'pi_test_R14' }], sessions: { cs_test_R14: unpaid() }, intents: { pi_test_R14: { status: 'succeeded' } }, expect: { ...NO_MONEY, calls: [S('cs_test_R14')] } },
  { name: 'R15 a session that can not be read is "can not be asked", with the message of Stripe (not the one of a missing identifier)', attempts: [{ session: 'cs_test_R15' }], sessions: { cs_test_R15: 'fail' }, expect: { ...CAN_NOT_BE_ASKED, calls: [S('cs_test_R15')] } },
  { name: 'R16 a payment intent that can not be read after its session was is "can not be asked"', attempts: [{ session: 'cs_test_R16' }], sessions: { cs_test_R16: unpaid('pi_test_R16') }, intents: { pi_test_R16: 'fail' }, expect: { ...CAN_NOT_BE_ASKED, calls: [S('cs_test_R16'), P('pi_test_R16')] } },
  { name: 'R17 a read that fails does not stop the others: money found on the next attempt is CHARGE_EXISTS', attempts: [{ session: 'cs_test_R17a' }, { session: 'cs_test_R17b' }], sessions: { cs_test_R17a: 'fail', cs_test_R17b: unpaid(null, { payment_status: 'paid' }) }, expect: { ...MONEY, calls: [S('cs_test_R17a'), S('cs_test_R17b')] } },
  { name: 'R18 the reading stops at the first money: the other attempts are not asked about', attempts: [{ session: 'cs_test_R18a' }, { session: 'cs_test_R18b' }, { intent: 'pi_test_R18c' }], sessions: { cs_test_R18a: unpaid(null, { payment_status: 'paid' }), cs_test_R18b: unpaid() }, intents: { pi_test_R18c: { status: 'succeeded' } }, expect: { ...MONEY, calls: [S('cs_test_R18a')] } },
  { name: 'R19 no money anywhere: every attempt is read once, in order, and "no charge" is decided', attempts: [{ session: 'cs_test_R19a' }, { intent: 'pi_test_R19b' }, { session: 'cs_test_R19c', intent: 'pi_test_R19c' }], sessions: { cs_test_R19a: unpaid(), cs_test_R19c: unpaid() }, intents: { pi_test_R19b: { status: 'canceled' } }, expect: { ...NO_MONEY, calls: [S('cs_test_R19a'), P('pi_test_R19b'), S('cs_test_R19c')] } },
]
for (const readCase of READ_CASES) {
  test(`${readCase.name}: the reads of the check are the ones it always made`, async () => {
    await reset()
    const id = await confirming()
    const prisma = await db()
    const [first] = await attemptsOf(id)
    const base = Date.now()
    await prisma.paymentAttempt.update({ where: { id: first.id }, data: { stripeSessionId: readCase.attempts[0].session ?? null, stripePaymentIntentId: readCase.attempts[0].intent ?? null, status: 'expired', createdAt: new Date(base) } })
    for (let index = 1; index < readCase.attempts.length; index++) {
      await addAttempt(id, { status: 'expired', stripeSessionId: readCase.attempts[index].session ?? null, stripePaymentIntentId: readCase.attempts[index].intent ?? null, createdAt: new Date(base - index * 1000) })
    }
    const recorder = recordStripeReads({ sessions: readCase.sessions, intents: readCase.intents })
    let r: Awaited<ReturnType<typeof resolve>>
    try {
      r = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    } finally {
      recorder.restore()
    }
    assert.equal(r.status, readCase.expect.status, r.text)
    if (readCase.expect.code) assert.equal(r.json.code, readCase.expect.code)
    else assert.equal(r.json.stripeCheck, 'confirmed_no_charge')
    assert.deepEqual(recorder.calls, readCase.expect.calls, 'exactly the reads the check has always made, in the order of the attempts, with the same options')
    if (readCase.expect.code === 'STRIPE_UNVERIFIABLE') {
      assert.match(r.json.error, /could not be asked/, 'the refusal says that Stripe could not be asked')
      assert.doesNotMatch(r.json.error, /no Stripe identifier/, 'and not that an identifier is missing')
    }
    if (readCase.expect.code === 'CHARGE_EXISTS') assert.match(r.json.error, /collected or on its way at Stripe/)
    assert.equal(fake.state.expireCalls, 0)
  })
}

// ---- an identifier that is not shaped like a Stripe one is not asked about ------------------------------------------------------------------------------------------------------------
const JUNK_IDENTIFIERS: Array<{ name: string; over: (quiet: string) => Record<string, unknown> }> = [
  { name: 'a session id that is not one', over: () => ({ stripeSessionId: 'not-a-session' }) },
  { name: 'a payment intent id that is not one', over: () => ({ stripePaymentIntentId: 'not-an-intent' }) },
  { name: 'a session id with the prefix of a payment intent', over: () => ({ stripeSessionId: 'pi_test_FAKE_wrong_field' }) },
  { name: 'a good session id next to a malformed payment intent id (never repaired into a channel read through the session)', over: (quiet) => ({ stripeSessionId: quiet, stripePaymentIntentId: 'junk' }) },
]
for (const scenario of JUNK_IDENTIFIERS) {
  test(`H13 F02 - an attempt with ${scenario.name} is not a channel: 409 STRIPE_UNVERIFIABLE, and Stripe is not asked about it`, async () => {
    await reset()
    const id = await confirming()
    const [original] = await attemptsOf(id)
    const quiet = registerQuietSession('cs_test_FAKE_H13')
    await addAttempt(id, { status: 'expired', failureReason: 'stale_reservation', ...scenario.over(quiet) })
    const before = await snapshot(id)
    const recorder = recordStripeReads()
    let refused: Awaited<ReturnType<typeof resolve>>
    try {
      refused = await resolve(id, { outcome: 'no_charge', reason: REASON }, admin)
    } finally {
      recorder.restore()
    }
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.code, 'STRIPE_UNVERIFIABLE')
    assert.match(refused.json.error, /no Stripe identifier/)
    assert.deepEqual([...new Set(recorder.ids)], [original.stripeSessionId], 'Stripe was asked about the attempt that can be asked about - and about nothing else')
    assert.equal(recorder.ids.length, 2, 'the sync of the decision and the check read it once each')
    await assertDecisionWroteNothing(id, before, scenario.name)
  })
}
