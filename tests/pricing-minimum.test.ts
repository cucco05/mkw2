import assert from 'node:assert/strict'
import test from 'node:test'
import { applyGroupMinimum, applyMinimumAfterScale, countMultipartUnits, resolveMinimumUnitPrice, resolveModelPricing } from '../lib/pricing'

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

// ---- loose parts of a model made of several parts -------------------------------------------------------------------------------------------
const PARTS = ['a', 'b', 'c']
const copies = (entries: Record<string, number>) => new Map(Object.entries(entries))

test('countMultipartUnits: a copy of every part is ONE set, a part left over is a unit of its own', () => {
  assert.deepEqual(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 1, b: 1, c: 1 }) }), { sets: 1, units: 1 }, 'a complete model added by the pages (one line per part)')
  assert.deepEqual(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 3, b: 3, c: 3 }) }), { sets: 3, units: 3 })
  assert.deepEqual(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 4, b: 2, c: 2 }) }), { sets: 2, units: 4 }, '2 sets and 2 spare copies of a')
  assert.deepEqual(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 1 }) }), { sets: 0, units: 1 }, 'one part bought on its own')
  assert.deepEqual(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 5 }) }), { sets: 0, units: 5 })
  assert.deepEqual(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 1, b: 1 }) }), { sets: 0, units: 2 }, 'without the third part there is no complete set: two parts bought separately')
})

test('countMultipartUnits: splitting the lines (other colours, other sizes) cannot lower the count', () => {
  // the count depends on the copies per part only, so the caller adds the quantities of every line of the same part: the same cart in any number of lines is the same count
  const whole = countMultipartUnits({ partIds: PARTS, copies: copies({ a: 4, b: 4, c: 4 }) }).units
  const split = countMultipartUnits({ partIds: PARTS, copies: copies({ a: 1 + 3, b: 2 + 2, c: 4 }) }).units
  assert.equal(split, whole)
})

test('countMultipartUnits: the units are never fewer than the copies of the commonest part, never more than the copies, and a set needs a copy of every part', () => {
  for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) for (let c = 0; c <= 6; c++) {
    const { sets, units } = countMultipartUnits({ partIds: PARTS, copies: copies({ a, b, c }) })
    assert.ok(units >= Math.max(a, b, c), `${a},${b},${c}: ${units}`)
    assert.ok(units <= a + b + c, `${a},${b},${c}: ${units}`)
    assert.equal(sets, Math.min(a, b, c))
  }
})

test('countMultipartUnits: KNOWN CONSEQUENCE - completing a set lowers the units (two parts bought separately are two units; with the third they are one complete set)', () => {
  // This is the price of not knowing which parts make a unit (docs/CHECKOUT-S2-S3.md, "Passo 4.5"): it is pinned here so that nobody relies on it, or removes it by accident.
  assert.equal(countMultipartUnits({ partIds: PARTS, copies: copies({ b: 1, c: 1 }) }).units, 2)
  assert.equal(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 1, b: 1, c: 1 }) }).units, 1)
  assert.equal(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 1, b: 2, c: 2 }) }).units, 3)
  assert.equal(countMultipartUnits({ partIds: PARTS, copies: copies({ a: 2, b: 2, c: 2 }) }).units, 2)
})

test('countMultipartUnits: when the parts of the model are not known every copy is a unit (never fewer than the truth)', () => {
  assert.deepEqual(countMultipartUnits({ partIds: [], copies: copies({ a: 2, b: 1 }) }), { sets: 0, units: 3 })
})

test('applyGroupMinimum: the lines together cost at least units x minimum, the shortfall shared in proportion to what each line costs', () => {
  // a complete model of 3 parts that costs 1.20 + 0.80 + 0.50 = 2.50 < 5.00: one unit
  const lines = [{ qty: 1, unitPrice: 1.2 }, { qty: 1, unitPrice: 0.8 }, { qty: 1, unitPrice: 0.5 }]
  const { factor, floored } = applyGroupMinimum({ lines, units: 1, minimumPrice: 5 })
  assert.equal(floored, true)
  const total = lines.reduce((sum, line) => sum + line.qty * line.unitPrice * factor, 0)
  assert.ok(Math.abs(total - 5) < 1e-9, `${total}`)
  assert.ok(Math.abs(lines[0].unitPrice * factor - 2.4) < 1e-9, 'in proportion: 1.20 of 2.50 is 2.40 of 5.00')
})

test('applyGroupMinimum: nothing changes when the group is already over the minimum, or when there is no minimum', () => {
  assert.deepEqual(applyGroupMinimum({ lines: [{ qty: 1, unitPrice: 4 }, { qty: 1, unitPrice: 3 }], units: 1, minimumPrice: 5 }), { factor: 1, floored: false })
  assert.deepEqual(applyGroupMinimum({ lines: [{ qty: 1, unitPrice: 1 }], units: 3, minimumPrice: 0 }), { factor: 1, floored: false })
  assert.deepEqual(applyGroupMinimum({ lines: [{ qty: 1, unitPrice: 1 }], units: 3, minimumPrice: Number.NaN }), { factor: 1, floored: false })
})

test('applyGroupMinimum: a part bought on its own is a unit of its own (qty 3 of a 0.40 part = 3 minimums)', () => {
  const { factor } = applyGroupMinimum({ lines: [{ qty: 3, unitPrice: 0.4 }], units: 3, minimumPrice: 5 })
  assert.ok(Math.abs(3 * 0.4 * factor - 15) < 1e-9)
  assert.ok(Math.abs(0.4 * factor - 5) < 1e-9, 'each copy costs the minimum')
})

test('applyGroupMinimum: the same cart in one line or in two gives the same total', () => {
  const one = applyGroupMinimum({ lines: [{ qty: 4, unitPrice: 0.5 }], units: 4, minimumPrice: 5 })
  const two = applyGroupMinimum({ lines: [{ qty: 1, unitPrice: 0.5 }, { qty: 3, unitPrice: 0.5 }], units: 4, minimumPrice: 5 })
  assert.ok(Math.abs(4 * 0.5 * one.factor - (0.5 + 3 * 0.5) * two.factor) < 1e-9)
})

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
