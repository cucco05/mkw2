// DR-13 phase 4: when the end of a payment page may end the ORDER (lib/payment-verification.ts, mayCancelAfterExpiry). Pure.
//
// An order is cancelled because its last payment page ran out of time - never because a page was closed EARLY (an operator, or our own replacement of it: the provider announces that
// too, with `checkout.session.expired`, and the announcement can overtake the very request that is opening the next page), and never while something could still bring a payment or while
// something about the order cannot be proved (a reservation of any age, a row that was closed without proof).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mayCancelAfterExpiry, NATURAL_EXPIRY_TOLERANCE_MS } from '../lib/payment-verification'

const NOW = new Date(Date.UTC(2026, 10, 4, 12, 0, 0))
const MIN = 60_000
const HOUR = 3_600_000
const at = (ms: number) => new Date(NOW.getTime() + ms)
const order = { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null as string | null }
type Row = { id: string; status: string; createdAt: Date; expiresAt: Date; stripeSessionId?: string | null; failureReason?: string | null }
const page = (id: string, expiresInMs: number, over: Partial<Row> = {}): Row => ({ id, status: 'open', createdAt: at(-30 * MIN), expiresAt: at(expiresInMs), stripeSessionId: `cs_${id}`, failureReason: null, ...over })
const may = (attempts: Row[], expired = 'a', o = order) => mayCancelAfterExpiry(o, attempts.map((x) => (x.id === expired ? { ...x, status: 'expired' } : x)), expired, { now: NOW })

test('a page that ran out of its time ends the order when nothing else could bring a payment', () => {
  assert.equal(may([page('a', -MIN)]), true)
  assert.equal(may([page('a', -MIN), page('b', -2 * HOUR, { status: 'expired', failureReason: 'provider_status:expired' })]), true)
  // (follow-up P0-B) a `failed` row with an identifier proves nothing about its page: only the provider's word does
  assert.equal(may([page('a', -MIN), page('b', -2 * HOUR, { status: 'failed', failureReason: 'payment_failed' })]), false)
  assert.equal(may([page('a', -MIN), page('b', -2 * HOUR, { status: 'expired', failureReason: null })]), false)
  assert.equal(may([page('a', -MIN), page('b', -2 * HOUR, { status: 'failed', failureReason: 'closed_by_us:proved (was payment_failed)' })]), true)
  assert.equal(may([page('a', -MIN), page('b', -2 * HOUR, { status: 'failed', failureReason: 'session_mismatch:amount' })]), true)
})

test('a page closed EARLY does not end the order - the limits, to the millisecond', () => {
  assert.equal(NATURAL_EXPIRY_TOLERANCE_MS, 2000)
  assert.equal(may([page('a', 25 * MIN)]), false, 'closed 25 minutes before its end')
  assert.equal(may([page('a', 60_000)]), false, 'one minute early')
  assert.equal(may([page('a', NATURAL_EXPIRY_TOLERANCE_MS)]), true, 'within the tolerance of the provider\'s own clock')
  assert.equal(may([page('a', NATURAL_EXPIRY_TOLERANCE_MS + 1)]), false)
  assert.equal(may([page('a', 0)]), true)
  assert.equal(may([page('a', -1)]), true)
})

test('anything that could still bring a payment, or cannot be proved, keeps the order alive', () => {
  const expired = page('a', -MIN)
  for (const status of ['open', 'processing', 'paid', 'mismatch']) assert.equal(may([expired, page('b', 10 * MIN, { status })]), false, status)
  // a reservation, of ANY age: it may hold a page the database never learned about
  for (const age of [10_000, 5 * MIN, HOUR, 72 * HOUR]) assert.equal(may([expired, page('b', 10 * MIN, { status: 'creating', stripeSessionId: null, createdAt: at(-age) })]), false, `a reservation ${age} ms old`)
  // a row closed without proof: by the clock (the old rule), or with no identifier and no proof that nothing was created
  assert.equal(may([expired, page('b', -HOUR, { status: 'expired', failureReason: 'stale_reservation', stripeSessionId: null })]), false)
  assert.equal(may([expired, page('b', -HOUR, { status: 'failed', failureReason: 'StripeInvalidRequestError:x', stripeSessionId: null })]), false)
  assert.equal(may([expired, page('b', -HOUR, { status: 'failed', failureReason: 'local_refusal:lines', stripeSessionId: null })]), true, 'a refusal made here proves nothing was sent')
})

test('an order that is paid, being confirmed, not waiting for payment or under review is never cancelled by an expiry; neither is a page that is not in the list or has no readable time', () => {
  for (const o of [{ ...order, paymentStatus: 'paid' }, { ...order, paymentStatus: 'free' }, { ...order, paymentStatus: 'processing' }, { ...order, status: 'queued' }, { ...order, status: 'cancelled' }, { ...order, paymentReviewReason: 'amount' }]) {
    assert.equal(may([page('a', -MIN)], 'a', o), false, JSON.stringify(o))
  }
  assert.equal(mayCancelAfterExpiry(order, [page('b', -MIN)], 'a', { now: NOW }), false)
  assert.equal(may([{ ...page('a', -MIN), expiresAt: new Date(Number.NaN) }]), false)
  const now = Date.now()
  assert.equal(mayCancelAfterExpiry(order, [{ ...page('a', 0), expiresAt: new Date(now - MIN), status: 'expired' }], 'a'), true, 'the clock of the process is used when none is given')
  assert.equal(mayCancelAfterExpiry(order, [{ ...page('a', 0), expiresAt: new Date(now + 20 * MIN), status: 'expired' }], 'a'), false, 'and a page that is 20 minutes from its end is not over')
})
