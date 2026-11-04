// DR-13 follow-up P0-A - the administrator releases a payment as "no charge": the order is cancelled, the customer may pay again, and NO payment page of the order may still be payable.
//
// The decision (lib/payment-hold.ts) asked Stripe whether any payment of the order was collected or on its way, then - in one transaction - cancelled the order and marked its open attempts
// failed, and only AFTER the commit asked Stripe to expire the pages, one call each, any failure swallowed. A page that could not be closed (an unreachable provider, a timeout, a crash between
// two calls, a customer who finished paying meanwhile) stayed payable on a cancelled order: money for an order that no longer exists. The rule these tests judge, on the state the faithful stand-in
// for Stripe really holds (tests/security/_stripe-sim.ts):
//   * "no charge" is confirmed only when EVERY page that could still be paid has been closed at the provider WITH PROOF (the answer was `expired`, or the page reads back `expired`) and no payment
//     is in progress: a page that turns out COMPLETE is money, one that can not be closed or read leaves the hold exactly as it was (409 PAGES_NOT_CLOSED);
//   * the closing happens BEFORE the decision is committed, outside any database transaction; then the order, the attempts and the proofs are read again under the lock, and a decision whose basis
//     changed meanwhile is refused;
//   * pages closed before a decision that could not be completed stay closed: asking again reconciles them (no page is created, no money moves) and completes the decision;
//   * the proof is written on the rows (`closed_by_us:` / `provider_status:expired`), together with the reason of the decision;
//   * the rest of the hold is as it was: F01 (Stripe must answer), F02 (an attempt with no identifier), the audit record, the financial revision, the refusal while a refund is in progress.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { bootKit, type Kit, type Started } from './_dr13-kit'
import { gate, type Gate } from './_dr13-barrier'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { checkoutPagesHooks } from '../../lib/checkout-pages'
import { killChildren, runOne, runTogether } from './_dr13-procs'

let k: Kit
let admin: NonNullable<Viewer>
const REASON = 'Checked with the customer and with Stripe: nothing was charged.'
let ipSeq = 0
const nextIp = () => `10.14.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`

test.before(async () => {
  k = await bootKit()
  const user = await k.prisma.user.create({ data: { email: 'hold-pages-admin@sectest.invalid', passwordHash: 'x', name: 'hold-pages-admin', role: 'admin', isAdmin: true } as any })
  admin = { id: user.id, role: 'admin' }
})
// The closing of the OTHER pages of an order (lib/checkout-pages.ts) is started in the background by every payment sync - also by the one that precedes a decision - and has suites of its own
// (dr13-payments, dr13-closed-open). What is judged here is the DECISION's own closing of the pages, in the order in which it does it: the jobs are dropped, so that their calls (and the faults
// these tests inject at the provider's calls) are not taken for the decision's.
test.beforeEach(async () => { await k.fresh(); await k.prisma.adminAuditEvent.deleteMany(); k.sim.hooks = {}; checkoutPagesHooks.runJob = async () => undefined })
test.afterEach(() => { k.sim.hooks = {}; killChildren() })
test.after(async () => { checkoutPagesHooks.runJob = null; await k.fresh(); await k.sim.close() })

async function resolve(orderId: string, body: unknown = { outcome: 'no_charge', reason: REASON }) {
  viewerGuards.getViewer = async () => admin
  const mod = await import('../../app/api/admin/orders/[orderId]/payment-hold/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/admin/orders/${orderId}/payment-hold`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), 'user-agent': 'sectest' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ orderId }) })) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

// An order whose payment is on hold: being confirmed (the state a payment that is processing leaves), while the page it rests on is, at the provider, still open
async function onHold(): Promise<Started> {
  const a = await k.startCheckout(k.newBrowser())
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { paymentStatus: 'processing' } })
  await k.prisma.paymentAttempt.update({ where: { id: a.attemptId }, data: { status: 'processing' } })
  return a
}
// An order on hold for a REVIEW (a payment that did not match): the hold stays even when the page is expired
async function onReview(): Promise<Started> {
  const a = await k.startCheckout(k.newBrowser())
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { paymentReviewReason: 'amount' } })
  return a
}
async function holdUntilReached(held: Gate, request: Promise<unknown>) {
  try { await held.arrive() } catch (error) { held.release(); await request.catch(() => undefined); throw error }
}
// everything a REFUSED decision must leave as it was
async function facts(orderId: string) {
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: { orderBy: { id: 'asc' } } } })
  return {
    order: { status: order.status, paymentStatus: order.paymentStatus, review: order.paymentReviewReason, revision: order.financialRevision, resolutions: (order.metadata as any)?.paymentHoldResolution ?? null, cancellation: (order.metadata as any)?.cancellation ?? null },
    attempts: order.paymentAttempts.map((x) => ({ id: x.id, status: x.status, reason: x.failureReason, session: x.stripeSessionId })),
    decisions: await k.prisma.adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }),
  }
}

// ====================================================================================================================================================================
// H1 - the pages are closed, with proof, BEFORE the decision is committed
// ====================================================================================================================================================================
test('H1: every payment page of the order is closed at the provider BEFORE the order is cancelled; the proof is written on the rows; nothing is payable afterwards', async () => {
  const a = await onHold()
  const twin = await k.addLegacyTwin(a.orderId)                 // a second payable page, made by the old code
  const seen: Array<{ session: string; status: string; payment: string }> = []
  k.sim.hooks.afterExpire = async (id) => {
    const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
    seen.push({ session: id, status: order.status, payment: order.paymentStatus })
  }
  const r = await resolve(a.orderId)
  k.sim.hooks = {}
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.stripeCheck, 'confirmed_no_charge')
  assert.deepEqual(seen.map((s) => s.session).sort(), [a.sessionId, twin.sessionId].sort(), 'both pages were closed by the decision')
  for (const s of seen) {
    assert.deepEqual([s.status, s.payment], ['awaiting_payment', 'processing'], `the page ${s.session} was closed when the order had ALREADY been cancelled: the decision was committed before the proof`)
  }
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'no page is payable')
  const f = await facts(a.orderId)
  assert.deepEqual([f.order.status, f.order.paymentStatus, f.order.review], ['cancelled', 'canceled', null])
  for (const attempt of f.attempts) {
    assert.equal(attempt.status, 'failed')
    assert.match(attempt.reason ?? '', /^closed_by_us:admin_released/, `the proof of the closing is written on the row (${attempt.reason})`)
  }
  assert.equal(f.decisions, 1, 'the decision is recorded once')
  assert.equal(await k.sim.countOps('expire.executed'), 2, 'one closing per page - none after the commit')
  await k.assertClean('H1')
})

test('H1 (control): a page that is ALREADY expired at the provider carries the provider\'s own word as proof - nothing is expired by us - and the decision goes on', async () => {
  const a = await onReview()
  await k.sim.expire(a.sessionId)                                 // the page ran out at the provider
  const before = await k.sim.countOps('expire.executed')
  const r = await resolve(a.orderId)
  assert.equal(r.status, 200, r.text)
  assert.equal(await k.sim.countOps('expire.executed'), before, 'nothing was closed by us')
  const f = await facts(a.orderId)
  assert.equal(f.attempts[0].status, 'expired', 'the payment sync that precedes the decision had already moved it, with the proof')
  assert.match(f.attempts[0].reason ?? '', /^provider_status:expired/)
  assert.equal(f.attempts[0].session, a.sessionId)
  assert.deepEqual([f.order.status, f.order.paymentStatus], ['cancelled', 'canceled'])
})

test('H1: the answer of the closing is LOST but the page IS expired (a timeout): the read that follows proves it - the decision goes on', async () => {
  const a = await onHold()
  k.sim.faults.expireLostAnswer = 1
  const r = await resolve(a.orderId)
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  const f = await facts(a.orderId)
  assert.match(f.attempts[0].reason ?? '', /^(closed_by_us|provider_status:expired)/)
})

// ====================================================================================================================================================================
// H2 - what can not be closed keeps the hold
// ====================================================================================================================================================================
test('H2: one of two pages can not be closed (the provider does not answer): 409 PAGES_NOT_CLOSED, the order and its attempts are exactly as they were, no decision is recorded', async () => {
  const a = await onHold()
  await k.addLegacyTwin(a.orderId)
  let first = true
  k.sim.hooks.afterExpire = async () => { if (first) { first = false; k.sim.faults.expireUnreachable = 5; k.sim.faults.retrieveUnreachable = 5 } }   // the provider stops answering after the first page
  const before = await facts(a.orderId)
  const r = await resolve(a.orderId)
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAGES_NOT_CLOSED')
  assert.deepEqual(await facts(a.orderId), before, 'nothing was written: the hold is preserved')
  assert.equal((await k.sim.payable(a.orderId)).length, 1, 'exactly one page was closed; the other is still payable - and the order is NOT cancelled')
})

test('H2: the page is still OPEN after a failed expire (an inconclusive read): the closing is not proved - nothing is decided', async () => {
  const a = await onHold()
  k.sim.faults.expireUnreachable = 5
  k.sim.faults.retrieveInconclusive = 5
  const before = await facts(a.orderId)
  const r = await resolve(a.orderId)
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAGES_NOT_CLOSED')
  assert.deepEqual(await facts(a.orderId), before)
})

test('H3: after a decision that could not be completed, asking again RECONCILES: the page that was closed stays closed (not closed twice), no page is created, no money moves, the decision is taken', async () => {
  const a = await onHold()
  const twin = await k.addLegacyTwin(a.orderId)
  let first = true
  k.sim.hooks.afterExpire = async () => { if (first) { first = false; k.sim.faults.expireUnreachable = 5; k.sim.faults.retrieveUnreachable = 5 } }
  const refused = await resolve(a.orderId)
  assert.equal(refused.status, 409, refused.text)
  k.sim.hooks = {}
  k.sim.faults.expireUnreachable = 0
  k.sim.faults.retrieveUnreachable = 0
  const executedBefore = await k.sim.countOps('expire.executed')
  const createsBefore = await k.sim.countOps('create.call')
  const retried = await resolve(a.orderId)
  assert.equal(retried.status, 200, retried.text)
  assert.equal(await k.sim.countOps('expire.executed'), executedBefore + 1, 'only the page that was still open is closed now')
  assert.equal(await k.sim.countOps('create.call'), createsBefore, 'no page was created')
  assert.equal(await k.prisma.refundOperation.count(), 0, 'no money moved')
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  const f = await facts(a.orderId)
  assert.deepEqual([f.order.status, f.order.paymentStatus], ['cancelled', 'canceled'])
  // every attempt is closed and carries the provider's word: the page the decision closed now (failed / closed_by_us), and the one it had closed before (the payment sync that precedes the decision
  // read it expired and moved the row, with the proof)
  assert.ok(f.attempts.every((x) => (x.status === 'failed' || x.status === 'expired') && /^(closed_by_us|provider_status:expired)/.test(x.reason ?? '')), JSON.stringify(f.attempts))
  assert.equal(f.attempts.find((x) => x.session === a.sessionId)?.status, 'failed', 'the carrier of the hold is released by the decision')
  assert.equal(f.decisions, 1)
  void twin
})

// ====================================================================================================================================================================
// H4 - money
// ====================================================================================================================================================================
test('H4: the customer FINISHES PAYING while the closing is in flight: the expire is refused, the read shows the page complete - the decision is refused, the payment is recorded, the order is NOT cancelled', async () => {
  const a = await onHold()
  const held = gate('expire in flight', { timeoutMs: 5000 })
  k.sim.hooks.duringExpire = () => held.pass()
  const decision = resolve(a.orderId)
  await holdUntilReached(held, decision)
  await k.customerPays(a.sessionId)                              // pays; the webhook arrives and the payment is recorded
  held.release()
  const r = await decision
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  assert.ok(['CHARGE_EXISTS', 'PAYMENT_COLLECTED'].includes(r.json.code), r.json.code)
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
  assert.notEqual(order.status, 'cancelled', 'an order that was paid is not cancelled')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(await k.prisma.adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }), 0)
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  assert.ok(Object.values(k.effects).every((n) => n <= 1), `the effects of a payment ran at most once: ${JSON.stringify(k.effects)}`)
})

test('H4: a page that is COMPLETE at the provider (the customer finished paying; the database does not know) keeps the hold: nothing is cancelled', async () => {
  const a = await onHold()
  assert.equal((await k.sim.pay(a.sessionId, { piStatus: 'requires_payment_method' })).paid, true)   // the page is complete, but no money has arrived
  const before = await facts(a.orderId)
  const r = await resolve(a.orderId)
  assert.equal(r.status, 409, r.text)
  const after = await facts(a.orderId)
  assert.deepEqual([after.order.status, after.order.paymentStatus, after.decisions], [before.order.status, before.order.paymentStatus, 0])
})

test('H4: an attempt that is only a PaymentIntent (no page) and is still waiting for a payment method is a doubtful payment: the hold is kept; one that is CANCELED lets the decision go on', async () => {
  const a = await onHold()
  const waiting = await k.sim.seedIntent({ orderId: a.orderId, attemptId: null, status: 'requires_payment_method', amount: a.total })
  await k.prisma.paymentAttempt.create({ data: { orderId: a.orderId, amountCents: a.total, currency: 'EUR', status: 'expired', stripePaymentIntentId: waiting, failureReason: 'payment_failed', expiresAt: new Date(Date.now() - 60_000) } })
  const before = await facts(a.orderId)
  const refused = await resolve(a.orderId)
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'PAGES_NOT_CLOSED')
  assert.deepEqual(await facts(a.orderId), before)
  // the same attempt, with its PaymentIntent cancelled: nothing is payable any more
  await (k.sim as any).client.$executeRawUnsafe(`UPDATE fakestripe.intent SET body = body || '{"status":"canceled"}'::jsonb WHERE id = $1`, waiting)
  const accepted = await resolve(a.orderId)
  assert.equal(accepted.status, 200, accepted.text)
})

// ====================================================================================================================================================================
// H5 - rows the database holds as closed whose page was never shown closed
// ====================================================================================================================================================================
test('H5: a row the database holds as CLOSED (failed, with an identifier, no proof) whose page is still open is closed at the provider too - and gets its proof', async () => {
  const a = await onHold()
  const hidden = await k.addLegacyTwin(a.orderId)
  await k.prisma.paymentAttempt.update({ where: { id: hidden.twin.id }, data: { status: 'failed', failureReason: 'payment_failed' } })
  assert.deepEqual((await k.sim.payable(a.orderId)).sort(), [a.sessionId, hidden.sessionId].sort(), 'premise: two payable pages, one of them on a closed row')
  const r = await resolve(a.orderId)
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'the page of the closed row is closed too')
  const row = (await facts(a.orderId)).attempts.find((x) => x.id === hidden.twin.id)!
  assert.match(row.reason ?? '', /^closed_by_us:/, 'and its row carries the proof')
  assert.equal(row.session, hidden.sessionId)
})

// ====================================================================================================================================================================
// H6 - the basis of the decision changes while the pages are being closed
// ====================================================================================================================================================================
test('H6: another writer moves the financial revision of the order while the pages are being closed: the decision is refused, nothing is written, the next request decides again', async () => {
  const a = await onReview()
  let touched = false
  k.sim.hooks.afterExpire = async () => {
    if (touched) return
    touched = true
    await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { financialRevision: { increment: 1 } } })
  }
  const before = await facts(a.orderId)
  const r = await resolve(a.orderId)
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  const after = await facts(a.orderId)
  assert.equal(after.decisions, 0)
  assert.equal(after.order.status, 'awaiting_payment', 'not cancelled')
  assert.equal(after.order.revision, before.order.revision + 1, 'only the writer\'s own change')
  const again = await resolve(a.orderId)
  assert.equal(again.status, 200, again.text)
})

test('H6: a new payment attempt appears while the pages are being closed: the set examined is not the set found under the lock - refused, nothing written', async () => {
  const a = await onHold()
  let added = false
  k.sim.hooks.afterExpire = async () => {
    if (added) return
    added = true
    await k.prisma.paymentAttempt.create({ data: { orderId: a.orderId, amountCents: a.total, currency: 'EUR', status: 'expired', failureReason: 'closed_by_us:replaced', stripeSessionId: 'cs_test_SIM_late_arrival', expiresAt: new Date(Date.now() - 1000) } })
  }
  const r = await resolve(a.orderId)
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  const f = await facts(a.orderId)
  assert.equal(f.decisions, 0)
  assert.equal(f.order.status, 'awaiting_payment')
})

test('H6: the PROOF of a closed row is taken away while the pages are being closed (another writer replaces its reason): under the lock the row has no proof and no closing in this decision covers it - refused, nothing written', async () => {
  const a = await onReview()
  // a second attempt, already closed WITH the provider\'s proof (so the decision has nothing to close for it)
  const quiet = await k.sim.seedSession({ orderId: a.orderId, attemptId: null, legacy: true, status: 'expired', amount: a.total, currency: 'eur' })
  const proved = await k.prisma.paymentAttempt.create({ data: { orderId: a.orderId, amountCents: a.total, currency: 'EUR', status: 'expired', stripeSessionId: quiet, failureReason: 'provider_status:expired', expiresAt: new Date(Date.now() - 60_000) } })
  let touched = false
  k.sim.hooks.afterExpire = async () => {
    if (touched) return
    touched = true
    await k.prisma.paymentAttempt.update({ where: { id: proved.id }, data: { failureReason: 'payment_failed' } })
  }
  const r = await resolve(a.orderId)
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAGES_NOT_CLOSED')
  const f = await facts(a.orderId)
  assert.equal(f.decisions, 0)
  assert.equal(f.order.status, 'awaiting_payment')
  assert.equal(f.attempts.find((x) => x.id === proved.id)?.reason, 'payment_failed', 'the writer\'s change is there, untouched')
})

// ====================================================================================================================================================================
// H7 - controls: what the decision always did
// ====================================================================================================================================================================
test('H7 control: money collected at Stripe is still refused before any page is touched (F01 / CHARGE_EXISTS); an attempt with no identifier is still refused (F02)', async () => {
  const a = await onHold()
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)
  const money = await resolve(a.orderId)
  assert.equal(money.status, 409, money.text)
  assert.ok(['CHARGE_EXISTS', 'PAYMENT_COLLECTED'].includes(money.json.code), money.json.code)   // (the sync that precedes the decision records the payment first)
  assert.equal(await k.sim.countOps('expire.call'), 0, 'no page was touched')
  const b = await onHold()
  await k.prisma.paymentAttempt.create({ data: { orderId: b.orderId, amountCents: b.total, currency: 'EUR', status: 'creating', expiresAt: new Date(Date.now() + 60_000) } })
  const f02 = await resolve(b.orderId)
  assert.equal(f02.status, 409, f02.text)
  assert.equal(f02.json.code, 'STRIPE_UNVERIFIABLE')
  assert.equal(await k.sim.countOps('expire.call'), 0, 'no page was touched')
})

// ====================================================================================================================================================================
// H8 - real processes: a power cut in the middle of the closing, and several administrators at the same moment
// ====================================================================================================================================================================
const HOLD_CHILD = (extra: Record<string, string> = {}) => ({ CHILD_MODE: 'hold', CHILD_ADMIN: admin.id, CHILD_NO_JOBS: '1', ...extra })

test('H8: the process DIES (a power cut) right after the first page was closed at the provider: the hold is exactly as it was; the next process reconciles it - no page is created, no money moves', async () => {
  const a = await onHold()
  await k.addLegacyTwin(a.orderId)
  const before = await facts(a.orderId)
  const died = await runOne(k, 'h8a', a.orderId, HOLD_CHILD({ SIM_FAULTS: JSON.stringify({ expireCrashAfter: 1 }) }))
  assert.equal(died.exit, 137, died.output)
  assert.equal(died.kind, 'no_result', 'it left no answer')
  assert.deepEqual(await facts(a.orderId), before, 'the order, its attempts and the audit log are exactly as they were: nothing was decided')
  assert.equal((await k.sim.payable(a.orderId)).length, 1, 'one page was closed before the crash; the other is still payable, and the order is NOT cancelled - which is what the old decision (cancel first, close later) could not say')
  const createsBefore = await k.sim.countOps('create.call')
  const next = await runOne(k, 'h8b', a.orderId, HOLD_CHILD())
  assert.equal(next.exit, 0, next.output)
  assert.equal(next.kind, 'decided', JSON.stringify([next.kind, next.status, next.code, next.reason]))
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  assert.equal(await k.sim.countOps('create.call'), createsBefore, 'no page was created')
  assert.equal(await k.prisma.refundOperation.count(), 0, 'no money moved')
  const f = await facts(a.orderId)
  assert.deepEqual([f.order.status, f.order.paymentStatus], ['cancelled', 'canceled'])
  assert.ok(f.attempts.every((x) => /^(closed_by_us|provider_status:expired)/.test(x.reason ?? '')), JSON.stringify(f.attempts))
  assert.equal(f.decisions, 1)
})

test('H8: three administrators decide at the same moment from three real processes, each closing the same pages: never two decisions, each page closed once, no page created, nothing left payable - and what was left undone is completed by the next request', async () => {
  const a = await onReview()                                    // (a review hold: the payment sync does not dissolve it when it finds the page closed)
  await k.addLegacyTwin(a.orderId)
  const createsBefore = await k.sim.countOps('create.call')
  const results = await runTogether(k, 3, a.orderId, HOLD_CHILD())
  const summary = JSON.stringify(results.map((r) => [r.label, r.exit, r.kind, r.status, r.code, r.reason]))
  assert.deepEqual(results.map((r) => r.exit), [0, 0, 0], summary)
  const decided = results.filter((r) => r.kind === 'decided').length
  assert.ok(decided <= 1, `two decisions: ${summary}`)
  for (const r of results.filter((x) => x.kind !== 'decided')) {
    assert.equal(r.status, 409, summary)
    assert.ok(['NOT_ON_HOLD', 'STRIPE_UNVERIFIABLE'].includes(r.code as string), summary)   // (it was decided by another, or the attempts changed under it: it read them again and refused)
  }
  assert.equal((await facts(a.orderId)).decisions, decided, 'recorded as many times as it was taken')
  assert.equal(await k.sim.countOps('expire.executed'), 2, 'each of the two pages was closed once, however many processes tried')
  assert.equal(await k.sim.countOps('create.call'), createsBefore, 'no page was created')
  if (decided === 0) {
    // nobody completed: the order is NOT cancelled, and the next request finishes the job with the pages already closed
    assert.equal((await facts(a.orderId)).order.status, 'awaiting_payment')
    const finish = await resolve(a.orderId)
    assert.equal(finish.status, 200, finish.text)
  }
  const f = await facts(a.orderId)
  assert.deepEqual([f.order.status, f.order.paymentStatus], ['cancelled', 'canceled'])
  assert.deepEqual(await k.sim.payable(a.orderId), [])
  assert.equal(f.decisions, 1)
  assert.ok(f.attempts.every((x) => /^(closed_by_us|provider_status:expired)/.test(x.reason ?? '')), JSON.stringify(f.attempts))
  assert.equal(await k.prisma.refundOperation.count(), 0, 'no money moved')
})
