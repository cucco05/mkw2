// Step 4.6, S6a (P2b, M115) - the ORACLE of the financial revision: whatever the release decision READS must be classified.
//
// The revision (lib/financial-revision.ts) is raised by the writers of the facts in the list E1-E14. If the release decision started to read a fact that is on neither list - the
// shipping cost, say - then a change of that fact would NOT invalidate an authorization given before it, and nobody would notice. So this test runs the decision (and the functions
// that decide for the routes: checkManualTransition, gateAutomaticStatus, isReleasedToProduction) over a large, deterministic set of orders whose facts and metadata are wrapped in a
// Proxy that records every property that is read, and fails when a property that was read is neither an event (E1-E14) nor a documented non-event (N1-N10) nor one of the
// authorization / revision themselves. It also fails when the oracle itself is blind (it must see the core facts), and it is proved able to catch a read of an unclassified fact.
// Pure: no database, no network.
import { classifyFactPath } from '../lib/financial-revision'
import { checkManualTransition, gateAutomaticStatus, isReleasedToProduction, releaseDecision, type ReleaseFacts } from '../lib/order-payment-policy'
import assert from 'node:assert/strict'
import test from 'node:test'

// ---- the recording Proxy --------------------------------------------------------------------------------------------------------------------------------------------
// `plain`: top-level properties handed over WITHOUT recording what is read inside them (used where the metadata is only COPIED into the metadata a grant writes - a spread reads every
// key, and that is not a decision)
function recording<T>(value: T, reads: Set<string>, path = '', plain: ReadonlySet<string> = new Set()): T {
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  const isArray = Array.isArray(value)
  return new Proxy(value as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      const child = Reflect.get(target, prop, receiver)
      // a method (some, filter, includes...) is not a fact: what it reads goes through this same proxy
      if (typeof child === 'function') return child
      const indexed = isArray && /^\d+$/.test(prop)
      const childPath = indexed ? `${path}[]` : `${path}${path ? '.' : ''}${prop}`
      reads.add(childPath)
      return path === '' && plain.has(prop) ? child : recording(child, reads, childPath)
    },
    ownKeys(target) {
      // enumerating the keys of an object is a read of ALL of them: it must be classified as such
      reads.add(`${path}.{keys}`)
      return Reflect.ownKeys(target)
    },
  }) as T
}

// ---- a deterministic corpus -----------------------------------------------------------------------------------------------------------------------------------------
function lcg(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}
const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString()

const PAYMENT_STATUSES = ['pending', 'paid', 'free', 'processing', 'failed', 'canceled', 'quote', null]
const REASONS = [null, null, null, 'dispute', 'amount', 'external_order', 'duplicate_payment', 'shipping_address_missing']
const METHODS = ['card', 'cash', 'invoice', 'po', 'paypal', 'quote', 'comped', null]
const ATTEMPT_STATUSES = ['creating', 'open', 'processing', 'paid', 'mismatch', 'expired', 'failed']
const REFUND_STATUSES = ['requested', 'sending', 'unknown', 'pending', 'requires_action', 'succeeded', 'failed', 'canceled', 'abandoned', 'unresolved', 'something-new']

function metadataVariant(pick: <T>(items: readonly T[]) => T, revision: number): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {}
  if (pick([false, false, true])) metadata.stripe = { paymentIntentId: 'pi_x', paymentStatus: pick(['paid', 'processing', 'pending']), dispute: pick([undefined, { id: 'dp_1', status: 'needs_response' }]), receiptUrl: 'https://x' }
  if (pick([false, false, true])) metadata.stripeInvoice = { paymentStatus: pick(['paid', 'open']) }
  if (pick([false, false, true])) metadata.paypal = { captureId: pick(['cap_1', '']), paymentStatus: pick(['paid', 'pending']) }
  if (pick([false, true])) {
    metadata.manualPayment = {
      by: 'adm', at: iso(-5), reason: 'cash at the counter', method: pick(['cash', 'invoice', 'po', 'comped', 'paypal']), receivedVia: pick(['cash', 'bank_transfer', undefined, 'wire']),
      reference: pick([undefined, 'CRO 1']), amountCents: pick([2500, 100, undefined]), currency: pick(['EUR', 'USD', undefined]),
    }
  }
  if (pick([false, true])) {
    metadata.productionAuthorization = {
      authorized: pick([true, true, false]), by: pick(['adm', '']), at: iso(-9), reason: 'agreed with the customer', kind: pick(['exceptional', 'commercial_credit']),
      financialRevision: pick([revision, revision, revision + 1, undefined, '0', -1, 1.5]),
      credit: pick([undefined, { method: 'invoice', reference: 'INV-1', amountDueCents: 2500, currency: 'EUR', dueAt: null }, { method: 'invoice' }]),
      financialFacts: { refundedCents: 0, totalCents: 2500, currency: 'EUR', proofBasis: null },
    }
  }
  if (pick([false, false, true])) metadata.paymentReview = pick([[{ reason: 'dispute', at: iso(-3) }], [{ reason: 'amount' }, { reason: 'external_order' }], [], 'not-an-array'])
  if (pick([false, false, true])) metadata.paymentHoldResolution = [{ outcome: 'accepted', by: 'adm', at: iso(-2), reason: 'checked', stripeCheck: 'payment_collected' }]
  if (pick([false, false, true])) metadata.reprint = { kind: 'customer_request', sourceOrderId: 'o1' }
  if (pick([false, false, true])) metadata.orgApproval = { action: 'approve' }
  if (pick([false, false, true])) metadata.printLabSubmissions = [{ id: 'j1' }]
  if (pick([false, false, true])) metadata.externalEffects = { k: { state: 'confirmed' } }
  return pick([null, metadata, metadata, metadata, {}]) ?? null
}

function corpus(size: number): ReleaseFacts[] {
  const random = lcg(20261020)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const facts: ReleaseFacts[] = []
  for (let i = 0; i < size; i++) {
    const revision = pick([0, 0, 1, 2, 7])
    facts.push({
      paymentStatus: pick(PAYMENT_STATUSES), paymentReviewReason: pick(REASONS), paymentMethod: pick(METHODS), totalCents: pick([0, 2500, 2500, 9000]), currency: pick(['EUR', 'EUR', 'USD', null]),
      refundedCents: pick([0, 0, 0, 500, 2500]), financialRevision: pick([revision, revision, revision, null as unknown as number, 'x' as unknown as number]),
      stripePaymentIntentId: pick([null, 'pi_x']), stripeInvoiceId: pick([null, null, 'in_x']), paidAt: pick([null, new Date(NOW - 60_000)]),
      metadata: metadataVariant(pick, revision),
      paymentAttempts: Array.from({ length: Math.floor(random() * 3) }, () => ({ status: pick(ATTEMPT_STATUSES), expiresAt: pick([new Date(NOW + 600_000), new Date(NOW - 3_600_000), iso(5), null as unknown as Date]) })),
      refundOperations: Array.from({ length: Math.floor(random() * 2.4) }, () => ({ status: pick(REFUND_STATUSES), appliedAt: pick([null, new Date(NOW - 1000), undefined as unknown as null]) })),
    })
  }
  return facts
}

// every function that decides for the routes, run on the recording copy of the facts
function readsOf(facts: ReleaseFacts[], run: (recorded: ReleaseFacts, hybrid: ReleaseFacts) => void): Set<string> {
  const reads = new Set<string>()
  for (const fact of facts) run(recording(fact, reads), recording(fact, reads, '', new Set(['metadata'])))
  return reads
}
const ALL_DECISIONS = (recorded: ReleaseFacts, hybrid: ReleaseFacts) => {
  releaseDecision(recorded, { now: NOW })
  isReleasedToProduction(recorded, { now: NOW })
  gateAutomaticStatus(recorded, 'queued')
  // a refusal for a reason that is too short: the decision, and the wording of the refusal (it reads whether the order is a reprint)
  checkManualTransition(recorded, 'printing', { authorizeUnpaid: true, adminId: 'adm', reason: 'short', now: NOW })
  checkManualTransition(recorded, 'printing', { authorizeUnpaid: false, adminId: 'adm', now: NOW })
  // a GRANT: besides the decision above it COPIES the metadata into the metadata it writes (a spread reads every key: that is a copy, not a decision), and reads the order's own figures
  checkManualTransition(hybrid, 'printing', { authorizeUnpaid: true, adminId: 'adm', reason: 'agreed with the customer on the phone', now: NOW })
  checkManualTransition(hybrid, 'printing', { authorizeUnpaid: true, adminId: 'adm', reason: 'agreed with the customer on the phone', kind: 'commercial_credit', creditReference: 'INV-9', now: NOW })
}
const unclassified = (reads: Set<string>) => [...reads].filter((path) => classifyFactPath(path) === null).sort()

test('M115 everything the release decision reads about an order is classified: an event (E1-E14), a non-event (N1-N10), the authorization or the revision itself', () => {
  const reads = readsOf(corpus(6000), ALL_DECISIONS)
  assert.deepEqual(unclassified(reads), [], 'the decision reads a fact that is neither an event nor a documented non-event: a change of it would NOT invalidate an authorization given before it. Classify it in lib/financial-revision.ts (and make its writers raise the revision), or stop reading it')
})

test('M115 the oracle is not blind: it sees the core facts of the decision, in every shape (columns, metadata keys, attempts, refund operations, the authorization)', () => {
  const reads = readsOf(corpus(6000), ALL_DECISIONS)
  for (const expected of [
    'paymentStatus', 'paymentReviewReason', 'paymentMethod', 'totalCents', 'currency', 'refundedCents', 'financialRevision', 'stripePaymentIntentId', 'paidAt',
    'metadata.stripe.paymentStatus', 'metadata.stripeInvoice.paymentStatus', 'metadata.paypal.captureId', 'metadata.manualPayment.method', 'metadata.manualPayment.amountCents',
    'metadata.productionAuthorization.financialRevision', 'metadata.paymentReview', 'paymentAttempts[].status', 'paymentAttempts[].expiresAt', 'refundOperations[].status', 'refundOperations[].appliedAt',
  ]) assert.ok(reads.has(expected), `the corpus never made the decision read "${expected}": the oracle would not notice a change there (reads: ${[...reads].sort().join(', ')})`)
  // and it covers the events the decision depends on
  const events = new Set([...reads].map((path) => classifyFactPath(path)).filter((cls) => cls?.kind === 'event').map((cls) => cls!.code))
  for (const code of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E12', 'E13']) assert.ok(events.has(code), `the decision never read a fact of ${code}: the registry lists an event the decision does not depend on, or the corpus is too narrow`)
})

test('M115 the oracle can FAIL: a decision that also reads the shipping cost, the status or an unknown metadata key is caught', () => {
  const sneaky = (recorded: ReleaseFacts) => {
    releaseDecision(recorded, { now: NOW })
    void (recorded as unknown as { shippingCents?: number }).shippingCents
    void (recorded.metadata as Record<string, unknown> | null)?.['somethingNew']
    void (recorded as unknown as { status?: string }).status
  }
  const reads = readsOf(corpus(50), sneaky)
  const missed = unclassified(reads)
  assert.ok(missed.includes('shippingCents'), 'a read of the shipping cost went unnoticed')
  assert.ok(missed.includes('status'), 'a read of the order status went unnoticed')
  assert.ok(missed.includes('metadata.somethingNew'), 'a read of an unknown metadata key went unnoticed')
})

test('M115 enumerating the keys of the metadata is a read of all of them and must be classified', () => {
  const reads = readsOf(corpus(20), (recorded) => { void Object.keys((recorded.metadata ?? {}) as object) })
  assert.ok(unclassified(reads).some((path) => path.endsWith('{keys}')), 'Object.keys(metadata) went unnoticed')
})
