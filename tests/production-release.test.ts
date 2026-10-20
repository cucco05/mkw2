// Step 4.6, S4 - the pure rule that decides whether an order may go to production (lib/order-payment-policy.ts). No database, no network.
// The same table is run against the REAL route handlers in tests/security/production-release.sec.ts; here every cell of it is pinned on its own.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIVE_ATTEMPT_GRACE_MS, ASSIGN_PRINTER_STATUSES, ORDER_LINK_METADATA_KEYS, ORG_APPROVAL_STATUSES, PRINTLAB_SUBMIT_STATUSES, RESERVED_ORDER_METADATA_KEYS, RELEASE_FACTS_SELECT,
  checkManualTransition, describeRelease, gateAutomaticStatus, getProductionAuthorization, hasManualPaymentRecord, isReleasedToProduction, manualPaymentCovers, newOrderFacts,
  releaseDecision, releasedOrderWhere, productStockMayBeTakenAtCheckout, sanitizeExternalMetadata, verifiedPaymentBasis, type ReleaseFacts,
} from '../lib/order-payment-policy'
import { PAYMENT_REVIEW_REASON_TEXT, describeReviewReason } from '../lib/payment-review-reasons'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const minutes = (n: number) => new Date(NOW + n * 60_000)
// (step 4.6, S6) an authorization records the financial revision the order had when it was given; facts() below has revision 0
const AUTH = { productionAuthorization: { authorized: true, by: 'admin_1', at: '2026-10-17T09:00:00Z', reason: 'cash at the counter', kind: 'exceptional', financialRevision: 0 } }
// (step 4.6, S6) a payment attested by an administrator: how it was received, how much (taken from the order by the server) and in which currency
const MANUAL = { manualPayment: { by: 'admin_1', at: '2026-10-17T09:00:00Z', reason: 'cash received', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR' } }

function facts(over: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return {
    paymentStatus: 'pending', paymentReviewReason: null, metadata: {}, totalCents: 2500, currency: 'EUR', paymentMethod: 'card',
    stripePaymentIntentId: null, stripeInvoiceId: null, paidAt: null, refundedCents: 0, financialRevision: 0, paymentAttempts: [], refundOperations: [],
    ...over,
  }
}
const stripePaid = (over: Partial<ReleaseFacts> = {}) => facts({ paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paidAt: new Date(NOW - 60_000), ...over })
const decide = (f: ReleaseFacts) => releaseDecision(f, { now: NOW })

// ---- the table the owner listed -----------------------------------------------------------------------------------------------------------
const TABLE: Array<{ name: string; facts: ReleaseFacts; state: string; basis?: string; code?: string; authorizable?: boolean }> = [
  { name: 'awaiting payment', facts: facts(), state: 'payment_pending', code: 'PAYMENT_NOT_VERIFIED', authorizable: true },
  { name: 'payment being confirmed (status + attempt)', facts: facts({ paymentStatus: 'processing', paymentAttempts: [{ status: 'processing', expiresAt: minutes(20) }] }), state: 'payment_processing', code: 'PAYMENT_PROCESSING', authorizable: false },
  { name: 'payment being confirmed (attempt only, on a paid order)', facts: stripePaid({ paymentAttempts: [{ status: 'paid' }, { status: 'processing' }] }), state: 'payment_processing', code: 'PAYMENT_PROCESSING', authorizable: false },
  { name: 'payment under review (amount)', facts: facts({ paymentReviewReason: 'amount' }), state: 'payment_hold', code: 'PAYMENT_ON_HOLD', authorizable: false },
  { name: 'payment under review (dispute on a paid order)', facts: stripePaid({ paymentReviewReason: 'dispute' }), state: 'payment_hold', code: 'PAYMENT_ON_HOLD', authorizable: false },
  { name: 'payment under review (a code nobody knows)', facts: stripePaid({ paymentReviewReason: 'something_new' }), state: 'payment_hold', code: 'PAYMENT_ON_HOLD', authorizable: false },
  { name: 'payment confirmed', facts: stripePaid(), state: 'released', basis: 'stripe_verified' },
  { name: 'outside order, not authorized', facts: facts({ paymentReviewReason: 'external_order' }), state: 'external_review', code: 'EXTERNAL_ORDER_NOT_AUTHORIZED', authorizable: true },
  { name: 'outside order, not authorized, even with a verified payment', facts: stripePaid({ paymentReviewReason: 'external_order' }), state: 'external_review', code: 'EXTERNAL_ORDER_NOT_AUTHORIZED', authorizable: true },
  { name: 'outside order, authorized', facts: facts({ paymentReviewReason: 'external_order', metadata: AUTH }), state: 'released', basis: 'admin_authorization' },
  { name: 'outside order, authorized, with a later money problem in the review log', facts: facts({ paymentReviewReason: 'external_order', metadata: { ...AUTH, paymentReview: [{ reason: 'duplicate_payment' }] } }), state: 'payment_hold', code: 'PAYMENT_ON_HOLD', authorizable: false },
  { name: 'cancelled after payment', facts: stripePaid({ paymentReviewReason: 'paid_after_cancel' }), state: 'payment_hold', code: 'PAYMENT_ON_HOLD', authorizable: false },
  { name: 'a mismatch attempt left after the hold was accepted', facts: stripePaid({ paymentAttempts: [{ status: 'paid' }, { status: 'mismatch' }] }), state: 'released', basis: 'stripe_verified' },
  { name: 'free order made by an administrator', facts: facts({ paymentStatus: 'free', totalCents: 0 }), state: 'released', basis: 'free_order' },
  { name: 'unpaid order with an explicit authorization', facts: facts({ metadata: AUTH }), state: 'released', basis: 'admin_authorization' },
  { name: 'authorization does not override a money hold', facts: facts({ metadata: AUTH, paymentReviewReason: 'amount' }), state: 'payment_hold', code: 'PAYMENT_ON_HOLD', authorizable: false },
  { name: 'authorization does not override a payment being confirmed', facts: facts({ metadata: AUTH, paymentStatus: 'processing' }), state: 'payment_processing', code: 'PAYMENT_PROCESSING', authorizable: false },
  { name: 'authorization does not override an open Stripe page', facts: facts({ metadata: AUTH, paymentAttempts: [{ status: 'open', expiresAt: minutes(20) }] }), state: 'payment_active', code: 'PAYMENT_ACTIVE', authorizable: false },
  { name: 'an open Stripe page, no authorization', facts: facts({ paymentAttempts: [{ status: 'open', expiresAt: minutes(20) }] }), state: 'payment_active', code: 'PAYMENT_ACTIVE', authorizable: false },
  { name: 'a reservation being created', facts: facts({ paymentAttempts: [{ status: 'creating', expiresAt: minutes(30) }] }), state: 'payment_active', code: 'PAYMENT_ACTIVE', authorizable: false },
  { name: 'paid with proof and a second page left open', facts: stripePaid({ paymentAttempts: [{ status: 'paid' }, { status: 'open', expiresAt: minutes(20) }] }), state: 'released', basis: 'stripe_verified' },
  { name: 'paid by a registered manual payment', facts: facts({ paymentStatus: 'paid', metadata: MANUAL }), state: 'released', basis: 'manual_payment' },
  { name: '"paid" with no proof at all', facts: facts({ paymentStatus: 'paid' }), state: 'payment_unproven', code: 'PAYMENT_UNPROVEN', authorizable: true },
  { name: '"free" on an order that has a price', facts: facts({ paymentStatus: 'free', totalCents: 2500 }), state: 'payment_unproven', code: 'PAYMENT_UNPROVEN', authorizable: true },
  { name: 'a typed Stripe reference with no verification', facts: facts({ stripePaymentIntentId: 'pi_typed', metadata: { stripe: { paymentIntentId: 'pi_typed' } } }), state: 'payment_pending', code: 'PAYMENT_NOT_VERIFIED', authorizable: true },
  { name: 'a quote request', facts: facts({ paymentStatus: 'quote' }), state: 'payment_pending', code: 'PAYMENT_NOT_VERIFIED', authorizable: true },
  { name: 'authorized only (requires_capture)', facts: facts({ paymentStatus: 'requires_capture' }), state: 'payment_pending', code: 'PAYMENT_NOT_VERIFIED', authorizable: true },
  { name: 'payment failed', facts: facts({ paymentStatus: 'failed' }), state: 'payment_pending', code: 'PAYMENT_NOT_VERIFIED', authorizable: true },
  { name: '"paid" with no proof but an administrator authorization', facts: facts({ paymentStatus: 'paid', metadata: AUTH }), state: 'released', basis: 'admin_authorization' },
]

for (const row of TABLE) {
  test(`decision: ${row.name}`, () => {
    const d = decide(row.facts)
    assert.equal(d.state, row.state)
    assert.equal(d.released, row.state === 'released')
    assert.equal(d.basis, row.basis ?? null)
    assert.equal(d.code, row.code ?? null)
    if (row.state !== 'released') {
      assert.equal(d.authorizable, row.authorizable)
      assert.ok(d.message.length > 20, 'a refusal explains itself')
    } else {
      assert.equal(d.message, '')
    }
    assert.equal(isReleasedToProduction(row.facts, { now: NOW }), row.state === 'released')
  })
}

// ---- the proof of a payment -------------------------------------------------------------------------------------------------------------------
test('proof: a Stripe payment needs a reference AND the verification the server writes', () => {
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid' })), null, 'the status word alone')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', stripePaymentIntentId: 'pi_1' })), null, 'a reference alone')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', paidAt: new Date(NOW) })), null, 'a date without a reference')
  assert.equal(verifiedPaymentBasis(stripePaid()), 'stripe_verified', 'reference + paidAt')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', paymentAttempts: [{ status: 'paid' }] })), 'stripe_verified', 'reference + a paid attempt')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', metadata: { stripe: { paymentIntentId: 'pi_1', paymentStatus: 'paid' } } })), 'stripe_verified', 'reference + the Stripe record')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', stripePaymentIntentId: 'pi_1', metadata: { stripe: { paymentIntentId: 'pi_1', paymentStatus: 'processing' } } })), null, 'the Stripe record says it is not paid')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', stripeInvoiceId: 'in_1', metadata: { stripeInvoice: { invoiceId: 'in_1', paymentStatus: 'paid' } } })), 'stripe_verified', 'an invoice')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'pending', stripePaymentIntentId: 'pi_1', paidAt: new Date(NOW) })), null, 'the status is not paid')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'succeeded', stripePaymentIntentId: 'pi_1', paidAt: new Date(NOW) })), 'stripe_verified', 'Stripe\'s own word for paid')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', stripePaymentIntentId: '  ', paidAt: new Date(NOW) })), null, 'a blank reference')
})

test('proof: a manual payment is a COMPLETE record, and it is not a Stripe payment', () => {
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata: MANUAL })), 'manual_payment')
  for (const missing of ['by', 'at', 'reason', 'method', 'receivedVia', 'amountCents', 'currency']) {
    const record: Record<string, unknown> = { ...MANUAL.manualPayment }
    delete record[missing]
    assert.equal(hasManualPaymentRecord({ manualPayment: record }), false, missing)
    assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata: { manualPayment: record } })), null, missing)
  }
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'pending', metadata: MANUAL })), null, 'registered but the status is not paid')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata: { manualPayment: 'cash' } })), null, 'the wrong shape')
  // with both, the Stripe verification is what is reported
  assert.equal(verifiedPaymentBasis(stripePaid({ metadata: MANUAL })), 'stripe_verified')
})

test('proof: PayPal capture and no-charge orders', () => {
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata: { paypal: { orderId: 'o1', captureId: 'c1', paymentStatus: 'paid' } } })), 'paypal_verified')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata: { paypal: { orderId: 'o1', captureId: null, paymentStatus: 'paid' } } })), null)
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata: { paypal: { orderId: 'o1', captureId: 'c1', paymentStatus: 'processing' } } })), null)
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'free', totalCents: 0 })), 'free_order')
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'free', totalCents: 1 })), null)
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', totalCents: 0 })), null, '"paid" is not "free"')
  const comped = { manualPayment: { by: 'admin_1', at: '2026-10-17T09:00:00Z', reason: 'gift for the fair', method: 'comped', receivedVia: 'none', amountCents: 0, currency: 'EUR' } }
  assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'free', totalCents: 2500, metadata: comped })), 'manual_payment', 'a registered no-charge decision')
})

// ---- a Stripe payment page that is still open ------------------------------------------------------------------------------------------
test('active page: open until it expired plus the grace, and only on an order that is not already paid with proof', () => {
  const open = (expiresAt: Date | null | undefined) => facts({ paymentAttempts: [{ status: 'open', expiresAt }] })
  assert.equal(decide(open(minutes(20))).state, 'payment_active')
  assert.equal(decide(open(minutes(-1))).state, 'payment_active', 'expired a minute ago: Stripe or the webhook may not have said so yet')
  const justInside = new Date(NOW - ACTIVE_ATTEMPT_GRACE_MS + 1000)
  assert.equal(decide(open(justInside)).state, 'payment_active')
  const justOutside = new Date(NOW - ACTIVE_ATTEMPT_GRACE_MS - 1000)
  assert.equal(decide(open(justOutside)).state, 'payment_pending', 'long expired: it no longer holds the order')
  assert.equal(decide(open(null)).state, 'payment_active', 'no readable expiry: taken as open')
  assert.equal(decide(facts({ paymentAttempts: [{ status: 'expired', expiresAt: minutes(20) }, { status: 'failed', expiresAt: minutes(20) }] })).state, 'payment_pending', 'closed attempts do not count')
  assert.equal(decide(facts({ paymentAttempts: [{ status: 'mismatch', expiresAt: minutes(20) }] })).state, 'payment_pending', 'a mismatch always comes with a review reason; alone it does not block')
  const d = decide(open(minutes(20)))
  assert.equal(d.activeUntil, new Date(minutes(20).getTime() + ACTIVE_ATTEMPT_GRACE_MS).toISOString())
  const strings = decide(facts({ paymentAttempts: [{ status: 'open', expiresAt: minutes(5).toISOString() }] }))
  assert.equal(strings.state, 'payment_active', 'dates as strings (JSON) work too')
})

// ---- precedence ---------------------------------------------------------------------------------------------------------------------------------
test('precedence: nothing overrides a hold, a payment being confirmed or an open page', () => {
  for (const base of [
    facts({ metadata: AUTH, paymentReviewReason: 'dispute' }),
    stripePaid({ metadata: AUTH, paymentReviewReason: 'duplicate_payment' }),
    facts({ metadata: AUTH, paymentStatus: 'processing' }),
    stripePaid({ metadata: AUTH, paymentAttempts: [{ status: 'processing' }] }),
    facts({ metadata: AUTH, paymentAttempts: [{ status: 'creating', expiresAt: minutes(30) }] }),
  ]) {
    const d = decide(base)
    assert.equal(d.released, false)
    assert.equal(d.authorizable, false)
  }
})

test('precedence: a review reason beats every proof of payment', () => {
  for (const meta of [{}, MANUAL, { paypal: { captureId: 'c1', paymentStatus: 'paid' } }]) {
    assert.equal(decide(stripePaid({ metadata: meta, paymentReviewReason: 'amount' })).state, 'payment_hold')
  }
  assert.equal(decide(facts({ paymentStatus: 'free', totalCents: 0, paymentReviewReason: 'amount' })).state, 'payment_hold')
})

test('a hold the administrator accepted (reason cleared) leaves the log without blocking a hosted order', () => {
  const accepted = stripePaid({ paymentReviewReason: null, metadata: { paymentReview: [{ reason: 'duplicate_payment' }], stripe: { paymentStatus: 'paid' } } })
  assert.equal(decide(accepted).state, 'released', 'only an outside order is blocked by the log: the column is what a hold sets and what "accepted" clears')
})

test('the review log blocks an outside order only for a money reason, not for the "external order" entry itself', () => {
  const entry = { reason: 'external_order', at: 'x' }
  assert.equal(decide(facts({ paymentReviewReason: 'external_order', metadata: { ...AUTH, paymentReview: [entry] } })).state, 'released')
  assert.equal(decide(facts({ paymentReviewReason: 'external_order', metadata: { ...AUTH, paymentReview: [entry, { reason: 'dispute' }] } })).state, 'payment_hold')
  assert.equal(decide(facts({ paymentReviewReason: 'external_order', metadata: { ...AUTH, paymentReview: 'not a list' } })).state, 'released')
  assert.equal(decide(facts({ paymentReviewReason: 'external_order', metadata: { ...AUTH, paymentReview: [null, 5, { reason: 7 }, {}] } })).state, 'released', 'malformed entries say nothing')
})

test('a forged authorization does not count', () => {
  for (const metadata of [{ productionAuthorization: { by: 'x' } }, { productionAuthorization: { authorized: true } }, { productionAuthorization: { authorized: 'true', by: 'x' } }, { productionAuthorization: { authorized: true, by: '' } }, { productionAuthorization: 'yes' }]) {
    assert.equal(decide(facts({ metadata })).state, 'payment_pending', JSON.stringify(metadata))
  }
})

test('facts that are not an object do not release anything', () => {
  for (const metadata of [null, undefined, 'x', 5, [], [AUTH]]) assert.equal(decide(facts({ metadata })).released, false)
})

// ---- the transitions built on the decision ------------------------------------------------------------------------------------------------
test('manual transition: same behavior as before for the old cases, with the same code', () => {
  const unpaid = facts()
  const paid = stripePaid()
  for (const next of ['queued', 'printing', 'post_process', 'shipped', 'completed']) {
    const refused = checkManualTransition(unpaid, next, { adminId: 'a', now: NOW })
    assert.equal(refused.allowed, false, next)
    assert.equal((refused as any).code, 'PAYMENT_NOT_VERIFIED')
    assert.equal(checkManualTransition(paid, next, { adminId: 'a', now: NOW }).allowed, true, next)
  }
  for (const next of ['cancelled', 'failed', 'awaiting_payment', 'awaiting_review']) {
    assert.equal(checkManualTransition(facts({ paymentReviewReason: 'dispute' }), next, { adminId: 'a', now: NOW }).allowed, true, `${next}: moving away from production is always allowed`)
  }
  const auth = checkManualTransition(unpaid, 'queued', { adminId: 'admin_1', authorizeUnpaid: true, reason: 'cash received', now: NOW })
  assert.equal(auth.allowed, true)
  assert.equal(((auth as any).metadata.productionAuthorization).by, 'admin_1')
  assert.equal(isReleasedToProduction({ ...unpaid, metadata: (auth as any).metadata }, { now: NOW }), true)
})

test('manual transition: an authorization is refused when the payment is held, being confirmed or open - with the reason why', () => {
  const cases: Array<[ReleaseFacts, string]> = [
    [facts({ paymentReviewReason: 'amount' }), 'PAYMENT_ON_HOLD'],
    [facts({ paymentStatus: 'processing' }), 'PAYMENT_PROCESSING'],
    [facts({ paymentAttempts: [{ status: 'open', expiresAt: minutes(10) }] }), 'PAYMENT_ACTIVE'],
  ]
  for (const [order, code] of cases) {
    const result = checkManualTransition(order, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'goods handed over', now: NOW })
    assert.equal(result.allowed, false)
    assert.equal((result as any).code, code)
    assert.equal((result as any).metadata, undefined, 'nothing to write')
  }
})

test('manual transition: authorizable states need the flag; unproven and outside orders can be authorized', () => {
  for (const order of [facts({ paymentStatus: 'paid' }), facts({ paymentReviewReason: 'external_order' })]) {
    assert.equal(checkManualTransition(order, 'queued', { adminId: 'a', now: NOW }).allowed, false)
    assert.equal(checkManualTransition(order, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'checked by hand', now: NOW }).allowed, true)
  }
})

test('manual transition: a free reprint needs a written reason (and so does every other authorization, since S6)', () => {
  const reprint = facts({ metadata: { reprint: { sourceOrderId: 'o1' } } })
  const short = checkManualTransition(reprint, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'ok', now: NOW })
  assert.equal(short.allowed, false)
  assert.equal((short as any).code, 'REASON_REQUIRED')
  assert.equal((short as any).httpStatus, 400)
  assert.equal(checkManualTransition(reprint, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'printed wrong, our fault', now: NOW }).allowed, true)
})

test('automatic transition: only a released order enters production', () => {
  for (const next of ['queued', 'printing', 'completed']) {
    assert.equal(gateAutomaticStatus(facts(), next), 'awaiting_payment')
    assert.equal(gateAutomaticStatus(facts({ paymentReviewReason: 'amount', metadata: AUTH }), next), 'awaiting_payment')
    assert.equal(gateAutomaticStatus(stripePaid(), next), next)
  }
  assert.equal(gateAutomaticStatus(facts(), 'cancelled'), 'cancelled')
  assert.equal(gateAutomaticStatus(facts(), 'queued', 'awaiting_review'), 'awaiting_review')
})

test('a new order is described by its own facts', () => {
  assert.equal(decide(newOrderFacts({ paymentStatus: 'free', totalCents: 0 })).basis, 'free_order')
  assert.equal(decide(newOrderFacts({ paymentStatus: 'pending', totalCents: 500 })).state, 'payment_pending')
  assert.equal(decide(newOrderFacts({ paymentStatus: 'pending', totalCents: 500, metadata: AUTH })).basis, 'admin_authorization')
})

// ---- words, lists and the selection ---------------------------------------------------------------------------------------------------------
test('descriptions: every state has a label and a sentence, and the three bases stay distinct', () => {
  const labels = new Set<string>()
  for (const row of TABLE) {
    const text = describeRelease(decide(row.facts))
    assert.ok(text.label.length > 5 && text.detail.length > 10, row.name)
    labels.add(text.label)
  }
  assert.ok(describeRelease(decide(stripePaid())).label.includes('Stripe'))
  assert.ok(describeRelease(decide(facts({ paymentStatus: 'paid', metadata: MANUAL }))).label.includes('manual'))
  assert.ok(describeRelease(decide(facts({ metadata: AUTH }))).label.includes('authorization'))
  assert.ok(describeRelease(decide(facts({ paymentReviewReason: 'dispute' }))).label.includes('Payment disputed'))
  assert.ok(labels.size >= 9)
  // the new states of S6
  assert.ok(describeRelease(decide(stripePaid({ refundedCents: 500 }))).label.includes('refunded'))
  assert.ok(describeRelease(decide(stripePaid({ refundOperations: [{ status: 'unknown', appliedAt: null }] }))).label.includes('refund in progress'))
  const credit = { productionAuthorization: { authorized: true, by: 'admin_1', at: 'x', reason: 'trusted customer', kind: 'commercial_credit', financialRevision: 0, credit: { method: 'invoice', reference: 'INV-7', amountDueCents: 12000, currency: 'EUR', dueAt: null } } }
  const creditText = describeRelease(decide(facts({ paymentMethod: 'invoice', totalCents: 12000, metadata: credit })))
  assert.match(creditText.label, /commercial credit \(invoice INV-7\): 120\.00 EUR still due/)
})

test('review reasons: every code the payment sync can write has a text; an unknown one is still described', () => {
  assert.equal(Object.keys(PAYMENT_REVIEW_REASON_TEXT).length, 15)
  for (const [code, text] of Object.entries(PAYMENT_REVIEW_REASON_TEXT)) assert.ok(text.label && text.detail, code)
  assert.equal(describeReviewReason(null), null)
  assert.ok(describeReviewReason('brand_new_code')?.detail.includes('blocked'))
})

test('which statuses an operation accepts', () => {
  assert.deepEqual([...ASSIGN_PRINTER_STATUSES], ['queued', 'printing', 'in_production'])
  assert.deepEqual([...PRINTLAB_SUBMIT_STATUSES], ['queued'])
  assert.deepEqual([...ORG_APPROVAL_STATUSES], ['awaiting_review', 'awaiting_payment'])
})

test('reserved metadata keys: an outside service can not write the markers of the production flows', () => {
  for (const key of ['productionAuthorization', 'manualPayment', 'stripe', 'paypal', 'printLabSubmissions', 'lastPrintLabSubmission', 'stockworksConsumedAt', 'stockworksConsumption', 'externalEffects', 'orgApproval', 'paymentReview', 'financialRevision', 'paymentHoldResolution']) {
    assert.ok(RESERVED_ORDER_METADATA_KEYS.includes(key), key)
  }
  // the ids the server writes into an order made from a job are not the sender's to set (the caller that wrote them itself keeps them)
  assert.deepEqual([...ORDER_LINK_METADATA_KEYS].sort(), ['jobFormId', 'orderId', 'paymentIntentId', 'source'])
  const linked = { note: 'x', paymentIntentId: 'pi_attacker', source: 'evil', jobFormId: 'job_other', orderId: 'order_other' }
  assert.deepEqual(sanitizeExternalMetadata(linked), { note: 'x' })
  assert.deepEqual(sanitizeExternalMetadata(linked, { keepLinks: true }), linked)
  const cleaned = sanitizeExternalMetadata({ note: 'x', stockworksConsumedAt: '2026-01-01', externalEffects: {}, paypal: { captureId: 'c', paymentStatus: 'paid' }, printLabSubmissions: [] })
  assert.deepEqual(cleaned, { note: 'x' })
})

test('the selection that loads the facts has every field the decision reads', () => {
  const selected = Object.keys(RELEASE_FACTS_SELECT).sort()
  assert.deepEqual(selected, ['currency', 'financialRevision', 'metadata', 'paidAt', 'paymentAttempts', 'paymentMethod', 'paymentReviewReason', 'paymentStatus', 'refundOperations', 'refundedCents', 'stripeInvoiceId', 'stripePaymentIntentId', 'totalCents'])
})

test('the Prisma prefilter has the two ways in and refuses a payment in confirmation', () => {
  const where = releasedOrderWhere(new Date(NOW)) as any
  const json = JSON.stringify(where)
  assert.ok(json.includes('"processing"'), 'attempts being confirmed are excluded')
  assert.ok(json.includes('productionAuthorization'))
  assert.ok(json.includes('manualPayment'))
  assert.ok(json.includes('"creating"') && json.includes('"open"'), 'open pages block the authorization branch')
  assert.equal(where.AND.length, 3)
  assert.deepEqual(Object.keys(where.AND[1]), ['refundOperations'], 'an order with a refund operation that blocks is never picked')
  assert.equal(where.AND[2].OR.length, 2)
  assert.ok(json.includes('"refundedCents":0'), 'a refund of the order\'s own payment takes the Stripe proof away')
  assert.ok(json.includes('financialRevision'), 'an authorization without a revision is never valid')
})

test('legacy checkout: stock of a ready-made product is taken only for a sale that is real', () => {
  const may = (paymentMethod: string, paymentStatus: string | null) => productStockMayBeTakenAtCheckout({ paymentMethod, paymentStatus })
  // never for a quote request, whatever status it carries
  for (const status of ['quote', 'paid', 'free', 'pending', null]) assert.equal(may('quote', status), false, `quote/${status}`)
  // a card or PayPal payment: only once this request verified it
  assert.equal(may('card', 'paid'), true)
  assert.equal(may('paypal', 'paid'), true)
  for (const status of ['processing', 'requires_capture', 'pending', 'failed', 'canceled', null]) {
    assert.equal(may('card', status), false, `card/${status}`)
    assert.equal(may('paypal', status), false, `paypal/${status}`)
  }
  // a no-charge order, and the orders an administrator enters by hand
  assert.equal(may('comped', 'free'), true)
  for (const method of ['cash', 'invoice', 'po']) assert.equal(may(method, 'pending'), true, method)
  assert.equal(may('mystery', 'pending'), false)
})
