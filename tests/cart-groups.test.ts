// Step 4.6 (S2) - the cart side of a "complete model": what a group of lines does when the customer changes it. Pure, no browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkGrouping, countUnits, dissolveGroup, findGroupFor, groupLines, groupsOf, newSetKey, orderForDisplay, propagateGroup, removeGroup, removeLine, SET_KEY_PATTERN,
  type GroupableLine,
} from '../lib/cart-groups'

type Line = GroupableLine & { title?: string }
let seq = 0
const line = (over: Partial<Line> & { modelId: string; partId?: string | null }, options: Partial<Line['options']> = {}): Line => ({
  cartItemId: `c${++seq}`, setKey: null, ...over, options: { qty: 1, scale: 1, lockDimensions: true, dimensionOverrides: null, ...options },
})
const model = (key: string | null, qty = 1, scale = 1) => ['a', 'b', 'c'].map((partId) => line({ modelId: 'M', partId, setKey: key }, { qty, scale }))

test('a new key matches the pattern the server accepts, and two keys are not the same', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newSetKey()))
  assert.equal(keys.size, 200)
  for (const key of keys) assert.match(key, SET_KEY_PATTERN)
  assert.equal(newSetKey(() => new Uint8Array(12)), 'sAAAAAAAAAAAAAAAA')
})

test('quantity and size of a group change together: the other lines follow the line that was changed', () => {
  const items = [...model('SETKEY001', 1), line({ modelId: 'N', partId: 'x' })]
  const changed = { ...items[1], options: { ...items[1].options, qty: 3, scale: 1.5, lockDimensions: false, dimensionOverrides: { x: 1.5, y: 1.5, z: 2 } } }
  const next = propagateGroup(items.map((item) => (item === items[1] ? changed : item)), changed)
  for (const index of [0, 1, 2]) {
    assert.equal(next[index].options.qty, 3)
    assert.equal(next[index].options.scale, 1.5)
    assert.equal(next[index].options.lockDimensions, false)
    assert.deepEqual(next[index].options.dimensionOverrides, { x: 1.5, y: 1.5, z: 2 })
  }
  assert.equal(next[3].options.qty, 1, 'a line of another model is not touched')
  assert.notEqual(next[0].options.dimensionOverrides, next[1].options.dimensionOverrides, 'each line has its own copy of the sizes')
})

test('a line with no key propagates to nobody', () => {
  const items = model(null, 1)
  const changed = { ...items[0], options: { ...items[0].options, qty: 5 } }
  const next = propagateGroup([changed, items[1], items[2]], changed)
  assert.deepEqual(next.map((item) => item.options.qty), [5, 1, 1])
})

test('removing ONE line of a group dissolves the group: the others stay as single parts; removing the group removes all of it', () => {
  const items = [...model('SETKEY001', 2), ...model('SETKEY002', 1)]
  const afterOne = removeLine(items, (item) => item === items[0])
  assert.equal(afterOne.length, 5)
  assert.deepEqual(afterOne.slice(0, 2).map((item) => item.setKey), [null, null])
  assert.deepEqual(afterOne.slice(2).map((item) => item.setKey), ['SETKEY002', 'SETKEY002', 'SETKEY002'])
  const afterGroup = removeGroup(items, 'SETKEY001')
  assert.equal(afterGroup.length, 3)
  assert.ok(afterGroup.every((item) => item.setKey === 'SETKEY002'))
  assert.equal(removeGroup(items, null), items)
})

test('dissolving a group keeps every line, quantity and option', () => {
  const items = model('SETKEY001', 2)
  const loose = dissolveGroup(items, 'SETKEY001')
  assert.deepEqual(loose.map((item) => [item.cartItemId, item.options.qty, item.setKey]), items.map((item) => [item.cartItemId, 2, null]))
})

test('the counter counts copies, not lines: a complete model of three parts is one', () => {
  assert.equal(countUnits(model('SETKEY001', 2)), 2)
  assert.equal(countUnits([...model('SETKEY001', 1), ...model('SETKEY002', 3), line({ modelId: 'V' }, { qty: 4 })]), 1 + 3 + 4)
  assert.equal(countUnits(model(null, 2)), 6, 'three single parts of 2 are six pieces')
  assert.equal(countUnits([]), 0)
})

test('groupsOf lists each group once, in the order of its first line, and ignores a key that does not look like one', () => {
  const items = [line({ modelId: 'V' }), ...model('SETKEY001'), ...model('x')]
  const groups = groupsOf(items)
  assert.deepEqual(groups.map((group) => [group.setKey, group.lines.length]), [['SETKEY001', 3]])
})

test('putting loose lines together: only parts of ONE model, each part once, same quantity, same size - nothing is adjusted', () => {
  const ok = model(null, 2)
  const ids = ok.map((item) => item.cartItemId)
  assert.deepEqual(checkGrouping(ok, ids), { ok: true, modelId: 'M', partCount: 3, qty: 2 })
  const grouped = groupLines(ok, ids, () => 'NEWKEY0001')
  assert.deepEqual(grouped.map((item) => item.setKey), ['NEWKEY0001', 'NEWKEY0001', 'NEWKEY0001'])

  const refuse = (items: Line[], reason: string, pick = items.map((item) => item.cartItemId)) => {
    const result = checkGrouping(items, pick)
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, reason)
    assert.equal(groupLines(items, pick), items, `${reason}: the cart is returned unchanged`)
  }
  const base = model(null, 1)
  refuse(base, 'TOO_FEW', [base[0].cartItemId])
  refuse([...base.slice(0, 2), line({ modelId: 'N', partId: 'x' })], 'OTHER_MODELS')
  refuse([...base.slice(0, 2), line({ modelId: 'M', partId: null })], 'NOT_PARTS')
  refuse([...base.slice(0, 2), line({ modelId: 'M', partId: 'c' }, { productTemplateId: 'prod' })], 'NOT_PARTS')
  refuse([...base.slice(0, 2), { ...base[2], setKey: 'SETKEY009' }], 'ALREADY_GROUPED')
  refuse([...base.slice(0, 2), line({ modelId: 'M', partId: 'a' })], 'DUPLICATE_PART')
  refuse([...base.slice(0, 2), line({ modelId: 'M', partId: 'c' }, { qty: 2 })], 'QTY_DIFFERS')
  refuse([...base.slice(0, 2), line({ modelId: 'M', partId: 'c' }, { scale: 1.2 })], 'SIZE_DIFFERS')
})

test('"same size" looks at the size on every axis, not at the label: unlocked sizes that agree are the same, ones that differ are not', () => {
  const a = line({ modelId: 'M', partId: 'a' }, { scale: 1, lockDimensions: false, dimensionOverrides: { x: 1.5, y: 1.5, z: 1.5 } })
  const b = line({ modelId: 'M', partId: 'b' }, { scale: 1.5, lockDimensions: true, dimensionOverrides: null })
  assert.equal(checkGrouping([a, b], [a.cartItemId, b.cartItemId]).ok, true, 'a locked 1.5 and an unlocked 1.5/1.5/1.5 are one size')
  const c = line({ modelId: 'M', partId: 'c' }, { scale: 1, lockDimensions: false, dimensionOverrides: { x: 1.5, y: 1.5, z: 2 } })
  assert.equal(checkGrouping([a, c], [a.cartItemId, c.cartItemId]).ok, false)
})

test('adding a model again finds the group that already holds the same parts with the same options', () => {
  const items = [...model('SETKEY001'), ...model('SETKEY002')]
  const same = () => true
  assert.equal(findGroupFor(items, 'M', ['a', 'b', 'c'], same), 'SETKEY001')
  assert.equal(findGroupFor(items, 'M', ['a', 'b'], same), null, 'not the same parts')
  assert.equal(findGroupFor(items, 'N', ['a', 'b', 'c'], same), null, 'not the same model')
  assert.equal(findGroupFor(items, 'M', ['a', 'a', 'c'], same), null, 'a part twice is not a model')
  assert.equal(findGroupFor(items, 'M', ['a', 'b', 'c'], (item) => item.partId !== 'b'), null, 'options differ on one part')
  assert.equal(findGroupFor([], 'M', ['a', 'b', 'c'], same), null)
  assert.equal(findGroupFor(items, 'M', [], same), null)
})

test('the lines of a group are shown together, at the place of the first one, and nothing is lost or reordered otherwise', () => {
  const a = model('SETKEY001')
  const solo1 = line({ modelId: 'V' })
  const solo2 = line({ modelId: 'W' })
  const b = model('SETKEY002')
  const items = [a[0], solo1, b[0], a[1], solo2, b[1], a[2], b[2]]
  const shown = orderForDisplay(items)
  assert.deepEqual(shown.map((item) => item.cartItemId), [a[0], a[1], a[2], solo1, b[0], b[1], b[2], solo2].map((item) => item.cartItemId))
  assert.equal(shown.length, items.length)
  assert.deepEqual(orderForDisplay([solo1, solo2]), [solo1, solo2])
})
