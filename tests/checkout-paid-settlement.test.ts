// R1-2 (S-04, S-08, S-09) – what the page does with the cart, the key and the memory of the order once the SERVER has said that a payment is verified.
//
// The rules, all of them about what is NOT done unless it can be shown to be right:
//   * the key is forgotten, and the cart emptied, only if the key in the slot is PROVED to be this payment's (the slot carries this order's id) - not because the cart looks the same;
//   * the cart is emptied FIRST, the key forgotten second, the memory of the order removed last - so an interruption at any step leaves an empty cart with a key kept (harmless), never a full
//     cart with no key (a second order for the same things);
//   * a slot that proves nothing (empty, forgotten, damaged, unreadable, written before R1-2) does NOT mean the payment was replaced by another: nothing is touched, the memory of the
//     order STAYS (it is the only way back to it), and the answer is its own - `provenance_unknown` - not "not mine";
//   * a slot that belongs to ANOTHER purchase is left exactly as it is;
//   * a turn that can not be had (the lock service is broken, busy for too long, the page is gone) changes nothing at all, and the memory of the order stays.
// The fake cart and the storage below are models; the real provider is tests/e2e/cart-clear-if.responsive.spec.ts and the real pages tests/e2e/checkout-paid-provenance.responsive.spec.ts.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'
import type { CartItem } from '../components/cart/CartProvider'
import type { ClearIfResult } from '../lib/cart-clear-if'
import {
  cartItemsSignature, createCheckoutKeyMemory, forgetCheckoutKey, readCheckoutKeyEntry, readCheckoutKeySlot, resolveCheckoutKey, stampCheckoutKeyOrder, type KeyStorage,
} from '../lib/checkout-client'
import { paidNote, type PaidView } from '../components/checkout/usePaidSettlement'
import { PURCHASE_LOCK_NAME, blocksNewPayment, isFinalSettlement, settlePaidPurchase, type PaidSettlement } from '../lib/checkout-single-flight'
import { pendingOrderFor, readPendingOrders, rememberPendingOrder } from '../lib/order-status-client'

const KEY_SLOT = 'mw:checkout-key:v1'
const PENDING = 'mw:pending-orders:v2'
const A = 'clorderAAAAAAAAAAAAAAAA'
const B = 'clorderBBBBBBBBBBBBBBBB'
const strongKey = (seed: string) => `k${seed.padEnd(32, 'abcdefghijklmnopqrstuvwxyzABCDEF').slice(0, 32)}`
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

class MemoryStorage implements KeyStorage {
  data = new Map<string, string>()
  writes: Array<{ key: string; value: string | null }> = []
  events: string[] | null = null
  failReads = false
  getItem(key: string) { if (this.failReads) throw new Error('storage denied'); return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.writes.push({ key, value }); this.events?.push(`write ${key === KEY_SLOT ? 'slot' : 'pending'}`); this.data.set(key, value) }
  removeItem(key: string) { this.writes.push({ key, value: null }); this.events?.push(`remove ${key === KEY_SLOT ? 'slot' : 'pending'}`); this.data.delete(key) }
  snapshot() { return JSON.stringify([...this.data.entries()].sort()) }
}

const line = (n: number, qty = 1) => ({
  cartItemId: `ci-${n}`, modelId: `clmodelmodelmodel0000${n}`, partId: null, partName: null, title: `Model ${n}`, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
}) as unknown as CartItem
const X = [line(1, 2), line(2)]
const Y = [line(3)]
const SIG_X = cartItemsSignature(X)

type ClearIf = (matches: (items: readonly CartItem[]) => boolean, options?: { waitMs?: number }) => Promise<ClearIfResult>
// a cart that behaves as the provider promises: the question is asked of what the cart holds NOW
function fakeCart(initial: readonly CartItem[], events: string[] = []) {
  const cart = { items: initial, asked: 0 }
  const clearIf: ClearIf = async (matches) => {
    cart.asked++
    events.push('clearIf')
    let hit = false
    try { hit = matches(cart.items) } catch { hit = false }
    if (!hit) return { kind: 'kept', reason: 'changed' }
    cart.items = []
    return { kind: 'cleared' }
  }
  return { cart, clearIf }
}
const scripted = (result: ClearIfResult | Error, events: string[] = []): { clearIf: ClearIf; asked: () => number } => {
  let asked = 0
  return { asked: () => asked, clearIf: async () => { asked++; events.push('clearIf'); if (result instanceof Error) throw result; return result } }
}

// the key of the purchase A, as the page leaves it after the server named the order
function world(options: { slot?: 'owned' | 'other' | 'legacy' | 'absent' | 'forgotten' | 'damaged' | 'malformed'; record?: boolean } = {}) {
  const store = new MemoryStorage()
  const memory = createCheckoutKeyMemory()
  const key = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('A'), memory)
  const made = { key, signature: 'sig-A', totalCents: 4700 }
  switch (options.slot ?? 'owned') {
    case 'owned': stampCheckoutKeyOrder(store, made, A); break
    case 'other': stampCheckoutKeyOrder(store, made, B); break
    case 'legacy': break
    case 'absent': store.data.delete(KEY_SLOT); break
    case 'forgotten': store.data.set(KEY_SLOT, ''); break
    case 'damaged': store.data.set(KEY_SLOT, '{not json'); break
    case 'malformed': store.data.set(KEY_SLOT, JSON.stringify({ ...made, orderId: '../../x' })); break
  }
  if (options.record !== false) rememberPendingOrder(store, A, SIG_X)
  store.writes.length = 0
  return { store, key }
}
const settle = (store: KeyStorage | null, clearIf: ClearIf, over: Partial<Parameters<typeof settlePaidPurchase>[0]> = {}) => settlePaidPurchase({
  store: store as never, orderId: A, recordCartSignature: SIG_X, lifetime: { alive: () => true, signal: new AbortController().signal }, clearIf, navigator: {}, ...over,
})
const noWrites = (store: MemoryStorage, label: string) => assert.deepEqual(store.writes, [], `${label}: nothing was written`)

// ---- the way it should go ---------------------------------------------------------------------------------------------------------------------
test('S-09 A: the key in the slot is this payment\'s - the cart is emptied FIRST, the key forgotten SECOND, the memory of the order removed LAST', async () => {
  const { store, key } = world()
  const events: string[] = []
  store.events = events
  const { cart, clearIf } = fakeCart(X, events)
  assert.deepEqual(await settle(store, clearIf), { kind: 'applied' })
  assert.deepEqual(events, ['clearIf', 'write slot', 'remove pending'], 'cart, key, record - in this order')
  assert.deepEqual(cart.items, [])
  assert.equal(readCheckoutKeySlot(store).kind, 'forgotten')
  assert.equal(pendingOrderFor(store, A), null)
  assert.notEqual(key, '')
})

test('S-09 A2: an empty cart (cleared by hand, or by the other tab a moment ago) is "nothing to clear": the key is forgotten and the memory removed - the interrupted job is finished', async () => {
  const { store } = world()
  const { clearIf } = fakeCart([])
  assert.deepEqual(await settle(store, clearIf), { kind: 'applied' })
  assert.equal(readCheckoutKeySlot(store).kind, 'forgotten')
  assert.equal(pendingOrderFor(store, A), null)
})

test('S-09 B: the question put to the cart is "is this the cart that was paid, or an empty one?" - nothing more', async () => {
  const { store } = world()
  let predicate!: (items: readonly CartItem[]) => boolean
  await settle(store, async (matches) => { predicate = matches; return { kind: 'unconfirmed', reason: 'not_flushed' } })
  assert.equal(predicate(X), true)
  assert.equal(predicate([...X].reverse()), true, 'the same lines in another order are the same cart (the signature sorts them)')
  assert.equal(predicate([]), true)
  assert.equal(predicate(Y), false)
  assert.equal(predicate([...X, ...Y]), false)
  assert.equal(predicate([line(1, 3), line(2)]), false, 'another quantity is another cart')
})

test('S-07 C: the cart is not the paid one any more - nothing is emptied, the key stays, the memory of the order goes (it would only empty a cart that is not that one, later)', async () => {
  const { store, key } = world()
  const before = store.data.get(KEY_SLOT)
  const { cart, clearIf } = fakeCart([...X, ...Y])
  assert.deepEqual(await settle(store, clearIf), { kind: 'cart_changed' })
  assert.equal(cart.items.length, 3)
  assert.equal(store.data.get(KEY_SLOT), before, 'the slot is byte for byte the same')
  assert.equal(readCheckoutKeyEntry(store)?.key, key)
  assert.equal(pendingOrderFor(store, A), null)
})

test('S-07/S-10 D: no way of "not sure" empties, forgets or removes anything - the memory of the order and the key stay for the next time', async () => {
  const cases: Array<[string, ClearIfResult, PaidSettlement]> = [
    ['another tab saved a cart this one has not taken', { kind: 'kept', reason: 'other_tab' }, { kind: 'deferred', reason: 'cart_unsettled' }],
    ['not ready', { kind: 'unconfirmed', reason: 'not_ready' }, { kind: 'deferred', reason: 'unconfirmed' }],
    ['not flushed', { kind: 'unconfirmed', reason: 'not_flushed' }, { kind: 'deferred', reason: 'unconfirmed' }],
    ['not persisted', { kind: 'unconfirmed', reason: 'not_persisted' }, { kind: 'deferred', reason: 'unconfirmed' }],
  ]
  for (const [label, result, expected] of cases) {
    const { store } = world()
    const before = store.snapshot()
    assert.deepEqual(await settle(store, scripted(result).clearIf), expected, label)
    noWrites(store, label)
    assert.equal(store.snapshot(), before, label)
    assert.equal(isFinalSettlement(expected), false)
  }
  const thrown = world()
  assert.deepEqual(await settle(thrown.store, scripted(new Error('clearIf blew up')).clearIf), { kind: 'deferred', reason: 'unconfirmed' })
  noWrites(thrown.store, 'clearIf throws')
})

test('S-09 E: the cart WAS emptied but the slot is no longer this payment\'s when it comes to forgetting (it moved on in the meantime) - the key is left alone, the memory STAYS, the answer is "deferred"', async () => {
  const { store } = world()
  const takeOver = async (): Promise<ClearIfResult> => { store.data.set(KEY_SLOT, JSON.stringify({ signature: 'sig-B', totalCents: 100, key: strongKey('B'), orderId: B })); store.writes.length = 0; return { kind: 'cleared' } }
  const result = await settle(store, takeOver)
  assert.deepEqual(result, { kind: 'deferred', reason: 'key_not_forgotten' })
  noWrites(store, 'nothing after the cart')
  assert.equal(readCheckoutKeyEntry(store)?.orderId, B, 'the other purchase\'s key is untouched')
  assert.equal(pendingOrderFor(store, A)?.orderId, A)
})

// ---- S-09: a verified payment without local provenance -------------------------------------------------------------------------------------------------
test('S-09 F: the slot belongs to ANOTHER purchase - its key and the cart are not touched, the memory of A goes (nothing of A is left to protect), the answer is "not owned"', async () => {
  const { store } = world({ slot: 'other' })
  rememberPendingOrder(store, B, cartItemsSignature(Y))
  store.writes.length = 0
  const before = store.data.get(KEY_SLOT)
  const { cart, clearIf } = fakeCart(Y)
  assert.deepEqual(await settle(store, clearIf), { kind: 'not_owned' })
  assert.equal(cart.asked, 0, 'the cart is not even asked about')
  assert.deepEqual(cart.items, Y)
  assert.equal(store.data.get(KEY_SLOT), before, 'K_B byte for byte')
  assert.equal(pendingOrderFor(store, A), null)
  assert.equal(pendingOrderFor(store, B)?.orderId, B, 'the memory of B is not touched')
  assert.deepEqual(store.writes.map((w) => w.key), [PENDING], 'one write: the memory of A, nothing else')
  assert.equal(isFinalSettlement({ kind: 'not_owned' }), true)
})

test('S-09 G: no provenance - the slot is empty, forgotten, damaged, unreadable, written before R1-2, or names something that is not an order: NOTHING is touched, the memory of the order STAYS, and it is not "not owned"', async () => {
  const kinds: Array<[string, Parameters<typeof world>[0]]> = [
    ['absent', { slot: 'absent' }],
    ['empty placeholder', { slot: 'forgotten' }],
    ['damaged JSON', { slot: 'damaged' }],
    ['written before R1-2 (a valid key with no order)', { slot: 'legacy' }],
    ['an orderId that is not an order id', { slot: 'malformed' }],
  ]
  for (const [label, setup] of kinds) {
    const { store } = world(setup)
    const before = store.snapshot()
    const { cart, clearIf } = fakeCart(X)
    const result = await settle(store, clearIf)
    assert.deepEqual(result, { kind: 'provenance_unknown' }, label)
    assert.equal(isFinalSettlement(result), false, label)
    assert.equal(cart.asked, 0, `${label}: the cart is not asked about`)
    assert.deepEqual(cart.items, X, `${label}: the cart is not emptied`)
    noWrites(store, label)
    assert.equal(store.snapshot(), before, `${label}: storage byte for byte`)
    assert.equal(pendingOrderFor(store, A)?.orderId, A, `${label}: the memory of the order stays`)
  }
  // a storage that can not be read
  const { store } = world()
  store.failReads = true
  const { cart, clearIf } = fakeCart(X)
  assert.deepEqual(await settle(store, clearIf), { kind: 'provenance_unknown' }, 'unreadable')
  assert.equal(cart.asked, 0)
  assert.deepEqual(store.writes, [])
  assert.deepEqual(await settle(null, clearIf), { kind: 'provenance_unknown' }, 'no storage at all')
})

test('S-09 H: asked again (a reload, the next page) with no provenance - the same answer, no write, ever - and the key is never made by the settlement', async () => {
  const { store } = world({ slot: 'legacy' })
  const before = store.snapshot()
  for (let round = 0; round < 3; round++) assert.deepEqual(await settle(store, fakeCart(X).clearIf), { kind: 'provenance_unknown' })
  noWrites(store, 'three rounds')
  assert.equal(store.snapshot(), before)
  assert.equal(readCheckoutKeyEntry(store)?.orderId, undefined, 'and no provenance was invented')
})

test('S-09 I: a slot that carries this order AFTER the legacy recovery (the server named the order again and the page stamped it) is settled like any other', async () => {
  const { store, key } = world({ slot: 'legacy' })
  assert.deepEqual(await settle(store, fakeCart(X).clearIf), { kind: 'provenance_unknown' })
  stampCheckoutKeyOrder(store, { key, signature: 'sig-A', totalCents: 4700 }, A)       // what sendPurchase does when the server names the order
  store.writes.length = 0
  assert.deepEqual(await settle(store, fakeCart(X).clearIf), { kind: 'applied' })
})

test('S-08 J: the memory of the order is gone (another tab finished the job, or it expired) - nothing is done: no question to the cart, no write, a final answer without a note', async () => {
  const { store } = world({ record: false })
  const { cart, clearIf } = fakeCart(X)
  const result = await settle(store, clearIf)
  assert.deepEqual(result, { kind: 'already_settled' })
  assert.equal(isFinalSettlement(result), true)
  assert.equal(cart.asked, 0)
  noWrites(store, 'no memory')
})

test('S-08 K: two tabs get "paid" together - one finishes the job, the other finds it done: one question, one forgetting, one removal', async () => {
  const { store } = world()
  const hub = createHub()
  const events: string[] = []
  store.events = events
  const { cart, clearIf } = fakeCart(X, events)
  const nav = { locks: hub.manager }
  const [first, second] = await Promise.all([settle(store, clearIf, { navigator: nav }), settle(store, clearIf, { navigator: nav })])
  assert.deepEqual([first, second].map((r) => r.kind).sort(), ['already_settled', 'applied'])
  assert.deepEqual(events, ['clearIf', 'write slot', 'remove pending'])
  assert.deepEqual(cart.items, [])
})

// ---- the turn ---------------------------------------------------------------------------------------------------------------------------------------
function createHub() {
  const queue: Array<{ callback: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal }> = []
  let held = false
  const pump = () => {
    if (held) return
    const next = queue.shift()
    if (!next) return
    held = true
    Promise.resolve().then(() => next.callback()).then(next.resolve, next.reject).finally(() => { held = false; pump() })
  }
  const manager = {
    request(_name: string, opts: { signal?: AbortSignal }, callback: () => Promise<unknown>) {
      return new Promise<unknown>((resolve, reject) => {
        const entry = { callback, resolve, reject, signal: opts.signal }
        queue.push(entry)
        opts.signal?.addEventListener('abort', () => { const at = queue.indexOf(entry); if (at >= 0) { queue.splice(at, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) } }, { once: true })
        pump()
      })
    },
  }
  const occupy = () => { let release!: () => void; const owner = new Promise<void>((resolve) => { release = resolve }); void manager.request(PURCHASE_LOCK_NAME, {}, () => owner); return release }
  return { manager, occupy }
}

test('S-05/S-08 L: a turn that can not be had - the lock service is broken, or the page is gone - changes NOTHING and leaves the memory of the order where it is', async () => {
  const broken = world()
  const { clearIf, cart } = fakeCart(X)
  const brokenNav = { locks: { request() { throw Object.assign(new Error('x'), { name: 'SecurityError' }) } } }
  assert.deepEqual(await settle(broken.store, clearIf, { navigator: brokenNav }), { kind: 'deferred', reason: 'lock_error' })
  assert.equal(cart.asked, 0)
  noWrites(broken.store, 'broken lock service')
  assert.equal(pendingOrderFor(broken.store, A)?.orderId, A)
  const left = world()
  assert.deepEqual(await settle(left.store, clearIf, { lifetime: { alive: () => false, signal: new AbortController().signal } }), { kind: 'deferred', reason: 'page_left' })
  noWrites(left.store, 'page left')
  const gone = new AbortController()
  gone.abort()
  const abandoned = world()
  assert.deepEqual(await settle(abandoned.store, clearIf, { navigator: { locks: createHub().manager }, lifetime: { alive: () => true, signal: gone.signal } }), { kind: 'deferred', reason: 'abandoned' })
  noWrites(abandoned.store, 'abandoned')
})

test('S-08 M: another tab keeps the turn for too long - the wait ends, nothing is changed, the memory of the order STAYS; when the turn is free again the job is done, with no new payment', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { store } = world()
    const hub = createHub()
    const release = hub.occupy()
    const { cart, clearIf } = fakeCart(X)
    const waiting = settle(store, clearIf, { navigator: { locks: hub.manager }, waitMs: 5_000 })
    await flush()
    mock.timers.tick(5_000)
    assert.deepEqual(await waiting, { kind: 'deferred', reason: 'wait_expired' })
    noWrites(store, 'wait expired')
    assert.equal(cart.asked, 0)
    assert.equal(pendingOrderFor(store, A)?.orderId, A, 'the way back to the order is still there')
    release()
    await flush()
    assert.deepEqual(await settle(store, clearIf, { navigator: { locks: hub.manager } }), { kind: 'applied' })
  } finally { mock.timers.reset() }
})

test('S-08 N: the job never runs inside a render - the first thing it does is let the caller\'s turn finish', async () => {
  const { store } = world()
  let started = false
  const { clearIf } = fakeCart(X)
  const running = settle(store, async (matches) => { started = true; return clearIf(matches) })
  assert.equal(started, false, 'not synchronously, before the caller has returned')
  await running
  assert.equal(started, true)
})

// ---- the words ------------------------------------------------------------------------------------------------------------------------------------------
test('S-08/S-09 O: only a payment that is settled lets "pay" come back - a verified one that is not settled keeps it off, like one that is being confirmed', () => {
  assert.equal(blocksNewPayment('paid'), true)
  assert.equal(blocksNewPayment('confirming'), true)
  assert.equal(blocksNewPayment('attention'), true)
  assert.equal(blocksNewPayment('pending'), false)
  assert.equal(blocksNewPayment('canceled'), false)
  assert.equal(blocksNewPayment(null), false)
  const finals: PaidSettlement[] = [{ kind: 'applied' }, { kind: 'not_owned' }, { kind: 'cart_changed' }, { kind: 'already_settled' }]
  const open: PaidSettlement[] = [{ kind: 'provenance_unknown' }, { kind: 'deferred', reason: 'wait_expired' }, { kind: 'deferred', reason: 'page_left' }, { kind: 'deferred', reason: 'key_not_forgotten' }]
  for (const result of finals) assert.equal(isFinalSettlement(result), true, result.kind)
  for (const result of open) assert.equal(isFinalSettlement(result), false, result.kind)
})

// ---- the source: the order of the steps and what the job may not do ---------------------------------------------------------------------------------------
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const single = code(readFileSync(path.join(process.cwd(), 'lib/checkout-single-flight.ts'), 'utf8'))
const section = (() => {
  const start = single.indexOf('async function settleInTurn')
  assert.ok(start > 0, 'the job is written as `settleInTurn`')
  return single.slice(start, single.indexOf('\nexport', start) > 0 ? single.indexOf('\nexport', start) : single.length)
})()

test('IS-11/IS-14: in the job, the cart is asked about before the key is forgotten, and the key before the memory of the order is removed', () => {
  const cart = section.indexOf('clearIf(')
  const key = section.indexOf('forgetCheckoutKey(store, { orderId')
  const record = section.lastIndexOf('forgetPendingOrder(')
  assert.ok(cart > 0 && key > cart && record > key, `clearIf@${cart} < forgetCheckoutKey@${key} < forgetPendingOrder@${record}`)
})

test('IS-3: the job never sends a request, never leaves the page, never writes the cart, never makes a key', () => {
  assert.equal(/requestSession|\bfetch\b|location\.|window\.|resolveCheckoutKey|newCheckoutKey|rememberPendingOrder|stampCheckoutKeyOrder|mwv2:cart/.test(section), false)
  assert.equal(/\.clear\(\)|\bclear\(\)/.test(section), false, 'and the old `clear()` is not used for a payment')
})

test('IS-3: the key is forgotten for a verified payment in ONE place, with the order named; no component forgets a key or empties the cart for a payment any more', () => {
  const callers: string[] = []
  const walk = (dir: string) => {
    for (const item of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const relative = path.join(dir, item.name)
      if (item.isDirectory()) { walk(relative); continue }
      if (/\.(ts|tsx)$/.test(item.name) && !relative.endsWith('lib/checkout-client.ts') && /\bforgetCheckoutKey\(/.test(code(readFileSync(path.join(process.cwd(), relative), 'utf8')))) callers.push(relative.split(path.sep).join('/'))
    }
  }
  for (const dir of ['app', 'components', 'lib']) walk(dir)
  assert.deepEqual(callers.sort(), ['lib/checkout-single-flight.ts'])
  const forgets = (single.match(/forgetCheckoutKey\(/g) ?? []).length
  assert.equal(forgets, 2, 'one for "conflict" (the key that was refused) and one for a verified payment (the order named)')
  assert.equal((single.match(/forgetCheckoutKey\(store, \{ orderId/g) ?? []).length, 1)
  for (const file of ['components/checkout/CheckoutStatus.tsx', 'components/checkout/PendingPaymentNotice.tsx', 'components/checkout/usePaidSettlement.ts', 'components/checkout/HostedCheckout.tsx']) {
    const text = code(readFileSync(path.join(process.cwd(), file), 'utf8'))
    assert.equal(/\bclear\b|forgetCheckoutKey/.test(text.replace(/clearIf/g, '')), false, `${file} does not empty the cart or forget a key itself`)
  }
})

test('the memory of the orders: reading and writing it is unchanged by this work (the format is the one of before)', () => {
  const store = new MemoryStorage()
  rememberPendingOrder(store, A, 'items-signature')
  const raw = JSON.parse(store.data.get(PENDING)!) as Array<Record<string, unknown>>
  assert.deepEqual(Object.keys(raw[0]).sort(), ['at', 'cartSignature', 'orderId'])
  assert.equal(readPendingOrders(store)[0].orderId, A)
})

// ---- what the page says afterwards -------------------------------------------------------------------------------------------------------------------
const viewWith = (outcome: PaidSettlement | null): PaidView => ({ orderId: A, orderNumber: 12, recordCartSignature: SIG_X, outcome })
test('S-08/S-09 P: the note under the confirmation - four different things, told apart; the ones about THE CART PAID are not said about a cart the customer has since changed', () => {
  const same = SIG_X
  const other = 'another cart'
  assert.equal(paidNote(null, same), null, 'no payment verified, no note')
  assert.equal(paidNote(viewWith(null), same), null, 'the job is still going on: nothing to say yet')
  assert.equal(paidNote(viewWith({ kind: 'applied' }), same), 'emptied')
  assert.equal(paidNote(viewWith({ kind: 'applied' }), null), 'emptied', 'the cart is empty now - that is what it says')
  // "not emptied because it may hold a new purchase": only while the cart still holds what the order held
  assert.equal(paidNote(viewWith({ kind: 'not_owned' }), same), 'kept')
  assert.equal(paidNote(viewWith({ kind: 'not_owned' }), other), null)
  assert.equal(paidNote(viewWith({ kind: 'not_owned' }), null), null)
  // "this cart can not be tied to that payment": not "emptied", not "kept", not "pending"
  assert.equal(paidNote(viewWith({ kind: 'provenance_unknown' }), same), 'unlinked')
  assert.equal(paidNote(viewWith({ kind: 'provenance_unknown' }), other), null)
  // "the job is not finished": every reason says the same thing - and nothing is said about a cart that was changed
  for (const reason of ['page_left', 'wait_expired', 'abandoned', 'lock_error', 'cart_unsettled', 'unconfirmed', 'key_not_forgotten'] as const) {
    assert.equal(paidNote(viewWith({ kind: 'deferred', reason }), same), 'pending', reason)
    assert.equal(paidNote(viewWith({ kind: 'deferred', reason }), other), null, reason)
  }
  // nothing to add
  for (const kind of ['cart_changed', 'already_settled'] as const) assert.equal(paidNote(viewWith({ kind }), same), null, kind)
})

test('IC-8 / P7 (R1-2): a key that one tab forgot does not come back from the copy another tab still keeps in its memory - the placeholder wins', () => {
  const store = new MemoryStorage()
  const maker = createCheckoutKeyMemory()     // the tab that MADE the key keeps a copy of it in its memory (a page only remembers the keys it made itself)
  const other = createCheckoutKeyMemory()     // another tab of the same browser
  const first = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('A'), maker)
  assert.equal(maker.current?.key, first, 'the tab that made the key holds it in memory')
  assert.equal(forgetCheckoutKey(store, undefined, other), true, 'the other tab forgets it (a verified payment): the placeholder is written - the maker\'s memory is not reachable from there')
  assert.equal(store.data.get(KEY_SLOT), '')
  assert.equal(maker.current?.key, first, 'the maker still holds its copy')
  const next = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('B'), maker)
  assert.notEqual(next, first, 'the key of the paid purchase must not be used again, whatever a tab still holds in memory')
  assert.equal(next, strongKey('B'))
})

test('IS-6 (pins): the hook starts one settlement per order and per visit, and updates the page only if the page is still there', () => {
  const hook = readFileSync(path.join(process.cwd(), 'components/checkout/usePaidSettlement.ts'), 'utf8')
  // These two guards are defences: the pages never reach them today (the small component that asks the server tells the hook once per answer, and React ignores an update of a page that is
  // gone without a word) - which is why no browser test can tell a hook with them from one without. The pins say they are there, and why.
  assert.match(hook, /if \(!mine \|\| !mine\.alive \|\| started\.current\.has\(info\.orderId\)\) return/, 'one settlement per order and per visit')
  assert.match(hook, /if \(mine\.alive\) setView\(/, 'no update of a page that is gone')
  assert.match(hook, /started\.current\.add\(info\.orderId\)/)
})
