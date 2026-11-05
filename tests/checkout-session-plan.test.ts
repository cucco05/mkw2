// DR-13 phase 2: the pure decision about the payment page of an order (lib/checkout-session-plan.ts), over EVERY combination of up to three attempts, nine kinds of order and the moments
// that matter. A property is a sentence that must be true of all of them; a table is a case someone should be able to read.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FRESH_SAFETY_MS, JOIN_WINDOW_MS, KNOWN_ATTEMPT_STATUSES, LOCAL_REFUSAL_NAME, MAX_ATTEMPTS_PER_ORDER, MAX_FUTURE_SKEW_MS, PROVEN_NOT_CREATED, PROVIDER_MIN_EXPIRY_MS, REPLAY_RETENTION_MS,
  REUSE_MARGIN_MS, SESSION_TTL_MS, classifyCloseOutcome, classifyCreateError, classifySessionStatus, closedWithIdUnproven, closedWithoutProof, closingIsProved, mismatchClosureReason, planNextStep, replayMode, stampProof,
  type PlanAttempt, type PlanOrder,
} from '../lib/checkout-session-plan'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const at = (offsetMs: number) => new Date(NOW + offsetMs)

// ---- the orders ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const base: PlanOrder = { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null }
const orders: Array<{ name: string; order: PlanOrder; payable: boolean }> = [
  { name: 'payable', order: base, payable: true },
  { name: 'paid', order: { ...base, paymentStatus: 'paid', status: 'queued' }, payable: false },
  { name: 'free', order: { ...base, paymentStatus: 'free' }, payable: false },
  { name: 'processing', order: { ...base, paymentStatus: 'processing' }, payable: false },
  { name: 'cancelled', order: { ...base, status: 'cancelled', paymentStatus: 'canceled' }, payable: false },
  { name: 'in production', order: { ...base, status: 'printing' }, payable: false },
  { name: 'under review', order: { ...base, paymentReviewReason: 'amount' }, payable: false },
  { name: 'paidAt set', order: { ...base, paidAt: at(-HOUR) }, payable: false },
  { name: 'payment intent linked', order: { ...base, stripePaymentIntentId: 'pi_test_123' }, payable: false },
]

// ---- the attempts (each archetype is one situation the database can be in) ------------------------------------------------------------------------------------------------------------
type Archetype = { name: string; make: (id: string) => PlanAttempt; kind: 'creating' | 'open' | 'money' | 'closed_proved' | 'closed_to_prove' | 'closed_unproved' | 'closed_never_sent' | 'unknown'; hasSession: boolean }
const row = (id: string, status: string, over: Partial<PlanAttempt> = {}): PlanAttempt => ({ id, status, stripeSessionId: null, failureReason: null, amountReceivedCents: null, createdAt: at(-10 * SEC), expiresAt: at(SESSION_TTL_MS - 10 * SEC), ...over })
const archetypes: Archetype[] = [
  { name: 'creating, young', kind: 'creating', hasSession: false, make: (id) => row(id, 'creating') },
  { name: 'creating, an hour old', kind: 'creating', hasSession: false, make: (id) => row(id, 'creating', { createdAt: at(-HOUR), expiresAt: at(-HOUR + SESSION_TTL_MS) }) },
  { name: 'creating, 3 days old', kind: 'creating', hasSession: false, make: (id) => row(id, 'creating', { createdAt: at(-72 * HOUR), expiresAt: at(-72 * HOUR + SESSION_TTL_MS) }) },
  { name: 'creating, with an adopted session id', kind: 'creating', hasSession: true, make: (id) => row(id, 'creating', { stripeSessionId: `cs_${id}`, createdAt: at(-5 * MIN) }) },
  { name: 'open, 10 minutes left', kind: 'open', hasSession: true, make: (id) => row(id, 'open', { stripeSessionId: `cs_${id}`, expiresAt: at(10 * MIN) }) },
  { name: 'open, 20 minutes left', kind: 'open', hasSession: true, make: (id) => row(id, 'open', { stripeSessionId: `cs_${id}`, expiresAt: at(20 * MIN) }) },
  { name: 'open, 30 s left (in the margin)', kind: 'open', hasSession: true, make: (id) => row(id, 'open', { stripeSessionId: `cs_${id}`, expiresAt: at(30 * SEC) }) },
  { name: 'open, past its expiry', kind: 'open', hasSession: true, make: (id) => row(id, 'open', { stripeSessionId: `cs_${id}`, expiresAt: at(-5 * MIN) }) },
  { name: 'open, expiry unreadable', kind: 'open', hasSession: true, make: (id) => row(id, 'open', { stripeSessionId: `cs_${id}`, expiresAt: null }) },
  { name: 'open, no Stripe identifier', kind: 'open', hasSession: false, make: (id) => row(id, 'open', { expiresAt: at(10 * MIN) }) },
  { name: 'processing', kind: 'money', hasSession: true, make: (id) => row(id, 'processing', { stripeSessionId: `cs_${id}` }) },
  { name: 'paid', kind: 'money', hasSession: true, make: (id) => row(id, 'paid', { stripeSessionId: `cs_${id}` }) },
  { name: 'mismatch', kind: 'money', hasSession: true, make: (id) => row(id, 'mismatch', { stripeSessionId: `cs_${id}` }) },
  { name: 'expired, shown by the provider', kind: 'closed_proved', hasSession: true, make: (id) => row(id, 'expired', { stripeSessionId: `cs_${id}`, failureReason: 'provider_status:expired' }) },
  { name: 'expired, closed by us with proof', kind: 'closed_proved', hasSession: true, make: (id) => row(id, 'expired', { stripeSessionId: `cs_${id}`, failureReason: 'closed_by_us:replaced' }) },
  // a page that did not match the order and was closed WITH the provider's proof: the proof first, the cause after it (follow-up: `session_mismatch:` alone is not a proof)
  { name: 'failed, a page that did not match, closed by us with proof (the cause is kept)', kind: 'closed_proved', hasSession: true, make: (id) => row(id, 'failed', { stripeSessionId: `cs_${id}`, failureReason: 'closed_by_us:session_mismatch:amount' }) },
  { name: 'failed, a page that did not match, shown closed by the provider (the cause is kept)', kind: 'closed_proved', hasSession: true, make: (id) => row(id, 'failed', { stripeSessionId: `cs_${id}`, failureReason: 'provider_status:expired (session_mismatch:amount)' }) },
  // closed rows WITH an identifier and without the provider's word that the page is closed: the identifier is not a proof (follow-up P0-B), they are asked about first
  { name: 'failed, the payment failed (identifier, no proof of closing)', kind: 'closed_to_prove', hasSession: true, make: (id) => row(id, 'failed', { stripeSessionId: `cs_${id}`, failureReason: 'payment_failed' }) },
  { name: 'failed, the payment was cancelled (identifier, no proof of closing)', kind: 'closed_to_prove', hasSession: true, make: (id) => row(id, 'failed', { stripeSessionId: `cs_${id}`, failureReason: 'payment_canceled' }) },
  { name: 'expired, no reason (identifier, no proof of closing)', kind: 'closed_to_prove', hasSession: true, make: (id) => row(id, 'expired', { stripeSessionId: `cs_${id}` }) },
  // the row the code that was PUBLISHED left for an open page that no longer matched the order: it closed the row, named the cause, and never closed the page
  { name: 'failed, a page that did not match - legacy: the row only names the cause (identifier, no proof of closing)', kind: 'closed_to_prove', hasSession: true, make: (id) => row(id, 'failed', { stripeSessionId: `cs_${id}`, failureReason: 'session_mismatch:amount' }) },
  { name: 'expired, stale reservation of the old code (no identifier)', kind: 'closed_unproved', hasSession: false, make: (id) => row(id, 'expired', { failureReason: 'stale_reservation', createdAt: at(-72 * HOUR), expiresAt: at(-72 * HOUR + SESSION_TTL_MS) }) },
  { name: 'expired, stale reservation of the old code (with an identifier adopted later)', kind: 'closed_to_prove', hasSession: true, make: (id) => row(id, 'expired', { stripeSessionId: `cs_${id}`, failureReason: 'stale_reservation' }) },
  { name: 'failed, a Stripe error of the old code (no identifier)', kind: 'closed_unproved', hasSession: false, make: (id) => row(id, 'failed', { failureReason: 'StripeInvalidRequestError:parameter_invalid_integer' }) },
  { name: 'failed, open without a session (old code)', kind: 'closed_unproved', hasSession: false, make: (id) => row(id, 'failed', { failureReason: 'open_without_session' }) },
  { name: 'expired, no identifier, no reason', kind: 'closed_unproved', hasSession: false, make: (id) => row(id, 'expired') },
  { name: 'failed, refused here before any call (proved never sent)', kind: 'closed_never_sent', hasSession: false, make: (id) => row(id, 'failed', { failureReason: 'local_refusal:lines_do_not_add_up' }) },
  { name: 'failed, a rejection shown to create nothing', kind: 'closed_never_sent', hasSession: false, make: (id) => row(id, 'failed', { failureReason: 'provider_rejected:StripeInvalidRequestError:x' }) },
  { name: 'a status nobody knows', kind: 'unknown', hasSession: true, make: (id) => row(id, 'frobnicating', { stripeSessionId: `cs_${id}` }) },
]

function* combinations(size: number, from = 0): Generator<number[]> {
  if (size === 0) { yield []; return }
  for (let i = from; i < archetypes.length; i++) for (const rest of combinations(size - 1, i)) yield [i, ...rest]
}
function* everyAttemptSet(): Generator<{ label: string; attempts: PlanAttempt[]; picked: Archetype[] }> {
  for (let size = 0; size <= 3; size++) {
    for (const combo of combinations(size)) {
      const picked = combo.map((i) => archetypes[i])
      yield { label: picked.map((a) => a.name).join(' + ') || '(no attempts)', attempts: picked.map((a, index) => a.make(`a${index}`)), picked }
    }
  }
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !(value instanceof Date)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v) }
  return value
}

// ====================================================================================================================================================================
// properties over everything
// ====================================================================================================================================================================
test('PROPERTY: a new page is opened ONLY when nothing is alive, nothing is in doubt and nothing is being paid - and in that case it always is', () => {
  let cases = 0
  for (const { label, attempts, picked } of everyAttemptSet()) {
    for (const { name, order, payable } of orders) {
      const plan = planNextStep({ order, attempts: deepFreeze(structuredClone(attempts)), now: NOW })
      cases++
      const clear = payable && picked.every((a) => a.kind === 'closed_proved' || a.kind === 'closed_never_sent')
      if (plan.kind === 'create') {
        assert.ok(clear, `create although the situation is not clear: order ${name}, attempts ${label}`)
        assert.ok(attempts.length < MAX_ATTEMPTS_PER_ORDER)
      }
      if (clear) assert.equal(plan.kind, attempts.length >= MAX_ATTEMPTS_PER_ORDER ? 'too_many_attempts' : 'create', `a clear situation was not opened: order ${name}, attempts ${label} -> ${JSON.stringify(plan)}`)
    }
  }
  assert.ok(cases > 15_000, `only ${cases} cases were looked at`)
})

test('PROPERTY: a payment of the order (paid, being confirmed, not matching) or an order that forbids it blocks everything - no page, no replay, no retire', () => {
  for (const { label, attempts, picked } of everyAttemptSet()) {
    for (const { name, order, payable } of orders) {
      const plan = planNextStep({ order, attempts, now: NOW })
      const hasMoney = picked.some((a) => a.kind === 'money')
      if (!payable || hasMoney) assert.equal(plan.kind, 'blocked', `not blocked: order ${name}, attempts ${label} -> ${JSON.stringify(plan)}`)
    }
  }
})

test('PROPERTY: a reservation is replayed whatever its age, and the plan does not depend on the time (a reservation is never closed by the clock)', () => {
  const moments = [NOW - HOUR, NOW, NOW + 31 * MIN, NOW + 25 * HOUR, NOW + 72 * HOUR]
  let looked = 0
  for (const { label, attempts, picked } of everyAttemptSet()) {
    if (!picked.some((a) => a.kind === 'creating') || picked.some((a) => a.kind === 'money' || a.kind === 'unknown' || a.kind === 'closed_to_prove')) continue   // (a closed row to prove is asked about FIRST: see the PROVE properties)
    const plans = moments.map((now) => planNextStep({ order: base, attempts, now }))
    looked++
    for (const plan of plans) assert.equal(plan.kind, 'replay', `a reservation was not replayed: ${label} -> ${JSON.stringify(plan)}`)
    assert.deepEqual(plans.map((p) => (p as { attemptId: string }).attemptId), plans.map(() => (plans[0] as { attemptId: string }).attemptId), `the choice depends on the time: ${label}`)
  }
  assert.ok(looked > 500)
})

test('PROPERTY: nothing is opened over a row that was closed without proof - not when it is old, not when everything else is clear (mandate B)', () => {
  for (const { label, attempts, picked } of everyAttemptSet()) {
    if (!picked.some((a) => a.kind === 'closed_unproved' || a.kind === 'closed_to_prove')) continue
    for (const now of [NOW, NOW + 3 * HOUR, NOW + 30 * 24 * HOUR]) {
      const plan = planNextStep({ order: base, attempts, now })
      assert.notEqual(plan.kind, 'create', `a page was opened over an unproved row: ${label} at +${(now - NOW) / HOUR} h`)
      assert.notEqual(plan.kind, 'too_many_attempts', `an unproved row was reported as "too many attempts" instead of being named: ${label}`)
    }
  }
})

test('PROPERTY: reuse and retire only ever touch a page that is open and has a Stripe identifier, and never when a payment, a reservation or an unknown status is in the way', () => {
  for (const { label, attempts, picked } of everyAttemptSet()) {
    const plan = planNextStep({ order: base, attempts, now: NOW })
    const byId = new Map(attempts.map((a) => [a.id, a]))
    if (plan.kind === 'reuse') {
      const a = byId.get(plan.attemptId)!
      assert.equal(a.status, 'open')
      assert.ok(a.stripeSessionId)
      assert.ok(new Date(a.expiresAt as Date).getTime() > NOW, `a page with no time left was handed out: ${label}`)
      assert.equal(attempts.filter((x) => x.status === 'open').length, 1, `twins: ${label}`)
      assert.ok(!picked.some((p) => ['creating', 'money', 'unknown', 'closed_to_prove'].includes(p.kind)), label)
    }
    if (plan.kind === 'retire') {
      assert.ok(plan.attemptIds.length > 0)
      for (const id of plan.attemptIds) { const a = byId.get(id)!; assert.equal(a.status, 'open'); assert.ok(a.stripeSessionId, `retire of a page with no identifier: ${label}`) }
      assert.ok(!picked.some((p) => ['creating', 'money', 'unknown', 'closed_to_prove'].includes(p.kind)), label)
    }
    if (plan.kind === 'replay') assert.equal(byId.get(plan.attemptId)!.status, 'creating')
  }
})

test('PROPERTY: a page is never closed to make room for one that may not be opened (nothing replaces it while something is in doubt)', () => {
  for (const { label, attempts, picked } of everyAttemptSet()) {
    if (!picked.some((a) => a.kind === 'closed_unproved') || picked.some((a) => ['creating', 'money', 'unknown', 'closed_to_prove'].includes(a.kind))) continue
    const open = attempts.filter((a) => a.status === 'open')
    if (open.length === 0) continue
    const plan = planNextStep({ order: base, attempts, now: NOW })
    if (plan.kind !== 'retire') continue
    // what may be closed: twins, or pages that have no time at all
    const closing = new Set(plan.attemptIds)
    const keepers = open.filter((a) => !closing.has(a.id))
    const alive = open.filter((a) => new Date(a.expiresAt as Date).getTime() > NOW)
    assert.ok(alive.length === 0 || keepers.length === 1, `the only live page was closed while a replacement is not allowed: ${label} -> ${JSON.stringify(plan)}`)
  }
})

test('PROPERTY: the order of the rows does not matter, the facts are not touched, and the same facts give the same plan', () => {
  for (const { label, attempts } of everyAttemptSet()) {
    const frozen = deepFreeze(structuredClone(attempts))
    for (const { order } of orders) {
      const a = planNextStep({ order, attempts: frozen, now: NOW })
      const b = planNextStep({ order, attempts: [...frozen].reverse(), now: NOW })
      assert.deepEqual(b.kind === 'retire' && a.kind === 'retire' ? { ...b, attemptIds: [...b.attemptIds].sort() } : b, a.kind === 'retire' && b.kind === 'retire' ? { ...a, attemptIds: [...a.attemptIds].sort() } : a, `the order of the rows changed the plan: ${label}`)
      assert.deepEqual(planNextStep({ order, attempts: frozen, now: NOW }), a)
    }
  }
})

test('PROPERTY: adding a payment, a reservation or an unproved row to ANY situation can only make the plan stricter, never open a page', () => {
  const extras = archetypes.filter((a) => ['money', 'creating', 'closed_unproved', 'closed_to_prove', 'unknown'].includes(a.kind))
  for (const { label, attempts } of everyAttemptSet()) {
    if (attempts.length > 2) continue
    for (const extra of extras) {
      const plan = planNextStep({ order: base, attempts: [...attempts, extra.make('extra')], now: NOW })
      assert.notEqual(plan.kind, 'create', `adding "${extra.name}" to ${label} opened a page`)
    }
  }
})

test('PROPERTY (follow-up P0-B): a closed row with an identifier and no proof of closing is ASKED ABOUT - all such rows, together, before anything else is decided, whatever else is alive, reserved or in doubt', () => {
  let proved = 0
  for (const { label, attempts, picked } of everyAttemptSet()) {
    for (const { name, order, payable } of orders) {
      const plan = planNextStep({ order, attempts: deepFreeze(structuredClone(attempts)), now: NOW })
      const toProve = attempts.filter((a) => closedWithIdUnproven(a)).map((a) => a.id)
      const kinds = picked.map((a) => a.kind)
      const blockedByOther = !payable || kinds.includes('money') || kinds.includes('unknown')
      if (toProve.length > 0 && !blockedByOther) {
        proved++
        assert.deepEqual(plan, { kind: 'prove', attemptIds: [...toProve].sort() }, `rows to prove were not asked about: order ${name}, attempts ${label} -> ${JSON.stringify(plan)}`)
      } else {
        assert.notEqual(plan.kind, 'prove', `nothing to prove, or the order forbids anything: order ${name}, attempts ${label} -> ${JSON.stringify(plan)}`)
      }
    }
  }
  assert.ok(proved > 1000, `only ${proved} cases were looked at`)
})

test('PROPERTY (follow-up P0-B): a row that carries the provider\'s proof of closing is never asked about again, and a row is "to prove" exactly when it is closed, has an identifier and no proof', () => {
  for (const { label, attempts } of everyAttemptSet()) {
    for (const a of attempts) {
      const expected = (a.status === 'expired' || a.status === 'failed') && Boolean(a.stripeSessionId) && !closingIsProved(a.failureReason)
      assert.equal(closedWithIdUnproven(a), expected, `${label}: ${a.id}`)
      if (closingIsProved(a.failureReason)) assert.equal(closedWithIdUnproven(a), false)
    }
  }
})

// ====================================================================================================================================================================
// cases someone should be able to read
// ====================================================================================================================================================================
const plan = (attempts: PlanAttempt[], order: PlanOrder = base, now = NOW) => planNextStep({ order, attempts, now })
const find = (name: string) => archetypes.find((a) => a.name === name)!

test('a page with 10 minutes left is handed out again; with 30 s left it is closed at the provider (the margin is 60 s)', () => {
  assert.deepEqual(plan([find('open, 10 minutes left').make('a')]), { kind: 'reuse', attemptId: 'a' })
  assert.deepEqual(plan([find('open, 30 s left (in the margin)').make('a')]), { kind: 'retire', attemptIds: ['a'] })
  assert.deepEqual(plan([row('a', 'open', { stripeSessionId: 'cs_a', expiresAt: at(REUSE_MARGIN_MS + 1) })]), { kind: 'reuse', attemptId: 'a' })
  assert.deepEqual(plan([row('a', 'open', { stripeSessionId: 'cs_a', expiresAt: at(REUSE_MARGIN_MS) })]), { kind: 'retire', attemptIds: ['a'] }, 'exactly 60 s left is in the margin')
})

test('twin pages: the one with the most time is kept, the others are closed first', () => {
  const p = plan([row('a', 'open', { stripeSessionId: 'cs_a', expiresAt: at(10 * MIN) }), row('b', 'open', { stripeSessionId: 'cs_b', expiresAt: at(20 * MIN) }), row('c', 'open', { stripeSessionId: 'cs_c', expiresAt: at(30 * SEC) })])
  assert.deepEqual(p, { kind: 'retire', attemptIds: ['a', 'c'] })
})

test('MANDATE B: an old "expired / stale_reservation" row with no identifier blocks a new page even long after its TTL and grace; the rest of the order is clear', () => {
  const stale = find('expired, stale reservation of the old code (no identifier)').make('old')
  for (const now of [NOW, NOW + 3 * HOUR, NOW + 72 * HOUR, NOW + 365 * 24 * HOUR]) assert.deepEqual(plan([stale], base, now), { kind: 'unresolved', why: 'uncertain_history' })
  // the same row with an expired provider page next to it: still not clear
  assert.deepEqual(plan([stale, find('expired, shown by the provider').make('x')]), { kind: 'unresolved', why: 'uncertain_history' })
  // next to a page the database knows: that page is handed out again, even in the margin; nothing new is opened and the page is not closed
  assert.deepEqual(plan([stale, find('open, 30 s left (in the margin)').make('k')]), { kind: 'reuse', attemptId: 'k' })
  assert.deepEqual(plan([stale, find('open, 10 minutes left').make('k')]), { kind: 'reuse', attemptId: 'k' })
  // a page with no time at all is closed, and then the order waits for a person
  assert.deepEqual(plan([stale, find('open, past its expiry').make('k')]), { kind: 'retire', attemptIds: ['k'] })
  assert.deepEqual(plan([stale]), { kind: 'unresolved', why: 'uncertain_history' })
  // a row closed WITH an identifier by the old clock rule is no safer
  assert.equal(closedWithoutProof(find('expired, stale reservation of the old code (with an identifier adopted later)').make('z')), true)
})

test('FOLLOW-UP P0-B: a failed / expired row with an identifier is not a closed page until the provider said so; asked about, all together, before anything is opened', () => {
  const failed = find('failed, the payment failed (identifier, no proof of closing)').make('f')
  const cancelled = find('failed, the payment was cancelled (identifier, no proof of closing)').make('c')
  const quiet = find('expired, no reason (identifier, no proof of closing)').make('q')
  const stale = find('expired, stale reservation of the old code (with an identifier adopted later)').make('s')
  const legacyMismatch = find('failed, a page that did not match - legacy: the row only names the cause (identifier, no proof of closing)').make('m')
  for (const one of [failed, cancelled, quiet, stale, legacyMismatch]) assert.deepEqual(plan([one]), { kind: 'prove', attemptIds: [one.id] }, one.failureReason ?? 'no reason')
  assert.deepEqual(plan([failed, cancelled, quiet]), { kind: 'prove', attemptIds: ['c', 'f', 'q'] }, 'all together, the oldest first and ties by id')
  assert.deepEqual(plan([quiet, cancelled, failed]), { kind: 'prove', attemptIds: ['c', 'f', 'q'] }, 'whatever the order the rows come in')
  // before a reservation is replayed, a page is handed out or retired, and next to a row in doubt
  assert.deepEqual(plan([failed, find('creating, young').make('r')]), { kind: 'prove', attemptIds: ['f'] })
  assert.deepEqual(plan([failed, find('open, 10 minutes left').make('o')]), { kind: 'prove', attemptIds: ['f'] })
  assert.deepEqual(plan([failed, find('open, 30 s left (in the margin)').make('o')]), { kind: 'prove', attemptIds: ['f'] })
  assert.deepEqual(plan([failed, find('expired, stale reservation of the old code (no identifier)').make('d')]), { kind: 'prove', attemptIds: ['f'] })
  // once the proof is on the row nothing is asked: the next page may be opened
  assert.deepEqual(plan([row('f', 'failed', { stripeSessionId: 'cs_f', failureReason: stampProof('closed_by_us:proved', 'payment_failed') })]), { kind: 'create' })
  assert.deepEqual(plan([row('q', 'expired', { stripeSessionId: 'cs_q', failureReason: stampProof('provider_status:expired', null) })]), { kind: 'create' })
  // the order's own facts come first: a payment, a review, a cancelled order - nothing is asked, nothing is opened
  assert.deepEqual(plan([failed, find('processing').make('p')]), { kind: 'blocked', reason: 'processing' })
  assert.deepEqual(plan([failed], { ...base, status: 'cancelled' }), { kind: 'blocked', reason: 'cancelled' })
  assert.deepEqual(plan([failed, find('a status nobody knows').make('u')]), { kind: 'unresolved', why: 'unknown_attempt_status' })
})

test('the proof of closing: only the provider\'s word counts, it is written first and what the row said before is kept after it', () => {
  for (const proof of ['closed_by_us:replaced', 'closed_by_us:order_paid', 'provider_status:expired', 'closed_by_us:session_mismatch:amount', 'provider_status:expired (session_mismatch:amount)']) assert.equal(closingIsProved(proof), true, proof)
  // a reason that only NAMES a cause is a diagnosis, not a proof - `session_mismatch:` included: the code that was published wrote it for rows whose page it never closed
  for (const none of [null, undefined, '', 'payment_failed', 'payment_canceled', 'admin_released', 'stale_reservation', 'expired', 'closed_by_us', 'provider_status:open', 'Closed_by_us:x', ' closed_by_us:x', 'was closed_by_us:x',
    'session_mismatch:amount', 'session_mismatch:', 'session_mismatch:closed_by_us:', 'provider_status:complete']) assert.equal(closingIsProved(none), false, String(none))
  assert.equal(stampProof('closed_by_us:proved', 'payment_failed'), 'closed_by_us:proved (was payment_failed)')
  assert.equal(stampProof('closed_by_us:proved', 'session_mismatch:amount'), 'closed_by_us:proved (was session_mismatch:amount)', 'a legacy mismatch row keeps its cause after the proof')
  assert.equal(stampProof('provider_status:expired', 'session_mismatch:currency'), 'provider_status:expired (was session_mismatch:currency)')
  assert.equal(mismatchClosureReason('us', 'amount'), 'closed_by_us:session_mismatch:amount')
  assert.equal(mismatchClosureReason('provider', 'amount'), 'provider_status:expired (session_mismatch:amount)')
  for (const by of ['us', 'provider'] as const) {
    assert.equal(closingIsProved(mismatchClosureReason(by, 'metadata')), true, `${by}: what the new code writes is a proof`)
    assert.ok(mismatchClosureReason(by, 'metadata').includes('session_mismatch:metadata'), `${by}: and keeps the cause`)
    assert.ok(mismatchClosureReason(by, 'x'.repeat(500)).length <= 200)
    assert.equal(closingIsProved(mismatchClosureReason(by, 'x'.repeat(500))), true, 'the proof survives the cut')
  }
  assert.equal(stampProof('provider_status:expired', null), 'provider_status:expired')
  assert.equal(stampProof('provider_status:expired', ''), 'provider_status:expired')
  assert.equal(stampProof('closed_by_us:proved', 'closed_by_us:replaced'), 'closed_by_us:proved', 'a reason that already is a proof is not carried along')
  assert.equal(closingIsProved(stampProof('closed_by_us:proved', 'payment_failed')), true)
  assert.ok(stampProof('closed_by_us:proved', 'x'.repeat(500)).length <= 200)
  assert.equal(closingIsProved(stampProof('closed_by_us:proved', 'x'.repeat(500))), true, 'the proof survives the cut')
})

test('rows that PROVE nothing was created (refused here before any call; a rejection shown to create nothing) do not hold a new page back', () => {
  assert.deepEqual(plan([find('failed, refused here before any call (proved never sent)').make('a')]), { kind: 'create' })
  assert.deepEqual(plan([find('failed, a rejection shown to create nothing').make('a')]), { kind: 'create' })
  assert.deepEqual(plan([find('expired, shown by the provider').make('a'), find('failed, a page that did not match, closed by us with proof (the cause is kept)').make('b')]), { kind: 'create' })
})

test('a reservation is replayed even when the order has an open page next to it; twins are dealt with afterwards', () => {
  assert.deepEqual(plan([find('open, 10 minutes left').make('o'), find('creating, an hour old').make('r')]), { kind: 'replay', attemptId: 'r' })
  assert.deepEqual(plan([row('r2', 'creating', { createdAt: at(-5 * MIN) }), row('r1', 'creating', { createdAt: at(-10 * MIN) })]), { kind: 'replay', attemptId: 'r1' }, 'the oldest first')
})

test('a page with no Stripe identifier cannot be asked about or closed: unresolved; an unknown status: unresolved; the unreadable expiry of a page: closed with proof', () => {
  assert.deepEqual(plan([find('open, no Stripe identifier').make('a')]), { kind: 'unresolved', why: 'open_without_session' })
  assert.deepEqual(plan([find('a status nobody knows').make('a')]), { kind: 'unresolved', why: 'unknown_attempt_status' })
  assert.deepEqual(plan([find('open, expiry unreadable').make('a')]), { kind: 'retire', attemptIds: ['a'] })
})

test('the attempts of an order are limited, but only when a new one would be opened', () => {
  const closed = (n: number) => Array.from({ length: n }, (_, i) => row(`c${i}`, 'expired', { stripeSessionId: `cs_c${i}`, failureReason: 'provider_status:expired' }))
  assert.deepEqual(plan(closed(MAX_ATTEMPTS_PER_ORDER - 1)), { kind: 'create' })
  assert.deepEqual(plan(closed(MAX_ATTEMPTS_PER_ORDER)), { kind: 'too_many_attempts' })
  assert.deepEqual(plan([...closed(MAX_ATTEMPTS_PER_ORDER), find('open, 10 minutes left').make('o')]), { kind: 'reuse', attemptId: 'o' })
})

test('money that does not fit "a page may be opened" blocks: a payment intent, a payment date, an amount received - while the order does not say it is paid', () => {
  assert.deepEqual(plan([], { ...base, stripePaymentIntentId: 'pi_1' }), { kind: 'blocked', reason: 'review' })
  assert.deepEqual(plan([], { ...base, paidAt: at(-1) }), { kind: 'blocked', reason: 'review' })
  assert.deepEqual(plan([row('a', 'expired', { stripeSessionId: 'cs_a', failureReason: 'provider_status:expired', amountReceivedCents: 100 })]), { kind: 'blocked', reason: 'review' })
  assert.deepEqual(plan([row('a', 'expired', { stripeSessionId: 'cs_a', failureReason: 'provider_status:expired', amountReceivedCents: 0 })]), { kind: 'create' })
})

// ====================================================================================================================================================================
// the replay horizon
// ====================================================================================================================================================================
test('the numbers fit together: a replay is a valid NEW request for exactly as long as the old "join window" said', () => {
  assert.equal(SESSION_TTL_MS - JOIN_WINDOW_MS, PROVIDER_MIN_EXPIRY_MS + FRESH_SAFETY_MS)
  assert.equal(REPLAY_RETENTION_MS, 23 * HOUR)
  assert.ok(REPLAY_RETENTION_MS < 24 * HOUR, 'the provider keeps a key for AT LEAST 24 hours; the horizon must be inside that')
})

test('replayMode: the limits, to the millisecond', () => {
  const made = (ageMs: number, ttl = SESSION_TTL_MS) => ({ createdAt: at(-ageMs), expiresAt: at(-ageMs + ttl) })
  // inside the window in which the request is still a valid new one
  assert.equal(replayMode(made(0), NOW), 'FRESH_OK')
  assert.equal(replayMode(made(JOIN_WINDOW_MS), NOW), 'FRESH_OK', 'exactly 90 s old: 30 min 30 s left')
  assert.equal(replayMode(made(JOIN_WINDOW_MS + 1), NOW), 'EVIDENCE_ONLY', 'one millisecond more')
  assert.equal(replayMode(made(2 * MIN), NOW), 'EVIDENCE_ONLY')
  assert.equal(replayMode(made(35 * MIN), NOW), 'EVIDENCE_ONLY')
  // the retention horizon
  assert.equal(replayMode(made(REPLAY_RETENTION_MS - 1), NOW), 'EVIDENCE_ONLY')
  assert.equal(replayMode(made(REPLAY_RETENTION_MS), NOW), 'NO_REPLAY', 'exactly 23 h')
  assert.equal(replayMode(made(24 * HOUR), NOW), 'NO_REPLAY')
  assert.equal(replayMode(made(72 * HOUR), NOW), 'NO_REPLAY')
  // a longer life of the page widens the first window, never the second
  assert.equal(replayMode(made(25 * MIN, 60 * MIN), NOW), 'FRESH_OK')
  assert.equal(replayMode(made(REPLAY_RETENTION_MS, 24 * HOUR), NOW), 'NO_REPLAY')
  // what cannot be read, or cannot be believed, is not replayed
  assert.equal(replayMode({ createdAt: null, expiresAt: at(MIN) }, NOW), 'NO_REPLAY')
  assert.equal(replayMode({ createdAt: at(-MIN), expiresAt: 'not a date' }, NOW), 'NO_REPLAY')
  assert.equal(replayMode(made(0), Number.NaN), 'NO_REPLAY')
  assert.equal(replayMode({ createdAt: at(MAX_FUTURE_SKEW_MS), expiresAt: at(MAX_FUTURE_SKEW_MS + SESSION_TTL_MS) }, NOW), 'FRESH_OK', 'a clock a few minutes behind is tolerated')
  assert.equal(replayMode({ createdAt: at(MAX_FUTURE_SKEW_MS + 1), expiresAt: at(MAX_FUTURE_SKEW_MS + 1 + SESSION_TTL_MS) }, NOW), 'NO_REPLAY', 'a reservation from the future is not trusted')
})

// ====================================================================================================================================================================
// what the provider's answers allow one to conclude
// ====================================================================================================================================================================
test('classifyCreateError: ONLY a refusal made here is "never sent"; the list of proved rejections is empty, so every answer of the provider is ambiguous', () => {
  assert.deepEqual(classifyCreateError(Object.assign(new Error('lines do not add up'), { name: LOCAL_REFUSAL_NAME })), { class: 'never_sent', transient: false })
  assert.equal(PROVEN_NOT_CREATED.length, 0)
  const shapes: Array<[string, unknown, boolean]> = [
    ['connection lost', { type: 'StripeConnectionError' }, true],
    ['timeout', { type: 'StripeConnectionError', code: 'ETIMEDOUT' }, true],
    ['stored 500', { type: 'StripeAPIError', rawType: 'api_error', statusCode: 500 }, true],
    ['502', { statusCode: 502 }, true],
    ['429', { type: 'StripeRateLimitError', rawType: 'rate_limit_error', statusCode: 429 }, true],
    ['409, key in use', { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 409, code: 'idempotency_key_in_use' }, true],
    ['idempotency error (other parameters)', { type: 'StripeIdempotencyError', rawType: 'idempotency_error', statusCode: 400 }, false],
    ['400 invalid_request_error, a parameter', { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 400, code: 'parameter_invalid_integer', param: 'line_items[0][price_data][unit_amount]' }, false],
    ['400 invalid_request_error, expires_at', { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 400, param: 'expires_at' }, false],
    ['400 invalid_request_error, no parameter', { type: 'StripeInvalidRequestError', rawType: 'invalid_request_error', statusCode: 400 }, false],
    ['401', { type: 'StripeAuthenticationError', statusCode: 401 }, false],
    ['403', { type: 'StripePermissionError', statusCode: 403 }, false],
    ['404', { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' }, false],
    ['an Error with nothing on it', new Error('boom'), true],
    ['a string', 'boom', true],
    ['null', null, true],
    ['undefined', undefined, true],
    ['a number', 42, true],
    ['an empty object', {}, true],
  ]
  for (const [name, error, transient] of shapes) assert.deepEqual(classifyCreateError(error), { class: 'ambiguous', transient }, name)
})

test('classifyCreateError: over every combination of type, status, code and parameter, nothing is ever "proved" unless the list says so', () => {
  const types = ['StripeInvalidRequestError', 'StripeAPIError', 'StripeConnectionError', 'StripeIdempotencyError', 'StripeAuthenticationError', 'StripeRateLimitError', 'StripePermissionError', '', undefined, 7]
  const rawTypes = ['invalid_request_error', 'api_error', 'idempotency_error', 'rate_limit_error', 'authentication_error', '', undefined]
  const statuses = [undefined, 0, 200, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 599]
  const codes = [undefined, '', 'parameter_invalid_integer', 'parameter_missing', 'resource_missing', 'idempotency_key_in_use', 'lock_timeout', 'rate_limit', 'expires_at_invalid']
  const params = [undefined, 'expires_at', 'success_url', 'line_items']
  let n = 0
  for (const type of types) for (const rawType of rawTypes) for (const statusCode of statuses) for (const code of codes) for (const param of params) {
    const result = classifyCreateError({ type, rawType, statusCode, code, param })
    n++
    assert.equal(result.class, 'ambiguous', JSON.stringify({ type, rawType, statusCode, code, param }))
  }
  assert.ok(n > 20_000)
  // and when the owner HAS seen a rejection create nothing and puts it on the list, exactly that one is proved
  const list = [{ type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid_integer' }]
  assert.equal(classifyCreateError({ type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid_integer' }, list).class, 'proven_not_created')
  assert.equal(classifyCreateError({ type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_missing' }, list).class, 'ambiguous')
  assert.equal(classifyCreateError({ type: 'StripeInvalidRequestError', statusCode: 409, code: 'parameter_invalid_integer' }, list).class, 'ambiguous')
})

test('what a session is shown to be: only "expired" is closed, "complete" is money (never closed, never failed), anything else is not a proof', () => {
  assert.equal(classifySessionStatus('expired'), 'closed')
  assert.equal(classifySessionStatus('complete'), 'complete')
  assert.equal(classifySessionStatus('open'), 'open')
  for (const odd of [undefined, null, '', 'Expired', 'EXPIRED', 'completed', 'canceled', 0, {}, []]) assert.equal(classifySessionStatus(odd), 'unknown', String(odd))
  assert.equal(classifyCloseOutcome('expired'), 'closed')
  assert.equal(classifyCloseOutcome('complete'), 'complete')
  assert.equal(classifyCloseOutcome('open'), 'unknown', 'a session that is still open after a refused or failed "expire" was NOT closed')
  assert.equal(classifyCloseOutcome(undefined), 'unknown')
})

test('closedWithoutProof: which closed rows prove nothing', () => {
  const closed = (status: string, stripeSessionId: string | null, failureReason: string | null) => closedWithoutProof({ status, stripeSessionId, failureReason })
  assert.equal(closed('expired', null, 'stale_reservation'), true)
  assert.equal(closed('expired', 'cs_1', 'stale_reservation'), true)
  assert.equal(closed('failed', null, 'StripeAPIError:'), true)
  assert.equal(closed('failed', null, null), true)
  assert.equal(closed('expired', null, ''), true)
  assert.equal(closed('failed', null, 'local_refusal:lines'), false)
  assert.equal(closed('failed', null, 'provider_rejected:x'), false)
  assert.equal(closed('expired', 'cs_1', 'provider_status:expired'), false)
  assert.equal(closed('failed', 'cs_1', 'payment_failed'), true, 'an identifier is not a proof of closing (follow-up P0-B)')
  assert.equal(closed('failed', 'cs_1', 'payment_canceled'), true)
  assert.equal(closed('failed', 'cs_1', 'admin_released'), true)
  assert.equal(closed('expired', 'cs_1', null), true)
  assert.equal(closed('expired', 'cs_1', 'closed_by_us:replaced'), false)
  assert.equal(closed('failed', 'cs_1', 'session_mismatch:amount'), true, 'a reason that only names the cause proves nothing: the old code left the page open')
  assert.equal(closed('failed', 'cs_1', 'closed_by_us:session_mismatch:amount'), false)
  assert.equal(closed('failed', 'cs_1', 'provider_status:expired (session_mismatch:amount)'), false)
  // an identifier that is not shaped like a session id can not be asked about: it is no identifier (F02 reads it the same way)
  for (const junk of ['not-a-session', 'pi_test_x', 'cs_', 'cs_ x', 'CS_test_1', ' cs_test_1']) {
    assert.equal(closed('failed', junk, 'payment_failed'), true, junk)
    assert.equal(closedWithIdUnproven({ status: 'failed', stripeSessionId: junk, failureReason: 'payment_failed' }), false, `${junk}: nothing can be asked about it`)
    assert.equal(closed('failed', junk, 'local_refusal:lines'), false, `${junk}: but a proof that nothing was ever created still counts`)
  }
  assert.equal(closed('open', null, null), false, 'a live row is not "closed"')
  assert.equal(closed('creating', null, null), false)
  assert.equal(closed('paid', null, null), false)
  for (const status of KNOWN_ATTEMPT_STATUSES) assert.equal(typeof closed(status, null, null), 'boolean')
})
