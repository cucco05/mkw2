import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMinimumAfterScale, resolveMinimumUnitPrice, resolveModelPricing } from '../lib/pricing'

const saved = { CURRENCY: process.env.CURRENCY, USD: process.env.MINIMUM_PRICE_USD, CAD: process.env.MINIMUM_PRICE_CAD }
test.afterEach(() => {
  for (const [key, value] of [['CURRENCY', saved.CURRENCY], ['MINIMUM_PRICE_USD', saved.USD], ['MINIMUM_PRICE_CAD', saved.CAD]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('applyMinimumAfterScale: a piece that falls under the minimum after a resize is raised to it', () => {
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 10.78, volumeMultiplier: 0.125, minimumPrice: 5 }), { price: 5, floored: true })
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 5, volumeMultiplier: 0.001, minimumPrice: 5 }), { price: 5, floored: true }, 'a price exactly at the minimum counts as having been floored')
})

test('applyMinimumAfterScale: a piece that stays at or over the minimum is not touched, and growing never lowers it', () => {
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 10, volumeMultiplier: 0.8, minimumPrice: 5 }), { price: 8, floored: false })
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 10, volumeMultiplier: 1, minimumPrice: 5 }), { price: 10, floored: false })
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 6, volumeMultiplier: 3.375, minimumPrice: 5 }), { price: 20.25, floored: false })
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 10, volumeMultiplier: 0.5, minimumPrice: 5 }), { price: 5, floored: false }, 'exactly the minimum: nothing to raise')
})

test('applyMinimumAfterScale: a price the shop set by hand UNDER the minimum is raised to it too, resized or not (a fixed price is not an exemption)', () => {
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 3, volumeMultiplier: 1, minimumPrice: 5 }), { price: 5, floored: true }, 'at the original size')
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 3, volumeMultiplier: 0.5, minimumPrice: 5 }), { price: 5, floored: true })
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 4.99, volumeMultiplier: 0.1, minimumPrice: 5 }), { price: 5, floored: true })
  // grown enough to be over the minimum by volume: priced by volume
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 3, volumeMultiplier: 2, minimumPrice: 5 }), { price: 6, floored: false })
})

test('applyMinimumAfterScale: no minimum (0, negative, not a number) changes nothing', () => {
  for (const minimumPrice of [0, -3, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
    assert.deepEqual(applyMinimumAfterScale({ basePrice: 10, volumeMultiplier: 0.125, minimumPrice }), { price: 1.25, floored: false })
  }
})

test('resolveMinimumUnitPrice: the configuration wins, then the environment of the currency, then the USD one, then none', () => {
  process.env.CURRENCY = 'EUR'
  process.env.MINIMUM_PRICE_USD = '4'
  assert.equal(resolveMinimumUnitPrice({ minimumPriceUsd: 5 } as any), 5)
  assert.equal(resolveMinimumUnitPrice({ minimumPriceUsd: 0 } as any), 0, 'a configured 0 is a choice: no minimum, whatever the environment says')
  assert.equal(resolveMinimumUnitPrice({} as any), 4)
  assert.equal(resolveMinimumUnitPrice(null), 4)
  delete process.env.MINIMUM_PRICE_USD
  assert.equal(resolveMinimumUnitPrice(null), 0)
  process.env.CURRENCY = 'CAD'
  process.env.MINIMUM_PRICE_USD = '4'
  process.env.MINIMUM_PRICE_CAD = '6'
  assert.equal(resolveMinimumUnitPrice(null), 6)
})

test('resolveMinimumUnitPrice: nonsense is no minimum, never NaN', () => {
  process.env.CURRENCY = 'EUR'
  process.env.MINIMUM_PRICE_USD = 'abc'
  assert.equal(resolveMinimumUnitPrice(null), 0)
  assert.equal(resolveMinimumUnitPrice({ minimumPriceUsd: -5 } as any), 0)
  assert.equal(resolveMinimumUnitPrice({ minimumPriceUsd: 5.004 } as any), 5)
})

// ---- the parts of a model made of several parts -------------------------------------------------------------------------------------------
// (step 4.6) The count-based rule of step 4.5 (countMultipartUnits / applyGroupMinimum) is gone: which lines make one unit is now stated by the cart and CHECKED by
// the server - lib/sale-units.ts (tests/sale-units.test.ts), lib/unit-pricing.ts (tests/unit-pricing.test.ts), and through the real route in tests/security/sale-units.sec.ts.

// ---- the shop window shows the price the checkout charges ------------------------------------------------------------------------------------
test('resolveModelPricing: a sale price under the minimum is shown at the minimum; over it, as it is; no minimum, as it is', () => {
  process.env.CURRENCY = 'EUR'
  delete process.env.MINIMUM_PRICE_USD
  const model = (salePriceUsd: number | null) => ({ volumeMm3: 150000, material: 'PLA', supportRatio: null, priceUsd: 12, salePriceUsd })
  assert.equal(resolveModelPricing(model(3), { minimumPriceUsd: 5 } as any).salePriceUsd, 5)
  assert.equal(resolveModelPricing(model(3), { minimumPriceUsd: 5 } as any).priceUsd, 5)
  assert.equal(resolveModelPricing(model(20), { minimumPriceUsd: 5 } as any).salePriceUsd, 20)
  assert.equal(resolveModelPricing(model(3), { minimumPriceUsd: 0 } as any).salePriceUsd, 3)
  assert.equal(resolveModelPricing(model(null), { minimumPriceUsd: 5 } as any).salePriceUsd, null)
})

test('resolveModelPricing / estimatePricing: a minimum named for the model (a waiver) replaces the shop\'s, in both directions', () => {
  process.env.CURRENCY = 'EUR'
  delete process.env.MINIMUM_PRICE_USD
  const model = (salePriceUsd: number | null) => ({ volumeMm3: 150000, material: 'PLA', supportRatio: null, priceUsd: 12, salePriceUsd })
  assert.equal(resolveModelPricing(model(3), { minimumPriceUsd: 5 } as any, { minimumPrice: 2 }).salePriceUsd, 3, 'a waiver floor of 2.00: the hand-set 3.00 stays')
  assert.equal(resolveModelPricing(model(3), { minimumPriceUsd: 5 } as any, { minimumPrice: 0 }).salePriceUsd, 3, 'no floor at all')
  assert.equal(resolveModelPricing(model(1), { minimumPriceUsd: 5 } as any, { minimumPrice: 2 }).salePriceUsd, 2, 'under the waiver floor it is lifted to it')
})
