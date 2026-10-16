import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMinimumAfterScale, resolveMinimumUnitPrice } from '../lib/pricing'

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

test('applyMinimumAfterScale: a price the shop set under the minimum is left alone (it was not raised at the original size either)', () => {
  assert.deepEqual(applyMinimumAfterScale({ basePrice: 3, volumeMultiplier: 0.5, minimumPrice: 5 }), { price: 1.5, floored: false })
  const under = applyMinimumAfterScale({ basePrice: 4.99, volumeMultiplier: 0.1, minimumPrice: 5 })
  assert.equal(under.floored, false)
  assert.ok(Math.abs(under.price - 0.499) < 1e-9)
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
