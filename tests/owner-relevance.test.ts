// R1-3 / KLOSS hardening A - the owner guard reads only the RELEVANT siblings (lib/checkout-owner-guard.ts, isRelevantSibling): a pure property, no database.
//
// For every generated world - the orders one owner has for one cart, of every state and every shape (other spellings, NULLs, missing instants, pages of every kind), a request, its windows - the
// decision taken with ALL the orders and the decision taken with the RELEVANT ones alone are the same, for every function that decides:
//   * at S2 (before an order is made): planOwnerIntent, publicResponseFor of its decision, recoveryTargets of its hold, repeatSetOf (the set G of the repeat gate);
//   * at S3 (before a page is given): arbitratePage and arbitrateReservation, their answers and recovery, and repeatSetOf where the repeat gate asks (on, or in shadow with its wider window);
// with the relevance of THAT door (the windows the door uses). A failure prints the seed and the world, so that it can be run again. Below, the words the query compares exactly are pinned to the
// pure ones (lib/checkout-session-plan.ts, lib/orderworks-status.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRelevantSibling, NOT_VERIFIED_PAYMENT_STATUSES, PAGE_UNPAID_WINDOW_MS, recoveryTargets, REPEAT_CONFIRM_WINDOW_MS, REPEAT_SHADOW_WINDOW_MS, SESSION_ID_SQL_PATTERN, VERIFIED_PAYMENT_STATUSES,
  type SiblingRelevance,
} from '../lib/checkout-owner-guard'
import {
  arbitratePage, arbitrateReservation, planOwnerIntent, publicResponseFor, repeatSetOf, reservationScope, scopeOf, type AttemptFacts, type OwnerEvidence, type SiblingOrder,
} from '../lib/owner-intent'
import { isSessionId, JOIN_WINDOW_MS } from '../lib/checkout-session-plan'
import { DUPLICATE_ORDER_WINDOW_MS } from '../lib/checkout-orders'
import { isPaymentVerified } from '../lib/order-payment-policy'
import { normalizePaymentStatus, PAYMENT_STATUS_OPTIONS } from '../lib/orderworks-status'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'd'.repeat(64)
const WORLDS = 50_000

function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- the pools a world is drawn from: the words the application writes, and others -------------------------------------------------------------------------------------------------------
const STATUSES = ['awaiting_payment', 'awaiting_payment', 'awaiting_payment', 'awaiting_review', 'queued', 'cancelled', 'completed', 'shipped', 'Awaiting_Payment', '']
const PAYMENT = ['pending', 'pending', 'pending', 'processing', 'paid', 'paid', 'paid', 'free', 'refunded', 'canceled', 'cancelled', 'failed', 'requires_capture', 'succeeded', ' PAID ', 'unknown', '']
const REVIEW = [null, null, null, null, null, null, '', 'amount']
const ATTEMPT = ['creating', 'open', 'processing', 'mismatch', 'paid', 'paid', 'expired', 'expired', 'expired', 'failed', 'failed', 'canceled', 'OPEN', '']
const SESSION = [null, null, '', 'cs_test_x', 'cs_test_x', 'cs_test_x', 'cs_test_x\n', 'not-a-session-id']
const REASON = [
  null, null, '', 'closed_by_us:x', 'closed_by_us:x', 'closedXbyXus:x', 'provider_status:expired', 'provider_status:expired (session_mismatch:amount)', 'local_refusal:x', 'provider_rejected:x',
  'stale_reservation', 'session_mismatch:x', 'payment_failed',
]
const relevanceAt = (now: number, unpaidWindowMs: number, repeatWindowMs: number): SiblingRelevance => ({ unpaidSince: now - unpaidWindowMs, verifiedSince: repeatWindowMs > 0 ? now - repeatWindowMs : null })

type World = { orders: SiblingOrder[]; owner: OwnerEvidence; requestTotalCents: number; confirmRepeat: boolean; windows: { duplicateMs: number; repeatMs: number; reservingMs: number }; target: SiblingOrder; pageOwner: OwnerEvidence | null; pageRepeat: 'off' | 'on' | 'shadow' }
// (one world in three is TIDY: the words the application writes, pages closed with proof or carrying the payment, orders of the owner who asks - where reuse and confirmation live)
const TIDY_STATUSES = ['awaiting_payment', 'awaiting_payment', 'queued', 'cancelled', 'completed']
const TIDY_PAYMENT = ['pending', 'pending', 'paid', 'paid', 'canceled', 'refunded']
function world(seed: number): World {
  const random = prng(seed)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]
  const tidy = random() < 1 / 3
  const windows = { duplicateMs: pick([0, DUPLICATE_ORDER_WINDOW_MS, DUPLICATE_ORDER_WINDOW_MS]), repeatMs: pick([0, REPEAT_CONFIRM_WINDOW_MS, REPEAT_SHADOW_WINDOW_MS]), reservingMs: pick([0, JOIN_WINDOW_MS, JOIN_WINDOW_MS]) }
  // instants on the edges of every window, and the ones a Date can not be
  const edges = [windows.duplicateMs, windows.repeatMs, windows.reservingMs, JOIN_WINDOW_MS, DUPLICATE_ORDER_WINDOW_MS, REPEAT_CONFIRM_WINDOW_MS, REPEAT_SHADOW_WINDOW_MS, PAGE_UNPAID_WINDOW_MS].filter((value) => value > 0)
  const instant = (): number | Date | string | null | undefined => {
    const r = random()
    if (r < 0.1) return null
    if (r < 0.13) return undefined
    if (r < 0.15) return 'not a time'
    if (r < 0.55) return NOW - pick(edges) + pick([-1, 0, 1])
    const value = NOW - pick([MIN, 5 * MIN, 30 * MIN, 3 * HOUR, 30 * HOUR, -5 * MIN])
    return r < 0.75 ? new Date(value) : value
  }
  const users = ['user_1', 'user_2']
  const orders: SiblingOrder[] = []
  for (let i = 0, count = Math.floor(random() * 7); i < count; i++) {
    const id = `o${i}`
    const intent = tidy ? `pi_${i}` : pick([null, `pi_${i}`, `pi_${i}`, ''])
    const paymentStatus = pick(tidy ? TIDY_PAYMENT : PAYMENT)
    const attempts: Array<AttemptFacts & { id: string }> = []
    for (let j = 0, many = pick(tidy ? [0, 0, 1] : [0, 0, 1, 1, 2, 3]); j < many; j++) {
      attempts.push(tidy
        ? (paymentStatus === 'paid' || paymentStatus === 'refunded'
          ? { id: `${id}_a${j}`, status: 'paid', stripeSessionId: 'cs_test_x', failureReason: null, stripePaymentIntentId: intent, completedAt: instant() }
          : { id: `${id}_a${j}`, status: pick(['expired', 'failed']), stripeSessionId: 'cs_test_x', failureReason: pick(['closed_by_us:x', 'provider_status:expired']), stripePaymentIntentId: null, completedAt: null })
        : { id: `${id}_a${j}`, status: pick(ATTEMPT), stripeSessionId: pick(SESSION), failureReason: pick(REASON), stripePaymentIntentId: pick([null, intent, intent, 'pi_other', '']), completedAt: instant() })
    }
    orders.push({
      id, orderNumber: 100 + i, userId: tidy ? pick([null, users[0]]) : pick([null, null, users[0], users[1]]), guestSessionHash: tidy ? HASH_A : pick([null, HASH_A, HASH_A, HASH_B, '']),
      paymentMethod: tidy ? 'card' : pick(['card', 'card', 'card', 'cash']), status: pick(tidy ? TIDY_STATUSES : STATUSES), paymentStatus, paymentReviewReason: tidy ? null : pick(REVIEW), stripePaymentIntentId: intent,
      totalCents: tidy ? 5000 : pick([5000, 5000, 6000]), refundedCents: tidy ? 0 : pick([0, 0, 0, 100, null]), paidAt: instant(), createdAt: instant(), financialRevision: pick([0, 1, 2, 3]), attempts,
    })
  }
  const guests = orders.filter((order) => order.userId === null)
  const opened = guests.filter(() => random() < 0.3).map((order) => ({ id: order.id, guestSessionHash: order.guestSessionHash || null }))
  const owner: OwnerEvidence = random() < 0.4 ? { kind: 'account', userId: tidy ? users[0] : pick(users) } : { kind: 'guest', sessionHash: tidy ? pick([HASH_A, HASH_C]) : pick([null, HASH_A, HASH_B, HASH_C]), verifiedOrders: opened }
  const target: SiblingOrder = orders.length > 0 && random() < 0.7 ? pick(orders) : { id: 'new', orderNumber: 999, userId: owner.kind === 'account' ? owner.userId : null, guestSessionHash: owner.kind === 'guest' ? owner.sessionHash : null, paymentMethod: 'card', status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null, totalCents: 5000, refundedCents: 0, paidAt: null, createdAt: NOW, financialRevision: 0, attempts: [] }
  return { orders, owner, requestTotalCents: tidy ? 5000 : pick([5000, 6000]), confirmRepeat: random() < 0.3, windows, target, pageOwner: random() < 0.8 ? owner : null, pageRepeat: pick(['off', 'on', 'shadow'] as const) }
}

// what a call gives - its value, or the error it throws (a throw in one reading and not in the other is a difference too)
function outcome<T>(run: () => T): { ok: T } | { error: string } {
  try { return { ok: run() } } catch (error) { return { error: `${(error as Error).name}: ${(error as Error).message}` } }
}
const sameOutcome = (a: unknown, b: unknown, what: string, seed: number, w: World) => assert.deepEqual(a, b, `${what} differs for seed ${seed}: ${JSON.stringify(w)}`)

test('A relevance: for 50 000 generated worlds, every decision at S2 and at S3 is the same with all the orders of the owner and the cart and with the relevant ones alone', () => {
  const seen = { trimmed: 0, decisions: new Map<string, number>(), page: new Map<string, number>(), members: 0 }
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
  for (let seed = 1; seed <= WORLDS; seed++) {
    const w = world(seed)
    // ---- S2, with the relevance decideOwnerIntent reads by
    const s2 = relevanceAt(NOW, Math.max(w.windows.duplicateMs, JOIN_WINDOW_MS), w.windows.repeatMs)
    const relevant = w.orders.filter((order) => isRelevantSibling(order, s2))
    if (relevant.length < w.orders.length) seen.trimmed++
    const input = { owner: w.owner, requestTotalCents: w.requestTotalCents, confirmRepeat: w.confirmRepeat, now: NOW, windows: w.windows, listIsComplete: true }
    const all = outcome(() => planOwnerIntent({ ...input, orders: w.orders }))
    const only = outcome(() => planOwnerIntent({ ...input, orders: relevant }))
    sameOutcome(all, only, 'planOwnerIntent', seed, w)
    if ('ok' in all && 'ok' in only) {
      count(seen.decisions, all.ok.kind === 'hold' ? `hold:${all.ok.cause}` : all.ok.kind)
      sameOutcome(outcome(() => publicResponseFor(all.ok, w.owner)), outcome(() => publicResponseFor(only.ok, w.owner)), 'publicResponseFor (S2)', seed, w)
      if (all.ok.kind === 'hold' && only.ok.kind === 'hold') sameOutcome(recoveryTargets(all.ok.holders, w.orders), recoveryTargets(only.ok.holders, relevant), 'recoveryTargets (S2)', seed, w)
    }
    const g = (orders: SiblingOrder[]) => outcome(() => repeatSetOf({ owner: w.owner, scope: scopeOf(w.owner), orders, now: NOW, windowMs: w.windows.repeatMs }))
    const gAll = g(w.orders)
    sameOutcome(gAll, g(relevant), 'repeatSetOf (S2)', seed, w)
    if ('ok' in gAll) seen.members += gAll.ok.length

    // ---- S3, with the relevance judgeOwnerPage reads by
    const pageWindow = w.pageOwner === null || w.pageRepeat === 'off' ? 0 : w.pageRepeat === 'on' ? REPEAT_CONFIRM_WINDOW_MS : REPEAT_SHADOW_WINDOW_MS
    const s3 = relevanceAt(NOW, PAGE_UNPAID_WINDOW_MS, pageWindow)
    const pageRelevant = w.orders.filter((order) => isRelevantSibling(order, s3))
    for (const [name, arbiter] of [['arbitratePage', arbitratePage], ['arbitrateReservation', arbitrateReservation]] as const) {
      const verdictAll = outcome(() => arbiter({ owner: w.pageOwner, order: w.target, orders: w.orders, listIsComplete: true }))
      const verdictOnly = outcome(() => arbiter({ owner: w.pageOwner, order: w.target, orders: pageRelevant, listIsComplete: true }))
      sameOutcome(verdictAll, verdictOnly, name, seed, w)
      if ('ok' in verdictAll && 'ok' in verdictOnly) {
        if (name === 'arbitratePage') count(seen.page, verdictAll.ok.kind === 'hold' ? `hold:${verdictAll.ok.cause}` : verdictAll.ok.kind)
        sameOutcome(outcome(() => publicResponseFor(verdictAll.ok, w.pageOwner)), outcome(() => publicResponseFor(verdictOnly.ok, w.pageOwner)), `publicResponseFor (${name})`, seed, w)
        if (verdictAll.ok.kind === 'hold' && verdictOnly.ok.kind === 'hold') sameOutcome(recoveryTargets(verdictAll.ok.holders, w.orders), recoveryTargets(verdictOnly.ok.holders, pageRelevant), `recoveryTargets (${name})`, seed, w)
      }
    }
    if (w.pageOwner !== null && pageWindow > 0) {
      const pageG = (orders: SiblingOrder[]) => outcome(() => repeatSetOf({ owner: w.pageOwner, scope: reservationScope(w.pageOwner, w.target), orders, excludeOrderId: w.target.id, now: NOW, windowMs: pageWindow }))
      sameOutcome(pageG(w.orders), pageG(pageRelevant), 'repeatSetOf (S3)', seed, w)
    }
  }
  // not vacuous: the relevant orders are fewer than all in many worlds, and every kind of decision is met many times
  assert.ok(seen.trimmed > WORLDS / 3, `only ${seen.trimmed} worlds lost an order to the relevance`)
  for (const kind of ['create', 'reuse', 'confirm', 'hold:in_doubt', 'hold:sibling_page']) assert.ok((seen.decisions.get(kind) ?? 0) > 500, `S2 ${kind}: ${seen.decisions.get(kind) ?? 0} - ${JSON.stringify([...seen.decisions])}`)
  for (const kind of ['proceed', 'hold:in_doubt', 'hold:sibling_page', 'hold:unproved']) assert.ok((seen.page.get(kind) ?? 0) > 500, `S3 ${kind}: ${seen.page.get(kind) ?? 0} - ${JSON.stringify([...seen.page])}`)
  assert.ok(seen.members > 1000, `members of G: ${seen.members}`)
  console.log(`worlds ${WORLDS}; trimmed by the relevance ${seen.trimmed}; S2 ${JSON.stringify([...seen.decisions])}; S3 ${JSON.stringify([...seen.page])}; members of G ${seen.members}`)
})

test('A relevance: the window of an unpaid order at the page is the window of the duplicate search and of the page being given, whichever is longer; each door\'s windows are what it reads by', () => {
  assert.equal(PAGE_UNPAID_WINDOW_MS, Math.max(DUPLICATE_ORDER_WINDOW_MS, JOIN_WINDOW_MS))
  // condition 3 (an unpaid order), on the edge of the window: after the instant is relevant, at it is not
  const unpaid = (createdAt: number): SiblingOrder => ({ id: 'o1', orderNumber: 1, userId: 'user_1', guestSessionHash: null, paymentMethod: 'card', status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null, totalCents: 5000, refundedCents: 0, paidAt: null, createdAt, financialRevision: 0, attempts: [] })
  const relevance = relevanceAt(NOW, HOUR, 0)
  assert.deepEqual([NOW - HOUR + 1, NOW - HOUR, NOW - HOUR - 1].map((at) => isRelevantSibling(unpaid(at), relevance)), [true, false, false])
  // condition 4 (a verified payment): after the instant, or at an unknown one, is relevant - and only where the repeat gate asks
  const paid = (paidAt: SiblingOrder['paidAt']): SiblingOrder => ({ ...unpaid(NOW - 5 * HOUR), status: 'queued', paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt })
  assert.deepEqual([NOW - HOUR + 1, NOW - HOUR, null, 'not a time'].map((at) => isRelevantSibling(paid(at), relevanceAt(NOW, HOUR, HOUR))), [true, false, true, true])
  assert.deepEqual([NOW - HOUR + 1, null].map((at) => isRelevantSibling(paid(at), relevanceAt(NOW, HOUR, 0))), [false, false])
  // ...dated by the page that carried it when `paidAt` is missing (verifiedAtOf)
  const carried = (completedAt: number): SiblingOrder => ({ ...paid(null), attempts: [{ id: 'a1', status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_1', failureReason: null, completedAt }] })
  assert.deepEqual([NOW - HOUR + 1, NOW - HOUR].map((at) => isRelevantSibling(carried(at), relevanceAt(NOW, HOUR, HOUR))), [true, false])
})

test('A relevance: the words the query compares exactly are the pure ones - the shape of a session id, the payment statuses that were verified and the ones that were not', () => {
  // the session id: the same shape, for every kind of string (the query compares it in the "C" collation)
  const sql = new RegExp(SESSION_ID_SQL_PATTERN)
  const ids = ['cs_test_1', 'cs_', 'cs_a', 'CS_test', 'cs_test-1', 'cs_test_1\n', '\ncs_test_1', ' cs_test_1', 'cs_tést', 'cs_٣', 'cs_Ａ', `cs_${'a'.repeat(255)}`, `cs_${'a'.repeat(256)}`, '', 'pi_test_1', 'cs_test_1 ', 'cs__']
  for (const id of ids) assert.equal(sql.test(id), isSessionId(id), JSON.stringify(id))
  // a status the carrier is recognised by: verified, every one; a status condition 4 leaves out: not verified, every one
  const verified = (status: string) => isPaymentVerified(status) || normalizePaymentStatus(status) === 'refunded'
  for (const status of VERIFIED_PAYMENT_STATUSES) assert.equal(verified(status), true, status)
  for (const status of NOT_VERIFIED_PAYMENT_STATUSES) assert.equal(verified(status), false, status)
  // every status the application offers is in exactly one of the two lists (a new one is a decision, not an accident)
  for (const { value } of PAYMENT_STATUS_OPTIONS) assert.equal(Number(VERIFIED_PAYMENT_STATUSES.includes(value)) + Number(NOT_VERIFIED_PAYMENT_STATUSES.includes(value)), 1, value)
})
