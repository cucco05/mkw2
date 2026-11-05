// DR-13 follow-up - LEGACY SESSION MISMATCH.
//
// The code that was PUBLISHED (claude/stampa3d-fase1, 457df91, lib/checkout-sessions.ts reopenAttempt) met an OPEN page that no longer matched the order (`sessionProblem`) and closed the ROW:
// `failed`, failureReason `session_mismatch:<problem>`, the Stripe session id still on it. It never asked Stripe to close the page: the page stayed open and PAYABLE. (tests/security/_legacy-checkout.ts
// keeps that function verbatim, and the rows below are made BY IT.)
//
// The replacement took `session_mismatch:` for a proof that the page is closed. For rows the new code writes it is true (it writes it after the provider's proof); for the rows the old code left it is
// false - and a database that was filled by the old code has such rows. What these tests judge, on the state the faithful stand-in for Stripe really holds:
//   T1  a legacy row whose page is OPEN: a new request closes that page, with proof, BEFORE any other page is made; the cause of the mismatch stays on the row
//   T2  ... whose page is COMPLETE (the customer paid it): no other page, the payment is handled by the payment sync
//   T3  ... whose closing can not be proved (expire and read inconclusive or unreachable): nothing is opened, nothing is cancelled, fail closed
//   T4  the administrator's "no charge" with such a page still open: closed with proof BEFORE the decision is committed; if Stripe does not answer, 409 and the hold is kept
//   T5  rows the NEW code writes, whose mismatch was really closed with the provider's proof: they are not asked about again, they do not block, they keep the cause
//   T6  the report (Q5/Q6) lists the legacy row and not the proven one; the places that heal it - the confirmation page, the expiry announcement - write the proof and keep the cause
//   T7  another page of the order expires while the legacy page is open: the order is not cancelled
// A proof of closing is, and only is: `closed_by_us:` or `provider_status:expired` at the start of the reason. A reason that merely NAMES a cause (`session_mismatch:`) is a diagnosis, not a proof.
import './_harness'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { bootKit, type Kit, type Started } from './_dr13-kit'
import { gate, type Gate } from './_dr13-barrier'
import { checkoutPagesHooks } from '../../lib/checkout-pages'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { reopenAttempt as legacyReopenAttempt } from './_legacy-checkout'

let k: Kit
let admin: NonNullable<Viewer>
const REASON = 'Checked with the customer and with Stripe: nothing was charged.'
let ipSeq = 0
const nextIp = () => `10.15.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`

test.before(async () => {
  k = await bootKit()
  const user = await k.prisma.user.create({ data: { email: 'legacy-mismatch-admin@sectest.invalid', passwordHash: 'x', name: 'legacy-mismatch-admin', role: 'admin', isAdmin: true } as any })
  admin = { id: user.id, role: 'admin' }
})
test.beforeEach(async () => { await k.fresh(); await k.prisma.adminAuditEvent.deleteMany(); k.sim.hooks = {}; checkoutPagesHooks.runJob = null })
test.afterEach(() => { k.sim.hooks = {}; checkoutPagesHooks.runJob = null })
test.after(async () => { await k.fresh(); await k.sim.close() })

const liveAttempts = (attempts: Array<{ status: string }>) => attempts.filter((a) => a.status === 'creating' || a.status === 'open')

// the order of what happened at the provider: the old page must be closed there BEFORE the next one is created
function assertClosedBeforeNextOpened(ops: string[], oldSession: string) {
  const created = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.startsWith('create.executed'))
  assert.ok(created.length >= 2, `a second page was expected: ${ops.join(' | ')}`)
  const closed = ops.indexOf(`expire.executed:${oldSession}`)
  assert.ok(closed >= 0 && closed < created[1].index, `the old page ${oldSession} must be closed at the provider before the next one is created: ${ops.join(' | ')}`)
}

// What each problem `sessionProblem` can report for an OPEN page looks like at the provider
const PROBLEMS: Array<{ problem: string; patch: (total: number) => Record<string, unknown> }> = [
  { problem: 'amount', patch: (total) => ({ amount_total: total + 100 }) },
  { problem: 'currency', patch: () => ({ currency: 'usd' }) },
  { problem: 'client_reference_id', patch: () => ({ client_reference_id: 'another-order' }) },
  { problem: 'metadata', patch: () => ({ metadata: { orderId: 'another-order' } }) },
  { problem: 'mode', patch: () => ({ mode: 'subscription' }) },
  { problem: 'no_url', patch: () => ({ url: null }) },
]

// A page that matched when it was made and, by the time the OLD code looks at it again, does not match the order (whatever the cause); then the OLD reopenAttempt meets it - the real function,
// character for character - and leaves what it left: the row closed `failed / session_mismatch:<problem>` with the session id on it, and the page still open at the provider.
async function legacyMismatch(problem = 'amount'): Promise<Started> {
  const a = await k.startCheckout(k.newBrowser())
  const spec = PROBLEMS.find((p) => p.problem === problem)!
  await k.sim.tamper(a.sessionId, spec.patch(a.total))
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId }, include: { items: { orderBy: { createdAt: 'asc' } } } })
  const attempt = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  const expireCalls = await k.sim.countOps('expire.call')
  assert.equal(await legacyReopenAttempt(order, attempt), null, 'the old code ended the attempt')
  // the premise, read from the state: what the old code left in the database and at the provider
  const row = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })
  assert.deepEqual([row.status, row.failureReason, row.stripeSessionId], ['failed', `session_mismatch:${problem}`, a.sessionId], 'premise: the row the old code leaves')
  assert.equal(await k.sim.countOps('expire.call'), expireCalls, 'premise: the old code did not ask the provider to close the page')
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId], 'premise: and the page is still payable')
  return a
}

async function facts(orderId: string) {
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: { orderBy: { id: 'asc' } } } })
  return {
    order: { status: order.status, paymentStatus: order.paymentStatus, review: order.paymentReviewReason, revision: order.financialRevision, resolutions: (order.metadata as any)?.paymentHoldResolution ?? null, cancellation: (order.metadata as any)?.cancellation ?? null },
    attempts: order.paymentAttempts.map((x) => ({ id: x.id, status: x.status, reason: x.failureReason, session: x.stripeSessionId })),
    decisions: await k.prisma.adminAuditEvent.count({ where: { action: 'admin.order.payment_hold.resolve' } }),
  }
}
async function holdUntilReached(held: Gate, request: Promise<unknown>) {
  try { await held.arrive() } catch (error) { held.release(); await request.catch(() => undefined); throw error }
}

// ====================================================================================================================================================================
// T1 - the page is OPEN
// ====================================================================================================================================================================
for (const { problem } of PROBLEMS) {
  test(`T1: the old code closed the ROW for "${problem}" and left the page open: a new request closes that page at the provider, with proof, BEFORE any other page is made - and the cause stays on the row`, async () => {
    const a = await legacyMismatch(problem)
    const r = await k.payAgain(a)
    await k.assertClean(`T1 ${problem}`)
    assert.equal(r.status, 200, r.text)
    assert.notEqual(k.sessionIdOf(r.json.url), a.sessionId, 'the customer is handed the NEW page')
    assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
    const attempts = await k.attemptsOf(a.orderId)
    const old = attempts.find((x) => x.id === a.attemptId)!
    assert.equal(old.status, 'failed', 'the row keeps its status')
    assert.equal(old.stripeSessionId, a.sessionId, 'and the identifier of its session')
    assert.match(old.failureReason ?? '', /^closed_by_us:/, `the provider's proof is written on the row (${old.failureReason})`)
    assert.ok((old.failureReason ?? '').includes(`session_mismatch:${problem}`), `and the cause of the mismatch is not lost (${old.failureReason})`)
    assert.equal(liveAttempts(attempts).length, 1)
    assert.equal(attempts.length, 2, 'the legacy row and its successor')
    assert.equal((await k.sim.payable(a.orderId)).length, 1, 'one payable page at the provider')
    // the reconciliation is IDEMPOTENT: the proof is on the row now, so nothing asks the provider about that page again and the row is not written again
    const opsBefore = (await k.opNames()).length
    const again = await k.payAgain(a)
    assert.equal(again.status, 200, again.text)
    const asked = (await k.opNames()).slice(opsBefore).filter((op) => op.includes(a.sessionId))
    assert.deepEqual(asked, [], `the page that was proved closed was asked about again: ${asked.join(' | ')}`)
    const settled = await k.attemptsOf(a.orderId)
    assert.equal(settled.find((x) => x.id === a.attemptId)!.failureReason, old.failureReason, 'and the row was not written again')
    assert.equal(settled.length, 2, 'and no other attempt was made')
  })
}

// ====================================================================================================================================================================
// T2 - the page is COMPLETE
// ====================================================================================================================================================================
test('T2: the page the old code left open has been PAID: no other page is made; the payment is recorded by the payment sync (it does not match the order: it goes to a person), once', async () => {
  const a = await legacyMismatch('amount')
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)            // the customer paid the page that was left open (at the amount it carries); the webhook has not arrived
  const r = await k.payAgain(a)
  await k.assertClean('T2')
  assert.equal(r.status, 409, r.text)
  assert.equal(await k.sim.createdSessions(), 1, 'no other page was made')
  assert.equal(await k.sim.countOps('create.call'), 1)
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
  assert.equal(order.paymentReviewReason, 'amount', 'the payment sync verified the payment against the order: the amount does not match - a person looks')
  assert.notEqual(order.paymentStatus, 'paid', 'a payment that does not match is never marked paid')
  assert.ok(Object.values(k.effects).every((n) => n === 0), `nothing was released to production: ${JSON.stringify(k.effects)}`)
  const row = (await k.attemptsOf(a.orderId))[0]
  assert.equal(row.stripeSessionId, a.sessionId, 'the identifier is not lost')
  assert.equal(row.status, 'mismatch', 'the sync recorded the payment on the attempt that carries it')
  assert.deepEqual(await k.sim.payable(a.orderId), [])
})

// ====================================================================================================================================================================
// T3 - the closing can not be proved
// ====================================================================================================================================================================
for (const variant of ['expire and read unreachable', 'expire unreachable, the read says "open"'] as const) {
  test(`T3: ${variant}: nothing is opened, nothing is cancelled, the row is as it was; with the provider back the next request closes the page and goes on`, async () => {
    const a = await legacyMismatch('amount')
    k.sim.faults.expireUnreachable = 5
    if (variant === 'expire and read unreachable') k.sim.faults.retrieveUnreachable = 5
    else k.sim.faults.retrieveInconclusive = 5
    const before = await facts(a.orderId)
    const down = await k.payAgain(a)
    assert.equal(down.status, 503, down.text)
    assert.equal(down.json?.code, 'PAYMENT_PAGE_CLOSE_UNCONFIRMED')
    assert.equal(await k.sim.countOps('create.call'), 1, 'no other page was made')
    assert.deepEqual(await facts(a.orderId), before, 'the order, its attempts and the audit log are exactly as they were: nothing was cancelled, nothing was written')
    assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId], 'the page is still there - and still the only one')
    k.sim.faults.expireUnreachable = 0
    k.sim.faults.retrieveUnreachable = 0
    k.sim.faults.retrieveInconclusive = 0
    const up = await k.payAgain(a)
    await k.assertClean(`T3 ${variant}`)
    assert.equal(up.status, 200, up.text)
    assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
  })
}

// ====================================================================================================================================================================
// T2b - the order is not CANCELLED over a page that may still be paid
// ====================================================================================================================================================================
test('T7: another page of the order runs out of time and is announced while the legacy mismatch page is still OPEN: the order is NOT cancelled (that page may still be paid) - and the next request closes it with proof', async () => {
  const a = await legacyMismatch('amount')                       // A: failed / session_mismatch:amount, its page S1 open at the provider
  await k.sim.expiresIn(a.sessionId, 3 * 3_600_000)               // S1 lives on, whatever the clock does
  const twin = await k.addLegacyTwin(a.orderId)                   // B: a second page of the old code ...
  const delivered = await k.expireNaturally(twin.sessionId)        // ... that runs out of its time at the provider and is announced
  assert.equal(delivered?.status, 200, JSON.stringify(delivered?.json))
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
  assert.notEqual(order.status, 'cancelled', 'an order is not cancelled over a row that proves nothing about its page')
  assert.equal(order.status, 'awaiting_payment')
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId], 'the legacy page is still payable')
  const r = await k.payAgain(a)
  await k.assertClean('T7')
  assert.equal(r.status, 200, r.text)
  assertClosedBeforeNextOpened(await k.opNames(), a.sessionId)
})

// ====================================================================================================================================================================
// T4 - the administrator's "no charge" meets such a page
// ====================================================================================================================================================================
async function resolveHold(orderId: string, body: unknown = { outcome: 'no_charge', reason: REASON }) {
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
// (the closing of the other pages in the background has suites of its own: what is judged here is the DECISION's own closing, in its order)
const withoutJobs = async <T>(body: () => Promise<T>): Promise<T> => {
  checkoutPagesHooks.runJob = async () => undefined
  try { return await body() } finally { checkoutPagesHooks.runJob = null }
}
async function onHoldWithLegacyPage(): Promise<Started> {
  const a = await legacyMismatch('amount')
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { paymentReviewReason: 'amount' } })     // the order's payment is on hold, for a person to decide
  return a
}

test('T4: "no charge" with a legacy mismatch page still OPEN: the page is closed at the provider, with proof, BEFORE the order is cancelled; the row keeps the cause', async () => {
  const a = await onHoldWithLegacyPage()
  const seen: Array<{ session: string; status: string; payment: string }> = []
  k.sim.hooks.afterExpire = async (id) => {
    const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
    seen.push({ session: id, status: order.status, payment: order.paymentStatus })
  }
  const r = await withoutJobs(() => resolveHold(a.orderId))
  k.sim.hooks = {}
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(seen.map((s) => s.session), [a.sessionId], 'the page was closed by the decision')
  assert.deepEqual([seen[0].status, seen[0].payment], ['awaiting_payment', 'pending'], 'while the order was NOT yet cancelled: the proof came before the commit')
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'nothing is payable afterwards')
  const f = await facts(a.orderId)
  assert.deepEqual([f.order.status, f.order.paymentStatus], ['cancelled', 'canceled'])
  assert.equal(f.decisions, 1)
  assert.match(f.attempts[0].reason ?? '', /^closed_by_us:admin_released/, 'the proof is on the row')
  assert.ok((f.attempts[0].reason ?? '').includes('session_mismatch:amount'), `and the cause is kept (${f.attempts[0].reason})`)
  await k.assertClean('T4')
})

test('T4: Stripe can not close the legacy page: 409, the hold is kept - the order is not cancelled, nothing is written, no decision is recorded', async () => {
  const a = await onHoldWithLegacyPage()
  k.sim.faults.expireUnreachable = 5
  const before = await facts(a.orderId)
  const r = await withoutJobs(() => resolveHold(a.orderId))
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'PAGES_NOT_CLOSED')
  assert.deepEqual(await facts(a.orderId), before)
  assert.deepEqual(await k.sim.payable(a.orderId), [a.sessionId], 'the page is still payable - on an order that is NOT cancelled')
})

test('T4: Stripe does not answer at all: 409, the hold is kept', async () => {
  const a = await onHoldWithLegacyPage()
  k.sim.faults.expireUnreachable = 9
  k.sim.faults.retrieveUnreachable = 9
  const before = await facts(a.orderId)
  const r = await withoutJobs(() => resolveHold(a.orderId))
  assert.equal(r.status, 409, r.text)
  assert.ok(['STRIPE_UNVERIFIABLE', 'PAGES_NOT_CLOSED'].includes(r.json.code), r.json.code)
  assert.deepEqual(await facts(a.orderId), before)
})

test('T4: the customer PAYS the legacy page while the decision is closing it: the expire is refused, the read shows "complete" - the decision is refused, the order is NOT cancelled', async () => {
  const a = await onHoldWithLegacyPage()
  const held = gate('expire in flight', { timeoutMs: 5000 })
  k.sim.hooks.duringExpire = () => held.pass()
  const decision = withoutJobs(() => resolveHold(a.orderId))
  await holdUntilReached(held, decision)
  assert.equal((await k.sim.pay(a.sessionId)).paid, true)
  held.release()
  const r = await decision
  k.sim.hooks = {}
  assert.equal(r.status, 409, r.text)
  const f = await facts(a.orderId)
  assert.notEqual(f.order.status, 'cancelled', 'a page that was paid is not released as "no charge"')
  assert.equal(f.decisions, 0)
})

// ====================================================================================================================================================================
// T5 - the rows the NEW code writes
// ====================================================================================================================================================================
test('T5: a mismatching page met by the NEW code is closed with the provider\'s proof; its row says closed_by_us and keeps the cause; the next request opens the next page at once, without asking about the old one', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.sim.tamper(a.sessionId, { amount_total: a.total + 100 })
  const first = await k.payAgain(a)
  assert.equal(first.status, 500, first.text)
  assert.equal(first.json?.code, 'PAYMENT_PROVIDER_ERROR')
  const [row] = await k.attemptsOf(a.orderId)
  assert.equal(row.status, 'failed')
  assert.equal(row.stripeSessionId, a.sessionId, 'the identifier is not lost')
  assert.equal(row.failureReason, 'closed_by_us:session_mismatch:amount', 'the proof first, the cause after it')
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'the page was closed at the provider')
  const opsBefore = (await k.opNames()).length
  const second = await k.payAgain(a)
  await k.assertClean('T5')
  assert.equal(second.status, 200, second.text)
  const asked = (await k.opNames()).slice(opsBefore).filter((op) => op.includes(a.sessionId))
  assert.deepEqual(asked, [], `the provider was not asked about the page that was already proved closed: ${asked.join(' | ')}`)
  const attempts = await k.attemptsOf(a.orderId)
  assert.equal(attempts.length, 2)
  assert.equal(liveAttempts(attempts).length, 1)
  assert.equal((await k.sim.payable(a.orderId)).length, 1)
})

test('T5: the mismatching page had ALREADY been closed by the provider when the new code came to close it: the row says provider_status:expired and keeps the cause', async () => {
  const a = await k.startCheckout(k.newBrowser())
  await k.sim.tamper(a.sessionId, { amount_total: a.total + 100 })
  let once = true
  k.sim.hooks.duringExpire = async (id) => { if (once) { once = false; await k.sim.expire(id) } }       // the page runs out at the provider just before our expire is executed
  const first = await k.payAgain(a)
  k.sim.hooks = {}
  assert.equal(first.status, 500, first.text)
  const [row] = await k.attemptsOf(a.orderId)
  assert.equal(row.failureReason, 'provider_status:expired (session_mismatch:amount)')
  const second = await k.payAgain(a)
  await k.assertClean('T5 provider')
  assert.equal(second.status, 200, second.text)
})

// ====================================================================================================================================================================
// T6 - the report and the places that heal the row
// ====================================================================================================================================================================
test('T6: scripts/checkout-pages-check.sql lists the legacy mismatch row (Q5, and Q6 when the order can not be paid) and does not list the row the new code proved', async () => {
  const sql = readFileSync(new URL('../../scripts/checkout-pages-check.sql', import.meta.url), 'utf8')
  const queries = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((q) => q.trim()).filter(Boolean)
  const run = (index: number) => k.prisma.$queryRawUnsafe(queries[index]) as Promise<any[]>
  const waiting = await legacyMismatch('amount')                                       // legacy, the order can still be paid
  const cancelled = await legacyMismatch('currency')                                   // legacy, the order was cancelled
  await k.prisma.printOrder.update({ where: { id: cancelled.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  const proved = await k.startCheckout(k.newBrowser())                                 // written by the new code, with the provider's proof
  await k.sim.tamper(proved.sessionId, { amount_total: proved.total + 100 })
  assert.equal((await k.payAgain(proved)).status, 500)
  await k.prisma.printOrder.update({ where: { id: proved.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  const q5 = (await run(4)).map((r) => r.attempt).sort()
  assert.deepEqual(q5, [waiting.attemptId, cancelled.attemptId].sort(), 'Q5: the two legacy rows - and not the proved one')
  const q6 = (await run(5)).map((r) => r.attempt)
  assert.deepEqual(q6, [cancelled.attemptId], 'Q6: the legacy row of the order that can not be paid - not the one of the order that can, not the proved one')
  // (the row the report leaves out is the one the new code wrote with the provider's proof)
  assert.equal((await k.attemptsOf(proved.orderId))[0].failureReason, 'closed_by_us:session_mismatch:amount')
})

test('T6: the customer looks at the confirmation page of an order that was CANCELLED while the old code had left its page open: the page is closed at the provider, with proof, and the row keeps the cause', async () => {
  const a = await legacyMismatch('amount')
  await k.prisma.printOrder.update({ where: { id: a.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  await k.getStatus(a.orderId, { ...a.who, cookie: a.accessCookie ?? undefined })
  assert.deepEqual(await k.sim.payable(a.orderId), [], 'the page is no longer payable')
  const row = (await k.attemptsOf(a.orderId))[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.stripeSessionId, a.sessionId)
  assert.match(row.failureReason ?? '', /^closed_by_us:order_cancelled/)
  assert.ok((row.failureReason ?? '').includes('session_mismatch:amount'), `the cause is kept (${row.failureReason})`)
})

test('T6: the provider announces that the legacy page expired (checkout.session.expired): the announcement is verified against the session and the proof is written on the row - the cause is kept', async () => {
  const a = await legacyMismatch('amount')
  checkoutPagesHooks.runJob = async () => undefined      // (what is judged is what the sync itself writes)
  await k.sim.expire(a.sessionId)
  const delivered = await k.announceExpired(a.sessionId)
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json))
  const row = (await k.attemptsOf(a.orderId))[0]
  assert.equal(row.status, 'failed', 'the row keeps its status')
  assert.equal(row.failureReason, 'provider_status:expired (was session_mismatch:amount)')
  assert.equal(row.stripeSessionId, a.sessionId)
})
