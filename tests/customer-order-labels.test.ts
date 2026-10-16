// Step 4.3 – how the customer area describes an order: an unpaid order is not "Queued", an abandoned one goes to the history, money is never hidden.
import assert from 'node:assert/strict'
import test from 'node:test'
import { CUSTOMER_ORDER_COPY, describeCustomerOrder, isAbandonedExpiredOrder, splitOrdersForCustomer, type CustomerOrderLike } from '../lib/customer-order-labels'

const expired = { reason: 'checkout_expired', at: '2026-10-01T10:00:00.000Z' }
const order = (over: Partial<CustomerOrderLike> = {}): CustomerOrderLike => ({ status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, paidAt: null, metadata: null, ...over })

test('what an order is called depends on the payment, not only on its production status', () => {
  const cases: Array<[string, CustomerOrderLike, ReturnType<typeof describeCustomerOrder>]> = [
    ['created, not paid', order(), 'awaiting_payment'],
    ['payment being confirmed', order({ paymentStatus: 'processing' }), 'confirming'],
    ['paid and released', order({ status: 'queued', paymentStatus: 'paid', paidAt: new Date() }), 'production'],
    ['paid and printing', order({ status: 'printing', paymentStatus: 'paid', paidAt: new Date() }), 'production'],
    ['no-charge order', order({ status: 'queued', paymentStatus: 'free' }), 'production'],
    ['paid, held for a person', order({ status: 'awaiting_review', paymentStatus: 'paid', paidAt: new Date() }), 'under_review'],
    ['paid, flagged', order({ status: 'queued', paymentStatus: 'paid', paymentReviewReason: 'shipping_country' }), 'under_review'],
    ['payment to check (wrong amount)', order({ paymentReviewReason: 'amount' }), 'under_review'],
    ['closed after the payment page expired', order({ status: 'cancelled', paymentStatus: 'canceled', metadata: { cancellation: expired } }), 'closed_unpaid'],
    ['money arrived after the cancellation', order({ status: 'cancelled', paymentStatus: 'paid', paidAt: new Date(), paymentReviewReason: 'paid_after_cancel', metadata: { cancellation: expired } }), 'under_review'],
    ['cancelled by the shop (no expiry marker)', order({ status: 'cancelled', paymentStatus: 'canceled' }), 'production'],
    ['a quote request (manual)', order({ status: 'awaiting_review', paymentStatus: 'quote', metadata: { manualQuote: { priceStatus: 'to_be_quoted' } } }), 'quote_requested'],
    ['a reprint request', order({ status: 'awaiting_review', paymentStatus: 'quote', metadata: { reprint: { priceStatus: 'to_be_quoted' } } }), 'quote_requested'],
    ['an old order, shipped', order({ status: 'shipped', paymentStatus: 'paid' }), 'production'],
    ['an old order without payment data, completed', order({ status: 'completed', paymentStatus: null }), 'production'],
  ]
  for (const [name, input, expected] of cases) assert.equal(describeCustomerOrder(input), expected, name)
})

test('an unpaid order is never shown as "Queued"', () => {
  for (const kind of ['awaiting_payment', 'confirming', 'closed_unpaid'] as const) assert.doesNotMatch(CUSTOMER_ORDER_COPY[kind].label, /queued/i)
  for (const [kind, copy] of Object.entries(CUSTOMER_ORDER_COPY)) {
    assert.ok(copy.label.length > 3 && copy.message.length > 30, kind)
    assert.doesNotMatch(copy.message, /review reason|stripe|payment_intent|pi_|cs_/i, `${kind} does not reveal why or any identifier`)
  }
})

test('only an order left unpaid until the payment page expired goes to the history - never one with money or a doubt', () => {
  const abandoned = order({ status: 'cancelled', paymentStatus: 'canceled', metadata: { cancellation: expired } })
  assert.equal(isAbandonedExpiredOrder(abandoned), true)
  const notAbandoned: Array<[string, CustomerOrderLike]> = [
    ['still waiting for payment', order()],
    ['cancelled by the shop', order({ status: 'cancelled', paymentStatus: 'canceled', metadata: { cancellation: { reason: 'admin' } } })],
    ['cancelled, no reason recorded', order({ status: 'cancelled', paymentStatus: 'canceled', metadata: {} })],
    ['paid after the expiry', { ...abandoned, paymentStatus: 'paid' }],
    ['paidAt set', { ...abandoned, paidAt: new Date() }],
    ['a payment under check', { ...abandoned, paymentReviewReason: 'paid_after_cancel' }],
    ['payment still being processed', { ...abandoned, paymentStatus: 'processing' }],
    ['no-charge order', { ...abandoned, paymentStatus: 'free' }],
    ['metadata of another shape', { ...abandoned, metadata: { cancellation: 'checkout_expired' } }],
    ['metadata an array', { ...abandoned, metadata: [{ cancellation: expired }] }],
  ]
  for (const [name, input] of notAbandoned) assert.equal(isAbandonedExpiredOrder(input), false, name)
})

test('the list keeps everything except the abandoned orders, in the same order, and the history holds only those', () => {
  const a = order({ status: 'queued', paymentStatus: 'paid' })
  const b = order({ status: 'cancelled', paymentStatus: 'canceled', metadata: { cancellation: expired } })
  const c = order()
  const d = order({ status: 'cancelled', paymentStatus: 'paid', paidAt: new Date(), paymentReviewReason: 'paid_after_cancel', metadata: { cancellation: expired } })
  const { current, history } = splitOrdersForCustomer([a, b, c, d])
  assert.deepEqual(current, [a, c, d])
  assert.deepEqual(history, [b])
  assert.deepEqual(splitOrdersForCustomer([]), { current: [], history: [] })
})
