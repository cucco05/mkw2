// Step 4.6 (S2) - parts that would make a complete model but are bought one by one: the customer's choice is bound to THAT cart and THAT subtotal.
// Pure: a fake storage stands in for the browser's.
import assert from 'node:assert/strict'
import test from 'node:test'
import { completeModelNotices, needsSinglePartsChoice, readSinglePartsAck, writeSinglePartsAck, clearSinglePartsAck } from '../lib/single-parts-ack'

const fakeStore = () => {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
const suggestion = [{ code: 'COULD_BE_COMPLETE_MODEL', itemIndexes: [0, 1, 2], copies: 1 }]
const invalid = [{ code: 'SET_NOT_VALID', reason: 'QTY_MISMATCH', itemIndexes: [0, 1] }]

test('only the suggestion of a complete model asks the customer to choose; a refused group is a different message', () => {
  assert.equal(completeModelNotices(suggestion).length, 1)
  assert.equal(completeModelNotices(invalid).length, 0)
  assert.equal(completeModelNotices(undefined).length, 0)
  assert.equal(completeModelNotices(null).length, 0)
  const store = fakeStore()
  assert.equal(needsSinglePartsChoice(invalid, store, 'cart-a', 1500), false)
  assert.equal(needsSinglePartsChoice([], store, 'cart-a', 1500), false)
  assert.equal(needsSinglePartsChoice(suggestion, store, 'cart-a', 1500), true)
})

test('the confirmation is for this cart and this subtotal ONLY: a change of either asks again', () => {
  const store = fakeStore()
  writeSinglePartsAck(store, 'cart-a', 1500)
  assert.equal(readSinglePartsAck(store, 'cart-a', 1500), true)
  assert.equal(needsSinglePartsChoice(suggestion, store, 'cart-a', 1500), false, 'confirmed')
  assert.equal(needsSinglePartsChoice(suggestion, store, 'cart-a', 1501), true, 'one cent more is a new price')
  assert.equal(needsSinglePartsChoice(suggestion, store, 'cart-b', 1500), true, 'another cart')
})

test('with no cart signature or no subtotal yet the choice is still required (never assumed)', () => {
  const store = fakeStore()
  writeSinglePartsAck(store, 'cart-a', 1500)
  assert.equal(needsSinglePartsChoice(suggestion, store, null, 1500), true)
  assert.equal(needsSinglePartsChoice(suggestion, store, 'cart-a', null), true)
})

test('a blocked or damaged storage never counts as a confirmation, and the choice made in this page still holds', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readSinglePartsAck(broken, 'cart-a', 1500), false)
  assert.doesNotThrow(() => writeSinglePartsAck(broken, 'cart-a', 1500))
  assert.equal(needsSinglePartsChoice(suggestion, broken, 'cart-a', 1500), true)
  assert.equal(needsSinglePartsChoice(suggestion, broken, 'cart-a', 1500, { signature: 'cart-a', totalCents: 1500 }), false, 'kept in memory for this page')
  assert.equal(needsSinglePartsChoice(suggestion, broken, 'cart-a', 1500, { signature: 'cart-a', totalCents: 1400 }), true)
  const store = fakeStore()
  store.setItem('mw:single-parts-ack:v1', '{not json')
  assert.equal(readSinglePartsAck(store, 'cart-a', 1500), false)
  assert.equal(readSinglePartsAck(null, 'cart-a', 1500), false)
})

test('forgetting the confirmation asks again', () => {
  const store = fakeStore()
  writeSinglePartsAck(store, 'cart-a', 1500)
  clearSinglePartsAck(store)
  assert.equal(readSinglePartsAck(store, 'cart-a', 1500), false)
})
