// DR-13 / D10 — is this session THE session of this attempt? (lib/checkout-reconcile.ts, identifySession: pure.)
// Every check must hold; flipping any one of them refuses. Amount and currency are not checks of identity (the settlement closes a page that no longer matches the order).
import test from 'node:test'
import assert from 'node:assert/strict'
import { identifySession } from '../lib/checkout-reconcile'

const ATTEMPT = 'cattempt0000000000000001'
const ORDER = 'corder00000000000000001'
const SESSION = 'cs_test_a1B2c3'
const good = () => ({ id: SESSION, mode: 'payment' as const, metadata: { attemptId: ATTEMPT, orderId: ORDER }, client_reference_id: ORDER })
const ask = (over: Record<string, unknown> = {}, sessionId = SESSION, attemptId = ATTEMPT, orderId = ORDER) =>
  identifySession({ attemptId, orderId, sessionId, session: { ...good(), ...over } as any })

test('a session that names this attempt and this order, in payment mode, with the identifier that was asked for, is identified', () => {
  const r = ask()
  assert.equal(r.ok, true)
  assert.deepEqual(r.checks, { shape: true, sameId: true, paymentMode: true, namesAttempt: true, namesOrder: true, clientReference: true })
})

for (const [what, over, check] of [
  ['another attempt', { metadata: { attemptId: 'cother', orderId: ORDER } }, 'namesAttempt'],
  ['no attempt in the metadata', { metadata: { orderId: ORDER } }, 'namesAttempt'],
  ['another order in the metadata', { metadata: { attemptId: ATTEMPT, orderId: 'cother' } }, 'namesOrder'],
  ['no order in the metadata', { metadata: { attemptId: ATTEMPT } }, 'namesOrder'],
  ['no metadata at all', { metadata: null }, 'namesAttempt'],
  ['another client reference', { client_reference_id: 'cother' }, 'clientReference'],
  ['no client reference', { client_reference_id: null }, 'clientReference'],
  ['a session of another mode', { mode: 'subscription' }, 'paymentMode'],
  ['an answer for another identifier than the one asked about', { id: 'cs_test_other' }, 'sameId'],
] as Array<[string, Record<string, unknown>, string]>) {
  test(`not identified: ${what}`, () => {
    const r = ask(over)
    assert.equal(r.ok, false)
    assert.equal((r.checks as any)[check], false, `${check} must be the check that fails`)
  })
}

for (const bad of ['', 'cs', 'pi_123', 'cs_', 'cs_has space', 'cs_x/../y', 'CS_test_a', `cs_${'a'.repeat(300)}`]) {
  test(`not identified: "${bad.slice(0, 24)}" is not the identifier of a session`, () => {
    const r = ask({ id: bad }, bad)
    assert.equal(r.ok, false)
    assert.equal(r.checks.shape, false)
  })
}

test('an empty attempt or order id never matches an empty metadata value', () => {
  assert.equal(ask({ metadata: { attemptId: '', orderId: ORDER } }, SESSION, '', ORDER).ok, false)
  assert.equal(ask({ metadata: { attemptId: ATTEMPT, orderId: '' }, client_reference_id: '' }, SESSION, ATTEMPT, '').ok, false)
})

test('amount and currency are not part of identity: a page that no longer matches the order is still that attempt\'s page', () => {
  assert.equal(ask({ amount_total: 1, currency: 'usd' }).ok, true)
})
