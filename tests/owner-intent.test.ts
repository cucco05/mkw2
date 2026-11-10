// R1-3 / KLOSS, P1 - the pure rules of what a new checkout may do, given what the same owner already has for the same cart (lib/owner-intent.ts).
//
// Pure: no database, no provider, no clock. The module is NOT connected to the checkout yet (P2 does that); these tests pin the rules first, over every combination that matters:
//   * mayStillBePayable - the ONE definition of "this page may still be paid": exhaustive over status x reason x identifier x carrier, against a table written here from the plan (REV3, 1.2),
//     and "no surrogate authorises": the state of the order, the words failed / expired / paid without the provider's word, an identifier and time are never proofs;
//   * scope and locks - what a request proves; two guests with the same cart are never merged; proofs only ever add; the lock names are additive and named by proved identities;
//   * the decision - the order of the checks, every scenario of the plan (D1, D2, D3, A, B, C, D, E1, E2, F, G), and invariants over thousands of generated worlds;
//   * the answers - one coarse answer for the session alone, whatever the reason and the state; an order named only to a proof the status page would accept;
//   * the limit E2 - written down as a limit that is NOT closed here.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  allLockNames, arbitrateReservation, classifySiblings, disclosureLevelOf, EMPTY_SCOPE, HOLD_CODE, HOLD_MESSAGE, isCarrierOfOrderPayment, isEmptyScope, isInDoubt, isOwnerLockName,
  mayStillBePayable, orderInScope, ownerLockNames, OWNER_LOCK_PREFIX, planOwnerIntent, proofAllowsReuse, proofOf, publicResponseFor, REPEAT_CONFIRMATION_CODE, REPEAT_CONFIRMATION_MESSAGE,
  reservationScope, scopeOf, scopeOfOrder, unionScopes,
  type AttemptFacts, type Holder, type OwnerEvidence, type OwnerIntentDecision, type OwnerIntentInput, type OwnerScope, type ProofKind, type ReservationVerdict, type SiblingOrder,
} from '../lib/owner-intent'
import * as planner from '../lib/owner-intent'
import { ownershipProof, PURCHASE_REFUSAL_CODE, purchaseKeyLockName, purchaseRefusal } from '../lib/purchase-intent'

const ROOT = process.cwd()
const MODULE = 'lib/owner-intent.ts'
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

// ====================================================================================================================================================================
// facts
// ====================================================================================================================================================================
const MIN = 60_000
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)
// (`reservingMs: 0`: the rule of P2 about an order that was just made is off here, and has its own section - 6c - where it is on)
const WINDOWS = { duplicateMs: 60 * MIN, repeatMs: 60 * MIN, reservingMs: 0 }
const CART = 'c'.repeat(64)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'd'.repeat(64)
const ACCOUNT = 'user_account_1'

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Attempt = AttemptFacts & { id: string }
let seq = 0
function attempt(status: string, over: Partial<Attempt> = {}): Attempt {
  seq += 1
  return { id: `att_${seq}`, status, stripeSessionId: status === 'creating' ? null : `cs_test_${seq}`, failureReason: null, stripePaymentIntentId: null, ...over }
}
const livePage = (over: Partial<Attempt> = {}) => attempt('open', over)
const closedProved = (over: Partial<Attempt> = {}) => attempt('expired', { failureReason: 'closed_by_us:order_cancelled', ...over })
const closedUnproved = (over: Partial<Attempt> = {}) => attempt('expired', { failureReason: null, ...over })
const carrierPage = (intent = 'pi_1') => attempt('paid', { stripePaymentIntentId: intent })

function order(over: Partial<SiblingOrder> & { id: string }): SiblingOrder {
  return {
    userId: null, guestSessionHash: HASH_A, orderNumber: 1000, paymentMethod: 'card', status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null,
    totalCents: 5000, refundedCents: 0, paidAt: null, createdAt: NOW - 5 * MIN, attempts: [], ...over,
  }
}
const paidOrder = (id: string, over: Partial<SiblingOrder> = {}) => order({ id, status: 'queued', paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt: NOW - 10 * MIN, createdAt: NOW - 20 * MIN, attempts: [carrierPage('pi_1')], ...over })
const cancelledOrder = (id: string, over: Partial<SiblingOrder> = {}) => order({ id, status: 'cancelled', paymentStatus: 'canceled', ...over })

const sessionOnly = (hash: string = HASH_A): OwnerEvidence => ({ kind: 'guest', sessionHash: hash, verifiedOrders: [] })
const withCookie = (hash: string | null, ...opened: Array<{ id: string; hash: string | null }>): OwnerEvidence => ({ kind: 'guest', sessionHash: hash, verifiedOrders: opened.map((entry) => ({ id: entry.id, guestSessionHash: entry.hash })) })
const accountEvidence = (userId = ACCOUNT): OwnerEvidence => ({ kind: 'account', userId })

function plan(owner: OwnerEvidence, orders: SiblingOrder[], over: Partial<OwnerIntentInput> = {}): OwnerIntentDecision {
  return planOwnerIntent({ owner, requestTotalCents: 5000, confirmRepeat: false, now: NOW, windows: WINDOWS, orders, listIsComplete: true, ...over })
}
const holder = (orderId: string, proof: ProofKind | null, over: Partial<Holder> = {}): Holder => ({ orderId, orderNumber: 1000, proof, inDoubt: false, ...over })

// ====================================================================================================================================================================
// 0. the module stays pure, stays unconnected, and knows no purchase key
// ====================================================================================================================================================================
function runtimeImports(source: string): string[] {
  const code = withoutComments(source)
  const found: string[] = []
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+(?!type\b)[^;'"]*?\sfrom\s+['"]([^'"]+)['"]/g)) found.push(match[1])
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) found.push(match[1])
  for (const match of code.matchAll(/(?:^|\n)\s*export\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)) found.push(match[1])
  return found
}
function resolveImport(specifier: string, from: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(ROOT, specifier.slice(2)) : path.resolve(path.dirname(path.join(ROOT, from)), specifier)
  for (const suffix of ['.ts', '.tsx', '/index.ts']) if (existsSync(base + suffix)) return path.relative(ROOT, base + suffix)
  return null
}
function importClosure(start: string) {
  const files = new Set<string>()
  const externals = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    for (const specifier of runtimeImports(read(file))) {
      if (specifier.startsWith('@/') || specifier.startsWith('.')) {
        const resolved = resolveImport(specifier, file)
        if (resolved) queue.push(resolved)
        else externals.add(`UNRESOLVED ${specifier}`)
      } else externals.add(specifier)
    }
  }
  return { files: [...files].sort(), externals: [...externals].sort() }
}

test('P6-style guard: the module imports only the pure DR-13 / R1-1b / payment-policy vocabulary, and reads no clock, environment, network or random source', () => {
  const code = withoutComments(read(MODULE))
  assert.deepEqual(runtimeImports(read(MODULE)).sort(), ['@/lib/checkout-session-plan', '@/lib/order-payment-policy', '@/lib/orderworks-status', '@/lib/purchase-intent'])
  for (const forbidden of [/\bDate\b/, /\bprocess\b/, /Math\.random/, /\bfetch\b/, /\bprisma\b/i, /\bstripe\b/i, /\brequire\(/, /\bsetTimeout\b/, /\bperformance\b/, /\bconsole\b/, /randomBytes|randomUUID|getRandomValues/, /\bawait\b|\basync\b/]) {
    assert.equal(forbidden.test(code), false, `the module must not contain ${forbidden}`)
  }
})

test('P6-style guard: everything the module reaches at run time is pure too - nothing reaches the database, the provider, the framework or any package but node:crypto', () => {
  const closure = importClosure(MODULE)
  assert.deepEqual(closure.externals, ['node:crypto'], `reached: ${closure.files.join(', ')}`)
  for (const forbidden of ['lib/db.ts', 'lib/stripe.ts', 'lib/stripe-payments.ts', 'lib/payment-sync.ts', 'lib/checkout-orders.ts', 'lib/checkout-sessions.ts', 'lib/checkout-pages.ts']) {
    assert.equal(closure.files.includes(forbidden), false, `${forbidden} must not be reached`)
  }
  assert.ok(closure.files.includes('lib/checkout-session-plan.ts') && closure.files.includes('lib/purchase-intent.ts'), 'it is built on DR-13 and R1-1b, not beside them')
})

test('NOT CONNECTED (P1): nothing in app/, components/, lib/ or scripts/ uses the module yet - P2 connects it, and replaces this guard with the tests of the connection', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.next') walk(relative, out) } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(relative)
    }
    return out
  }
  const users = ['app', 'components', 'lib', 'scripts'].flatMap((dir) => walk(dir)).filter((file) => file !== MODULE && /owner-intent/.test(read(file)))
  assert.deepEqual(users, [])
})

test('a purchase KEY is never an identity: no function of the module takes one, no lock is named by one', () => {
  const code = withoutComments(read(MODULE))
  assert.equal(/purchaseKey|checkoutKey|storedKey|keyHash|PURCHASE_KEY/.test(code), false)
  // and the lock of a key is another family: it can never be the name of an owner lock
  assert.equal(isOwnerLockName(purchaseKeyLockName('e'.repeat(64))), false)
})

test('the words of the answer are the ones the route says today (a drift would be a decision, not an accident)', () => {
  const route = read('app/api/checkout/session/route.ts')
  assert.ok(route.includes(`'${HOLD_CODE}'`) && route.includes(HOLD_MESSAGE), 'PAYMENT_IN_PROGRESS and its sentence are the route\'s own')
  assert.equal(HOLD_CODE, 'PAYMENT_IN_PROGRESS')
  assert.equal(REPEAT_CONFIRMATION_CODE, 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED')
  assert.ok(read('lib/checkout-client.ts').includes('PAYMENT_IN_PROGRESS'), 'the client already knows the hold code')
})

// ====================================================================================================================================================================
// 1. mayStillBePayable - the one definition
// ====================================================================================================================================================================
const SESSION_IDS: Array<string | null> = [null, 'cs_test_abc123', 'cs_live_XYZ_9', 'not-a-session-id', '']
const REASONS: Array<string | null | undefined> = [
  null, undefined, '', 'closed_by_us:order_paid', 'closed_by_us:session_mismatch:amount', 'provider_status:expired', 'provider_status:expired (session_mismatch:currency)', 'local_refusal:price_changed',
  'provider_rejected:invalid_request', 'stale_reservation', 'session_mismatch:amount', 'payment_failed', 'payment_canceled', 'admin_released', 'expired', 'paid', 'cancelled', 'closed_by_us', 'provider_status',
]
const ATTEMPT_STATUSES = ['creating', 'open', 'processing', 'mismatch', 'paid', 'expired', 'failed', 'canceled', 'cancelled', 'requires_action', '', 'OPEN', 'Expired', 'unknown_status']
const ORDER_STATUSES = ['pending', 'processing', 'paid', 'free', 'refunded', 'canceled', 'failed', 'succeeded', ' PAID ', 'requires_capture', 'unpaid']
const INTENTS: Array<string | null | undefined> = [null, undefined, '', 'pi_1', 'pi_2']

// the plan's table (REV3, 1.2), written out again here from the plan - not from the module
function expectedPayable(a: AttemptFacts, o: { paymentStatus: string; stripePaymentIntentId?: string | null }): boolean {
  const reason = a.failureReason ?? ''
  const shapedId = typeof a.stripeSessionId === 'string' && /^cs_[A-Za-z0-9_]{1,255}$/.test(a.stripeSessionId)
  const providerWord = reason.startsWith('closed_by_us:') || reason.startsWith('provider_status:expired')
  const neverCreated = reason.startsWith('local_refusal:') || reason.startsWith('provider_rejected:')
  switch (a.status) {
    case 'creating': case 'open': case 'processing': case 'mismatch': return true
    case 'expired': case 'failed':
      if (reason === 'stale_reservation') return true
      return shapedId ? !providerWord : !neverCreated
    case 'paid': {
      const verified = ['paid', 'free', 'refunded'].includes((o.paymentStatus ?? '').trim().toLowerCase()) || ['success', 'succeeded'].includes((o.paymentStatus ?? '').trim().toLowerCase())
      return !(Boolean(a.stripePaymentIntentId) && a.stripePaymentIntentId === o.stripePaymentIntentId && verified)
    }
    default: return true
  }
}

test('mayStillBePayable: the plan\'s table, row by row', () => {
  const unpaid = { paymentStatus: 'pending', stripePaymentIntentId: null }
  const paid = { paymentStatus: 'paid', stripePaymentIntentId: 'pi_1' }
  const rows: Array<[string, AttemptFacts, { paymentStatus: string; stripePaymentIntentId?: string | null }, boolean]> = [
    ['creating (a reservation of any age is never closed by the clock)', { status: 'creating', stripeSessionId: null }, unpaid, true],
    ['open', { status: 'open', stripeSessionId: 'cs_test_1' }, unpaid, true],
    ['processing (money is moving)', { status: 'processing', stripeSessionId: 'cs_test_1' }, unpaid, true],
    ['mismatch', { status: 'mismatch', stripeSessionId: 'cs_test_1' }, unpaid, true],
    ['expired with the provider\'s word (closed by us)', { status: 'expired', stripeSessionId: 'cs_test_1', failureReason: 'closed_by_us:order_cancelled' }, unpaid, false],
    ['expired with the provider\'s word (it expired by itself)', { status: 'expired', stripeSessionId: 'cs_test_1', failureReason: 'provider_status:expired' }, unpaid, false],
    ['failed with the provider\'s word', { status: 'failed', stripeSessionId: 'cs_test_1', failureReason: 'closed_by_us:order_paid' }, unpaid, false],
    ['expired WITH an identifier and WITHOUT the word: an identifier is not a proof', { status: 'expired', stripeSessionId: 'cs_test_1', failureReason: null }, unpaid, true],
    ['expired with an identifier and a reason that only names a cause (session_mismatch:)', { status: 'expired', stripeSessionId: 'cs_test_1', failureReason: 'session_mismatch:amount' }, unpaid, true],
    ['failed with an identifier and payment_failed', { status: 'failed', stripeSessionId: 'cs_test_1', failureReason: 'payment_failed' }, unpaid, true],
    ['admin_released with an identifier', { status: 'expired', stripeSessionId: 'cs_test_1', failureReason: 'admin_released' }, unpaid, true],
    ['closed by the clock (stale_reservation), with an identifier', { status: 'expired', stripeSessionId: 'cs_test_1', failureReason: 'stale_reservation' }, unpaid, true],
    ['closed by the clock (stale_reservation), without one', { status: 'expired', stripeSessionId: null, failureReason: 'stale_reservation' }, unpaid, true],
    ['local refusal without an identifier: nothing was ever created', { status: 'failed', stripeSessionId: null, failureReason: 'local_refusal:price_changed' }, unpaid, false],
    ['provider rejected without an identifier: nothing was ever created', { status: 'failed', stripeSessionId: null, failureReason: 'provider_rejected:invalid_request' }, unpaid, false],
    ['local refusal WITH an identifier: a page may exist', { status: 'failed', stripeSessionId: 'cs_test_1', failureReason: 'local_refusal:x' }, unpaid, true],
    ['expired without an identifier and without any proof: nobody knows if a page exists', { status: 'expired', stripeSessionId: null, failureReason: null }, unpaid, true],
    ['expired with something that is not a session id', { status: 'expired', stripeSessionId: 'not-a-session-id', failureReason: null }, unpaid, true],
    ['the carrier: paid, the order\'s own PaymentIntent, payment verified', { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_1' }, paid, false],
    ['paid with ANOTHER PaymentIntent: money on a page that is not the order\'s', { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_2' }, paid, true],
    ['paid without a PaymentIntent', { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: null }, paid, true],
    ['paid, the order does not say it is paid', { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_1' }, { paymentStatus: 'pending', stripePaymentIntentId: 'pi_1' }, true],
    ['paid, the order has no PaymentIntent', { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_1' }, { paymentStatus: 'paid', stripePaymentIntentId: null }, true],
    ['the carrier of an order whose payment was verified and refunded since', { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_1' }, { paymentStatus: 'refunded', stripePaymentIntentId: 'pi_1' }, false],
    ['a state nobody knows', { status: 'quantum', stripeSessionId: 'cs_test_1' }, unpaid, true],
  ]
  for (const [name, a, o, expected] of rows) assert.equal(mayStillBePayable(a, o), expected, name)
})

test('mayStillBePayable: exhaustive over status x identifier x reason x order state x payment intents agrees with the plan\'s table', () => {
  let checked = 0
  for (const status of ATTEMPT_STATUSES) for (const stripeSessionId of SESSION_IDS) for (const failureReason of REASONS) for (const attemptIntent of INTENTS) for (const paymentStatus of ORDER_STATUSES) for (const orderIntent of INTENTS) {
    const a: AttemptFacts = { status, stripeSessionId, failureReason, stripePaymentIntentId: attemptIntent }
    const o = { paymentStatus, stripePaymentIntentId: orderIntent }
    assert.equal(mayStillBePayable(a, o), expectedPayable(a, o), JSON.stringify({ a, o }))
    checked += 1
  }
  assert.ok(checked > 100_000)
})

test('NO SURROGATE AUTHORISES: nothing but the provider\'s word, the proof that nothing was created, or the carrier makes a page not payable', () => {
  // (a) for every attempt that is not `paid`, the answer does not depend on the order at all: its state (paid, cancelled, failed, refunded...) and its intents are no proof of anything about the page
  for (const status of ATTEMPT_STATUSES.filter((entry) => entry !== 'paid')) for (const stripeSessionId of SESSION_IDS) for (const failureReason of REASONS) {
    const a: AttemptFacts = { status, stripeSessionId, failureReason }
    const answers = new Set<boolean>()
    for (const paymentStatus of ORDER_STATUSES) for (const orderIntent of INTENTS) answers.add(mayStillBePayable(a, { paymentStatus, stripePaymentIntentId: orderIntent }))
    assert.equal(answers.size, 1, `an order's state changed the answer for ${JSON.stringify(a)}`)
  }
  // (b) a closed row is not payable only through one of the three proofs
  for (const status of ['expired', 'failed']) for (const stripeSessionId of SESSION_IDS) for (const failureReason of REASONS) {
    const a: AttemptFacts = { status, stripeSessionId, failureReason }
    if (mayStillBePayable(a, { paymentStatus: 'pending' })) continue
    const reason = failureReason ?? ''
    const shaped = typeof stripeSessionId === 'string' && /^cs_[A-Za-z0-9_]{1,255}$/.test(stripeSessionId)
    const proof = shaped ? /^(closed_by_us:|provider_status:expired)/.test(reason) : /^(local_refusal:|provider_rejected:)/.test(reason)
    assert.ok(proof, `${JSON.stringify(a)} was called not payable without a proof`)
  }
  // (c) a `paid` row is not payable only as the carrier of a payment that was verified
  for (const attemptIntent of INTENTS) for (const orderIntent of INTENTS) for (const paymentStatus of ORDER_STATUSES) {
    const a: AttemptFacts = { status: 'paid', stripeSessionId: 'cs_test_1', stripePaymentIntentId: attemptIntent }
    const o = { paymentStatus, stripePaymentIntentId: orderIntent }
    if (!mayStillBePayable(a, o)) assert.ok(Boolean(attemptIntent) && attemptIntent === orderIntent && isCarrierOfOrderPayment(a, o))
  }
  // (d) and only a `paid` row can be the carrier, whatever else it says
  for (const status of ATTEMPT_STATUSES.filter((entry) => entry !== 'paid')) {
    assert.equal(isCarrierOfOrderPayment({ status, stripeSessionId: 'cs_test_1', stripePaymentIntentId: 'pi_1' }, { paymentStatus: 'paid', stripePaymentIntentId: 'pi_1' }), false, status)
  }
})

test('mayStillBePayable is total: it never throws, whatever strings (or nothing) the row holds - and a state nobody knows is "yes"', () => {
  const texts: Array<string | null | undefined> = [null, undefined, '', ' ', 'x', 'cs_', 'cs_\n', 'closed_by_us:'.repeat(50), '\u0000', 'ünïcode', 'a'.repeat(10_000)]
  for (const status of [...ATTEMPT_STATUSES, ...texts.filter((entry): entry is string => typeof entry === 'string')]) for (const stripeSessionId of texts) for (const failureReason of texts) for (const stripePaymentIntentId of texts) {
    const answer = mayStillBePayable({ status, stripeSessionId: stripeSessionId ?? null, failureReason, stripePaymentIntentId }, { paymentStatus: 'paid', stripePaymentIntentId: 'pi_1' })
    assert.equal(typeof answer, 'boolean')
    if (!ATTEMPT_STATUSES.includes(status) && !['', ' '].includes(status)) assert.equal(answer, true, `a state nobody knows: ${JSON.stringify(status)}`)
  }
})

// ====================================================================================================================================================================
// 2. a payment in doubt - the same four conditions as PAYMENT_IN_DOUBT_WHERE
// ====================================================================================================================================================================
test('isInDoubt: the four conditions, and nothing else', () => {
  const base = { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null as string | null }
  const none: Array<{ status: string }> = []
  assert.equal(isInDoubt(base, none), false)
  assert.equal(isInDoubt({ ...base, paymentStatus: 'processing' }, none), true, 'the order says money is moving')
  assert.equal(isInDoubt({ ...base, paymentReviewReason: 'dispute' }, none), true, 'a person has to look')
  assert.equal(isInDoubt({ ...base, paymentReviewReason: '' }, none), true, 'IS NOT NULL: an empty reason is a reason')
  assert.equal(isInDoubt({ ...base, status: 'awaiting_review', paymentStatus: 'paid' }, none), true)
  assert.equal(isInDoubt({ ...base, status: 'awaiting_review', paymentStatus: 'free' }, none), true)
  assert.equal(isInDoubt({ ...base, status: 'awaiting_review', paymentStatus: 'pending' }, none), false, 'awaiting review but nothing paid')
  assert.equal(isInDoubt({ ...base, status: 'queued', paymentStatus: 'paid' }, none), false, 'paid and in the queue')
  assert.equal(isInDoubt(base, [{ status: 'processing' }]), true)
  assert.equal(isInDoubt(base, [{ status: 'mismatch' }]), true)
  for (const status of ['creating', 'open', 'paid', 'expired', 'failed']) assert.equal(isInDoubt(base, [{ status }]), false, `an attempt that is ${status} is not a doubt`)
})

// ====================================================================================================================================================================
// 3. scope and proof
// ====================================================================================================================================================================
test('scopeOf: what a request proves - sorted, without duplicates, nothing it does not prove', () => {
  assert.deepEqual(scopeOf(null), EMPTY_SCOPE)
  assert.deepEqual(scopeOf(accountEvidence()), { userId: ACCOUNT, hashes: [], orderIds: [], hashlessOrderIds: [] })
  assert.deepEqual(scopeOf(sessionOnly(HASH_B)), { userId: null, hashes: [HASH_B], orderIds: [], hashlessOrderIds: [] })
  assert.deepEqual(scopeOf({ kind: 'guest', sessionHash: null, verifiedOrders: [] }), EMPTY_SCOPE, 'no session and no cookie proves nothing')
  assert.deepEqual(scopeOf({ kind: 'guest', sessionHash: '', verifiedOrders: [] }), EMPTY_SCOPE, 'an empty hash proves nothing')
  const scope = scopeOf(withCookie(HASH_B, { id: 'o_2', hash: HASH_A }, { id: 'o_1', hash: HASH_A }, { id: 'o_3', hash: null }, { id: 'o_1', hash: HASH_A }))
  assert.deepEqual(scope, { userId: null, hashes: [HASH_A, HASH_B], orderIds: ['o_1', 'o_2', 'o_3'], hashlessOrderIds: ['o_3'] })
  assert.equal(isEmptyScope(scope), false)
  assert.equal(isEmptyScope(scopeOf(null)), true)
})

test('scopeOf throws on an identity that is not an identity (a name and a query are built from it; dropping it would narrow the scope without a word)', () => {
  const bad: Array<[string, () => unknown]> = [
    ['short hash', () => scopeOf(sessionOnly('abc'))],
    ['upper-case hash', () => scopeOf(sessionOnly('A'.repeat(64)))],
    ['non-hex hash', () => scopeOf(sessionOnly('g'.repeat(64)))],
    ['hash of a verified order', () => scopeOf(withCookie(HASH_A, { id: 'o_1', hash: 'nope' }))],
    ['order id with a colon', () => scopeOf(withCookie(HASH_A, { id: 'o:1', hash: HASH_A }))],
    ['empty order id', () => scopeOf(withCookie(HASH_A, { id: '', hash: HASH_A }))],
    ['order id with a space', () => scopeOf(withCookie(HASH_A, { id: 'o 1', hash: HASH_A }))],
    ['account id with a colon', () => scopeOf(accountEvidence('a:b'))],
    ['empty account id', () => scopeOf(accountEvidence(''))],
    ['newline in an id', () => scopeOf(accountEvidence('a\nb'))],
  ]
  for (const [name, run] of bad) assert.throws(run, TypeError, name)
})

test('scopeOfOrder: an order is its account\'s, or its hash\'s, or - with no hash - its own id', () => {
  assert.deepEqual(scopeOfOrder({ id: 'o_1', userId: ACCOUNT, guestSessionHash: HASH_A }), scopeOf(accountEvidence()))
  assert.deepEqual(scopeOfOrder({ id: 'o_1', userId: null, guestSessionHash: HASH_A }), { userId: null, hashes: [HASH_A], orderIds: [], hashlessOrderIds: [] })
  assert.deepEqual(scopeOfOrder({ id: 'o_1', userId: null, guestSessionHash: null }), { userId: null, hashes: [], orderIds: ['o_1'], hashlessOrderIds: ['o_1'] })
  assert.deepEqual(scopeOfOrder({ id: 'o_1', userId: null, guestSessionHash: '' }), { userId: null, hashes: [], orderIds: ['o_1'], hashlessOrderIds: ['o_1'] })
})

test('orderInScope: accounts by userId, guests by a proved hash or a verified id - and two guests with the same cart are never merged', () => {
  const mine = { id: 'o_1', userId: null, guestSessionHash: HASH_A }
  const sameBrowserLater = { id: 'o_2', userId: null, guestSessionHash: HASH_A }
  const stranger = { id: 'o_3', userId: null, guestSessionHash: HASH_C }
  const hashless = { id: 'o_4', userId: null, guestSessionHash: null }
  const emptyHash = { id: 'o_5', userId: null, guestSessionHash: '' }
  const accountOrder = { id: 'o_6', userId: ACCOUNT, guestSessionHash: null }
  const otherAccount = { id: 'o_7', userId: 'user_account_2', guestSessionHash: null }
  const guest = scopeOf(sessionOnly(HASH_A))
  assert.deepEqual([mine, sameBrowserLater, stranger, hashless, emptyHash, accountOrder, otherAccount].map((o) => orderInScope(o, guest)), [true, true, false, false, false, false, false])
  const account = scopeOf(accountEvidence())
  assert.deepEqual([mine, sameBrowserLater, stranger, hashless, emptyHash, accountOrder, otherAccount].map((o) => orderInScope(o, account)), [false, false, false, false, false, true, false])
  // a verified id opens an order whatever its hash says; an order of no hash is no one's by "two empty values are equal"
  const withIds = scopeOf(withCookie(HASH_A, { id: 'o_4', hash: null }, { id: 'o_3', hash: HASH_C }))
  assert.deepEqual([mine, stranger, hashless, emptyHash].map((o) => orderInScope(o, withIds)), [true, true, true, false])
  assert.equal(orderInScope(emptyHash, scopeOf({ kind: 'guest', sessionHash: '', verifiedOrders: [] })), false)
  // an order of an ACCOUNT is never reached by a guest's proofs, not even by a verified id
  assert.equal(orderInScope(accountOrder, scopeOf(withCookie(HASH_A, { id: 'o_6', hash: null }))), false)
})

test('unionScopes / reservationScope: proofs only ever add; the reservation never looks at less than the order\'s own columns', () => {
  const a = scopeOf(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }))
  const b = scopeOf(withCookie(HASH_B, { id: 'o_2', hash: null }))
  const both = unionScopes(a, b)
  assert.deepEqual(both, { userId: null, hashes: [HASH_A, HASH_B], orderIds: ['o_1', 'o_2'], hashlessOrderIds: ['o_2'] })
  assert.deepEqual(unionScopes(b, a), both, 'commutative')
  assert.deepEqual(unionScopes(a, a), a, 'idempotent')
  assert.deepEqual(unionScopes(a, EMPTY_SCOPE), a)
  assert.deepEqual(unionScopes(unionScopes(a, b), scopeOf(accountEvidence())), unionScopes(a, unionScopes(b, scopeOf(accountEvidence()))), 'associative')
  assert.throws(() => unionScopes(scopeOf(accountEvidence()), scopeOf(accountEvidence('user_account_2'))), TypeError, 'two accounts are not a union')
  const reserved = { id: 'o_9', userId: null, guestSessionHash: HASH_C }
  assert.deepEqual(reservationScope(null, reserved), scopeOfOrder(reserved), 'no request: the columns')
  assert.deepEqual(reservationScope(sessionOnly(HASH_A), reserved), { userId: null, hashes: [HASH_A, HASH_C], orderIds: [], hashlessOrderIds: [] })
  assert.deepEqual(reservationScope(accountEvidence(), { id: 'o_9', userId: ACCOUNT, guestSessionHash: null }), scopeOf(accountEvidence()))
})

test('scopes only grow with the proofs: more evidence never removes an order from the scope, a lock name, or a proof level', () => {
  const next = rng(7)
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]
  const hashes = [HASH_A, HASH_B, HASH_C]
  const ids = ['o_1', 'o_2', 'o_3', 'o_4']
  for (let round = 0; round < 400; round += 1) {
    const smaller: Array<{ id: string; hash: string | null }> = []
    for (const id of ids) if (next() < 0.4) smaller.push({ id, hash: next() < 0.2 ? null : pick(hashes) })
    const larger = [...smaller]
    for (const id of ids) if (!larger.some((entry) => entry.id === id) && next() < 0.5) larger.push({ id, hash: next() < 0.2 ? null : pick(hashes) })
    const sessionHash = next() < 0.3 ? null : pick(hashes)
    const e1 = withCookie(sessionHash, ...smaller)
    const e2 = withCookie(sessionHash ?? pick(hashes), ...larger)
    const s1 = scopeOf(e1)
    const s2 = scopeOf(e2)
    for (const identity of s1.hashes) assert.ok(s2.hashes.includes(identity))
    for (const identity of s1.orderIds) assert.ok(s2.orderIds.includes(identity))
    const names1 = ownerLockNames(s1, CART)
    const names2 = ownerLockNames(s2, CART)
    for (const name of names1) assert.ok(names2.includes(name), `${name} was lost when proofs were added`)
    assert.equal(names1.length === 0, isEmptyScope(s1), 'a lock is named by a proved identity, and every proved identity names one')
    assert.equal(names2.length === 0, isEmptyScope(s2))
    for (const id of ids) for (const hash of [...hashes, null]) {
      const o = { id, userId: null, guestSessionHash: hash }
      if (orderInScope(o, s1)) assert.ok(orderInScope(o, s2))
      assert.ok(disclosureLevelOf(proofOf(o, e2)) >= disclosureLevelOf(proofOf(o, e1)), 'a proof level went down')
    }
  }
})

test('proofOf: the strongest proof there is; it is non-null exactly when the order is in the scope', () => {
  const mine = { id: 'o_1', userId: null, guestSessionHash: HASH_A }
  const lineageOnly = { id: 'o_2', userId: null, guestSessionHash: HASH_A }
  const stranger = { id: 'o_3', userId: null, guestSessionHash: HASH_C }
  assert.equal(proofOf(mine, sessionOnly(HASH_A)), 'session')
  assert.equal(proofOf(mine, withCookie(HASH_A, { id: 'o_1', hash: HASH_A })), 'access', 'the cookie is stronger than the session, as the route\'s `via` has it')
  assert.equal(proofOf(mine, withCookie(HASH_B, { id: 'o_1', hash: HASH_A })), 'access')
  assert.equal(proofOf(lineageOnly, withCookie(HASH_B, { id: 'o_1', hash: HASH_A })), 'lineage', 'the hash of an order the cookie opened: the same browser, an earlier session')
  assert.equal(proofOf(stranger, withCookie(HASH_B, { id: 'o_1', hash: HASH_A })), null)
  assert.equal(proofOf({ id: 'o_6', userId: ACCOUNT, guestSessionHash: null }, accountEvidence()), 'account')
  assert.equal(proofOf({ id: 'o_6', userId: ACCOUNT, guestSessionHash: null }, sessionOnly(HASH_A)), null, 'an account order is not proved by a session')
  // ...not even when it carries the very hash of the session, or its id is in the cookie: an account\'s order is the account\'s
  assert.equal(proofOf({ id: 'o_6', userId: ACCOUNT, guestSessionHash: HASH_A }, sessionOnly(HASH_A)), null)
  assert.equal(proofOf({ id: 'o_6', userId: ACCOUNT, guestSessionHash: HASH_A }, withCookie(HASH_B, { id: 'o_6', hash: HASH_A })), null)
  assert.equal(proofOf({ id: 'o_6', userId: ACCOUNT, guestSessionHash: null }, withCookie(HASH_B, { id: 'o_6', hash: null })), null)
  assert.equal(proofOf({ id: 'o_6', userId: ACCOUNT, guestSessionHash: HASH_A }, withCookie(HASH_B, { id: 'o_x', hash: HASH_A })), null)
  assert.equal(proofOf(mine, accountEvidence()), null, 'a guest order is not proved by an account')
  assert.equal(proofOf({ id: 'o_9', userId: null, guestSessionHash: null }, sessionOnly(HASH_A)), null, 'an order of no hash is proved by no session')
  assert.equal(proofOf(mine, null), null)
  assert.deepEqual([null, 'lineage', 'session', 'access', 'account'].map((kind) => disclosureLevelOf(kind as never)), [0, 1, 1, 2, 3])
  // to be HANDED an order back asks for the request's own session, the order's cookie or the account: a lineage holds, it is never given an order (audit of P1, defect A)
  assert.deepEqual([null, 'lineage', 'session', 'access', 'account'].map((kind) => proofAllowsReuse(kind as never)), [false, false, true, true, true])
  // the equivalence with the scope
  const hashes = [HASH_A, HASH_B, HASH_C, null, '']
  const ids = ['o_1', 'o_2', 'o_3']
  for (const session of hashes) for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) for (const storedHash of hashes) for (const id of ids) {
    const opened = ids.filter((_, index) => (mask >> index) & 1).map((entry, index) => ({ id: entry, hash: [HASH_A, HASH_B, null][index] as string | null }))
    const evidence = withCookie(session, ...opened)
    for (const userId of [null, ACCOUNT]) {
      const o = { id, userId, guestSessionHash: storedHash }
      assert.equal(orderInScope(o, scopeOf(evidence)), proofOf(o, evidence) !== null, JSON.stringify({ evidence, o }))
    }
  }
})

test('proofOf agrees with R1-1b\'s ownershipProof and with the route\'s `via`: it only ever adds the "lineage" level, and puts the cookie before the session', () => {
  const stored: Record<string, string | null> = { o_1: HASH_A, o_2: HASH_B, o_3: null }
  const candidates = [{ id: 'o_1', hash: HASH_A }, { id: 'o_2', hash: HASH_B }, { id: 'o_3', hash: null }, { id: 'o_4', hash: HASH_A }, { id: 'o_5', hash: HASH_C }, { id: 'o_6', hash: null }, { id: 'o_7', hash: '' }]
  for (const session of [HASH_A, HASH_B, HASH_C, null, '']) for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const opened = ['o_1', 'o_2', 'o_3'].filter((_, index) => (mask >> index) & 1)
    const evidence = withCookie(session, ...opened.map((id) => ({ id, hash: stored[id] })))
    for (const candidate of candidates) {
      const o = { id: candidate.id, userId: null, guestSessionHash: candidate.hash }
      const r11b = ownershipProof(o, session, new Set(opened))
      const mine = proofOf(o, evidence)
      if (r11b === null) assert.ok(mine === null || mine === 'lineage', JSON.stringify({ session, opened, candidate, mine }))
      else assert.ok(mine === 'access' || mine === 'session', JSON.stringify({ session, opened, candidate, mine }))
      // an order may be handed back exactly when R1-1b's own rule says the request owns it - the existing policy, not a new one
      assert.equal(proofAllowsReuse(mine), r11b !== null, JSON.stringify({ session, opened, candidate, mine, r11b }))
      // the route's `via` for an order its query finds (this browser's session made it, or its cookie opens it)
      const found = (Boolean(session) && candidate.hash === session) || opened.includes(candidate.id)
      if (found) assert.equal(mine, opened.includes(candidate.id) ? 'access' : 'session')
    }
  }
})

// ====================================================================================================================================================================
// 4. the locks - additive, named by proved identities, never by a key
// ====================================================================================================================================================================
const NAME_SHAPE = new RegExp(`^${OWNER_LOCK_PREFIX}(?:u:[A-Za-z0-9_-]{1,128}|h:[0-9a-f]{64}|o:[A-Za-z0-9_-]{1,128}):[0-9a-f]{64}$`)

test('ownerLockNames: one name per proved identity and the cart WITHOUT the total, sorted, unique, and of a family no legacy lock belongs to', () => {
  assert.deepEqual(ownerLockNames(EMPTY_SCOPE, CART), [])
  assert.deepEqual(ownerLockNames(scopeOf(accountEvidence()), CART), [`checkout:owner:u:${ACCOUNT}:${CART}`])
  assert.deepEqual(ownerLockNames(scopeOf(sessionOnly(HASH_A)), CART), [`checkout:owner:h:${HASH_A}:${CART}`])
  const names = ownerLockNames(scopeOf(withCookie(HASH_B, { id: 'o_1', hash: HASH_A }, { id: 'o_2', hash: null }, { id: 'o_3', hash: null })), CART)
  assert.deepEqual(names, [`checkout:owner:h:${HASH_A}:${CART}`, `checkout:owner:h:${HASH_B}:${CART}`, `checkout:owner:o:o_2:${CART}`, `checkout:owner:o:o_3:${CART}`])
  assert.deepEqual([...names].sort(), names)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) { assert.match(name, NAME_SHAPE); assert.equal(isOwnerLockName(name), true) }
  // the names the checkout takes today belong to other families: none can be, or equal, an owner lock
  const legacy = [`checkout:${ACCOUNT}:${CART}`, `checkout:guest-session:${HASH_A}:${CART}`, `checkout:guest:${CART}`, purchaseKeyLockName('e'.repeat(64))]
  for (const name of legacy) assert.equal(isOwnerLockName(name), false, name)
  // no collision is possible with an account lock whose id happens to be `owner`: after `checkout:owner:` comes `u:`, `h:` or `o:`, and a fingerprint is hexadecimal
  assert.notEqual(`checkout:owner:${CART}`, names[0])
})

test('ownerLockNames throws on anything that is not an identity - a name is never made from text that could carry a separator', () => {
  const dirty: OwnerScope = { userId: 'a:b', hashes: [], orderIds: [], hashlessOrderIds: [] }
  assert.throws(() => ownerLockNames(dirty, CART), TypeError)
  assert.throws(() => ownerLockNames({ ...EMPTY_SCOPE, hashes: ['xyz'] }, CART), TypeError)
  assert.throws(() => ownerLockNames({ ...EMPTY_SCOPE, hashlessOrderIds: ['o:1'] }, CART), TypeError)
  assert.throws(() => ownerLockNames({ ...EMPTY_SCOPE, hashlessOrderIds: [''] }, CART), TypeError)
  for (const cart of ['', 'c'.repeat(63), 'C'.repeat(64), `${'c'.repeat(63)}:`, 'c'.repeat(64) + '\n']) assert.throws(() => ownerLockNames(scopeOf(sessionOnly()), cart), TypeError, JSON.stringify(cart))
})

test('two guests with disjoint proofs share no owner lock and see none of each other\'s orders (F); the same browser on both sides of a session change shares the old session\'s (E1)', () => {
  const next = rng(11)
  const pool = ['1', '2', '3', '4', '5', '6'].map((digit) => digit.repeat(64))
  for (let round = 0; round < 300; round += 1) {
    const shuffled = [...pool].sort(() => next() - 0.5)
    const left = shuffled.slice(0, 3)
    const right = shuffled.slice(3)
    const evidenceLeft = withCookie(left[0], ...left.slice(1).map((hash, index) => ({ id: `l_${index}`, hash })))
    const evidenceRight = withCookie(right[0], ...right.slice(1).map((hash, index) => ({ id: `r_${index}`, hash })))
    const shared = ownerLockNames(scopeOf(evidenceLeft), CART).filter((name) => ownerLockNames(scopeOf(evidenceRight), CART).includes(name))
    assert.deepEqual(shared, [], 'disjoint proofs, a shared lock')
    // what each of them made (the orders their cookies open, and any new order carrying one of their hashes) is in its own scope and never in the other\'s
    const madeByLeft = [...left.map((hash, index) => ({ id: `n_l${index}`, userId: null, guestSessionHash: hash })), { id: 'l_0', userId: null, guestSessionHash: left[1] }, { id: 'l_1', userId: null, guestSessionHash: left[2] }]
    const madeByRight = [...right.map((hash, index) => ({ id: `n_r${index}`, userId: null, guestSessionHash: hash })), { id: 'r_0', userId: null, guestSessionHash: right[1] }, { id: 'r_1', userId: null, guestSessionHash: right[2] }]
    for (const o of madeByLeft) { assert.equal(orderInScope(o, scopeOf(evidenceLeft)), true); assert.equal(orderInScope(o, scopeOf(evidenceRight)), false, JSON.stringify(o)); assert.equal(proofOf(o, evidenceRight), null) }
    for (const o of madeByRight) { assert.equal(orderInScope(o, scopeOf(evidenceRight)), true); assert.equal(orderInScope(o, scopeOf(evidenceLeft)), false, JSON.stringify(o)); assert.equal(proofOf(o, evidenceLeft), null) }
  }
  const h1Alone = ownerLockNames(scopeOf(withCookie(HASH_A, { id: 'o_1', hash: HASH_A })), CART)
  const h2WithCookie = ownerLockNames(scopeOf(withCookie(HASH_B, { id: 'o_1', hash: HASH_A })), CART)
  assert.deepEqual(h1Alone.filter((name) => h2WithCookie.includes(name)), [`checkout:owner:h:${HASH_A}:${CART}`], 'H1 and H2 (with the cookie of an order of H1) take turns on the old session\'s lock')
})

test('allLockNames: the names the checkout takes today are kept AS THEY ARE; the additive ones join them in one total order, without duplicates', () => {
  const legacy = [`checkout:guest-session:${HASH_A}:${CART}`, `checkout:guest:${CART}`, purchaseKeyLockName('e'.repeat(64)), `checkout:User_ABC.9:${CART}`, 'checkout:Ünï:Case']
  const additive = ownerLockNames(scopeOf(sessionOnly(HASH_A)), CART)
  const all = allLockNames(legacy, additive)
  for (const name of legacy) assert.ok(all.includes(name), `${name} was dropped or renamed`)
  assert.deepEqual(all.filter((name) => !additive.includes(name)), [...legacy].sort(), 'not a character of a legacy name is touched')
  for (const name of additive) assert.ok(all.includes(name))
  assert.deepEqual([...all].sort(), all)
  assert.equal(all.length, legacy.length + additive.length)
  assert.deepEqual(allLockNames(legacy, []), [...legacy].sort(), 'with no additive name it is exactly what the checkout takes today')
  assert.deepEqual(allLockNames([...legacy, ...additive], additive), allLockNames(legacy, additive), 'no duplicates')
  // two requests ordering the same names always get the same order: no wait cycle between them
  assert.deepEqual(allLockNames(additive, legacy), all)
})

test('the locks of a reservation include the order\'s own identity: never fewer than the columns say', () => {
  const guestOrder = { id: 'o_9', userId: null, guestSessionHash: HASH_C }
  assert.ok(ownerLockNames(reservationScope(null, guestOrder), CART).includes(`checkout:owner:h:${HASH_C}:${CART}`))
  assert.ok(ownerLockNames(reservationScope(sessionOnly(HASH_A), guestOrder), CART).includes(`checkout:owner:h:${HASH_C}:${CART}`))
  assert.deepEqual(ownerLockNames(reservationScope(null, { id: 'o_9', userId: null, guestSessionHash: null }), CART), [`checkout:owner:o:o_9:${CART}`])
  assert.deepEqual(ownerLockNames(reservationScope(null, { id: 'o_9', userId: ACCOUNT, guestSessionHash: null }), CART), [`checkout:owner:u:${ACCOUNT}:${CART}`])
})

// ====================================================================================================================================================================
// 5. classifySiblings
// ====================================================================================================================================================================
test('classifySiblings: only the cards of the scope, newest first, each with its kind, its proof and whether it holds a page', () => {
  const owner = withCookie(HASH_B, { id: 'o_cookie', hash: HASH_A })
  const orders = [
    order({ id: 'o_unpaid', guestSessionHash: HASH_B, attempts: [livePage()], createdAt: NOW - 3 * MIN, orderNumber: 11 }),
    paidOrder('o_cookie', { guestSessionHash: HASH_A, createdAt: NOW - 30 * MIN, orderNumber: 12 }),
    cancelledOrder('o_cancelled', { guestSessionHash: HASH_A, attempts: [closedUnproved()], createdAt: NOW - 20 * MIN, orderNumber: 13 }),
    order({ id: 'o_processing', guestSessionHash: HASH_A, paymentStatus: 'processing', createdAt: NOW - 25 * MIN, orderNumber: 14 }),
    order({ id: 'o_cash', guestSessionHash: HASH_A, paymentMethod: 'cash', createdAt: NOW - MIN }),
    order({ id: 'o_stranger', guestSessionHash: HASH_C, attempts: [livePage()], createdAt: NOW - MIN }),
    order({ id: 'o_account', userId: ACCOUNT, guestSessionHash: null, attempts: [livePage()], createdAt: NOW - MIN }),
  ]
  const out = classifySiblings({ owner, scope: scopeOf(owner), orders })
  assert.deepEqual(out.map((s) => [s.orderId, s.kind, s.proof, s.holdsPage]), [
    ['o_unpaid', 'unpaid', 'session', true],
    ['o_cancelled', 'terminal', 'lineage', true],
    ['o_processing', 'in_doubt', 'lineage', false],
    ['o_cookie', 'paid', 'access', false],
  ])
  assert.deepEqual(classifySiblings({ owner, scope: scopeOf(owner), orders, excludeOrderId: 'o_unpaid' }).map((s) => s.orderId), ['o_cancelled', 'o_processing', 'o_cookie'], 'the order being reserved is not its own sibling')
  const a = classifySiblings({ owner, scope: scopeOf(owner), orders })
  const b = classifySiblings({ owner, scope: scopeOf(owner), orders: [...orders].reverse() })
  assert.deepEqual(a, b, 'the same list for everybody, whatever order the rows were read in')
})

test('classifySiblings: a tie in time is broken by the id, and an unknown time is the oldest', () => {
  const owner = sessionOnly(HASH_A)
  const out = classifySiblings({
    owner, scope: scopeOf(owner),
    orders: [order({ id: 'o_a', createdAt: NOW - MIN }), order({ id: 'o_b', createdAt: NOW - MIN }), order({ id: 'o_c', createdAt: null }), order({ id: 'o_d', createdAt: 'not a date' as unknown as string }), order({ id: 'o_e', createdAt: Number.POSITIVE_INFINITY })],
  })
  assert.deepEqual(out.map((s) => s.orderId), ['o_b', 'o_a', 'o_e', 'o_d', 'o_c'], 'a time that is not a time (nothing, text, infinity) is the oldest, never the newest')
})

// ====================================================================================================================================================================
// 6. the decision - every scenario of the plan
// ====================================================================================================================================================================
test('D1: the same owner and cart, the total changed, the earlier page payable -> HELD (never a second payable page); at the old total -> the same order', () => {
  const o1 = order({ id: 'o_1', attempts: [livePage()], totalCents: 5000 })
  assert.deepEqual(plan(sessionOnly(), [o1], { requestTotalCents: 6000 }), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_1', 'session')] })
  assert.deepEqual(plan(sessionOnly(), [o1], { requestTotalCents: 5000 }), { kind: 'reuse', orderId: 'o_1' })
  // the earlier page is closed WITH the provider's word: nothing holds, a new order is fine
  assert.deepEqual(plan(sessionOnly(), [order({ id: 'o_1', attempts: [closedProved()], totalCents: 5000 })], { requestTotalCents: 6000 }), { kind: 'create', repeatOf: [] })
  // ...or not closed WITHOUT it: held (D1 uncertain)
  for (const attempts of [[closedUnproved()], [attempt('expired', { stripeSessionId: null })], [attempt('failed', { failureReason: 'payment_failed' })], [attempt('creating')]]) {
    assert.equal(plan(sessionOnly(), [order({ id: 'o_1', attempts, totalCents: 5000 })], { requestTotalCents: 6000 }).kind, 'hold')
  }
})

test('D2: the window of reuse follows the life of the page, not the age of the order', () => {
  const owner = sessionOnly()
  assert.deepEqual(plan(owner, [order({ id: 'o_1', createdAt: NOW - 61 * MIN, attempts: [livePage()] })]), { kind: 'reuse', orderId: 'o_1' }, '61 minutes old, its page alive: the same order')
  assert.deepEqual(plan(owner, [order({ id: 'o_1', createdAt: NOW - 61 * MIN, attempts: [closedProved()] })]), { kind: 'create', repeatOf: [] }, '61 minutes old, its page provably closed: a new purchase')
  assert.deepEqual(plan(owner, [order({ id: 'o_1', createdAt: NOW - 59 * MIN, attempts: [closedProved()] })]), { kind: 'reuse', orderId: 'o_1' }, 'inside the hour: the same order, as today')
  assert.deepEqual(plan(owner, [order({ id: 'o_1', createdAt: NOW - 60 * MIN, attempts: [closedProved()] })]), { kind: 'create', repeatOf: [] }, 'exactly an hour: outside (strictly less than)')
  assert.deepEqual(plan(owner, [order({ id: 'o_1', createdAt: NOW - 5 * 24 * 60 * MIN, attempts: [attempt('creating')] })]), { kind: 'reuse', orderId: 'o_1' }, 'an orphan reservation of any age is never closed by the clock')
  assert.deepEqual(plan(owner, [order({ id: 'o_1', createdAt: NOW - 120 * MIN, attempts: [closedUnproved()] })]), { kind: 'reuse', orderId: 'o_1' }, 'closed without the word: it may be payable, so it is the order to continue')
})

test('D3: a verified payment made lately asks a confirmation - only of a request that proves the paid order with the cookie or the account', () => {
  const paid = paidOrder('o_1')
  assert.deepEqual(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paid]), { kind: 'confirm', orderId: 'o_1', orderNumber: 1000, proof: 'access' })
  assert.deepEqual(plan(accountEvidence(), [paidOrder('o_1', { userId: ACCOUNT, guestSessionHash: null })]), { kind: 'confirm', orderId: 'o_1', orderNumber: 1000, proof: 'account' })
  // the explicit gesture: a new order, and the internal annotation names what it repeats
  assert.deepEqual(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paid], { confirmRepeat: true }), { kind: 'create', repeatOf: ['o_1'] })
  // the session alone: no gate at all - the same as a browser with no history; `confirmRepeat` changes nothing
  assert.deepEqual(plan(sessionOnly(), [paid]), { kind: 'create', repeatOf: [] })
  assert.deepEqual(plan(sessionOnly(), [paid], { confirmRepeat: true }), { kind: 'create', repeatOf: [] })
  assert.deepEqual(plan(sessionOnly(), []), { kind: 'create', repeatOf: [] })
  // lineage is a session's strength, not a cookie's
  assert.deepEqual(plan(withCookie(HASH_B, { id: 'o_0', hash: HASH_A }), [paid]), { kind: 'create', repeatOf: [] })
  // outside the window, refunded, cancelled: no gate
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: NOW - 61 * MIN })]).kind, 'create')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: NOW - 60 * MIN })]).kind, 'create', 'exactly the window: outside')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: NOW - 59 * MIN })]).kind, 'confirm')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { refundedCents: 100 })]).kind, 'create', 'a refund (even a partial one) takes the gate away')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paymentStatus: 'refunded' })]).kind, 'create')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { status: 'cancelled' })]).kind, 'create')
  // a payment time that is not a time is no time: the order is dated by its creation
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: Number.POSITIVE_INFINITY, createdAt: NOW - 90 * MIN })]).kind, 'create')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: 'garbage' as unknown as string, createdAt: NOW - 90 * MIN })]).kind, 'create')
  // a paid order with no paidAt is dated by its creation
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: null, createdAt: NOW - 30 * MIN })]).kind, 'confirm')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { paidAt: null, createdAt: NOW - 90 * MIN })]).kind, 'create')
  // several recent payments: the confirmation names the NEWEST one the request proves strongly - never an order it only knows by its session
  const several = withCookie(HASH_A, { id: 'o_a', hash: HASH_A }, { id: 'o_b', hash: HASH_A })
  assert.deepEqual(plan(several, [paidOrder('o_a', { createdAt: NOW - 20 * MIN, orderNumber: 21 }), paidOrder('o_b', { createdAt: NOW - 8 * MIN, orderNumber: 22 }), paidOrder('o_weak', { createdAt: NOW - 2 * MIN, orderNumber: 23 })]),
    { kind: 'confirm', orderId: 'o_b', orderNumber: 22, proof: 'access' })
  assert.deepEqual(plan(several, [paidOrder('o_a', { createdAt: NOW - 20 * MIN, orderNumber: 21 }), paidOrder('o_b', { createdAt: NOW - 8 * MIN, orderNumber: 22 })], { confirmRepeat: true }), { kind: 'create', repeatOf: ['o_b', 'o_a'] }, 'the annotation lists them newest first')
  // a paid order with a page that may still be paid is a hold before it is a confirmation
  assert.equal(plan(withCookie(HASH_A, { id: 'o_1', hash: HASH_A }), [paidOrder('o_1', { attempts: [carrierPage(), livePage()] })]).kind, 'hold')
})

test('A: a CANCELLED order whose page is not provably closed holds the cart; once the provider\'s word is on the row, it does not', () => {
  const cases: Array<[string, Attempt[], 'hold' | 'create']> = [
    ['id, no proof (old code)', [attempt('expired', { failureReason: null })], 'hold'],
    ['id, session_mismatch:', [attempt('expired', { failureReason: 'session_mismatch:amount' })], 'hold'],
    ['id, stale_reservation', [attempt('expired', { failureReason: 'stale_reservation' })], 'hold'],
    ['no id, no proof', [attempt('expired', { stripeSessionId: null, failureReason: null })], 'hold'],
    ['no id, stale_reservation', [attempt('expired', { stripeSessionId: null, failureReason: 'stale_reservation' })], 'hold'],
    ['open', [livePage()], 'hold'],
    ['id, local_refusal: (an id means a page may exist)', [attempt('failed', { failureReason: 'local_refusal:x' })], 'hold'],
    ['closed by us', [attempt('expired', { failureReason: 'closed_by_us:order_cancelled' })], 'create'],
    ['the provider says it expired', [attempt('expired', { failureReason: 'provider_status:expired' })], 'create'],
    ['no id, local_refusal: (nothing was ever created)', [attempt('failed', { stripeSessionId: null, failureReason: 'local_refusal:x' })], 'create'],
    ['no id, provider_rejected:', [attempt('failed', { stripeSessionId: null, failureReason: 'provider_rejected:x' })], 'create'],
    ['one clean, one not', [closedProved(), closedUnproved()], 'hold'],
    ['no attempt at all', [], 'create'],
  ]
  for (const [name, attempts, expected] of cases) for (const total of [5000, 6000]) {
    // (at the SAME total too: a cancelled order is never the order to continue, whatever its page)
    const decision = plan(sessionOnly(), [cancelledOrder('o_1', { attempts })], { requestTotalCents: total })
    assert.equal(decision.kind, expected, `${name} @${total}`)
    if (expected === 'hold') assert.deepEqual(decision, { kind: 'hold', cause: 'sibling_page', holders: [holder('o_1', 'session')] }, `${name} @${total}`)
  }
})

test('B: a PAID order with a second page the provider has not shown closed holds the cart; the carrier alone does not', () => {
  const owner = withCookie(HASH_A, { id: 'o_1', hash: HASH_A })
  assert.deepEqual(plan(owner, [paidOrder('o_1', { attempts: [carrierPage(), livePage()] })]), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_1', 'access')] })
  assert.equal(plan(owner, [paidOrder('o_1', { attempts: [carrierPage(), closedUnproved()] })]).kind, 'hold')
  assert.equal(plan(owner, [paidOrder('o_1', { attempts: [carrierPage(), closedProved()] })]).kind, 'confirm', 'the hidden page is provably closed: only the repeat gate is left')
  assert.equal(plan(sessionOnly(), [paidOrder('o_1', { attempts: [carrierPage(), closedProved()] })]).kind, 'create')
  // a second PAID page with another PaymentIntent is money on a page that is not the order's: held for a person
  assert.equal(plan(owner, [paidOrder('o_1', { attempts: [carrierPage('pi_1'), carrierPage('pi_2')] })]).kind, 'hold')
})

test('C: a terminal order whose every page is provably closed is as if it were not there', () => {
  const clean = [cancelledOrder('o_1', { attempts: [closedProved(), attempt('failed', { stripeSessionId: null, failureReason: 'local_refusal:x' })] }), paidOrder('o_2', { guestSessionHash: HASH_A, createdAt: NOW - 600 * MIN, paidAt: NOW - 590 * MIN })]
  assert.deepEqual(plan(sessionOnly(), clean, { requestTotalCents: 6000 }), { kind: 'create', repeatOf: [] })
  assert.deepEqual(plan(sessionOnly(), [], { requestTotalCents: 6000 }), plan(sessionOnly(), clean, { requestTotalCents: 6000 }))
})

test('a payment in doubt holds, with no limit of time, whatever the total and whatever else is there', () => {
  const owner = sessionOnly()
  const doubts: Array<[string, Partial<SiblingOrder>]> = [
    ['the order says money is moving', { paymentStatus: 'processing' }],
    ['a person has to look', { paymentReviewReason: 'dispute' }],
    ['paid and held for review', { status: 'awaiting_review', paymentStatus: 'paid' }],
    ['a payment that did not match', { attempts: [attempt('mismatch')] }],
    ['an attempt is processing', { attempts: [attempt('processing')] }],
  ]
  for (const [name, over] of doubts) {
    for (const total of [5000, 6000]) for (const age of [MIN, 59 * MIN, 61 * MIN, 400 * 24 * 60 * MIN]) {
      const decision = plan(owner, [order({ id: 'o_1', createdAt: NOW - age, ...over }), order({ id: 'o_2', totalCents: total, attempts: [livePage()] })], { requestTotalCents: total })
      assert.equal(decision.kind, 'hold', name)
      assert.equal((decision as { cause: string }).cause, 'in_doubt', name)
      assert.deepEqual((decision as { holders: unknown[] }).holders, [holder('o_1', 'session', { inDoubt: true })], name)
    }
  }
})

test('D/E1: a NEW session that holds the cookie of an earlier order is still the same owner: that order holds the cart and is named (the cookie opens it)', () => {
  const owner = withCookie(HASH_B, { id: 'o_1', hash: HASH_A })
  const o1 = order({ id: 'o_1', guestSessionHash: HASH_A, attempts: [livePage()], totalCents: 5000 })
  assert.deepEqual(plan(owner, [o1], { requestTotalCents: 6000 }), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_1', 'access')] })
  // an order of the old session that the cookie does not name is known by its hash: weaker
  const o3 = order({ id: 'o_3', guestSessionHash: HASH_A, attempts: [livePage()], totalCents: 5000, createdAt: NOW - MIN })
  assert.deepEqual((plan(owner, [o1, o3], { requestTotalCents: 6000 }) as { holders: unknown[] }).holders, [holder('o_3', 'lineage'), holder('o_1', 'access')])
  // the old session alone does not need the cookie to see its own orders
  assert.equal(plan(sessionOnly(HASH_A), [o1], { requestTotalCents: 6000 }).kind, 'hold')
})

test('F/G: another guest\'s orders - any state, any pages - do not exist for this request; nothing an invalid cookie would have added is in the evidence', () => {
  const strangers = [
    order({ id: 's_1', guestSessionHash: HASH_C, attempts: [livePage()] }), paidOrder('s_2', { guestSessionHash: HASH_C, attempts: [carrierPage(), livePage()] }), order({ id: 's_3', guestSessionHash: HASH_C, paymentStatus: 'processing' }),
    cancelledOrder('s_4', { guestSessionHash: HASH_C, attempts: [closedUnproved()] }), order({ id: 's_5', guestSessionHash: null, attempts: [livePage()] }), order({ id: 's_6', userId: ACCOUNT, guestSessionHash: null, attempts: [livePage()] }),
  ]
  for (const owner of [sessionOnly(HASH_A), withCookie(HASH_A, { id: 'o_9', hash: HASH_A }), accountEvidence('user_account_2')]) {
    assert.deepEqual(plan(owner, strangers, { requestTotalCents: 6000 }), plan(owner, [], { requestTotalCents: 6000 }))
  }
  // an owner with no proof at all has no scope: nothing is seen, and it is the route that refuses it before this is asked
  assert.deepEqual(plan({ kind: 'guest', sessionHash: null, verifiedOrders: [] }, strangers), { kind: 'create', repeatOf: [] })
})

test('an account sees its own orders only; a guest never sees an account\'s - and an account never a guest\'s (D4 stays a limit of identification)', () => {
  const accountOrder = order({ id: 'o_acc', userId: ACCOUNT, guestSessionHash: null, attempts: [livePage()] })
  const guestOrder = order({ id: 'o_gst', guestSessionHash: HASH_A, attempts: [livePage()] })
  assert.deepEqual(plan(accountEvidence(), [accountOrder, guestOrder], { requestTotalCents: 6000 }), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_acc', 'account')] })
  assert.deepEqual(plan(sessionOnly(HASH_A), [accountOrder, guestOrder], { requestTotalCents: 6000 }), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_gst', 'session')] })
  assert.equal(plan(accountEvidence('user_account_2'), [accountOrder, guestOrder], { requestTotalCents: 6000 }).kind, 'create')
})

test('only cards are siblings: an unpaid cash or invoice order of the same cart is not a card checkout to continue', () => {
  for (const paymentMethod of ['cash', 'invoice', 'paypal', 'po', 'quote', '']) {
    assert.deepEqual(plan(sessionOnly(), [order({ id: 'o_1', paymentMethod, attempts: [livePage()] })]), { kind: 'create', repeatOf: [] }, paymentMethod)
  }
})

test('the order of the checks: doubt, then pages that may be paid (more than one, or one that is not the order to continue), then a list that was cut, then the order to continue, then the repeat gate, then create', () => {
  // CORRECTED after the independent audit of P1 (defects B and C). Until d2e1821 this test pinned, as right, two things that are wrong:
  //   * "the order to continue, even though another page is open" was a REUSE - two orders that may both be paid are a HOLD, never a choice (C);
  //   * with a list that was cut a confirmation was still asked ("an incomplete list does not take a confirmation away") and an order that had been read was still continued ("continuing an order
  //     that was seen creates nothing") - a list that is not whole gives nothing, because what was not read may hold the cart (B).
  const owner = withCookie(HASH_A, { id: 'o_paid', hash: HASH_A })
  const doubt = order({ id: 'o_doubt', paymentStatus: 'processing' })
  const sameTotal = order({ id: 'o_same', attempts: [livePage()], createdAt: NOW - 2 * MIN })
  const otherTotal = order({ id: 'o_other', attempts: [livePage()], totalCents: 7000, createdAt: NOW - 3 * MIN })
  const paid = paidOrder('o_paid')
  const incomplete = { kind: 'hold', cause: 'incomplete', holders: [] }
  // 1. doubt first
  assert.equal(plan(owner, [doubt, sameTotal, otherTotal, paid]).kind, 'hold', 'doubt first')
  assert.equal((plan(owner, [doubt, sameTotal, otherTotal, paid]) as { cause: string }).cause, 'in_doubt')
  // 2. pages that may be paid: two of them hold, although one is at the requested total; one that is not the order to continue holds
  assert.deepEqual(plan(owner, [sameTotal, otherTotal, paid]), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_same', 'session'), holder('o_other', 'session')] }, 'two orders may be paid: never a choice between them')
  assert.equal((plan(owner, [otherTotal, paid]) as { cause: string }).cause, 'sibling_page', 'a page that is not the order to continue')
  // 3. a list that was cut gives nothing - but what was read and holds, holds for its own reason
  assert.deepEqual(plan(owner, [sameTotal, paid], { listIsComplete: false }), incomplete, 'not the order to continue')
  assert.deepEqual(plan(owner, [sameTotal], { listIsComplete: false }), incomplete)
  assert.deepEqual(plan(owner, [paid], { listIsComplete: false }), incomplete, 'not a confirmation')
  assert.deepEqual(plan(owner, [paid], { confirmRepeat: true, listIsComplete: false }), incomplete, 'not a new order')
  assert.deepEqual(plan(owner, [], { listIsComplete: false }), incomplete)
  assert.equal((plan(owner, [otherTotal], { listIsComplete: false }) as { cause: string }).cause, 'sibling_page')
  assert.equal((plan(owner, [doubt], { listIsComplete: false }) as { cause: string }).cause, 'in_doubt')
  // 4-5. the order to continue comes before the repeat gate
  assert.deepEqual(plan(owner, [sameTotal, paid]), { kind: 'reuse', orderId: 'o_same' })
  assert.deepEqual(plan(owner, [order({ id: 'o_recent', createdAt: NOW - 2 * MIN }), paid]), { kind: 'reuse', orderId: 'o_recent' })
  // 6. the repeat gate, then create
  assert.equal(plan(owner, [paid]).kind, 'confirm', 'the repeat gate')
  assert.deepEqual(plan(owner, [paid], { confirmRepeat: true }), { kind: 'create', repeatOf: ['o_paid'] })
  assert.deepEqual(plan(owner, [], { listIsComplete: true }), { kind: 'create', repeatOf: [] })
})

test('the order to continue: the ONE order that holds a page; with no page anywhere, the newest made inside the window (a tie by id); never one of two that may both be paid', () => {
  // CORRECTED after the independent audit of P1 (defect C). Until d2e1821 this test pinned "both hold: the newest" - a REUSE of one of two orders that may both be paid. That is a HOLD now; "the newest"
  // and the tie by id are still the rule, among orders WITHOUT a page.
  const owner = sessionOnly()
  const newerNoPage = order({ id: 'o_new', createdAt: NOW - MIN, attempts: [closedProved()] })
  const olderWithPage = order({ id: 'o_old', createdAt: NOW - 50 * MIN, attempts: [livePage()] })
  assert.deepEqual(plan(owner, [newerNoPage, olderWithPage]), { kind: 'reuse', orderId: 'o_old' }, 'the one that holds the page, not the newer one')
  assert.deepEqual(plan(owner, [olderWithPage, newerNoPage]), { kind: 'reuse', orderId: 'o_old' })
  const veryOldWithPage = order({ id: 'o_ancient', createdAt: NOW - 400 * MIN, attempts: [livePage()] })
  assert.deepEqual(plan(owner, [veryOldWithPage, newerNoPage]), { kind: 'reuse', orderId: 'o_ancient' }, 'its age is not a reason: its page may be paid')
  const twinPage = order({ id: 'o_twin', createdAt: NOW - 10 * MIN, attempts: [livePage()] })
  assert.deepEqual(plan(owner, [olderWithPage, twinPage]), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_twin', 'session'), holder('o_old', 'session')] }, 'both hold a page: a hold, not the newest')
  // no page anywhere: the newest inside the window; a tie by id, the same for everybody; outside the window it is another purchase
  const a = order({ id: 'o_a', createdAt: NOW - 10 * MIN, attempts: [closedProved()] })
  const b = order({ id: 'o_b', createdAt: NOW - 10 * MIN, attempts: [] })
  const older = order({ id: 'o_older', createdAt: NOW - 30 * MIN, attempts: [] })
  const outside = order({ id: 'o_outside', createdAt: NOW - 90 * MIN, attempts: [closedProved()] })
  assert.deepEqual(plan(owner, [older, a]), { kind: 'reuse', orderId: 'o_a' }, 'the newest')
  assert.deepEqual(plan(owner, [a, b, older]), { kind: 'reuse', orderId: 'o_b' }, 'a tie: by id')
  assert.deepEqual(plan(owner, [b, a, older]), { kind: 'reuse', orderId: 'o_b' })
  assert.deepEqual(plan(owner, [outside, older]), { kind: 'reuse', orderId: 'o_older' }, 'the one inside the window')
  assert.deepEqual(plan(owner, [outside]), { kind: 'create', repeatOf: [] })
  // at another total nothing is continued
  assert.deepEqual(plan(owner, [a, b, older], { requestTotalCents: 6000 }), { kind: 'create', repeatOf: [] })
})

test('the planner refuses numbers that would silently decide: a NaN window or a total that is not whole cents throws', () => {
  const bad: Array<Partial<OwnerIntentInput>> = [
    { now: Number.NaN }, { now: -1 }, { windows: { duplicateMs: Number.NaN, repeatMs: 1, reservingMs: 0 } }, { windows: { duplicateMs: 1, repeatMs: Number.POSITIVE_INFINITY, reservingMs: 0 } }, { windows: { duplicateMs: -5, repeatMs: 1, reservingMs: 0 } },
    { requestTotalCents: 50.5 }, { requestTotalCents: -1 }, { requestTotalCents: Number.NaN },
  ]
  for (const over of bad) assert.throws(() => plan(sessionOnly(), [], over), TypeError, JSON.stringify(over))
})

// ====================================================================================================================================================================
// 6b. the three corrections asked by the independent audit of P1 (the counterexamples are the auditor's; each of these tests was RED on d2e1821)
// ====================================================================================================================================================================
test('[P1-A] LINEAGE HOLDS, IT DOES NOT GIVE: an order known only through the hash of an earlier session is never the order to continue, and nothing of it is told', () => {
  // the current session is H2; the access cookie is verified for O1, which was made with H1; O2 is ANOTHER order of H1, which the cookie does not open
  const owner = withCookie(HASH_B, { id: 'o_1', hash: HASH_A })
  const o1 = cancelledOrder('o_1', { guestSessionHash: HASH_A, attempts: [closedProved()], createdAt: NOW - 40 * MIN })
  const o2 = (attempts: Attempt[]) => order({ id: 'o_2', orderNumber: 4242, guestSessionHash: HASH_A, totalCents: 5000, createdAt: NOW - 10 * MIN, attempts })
  assert.equal(proofOf(o2([]), owner), 'lineage', 'premise: O2 is proved by lineage only')
  assert.equal(proofOf(o1, owner), 'access', 'premise: O1 is the order the cookie opens')

  // no page of O2 may still be paid: O2 is not handed over and does not stand in the way - a new order is made, and O2 is named nowhere
  const clean: Array<[string, Attempt[]]> = [['no page at all', []], ['a page closed with the provider\'s word', [closedProved()]], ['nothing was ever created', [attempt('failed', { stripeSessionId: null, failureReason: 'local_refusal:x' })]]]
  for (const [name, attempts] of clean) {
    const decision = plan(owner, [o1, o2(attempts)])
    assert.deepEqual(decision, { kind: 'create', repeatOf: [] }, `${name} - CAUSE: the order to continue was chosen without asking HOW the request proves it; a lineage is enough to hold, not to be given the order`)
    assert.equal(publicResponseFor(decision, owner), null, name)
  }
  // a page of O2 may still be paid: the cart is HELD with the one coarse answer - no identifier of O2 leaves
  const payable: Array<[string, Attempt[]]> = [['a live page', [livePage()]], ['a page closed without the provider\'s word', [closedUnproved()]], ['an orphan reservation', [attempt('creating')]]]
  for (const [name, attempts] of payable) {
    const decision = plan(owner, [o1, o2(attempts)])
    assert.deepEqual(decision, { kind: 'hold', cause: 'sibling_page', holders: [holder('o_2', 'lineage', { orderNumber: 4242 })] }, `${name} - CAUSE: as above; with a page that may be paid the lineage HOLDS`)
    const response = publicResponseFor(decision, owner)
    assert.deepEqual(response, UNIFORM_HOLD, name)
    assert.equal(/o_2|4242/.test(JSON.stringify(response)), false, `${name}: an identifier of O2 left the server`)
  }

  // CONTROLS (green before and after): the same O2 proved the way the checkout already requires IS the order to continue
  assert.deepEqual(plan(sessionOnly(HASH_A), [o1, o2([])]), { kind: 'reuse', orderId: 'o_2' }, 'its own session')
  assert.deepEqual(plan(sessionOnly(HASH_A), [o1, o2([livePage()])]), { kind: 'reuse', orderId: 'o_2' }, 'its own session, its page alive')
  assert.deepEqual(plan(withCookie(HASH_B, { id: 'o_2', hash: HASH_A }), [o1, o2([])]), { kind: 'reuse', orderId: 'o_2' }, 'its own access cookie, from another session')
  assert.deepEqual(plan(withCookie(HASH_B, { id: 'o_2', hash: HASH_A }), [o1, o2([livePage()])]), { kind: 'reuse', orderId: 'o_2' })
  assert.deepEqual(plan(accountEvidence(), [order({ id: 'o_2', userId: ACCOUNT, guestSessionHash: null, createdAt: NOW - 10 * MIN })]), { kind: 'reuse', orderId: 'o_2' }, 'the account')
  // and the order the cookie DOES open is continued while the lineage order beside it (no page) is left alone
  const o1Unpaid = order({ id: 'o_1', guestSessionHash: HASH_A, createdAt: NOW - 20 * MIN, attempts: [livePage()] })
  assert.deepEqual(plan(owner, [o1Unpaid, o2([])]), { kind: 'reuse', orderId: 'o_1' })
})

test('[P1-B] A LIST THAT WAS CUT GIVES NOTHING: no order is continued, no confirmation is asked and no order is made when not every order of the scope was read', () => {
  const owner = withCookie(HASH_A, { id: 'o_paid', hash: HASH_A })
  const reusableWithPage = order({ id: 'o_same', attempts: [livePage()], createdAt: NOW - 2 * MIN })
  const reusableNoPage = order({ id: 'o_recent', attempts: [closedProved()], createdAt: NOW - 2 * MIN })
  const incomplete: OwnerIntentDecision = { kind: 'hold', cause: 'incomplete', holders: [] }
  assert.deepEqual(plan(owner, [reusableWithPage], { listIsComplete: false }), incomplete,
    'CAUSE: the list was checked for completeness only on the way to CREATE; an order that looks reusable was handed back although another order with a payable page may be among the ones that were not read')
  assert.deepEqual(plan(owner, [reusableNoPage], { listIsComplete: false }), incomplete, 'a recent order with no page is not continued either')
  assert.deepEqual(plan(owner, [paidOrder('o_paid')], { listIsComplete: false }), incomplete, 'nor is a confirmation asked: what was not read may hold the cart')
  assert.deepEqual(plan(owner, [paidOrder('o_paid')], { listIsComplete: false, confirmRepeat: true }), incomplete)
  assert.deepEqual(plan(owner, [], { listIsComplete: false }), incomplete)
  assert.deepEqual(publicResponseFor(incomplete, owner), UNIFORM_HOLD, 'the answer is the one coarse hold: nothing is named')
  // what WAS read still holds for its own reason (a hold either way: nothing is given)
  assert.equal((plan(owner, [order({ id: 'o_doubt', paymentStatus: 'processing' }), reusableWithPage], { listIsComplete: false }) as { cause: string }).cause, 'in_doubt')
  assert.equal((plan(owner, [order({ id: 'o_other', totalCents: 7000, attempts: [livePage()] })], { listIsComplete: false }) as { cause: string }).cause, 'sibling_page')
  // CONTROLS (green before and after): the same lists, read to the end
  assert.deepEqual(plan(owner, [reusableWithPage]), { kind: 'reuse', orderId: 'o_same' })
  assert.deepEqual(plan(owner, [reusableNoPage]), { kind: 'reuse', orderId: 'o_recent' })
  assert.equal(plan(owner, [paidOrder('o_paid')]).kind, 'confirm')
  assert.deepEqual(plan(owner, []), { kind: 'create', repeatOf: [] })
  // the arbiter is as strict as it was: a list that was cut never lets a reservation through
  assert.deepEqual(arbitrateReservation({ owner, order: order({ id: 'o_new' }), orders: [], listIsComplete: false }), incomplete)
  assert.equal(arbitrateReservation({ owner, order: order({ id: 'o_new' }), orders: [reusableWithPage], listIsComplete: false }).kind, 'hold')
})

test('[P1-C] TWO ORDERS THAT MAY BOTH BE PAID ARE A HOLD, NEVER A REUSE: an order is continued only if no other order of the cart could produce a second payment', () => {
  const owner = sessionOnly()
  const atTotal = order({ id: 'o_same', orderNumber: 1, attempts: [livePage()], totalCents: 5000, createdAt: NOW - 2 * MIN })
  const others: Array<[string, SiblingOrder]> = [
    ['an unpaid order at another total with a live page', order({ id: 'o_other', orderNumber: 2, attempts: [livePage()], totalCents: 7000, createdAt: NOW - 3 * MIN })],
    ['an unpaid order at the SAME total with a live page (twin pages)', order({ id: 'o_other', orderNumber: 2, attempts: [livePage()], totalCents: 5000, createdAt: NOW - 3 * MIN })],
    ['an orphan reservation of another order', order({ id: 'o_other', orderNumber: 2, attempts: [attempt('creating')], totalCents: 7000, createdAt: NOW - 3 * MIN })],
    ['a cancelled order whose page is not provably closed', cancelledOrder('o_other', { orderNumber: 2, attempts: [closedUnproved()], createdAt: NOW - 3 * MIN })],
    ['a paid order with a hidden page', paidOrder('o_other', { orderNumber: 2, attempts: [carrierPage(), livePage()], createdAt: NOW - 3 * MIN, paidAt: NOW - 3 * MIN })],
  ]
  for (const [name, other] of others) {
    const expected = { kind: 'hold', cause: 'sibling_page', holders: [holder('o_same', 'session', { orderNumber: 1 }), holder('o_other', 'session', { orderNumber: 2 })] }
    assert.deepEqual(plan(owner, [atTotal, other]), expected, `${name} - CAUSE: the order at the requested total was continued although another order of the cart holds a page that may be paid too`)
    assert.deepEqual(plan(owner, [other, atTotal]), expected, `${name} (rows read in the other order)`)
    assert.deepEqual(publicResponseFor(plan(owner, [atTotal, other]), owner), UNIFORM_HOLD, name)
  }
  // an order with NO page is not continued either while another order holds one (its reservation would be refused: nothing to give)
  const noPage = order({ id: 'o_recent', orderNumber: 3, attempts: [], totalCents: 5000, createdAt: NOW - MIN })
  assert.deepEqual(plan(owner, [noPage, others[0][1]]), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_other', 'session', { orderNumber: 2 })] },
    'CAUSE: a recent order without a page was continued while another order of the cart holds a payable page')
  // CONTROLS (green before and after): ONE order holds a page and it is the order to continue
  assert.deepEqual(plan(owner, [atTotal]), { kind: 'reuse', orderId: 'o_same' })
  assert.deepEqual(plan(owner, [atTotal, noPage]), { kind: 'reuse', orderId: 'o_same' }, 'the one that holds the page, not the newer one without')
  assert.deepEqual(plan(owner, [atTotal, cancelledOrder('o_c', { attempts: [closedProved()] }), paidOrder('o_p', { paidAt: NOW - 500 * MIN, createdAt: NOW - 510 * MIN })]), { kind: 'reuse', orderId: 'o_same' }, 'clean orders beside it change nothing')
  assert.deepEqual(plan(owner, [noPage]), { kind: 'reuse', orderId: 'o_recent' }, 'no page anywhere and a recent order: the same purchase, as today')
})

// ====================================================================================================================================================================
// 6c. P2 - what connecting the planner to the checkout needed: an order that was just made, the repeat gate switched off, and "a page of an order only to who proves the order"
// ====================================================================================================================================================================
const JOIN = 90_000
const withJoin = { windows: { ...WINDOWS, reservingMs: JOIN } }
type ArbitratePage = (input: Parameters<typeof arbitrateReservation>[0]) => ReservationVerdict
const arbitratePage = (input: Parameters<typeof arbitrateReservation>[0]): ReservationVerdict => {
  const fn = (planner as unknown as { arbitratePage?: ArbitratePage }).arbitratePage
  assert.equal(typeof fn, 'function', 'CAUSE: the planner has no rule yet for "may THIS request be handed a page of THIS order"')
  return (fn as ArbitratePage)(input)
}

test('[P2-fresh] AN ORDER THAT WAS JUST MADE HOLDS THE CART WHILE ITS PAGE IS BEING OPENED: unpaid, no attempt at all, made less than the join window ago - and only when the decision is "make an order"', () => {
  const owner = sessionOnly()
  const fresh = (over: Partial<SiblingOrder> = {}) => order({ id: 'o_fresh', orderNumber: 7, attempts: [], createdAt: NOW - 20_000, ...over })
  // at another total: the request that made it is between "the order is committed" and "its page is reserved" - a second order would be made beside it
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000 })], withJoin), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_fresh', 'session', { orderNumber: 7 })] },
    'CAUSE: an order with no attempt yet "holds no page", so a second request of the same owner and cart (another total, or a proof by lineage) made its own order in the moment between the first order and its reservation')
  // known by lineage, at the same total: held, not given, not named
  const rotated = withCookie(HASH_B, { id: 'o_prev', hash: HASH_A })
  const viaLineage = plan(rotated, [fresh()], withJoin)
  assert.deepEqual(viaLineage, { kind: 'hold', cause: 'sibling_page', holders: [holder('o_fresh', 'lineage', { orderNumber: 7 })] })
  assert.deepEqual(publicResponseFor(viaLineage, rotated), UNIFORM_HOLD)
  // at the same total and proved: it is the order to continue, as today
  assert.deepEqual(plan(owner, [fresh()], withJoin), { kind: 'reuse', orderId: 'o_fresh' })
  // the window is "strictly less than"; from then on an order without a single attempt has no page (the reservation row is written before the provider is called) and is what it was before
  assert.equal(plan(owner, [fresh({ totalCents: 7000, createdAt: NOW - (JOIN - 1) })], withJoin).kind, 'hold')
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000, createdAt: NOW - JOIN })], withJoin), { kind: 'create', repeatOf: [] })
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000, createdAt: NOW - (JOIN + 1) })], withJoin), { kind: 'create', repeatOf: [] })
  // a clock that is off (an order "from the future") holds: time is only ever a reason to hold
  assert.equal(plan(owner, [fresh({ totalCents: 7000, createdAt: NOW + 30_000 })], withJoin).kind, 'hold')
  // an unknown time is not "just made"
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000, createdAt: null })], withJoin), { kind: 'create', repeatOf: [] })
  // only an order with NO attempt at all: one whose page is provably closed is not being opened by anybody
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000, attempts: [closedProved()] })], withJoin), { kind: 'create', repeatOf: [] })
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000, attempts: [attempt('failed', { stripeSessionId: null, failureReason: 'local_refusal:x' })] })], withJoin), { kind: 'create', repeatOf: [] })
  // only an UNPAID order
  assert.deepEqual(plan(owner, [cancelledOrder('o_fresh', { totalCents: 7000, attempts: [], createdAt: NOW - 20_000 })], withJoin), { kind: 'create', repeatOf: [] })
  assert.deepEqual(plan(owner, [paidOrder('o_fresh', { totalCents: 7000, attempts: [], createdAt: NOW - 20_000, paidAt: NOW - 500 * MIN })], withJoin), { kind: 'create', repeatOf: [] })
  // off at a window of 0
  assert.deepEqual(plan(owner, [fresh({ totalCents: 7000 })]), { kind: 'create', repeatOf: [] })
  // two of them, or one beside a page: a hold, never a choice (C)
  const second = order({ id: 'o_fresh2', orderNumber: 8, attempts: [], createdAt: NOW - 10_000 })
  assert.deepEqual(plan(owner, [fresh(), second], withJoin), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_fresh2', 'session', { orderNumber: 8 }), holder('o_fresh', 'session', { orderNumber: 7 })] })
  assert.equal(plan(owner, [fresh(), order({ id: 'o_page', totalCents: 7000, attempts: [livePage()], createdAt: NOW - 5 * MIN })], withJoin).kind, 'hold')
  // a list that was cut still gives nothing
  assert.deepEqual(plan(owner, [fresh()], { ...withJoin, listIsComplete: false }), { kind: 'hold', cause: 'incomplete', holders: [] })
  // THE ARBITER DOES NOT USE IT: two orders that were just made do not hold each other at the reservation - the lock and the first reservation decide there
  assert.deepEqual(arbitrateReservation({ owner, order: order({ id: 'o_new' }), orders: [fresh({ totalCents: 7000 })], listIsComplete: true }), { kind: 'proceed' })
  // the window is a number that decides: it is checked like the others
  for (const reservingMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.throws(() => plan(owner, [], { windows: { ...WINDOWS, reservingMs } }), TypeError)
})

test('[P2-fresh] invariants over generated worlds: with the rule on, nothing is made or continued beside an order that was just made; with no such order the rule changes nothing', () => {
  const next = rng(909)
  let fresh = 0
  let changed = 0
  for (let round = 0; round < 20_000; round += 1) {
    const { evidence, orders, total, confirmRepeat, complete } = randomWorld(next)
    // (half of the worlds get an order that was made 18 seconds ago and has no attempt yet - this owner's, another session's of the same browser, an account's or a stranger's)
    if (next() < 0.5) orders.push(build('o_justmade', (['own_a', 'own_b', 'account', 'stranger'] as const)[Math.floor(next() * 4)], 'unpaid', 'none', next() < 0.5 ? 5000 : 6000, 0.3, 950))
    const on = planOwnerIntent({ owner: evidence, requestTotalCents: total, confirmRepeat, now: NOW, windows: { ...WINDOWS, reservingMs: JOIN }, orders, listIsComplete: complete })
    const off = decide(evidence, orders, total, confirmRepeat, complete)
    const siblings = classifySiblings({ owner: evidence, scope: scopeOf(evidence), orders })
    const justMade = siblings.filter((s) => s.kind === 'unpaid' && (orders.find((o) => o.id === s.orderId) as SiblingOrder).attempts.length === 0 && s.createdAtMs > NOW - JOIN)
    const ctx = JSON.stringify({ evidence, total, complete, orders: orders.map((o) => o.id) })
    if (justMade.length === 0) { assert.deepEqual(on, off, `the rule changed a world with no order that was just made: ${ctx}`); continue }
    fresh += 1
    if (JSON.stringify(on) !== JSON.stringify(off)) changed += 1
    assert.notEqual(on.kind, 'create', `an order was made beside one that was just made: ${ctx}`)
    assert.notEqual(on.kind, 'confirm', ctx)
    if (on.kind === 'reuse') {
      assert.deepEqual(justMade.map((s) => s.orderId), [on.orderId], `an order was continued beside another that was just made: ${ctx}`)
      assert.equal(proofAllowsReuse(siblings.find((s) => s.orderId === on.orderId)?.proof ?? null), true, ctx)
    }
    // the rule only ever turns an answer into a hold (or leaves it): it never gives what was not given without it
    if (on.kind !== 'hold') assert.deepEqual(on, off, `the rule gave something that was not given without it: ${ctx}`)
  }
  assert.ok(fresh > 3_000 && changed > 1_000, `${fresh} worlds had an order that was just made, ${changed} decisions changed`)
})

test('[P2-gate-off] THE REPEAT GATE IS OFF AT A WINDOW OF 0 (P3 switches it on): no confirmation is ever asked, whatever the proof and whatever the clocks say, and nothing is remembered as repeated', () => {
  const off = { windows: { ...WINDOWS, repeatMs: 0 } }
  const cookie = withCookie(HASH_A, { id: 'o_1', hash: HASH_A })
  for (const paidAt of [NOW - 10 * MIN, NOW, NOW + 5 * MIN, NOW + 400 * MIN]) {
    assert.deepEqual(plan(cookie, [paidOrder('o_1', { paidAt })], off), { kind: 'create', repeatOf: [] },
      `paid at ${(paidAt - NOW) / MIN} min - CAUSE: a window of 0 was still a comparison with the clock, so a payment "from the future" (a clock that is off) asked a confirmation`)
    assert.deepEqual(plan(cookie, [paidOrder('o_1', { paidAt })], { ...off, confirmRepeat: true }), { kind: 'create', repeatOf: [] })
    assert.deepEqual(plan(accountEvidence(), [paidOrder('o_1', { userId: ACCOUNT, guestSessionHash: null, paidAt })], off), { kind: 'create', repeatOf: [] })
  }
  // CONTROL: with a window the gate is what it was
  assert.equal(plan(cookie, [paidOrder('o_1')]).kind, 'confirm')
  // a hold is still a hold with the gate off
  assert.equal(plan(cookie, [paidOrder('o_1', { attempts: [carrierPage(), livePage()] })], off).kind, 'hold')
})

test('[P2-page] A PAGE OF AN ORDER - a new one, or the one it has - IS GIVEN ONLY TO A REQUEST THAT PROVES THE ORDER, and only if no other order of the cart may be paid or is in doubt', () => {
  const mine = order({ id: 'o_mine', guestSessionHash: HASH_A, attempts: [livePage()] })
  const give = (owner: OwnerEvidence | null, orders: SiblingOrder[] = [], complete = true, target: SiblingOrder = mine) => arbitratePage({ owner, order: target, orders: [target, ...orders], listIsComplete: complete })
  // proved by its own session, by its access cookie, by the account - and nothing else holds: the page may be given (the order's own page is never its sibling)
  assert.deepEqual(give(sessionOnly(HASH_A)), { kind: 'proceed' })
  assert.deepEqual(give(withCookie(HASH_B, { id: 'o_mine', hash: HASH_A })), { kind: 'proceed' })
  const accountOrder = order({ id: 'o_acc', userId: ACCOUNT, guestSessionHash: null, attempts: [livePage()] })
  assert.deepEqual(give(accountEvidence(), [], true, accountOrder), { kind: 'proceed' })
  // known by LINEAGE, or not proved at all: nothing of the order is given - no page, no identifier
  const unproved: ReservationVerdict = { kind: 'hold', cause: 'unproved' as never, holders: [] }
  const lineageOwner = withCookie(HASH_B, { id: 'o_prev', hash: HASH_A })
  assert.equal(proofOf(mine, lineageOwner), 'lineage')
  assert.deepEqual(give(lineageOwner), unproved)
  assert.deepEqual(publicResponseFor(give(lineageOwner), lineageOwner), UNIFORM_HOLD)
  assert.deepEqual(give(sessionOnly(HASH_C)), unproved)
  assert.deepEqual(give(accountEvidence('user_account_2'), [], true, accountOrder), unproved)
  assert.deepEqual(give(sessionOnly(HASH_A), [], true, accountOrder), unproved, 'an account order is not a guest\'s')
  assert.deepEqual(give({ kind: 'guest', sessionHash: null, verifiedOrders: [] }), unproved)
  // a call with no request at all hands nothing to anybody: the columns of the order decide, as before
  assert.deepEqual(give(null), { kind: 'proceed' })
  assert.equal(give(null, [order({ id: 'o_sib', guestSessionHash: HASH_A, attempts: [livePage()] })]).kind, 'hold')
  // another order of the cart may be paid, or is in doubt: held even for the owner; the list was cut: held
  const sibling = order({ id: 'o_sib', orderNumber: 2, guestSessionHash: HASH_A, totalCents: 7000, attempts: [livePage()] })
  assert.deepEqual(give(sessionOnly(HASH_A), [sibling]), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_sib', 'session', { orderNumber: 2 })] })
  assert.equal((give(sessionOnly(HASH_A), [cancelledOrder('o_sib', { attempts: [closedUnproved()] })]) as { cause: string }).cause, 'sibling_page', 'a terminal order whose page is not provably closed')
  assert.equal((give(sessionOnly(HASH_A), [paidOrder('o_sib', { attempts: [carrierPage(), livePage()] })]) as { cause: string }).cause, 'sibling_page', 'a paid order with a hidden page')
  assert.equal((give(sessionOnly(HASH_A), [order({ id: 'o_sib', paymentStatus: 'processing' })]) as { cause: string }).cause, 'in_doubt')
  assert.deepEqual(give(sessionOnly(HASH_A), [], false), { kind: 'hold', cause: 'incomplete', holders: [] })
  assert.deepEqual(give(sessionOnly(HASH_A), [cancelledOrder('o_sib', { attempts: [closedProved()] }), paidOrder('o_paid')]), { kind: 'proceed' }, 'clean orders beside it change nothing')
  // whenever the request proves the order, the answer is the arbiter's own - nothing else was added
  const next = rng(31)
  let compared = 0
  for (let round = 0; round < 6_000; round += 1) {
    const { evidence, orders, complete } = randomWorld(next)
    const target = order({ id: 'o_target', ...(evidence.kind === 'account' ? { userId: ACCOUNT, guestSessionHash: null } : { guestSessionHash: next() < 0.5 ? HASH_A : HASH_B }) })
    const input = { owner: evidence, order: target, orders: [target, ...orders], listIsComplete: complete }
    if (proofAllowsReuse(proofOf(target, evidence))) { assert.deepEqual(arbitratePage(input), arbitrateReservation(input)); compared += 1 } else assert.deepEqual(arbitratePage(input), unproved)
  }
  assert.ok(compared > 2_000)
})

// ====================================================================================================================================================================
// 7. the arbiter (S3)
// ====================================================================================================================================================================
test('arbitrateReservation: an order may be reserved only if no OTHER order of the scope - in any state - holds a page or is in doubt', () => {
  const reserved = order({ id: 'o_new', guestSessionHash: HASH_A, attempts: [] })
  const arbitrate = (orders: SiblingOrder[], owner: OwnerEvidence | null = sessionOnly(HASH_A), over: { listIsComplete?: boolean; order?: SiblingOrder } = {}) =>
    arbitrateReservation({ owner, order: over.order ?? reserved, orders: [over.order ?? reserved, ...orders], listIsComplete: over.listIsComplete ?? true })
  assert.deepEqual(arbitrate([]), { kind: 'proceed' }, 'alone')
  assert.deepEqual(arbitrate([order({ id: 'o_1', attempts: [livePage()] })]), { kind: 'hold', cause: 'sibling_page', holders: [holder('o_1', 'session')] })
  assert.equal(arbitrate([cancelledOrder('o_1', { attempts: [closedUnproved()] })]).kind, 'hold', 'a cancelled order\'s page that is not provably closed')
  assert.equal(arbitrate([paidOrder('o_1', { attempts: [carrierPage(), livePage()] })]).kind, 'hold', 'a paid order\'s hidden page')
  assert.equal(arbitrate([order({ id: 'o_1', paymentStatus: 'processing' })]).kind, 'hold', 'a payment in doubt')
  assert.equal((arbitrate([order({ id: 'o_1', paymentStatus: 'processing' })]) as { cause: string }).cause, 'in_doubt')
  assert.deepEqual(arbitrate([cancelledOrder('o_1', { attempts: [closedProved()] }), paidOrder('o_2'), order({ id: 'o_3', attempts: [closedProved()] })]), { kind: 'proceed' }, 'all clean')
  assert.deepEqual(arbitrate([]), arbitrate([], null), 'the order\'s own columns are enough to find the same browser\'s orders')
  assert.equal(arbitrate([order({ id: 'o_1', attempts: [livePage()] })], null).kind, 'hold', 'no request at all: the columns still see the sibling of the same hash')
  assert.deepEqual(arbitrate([order({ id: 's_1', guestSessionHash: HASH_C, attempts: [livePage()] })]), { kind: 'proceed' }, 'another guest\'s page is not a sibling')
  assert.deepEqual(arbitrate([order({ id: 'o_1', attempts: [livePage()] })], sessionOnly(HASH_A), { listIsComplete: false }).kind, 'hold')
  assert.deepEqual(arbitrate([], sessionOnly(HASH_A), { listIsComplete: false }), { kind: 'hold', cause: 'incomplete', holders: [] }, 'a list that was cut never lets a reservation through')
  assert.deepEqual(arbitrateReservation({ owner: sessionOnly(HASH_A), order: reserved, orders: [{ ...reserved, attempts: [livePage()] }], listIsComplete: true }), { kind: 'proceed' }, 'the order itself is never its own sibling')
})

test('arbitrateReservation never reasons from less than the order\'s columns: the request that proves less still sees the siblings of the order\'s own hash', () => {
  const reserved = order({ id: 'o_new', guestSessionHash: HASH_B })
  const sibling = order({ id: 'o_1', guestSessionHash: HASH_B, attempts: [livePage()] })
  for (const owner of [null, sessionOnly(HASH_A), sessionOnly(HASH_C), withCookie(HASH_C, { id: 'o_x', hash: HASH_C })]) {
    assert.equal(arbitrateReservation({ owner, order: reserved, orders: [sibling], listIsComplete: true }).kind, 'hold', JSON.stringify(owner))
  }
  const accountReserved = order({ id: 'o_acc_new', userId: ACCOUNT, guestSessionHash: null })
  assert.equal(arbitrateReservation({ owner: null, order: accountReserved, orders: [order({ id: 'o_acc', userId: ACCOUNT, guestSessionHash: null, attempts: [livePage()] })], listIsComplete: true }).kind, 'hold')
  const hashless = order({ id: 'o_hashless', guestSessionHash: null })
  assert.equal(arbitrateReservation({ owner: null, order: hashless, orders: [order({ id: 'o_other', guestSessionHash: null, attempts: [livePage()] })], listIsComplete: true }).kind, 'proceed', 'a hashless order is nobody\'s by "two empty values are equal"')
})

test('E1: the request with the broader proofs (new session + the old order\'s cookie) is held by the earlier request\'s order; it sees it through the old session\'s hash', () => {
  const earlier = order({ id: 'o_a', guestSessionHash: HASH_A, attempts: [livePage()] })
  const reserved = order({ id: 'o_b', guestSessionHash: HASH_B })
  const broader = withCookie(HASH_B, { id: 'o_prev', hash: HASH_A })
  assert.equal(arbitrateReservation({ owner: broader, order: reserved, orders: [earlier], listIsComplete: true }).kind, 'hold')
  assert.equal(proofOf(earlier, broader), 'lineage')
})

test('E2 - THE LIMIT, NOT CLOSED HERE: the request that proved MORE makes an order the request that proves LESS can not see; persisting the link (P2b, a migration) is the only way to close it', () => {
  const broader = withCookie(HASH_B, { id: 'o_prev', hash: HASH_A })        // the new session + the cookie of an order of the old session
  const narrower = sessionOnly(HASH_A)                                      // the old session alone
  const madeByBroader = order({ id: 'o_b', guestSessionHash: HASH_B, attempts: [livePage()], totalCents: 5000 })
  const madeByNarrower = order({ id: 'o_a', guestSessionHash: HASH_A, attempts: [livePage()], totalCents: 5000 })
  // they take turns - the old session's lock is common to both...
  const shared = ownerLockNames(scopeOf(broader), CART).filter((name) => ownerLockNames(scopeOf(narrower), CART).includes(name))
  assert.deepEqual(shared, [`checkout:owner:h:${HASH_A}:${CART}`])
  // ...and the broader sees what the narrower made...
  assert.equal(orderInScope(madeByNarrower, scopeOf(broader)), true)
  assert.equal(plan(broader, [madeByNarrower], { requestTotalCents: 6000 }).kind, 'hold')
  // ...but the narrower can NOT see what the broader made: nothing it proves links that order to it. THIS IS THE LIMIT.
  assert.equal(orderInScope(madeByBroader, scopeOf(narrower)), false)
  assert.deepEqual(plan(narrower, [madeByBroader], { requestTotalCents: 6000 }), { kind: 'create', repeatOf: [] }, 'E2: a second payable page is possible here, and the pure rules can not prevent it')
  assert.equal(arbitrateReservation({ owner: narrower, order: order({ id: 'o_c', guestSessionHash: HASH_A }), orders: [madeByBroader], listIsComplete: true }).kind, 'proceed', 'nor can the arbiter')
  // the asymmetry is exactly the proofs: give the narrower request the cookie and the limit is gone for that request
  assert.equal(plan(withCookie(HASH_A, { id: 'o_prev', hash: HASH_A }), [madeByBroader], { requestTotalCents: 6000 }).kind, 'create', 'even with the cookie of the OLD order: nothing it proves names the new hash or the new order')
  // what closes it for one request is to prove the new order itself (its own cookie, or its hash) - which is exactly what a stored link between the two sessions would give every request
  assert.equal(plan(withCookie(HASH_A, { id: 'o_b', hash: HASH_B }), [madeByBroader], { requestTotalCents: 6000 }).kind, 'hold')
  assert.equal(plan(withCookie(HASH_A, { id: 'o_prev', hash: HASH_B }), [madeByBroader], { requestTotalCents: 6000 }).kind, 'hold')
})

// ====================================================================================================================================================================
// 8. what the request is told
// ====================================================================================================================================================================
const UNIFORM_HOLD = { status: 409, code: 'PAYMENT_IN_PROGRESS', message: HOLD_MESSAGE, extra: {} }

test('the session alone is told ONE thing, whatever holds the cart and in whatever state: the same status, code, sentence and body - and no order is named', () => {
  const owner = sessionOnly(HASH_A)
  const worlds: Array<[string, SiblingOrder[]]> = [
    ['an unpaid order with a live page (D1)', [order({ id: 'secret_id_unpaid', orderNumber: 424241, attempts: [livePage()] })]],
    ['a cancelled order with a page not provably closed (A)', [cancelledOrder('secret_id_cancelled', { orderNumber: 424242, attempts: [closedUnproved()] })]],
    ['a paid order with a hidden page (B)', [paidOrder('secret_id_paid', { orderNumber: 424243, attempts: [carrierPage(), livePage()] })]],
    ['a payment in doubt', [order({ id: 'secret_id_doubt', orderNumber: 424244, paymentStatus: 'processing' })]],
    ['a review', [order({ id: 'secret_id_review', orderNumber: 424245, status: 'awaiting_review', paymentStatus: 'paid', paymentReviewReason: 'dispute' })]],
    ['several at once', [order({ id: 'secret_id_x', orderNumber: 424246, attempts: [livePage()] }), cancelledOrder('secret_id_y', { orderNumber: 424247, attempts: [closedUnproved()] }), order({ id: 'secret_id_z', orderNumber: 424248, paymentStatus: 'processing' })]],
    ['an orphan reservation of any age', [order({ id: 'secret_id_orphan', orderNumber: 424249, createdAt: NOW - 90 * 24 * 60 * MIN, attempts: [attempt('creating')] })]],
  ]
  for (const [name, orders] of worlds) {
    const decision = plan(owner, orders, { requestTotalCents: 6000 })
    assert.equal(decision.kind, 'hold', name)
    const response = publicResponseFor(decision, owner)
    assert.deepEqual(response, UNIFORM_HOLD, name)
    const text = JSON.stringify(response)
    assert.equal(/secret_id|4242\d\d/.test(text), false, `${name}: an identifier left the server`)
    // the arbiter's answer is the same
    const reservation = arbitrateReservation({ owner, order: order({ id: 'o_new' }), orders, listIsComplete: true })
    assert.deepEqual(publicResponseFor(reservation, owner), UNIFORM_HOLD, `${name} (reservation)`)
  }
  assert.deepEqual(publicResponseFor({ kind: 'hold', cause: 'incomplete', holders: [] }, owner), UNIFORM_HOLD, 'an incomplete list is told the same')
  // lineage is a session's strength: nothing is named to it either
  const lineageOwner = withCookie(HASH_B, { id: 'o_prev', hash: HASH_A })
  assert.deepEqual(publicResponseFor(plan(lineageOwner, [order({ id: 'secret_id_lin', attempts: [livePage()] })], { requestTotalCents: 6000 }), lineageOwner), UNIFORM_HOLD)
})

test('the cookie or the account is told which order holds the cart - the newest it proves - and nothing more than that', () => {
  const owner = withCookie(HASH_A, { id: 'o_old', hash: HASH_A }, { id: 'o_mid', hash: HASH_A })
  const orders = [
    order({ id: 'o_new_weak', orderNumber: 31, attempts: [livePage()], createdAt: NOW - MIN }),                       // found by the session only
    order({ id: 'o_mid', orderNumber: 32, attempts: [livePage()], createdAt: NOW - 2 * MIN }),                          // the cookie opens it
    order({ id: 'o_old', orderNumber: 33, attempts: [livePage()], createdAt: NOW - 3 * MIN }),
  ]
  const decision = plan(owner, orders, { requestTotalCents: 6000 })
  assert.deepEqual(publicResponseFor(decision, owner), { status: 409, code: 'PAYMENT_IN_PROGRESS', message: HOLD_MESSAGE, extra: { orderId: 'o_mid', orderNumber: 32 } })
  const account = accountEvidence()
  const accountDecision = plan(account, [order({ id: 'o_acc', userId: ACCOUNT, guestSessionHash: null, orderNumber: 77, paymentStatus: 'processing' })])
  assert.deepEqual(publicResponseFor(accountDecision, account), { status: 409, code: 'PAYMENT_IN_PROGRESS', message: HOLD_MESSAGE, extra: { orderId: 'o_acc', orderNumber: 77 } })
  // the reason is not in the answer, only that the cart is held
  assert.deepEqual(Object.keys(publicResponseFor(accountDecision, account) as object).sort(), ['code', 'extra', 'message', 'status'])
})

test('the confirmation of a repeat purchase is given only for an order the request proves with the cookie or the account; a weaker proof THROWS', () => {
  const cookie = withCookie(HASH_A, { id: 'o_1', hash: HASH_A })
  const decision = plan(cookie, [paidOrder('o_1', { orderNumber: 55 })])
  assert.deepEqual(publicResponseFor(decision, cookie), { status: 409, code: REPEAT_CONFIRMATION_CODE, message: REPEAT_CONFIRMATION_MESSAGE, extra: { orderId: 'o_1', orderNumber: 55 } })
  const account = accountEvidence()
  assert.deepEqual(publicResponseFor(plan(account, [paidOrder('o_1', { userId: ACCOUNT, guestSessionHash: null, orderNumber: 56 })]), account)?.extra, { orderId: 'o_1', orderNumber: 56 })
  for (const proof of ['session', 'lineage', null] as const) {
    assert.throws(() => publicResponseFor({ kind: 'confirm', orderId: 'o_1', orderNumber: 1, proof: proof as never }, cookie), TypeError, String(proof))
  }
  // the planner itself never produces one for the session alone
  assert.notEqual(plan(sessionOnly(), [paidOrder('o_1')]).kind, 'confirm')
  // and the two answers are different things, so that the client can tell a hold from a question
  assert.notEqual(HOLD_CODE, REPEAT_CONFIRMATION_CODE)
})

test('nothing to say: a decision that goes on has no answer; a request that proves nothing gets R1-1b\'s one refusal and nothing is named', () => {
  const owner = sessionOnly()
  const goOn: Array<OwnerIntentDecision | ReservationVerdict> = [{ kind: 'reuse', orderId: 'o_1' }, { kind: 'create', repeatOf: [] }, { kind: 'proceed' }]
  for (const decision of goOn) assert.equal(publicResponseFor(decision, owner), null)
  const refusal = purchaseRefusal()
  const hold: OwnerIntentDecision = { kind: 'hold', cause: 'sibling_page', holders: [holder('secret_id', 'account')] }
  const nobody: Array<OwnerEvidence | null> = [null, { kind: 'guest', sessionHash: null, verifiedOrders: [] }]
  for (const evidence of nobody) {
    assert.deepEqual(publicResponseFor(hold, evidence), { status: 409, code: PURCHASE_REFUSAL_CODE, message: refusal.message, extra: { retry: false } })
    assert.deepEqual(publicResponseFor(hold, evidence, { supportCode: 'ABCDE-12345' }), { status: 409, code: PURCHASE_REFUSAL_CODE, message: refusal.message, extra: { supportCode: 'ABCDE-12345', retry: false } })
  }
  assert.equal(JSON.stringify(publicResponseFor(hold, null)).includes('secret_id'), false)
})

// ====================================================================================================================================================================
// 9. invariants over thousands of generated worlds
// ====================================================================================================================================================================
type Who = 'own_a' | 'own_b' | 'cookie' | 'hashless_cookie' | 'account' | 'stranger'
type State = 'unpaid' | 'paid_recent' | 'paid_old' | 'cancelled' | 'processing' | 'review' | 'refunded'
type Pages = 'none' | 'live' | 'proved' | 'unproved' | 'processing' | 'mismatch' | 'creating' | 'paid_other'
const WHOS: Who[] = ['own_a', 'own_b', 'cookie', 'hashless_cookie', 'account', 'stranger']
const STATES: State[] = ['unpaid', 'paid_recent', 'paid_old', 'cancelled', 'processing', 'review', 'refunded']
const PAGES: Pages[] = ['none', 'live', 'proved', 'unproved', 'processing', 'mismatch', 'creating', 'paid_other']
const EVIDENCES: Array<[string, OwnerEvidence]> = [
  ['session', sessionOnly(HASH_A)],
  ['cookie', withCookie(HASH_A, { id: 'o_cookie', hash: HASH_A })],
  ['rotated', withCookie(HASH_B, { id: 'o_cookie', hash: HASH_A })],
  ['hashless', withCookie(HASH_A, { id: 'o_hashless', hash: null })],
  ['account', accountEvidence()],
]
function build(id: string, who: Who, state: State, pages: Pages, total: number, ageMin: number, number_: number): SiblingOrder {
  const columns: Partial<SiblingOrder> =
    who === 'own_a' ? { guestSessionHash: HASH_A } : who === 'own_b' ? { guestSessionHash: HASH_B } : who === 'cookie' ? { guestSessionHash: HASH_A } : who === 'hashless_cookie' ? { guestSessionHash: null }
      : who === 'account' ? { userId: ACCOUNT, guestSessionHash: null } : { guestSessionHash: HASH_C }
  const base: Partial<SiblingOrder> = { orderNumber: number_, totalCents: total, createdAt: NOW - ageMin * MIN, ...columns }
  const stateFacts: Partial<SiblingOrder> =
    state === 'unpaid' ? {}
      : state === 'cancelled' ? { status: 'cancelled', paymentStatus: 'canceled' }
        : state === 'processing' ? { paymentStatus: 'processing' }
          : state === 'review' ? { status: 'awaiting_review', paymentStatus: 'paid', paidAt: NOW - 5 * MIN, stripePaymentIntentId: 'pi_1' }
            : { status: 'queued', paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt: NOW - (state === 'paid_old' ? 300 : 10) * MIN, refundedCents: state === 'refunded' ? 100 : 0 }
  const extra: Attempt[] = pages === 'none' ? [] : pages === 'live' ? [livePage()] : pages === 'proved' ? [closedProved()] : pages === 'unproved' ? [closedUnproved()] : pages === 'processing' ? [attempt('processing')]
    : pages === 'mismatch' ? [attempt('mismatch')] : pages === 'creating' ? [attempt('creating')] : [carrierPage('pi_other')]
  const carrier = ['paid_recent', 'paid_old', 'refunded'].includes(state) ? [carrierPage('pi_1')] : []
  return order({ id, ...base, ...stateFacts, attempts: [...carrier, ...extra] })
}
function randomWorld(next: () => number) {
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]
  const count = Math.floor(next() * 5)
  const orders: SiblingOrder[] = []
  const used = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    const who = pick(WHOS)
    const id = who === 'cookie' ? 'o_cookie' : who === 'hashless_cookie' ? 'o_hashless' : `w_${index}`
    if (used.has(id)) continue
    used.add(id)
    orders.push(build(id, who, pick(STATES), pick(PAGES), pick([5000, 6000]), pick([1, 30, 59, 61, 600]), 100 + index))
  }
  return { evidence: pick(EVIDENCES)[1], orders, total: pick([5000, 6000]), confirmRepeat: next() < 0.3, complete: next() < 0.9 }
}
const decide = (evidence: OwnerEvidence, orders: SiblingOrder[], total: number, confirmRepeat = false, complete = true) => plan(evidence, orders, { requestTotalCents: total, confirmRepeat, listIsComplete: complete })

test('INVARIANTS over 60,000 generated worlds: I-X at the decision, the reuse and the repeat gate, determinism, isolation, and the privacy of the session alone', (t) => {
  const next = rng(2026)
  const seen: Record<string, number> = {}
  const counts = (key: string) => { seen[key] = (seen[key] ?? 0) + 1 }
  for (let round = 0; round < 60_000; round += 1) {
    const { evidence, orders, total, confirmRepeat, complete } = randomWorld(next)
    const scope = scopeOf(evidence)
    const siblings = classifySiblings({ owner: evidence, scope, orders })
    const decision = decide(evidence, orders, total, confirmRepeat, complete)
    const ctx = JSON.stringify({ evidence, total, confirmRepeat, complete, orders: orders.map((o) => o.id) })
    counts(decision.kind)
    const anyDoubt = siblings.some((s) => s.kind === 'in_doubt')
    const anyHolds = siblings.some((s) => s.holdsPage)

    // I-X: a new order is made only when nothing of the scope is in doubt or holds a page, and the list is whole
    if (decision.kind === 'create') {
      assert.equal(anyDoubt || anyHolds, false, `create over a holder: ${ctx}`)
      assert.equal(complete, true, `create over an incomplete list: ${ctx}`)
    }
    // (the audit of P1: "the order to continue" is unpaid, at the requested total and proved well enough - never by lineage)
    const toContinue = (s: (typeof siblings)[number]) => s.kind === 'unpaid' && s.totalCents === total && (s.proof === 'session' || s.proof === 'access' || s.proof === 'account')
    const holders = siblings.filter((s) => s.holdsPage)
    if (decision.kind === 'hold') {
      counts(`hold:${decision.cause}`)
      if (decision.cause === 'in_doubt') { assert.ok(anyDoubt, ctx); assert.ok(decision.holders.length > 0 && decision.holders.every((h) => h.inDoubt)) }
      if (decision.cause === 'sibling_page') {
        assert.ok(!anyDoubt && anyHolds, ctx)
        assert.deepEqual(decision.holders.map((h) => h.orderId).sort(), holders.map((s) => s.orderId).sort(), ctx)
        // C: more than one order may be paid, or the one that may is not the order to continue
        assert.ok(holders.length > 1 || !toContinue(holders[0]), `a hold where the only page is the order to continue: ${ctx}`)
        if (holders.length > 1) counts('hold:several_pages')
        if (holders.length > 1 && holders.some(toContinue)) counts('hold:several_pages_one_at_the_total')
        if (holders.length === 1 && holders[0].proof === 'lineage' && holders[0].kind === 'unpaid' && holders[0].totalCents === total) counts('hold:lineage_page_at_the_total')
      }
      if (decision.cause === 'incomplete') {
        // B: only when nothing that was read holds for its own reason - and then nothing is given, whatever was read
        assert.equal(complete, false); assert.deepEqual(decision.holders, []); assert.ok(!anyDoubt, ctx)
        assert.ok(holders.length === 0 || (holders.length === 1 && toContinue(holders[0])), ctx)
        if (holders.length === 1) counts('hold:incomplete_over_an_order_to_continue')
      }
      for (const h of decision.holders) assert.ok(siblings.some((s) => s.orderId === h.orderId), 'a holder outside the scope')
    }
    if (decision.kind === 'reuse') {
      const target = siblings.find((s) => s.orderId === decision.orderId)
      assert.ok(target && toContinue(target) && (target.createdAtMs > NOW - WINDOWS.duplicateMs || target.holdsPage), `reuse of what is not the order to continue: ${ctx}`)
      assert.equal(anyDoubt, false, ctx)
      assert.equal(proofAllowsReuse(target.proof), true, `A: an order was handed back to a proof that is not enough (${target.proof}): ${ctx}`)
      assert.equal(complete, true, `B: an order was continued from a list that was cut: ${ctx}`)
      assert.equal(siblings.some((s) => s.orderId !== target.orderId && s.holdsPage), false, `C: an order was continued while another order may be paid: ${ctx}`)
      // with no page of its own it is the newest order to continue inside the window
      if (!target.holdsPage) assert.equal(siblings.find((s) => toContinue(s) && s.createdAtMs > NOW - WINDOWS.duplicateMs)?.orderId, target.orderId, ctx)
      counts(target.holdsPage ? 'reuse:the_one_page' : 'reuse:recent_no_page')
    }
    if (decision.kind === 'confirm') {
      const target = siblings.find((s) => s.orderId === decision.orderId)
      assert.ok(target && target.kind === 'paid' && !target.cancelled && !target.refunded && target.paidAtMs > NOW - WINDOWS.repeatMs, ctx)
      assert.ok(target.proof === 'access' || target.proof === 'account', `a confirmation for a proof that is not strong: ${ctx}`)
      assert.equal(confirmRepeat, false, ctx)
      assert.equal(anyDoubt || anyHolds, false, ctx)
      assert.equal(complete, true, `B: a confirmation was asked from a list that was cut: ${ctx}`)
    }
    // A: an order known by lineage alone is never given - not continued, not confirmed, not remembered as repeated, not named
    for (const s of siblings.filter((entry) => entry.proof === 'lineage')) {
      assert.equal((decision.kind === 'reuse' || decision.kind === 'confirm') && decision.orderId === s.orderId, false, `a lineage order was given: ${ctx}`)
      if (decision.kind === 'create') assert.equal(decision.repeatOf.includes(s.orderId), false, ctx)
      if (decision.kind !== 'hold' && s.kind === 'unpaid' && s.totalCents === total && !s.holdsPage && s.createdAtMs > NOW - WINDOWS.duplicateMs) counts('lineage:recent_order_left_alone')
    }
    if (decision.kind === 'create' && decision.repeatOf.length > 0) {
      assert.equal(confirmRepeat, true)
      for (const id of decision.repeatOf) assert.ok(['access', 'account'].includes(siblings.find((s) => s.orderId === id)?.proof ?? ''), ctx)
    }

    // the session alone: never a confirmation, never a name
    const weakOnly = siblings.every((s) => s.proof === 'session' || s.proof === 'lineage')
    if (weakOnly) {
      assert.notEqual(decision.kind, 'confirm', ctx)
      const response = publicResponseFor(decision, evidence)
      if (response) assert.deepEqual(response.extra, {}, `a weak proof was told something: ${ctx}`)
    }

    // determinism, and independence of the order the rows were read in
    assert.deepEqual(decide(evidence, [...orders].reverse(), total, confirmRepeat, complete), decision, `order of the rows changed the decision: ${ctx}`)
    assert.deepEqual(decide(evidence, orders, total, confirmRepeat, complete), decision)

    // isolation: orders of another guest (or any account's, for a guest) change nothing
    const noise = [build('n_1', 'stranger', 'unpaid', 'live', total, 3, 900), build('n_2', 'stranger', 'processing', 'unproved', total, 3, 901), build('n_3', 'stranger', 'paid_recent', 'live', total, 3, 902)]
    assert.deepEqual(decide(evidence, [...orders, ...noise], total, confirmRepeat, complete), decision, `a stranger's orders changed the decision: ${ctx}`)
    if (evidence.kind === 'guest') assert.deepEqual(decide(evidence, [...orders, build('n_4', 'account', 'unpaid', 'live', total, 3, 903)], total, confirmRepeat, complete), decision)
    if (evidence.kind === 'account') assert.deepEqual(decide(evidence, [...orders, build('n_5', 'own_a', 'unpaid', 'live', total, 3, 904)], total, confirmRepeat, complete), decision)

    // monotone safety: a holder added to the scope can never turn into a new order
    const holderOrder = build('n_6', evidence.kind === 'account' ? 'account' : 'own_a', 'unpaid', 'live', total + 1000, 2, 905)
    const withHolder = decide(evidence, [...orders, holderOrder], total, confirmRepeat, complete)
    assert.equal(withHolder.kind, 'hold', `a page of another order that may be paid, and still ${withHolder.kind}: ${ctx}`)

    // `confirmRepeat` is a gesture, not a key: whatever it changes, a confirmation is on one side of the change
    const flipped = decide(evidence, orders, total, !confirmRepeat, complete)
    if (JSON.stringify(flipped) !== JSON.stringify(decision)) assert.ok(decision.kind === 'confirm' || flipped.kind === 'confirm', `confirmRepeat changed something that is not a confirmation: ${ctx}`)
    if (decision.kind === 'reuse' || decision.kind === 'hold') assert.deepEqual(flipped, decision, `confirmRepeat changed a hold or a reuse: ${ctx}`)

    // a list that was cut: the same world read to the end may give something; cut, it gives nothing (B)
    const cut = decide(evidence, orders, total, confirmRepeat, false)
    assert.equal(cut.kind, 'hold', `a list that was cut gave ${cut.kind}: ${ctx}`)
  }
  // the generator really reached every kind of decision (otherwise the invariants above would be empty)
  t.diagnostic(`decisions over 60,000 worlds: ${JSON.stringify(seen)}`)
  // (recalibrated with the correction of P1: a confirmation and a reuse now need the whole list, so there are fewer of them; the seed is fixed, the counts are the same at every run)
  const atLeast: Record<string, number> = {
    create: 10_000, hold: 10_000, 'hold:in_doubt': 5_000, 'hold:sibling_page': 3_000, 'hold:incomplete': 1_500, reuse: 400, confirm: 100,
    'reuse:the_one_page': 300, 'reuse:recent_no_page': 100, 'hold:several_pages': 500, 'hold:several_pages_one_at_the_total': 100, 'hold:incomplete_over_an_order_to_continue': 40, 'hold:lineage_page_at_the_total': 30,
    'lineage:recent_order_left_alone': 5,
  }
  for (const [key, minimum] of Object.entries(atLeast)) assert.ok((seen[key] ?? 0) >= minimum, `${key}: ${seen[key] ?? 0} (at least ${minimum})`)
})

test('PRIVACY OF THE SESSION ALONE: orders that are paid or terminal and hold no page are INVISIBLE - removing them, or changing which of those states they are in, never changes the decision or the answer', () => {
  const next = rng(99)
  const invisibleForms: Array<(o: SiblingOrder) => SiblingOrder> = [
    (o) => ({ ...o, status: 'queued', paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt: NOW - 10 * MIN, refundedCents: 0, attempts: [carrierPage('pi_1')] }),
    (o) => ({ ...o, status: 'queued', paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt: NOW - 500 * MIN, refundedCents: 0, attempts: [carrierPage('pi_1'), closedProved()] }),
    (o) => ({ ...o, status: 'queued', paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt: NOW - 10 * MIN, refundedCents: 250, attempts: [carrierPage('pi_1')] }),
    (o) => ({ ...o, status: 'cancelled', paymentStatus: 'canceled', stripePaymentIntentId: null, paidAt: null, refundedCents: 0, attempts: [closedProved()] }),
    (o) => ({ ...o, status: 'cancelled', paymentStatus: 'canceled', stripePaymentIntentId: null, paidAt: null, refundedCents: 0, attempts: [] }),
    (o) => ({ ...o, status: 'cancelled', paymentStatus: 'failed', stripePaymentIntentId: null, paidAt: null, refundedCents: 0, attempts: [attempt('failed', { stripeSessionId: null, failureReason: 'local_refusal:x' })] }),
  ]
  let rewritten = 0
  for (let round = 0; round < 6_000; round += 1) {
    const { orders, total, confirmRepeat, complete } = randomWorld(next)
    for (const evidence of [sessionOnly(HASH_A), withCookie(HASH_B, { id: 'o_prev', hash: HASH_A })]) {
      const scope = scopeOf(evidence)
      const siblings = classifySiblings({ owner: evidence, scope, orders })
      const invisible = new Set(siblings.filter((s) => (s.kind === 'paid' || s.kind === 'terminal') && !s.holdsPage && (s.proof === 'session' || s.proof === 'lineage')).map((s) => s.orderId))
      if (invisible.size === 0) continue
      const decision = decide(evidence, orders, total, confirmRepeat, complete)
      assert.deepEqual(decide(evidence, orders.filter((o) => !invisible.has(o.id)), total, confirmRepeat, complete), decision, 'removing invisible orders changed the decision')
      const form = invisibleForms[Math.floor(next() * invisibleForms.length)]
      const changed = orders.map((o) => (invisible.has(o.id) ? form(o) : o))
      assert.deepEqual(decide(evidence, changed, total, confirmRepeat, complete), decision, 'the state of an invisible order changed the decision')
      assert.deepEqual(publicResponseFor(decide(evidence, changed, total, confirmRepeat, complete), evidence), publicResponseFor(decision, evidence))
      rewritten += 1
    }
  }
  assert.ok(rewritten > 1_000, `only ${rewritten} worlds had an invisible order`)
})

test('LINEAGE GIVES NOTHING: an order known only by lineage that holds no page and is not in doubt is INVISIBLE - unpaid, recent and at the requested total included; removing or changing it never changes the decision or the answer', () => {
  const next = rng(4242)
  // every shape an order can have with no page that may be paid and no doubt - the unpaid ones too
  const forms = (total: number): Array<(o: SiblingOrder) => SiblingOrder> => [
    (o) => ({ ...o, status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null, paidAt: null, refundedCents: 0, totalCents: total, createdAt: NOW - 5 * MIN, attempts: [] }),
    (o) => ({ ...o, status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null, paidAt: null, refundedCents: 0, totalCents: total, createdAt: NOW - 45 * MIN, attempts: [closedProved()] }),
    (o) => ({ ...o, status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null, paidAt: null, refundedCents: 0, totalCents: total + 1000, createdAt: NOW - 5 * MIN, attempts: [] }),
    (o) => ({ ...o, status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, stripePaymentIntentId: null, paidAt: null, refundedCents: 0, totalCents: total, createdAt: NOW - 600 * MIN, attempts: [closedProved()] }),
    (o) => ({ ...o, status: 'queued', paymentStatus: 'paid', paymentReviewReason: null, stripePaymentIntentId: 'pi_1', paidAt: NOW - 10 * MIN, refundedCents: 0, attempts: [carrierPage('pi_1')] }),
    (o) => ({ ...o, status: 'cancelled', paymentStatus: 'canceled', paymentReviewReason: null, stripePaymentIntentId: null, paidAt: null, refundedCents: 0, attempts: [closedProved()] }),
  ]
  let rewritten = 0
  let unpaidAtTheTotal = 0
  for (let round = 0; round < 20_000; round += 1) {
    const { orders, total, confirmRepeat, complete } = randomWorld(next)
    // the current session is H2; the cookie opens an order of H1: every other order of H1 is known by lineage
    for (const evidence of [withCookie(HASH_B, { id: 'o_prev', hash: HASH_A }), withCookie(HASH_B, { id: 'o_cookie', hash: HASH_A })]) {
      const siblings = classifySiblings({ owner: evidence, scope: scopeOf(evidence), orders })
      const invisible = new Set(siblings.filter((s) => s.proof === 'lineage' && !s.holdsPage && s.kind !== 'in_doubt').map((s) => s.orderId))
      if (invisible.size === 0) continue
      if (siblings.some((s) => invisible.has(s.orderId) && s.kind === 'unpaid' && s.totalCents === total && s.createdAtMs > NOW - WINDOWS.duplicateMs)) unpaidAtTheTotal += 1
      const decision = decide(evidence, orders, total, confirmRepeat, complete)
      assert.deepEqual(decide(evidence, orders.filter((o) => !invisible.has(o.id)), total, confirmRepeat, complete), decision, 'removing a lineage order changed the decision')
      const pick = forms(total)
      const changed = orders.map((o) => (invisible.has(o.id) ? pick[Math.floor(next() * pick.length)](o) : o))
      const after = decide(evidence, changed, total, confirmRepeat, complete)
      assert.deepEqual(after, decision, 'the state of a lineage order changed the decision')
      assert.deepEqual(publicResponseFor(after, evidence), publicResponseFor(decision, evidence))
      // and nothing of it is in what goes on or in what is said
      for (const id of invisible) assert.equal(JSON.stringify([decision, publicResponseFor(decision, evidence)]).includes(`"${id}"`), false, `${id} is in the decision`)
      rewritten += 1
    }
  }
  assert.ok(rewritten > 1_500 && unpaidAtTheTotal > 100, `${rewritten} worlds had a lineage order without a page, ${unpaidAtTheTotal} of them unpaid, recent and at the requested total`)
})

test('ARBITER INVARIANTS over generated worlds: proceed only when nothing else of the scope holds a page or is in doubt; the order itself is never a holder; more proofs never turn a hold into a proceed', () => {
  const next = rng(5150)
  let proceeded = 0
  let held = 0
  for (let round = 0; round < 15_000; round += 1) {
    const { evidence, orders, complete } = randomWorld(next)
    const reservedColumns = evidence.kind === 'account' ? { userId: ACCOUNT, guestSessionHash: null } : { userId: null, guestSessionHash: next() < 0.5 ? HASH_A : HASH_B }
    const reserved = order({ id: 'o_reserved', ...reservedColumns })
    const all = [{ ...reserved, attempts: [livePage()] }, ...orders]
    const verdict = arbitrateReservation({ owner: evidence, order: reserved, orders: all, listIsComplete: complete })
    const scope = reservationScope(evidence, reserved)
    const others = classifySiblings({ owner: evidence, scope, orders: all, excludeOrderId: reserved.id })
    const ctx = JSON.stringify({ evidence, reservedColumns, complete })
    if (verdict.kind === 'proceed') {
      proceeded += 1
      assert.equal(complete, true, ctx)
      assert.equal(others.some((s) => s.holdsPage || s.kind === 'in_doubt'), false, `proceeded over a holder: ${ctx}`)
    } else {
      held += 1
      assert.equal(verdict.holders.some((h) => h.orderId === 'o_reserved'), false, 'the order is its own holder')
      if (verdict.cause === 'incomplete') { assert.equal(complete, false, ctx); assert.deepEqual(verdict.holders, []); assert.equal(others.some((s) => s.holdsPage || s.kind === 'in_doubt'), false, ctx) } else assert.equal(others.some((s) => s.holdsPage || s.kind === 'in_doubt'), true, ctx)
    }
    // the same verdict with no request at all can only be stricter-or-equal in what it sees from the columns, never looser than the columns say
    const bare = arbitrateReservation({ owner: null, order: reserved, orders: all, listIsComplete: complete })
    const columnsOnly = classifySiblings({ owner: null, scope: scopeOfOrder(reserved), orders: all, excludeOrderId: reserved.id })
    if (columnsOnly.some((s) => s.holdsPage || s.kind === 'in_doubt')) assert.equal(bare.kind, 'hold', `the columns alone saw a holder and the arbiter did not: ${ctx}`)
    if (columnsOnly.some((s) => s.holdsPage || s.kind === 'in_doubt')) assert.equal(verdict.kind, 'hold', `a request with proofs saw less than the columns: ${ctx}`)
    // the arbiter never decides on the order the rows came in
    assert.deepEqual(arbitrateReservation({ owner: evidence, order: reserved, orders: [...all].reverse(), listIsComplete: complete }), verdict)
  }
  assert.ok(proceeded > 500 && held > 500, `${proceeded} proceeded, ${held} held`)
})

// ====================================================================================================================================================================
// 10. pure means pure: nothing it is given is changed, and what it returns is plain data
// ====================================================================================================================================================================
test('the functions do not change what they are given (inputs frozen all the way down: a write would throw) and return plain data that survives JSON', () => {
  const deepFreeze = <T,>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
    }
    return value
  }
  const next = rng(3)
  let decided = 0
  for (let round = 0; round < 400; round += 1) {
    const world = deepFreeze(randomWorld(next))
    const scope = scopeOf(world.evidence)
    const decision = decide(world.evidence, world.orders, world.total, world.confirmRepeat, world.complete)
    const reserved = deepFreeze(order({ id: 'o_reserved', guestSessionHash: HASH_A }))
    const verdict = arbitrateReservation({ owner: world.evidence, order: reserved, orders: world.orders, listIsComplete: world.complete })
    const classes = classifySiblings({ owner: world.evidence, scope, orders: world.orders })
    const names = ownerLockNames(scope, CART)
    const response = publicResponseFor(decision, world.evidence)
    for (const value of [decision, verdict, classes, names, response, scope]) assert.deepEqual(JSON.parse(JSON.stringify(value ?? null)), value ?? null)
    decided += 1
  }
  assert.equal(decided, 400)
})
