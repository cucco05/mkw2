// DR-13 / D10 — reconciling an attempt whose page nobody can name, on POSITIVE proof from the provider only (E-A). lib/checkout-reconcile.ts, scripts/checkout-reconcile.ts.
//
// What is judged (isolated PostgreSQL, the faithful stand-in for Stripe of tests/security/_stripe-sim.ts, the real settlement of the order):
//   * the block: a reservation whose request can not be sent again is refused by the customer's own path (503) however often she tries - and it is the PROVIDER NAMING the page that ends it;
//   * identification: the session must name THIS attempt and THIS order (metadata, client reference, payment mode, the identifier asked for), be readable now, and be held by no other attempt;
//   * a dry-run writes nothing and records nothing; an apply is audited before it acts, is idempotent (also when run several times at once), and goes through the settlement of the order;
//   * what the session turns out to be decides the result: open -> the order's page; complete -> a payment on its way (never marked paid here); expired -> closed with proof; a page that must not
//     stay open (the order was cancelled, the amount no longer matches) is closed AT THE PROVIDER, with proof;
//   * nothing is released because nothing was found: `discover` that finds nothing - complete listing or not - changes nothing; two candidates are refused; no code path of the tool writes a row by
//     hand, deletes, sends a request to create a page, or lets a listing stand for proof (a guard on the source);
//   * authorization (administrators only) and fail-closed on every error: unreachable provider, unreadable session, audit that can not be written.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { bootKit, type Kit } from './_dr13-kit'
import { reconcileAttempt, DISCOVERY_MAX_PAGES, RECONCILE_AUDIT_FINISHED, RECONCILE_AUDIT_REQUESTED, type ReconcileInput } from '../../lib/checkout-reconcile'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'

let k: Kit
let admin: { id: string }
let auditFailure: null | string = null
test.before(async () => {
  k = await bootKit()
  // an audit record that can not be written, on demand (the middleware passes everything else through)
  ;(k.prisma as any).$use(async (params: any, next: (p: any) => Promise<any>) => {
    if (auditFailure && params.model === 'AdminAuditEvent' && params.action === 'create' && String(params.args?.data?.action) === auditFailure) throw new Error('audit log unavailable (test)')
    return next(params)
  })
})
test.beforeEach(async () => {
  await k.fresh()
  auditFailure = null
  checkoutSessionHooks.withoutFollowUp = false
  await k.prisma.adminAuditEvent.deleteMany()
  await k.prisma.user.deleteMany({ where: { email: { endsWith: '@recon.invalid' } } })
  admin = await k.prisma.user.create({ data: { email: 'operator@recon.invalid', passwordHash: 'x', name: 'operator', role: 'admin', isAdmin: true } })
})
test.after(async () => { await k.fresh(); await k.prisma.adminAuditEvent.deleteMany(); await k.prisma.user.deleteMany({ where: { email: { endsWith: '@recon.invalid' } } }); await k.sim.close() })

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A reservation whose answer was lost: the provider HAS the page (open, naming the attempt), the database does not know its identifier. Its stored request is gone (the reservation as the old code
// left it, or a configuration that changed): the customer's own path will not send it again.
async function blockedReservation() {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.ok(first.status === 502 || first.status === 503, `premise: the answer was lost (${first.status})`)
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  await k.prisma.paymentAttempt.update({ where: { id: reservation.id }, data: { requestHash: null } })
  const sessions = await k.sim.sessionsOf(order.id)
  assert.equal(sessions.length, 1, 'premise: the provider holds one page')
  assert.equal(reservation.status, 'creating')
  assert.equal(reservation.stripeSessionId, null)
  const again = await k.payAgain({ ...first, orderId: order.id })
  assert.equal(again.status, 503, 'premise: the customer is told the page is being checked')
  assert.equal(again.json?.code, 'RESERVATION_UNRESOLVED')
  return { first: { ...first, orderId: order.id }, order, attemptId: reservation.id, sessionId: sessions[0].id, who: first.who, mark: (await ops()).length }
}
type Blocked = Awaited<ReturnType<typeof blockedReservation>>
const run = (b: { attemptId: string }, over: Partial<ReconcileInput> = {}) => reconcileAttempt({ attemptId: b.attemptId, operatorId: admin.id, dryRun: false, ...over })
const audits = () => k.prisma.adminAuditEvent.findMany({ where: { action: { startsWith: 'checkout.page.reconcile' } }, orderBy: { createdAt: 'asc' } })
// everything the tool could change, in one string
async function world(orderId: string) {
  const o = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { paymentAttempts: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } })
  return JSON.stringify({
    order: [o.status, o.paymentStatus, o.paymentReviewReason, o.financialRevision, o.paidAt, (o.metadata as any)?.cancellation ?? null],
    attempts: o.paymentAttempts.map((a) => [a.id, a.status, a.stripeSessionId, a.failureReason, a.requestHash, a.expiresAt.toISOString(), a.amountReceivedCents]),
    sessions: (await k.sim.sessionsOf(orderId)).map((s) => [s.id, s.status]),
  })
}
const ops = async () => (await k.sim.oplog()).map((o) => o.op)
// what was sent to the provider that CREATES or CLOSES something, since `mark` (the number of operations when the scenario was set up: the set-up itself created the orphan page)
const providerWrites = async (mark: number) => (await ops()).slice(mark).filter((op) => op === 'create.call' || op === 'expire.call' || op.startsWith('create.executed') || op.startsWith('expire.executed'))

// ====================================================================================================================================================================
// the block, the dry-run, the apply
// ====================================================================================================================================================================
test('DRY RUN (the default of the command): says what would be done, WRITES NOTHING - no row, no audit event, nothing at the provider - and the customer is still told to wait', async () => {
  const b = await blockedReservation()
  const before = await world(b.order.id)
  const sessionsBefore = await k.sim.createdSessions()
  const r = await run(b, { dryRun: true, sessionId: b.sessionId })
  assert.equal(r.outcome, 'planned', r.message)
  assert.equal(r.code, 'dry_run')
  assert.equal(r.dryRun, true)
  assert.equal(r.sessionId, b.sessionId)
  assert.deepEqual(r.checks, { shape: true, sameId: true, paymentMode: true, namesAttempt: true, namesOrder: true, clientReference: true })
  assert.ok(r.actions.length >= 2, 'the actions are spelled out')
  assert.equal(r.after, null)
  assert.equal(await world(b.order.id), before, 'a dry run changed something')
  assert.deepEqual(await audits(), [], 'a dry run records no audit event')
  assert.deepEqual(await providerWrites(b.mark), [], 'a dry run asks nothing of the provider but to read')
  assert.equal(await k.sim.createdSessions(), sessionsBefore)
  const still = await k.payAgain(b.first)
  assert.equal(still.status, 503, 'nothing changed for the customer')
})

test('APPLY with the session given: the page is written down and becomes the open page of the order - the customer is given THAT page, no second page exists, the audit has the request and the result', async () => {
  const b = await blockedReservation()
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied', r.message)
  assert.equal(r.code, 'ok')
  assert.equal(r.before?.attempt.status, 'creating')
  assert.equal(r.before?.attempt.stripeSessionId, null)
  assert.equal(r.after?.attempt.status, 'open')
  assert.equal(r.after?.attempt.stripeSessionId, b.sessionId)
  assert.equal(r.endedAs, 'settled')
  assert.deepEqual(await providerWrites(b.mark), [], 'the page is kept: nothing is created and nothing is closed at the provider')
  assert.deepEqual(await k.sim.payable(b.order.id), [b.sessionId])
  // the customer: the same page, no new one
  const pay = await k.payAgain(b.first)
  assert.equal(pay.status, 200, pay.text)
  assert.equal(k.sessionIdOf(pay.json.url), b.sessionId)
  assert.equal(await k.sim.createdSessions(), 1)
  await k.assertClean('reconcile open')
  // the audit: before and after, attributable, no secret
  const trail = await audits()
  assert.deepEqual(trail.map((e) => e.action), [RECONCILE_AUDIT_REQUESTED, RECONCILE_AUDIT_FINISHED])
  for (const e of trail) {
    assert.equal(e.adminId, admin.id)
    assert.equal(e.targetType, 'PaymentAttempt')
    assert.equal(e.targetId, b.attemptId)
    assert.equal(e.requestMethod, 'CLI')
    assert.equal((e.metadata as any).sessionId, b.sessionId)
    assert.equal((e.metadata as any).orderId, b.order.id)
  }
  assert.equal((trail[1].metadata as any).outcome, 'applied')
  assert.equal((trail[1].metadata as any).before.attempt.status, 'creating')
  assert.equal((trail[1].metadata as any).after.attempt.status, 'open')
  assert.ok(!JSON.stringify(trail.map((e) => e.metadata)).match(/sk_(test|live)_|whsec_/), 'no secret in the audit')
})

test('IDEMPOTENT: the same apply again changes nothing and says so - also when several run at once; the page stays one', async () => {
  const b = await blockedReservation()
  const first = await run(b, { sessionId: b.sessionId })
  assert.equal(first.outcome, 'applied')
  const settled = await world(b.order.id)
  const again = await run(b, { sessionId: b.sessionId })
  assert.equal(again.outcome, 'already_done', again.message)
  assert.equal(again.code, 'unchanged')
  assert.equal(await world(b.order.id), settled)
  // at once, from a blocked reservation
  await k.fresh(); await k.prisma.adminAuditEvent.deleteMany()
  admin = await k.prisma.user.create({ data: { email: 'operator2@recon.invalid', passwordHash: 'x', role: 'admin', isAdmin: true } })
  const c = await blockedReservation()
  const results = await Promise.all([1, 2, 3, 4].map(() => run(c, { sessionId: c.sessionId })))
  assert.ok(results.every((x) => x.outcome === 'applied' || x.outcome === 'already_done'), JSON.stringify(results.map((x) => [x.outcome, x.code, x.message])))
  assert.ok(results.filter((x) => x.outcome === 'applied').length >= 1)
  const attempts = await k.attemptsOf(c.order.id)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].status, 'open')
  assert.equal(attempts[0].stripeSessionId, c.sessionId)
  assert.deepEqual(await k.sim.payable(c.order.id), [c.sessionId])
  await k.assertClean('reconcile concurrent')
  // the audit log is a hash chain: runs at once chain one after the other (every event points to the one before it), none is lost, none is duplicated
  const chain = await k.prisma.adminAuditEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  assert.equal(chain.length, 8, 'a request and a result for each of the four runs')
  assert.equal(new Set(chain.map((e) => e.eventHash)).size, 8)
  const byHash = new Map(chain.map((e) => [e.eventHash, e]))
  const heads = chain.filter((e) => !e.prevHash || !byHash.has(e.prevHash))
  assert.equal(heads.length, 1, 'one chain, not several')
  assert.equal(new Set(chain.map((e) => e.prevHash)).size, 8, 'no two events chain to the same predecessor')
})

// ====================================================================================================================================================================
// what the session turns out to be
// ====================================================================================================================================================================
test('the orphan page was PAID by the customer: the attempt is a payment on its way, no second page, the order is paid only by the verified payment handling', async () => {
  const b = await blockedReservation()
  const paid = await k.sim.pay(b.sessionId)
  assert.equal(paid.paid, true)
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied', r.message)
  const attempt = (await k.attemptsOf(b.order.id))[0]
  assert.equal(attempt.stripeSessionId, b.sessionId)
  assert.ok(['processing', 'paid'].includes(attempt.status), `the attempt is a payment (${attempt.status})`)
  assert.equal(await k.sim.createdSessions(), 1, 'no second page')
  assert.deepEqual(await k.sim.payable(b.order.id), [])
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: b.order.id } })
  assert.ok(['processing', 'paid'].includes(order.paymentStatus), `the order is ${order.paymentStatus}`)
  assert.ok(order.financialRevision >= 1, 'entering processing is a financial move')
  const customer = await k.payAgain(b.first)
  assert.notEqual(customer.status, 200, 'the customer is not given a page to pay again')
  await k.assertClean('reconcile complete')
})

test('the orphan page EXPIRED at the provider: the proof is written on the row, which keeps its identifier - and the customer can have a new page, because the history is now proved', async () => {
  const b = await blockedReservation()
  await k.sim.expire(b.sessionId)
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied', r.message)
  const [attempt] = await k.attemptsOf(b.order.id)
  assert.equal(attempt.stripeSessionId, b.sessionId)
  assert.equal(attempt.status, 'expired')
  assert.match(attempt.failureReason ?? '', /^provider_status:expired/)
  const pay = await k.payAgain(b.first)
  assert.equal(pay.status, 200, pay.text)
  assert.notEqual(k.sessionIdOf(pay.json.url), b.sessionId, 'a NEW page: the old one is proved closed')
  assert.equal(await k.sim.createdSessions(), 2)
  await k.assertClean('reconcile expired')
})

test('the order was CANCELLED while the orphan page was open: the page is closed AT THE PROVIDER with proof, not kept', async () => {
  const b = await blockedReservation()
  await k.prisma.printOrder.update({ where: { id: b.order.id }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied', r.message)
  assert.deepEqual(await k.sim.payable(b.order.id), [], 'the page is closed at the provider')
  const [attempt] = await k.attemptsOf(b.order.id)
  assert.equal(attempt.stripeSessionId, b.sessionId)
  assert.match(attempt.failureReason ?? '', /^closed_by_us:/)
  assert.ok((await ops()).some((op) => op === `expire.executed`), 'the provider was asked to close it')
})

test('the orphan page does not match the order any more (amount): it is closed at the provider with proof, the cause kept after it', async () => {
  const b = await blockedReservation()
  const session = (await k.sim.sessionsOf(b.order.id))[0]
  await k.sim.tamper(session.id, { amount_total: 1 })
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied', r.message)
  assert.deepEqual(await k.sim.payable(b.order.id), [])
  const [attempt] = await k.attemptsOf(b.order.id)
  assert.equal(attempt.status, 'failed')
  assert.equal(attempt.failureReason, 'closed_by_us:session_mismatch:amount')
})

test('LEGACY row: closed by the clock (stale_reservation) with no identifier, its page still OPEN at the provider - the identifier is written, the page is closed with proof, the row stays closed and keeps what it said; then a new page can be made', async () => {
  const b = await blockedReservation()
  await k.prisma.paymentAttempt.update({ where: { id: b.attemptId }, data: { status: 'expired', failureReason: 'stale_reservation' } })
  assert.deepEqual(await k.sim.payable(b.order.id), [b.sessionId], 'premise: the page is payable although the row says expired')
  const blocked = await k.payAgain(b.first)
  assert.equal(blocked.status, 503, 'premise: nothing is opened next to a row closed without proof')
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied', r.message)
  assert.deepEqual(await k.sim.payable(b.order.id), [])
  const [row] = await k.attemptsOf(b.order.id)
  assert.equal(row.status, 'expired')
  assert.equal(row.stripeSessionId, b.sessionId)
  assert.match(row.failureReason ?? '', /^closed_by_us:.*\(was stale_reservation\)$/)
  const pay = await k.payAgain(b.first)
  assert.equal(pay.status, 200, pay.text)
  assert.equal(await k.sim.createdSessions(), 2)
  await k.assertClean('reconcile legacy')
})

// ====================================================================================================================================================================
// finding the session by looking: positive matches only
// ====================================================================================================================================================================
test('DISCOVER finds the one session that names the attempt among others, across several pages, reads it, identifies it and applies it', async () => {
  const b = await blockedReservation()
  for (let i = 0; i < 5; i++) await k.sim.seedSession({ orderId: `other_order_${i}`, attemptId: `other_attempt_${i}`, legacy: true })
  k.sim.options.listPageCap = 2
  const r = await run(b, { discover: true })
  assert.equal(r.outcome, 'applied', r.message)
  assert.equal(r.sessionId, b.sessionId)
  assert.ok(r.discovery && r.discovery.pages >= 3, `several pages were read (${r.discovery?.pages})`)
  assert.equal(r.discovery?.complete, true)
  assert.deepEqual(r.discovery?.matches, [b.sessionId])
  assert.equal(r.discovery && r.discovery.examined >= 6, true)
  const [attempt] = await k.attemptsOf(b.order.id)
  assert.equal(attempt.status, 'open')
  assert.equal(attempt.stripeSessionId, b.sessionId)
  const trail = await audits()
  assert.deepEqual((trail[0].metadata as any).discovery.matches, [b.sessionId], 'the audit says how the session was found')
  await k.assertClean('discover')
})

test('DISCOVER finds NOTHING (the request never reached the provider): no evidence, NOTHING is changed, the attempt stays blocked - a complete listing is not proof either', async () => {
  k.sim.faults.createUnreachable = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  assert.ok(first.status === 502 || first.status === 503)
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  await k.prisma.paymentAttempt.update({ where: { id: reservation.id }, data: { requestHash: null } })
  assert.equal(await k.sim.createdSessions(), 0, 'premise: no page exists')
  const before = await world(order.id)
  const mark = (await ops()).length
  const r = await run({ attemptId: reservation.id }, { discover: true })
  assert.equal(r.outcome, 'no_evidence', r.message)
  assert.equal(r.code, 'NO_EVIDENCE')
  assert.equal(r.discovery?.complete, true, 'the listing was complete and found nothing')
  assert.deepEqual(r.discovery?.matches, [])
  assert.match(r.message, /proves NOTHING/)
  assert.equal(await world(order.id), before, 'no evidence changed something')
  const after = (await k.attemptsOf(order.id))[0]
  assert.equal(after.status, 'creating', 'the reservation is NOT released: a listing that shows nothing is not proof of nothing')
  assert.equal((await k.payAgain({ ...first, orderId: order.id })).status, 503)
  assert.deepEqual(await providerWrites(mark), [])
  assert.deepEqual(await audits(), [], 'nothing was done, so nothing is recorded as done')
})

test('DISCOVER over a listing that is NOT complete (more pages than the tool reads): nothing found changes nothing; and says the listing was not complete', async () => {
  k.sim.faults.createUnreachable = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  const [reservation] = await k.attemptsOf(order.id)
  for (let i = 0; i < DISCOVERY_MAX_PAGES + 2; i++) await k.sim.seedSession({ orderId: `other_order_${i}`, attemptId: `other_attempt_${i}`, legacy: true })
  k.sim.options.listPageCap = 1
  const before = await world(order.id)
  const r = await run({ attemptId: reservation.id }, { discover: true })
  assert.equal(r.outcome, 'no_evidence', r.message)
  assert.equal(r.discovery?.complete, false)
  assert.equal(r.discovery?.pages, DISCOVERY_MAX_PAGES)
  assert.match(r.message, /NOT complete/)
  assert.equal(await world(order.id), before)
  assert.equal((await k.attemptsOf(order.id))[0].status, 'creating')
  void first
})

test('DISCOVER finds TWO sessions that name the attempt: refused - which one is the page is for a person; nothing is changed', async () => {
  const b = await blockedReservation()
  const second = await k.sim.seedSession({ orderId: b.order.id, attemptId: b.attemptId, legacy: true })
  const before = await world(b.order.id)
  const r = await run(b, { discover: true })
  assert.equal(r.outcome, 'refused', r.message)
  assert.equal(r.code, 'AMBIGUOUS_EVIDENCE')
  assert.deepEqual(r.discovery?.matches, [b.sessionId, second].sort())
  assert.equal(await world(b.order.id), before)
  assert.deepEqual(await providerWrites(b.mark), [])
})

test('DISCOVER when the provider can not be asked: refused, nothing changed', async () => {
  const b = await blockedReservation()
  k.sim.faults.listUnreachable = 1
  const before = await world(b.order.id)
  const r = await run(b, { discover: true })
  assert.equal(r.outcome, 'refused')
  assert.equal(r.code, 'PROVIDER_UNAVAILABLE')
  assert.equal(await world(b.order.id), before)
})

// ====================================================================================================================================================================
// identification: it must be THE session
// ====================================================================================================================================================================
for (const [what, patch] of [
  ['of another attempt', { metadata: { orderId: 'ORDER', attemptId: 'another_attempt' } }],
  ['with no attempt in its metadata', { metadata: { orderId: 'ORDER' } }],
  ['of another order (metadata)', { metadata: { orderId: 'another_order', attemptId: 'ATTEMPT' } }],
  ['of another order (client reference)', { client_reference_id: 'another_order' }],
  ['not in payment mode', { mode: 'subscription' }],
] as Array<[string, Record<string, unknown>]>) {
  test(`NOT IDENTIFIED: the session given is ${what}: refused, nothing changed, nothing recorded`, async () => {
    const b = await blockedReservation()
    const fill = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v) => (v === 'ORDER' ? b.order.id : v === 'ATTEMPT' ? b.attemptId : v)))
    await k.sim.tamper(b.sessionId, fill(patch) as Record<string, unknown>)
    const before = await world(b.order.id)
    const r = await run(b, { sessionId: b.sessionId })
    assert.equal(r.outcome, 'refused', r.message)
    assert.equal(r.code, 'SESSION_NOT_IDENTIFIED')
    assert.equal(Object.values(r.checks ?? {}).every(Boolean), false)
    assert.equal(await world(b.order.id), before)
    assert.deepEqual(await audits(), [])
    assert.deepEqual(await providerWrites(b.mark), [])
  })
}

test('REFUSED before anything: a malformed identifier, no session at all, an attempt that does not exist, an attempt that is already a payment, a session held by ANOTHER attempt, another session than the one the attempt holds', async () => {
  const b = await blockedReservation()
  const before = await world(b.order.id)
  assert.equal((await run(b, { sessionId: 'pi_123' })).code, 'SESSION_ID_INVALID')
  assert.equal((await run(b, { sessionId: 'cs_x/../y' })).code, 'SESSION_ID_INVALID')
  assert.equal((await run(b)).code, 'NO_SESSION_GIVEN')
  assert.equal((await reconcileAttempt({ attemptId: 'does-not-exist', sessionId: b.sessionId, operatorId: admin.id, dryRun: false })).code, 'ATTEMPT_NOT_FOUND')
  assert.equal(await world(b.order.id), before)
  // the session is held by another attempt (of another order)
  const other = await k.startCheckout(k.newBrowser())
  const held = await run(b, { sessionId: other.sessionId })
  assert.equal(held.code, 'SESSION_CONFLICT')
  // the attempt holds another session than the one given
  await k.prisma.paymentAttempt.update({ where: { id: b.attemptId }, data: { stripeSessionId: 'cs_test_already_here' } })
  const differs = await run(b, { sessionId: b.sessionId })
  assert.equal(differs.code, 'SESSION_CONFLICT')
  assert.equal((await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: b.attemptId } })).stripeSessionId, 'cs_test_already_here', 'never overwritten')
  // an attempt that is a payment is not this tool's
  await k.prisma.paymentAttempt.update({ where: { id: b.attemptId }, data: { stripeSessionId: null, status: 'processing' } })
  assert.equal((await run(b, { sessionId: b.sessionId })).code, 'NOT_RECONCILABLE')
  assert.deepEqual(await audits(), [])
  void other
})

// ====================================================================================================================================================================
// who may, and what happens when something goes wrong
// ====================================================================================================================================================================
test('AUTHORIZATION: only an administrator who exists and is not suspended - not staff, not a customer, not an unknown id, not nobody; and nothing was even read from the provider', async () => {
  const b = await blockedReservation()
  const staff = await k.prisma.user.create({ data: { email: 'staff@recon.invalid', passwordHash: 'x', role: 'staff' } })
  const customer = await k.prisma.user.create({ data: { email: 'customer@recon.invalid', passwordHash: 'x', role: 'customer' } })
  const suspended = await k.prisma.user.create({ data: { email: 'suspended@recon.invalid', passwordHash: 'x', role: 'admin', isAdmin: true, isSuspended: true } })
  const before = await world(b.order.id)
  const opsBefore = (await ops()).length
  for (const operatorId of [staff.id, customer.id, suspended.id, 'no-such-user', '']) {
    for (const dryRun of [true, false]) {
      const r = await reconcileAttempt({ attemptId: b.attemptId, sessionId: b.sessionId, operatorId, dryRun })
      assert.equal(r.outcome, 'refused')
      assert.equal(r.code, 'OPERATOR_NOT_AUTHORIZED', `${operatorId || '(empty)'} dryRun=${dryRun}`)
    }
  }
  assert.equal(await world(b.order.id), before)
  assert.equal((await ops()).length, opsBefore, 'the provider was not asked anything')
  assert.deepEqual(await audits(), [])
  // an administrator by the old flag alone is one too (the same rule as the routes)
  const flagged = await k.prisma.user.create({ data: { email: 'flag@recon.invalid', passwordHash: 'x', role: 'customer', isAdmin: true } })
  assert.equal((await reconcileAttempt({ attemptId: b.attemptId, sessionId: b.sessionId, operatorId: flagged.id, dryRun: true })).outcome, 'planned')
})

test('FAIL CLOSED: the provider can not be read -> refused, nothing changed, nothing recorded', async () => {
  const b = await blockedReservation()
  k.sim.faults.retrieveUnreachable = 1
  const before = await world(b.order.id)
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'refused')
  assert.equal(r.code, 'PROVIDER_UNAVAILABLE')
  assert.equal(await world(b.order.id), before)
  assert.deepEqual(await audits(), [])
})

test('FAIL CLOSED: the request can not be recorded in the audit log -> nothing is done (the page is not even closed or written down)', async () => {
  const b = await blockedReservation()
  auditFailure = RECONCILE_AUDIT_REQUESTED
  const before = await world(b.order.id)
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'refused')
  assert.equal(r.code, 'AUDIT_UNAVAILABLE')
  assert.equal(await world(b.order.id), before)
  assert.deepEqual(await providerWrites(b.mark), [])
  auditFailure = null
  assert.equal((await run(b, { sessionId: b.sessionId })).outcome, 'applied', 'and it works once the audit log does')
})

test('the audit of the RESULT failing does not undo or hide what was done: the result is reported, the request stays on record', async () => {
  const b = await blockedReservation()
  auditFailure = RECONCILE_AUDIT_FINISHED
  const r = await run(b, { sessionId: b.sessionId })
  assert.equal(r.outcome, 'applied')
  assert.equal((await audits()).map((e) => e.action).join(), RECONCILE_AUDIT_REQUESTED)
})

test('PARTIAL, never "done": the closing of a page that must not stay open can not be proved -> the identifier is recorded, the row stays live, nothing is released, and it says so; run again, it finishes', async () => {
  const b = await blockedReservation()
  await k.prisma.printOrder.update({ where: { id: b.order.id }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  k.sim.faults.expireUnreachable = 50
  const r = await run(b, { sessionId: b.sessionId })
  k.sim.faults.expireUnreachable = 0
  assert.equal(r.outcome, 'partial', r.message)
  assert.equal(r.code, 'PAGE_NOT_CLOSED')
  const [attempt] = await k.attemptsOf(b.order.id)
  assert.equal(attempt.stripeSessionId, b.sessionId, 'what was committed (the identifier) is kept')
  assert.ok(['creating', 'open'].includes(attempt.status), `the row is NOT closed without proof (${attempt.status})`)
  assert.deepEqual(await k.sim.payable(b.order.id), [b.sessionId], 'and the page is still there to be closed - and the report lists it')
  const q6 = (await k.prisma.$queryRawUnsafe(
    `SELECT a."id" FROM "PaymentAttempt" a JOIN "PrintOrder" o ON o."id" = a."orderId" WHERE a."status" IN ('creating','open') AND a."orderId" = '${b.order.id}' AND o."status" <> 'awaiting_payment'`)) as Array<{ id: string }>
  assert.deepEqual(q6.map((x) => x.id), [b.attemptId])
  assert.deepEqual((await audits()).map((e) => e.action), [RECONCILE_AUDIT_REQUESTED, RECONCILE_AUDIT_FINISHED])
  assert.equal(((await audits())[1].metadata as any).outcome, 'partial')
  // run again once the provider answers: it ends the job
  const again = await run(b, { sessionId: b.sessionId })
  assert.equal(again.outcome, 'applied', again.message)
  assert.deepEqual(await k.sim.payable(b.order.id), [])
  const closed = (await k.attemptsOf(b.order.id))[0]
  assert.match(closed.failureReason ?? '', /^closed_by_us:/)
})

// ====================================================================================================================================================================
// the tool is what it says: a guard on the source
// ====================================================================================================================================================================
test('GUARD: nothing in the tool writes a row by hand, deletes, creates a page, or takes a listing as proof of absence', () => {
  const lib = readFileSync(new URL('../../lib/checkout-reconcile.ts', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../../scripts/checkout-reconcile.ts', import.meta.url), 'utf8')
  const code = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [name, text] of [['lib/checkout-reconcile.ts', code(lib)], ['scripts/checkout-reconcile.ts', code(cli)]] as const) {
    for (const forbidden of [/\.paymentAttempt\.(update|updateMany|upsert|delete|deleteMany|create|createMany)\b/, /\.printOrder\.(update|updateMany|upsert|delete|deleteMany|create)\b/, /\$executeRaw/, /\$queryRaw/, /\bDELETE\b/, /\bUPDATE\b/, /sessions\.create\b/, /sessions\.expire\b/]) {
      assert.doesNotMatch(text, forbidden, `${name} must not contain ${forbidden}`)
    }
  }
  // the one write to a row goes through the settlement of the order; the one place a listing is read only collects positive matches
  assert.match(code(lib), /applyKnownSession\(/)
  const text = code(lib)
  const discover = text.slice(text.indexOf('export async function discoverSessions'), text.indexOf('export type ReconcileInput'))
  assert.ok(discover.length > 200 && discover.length < 2500, `the slice is the function (${discover.length})`)
  assert.doesNotMatch(discover, /failed|expired|release|creating|prisma/, 'discoverSessions only collects matches')
  // a dry run is a parameter with no default in the function, a default in the command
  assert.match(lib, /dryRun: boolean/)
  assert.match(cli, /dryRun: !flags\.has\('--apply'\)/)
})

// ====================================================================================================================================================================
// the command
// ====================================================================================================================================================================
function cli(args: string[]) {
  try {
    return { code: 0, out: execFileSync('npx', ['tsx', 'scripts/checkout-reconcile.ts', ...args], { cwd: process.cwd(), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }
  } catch (error: any) {
    return { code: error.status ?? 1, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') }
  }
}
test('COMMAND: wrong use is refused with status 64 before anything is read; an operator who is not an administrator is refused with status 2 and JSON; nothing is changed', async () => {
  const b = await blockedReservation()
  const before = await world(b.order.id)
  for (const args of [[], ['--attempt', b.attemptId], ['--operator', admin.id], ['--attempt', b.attemptId, '--operator', admin.id, '--apply', '--dry-run'], ['--attempt', b.attemptId, '--operator', admin.id, '--aply'], ['--attempt', b.attemptId, '--attempt', 'x', '--operator', admin.id], ['--attempt', b.attemptId, '--operator']]) {
    const r = cli(args)
    assert.equal(r.code, 64, `${args.join(' ')}: ${r.out}${r.err}`)
    assert.equal(r.out, '', 'nothing on stdout when the use is wrong')
  }
  const refused = cli(['--attempt', b.attemptId, '--operator', 'nobody@recon.invalid', '--session', b.sessionId, '--apply'])
  assert.equal(refused.code, 2, `${refused.out}${refused.err}`)
  const json = JSON.parse(refused.out)             // stdout is the result and nothing else
  assert.equal(json.code, 'OPERATOR_NOT_AUTHORIZED')
  assert.equal(json.outcome, 'refused')
  assert.equal(await world(b.order.id), before)
  assert.deepEqual(await audits(), [])
})
