// Step 4.5 - an order whose payment WAS being confirmed returns to "waiting for its payment" when Stripe, asked by the server, shows that no money is moving
// (lib/payment-verification.ts, decidePaymentUpdate). Without that it would stay "confirming" for ever, and since the 72-hour window of the checkout guard is
// gone it would block the same cart for ever. Pure functions: no database, no network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { decidePaymentUpdate, type OrderPaymentState, type PaymentVerdict } from '../lib/payment-verification'

const hosted = (over: Partial<OrderPaymentState> = {}): OrderPaymentState => ({ status: 'awaiting_payment', paymentStatus: 'processing', paymentReviewReason: null, stripePaymentIntentId: null, hosted: true, ...over })
const canceled: PaymentVerdict = { outcome: 'canceled', paymentIntentId: 'pi_1' }
const failed = (stripeStatus: string): PaymentVerdict => ({ outcome: 'unpaid', paymentIntentId: 'pi_1', stripeStatus })
const expired: PaymentVerdict = { outcome: 'expired', paymentIntentId: null }

test('a payment that was being confirmed and was canceled: the order waits for its payment again, the attempt failed', () => {
  const d = decidePaymentUpdate(hosted(), canceled, { processingEnded: true })
  assert.equal(d.paymentStatus, 'pending')
  assert.equal(d.attemptStatus, 'failed')
  assert.equal(d.release, false)
  assert.equal(d.paidNow, false)
  assert.equal(d.review, null)
})

test('a payment that was being confirmed and failed (the customer can try again): the same', () => {
  for (const stripeStatus of ['requires_payment_method', 'requires_confirmation', 'requires_action']) {
    const d = decidePaymentUpdate(hosted(), failed(stripeStatus), { processingEnded: true })
    assert.equal(d.paymentStatus, 'pending', stripeStatus)
    assert.equal(d.attemptStatus, 'failed', stripeStatus)
  }
})

test('an expired payment page, believed only when no money is moving on it, ends the confirmation too', () => {
  const d = decidePaymentUpdate(hosted(), expired, { processingEnded: true })
  assert.equal(d.paymentStatus, 'pending')
  assert.equal(d.attemptStatus, 'expired')
})

test('NOT ended: the caller did not say so (another attempt may still bring money, or this was not the attempt being confirmed)', () => {
  for (const verdict of [canceled, failed('requires_payment_method'), expired]) {
    for (const extras of [{}, { processingEnded: false }]) {
      const d = decidePaymentUpdate(hosted(), verdict, extras)
      assert.equal(d.paymentStatus, null, `${verdict.outcome} ${JSON.stringify(extras)}: the order is left as it is`)
    }
  }
})

test('NOT ended: a payment page that is merely open, or a payment that is still being processed, says nothing about the money', () => {
  assert.equal(decidePaymentUpdate(hosted(), failed('open'), { processingEnded: true }).paymentStatus, null, 'an open page')
  assert.equal(decidePaymentUpdate(hosted(), failed('processing'), { processingEnded: true }).paymentStatus, null, 'processing')
  assert.equal(decidePaymentUpdate(hosted(), failed('requires_capture'), { processingEnded: true }).paymentStatus, null, 'money reserved')
  const processing = decidePaymentUpdate(hosted(), { outcome: 'processing', paymentIntentId: 'pi_1' }, { processingEnded: true })
  assert.equal(processing.paymentStatus, 'processing')
  const authorized = decidePaymentUpdate(hosted(), { outcome: 'authorized', paymentIntentId: 'pi_1' }, { processingEnded: true })
  assert.equal(authorized.paymentStatus, 'processing')
})

test('NOT ended: an order that is paid, cancelled, or not being confirmed is not touched', () => {
  assert.equal(decidePaymentUpdate(hosted({ paymentStatus: 'paid' }), canceled, { processingEnded: true }).paymentStatus, null, 'paid stays paid (a person is told)')
  assert.equal(decidePaymentUpdate(hosted({ paymentStatus: 'paid' }), expired, { processingEnded: true }).paymentStatus, null)
  assert.equal(decidePaymentUpdate(hosted({ status: 'cancelled' }), canceled, { processingEnded: true }).paymentStatus, null)
  assert.equal(decidePaymentUpdate(hosted({ status: 'cancelled' }), expired, { processingEnded: true }).paymentStatus, null)
  assert.equal(decidePaymentUpdate(hosted({ paymentStatus: 'pending' }), canceled, { processingEnded: true }).paymentStatus, null, 'it was not being confirmed')
  assert.equal(decidePaymentUpdate(hosted({ paymentStatus: 'pending' }), expired, { processingEnded: true }).paymentStatus, null)
})

test('NOT ended: an order of the old flow keeps its old behaviour', () => {
  const legacy = decidePaymentUpdate(hosted({ hosted: false }), canceled, { processingEnded: true })
  assert.equal(legacy.paymentStatus, 'canceled')
  assert.equal(legacy.attemptStatus, null)
})

test('a payment that arrives paid is unaffected', () => {
  const d = decidePaymentUpdate(hosted({ paymentStatus: 'processing' }), { outcome: 'paid', paymentIntentId: 'pi_1', amountReceivedCents: 1000 }, { processingEnded: true })
  assert.equal(d.paymentStatus, 'paid')
  assert.equal(d.paidNow, true)
})
