// Step 4.6, S6a - the pure release rule after S6: the refund of the order's own payment (P2), the refund still in progress (P2c), the authorization that is valid only for the
// money situation it was given for (P2b), the commercial credit and the payment attested by an administrator (P6). No database, no network.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REFUND_OPERATION_STATUSES, authorizationStaleness, checkManualTransition, getProductionAuthorization, hasManualPaymentRecord, manualPaymentCovers, newOrderFacts,
  refundOperationBlocks, refundOperationBlocksWhere, releaseDecision, releaseFactsOf, verifiedPaymentBasis, withProductionAuthorization, type ReleaseFacts,
} from '../lib/order-payment-policy'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const AT = '2026-10-17T09:00:00Z'
const authorization = (over: Record<string, unknown> = {}) => ({ productionAuthorization: { authorized: true, by: 'admin_1', at: AT, reason: 'agreed with the customer', kind: 'exceptional', financialRevision: 0, ...over } })
const creditAuthorization = (over: Record<string, unknown> = {}) => authorization({
  kind: 'commercial_credit', credit: { method: 'invoice', reference: 'INV-7', amountDueCents: 12000, currency: 'EUR', dueAt: null }, ...over,
})
function facts(over: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return {
    paymentStatus: 'pending', paymentReviewReason: null, metadata: {}, totalCents: 2500, currency: 'EUR', paymentMethod: 'cash',
    stripePaymentIntentId: null, stripeInvoiceId: null, paidAt: null, refundedCents: 0, financialRevision: 0, paymentAttempts: [], refundOperations: [],
    ...over,
  }
}
const stripePaid = (over: Partial<ReleaseFacts> = {}) => facts({ paymentStatus: 'paid', paymentMethod: 'card', stripePaymentIntentId: 'pi_1', paidAt: new Date(NOW - 60_000), ...over })
const decide = (f: ReleaseFacts) => releaseDecision(f, { now: NOW })

// ======================================================================================================================================
// P2 - a refund of the order's own Stripe payment takes the payment proof away
// ======================================================================================================================================
test('P2 a refund of the order\'s own Stripe payment: the proof is gone, an administrator may authorize it again with a reason', () => {
  assert.equal(decide(stripePaid()).state, 'released')
  for (const refundedCents of [1, 500, 2499, 2500, 9999]) {
    const d = decide(stripePaid({ refundedCents }))
    assert.equal(d.released, false, `refunded ${refundedCents}`)
    assert.equal(d.state, 'payment_refunded')
    assert.equal(d.code, 'PAYMENT_REFUNDED')
    assert.equal(d.authorizable, true)
  }
  // a refund that was undone (the amount is back to 0) gives the proof back
  assert.equal(decide(stripePaid({ refundedCents: 0 })).basis, 'stripe_verified')
})

test('P2 only the Stripe proof decays: a payment attested by an administrator or a PayPal capture is not undone by a Stripe refund figure', () => {
  const manual = { manualPayment: { by: 'a', at: AT, reason: 'cash received', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR' } }
  assert.equal(decide(facts({ paymentStatus: 'paid', metadata: manual, refundedCents: 500 })).basis, 'manual_payment')
  assert.equal(decide(facts({ paymentStatus: 'paid', metadata: { paypal: { captureId: 'c1', paymentStatus: 'paid' } }, refundedCents: 500 })).basis, 'paypal_verified')
})

test('P2 an authorization given AFTER the refund releases the refunded order; one given before does not (the refund changed the revision)', () => {
  // the refund happened at revision 3; an authorization given at revision 3, after it, is valid
  const after = decide(stripePaid({ refundedCents: 500, financialRevision: 3, metadata: authorization({ financialRevision: 3 }) }))
  assert.equal(after.released, true)
  assert.equal(after.basis, 'admin_authorization')
  // an authorization given at revision 1 (before the payment and the refund) is not
  const before = decide(stripePaid({ refundedCents: 500, financialRevision: 3, metadata: authorization({ financialRevision: 1 }) }))
  assert.equal(before.released, false)
  assert.equal(before.state, 'payment_refunded')
  assert.equal(before.authorizationStale, 'revision_changed')
  assert.equal(before.authorizable, true)
})

// ======================================================================================================================================
// P2c - a refund that was requested from the application and is not over
// ======================================================================================================================================
const BLOCKING_NOW: Array<[string, boolean]> = [
  ['requested', true], ['sending', true], ['unknown', true], ['pending', true], ['requires_action', true], ['unresolved', true],
  ['succeeded', true], ['failed', true], ['canceled', true], // while the final state has not been read back and applied
  ['abandoned', false],
  ['something_nobody_knows', true], // fail closed
]
test('P2c which refund operations block: everything that is open, a finished one until its final state is applied, and any status nobody knows', () => {
  for (const [status, blocksWhenNotApplied] of BLOCKING_NOW) {
    assert.equal(refundOperationBlocks({ status, appliedAt: null }), blocksWhenNotApplied, `${status} not applied`)
  }
  for (const status of ['succeeded', 'failed', 'canceled']) assert.equal(refundOperationBlocks({ status, appliedAt: new Date(NOW) }), false, `${status} applied`)
  for (const status of ['requested', 'sending', 'unknown', 'pending', 'requires_action', 'unresolved']) {
    assert.equal(refundOperationBlocks({ status, appliedAt: new Date(NOW) }), true, `${status} blocks even with an appliedAt: only a finished one can be applied`)
  }
  assert.equal(refundOperationBlocks({ status: 'abandoned', appliedAt: null }), false)
  assert.equal(refundOperationBlocks({ status: 'succeeded', appliedAt: undefined }), true)
  assert.deepEqual([...REFUND_OPERATION_STATUSES].sort(), ['abandoned', 'canceled', 'failed', 'pending', 'requested', 'requires_action', 'sending', 'succeeded', 'unknown', 'unresolved'])
})

// A tiny interpreter of the one shape `refundOperationBlocksWhere` has, so that the Prisma filter and the function are proved to say the same thing (the database check is
// tests/security/production-release-parity.sec.ts)
function evaluateWhere(where: any, row: { status: string; appliedAt: Date | null }): boolean {
  if (where.OR) return where.OR.some((branch: any) => evaluateWhere(branch, row))
  let ok = true
  if (where.status?.in) ok = ok && where.status.in.includes(row.status)
  if (where.status?.notIn) ok = ok && !where.status.notIn.includes(row.status)
  if ('appliedAt' in where) ok = ok && (where.appliedAt === null ? row.appliedAt === null : row.appliedAt !== null)
  return ok
}
test('P2c the Prisma filter and the function agree on every status, applied or not', () => {
  for (const status of [...REFUND_OPERATION_STATUSES, 'something_nobody_knows', '']) {
    for (const appliedAt of [null, new Date(NOW)]) {
      assert.equal(evaluateWhere(refundOperationBlocksWhere, { status, appliedAt }), refundOperationBlocks({ status, appliedAt }), `${status}/${appliedAt ? 'applied' : 'not applied'}`)
    }
  }
})

test('P2c a refund in progress: not released, NOT authorizable, whatever proof, authorization or credit the order has', () => {
  const open = [{ status: 'unknown', appliedAt: null }]
  for (const order of [
    stripePaid({ refundOperations: open }),
    facts({ metadata: authorization(), refundOperations: open }),
    facts({ paymentMethod: 'invoice', metadata: creditAuthorization(), refundOperations: open }),
    facts({ paymentReviewReason: 'external_order', metadata: authorization(), refundOperations: open }),
    facts({ paymentStatus: 'free', totalCents: 0, refundOperations: open }),
    facts({ paymentStatus: 'paid', metadata: { manualPayment: { by: 'a', at: AT, reason: 'cash received', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR' } }, refundOperations: open }),
  ]) {
    const d = decide(order)
    assert.equal(d.released, false)
    assert.equal(d.state, 'payment_refund_pending')
    assert.equal(d.code, 'REFUND_IN_PROGRESS')
    assert.equal(d.authorizable, false)
    assert.ok(d.message.length > 40)
  }
})

test('P2c a refund in progress yields to a payment hold (the person who looks at the hold sees the hold first), and an abandoned or applied one does not block', () => {
  const open = [{ status: 'sending', appliedAt: null }]
  assert.equal(decide(stripePaid({ paymentReviewReason: 'dispute', refundOperations: open })).state, 'payment_hold')
  assert.equal(decide(facts({ paymentReviewReason: 'external_order', metadata: { paymentReview: [{ reason: 'duplicate_payment' }] }, refundOperations: open })).state, 'payment_hold')
  assert.equal(decide(stripePaid({ refundOperations: [{ status: 'abandoned', appliedAt: null }] })).state, 'released')
  assert.equal(decide(stripePaid({ refundOperations: [{ status: 'failed', appliedAt: new Date(NOW) }] })).state, 'released', 'a refund that failed and was applied: the money never left')
  assert.equal(decide(stripePaid({ refundOperations: [{ status: 'succeeded', appliedAt: new Date(NOW) }], refundedCents: 2500 })).state, 'payment_refunded', 'applied: the refunded amount decides now')
})

test('P2c the refund-in-progress state is never authorizable: checkManualTransition refuses it with the code, even with a reason', () => {
  const order = stripePaid({ refundOperations: [{ status: 'pending', appliedAt: null }] })
  const result = checkManualTransition(order, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'the customer asked us to go ahead', now: NOW })
  assert.equal(result.allowed, false)
  assert.equal((result as any).code, 'REFUND_IN_PROGRESS')
  assert.equal((result as any).metadata, undefined)
})

// ======================================================================================================================================
// P2b - an authorization is valid only for the money situation it was given for
// ======================================================================================================================================
test('P2b the authorization is valid only while the order has the revision it had when it was given', () => {
  assert.equal(decide(facts({ financialRevision: 4, metadata: authorization({ financialRevision: 4 }) })).basis, 'admin_authorization')
  for (const [revision, why] of [[3, 'revision_changed'], [5, 'revision_changed'], [0, 'revision_changed']] as const) {
    const d = decide(facts({ financialRevision: 4, metadata: authorization({ financialRevision: revision }) }))
    assert.equal(d.released, false, `given at ${revision}, order at 4`)
    assert.equal(d.state, 'payment_pending')
    assert.equal(d.authorizable, true, 'a NEW explicit decision with a reason is possible')
    assert.equal(d.authorizationStale, why)
    assert.match(d.message, /no longer valid/)
  }
})

test('P2b an authorization with no revision, a revision of the wrong type, or a negative one, is "no revision": never valid', () => {
  for (const financialRevision of [undefined, null, '0', 0.5, -1, NaN, Infinity, {}, [0], true]) {
    const metadata = authorization({ financialRevision })
    const d = decide(facts({ financialRevision: 0, metadata }))
    assert.equal(d.released, false, `revision ${String(financialRevision)}`)
    assert.equal(d.authorizationStale, 'no_revision', `revision ${String(financialRevision)}`)
  }
  const legacy = { productionAuthorization: { authorized: true, by: 'admin_1', at: AT, reason: 'from before S6' } }
  assert.equal(decide(facts({ metadata: legacy })).authorizationStale, 'no_revision')
  assert.equal(decide(facts({ financialRevision: null, metadata: authorization({ financialRevision: 0 }) })).released, false, 'an order whose own revision is unreadable')
  assert.equal(decide(facts({ financialRevision: undefined, metadata: authorization({ financialRevision: 0 }) })).released, false)
  assert.equal(authorizationStaleness(getProductionAuthorization(authorization({ financialRevision: 2 }))!, 2), null)
})

test('P2b the old A-B-A problem: values that go away and come back do not bring an old authorization back, because the revision only goes up', () => {
  const grantedAt = facts({ financialRevision: 0, metadata: authorization({ financialRevision: 0 }) })
  assert.equal(decide(grantedAt).released, true)
  // a refund was requested (revision 1), failed (revision 2): refundedCents and the total are exactly what they were
  const backToTheSameValues = facts({ financialRevision: 2, metadata: authorization({ financialRevision: 0 }), refundedCents: 0 })
  assert.equal(decide(backToTheSameValues).released, false)
  assert.equal(decide(backToTheSameValues).authorizationStale, 'revision_changed')
})

test('P2b an outside order: a stale authorization leaves it waiting for a new one; a hold is still a hold (and says the authorization is stale)', () => {
  const external = decide(facts({ paymentReviewReason: 'external_order', financialRevision: 2, metadata: authorization({ financialRevision: 0 }) }))
  assert.equal(external.state, 'external_review')
  assert.equal(external.authorizable, true)
  assert.equal(external.authorizationStale, 'revision_changed')
  const held = decide(facts({ paymentReviewReason: 'dispute', financialRevision: 2, metadata: authorization({ financialRevision: 0 }) }))
  assert.equal(held.state, 'payment_hold')
  assert.equal(held.authorizable, false)
  assert.equal(held.authorizationStale, 'revision_changed')
})

test('P2b a grant records the revision the order has and the facts it was given for; the grant itself does not change them', () => {
  const order = facts({ financialRevision: 7, totalCents: 4200, currency: 'eur', refundedCents: 0 })
  const result = checkManualTransition(order, 'queued', { adminId: 'admin_9', authorizeUnpaid: true, reason: 'agreed by phone, pays on pickup', now: NOW })
  assert.equal(result.allowed, true)
  const record = (result as any).metadata.productionAuthorization
  assert.equal(record.financialRevision, 7)
  assert.equal(record.kind, 'exceptional')
  assert.equal(record.by, 'admin_9')
  assert.deepEqual(record.financialFacts, { refundedCents: 0, totalCents: 4200, currency: 'eur', proofBasis: null })
  // the order is released by it at the same revision...
  assert.equal(decide({ ...order, metadata: (result as any).metadata }).basis, 'admin_authorization')
  // ...and not any more one revision later
  assert.equal(decide({ ...order, financialRevision: 8, metadata: (result as any).metadata }).released, false)
  // an order whose revision is unreadable records 0 (the order will then be at 0 or the grant is invalid at the next read: fail closed either way)
  const unreadable = checkManualTransition(facts({ financialRevision: null }), 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'agreed by phone, pays on pickup', now: NOW })
  assert.equal(((unreadable as any).metadata.productionAuthorization).financialRevision, 0)
})

// ======================================================================================================================================
// P6 - the reason, the kinds of authorization, the commercial credit, the payment attested by an administrator
// ======================================================================================================================================
test('P6 every authorization needs a written reason of at least 10 characters', () => {
  for (const reason of [undefined, null, '', '   ', 'ok', 'too short']) {
    const result = checkManualTransition(facts(), 'queued', { adminId: 'a', authorizeUnpaid: true, reason, now: NOW })
    assert.equal(result.allowed, false, `reason ${JSON.stringify(reason)}`)
    assert.equal((result as any).code, 'REASON_REQUIRED')
    assert.equal((result as any).httpStatus, 400)
    assert.equal((result as any).metadata, undefined)
  }
  assert.equal(checkManualTransition(facts(), 'queued', { adminId: 'a', authorizeUnpaid: true, reason: '  ten chars!', now: NOW }).allowed, true)
  // a released order needs no authorization, so no reason either
  assert.equal(checkManualTransition(stripePaid(), 'queued', { adminId: 'a', authorizeUnpaid: true, now: NOW }).allowed, true)
})

test('P6 the two kinds of authorization are not interchangeable (an outside order is authorized as it is)', () => {
  const invoice = facts({ paymentMethod: 'invoice', totalCents: 12000 })
  const exceptionalOnInvoice = checkManualTransition(invoice, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'agreed 30 days, trusted', now: NOW })
  assert.equal((exceptionalOnInvoice as any).code, 'CREDIT_KIND_MISMATCH')
  const creditOnCash = checkManualTransition(facts({ paymentMethod: 'cash' }), 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'agreed 30 days, trusted', kind: 'commercial_credit', creditReference: 'INV-1', now: NOW })
  assert.equal((creditOnCash as any).code, 'CREDIT_KIND_MISMATCH')
  const external = facts({ paymentMethod: 'invoice', paymentReviewReason: 'external_order' })
  assert.equal(checkManualTransition(external, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'checked with the sender', now: NOW }).allowed, true)
})

test('P6 a commercial credit: the amount due comes from the server, the reference is required, the payment status is not touched, and the due amount is in the decision', () => {
  const order = facts({ paymentMethod: 'po', totalCents: 12000, currency: 'eur' })
  for (const creditReference of [undefined, '', '   ', 'x'.repeat(121)]) {
    const refused = checkManualTransition(order, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'purchase order received', kind: 'commercial_credit', creditReference, now: NOW })
    assert.equal((refused as any).code, 'CREDIT_REFERENCE_REQUIRED', String(creditReference))
  }
  const ok = checkManualTransition(order, 'queued', { adminId: 'a', authorizeUnpaid: true, reason: 'purchase order received', kind: 'commercial_credit', creditReference: ' PO-77 ', creditDueAt: '2026-11-30', now: NOW })
  assert.equal(ok.allowed, true)
  const record = (ok as any).metadata.productionAuthorization
  assert.equal(record.kind, 'commercial_credit')
  assert.deepEqual(record.credit, { method: 'po', reference: 'PO-77', amountDueCents: 12000, currency: 'EUR', dueAt: '2026-11-30' })
  const d = decide({ ...order, metadata: (ok as any).metadata })
  assert.equal(d.released, true)
  assert.equal(d.basis, 'commercial_credit')
  assert.equal(d.credit?.amountDueCents, 12000)
  assert.equal(order.paymentStatus, 'pending', 'a credit is not a payment')
  // when the money arrives the basis becomes the payment and the amount due is gone
  const paid = decide({ ...order, paymentStatus: 'paid', metadata: { ...(ok as any).metadata, ...{ manualPayment: { by: 'a', at: AT, reason: 'bank transfer', method: 'po', receivedVia: 'bank_transfer', reference: 'CRO 1', amountCents: 12000, currency: 'EUR' } } } })
  assert.equal(paid.basis, 'manual_payment')
  assert.equal(paid.credit, null)
})

test('P6 a commercial credit record without its amount due is not an authorization at all', () => {
  for (const credit of [undefined, null, 'x', {}, { method: 'invoice', amountDueCents: 'many', currency: 'EUR' }, { method: 'invoice', amountDueCents: -5, currency: 'EUR' }, { method: 'invoice', amountDueCents: 1.5, currency: 'EUR' }, { amountDueCents: 5, currency: 'EUR' }, { method: 'invoice', amountDueCents: 5 }]) {
    const metadata = creditAuthorization({ credit })
    assert.equal(getProductionAuthorization(metadata), null, JSON.stringify(credit))
    assert.equal(decide(facts({ paymentMethod: 'invoice', metadata })).released, false, JSON.stringify(credit))
  }
})

test('P6 a payment attested by an administrator: complete, of a method that can be attested, for the order\'s amount and currency', () => {
  const record = (over: Record<string, unknown> = {}) => ({ manualPayment: { by: 'a', at: AT, reason: 'cash received', method: 'cash', receivedVia: 'cash', amountCents: 2500, currency: 'EUR', ...over } })
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['cash', record(), true],
    ['cash, more than the total', record({ amountCents: 3000 }), true],
    ['less than the total', record({ amountCents: 2499 }), false],
    ['another currency', record({ currency: 'USD' }), false],
    ['lower-case currency matches', record({ currency: 'eur' }), true],
    ['invoice paid by bank transfer with a reference', record({ method: 'invoice', receivedVia: 'bank_transfer', reference: 'CRO 1' }), true],
    ['invoice paid by bank transfer, no reference', record({ method: 'invoice', receivedVia: 'bank_transfer' }), false],
    ['invoice paid in cash', record({ method: 'invoice', receivedVia: 'cash' }), true],
    ['po paid by bank transfer with a reference', record({ method: 'po', receivedVia: 'bank_transfer', reference: 'CRO 1' }), true],
    ['cash method received by bank transfer', record({ method: 'cash', receivedVia: 'bank_transfer', reference: 'CRO 1' }), false],
    ['paypal', record({ method: 'paypal' }), false],
    ['card', record({ method: 'card' }), false],
    ['unknown receipt method', record({ receivedVia: 'barter' }), false],
    ['no receipt method', record({ receivedVia: undefined }), false],
    ['no amount (a record from before S6)', record({ amountCents: undefined }), false],
    ['amount as text', record({ amountCents: '2500' }), false],
    ['fractional amount', record({ amountCents: 2500.5 }), false],
    ['negative amount', record({ amountCents: -1 }), false],
    ['no currency', record({ currency: undefined }), false],
    ['no-charge decision', record({ method: 'comped', receivedVia: 'none', amountCents: 0 }), true],
    ['no-charge with money', record({ method: 'comped', receivedVia: 'none', amountCents: 5 }), false],
    ['no-charge received in cash', record({ method: 'comped', receivedVia: 'cash', amountCents: 0 }), false],
  ]
  for (const [name, metadata, covers] of cases) {
    assert.equal(manualPaymentCovers(metadata, 2500, 'EUR'), covers, name)
    assert.equal(verifiedPaymentBasis(facts({ paymentStatus: 'paid', metadata })) === 'manual_payment', covers, `${name} (basis)`)
  }
  assert.equal(hasManualPaymentRecord(record({ amountCents: 1 })), true, 'complete in shape, whatever the total')
  assert.equal(manualPaymentCovers(record(), 2500, null), false, 'an order whose currency is unknown')
  assert.equal(manualPaymentCovers(record(), 2501, 'EUR'), false, 'the total grew after the registration')
})

// ======================================================================================================================================
// the facts of an order, however they are loaded
// ======================================================================================================================================
test('releaseFactsOf and newOrderFacts carry every field the decision reads', () => {
  const row = { paymentStatus: 'paid', paymentReviewReason: null, metadata: {}, totalCents: 10, currency: 'EUR', paymentMethod: 'card', stripePaymentIntentId: 'pi_1', stripeInvoiceId: null, paidAt: new Date(NOW), refundedCents: 3, financialRevision: 9 }
  const built = releaseFactsOf(row, { paymentAttempts: [{ status: 'paid' }], refundOperations: [{ status: 'pending', appliedAt: null }] })
  assert.equal(built.refundedCents, 3)
  assert.equal(built.financialRevision, 9)
  assert.equal(built.refundOperations.length, 1)
  const fresh = newOrderFacts({ paymentStatus: 'pending', totalCents: 500, paymentMethod: 'cash', currency: 'EUR' })
  assert.equal(fresh.financialRevision, 0)
  assert.equal(fresh.refundedCents, 0)
  assert.deepEqual(fresh.refundOperations, [])
  assert.equal(withProductionAuthorization({}, 'a', ' a reason that is long enough ', { financialRevision: 0 }).productionAuthorization !== undefined, true)
})
