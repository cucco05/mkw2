// Step 4.6, S6a (P2b) - the closed list of changes that increase the financial revision of an order (lib/financial-revision.ts). Pure: no database, no network.
// E1-E14 each have a case; N1-N10 (what does NOT count) each have a case; a write that changes nothing changes nothing.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FINANCIAL_COLUMNS, FINANCIAL_COLUMN_EVENTS, FINANCIAL_METADATA_PATHS, NON_EVENTS, attemptChangeIsFinancial, classifyFactPath, financialEvents, withFinancialRevision,
  type FinancialEvent, type FinancialPrev,
} from '../lib/financial-revision'

const prev: FinancialPrev = {
  status: 'queued', paymentStatus: 'paid', paidAt: new Date('2026-10-01T10:00:00Z'), paymentReviewReason: null, refundedCents: 0, totalCents: 2500, subtotalCents: 2000,
  shippingCents: 500, taxCents: 0, discountPercent: null, currency: 'EUR', stripePaymentIntentId: 'pi_1', stripeInvoiceId: null, paymentMethod: 'card',
  metadata: {
    stripe: { paymentIntentId: 'pi_1', paymentStatus: 'paid', syncedAt: 'x', lastEventType: 'a' }, stripeInvoice: { paymentStatus: 'open' }, paypal: { captureId: 'c1', paymentStatus: 'paid' },
    manualPayment: { by: 'a', method: 'cash', amountCents: 2500 }, paymentReview: [{ reason: 'dispute', at: '1' }], paymentHoldResolution: [{ outcome: 'accepted' }],
    productionAuthorization: { authorized: true, by: 'a', financialRevision: 0 }, printLabSubmissions: [], externalEffects: {}, reprint: {}, orgApproval: {}, guestAccessTokenHash: 'h',
  },
}
const events = (data: Record<string, unknown>, extras = {}) => financialEvents(prev, data, extras)
const withMeta = (change: (m: Record<string, any>) => void) => {
  const m = JSON.parse(JSON.stringify(prev.metadata))
  change(m)
  return { metadata: m }
}

// ---- E1-E14: each one increases the revision -------------------------------------------------------------------------------------------------------
const EVENT_CASES: Array<[FinancialEvent, string, Record<string, unknown>, Record<string, unknown>?]> = [
  ['E1', 'paymentStatus changes', { paymentStatus: 'pending' }],
  ['E1', 'paymentStatus to canceled', { paymentStatus: 'canceled' }],
  ['E1', 'paidAt is set (the proof of the payment)', { paidAt: new Date('2026-10-02T10:00:00Z') }],
  ['E2', 'a review reason is set', { paymentReviewReason: 'dispute' }],
  ['E2', 'a review reason is removed', { paymentReviewReason: null }, { paymentReviewReason: 'dispute' }],
  ['E3', 'refunded amount goes up', { refundedCents: 500 }],
  ['E3', 'refunded amount goes down', { refundedCents: 0 }, { refundedCents: 500 }],
  ['E3', 'refunded amount moves by an increment', { refundedCents: { increment: 5 } }],
  ['E4', 'total changes', { totalCents: 3000 }],
  ['E4', 'total moves by an increment (an order line)', { totalCents: { increment: 500 }, subtotalCents: { increment: 500 } }],
  ['E4', 'shipping changes', { shippingCents: 0 }],
  ['E4', 'tax changes', { taxCents: 100 }],
  ['E4', 'discount changes', { discountPercent: 10 }],
  ['E4', 'currency changes', { currency: 'USD' }],
  ['E5', 'a PaymentIntent is linked', { stripePaymentIntentId: 'pi_2' }],
  ['E5', 'an invoice is linked', { stripeInvoiceId: 'in_1' }],
  ['E6', 'the payment method changes', { paymentMethod: 'invoice' }],
  ['E7', 'Stripe payment status in the metadata', withMeta((m) => { m.stripe.paymentStatus = 'processing' })],
  ['E7', 'Stripe PaymentIntent in the metadata', withMeta((m) => { m.stripe.paymentIntentId = 'pi_9' })],
  ['E7', 'Stripe invoice payment status', withMeta((m) => { m.stripeInvoice.paymentStatus = 'paid' })],
  ['E7', 'a dispute is recorded', withMeta((m) => { m.stripe.dispute = { id: 'dp_1', status: 'needs_response' } })],
  ['E8', 'PayPal capture', withMeta((m) => { m.paypal.captureId = 'c2' })],
  ['E8', 'PayPal status', withMeta((m) => { m.paypal.paymentStatus = 'refunded' })],
  ['E9', 'a payment attested by an administrator is registered', withMeta((m) => { delete m.manualPayment }) , undefined],
  ['E9', 'a field of the attested payment varies', withMeta((m) => { m.manualPayment.amountCents = 1 })],
  ['E10', 'a new entry in the review log', withMeta((m) => { m.paymentReview.push({ reason: 'amount', at: '2' }) })],
  ['E11', 'a new entry in the hold resolutions', withMeta((m) => { m.paymentHoldResolution.push({ outcome: 'no_charge' }) })],
  ['E14', 'the order is cancelled', { status: 'cancelled' }],
  ['E14', 'the order is cancelled (american spelling)', { status: 'canceled' }],
  ['E14', 'a cancelled order is re-opened', { status: 'queued' }, { status: 'cancelled' }],
]
for (const [code, name, data, over] of EVENT_CASES) {
  test(`${code}: ${name}`, () => {
    const before: FinancialPrev = over ? { ...prev, ...over } : prev
    const result = financialEvents(before, data)
    assert.ok(result.includes(code), `expected ${code}, got ${JSON.stringify(result)}`)
    const written = withFinancialRevision(before, data)
    assert.deepEqual((written as any).financialRevision, { increment: 1 })
  })
}
test('E9 an attested payment is registered on an order that had none', () => {
  const none: FinancialPrev = { ...prev, metadata: { note: 'x' } }
  assert.ok(financialEvents(none, { metadata: { note: 'x', manualPayment: { by: 'a', method: 'cash' } } }).includes('E9'))
})
test('E12: a payment attempt enters or leaves processing / paid / mismatch, or its amount received / PaymentIntent changes', () => {
  assert.ok(events({ note: 'x' }, { attempt: true }).includes('E12'))
  const base = { status: 'open', amountReceivedCents: null, stripePaymentIntentId: null }
  for (const [from, to] of [['open', 'processing'], ['open', 'paid'], ['processing', 'paid'], ['processing', 'failed'], ['paid', 'mismatch'], ['mismatch', 'failed'], ['creating', 'mismatch']] as const) {
    assert.equal(attemptChangeIsFinancial({ ...base, status: from }, { status: to }), true, `${from} -> ${to}`)
  }
  assert.equal(attemptChangeIsFinancial(base, { amountReceivedCents: 2500 }), true)
  assert.equal(attemptChangeIsFinancial(base, { stripePaymentIntentId: 'pi_1' }), true)
  // N3: the availability of the payment page is not an event
  for (const [from, to] of [['creating', 'open'], ['creating', 'expired'], ['open', 'expired'], ['open', 'failed'], ['creating', 'failed']] as const) {
    assert.equal(attemptChangeIsFinancial({ ...base, status: from }, { status: to }), false, `N3: ${from} -> ${to}`)
  }
  assert.equal(attemptChangeIsFinancial({ ...base, status: 'paid' }, { status: 'paid' }), false, 'no change')
  assert.equal(attemptChangeIsFinancial({ ...base, amountReceivedCents: 5 }, { amountReceivedCents: 5 }), false, 'same amount')
})
test('E13: a refund operation of the order changes state', () => {
  assert.deepEqual(events({ note: 'x' }, { refundOperation: true }), ['E13'])
})

// ---- N1-N10: what does NOT count -----------------------------------------------------------------------------------------------------------------
test('N1-N10: the changes that are not financial facts leave the revision alone', () => {
  const none: Array<[string, Record<string, unknown>]> = [
    ['N1 charge, customer, receipt and invoice links', { stripeChargeId: 'ch_9', stripeCustomerId: 'cus_9', receiptUrl: '/r.pdf', receiptStatus: 'received', hostedInvoiceUrl: 'u', invoicePdfUrl: 'p' }],
    ['N2 synchronisation bookkeeping', { paymentSyncLeaseId: 'lease', paymentSyncLeaseUntil: new Date(), paymentSyncedAt: new Date() }],
    ['N4 production statuses and printer assignment', { status: 'printing', printerId: 'p1', printerAssignedAt: new Date(), printerAssignedBy: 'a' }],
    ['N4 failed', { status: 'failed', failedAt: new Date(), failureNote: 'x' }],
    ['N5 production markers', withMeta((m) => { m.printLabSubmissions.push({ id: 1 }); m.externalEffects.k = { state: 'confirmed' }; m.lastPrintLabSubmission = { x: 1 }; m.stockworksConsumedAt = 'x' })],
    ['N6 reprint, organisation approval, admin pricing, free checkout', withMeta((m) => { m.reprint.kind = 'x'; m.orgApproval.action = 'approve'; m.adminPricing = { by: 'a' }; m.adminFreeCheckout = true })],
    ['N7 guest fields', { guestAccessTokenHash: 'h2', guestAccessExpiresAt: new Date(), guestSessionHash: 'g' }],
    ['N8 contact and address', { shippingAddress: { line1: 'x' }, customerEmail: 'a@b.c', customerName: 'n', notes: 'n' }],
    ['N10 the grant of the authorization itself', withMeta((m) => { m.productionAuthorization = { authorized: true, by: 'b', at: 'now', financialRevision: 0, kind: 'exceptional' } })],
    ['Stripe bookkeeping inside metadata.stripe', withMeta((m) => { m.stripe.syncedAt = 'later'; m.stripe.lastEventType = 'b'; m.stripe.chargeId = 'ch'; m.stripe.receiptUrl = 'u' })],
    ['the Stripe record is rewritten with the same values', withMeta((m) => { m.stripe = { ...m.stripe } })],
    ['the same status again', { status: 'queued' }],
    ['the same payment status again', { paymentStatus: 'paid', totalCents: 2500, currency: 'EUR', refundedCents: 0 }],
    ['the same date again', { paidAt: new Date('2026-10-01T10:00:00Z') }],
    ['an increment of zero', { totalCents: { increment: 0 }, refundedCents: { decrement: 0 } }],
    ['the review log is rewritten with the same entries', withMeta((m) => { m.paymentReview = [...m.paymentReview] })],
  ]
  for (const [name, data] of none) {
    assert.deepEqual(events(data), [], name)
    assert.equal('financialRevision' in withFinancialRevision(prev, data), false, name)
  }
  assert.deepEqual(Object.keys(NON_EVENTS).sort(), ['N1', 'N10', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9'])
})

// ---- the mechanics -------------------------------------------------------------------------------------------------------------------------------
test('several events in one write give ONE increment of one (the counter counts writes that matter, not facts)', () => {
  const data = { paymentStatus: 'pending', refundedCents: 5, totalCents: 1, status: 'cancelled' }
  assert.deepEqual(events(data), ['E1', 'E3', 'E4', 'E14'])
  assert.deepEqual((withFinancialRevision(prev, data) as any).financialRevision, { increment: 1 })
})

test('the revision is never assigned: a writer that sets it (instead of incrementing through the helper) is refused', () => {
  assert.throws(() => withFinancialRevision(prev, { paymentStatus: 'pending', financialRevision: 5 }), /never assigned/)
  assert.throws(() => withFinancialRevision(prev, { financialRevision: { increment: 1 } }), /never assigned/)
})

test('a previous value the writer did not tell us counts as changed (never a missed event)', () => {
  assert.deepEqual(financialEvents({}, { paymentStatus: 'paid' }), ['E1'])
  assert.deepEqual(financialEvents({}, { refundedCents: 0 }), ['E3'])
  assert.deepEqual(financialEvents({ metadata: undefined }, { metadata: { stripe: { paymentStatus: 'paid' } } }), ['E7'])
  assert.deepEqual(financialEvents({}, { status: 'queued' }), ['E14'], 'a status written without the previous one could be a re-opening')
  assert.deepEqual(financialEvents({ status: 'queued' }, { status: 'printing' }), [])
})

test('the metadata can be wiped (null / Prisma.JsonNull): every financial key that was there is gone, and that counts', () => {
  const wiped = financialEvents(prev, { metadata: null })
  for (const code of ['E7', 'E8', 'E9', 'E10', 'E11'] as const) assert.ok(wiped.includes(code), code)
  assert.deepEqual(financialEvents({ ...prev, metadata: { note: 'x' } }, { metadata: null }), [], 'nothing financial was there')
})

test('a Prisma "set" operation is compared with the previous value', () => {
  assert.deepEqual(events({ paymentStatus: { set: 'paid' } }), [])
  assert.deepEqual(events({ paymentStatus: { set: 'pending' } }), ['E1'])
  assert.deepEqual(events({ status: { set: 'cancelled' } }), ['E14'])
  assert.deepEqual(events({ totalCents: { multiply: 2 } }), ['E4'], 'any other operation is counted')
})

// ---- the registry is closed and consistent -------------------------------------------------------------------------------------------------------
test('the registry: every column and metadata key maps to an event, and the facts the decision reads are classified', () => {
  assert.deepEqual([...FINANCIAL_COLUMNS].sort(), Object.keys(FINANCIAL_COLUMN_EVENTS).sort())
  for (const column of FINANCIAL_COLUMNS) assert.match(FINANCIAL_COLUMN_EVENTS[column], /^E\d+$/)
  for (const { event, path } of FINANCIAL_METADATA_PATHS) { assert.match(event, /^E\d+$/); assert.ok(path.length >= 1) }
  assert.deepEqual(classifyFactPath('refundedCents'), { kind: 'event', code: 'E3' })
  assert.deepEqual(classifyFactPath('metadata.stripe.paymentStatus'), { kind: 'event', code: 'E7' })
  assert.deepEqual(classifyFactPath('metadata.stripe.dispute.status'), { kind: 'event', code: 'E7' })
  assert.deepEqual(classifyFactPath('metadata.productionAuthorization.credit.amountDueCents'), { kind: 'authorization', code: 'N10' })
  assert.deepEqual(classifyFactPath('paymentAttempts[].expiresAt'), { kind: 'non_event', code: 'N3' })
  assert.deepEqual(classifyFactPath('refundOperations[].appliedAt'), { kind: 'event', code: 'E13' })
  assert.equal(classifyFactPath('financialRevision')?.kind, 'revision')
  assert.equal(classifyFactPath('stripeChargeId'), null, 'a column the decision does not read is not classified (it is N1: the oracle would flag a READ of it)')
  assert.equal(classifyFactPath('metadata.somethingNew.value'), null)
})
