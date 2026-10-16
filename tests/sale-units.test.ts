// Step 4.6 (S1) - what is actually sold: when does a group of lines count as ONE complete copy of a model, and when is it only parts.
// Pure: the model/part lists are given, no database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSaleUnits, type UnitLine } from '../lib/sale-units'

const PARTS: Record<string, string[]> = { M: ['a', 'b', 'c'], N: ['x', 'y'], S: ['only'] }
const partIdsOf = (modelId: string) => PARTS[modelId] ?? []
let counter = 0
const line = (over: Partial<UnitLine> & Pick<UnitLine, 'modelId'>): UnitLine => ({
  index: counter++, partId: null, productTemplateId: null, setKey: null, qty: 1, scaleX: 1, scaleY: 1, scaleZ: 1, ...over,
})
const resetIndex = () => { counter = 0 }
const completeSet = (key: string | null, over: Partial<UnitLine> = {}) => PARTS.M.map((partId) => line({ modelId: 'M', partId, setKey: key, ...over }))

test('a complete set (every part once, same quantity, same scale) is ONE unit of that many copies', () => {
  resetIndex()
  const plan = resolveSaleUnits(completeSet('k1', { qty: 3 }), partIdsOf)
  assert.equal(plan.units.length, 1)
  assert.deepEqual(plan.units[0], { kind: 'set', lineIndexes: [0, 1, 2], copies: 3, setOrdinal: 1, partCount: 3 })
  assert.deepEqual(plan.unitOfLine, [0, 0, 0])
  assert.deepEqual(plan.notices, [])
})

test('colours do not matter, and neither do material or finish: only the structure and the scale are checked', () => {
  // (the unit line carries no colour at all: the check cannot depend on it - see lib/sale-units.ts)
  resetIndex()
  const lines = completeSet('k1')
  assert.equal(resolveSaleUnits(lines, partIdsOf).units[0].kind, 'set')
})

test('a model whose parts have different scales is NOT a complete copy: sold as single parts, with the reason', () => {
  resetIndex()
  const lines = completeSet('k1')
  lines[1].scaleX = 1.5
  const plan = resolveSaleUnits(lines, partIdsOf)
  assert.deepEqual(plan.units.map((unit) => unit.kind), ['part', 'part', 'part'])
  assert.deepEqual(plan.notices, [{ code: 'SET_NOT_VALID', reason: 'SCALE_MISMATCH', itemIndexes: [0, 1, 2] }])
})

test('the scale is compared to four decimals: rounding noise is the same size, a visible difference is not', () => {
  resetIndex()
  const same = completeSet('k1')
  same[0].scaleX = 1.00001; same[0].scaleY = 0.99999
  assert.equal(resolveSaleUnits(same, partIdsOf).units[0].kind, 'set')
  resetIndex()
  const different = completeSet('k1')
  different[2].scaleZ = 1.001
  assert.equal(resolveSaleUnits(different, partIdsOf).units[0].kind, 'part')
})

test('every way a claim can fail is refused WITHOUT being repaired: the lines become single parts', () => {
  const cases: Array<[string, () => UnitLine[], string]> = [
    ['a part is missing', () => completeSet('k1').slice(0, 2), 'INCOMPLETE'],
    ['a part twice', () => [...completeSet('k1'), line({ modelId: 'M', partId: 'a', setKey: 'k1' })], 'DUPLICATE_PART'],
    ['a part of another model', () => [...completeSet('k1').slice(0, 2), line({ modelId: 'M', partId: 'x', setKey: 'k1' })], 'FOREIGN_PART'],
    ['different quantities', () => { const l = completeSet('k1'); l[1].qty = 2; return l }, 'QTY_MISMATCH'],
    ['different scales', () => { const l = completeSet('k1'); l[0].scaleY = 2; return l }, 'SCALE_MISMATCH'],
    ['one key on two models', () => [...completeSet('k1'), ...PARTS.N.map((partId) => line({ modelId: 'N', partId, setKey: 'k1' }))], 'KEY_ACROSS_MODELS'],
  ]
  for (const [label, build, reason] of cases) {
    resetIndex()
    const lines = build()
    const plan = resolveSaleUnits(lines, partIdsOf)
    assert.ok(plan.units.every((unit) => unit.kind === 'part'), `${label}: no set`)
    assert.equal(plan.units.length, lines.length, `${label}: one unit per line`)
    const notice = plan.notices.find((entry) => entry.code === 'SET_NOT_VALID')
    assert.ok(notice && notice.code === 'SET_NOT_VALID' && notice.reason === reason, `${label}: ${JSON.stringify(plan.notices)}`)
  }
})

test('a key on something that is not a part of a multi-part model counts for nothing and is reported', () => {
  resetIndex()
  const lines = [
    line({ modelId: 'M', setKey: 'k1' }), // a whole model
    line({ modelId: 'M', partId: 'a', productTemplateId: 'prod', setKey: 'k2' }), // a ready-made product
    line({ modelId: 'S', partId: 'only', setKey: 'k3' }), // the part of a single-part model
  ]
  const plan = resolveSaleUnits(lines, partIdsOf)
  assert.deepEqual(plan.units.map((unit) => unit.kind), ['whole', 'product', 'part'])
  assert.deepEqual(plan.notices, [{ code: 'SET_NOT_VALID', reason: 'KEY_ON_NON_PART', itemIndexes: [0, 1, 2] }])
})

test('several complete copies: one group with a quantity, or several groups - and different sizes are different groups', () => {
  resetIndex()
  const twoGroups = [...completeSet('k1', { scaleX: 1, scaleY: 1, scaleZ: 1 }), ...completeSet('k2', { scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5 })]
  const plan = resolveSaleUnits(twoGroups, partIdsOf)
  assert.deepEqual(plan.units.map((unit) => [unit.kind, unit.copies, unit.setOrdinal]), [['set', 1, 1], ['set', 1, 2]])
})

test('the units do not depend on the order of the lines or on the value of the keys', () => {
  resetIndex()
  const original = [...completeSet('k1', { qty: 2 }), line({ modelId: 'N', partId: 'x' })]
  const a = resolveSaleUnits(original, partIdsOf)
  resetIndex()
  const reordered = [line({ modelId: 'N', partId: 'x' }), ...completeSet('zzzz-other-key', { qty: 2 }).reverse()]
  const b = resolveSaleUnits(reordered, partIdsOf)
  const shape = (plan: typeof a) => plan.units.map((unit) => `${unit.kind}:${unit.copies}:${unit.lineIndexes.length}`).sort()
  assert.deepEqual(shape(a), shape(b))
})

test('loose parts with no key are never grouped by the server: they are suggested, with how many complete copies they could make', () => {
  resetIndex()
  const lines = [...completeSet(null, { qty: 2 }), line({ modelId: 'M', partId: 'a', qty: 1 })]
  const plan = resolveSaleUnits(lines, partIdsOf)
  assert.ok(plan.units.every((unit) => unit.kind === 'part'))
  assert.deepEqual(plan.notices, [{ code: 'COULD_BE_COMPLETE_MODEL', itemIndexes: [0, 1, 2, 3], copies: 2 }])
  resetIndex()
  const notEnough = resolveSaleUnits(completeSet(null).slice(0, 2), partIdsOf)
  assert.deepEqual(notEnough.notices, [], 'two of three parts could not make a complete model: no suggestion')
})

test('whole models and ready-made products are one unit per copy; a part of a single-part model too', () => {
  resetIndex()
  const plan = resolveSaleUnits([
    line({ modelId: 'M', qty: 4 }),
    line({ modelId: 'M', partId: 'a', productTemplateId: 'p1', qty: 2 }),
    line({ modelId: 'S', partId: 'only', qty: 3 }),
  ], partIdsOf)
  assert.deepEqual(plan.units.map((unit) => [unit.kind, unit.copies]), [['whole', 4], ['product', 2], ['part', 3]])
})

test('property: every line belongs to exactly one unit, and a set is always exactly one copy of every part with one quantity and one scale', () => {
  let seed = 99
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]
  for (let round = 0; round < 1500; round++) {
    resetIndex()
    const lines: UnitLine[] = []
    for (let i = 0, count = 1 + Math.floor(random() * 9); i < count; i++) {
      const modelId = pick(['M', 'N', 'S'])
      lines.push(line({
        modelId,
        partId: random() < 0.15 ? null : pick(PARTS[modelId].concat(random() < 0.1 ? ['zzz'] : [])),
        productTemplateId: random() < 0.07 ? 'prod' : null,
        setKey: random() < 0.6 ? pick(['k1', 'k2', 'k3']) : null,
        qty: pick([1, 1, 2, 3]),
        scaleX: pick([1, 1, 1, 2]), scaleY: 1, scaleZ: 1,
      }))
    }
    const plan = resolveSaleUnits(lines, partIdsOf)
    const seen = new Set<number>()
    plan.units.forEach((unit, unitIndex) => {
      unit.lineIndexes.forEach((position) => {
        assert.ok(!seen.has(position), 'a line is in one unit only')
        seen.add(position)
        assert.equal(plan.unitOfLine[position], unitIndex)
      })
      if (unit.kind !== 'set') { assert.equal(unit.lineIndexes.length, 1); return }
      const members = unit.lineIndexes.map((position) => lines[position])
      const model = members[0].modelId
      assert.ok(members.every((member) => member.modelId === model && member.partId && !member.productTemplateId))
      assert.deepEqual(members.map((member) => member.partId).sort(), PARTS[model].slice().sort(), 'every part, once')
      assert.equal(new Set(members.map((member) => member.qty)).size, 1)
      assert.equal(new Set(members.map((member) => `${member.scaleX}/${member.scaleY}/${member.scaleZ}`)).size, 1)
      assert.equal(unit.copies, members[0].qty)
    })
    assert.equal(seen.size, lines.length, 'every line is in a unit')
  }
})
