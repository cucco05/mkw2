// Step 4.6 (S1) - the cent arithmetic of a sold unit: pure, so every property is checked here without a database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateCents, allocatePartPriceCents, floorUnitCents } from '../lib/unit-pricing'

// a small deterministic generator: the same cases on every run
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}
const sum = (list: ReadonlyArray<number>) => list.reduce((a, b) => a + b, 0)

test('allocateCents: the parts add up to the total EXACTLY, whatever the weights', () => {
  const random = rng(7)
  for (let i = 0; i < 3000; i++) {
    const count = 1 + Math.floor(random() * 8)
    const total = Math.floor(random() * 100_000)
    const weights = Array.from({ length: count }, () => (random() < 0.15 ? 0 : random() * 1000))
    const parts = allocateCents(total, weights)
    assert.equal(parts.length, count)
    assert.equal(sum(parts), total, `total ${total} weights ${JSON.stringify(weights)}`)
    assert.ok(parts.every((value) => Number.isInteger(value) && value >= 0))
  }
})

test('allocateCents: each part is within one cent of its exact share, and a heavier line never gets less than a lighter one', () => {
  const random = rng(11)
  for (let i = 0; i < 2000; i++) {
    const count = 2 + Math.floor(random() * 5)
    const total = 1 + Math.floor(random() * 50_000)
    const weights = Array.from({ length: count }, () => 1 + random() * 500)
    const parts = allocateCents(total, weights)
    const weightSum = sum(weights)
    parts.forEach((value, index) => assert.ok(Math.abs(value - (total * weights[index]) / weightSum) < 1 + 1e-9))
    for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) if (weights[a] > weights[b]) assert.ok(parts[a] >= parts[b], 'heavier >= lighter')
  }
})

test('allocateCents: a tie goes to the earlier line, and the order of the lines only moves the cents that are tied', () => {
  assert.deepEqual(allocateCents(100, [1, 1, 1]), [34, 33, 33])
  assert.deepEqual(allocateCents(2, [1, 1, 1]), [1, 1, 0])
  assert.deepEqual(allocateCents(1000, [100000, 50000]), [667, 333], 'the two parts of the scenario model: 10.00 shared by volume')
  assert.deepEqual(allocateCents(0, [3, 2]), [0, 0])
})

test('allocateCents: nothing weighs anything -> equal shares; a negative, missing or not-a-number weight counts as 0; empty -> empty', () => {
  assert.deepEqual(allocateCents(10, [0, 0]), [5, 5])
  assert.deepEqual(allocateCents(10, [Number.NaN, -4, 6]), [0, 0, 10])
  assert.deepEqual(allocateCents(10, []), [])
  assert.deepEqual(allocateCents(-5, [1, 1]), [0, 0], 'a negative total is nothing')
  assert.deepEqual(allocateCents(Number.NaN, [1, 1]), [0, 0])
})

test('allocateCents: sharing an already shared total gives the same shares back (idempotent)', () => {
  const random = rng(13)
  for (let i = 0; i < 1000; i++) {
    const count = 1 + Math.floor(random() * 6)
    const weights = Array.from({ length: count }, () => 1 + random() * 400)
    const once = allocateCents(1 + Math.floor(random() * 20_000), weights)
    assert.deepEqual(allocateCents(sum(once), once), once)
  }
})

test('floorUnitCents: a unit that costs at least the minimum is not touched; one that costs less is raised to EXACTLY the minimum', () => {
  assert.deepEqual(floorUnitCents([300, 200], 500), { cents: [300, 200], floored: false }, 'exactly the minimum: nothing to raise')
  assert.deepEqual(floorUnitCents([900], 500), { cents: [900], floored: false })
  assert.deepEqual(floorUnitCents([100], 500), { cents: [500], floored: true })
  const raised = floorUnitCents([100, 150, 50], 500)
  assert.equal(raised.floored, true)
  assert.equal(sum(raised.cents), 500)
  assert.deepEqual(raised.cents, [167, 250, 83], 'shared in proportion to what each line cost')
})

test('floorUnitCents: no minimum, no lines, odd numbers -> nothing changes, never a negative or a fraction', () => {
  assert.deepEqual(floorUnitCents([100, 200], 0), { cents: [100, 200], floored: false })
  assert.deepEqual(floorUnitCents([], 500), { cents: [], floored: false })
  assert.deepEqual(floorUnitCents([-5, 10.4], 20), { cents: [0, 20], floored: true })
  assert.deepEqual(floorUnitCents([100], Number.NaN), { cents: [100], floored: false })
})

test('floorUnitCents: the unit total is max(what it costs, the minimum) - for every combination', () => {
  const random = rng(17)
  for (let i = 0; i < 3000; i++) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 5) }, () => Math.floor(random() * 900))
    const minimum = Math.floor(random() * 2000)
    const { cents, floored } = floorUnitCents(lines, minimum)
    assert.equal(sum(cents), Math.max(sum(lines), minimum))
    assert.equal(floored, sum(lines) < minimum && minimum > 0)
    if (!floored) assert.deepEqual(cents, lines)
    else assert.ok(cents.every((value) => Number.isInteger(value) && value >= 0))
  }
})

test('allocatePartPriceCents: the price of a model shared by volume adds up to the model\'s price; no reliable volume -> null', () => {
  assert.deepEqual(allocatePartPriceCents({ wholePriceCents: 1000, partVolumes: [100000, 50000] }), [667, 333])
  assert.deepEqual(allocatePartPriceCents({ wholePriceCents: 3000, partVolumes: [50, 30, 20] }), [1500, 900, 600])
  assert.equal(allocatePartPriceCents({ wholePriceCents: 1000, partVolumes: [100] }), null, 'one part is not a shared price')
  assert.equal(allocatePartPriceCents({ wholePriceCents: 1000, partVolumes: [100, null] }), null)
  assert.equal(allocatePartPriceCents({ wholePriceCents: 1000, partVolumes: [100, 0] }), null)
  assert.equal(allocatePartPriceCents({ wholePriceCents: Number.NaN, partVolumes: [1, 1] }), null)
  const random = rng(19)
  for (let i = 0; i < 1000; i++) {
    const volumes = Array.from({ length: 2 + Math.floor(random() * 5) }, () => 1 + Math.floor(random() * 90_000))
    const whole = Math.floor(random() * 90_000)
    assert.equal(sum(allocatePartPriceCents({ wholePriceCents: whole, partVolumes: volumes })!), whole)
  }
})
