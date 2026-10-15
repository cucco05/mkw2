// Step 4.1 – the pure rules behind the order status (lib/checkout-status.ts) and the wording of the new payment pages (lib/checkout-copy.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canViewOrder, derivePublicState, ORDER_ID_PATTERN, refreshableAttempt, toPublicStatus,
  type PublicCheckoutState, type StatusOrder,
} from '../lib/checkout-status'
import { CHECKOUT_ACTIONS, CHECKOUT_STATE_COPY, formatOrderNumber, supportLine } from '../lib/checkout-copy'
import { issueGuestAccess, mergeGuestAccessCookie } from '../lib/guest-order-access'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-0123456789abcdefghij'

const base = { status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null as string | null }

test('state: every combination of order and attempt maps to one of five states, and "paid" only comes from a verified payment', () => {
  const cases: Array<[string, Parameters<typeof derivePublicState>[0], Parameters<typeof derivePublicState>[1], Parameters<typeof derivePublicState>[2], PublicCheckoutState]> = [
    ['nothing paid, page open', base, { status: 'open' }, {}, 'pending'],
    ['no attempt at all', base, null, {}, 'pending'],
    ['expired page, order still open', base, { status: 'expired' }, {}, 'pending'],
    ['payment processing (order)', { ...base, paymentStatus: 'processing' }, { status: 'open' }, {}, 'confirming'],
    ['payment processing (attempt)', base, { status: 'processing' }, {}, 'confirming'],
    ['paid and released', { status: 'queued', paymentStatus: 'paid', paymentReviewReason: null }, { status: 'paid' }, {}, 'paid'],
    ['paid and already printing', { status: 'printing', paymentStatus: 'paid', paymentReviewReason: null }, { status: 'paid' }, {}, 'paid'],
    ['paid, flagged for a person', { status: 'queued', paymentStatus: 'paid', paymentReviewReason: 'dispute' }, { status: 'paid' }, {}, 'attention'],
    ['paid, held for review (delivery)', { status: 'awaiting_review', paymentStatus: 'paid', paymentReviewReason: 'shipping_country' }, { status: 'paid' }, {}, 'attention'],
    ['wrong amount (nothing paid)', { ...base, paymentReviewReason: 'amount' }, { status: 'mismatch' }, {}, 'attention'],
    ['mismatch attempt only', base, { status: 'mismatch' }, {}, 'attention'],
    ['flagged for a person, payment page still open', { ...base, paymentReviewReason: 'currency' }, { status: 'open' }, {}, 'attention'],
    ['closed after expiry', { status: 'cancelled', paymentStatus: 'canceled', paymentReviewReason: null }, { status: 'expired' }, {}, 'canceled'],
    ['money arrived for a cancelled order', { status: 'cancelled', paymentStatus: 'paid', paymentReviewReason: 'paid_after_cancel' }, { status: 'paid' }, {}, 'attention'],
    ['no-charge order', { status: 'queued', paymentStatus: 'free', paymentReviewReason: null }, null, {}, 'paid'],
  ]
  for (const [name, order, attempt, opts, expected] of cases) assert.equal(derivePublicState(order, attempt, opts), expected, name)
})

test('the browser saying "I am back" only softens "not paid" into "confirming" when Stripe could not be asked; it never makes "paid"', () => {
  assert.equal(derivePublicState(base, { status: 'open' }, { returned: true }), 'pending', 'returned but Stripe was asked and says not paid')
  assert.equal(derivePublicState(base, { status: 'open' }, { returned: true, unverified: true }), 'confirming')
  assert.equal(derivePublicState(base, { status: 'open' }, { returned: false, unverified: true }), 'pending', 'a visitor who did not come from the payment page is not told we are confirming')
  for (const returned of [true, false]) for (const unverified of [true, false]) {
    assert.notEqual(derivePublicState(base, { status: 'open' }, { returned, unverified }), 'paid')
    assert.notEqual(derivePublicState({ ...base, paymentReviewReason: 'amount' }, { status: 'mismatch' }, { returned, unverified }), 'paid')
  }
})

test('public status: only what is safe to show, and when to ask again', () => {
  const order = { orderNumber: 17, totalCents: 1234, currency: 'EUR' } as StatusOrder
  assert.deepEqual(toPublicStatus(order, 'confirming'), { orderNumber: 17, state: 'confirming', totalCents: 1234, currency: 'EUR', final: false, pollAfterMs: 2500 })
  assert.deepEqual(toPublicStatus(order, 'paid'), { orderNumber: 17, state: 'paid', totalCents: 1234, currency: 'EUR', final: true, pollAfterMs: null })
  assert.equal(toPublicStatus(order, 'pending').final, false)
  assert.equal(toPublicStatus(order, 'attention').final, true)
  assert.equal(toPublicStatus(order, 'canceled').final, true)
})

test('who may see an order: the signed-in owner, or the guest holding that order\'s own token - nobody else', () => {
  const now = new Date('2026-10-20T10:00:00Z')
  const guest = issueGuestAccess('order_guest_0001', now)
  const guestOrder = { id: 'order_guest_0001', userId: null, guestAccessTokenHash: guest.hash, guestAccessExpiresAt: guest.expiresAt } as StatusOrder
  const accountOrder = { id: 'order_account_01', userId: 'user_1', guestAccessTokenHash: issueGuestAccess('order_account_01', now).hash, guestAccessExpiresAt: new Date(now.getTime() + 3600_000) } as StatusOrder
  const cookie = mergeGuestAccessCookie(null, 'order_guest_0001', guest.token)
  // guest order
  assert.equal(canViewOrder(guestOrder, null, cookie, now), true)
  assert.equal(canViewOrder(guestOrder, 'user_9', cookie, now), true, 'a signed-in person holding the cookie may see a guest order')
  assert.equal(canViewOrder(guestOrder, null, null, now), false)
  assert.equal(canViewOrder(guestOrder, 'user_1', null, now), false, 'being signed in is not access to a guest order')
  assert.equal(canViewOrder(guestOrder, null, mergeGuestAccessCookie(null, 'order_guest_0001', 'x'.repeat(43)), now), false, 'wrong token')
  assert.equal(canViewOrder(guestOrder, null, mergeGuestAccessCookie(null, 'order_other_0002', guest.token), now), false, 'token of another order')
  assert.equal(canViewOrder(guestOrder, null, cookie, new Date(guest.expiresAt.getTime() + 1)), false, 'expired')
  // account order
  assert.equal(canViewOrder(accountOrder, 'user_1', null, now), true)
  assert.equal(canViewOrder(accountOrder, 'user_2', null, now), false)
  assert.equal(canViewOrder(accountOrder, null, null, now), false)
  assert.equal(canViewOrder(accountOrder, null, mergeGuestAccessCookie(null, 'order_account_01', issueGuestAccess('order_account_01', now).token), now), false, 'a guest token never opens an account order')
})

test('asking Stripe again: only for an order still waiting, with a page that could have been paid, and not right after a read', () => {
  const now = new Date('2026-10-20T10:00:00Z')
  const attempts = [{ id: 'a2', status: 'expired', stripeSessionId: 'cs_2' }, { id: 'a1', status: 'open', stripeSessionId: 'cs_1' }]
  assert.equal(refreshableAttempt({ ...base, paymentSyncedAt: null }, attempts, now, 4000)?.id, 'a1')
  assert.equal(refreshableAttempt({ ...base, paymentSyncedAt: new Date(now.getTime() - 5000) }, attempts, now, 4000)?.id, 'a1')
  assert.equal(refreshableAttempt({ ...base, paymentSyncedAt: new Date(now.getTime() - 1000) }, attempts, now, 4000), null, 'read a moment ago')
  assert.equal(refreshableAttempt({ ...base, paymentStatus: 'paid', paymentSyncedAt: null }, attempts, now, 4000), null, 'already paid')
  assert.equal(refreshableAttempt({ ...base, status: 'cancelled', paymentSyncedAt: null }, attempts, now, 4000), null)
  assert.equal(refreshableAttempt({ ...base, paymentReviewReason: 'amount', paymentSyncedAt: null }, attempts, now, 4000), null, 'flagged orders are a person\'s')
  assert.equal(refreshableAttempt({ ...base, paymentSyncedAt: null }, [{ id: 'x', status: 'expired', stripeSessionId: 'cs_x' }, { id: 'y', status: 'creating', stripeSessionId: null }], now, 4000), null)
})

test('order id format', () => {
  for (const ok of ['cmv9lrnm80001yysn2d06pftv', 'order_guest_0001', 'A1b2C3d4']) assert.equal(ORDER_ID_PATTERN.test(ok), true, ok)
  for (const bad of ['', 'short', 'has space in it', 'a/b/c/d/e/f/g/h', 'x'.repeat(65), '../../etc/passwd', 'id;drop table', 'id\n12345678']) assert.equal(ORDER_ID_PATTERN.test(bad), false, JSON.stringify(bad))
})

test('wording: every state has Italian text; the neutral "unknown" text never promises recovery by registering and never leaks anything', () => {
  for (const state of ['pending', 'confirming', 'paid', 'attention', 'canceled', 'unknown'] as const) {
    const copy = CHECKOUT_STATE_COPY[state]
    assert.ok(copy.title.length > 5 && copy.message.length > 20, state)
    assert.doesNotMatch(`${copy.title} ${copy.message} ${copy.hint ?? ''}`, /pi_|cs_|ch_|€|undefined|\{|\}/, `${state}: no identifiers or placeholders in the wording`)
  }
  const unknown = CHECKOUT_STATE_COPY.unknown
  assert.doesNotMatch(`${unknown.title} ${unknown.message}`, /registrar|registrazione|iscriv|account|accedi|crea(re)? un/i, 'no promise that an account recovers the order')
  // "attention" says nothing about why
  assert.doesNotMatch(CHECKOUT_STATE_COPY.attention.message, /importo|valuta|spedizione|contestazione|errore/i)
  assert.match(supportLine('assistenza@example.test'), /assistenza@example\.test/)
  assert.match(supportLine('assistenza@example.test'), /verificheremo la tua identità/)
  assert.match(supportLine(null), /numero d'ordine/)
  assert.doesNotMatch(supportLine('assistenza@example.test'), /registrar|registrazione|iscriv|account|accedi/i)
  assert.equal(formatOrderNumber(7), 'MW-00007')
  assert.ok(Object.keys(CHECKOUT_ACTIONS).length >= 3)
})
