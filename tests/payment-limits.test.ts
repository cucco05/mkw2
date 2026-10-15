// Step 4.2-ter (A5): the shop's commercial minimum order and the payment provider's technical minimum are two separate things.
import assert from 'node:assert/strict'
import test from 'node:test'
import { commercialMinimumDecided, stripeMinimumChargeCents } from '../lib/payment-limits'
import { getCheckoutBlocker } from '../lib/checkout-guards'
import { buildEnvChecks } from '../app/api/admin/env-check/route'

test('Stripe\'s smallest charge: 50 minor units in every supported currency; an account with another limit can say so; nonsense is ignored', () => {
  for (const currency of ['USD', 'EUR', 'CAD', 'AUD'] as const) assert.equal(stripeMinimumChargeCents(currency, {}), 50, currency)
  assert.equal(stripeMinimumChargeCents('EUR', { STRIPE_MINIMUM_CHARGE_CENTS: '100' }), 100)
  assert.equal(stripeMinimumChargeCents('EUR', { STRIPE_MINIMUM_CHARGE_CENTS: '0' }), 0)
  for (const bad of ['abc', '-5', '1.5', '999999999', ' ']) assert.equal(stripeMinimumChargeCents('EUR', { STRIPE_MINIMUM_CHARGE_CENTS: bad }), 50, bad)
})

test('the shop\'s minimum is "decided" only by a number: unset is not 0, and 0 is a real decision', () => {
  assert.equal(commercialMinimumDecided(null), false)
  assert.equal(commercialMinimumDecided(undefined), false)
  assert.equal(commercialMinimumDecided(Number.NaN), false)
  assert.equal(commercialMinimumDecided(-1), false)
  assert.equal(commercialMinimumDecided(0), true)
  assert.equal(commercialMinimumDecided(25), true)
})

const prod = { NODE_ENV: 'production', HOSTED_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', TAX_MODE: 'none', BASE_URL: 'https://shop.example.test', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' }

test('in production nothing is sold online until the shop has chosen its minimum order; no amount is made up', () => {
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: prod })?.code, undefined, 'not looked at yet (environment only): not blocked by this')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: prod, minimumOrderSubtotal: null })?.code, 'MINIMUM_ORDER_NOT_CONFIGURED')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: prod, minimumOrderSubtotal: null })?.status, 503)
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: prod, minimumOrderSubtotal: 0 }), null, '0 = no minimum, chosen on purpose')
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: prod, minimumOrderSubtotal: 30 }), null)
  // outside production (development, tests) an unset minimum simply means none
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...prod, NODE_ENV: 'development' }, minimumOrderSubtotal: null }), null)
})

test('the admin environment check lists the minimum order as required in production', () => {
  const base = { DATABASE_URL: 'x', JWT_SECRET: 'x'.repeat(40), ...prod }
  const unset = buildEnvChecks(base as any, new Set(), { minimumOrderSubtotal: null }).find((check) => check.key === 'MINIMUM_ORDER')
  assert.ok(unset)
  assert.equal(unset!.required, true)
  assert.equal(unset!.ok, false)
  assert.equal(buildEnvChecks(base as any, new Set(), { minimumOrderSubtotal: 0 }).find((check) => check.key === 'MINIMUM_ORDER')!.ok, true)
  assert.equal(buildEnvChecks(base as any, new Set(), { minimumOrderSubtotal: 20 }).find((check) => check.key === 'MINIMUM_ORDER')!.ok, true)
  assert.equal(buildEnvChecks({ ...base, NODE_ENV: 'development' } as any, new Set(), { minimumOrderSubtotal: null }).find((check) => check.key === 'MINIMUM_ORDER'), undefined)
})
