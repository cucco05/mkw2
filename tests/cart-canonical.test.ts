// Step 4.6 (S1) - the cart fingerprint depends on what is bought, not on the order of the lines or on the random keys that group them.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { canonicalCartItems, canonicalJson } from '../lib/cart-canonical'

const fp = (items: Array<Record<string, unknown>>) => createHash('sha256').update(canonicalJson(canonicalCartItems(items))).digest('hex')
const a = { modelId: 'M', partId: 'a', qty: 1, scale: 1, material: 'PLA', colors: ['#fff'] }
const b = { modelId: 'M', partId: 'b', qty: 1, scale: 1, material: 'PLA', colors: ['#fff'] }
const c = { modelId: 'M', partId: 'c', qty: 1, scale: 1, material: 'PLA', colors: ['#fff'] }
const solo = { modelId: 'V', qty: 2, scale: 1.5, material: 'PETG', colors: ['#000'] }

test('the order of the lines does not change the fingerprint', () => {
  const lines = [{ ...a, setKey: 'k1' }, { ...b, setKey: 'k1' }, { ...c, setKey: 'k1' }, solo]
  const reversed = lines.slice().reverse()
  const shuffled = [lines[2], lines[0], lines[3], lines[1]]
  assert.equal(fp(lines), fp(reversed))
  assert.equal(fp(lines), fp(shuffled))
})

test('the random value of the key does not change the fingerprint: a cart rebuilt with new keys is the same purchase', () => {
  const one = [{ ...a, setKey: 'AAAAAAAA' }, { ...b, setKey: 'AAAAAAAA' }, { ...c, setKey: 'AAAAAAAA' }]
  const two = [{ ...a, setKey: 'zq-9-new-key' }, { ...b, setKey: 'zq-9-new-key' }, { ...c, setKey: 'zq-9-new-key' }]
  assert.equal(fp(one), fp(two))
})

test('everything that is commercial DOES change it: quantity, options, which lines are grouped, a different grouping of the same lines', () => {
  const grouped = [{ ...a, setKey: 'k' }, { ...b, setKey: 'k' }, { ...c, setKey: 'k' }]
  const loose = [a, b, c]
  assert.notEqual(fp(grouped), fp(loose), 'grouped as a complete model is not the same purchase as three single parts')
  assert.notEqual(fp(grouped), fp([{ ...a, setKey: 'k', qty: 2 }, { ...b, setKey: 'k' }, { ...c, setKey: 'k' }]))
  assert.notEqual(fp(grouped), fp([{ ...a, setKey: 'k', material: 'PETG' }, { ...b, setKey: 'k' }, { ...c, setKey: 'k' }]))
  assert.notEqual(fp(grouped), fp([{ ...a, setKey: 'k1' }, { ...b, setKey: 'k1' }, { ...c, setKey: 'k2' }]), 'splitting the group in two keys')
  assert.notEqual(fp([solo]), fp([{ ...solo, qty: 3 }]))
})

test('two groups with the same content are two groups, and one group with doubled quantity is not the same cart', () => {
  const twoGroups = [{ ...a, setKey: 'k1' }, { ...b, setKey: 'k1' }, { ...c, setKey: 'k1' }, { ...a, setKey: 'k2' }, { ...b, setKey: 'k2' }, { ...c, setKey: 'k2' }]
  const oneDouble = [{ ...a, setKey: 'k1', qty: 2 }, { ...b, setKey: 'k1', qty: 2 }, { ...c, setKey: 'k1', qty: 2 }]
  assert.notEqual(fp(twoGroups), fp(oneDouble))
})

test('a line without a key keeps its own shape: a cart that never had keys is fingerprinted by its lines alone', () => {
  const canonical = canonicalCartItems([solo]) as Array<Record<string, unknown>>
  assert.ok(!('group' in canonical[0]) && !('setKey' in canonical[0]))
})
