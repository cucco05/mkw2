import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveInitialOrderStatus } from '../lib/orders'

// S5: an order enters the production queue ONLY with a verified payment (paid / free) or an explicit
// administrator authorization. The payment METHOD alone never decides it.

test('a verified card payment enters the production queue', () => {
  assert.equal(resolveInitialOrderStatus({
    amountCents: 1496, paymentMethod: 'card', shipping: { method: 'pickup' }, paymentStatus: 'paid',
  }), 'queued')
  assert.equal(resolveInitialOrderStatus({
    amountCents: 1496, paymentMethod: 'card', shipping: { method: 'ship' }, paymentStatus: 'succeeded',
  }), 'queued')
})

test('card payments that are not confirmed yet wait for payment', () => {
  for (const paymentStatus of ['processing', 'requires_capture', 'authorized', 'pending', 'failed', 'canceled', null, undefined]) {
    assert.equal(resolveInitialOrderStatus({
      amountCents: 1496, paymentMethod: 'card', shipping: { method: 'pickup' }, paymentStatus,
    }), 'awaiting_payment', `card/${String(paymentStatus)}`)
  }
})

test('cash, invoice and purchase-order orders wait for payment (cash pickup no longer skips the gate)', () => {
  for (const paymentMethod of ['cash', 'invoice', 'po'] as const) {
    for (const shipping of [{ method: 'pickup' as const }, { method: 'ship' as const }]) {
      assert.equal(resolveInitialOrderStatus({
        amountCents: 1496, paymentMethod, shipping, paymentStatus: 'pending',
      }), 'awaiting_payment', `${paymentMethod}/${shipping.method}`)
    }
  }
})

test('quote requests are never production orders', () => {
  assert.equal(resolveInitialOrderStatus({
    amountCents: 1496, paymentMethod: 'quote', shipping: { method: 'pickup' }, paymentStatus: 'quote',
  }), 'awaiting_review')
  // not even if the payment status were forged as paid
  assert.equal(resolveInitialOrderStatus({
    amountCents: 1496, paymentMethod: 'quote', shipping: { method: 'pickup' }, paymentStatus: 'paid',
  }), 'awaiting_review')
})

test('no-charge (free) orders and explicitly authorized orders enter production', () => {
  assert.equal(resolveInitialOrderStatus({
    amountCents: 0, paymentMethod: 'comped', shipping: { method: 'pickup' }, paymentStatus: 'free',
  }), 'queued')
  assert.equal(resolveInitialOrderStatus({
    amountCents: 1496, paymentMethod: 'cash', shipping: { method: 'pickup' }, paymentStatus: 'pending', productionAuthorized: true,
  }), 'queued')
})

test('a zero amount without a free/paid status does not enter production by itself', () => {
  assert.equal(resolveInitialOrderStatus({
    amountCents: 0, paymentMethod: 'cash', shipping: { method: 'pickup' }, paymentStatus: 'pending',
  }), 'awaiting_payment')
})
