// R1-2 (S-07, S-10) – two tabs of one browser around "the server says a payment is verified": revision 3's way of settling it against the way of this change.
//
//   R3  (the reference, reproduced below as `settleR3`): under the turn, if the slot is this payment's and the cart AS LAST RENDERED is the paid one - forget the key and call clear(),
//       "in one synchronous step". clear() only QUEUES an update: the cart is rendered, and saved in the browser, later - one render and one effect later, with no upper bound if the tab is
//       slowed or frozen. The plan's audit (S-07) showed what that costs, and this file shows it again on a model, so that the fix is measured against something.
//   R4  (this change): settlePaidPurchase with the real engine behind clearIf - ask the cart a question, learn that the new state was COMMITTED and the saved cart reads back empty, and
//       only then forget the key, and last of all the memory of the order.
//
// What is REAL here: lib/cart-clear-if.ts (the engine), lib/checkout-single-flight.ts (settlePaidPurchase) and the storage primitives (lib/checkout-client.ts, lib/order-status-client.ts).
// What is a MODEL: the CartProvider (a queue of updates, a render, a passive effect that saves the cart LATER, the `storage` listener that adopts whatever another tab saved) and the
// browser's shared storage, whose `storage` events are delivered only when the test says so (the order of delivery is the whole point). The real provider on the real React is tried in
// tests/e2e/cart-clear-if.responsive.spec.ts and, for what the tabs do to each other, tests/e2e/cart-sync-characterization.responsive.spec.ts.
//
// Naming: X = the cart that was paid for; Y = a line added afterwards; A = the paid purchase, B = a purchase started later. U1 = "a FULL cart saved, its key forgotten" - the state in which
// "pay" would create a second order for the same things; S1 = "an EMPTY cart saved, the key still kept" - the safe state.
//
// Three groups of tests, and the difference between them matters:
//   * I-1..I-4: what the change MUST keep from happening, and what revision 3 did - asserted both ways;
//   * residual windows (R-1, R-2): what the change narrows and does NOT close - pinned as they are, so that nobody takes them for fixed;
//   * I-5, I-6 and the bfcache case: what the CART does between tabs with no payment in sight (CART-SYNC, docs/CHECKLIST-PRELANCIO.md) - pinned as they are at HEAD, not changed here.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { CartItem } from '../components/cart/CartProvider'
import { createClearIfEngine, type ClearIfEngine } from '../lib/cart-clear-if'
import {
  cartItemsSignature, createCheckoutKeyMemory, forgetCheckoutKey, readCheckoutKeySlot, resolveCheckoutKey, stampCheckoutKeyOrder, type CheckoutKeyMemory, type KeyStorage,
} from '../lib/checkout-client'
import { settlePaidPurchase, type PaidSettlement } from '../lib/checkout-single-flight'
import { forgetPendingOrder, pendingOrderFor, rememberPendingOrder } from '../lib/order-status-client'

const CART = 'mwv2:cart'
const SLOT = 'mw:checkout-key:v1'
const A = 'clorderAAAAAAAAAAAAAAAA'
const B = 'clorderBBBBBBBBBBBBBBBB'
const strongKey = (seed: string) => `k${seed.padEnd(32, 'abcdefghijklmnopqrstuvwxyzABCDEF').slice(0, 32)}`
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const line = (n: number, qty = 1) => ({
  cartItemId: `ci-${n}`, modelId: `clmodelmodelmodel0000${n}`, partId: null, partName: null, title: `Model ${n}`, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
}) as unknown as CartItem
const X = [line(1, 2), line(2)]
const Y = line(3)
const XY = [...X, Y]
const SIG_X = cartItemsSignature(X)
const ids = (items: readonly CartItem[] | null) => (items === null ? null : items.map((item) => item.cartItemId))
const XIDS = ids(X)
const XYIDS = ids(XY)

// ---- the browser: one storage, shared; the events it sends are held until a tab is told to take them ---------------------------------------------------------------------------------
type Snapshot = { cart: string[] | null; key: 'K_A' | 'K_B' | 'forgotten' | 'none'; records: string[] }

class Browser implements KeyStorage {
  data = new Map<string, string>()
  tabs: Tab[] = []
  history: Snapshot[] = []                                   // the persistent state after EVERY change: each one is a state a tab that is closed right then leaves behind
  cartWrites: Array<{ by: string; text: string }> = []
  private writer: Tab | null = null
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { const changed = this.data.get(key) !== value; this.data.set(key, value); this.after(key, value, changed) }
  removeItem(key: string) { const had = this.data.delete(key); this.after(key, null, had) }
  saveCartAs(tab: Tab, text: string) { this.writer = tab; this.cartWrites.push({ by: tab.name, text }); try { this.setItem(CART, text) } finally { this.writer = null } }
  private after(key: string, value: string | null, changed: boolean) {
    this.history.push(this.snapshot())
    // the browser tells the OTHER tabs, and only when the text changed
    if (key !== CART || !changed) return
    for (const tab of this.tabs) if (tab !== this.writer) tab.inbox.push({ key, newValue: value })
  }
  snapshot(): Snapshot {
    const raw = this.data.get(CART)
    const slotText = this.data.get(SLOT)
    let key: Snapshot['key'] = 'none'
    if (slotText === '') key = 'forgotten'
    else if (slotText) { try { key = (JSON.parse(slotText) as { key: string }).key === strongKey('A') ? 'K_A' : 'K_B' } catch { key = 'none' } }
    const records = [A, B].filter((id) => pendingOrderFor(this, id) !== null)
    return { cart: raw === undefined ? null : (JSON.parse(raw) as CartItem[]).map((item) => item.cartItemId), key, records }
  }
  now() { return this.snapshot() }
}

// ---- one tab: the provider's queue, render, passive effect and storage listener, as components/cart/CartProvider.tsx has them ---------------------------------------------------
type Update = (prev: readonly CartItem[]) => readonly CartItem[]
class Tab {
  items: readonly CartItem[]
  queue: Update[] = []
  inbox: Array<{ key: string; newValue: string | null }> = []
  ticks: number[] = []
  committedTick = 0
  lastWritten: string
  persistPending = false
  observePending = false
  hops: Array<() => void> = []
  engine: ClearIfEngine<CartItem>
  constructor(readonly name: string, readonly browser: Browser, initial: readonly CartItem[]) {
    this.items = initial
    this.lastWritten = JSON.stringify(initial)
    browser.tabs.push(this)
    this.engine = createClearIfEngine<CartItem>({
      readPersisted: () => ({ available: true, raw: browser.getItem(CART) }),
      lastWritten: () => this.lastWritten,
      dispatch: ({ tick, apply }) => { this.ticks.push(tick); this.queue.push((prev) => apply(prev)) },
      nextTask: () => new Promise<void>((resolve) => { this.hops.push(resolve) }),
      setTimer: () => ({}),
      clearTimer: () => undefined,
    })
  }
  // useState's setItems: a value or an updater, QUEUED
  setItems(update: readonly CartItem[] | Update) { this.queue.push(typeof update === 'function' ? update : () => update) }
  add(item: CartItem) { this.setItems((prev) => [...prev, item]) }
  clear() { this.setItems([]) }
  // the provider's `storage` listener: adopt whatever another tab saved, unless it is what this tab wrote last - without looking at its own state
  receive() {
    for (const event of this.inbox.splice(0)) {
      if (event.key !== CART) continue
      if (event.newValue !== null && event.newValue === this.lastWritten) continue
      let next: CartItem[] = []
      try { const parsed = event.newValue ? JSON.parse(event.newValue) : null; if (Array.isArray(parsed)) next = parsed } catch { /* damaged: an empty cart */ }
      this.setItems(next)
    }
  }
  // a render: every queued update, in order; a commit if the list changed or a tick was set
  render() {
    if (this.queue.length === 0 && this.ticks.length === 0) return
    let next = this.items
    for (const update of this.queue.splice(0)) next = update(next)
    if (next !== this.items) { this.items = next; this.persistPending = true; this.observePending = true }
    if (this.ticks.length > 0) { this.committedTick = Math.max(this.committedTick, ...this.ticks.splice(0)); this.observePending = true }
  }
  // the passive effects of the commit: first the one that SAVES the cart, then the one that lets the engine look (declared after it in the provider)
  flushEffects() {
    if (this.persistPending) {
      this.persistPending = false
      const text = JSON.stringify(this.items)
      this.lastWritten = text
      this.browser.saveCartAs(this, text)
    }
    if (this.observePending) { this.observePending = false; this.engine.observe({ items: this.items, tick: this.committedTick }) }
  }
  step() { this.receive(); this.render(); this.flushEffects() }                                     // a quiet moment: take events, render, run the effects
  async hop() { const resolve = this.hops.shift(); assert.ok(resolve, `${this.name}: the engine asked for a fresh task`); resolve(); await flush() }
  // a tab that never hears about what the others save (restored from the back/forward cache, a listener not yet attached): its inbox is thrown away
  deaf() { this.inbox.length = 0 }
}

function world() {
  const browser = new Browser()
  const memory = createCheckoutKeyMemory()
  browser.data.set(CART, JSON.stringify(X))
  const key = resolveCheckoutKey(browser, 'sig-A', 4700, () => strongKey('A'), memory)
  stampCheckoutKeyOrder(browser, { key, signature: 'sig-A', totalCents: 4700 }, A)
  rememberPendingOrder(browser, A, SIG_X)
  const t1 = new Tab('T1', browser, X)
  const t2 = new Tab('T2', browser, X)
  browser.history.length = 0
  browser.cartWrites.length = 0
  return { browser, memory, t1, t2 }
}
// what the other tab's "pay" leaves behind for the purchase B: the slot with B's key and order, and the memory of the order
function startPurchaseB(browser: Browser, cart: readonly CartItem[]) {
  const key = resolveCheckoutKey(browser, 'sig-B', 5100, () => strongKey('B'), createCheckoutKeyMemory())
  stampCheckoutKeyOrder(browser, { key, signature: 'sig-B', totalCents: 5100 }, B)
  rememberPendingOrder(browser, B, cartItemsSignature(cart as CartItem[]))
}

// ---- the two ways of settling a verified payment ----------------------------------------------------------------------------------------------------------------------------------
// Revision 3: slot proved, cart AS LAST RENDERED is the paid one -> forget the key, queue clear(), remove the memory of the order. All "synchronous"; the cart is saved LATER.
function settleR3(tab: Tab, memory: CheckoutKeyMemory): 'applied' | 'not_owned' | 'cart_changed' {
  const slot = readCheckoutKeySlot(tab.browser)
  if (slot.kind !== 'entry' || slot.entry.orderId !== A) return 'not_owned'
  if (cartItemsSignature(tab.items as CartItem[]) !== SIG_X) return 'cart_changed'
  forgetCheckoutKey(tab.browser, { orderId: A }, memory)
  tab.clear()
  forgetPendingOrder(tab.browser, A)
  return 'applied'
}
// This change: the real settlement, the real engine behind clearIf. Starts it and returns its promise; the test moves the tab.
function settleR4(tab: Tab, memory: CheckoutKeyMemory, store: KeyStorage = tab.browser): Promise<PaidSettlement> {
  return settlePaidPurchase({
    store: store as never, orderId: A, recordCartSignature: SIG_X, lifetime: { alive: () => true, signal: new AbortController().signal },
    clearIf: (matches, options) => tab.engine.run(matches, options), navigator: {}, memory,
  })
}
// the settlement is waiting for its fresh task: let it have it
async function arm(tab: Tab) { await flush(); await tab.hop() }

// ---- the control: nothing else happens -----------------------------------------------------------------------------------------------------------------------------------------
test('S7-1: no one else touches the cart - both ways end with an empty saved cart, the key forgotten and the memory of the order gone; this change takes the steps cart -> key -> memory', async () => {
  const r3 = world()
  assert.equal(settleR3(r3.t1, r3.memory), 'applied')
  r3.t1.step()
  assert.deepEqual(r3.browser.now(), { cart: [], key: 'forgotten', records: [] })

  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  r4.t1.step()
  assert.deepEqual(await done, { kind: 'applied' })
  assert.deepEqual(r4.browser.now(), { cart: [], key: 'forgotten', records: [] })
  assert.deepEqual(r4.browser.history.map((s) => `${s.cart === null ? '-' : s.cart.length === 0 ? 'empty' : 'full'}/${s.key}/${s.records.join('') ? 'record' : 'no-record'}`), [
    'empty/K_A/record',          // 1. the cart is saved empty (the engine read it back)
    'empty/forgotten/record',    // 2. the key is forgotten
    'empty/forgotten/no-record', // 3. the memory of the order is removed - last
  ], 'every state a closed tab can leave behind is on this list, in this order')
})

// ---- I-1 / I-2: the other tab changed the cart before this one looked ---------------------------------------------------------------------------------------------------------
test('I-1: T1 decides to settle and is then slowed (or frozen); meanwhile T2 saves X+Y and starts the purchase B - revision 3 empties T2\'s cart when T1 wakes up, this change finds the saved cart is not its own and leaves everything', async () => {
  // revision 3: the decision and the forgetting of the key happen NOW; the cart is saved whenever T1 gets to render
  const r3 = world()
  assert.equal(settleR3(r3.t1, r3.memory), 'applied', 'T1 decides from its last render, which shows X')
  r3.t2.add(Y); r3.t2.step()                                                     // T2: X+Y rendered and saved
  startPurchaseB(r3.browser, XY)                                                 // T2: B's key and order
  r3.t1.render(); r3.t1.flushEffects()                                           // T1 wakes up: it renders [] and its effect SAVES it - over X+Y (T2's event for X+Y is still on its way)
  r3.t2.step()                                                                   // T2 follows what the other tab saved
  assert.deepEqual(ids(r3.t2.items), [], 'revision 3: T2 shows an empty cart - the line it added is gone')
  assert.deepEqual(r3.browser.now(), { cart: [], key: 'K_B', records: [B] }, 'B\'s key and order are intact, and the cart they were for is not: "pay" for B finds nothing')

  // this change: the same moments. The settlement is asked for first; T1 is slow to get its fresh task
  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await flush()
  assert.equal(r4.t1.hops.length, 1, 'T1 waits for its fresh task; nothing is queued, nothing is decided about the cart yet')
  r4.t2.add(Y); r4.t2.step()
  startPurchaseB(r4.browser, XY)
  await r4.t1.hop()                                                              // T1 wakes up: the gate looks at what is saved NOW
  assert.deepEqual(await done, { kind: 'deferred', reason: 'cart_unsettled' })
  assert.equal(r4.t1.queue.length + r4.t1.ticks.length, 0, 'and nothing was queued that could empty the cart later')
  assert.deepEqual(r4.browser.cartWrites.map((w) => w.by), ['T2'], 'T1 saved nothing')
  r4.t1.step()
  assert.deepEqual(ids(r4.t1.items), XYIDS, 'T1 follows T2')
  assert.deepEqual(r4.browser.now(), { cart: XYIDS, key: 'K_B', records: [A, B] }, 'B untouched; the memory of A STAYS (the job is not final) - the next page that sees A finishes it, without emptying B')
})

test('I-2: T2 saved X+Y and T1 has not taken the event - revision 3 judges from T1\'s LAST RENDER (X) and empties X+Y; this change sees a saved cart that T1 did not write: nothing asked, nothing forgotten, the memory STAYS', async () => {
  const r3 = world()
  r3.t2.add(Y); r3.t2.step()                                                     // saved X+Y; T1's event is on its way
  assert.equal(settleR3(r3.t1, r3.memory), 'applied', 'T1\'s last render is still X: "it is the paid cart"')
  r3.t1.render(); r3.t1.flushEffects()                                           // T1 saves [] over X+Y
  r3.t2.step()
  assert.deepEqual(ids(r3.t2.items), [], 'revision 3: the line T2 added is gone')

  const r4 = world()
  r4.t2.add(Y); r4.t2.step()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  assert.deepEqual(await done, { kind: 'deferred', reason: 'cart_unsettled' })
  assert.deepEqual(r4.browser.cartWrites.map((w) => w.by), ['T2'], 'T1 saved nothing')
  assert.deepEqual(r4.browser.now(), { cart: XYIDS, key: 'K_A', records: [A] }, 'cart as T2 saved it, key kept, memory of the order kept: the next page finishes the job')
  assert.equal(r4.t1.queue.length + r4.t1.ticks.length, 0, 'and nothing was queued that could empty the cart later')
  // the next page: T1 has taken T2's change; the cart is not the paid one, so the job ends without emptying anything
  r4.t1.step()
  assert.deepEqual(ids(r4.t1.items), XYIDS)
  const again = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  r4.t1.step()
  assert.deepEqual(await again, { kind: 'cart_changed' })
  assert.deepEqual(r4.browser.now(), { cart: XYIDS, key: 'K_A', records: [] }, 'cart untouched; the key stays (the server still refuses a second order for it); the memory goes')
})

test('S7-5: B was started (slot and memory of B) BEFORE the settlement\'s turn: it finds a slot that is not A\'s - nothing of B is touched, the cart is not even asked about, the memory of A goes', async () => {
  const r4 = world()
  startPurchaseB(r4.browser, X)                           // the same cart, another delivery: B's key and order
  const before = r4.browser.data.get(SLOT)
  const done = settleR4(r4.t1, r4.memory)
  await flush()
  assert.deepEqual(await done, { kind: 'not_owned' })
  assert.equal(r4.browser.data.get(SLOT), before, 'the slot is byte for byte what B left')
  assert.equal(r4.t1.hops.length, 0, 'the cart was not even asked about')
  assert.deepEqual(r4.browser.cartWrites, [])
  assert.deepEqual(r4.browser.now(), { cart: XIDS, key: 'K_B', records: [B] })
})

// ---- I-3: an update is already queued when the question is asked --------------------------------------------------------------------------------------------------------------
test('I-3a: T1 has queued the adoption of T2\'s X+Y but not rendered it - revision 3\'s clear() is queued AFTER it and wins; this change sees the saved cart is not its own and leaves everything', async () => {
  const r3 = world()
  r3.t2.add(Y); r3.t2.step()
  r3.t1.receive()                                         // the adoption of X+Y is queued in T1 ...
  assert.equal(settleR3(r3.t1, r3.memory), 'applied')     // ... and R3 decides from the LAST RENDER (X), then queues clear() behind it
  r3.t1.step()
  assert.deepEqual(r3.t1.items, [], 'adoption, then clear(): X+Y is emptied')
  assert.deepEqual(r3.browser.now().cart, [], 'and saved empty')

  const r4 = world()
  r4.t2.add(Y); r4.t2.step()
  r4.t1.receive()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  assert.deepEqual(await done, { kind: 'deferred', reason: 'cart_unsettled' })
  r4.t1.step()
  assert.deepEqual(ids(r4.t1.items), XYIDS, 'the adoption goes through; nothing empties it')
  assert.deepEqual(r4.browser.now(), { cart: XYIDS, key: 'K_A', records: [A] })
})

test('I-3b: T1 has taken and rendered T2\'s X+Y before the question - the gate says go, the question is asked of X+Y, the answer is "not the paid cart": kept, nothing emptied, the key stays', async () => {
  const r4 = world()
  r4.t2.add(Y); r4.t2.step()
  r4.t1.step()                                            // T1 adopts and saves X+Y (the same text: nothing new for the others)
  assert.deepEqual(ids(r4.t1.items), XYIDS)
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  r4.t1.step()                                            // the tick and the updater are rendered: the updater sees X+Y and keeps it
  assert.deepEqual(await done, { kind: 'cart_changed' })
  assert.deepEqual(ids(r4.t1.items), XYIDS)
  assert.deepEqual(r4.browser.now(), { cart: XYIDS, key: 'K_A', records: [] })
})

test('I-3c: the adoption arrives AFTER the question was queued and before it was rendered: the order of the queue is tick, question, adoption - the adoption has the last word, nothing is lost', async () => {
  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)                                        // gate: go; the tick and the question are queued, not rendered
  r4.t2.add(Y); r4.t2.step()                              // T2 saves X+Y now ...
  r4.t1.receive()                                         // ... and T1 queues its adoption behind the question
  assert.equal(r4.t1.queue.length, 2)
  r4.t1.render(); r4.t1.flushEffects()
  assert.deepEqual(ids(r4.t1.items), XYIDS, 'the question emptied X, the adoption then put X+Y back')
  assert.deepEqual(await done, { kind: 'cart_changed' }, 'the committed state is not empty and is not the paid cart: nothing was emptied, and the answer says so')
  assert.deepEqual(r4.browser.now(), { cart: XYIDS, key: 'K_A', records: [] })
})

// ---- I-4: the order of the steps - what a tab that is closed at any moment leaves behind -----------------------------------------------------------------------------------------
test('I-4: closed at ANY step - revision 3 can leave a FULL cart with its key forgotten (U1, a second order for the same things); this change never does', async () => {
  const isU1 = (s: Snapshot) => s.cart !== null && s.cart.length > 0 && s.key === 'forgotten'

  const r3 = world()
  settleR3(r3.t1, r3.memory)                              // "one synchronous step": the key is forgotten, clear() is queued - the cart is NOT yet saved
  r3.t1.step()
  assert.ok(r3.browser.history.some(isU1), 'revision 3: between the forgetting of the key and the saving of the cart the saved cart is full and the key is gone - closing the tab here is U1')

  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  r4.t1.step()
  await done
  assert.equal(r4.browser.history.some(isU1), false, 'this change: no state on the way is U1')
  assert.ok(r4.browser.history.length >= 3)
})

test('I-4b: interrupted after the cart was emptied and before the key was forgotten (S1): the next page that sees the order finishes the job - the empty cart counts as "nothing to clear"', async () => {
  const r4 = world()
  const first = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  r4.t1.step()
  await first
  // pretend the tab was closed right after the cart was saved empty: the key is back as it was, the memory of the order too
  r4.browser.data.set(SLOT, JSON.stringify({ signature: 'sig-A', totalCents: 4700, key: strongKey('A'), orderId: A }))
  rememberPendingOrder(r4.browser, A, SIG_X)
  assert.deepEqual(r4.browser.now(), { cart: [], key: 'K_A', records: [A] }, 'S1: an empty saved cart, the key kept, the memory kept')
  const t3 = new Tab('T3', r4.browser, [])               // a new page
  const again = settleR4(t3, r4.memory)
  await arm(t3)
  t3.step()
  assert.deepEqual(await again, { kind: 'applied' })
  assert.deepEqual(r4.browser.now(), { cart: [], key: 'forgotten', records: [] })
})

// ---- residual windows: narrowed, NOT closed -----------------------------------------------------------------------------------------------------------------------------------
test('R-1 (residual, NOT closed): the other tab saves X+Y in the few milliseconds between this tab\'s render and its effect, and its event has not arrived - this tab\'s save goes over it', async () => {
  // What revision 3 left open for as long as a tab can be slowed (unbounded), this change leaves open for one render and one effect. It does not need a payment to exist: it is two tabs
  // saving a whole cart without looking at each other (CART-SYNC). Pinned so that it is read as what it is.
  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)                                        // gate passed: the saved cart was T1's own
  r4.t1.render()                                          // T1's state is empty now ... its effect has not run
  r4.browser.data.set(CART, JSON.stringify(XY))           // ... and T2's save of X+Y lands at the browser (T2's page saw it first; T1's event is still on its way)
  r4.t1.flushEffects()                                    // T1's effect saves its cart
  assert.deepEqual(await done, { kind: 'applied' }, 'the engine read back an empty saved cart: that is what it proves, and it is true')
  assert.deepEqual(r4.browser.now().cart, [], 'the line T2 had just added is gone from the saved cart')
})

test('R-2 (residual, NOT closed): a tab that never heard of the settlement brings the paid cart back with its next change (back/forward cache, a listener not yet attached) - the key is already forgotten', async () => {
  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)
  r4.t1.step()
  assert.deepEqual(await done, { kind: 'applied' })
  r4.t2.deaf()                                            // T2 was restored from the cache, or never took the event
  r4.t2.setItems((prev) => prev.map((item) => ({ ...item, title: `${item.title} (edited)` })))
  r4.t2.step()                                            // T2's first change saves its WHOLE old cart, edited
  r4.t1.step()                                            // T1 follows
  assert.deepEqual(ids(r4.t1.items), XIDS, 'the paid cart is back in T1')
  assert.deepEqual(r4.browser.now(), { cart: XIDS, key: 'forgotten', records: [] }, 'with the key forgotten: "pay" would start a new purchase of what was already paid - CART-SYNC, to be decided before launch')
})

// ---- the slot changes hands while the settlement is in progress ---------------------------------------------------------------------------------------------------------------
test('S7-6: the slot changes hands AFTER the settlement read it (no turn to keep them apart): the key is forgotten only if the slot STILL is A\'s when the time comes - B\'s key survives, and the job is reported unfinished', async () => {
  const r4 = world()
  const done = settleR4(r4.t1, r4.memory)
  await arm(r4.t1)                                        // slot read: A's. gate: go.
  startPurchaseB(r4.browser, X)                           // B is started now (a browser without Web Locks, or a lock that did not hold)
  r4.t1.step()                                            // the cart is emptied and saved empty
  assert.deepEqual(await done, { kind: 'deferred', reason: 'key_not_forgotten' })
  assert.equal(r4.browser.now().key, 'K_B', 'B\'s key is untouched')
  assert.deepEqual(r4.browser.now().records, [A, B], 'the memory of A stays (the job is not final); B\'s is B\'s')
})

// ---- I-5 / I-6 / the cart between tabs - what HEAD does, pinned (CART-SYNC) --------------------------------------------------------------------------------------------------------------
test('I-5 (CART-SYNC, unchanged): storage events delivered out of order - the tab follows the LAST one it was given and saves it, whatever it was; nothing in this change touches that', () => {
  for (const order of [['[]', JSON.stringify([Y])], [JSON.stringify([Y]), '[]']] as const) {
    const browser = new Browser()
    browser.data.set(CART, JSON.stringify(X))
    const tab = new Tab('T', browser, X)
    for (const text of order) { tab.inbox.push({ key: CART, newValue: text }); tab.step() }
    assert.equal(tab.lastWritten, order[1], 'the last event is the one adopted and saved back')
    assert.equal(browser.data.get(CART), order[1])
    assert.deepEqual(browser.cartWrites.map((w) => w.text), [order[0], order[1]], 'each adopted value is written back, even though it came from someone else')
  }
  // both events in the queue before one render: only the last survives
  const browser = new Browser(); browser.data.set(CART, JSON.stringify(X)); const tab = new Tab('T', browser, X)
  tab.inbox.push({ key: CART, newValue: '[]' }, { key: CART, newValue: JSON.stringify([Y]) })
  tab.step()
  assert.deepEqual(ids(tab.items), ['ci-3'])
})

test('I-5b (CART-SYNC, unchanged): two tabs change the cart at the same moment - each saves its own whole list, the other follows, and one of the two edits is lost', () => {
  const { browser, t1, t2 } = world()
  t1.add(Y); t1.render()                                  // both render before either effect runs
  t2.setItems((prev) => prev.map((item, i) => (i === 0 ? { ...item, title: 'edited in T2' } : item))); t2.render()
  t1.flushEffects(); t2.flushEffects()                    // T1 saves X+Y, then T2 saves X-edited over it
  t1.receive(); t2.receive(); t1.render(); t2.render()
  const saved = JSON.parse(browser.data.get(CART) as string) as CartItem[]
  assert.equal(saved.length, 2, 'T2\'s save is the one standing: the line T1 added is gone from the saved cart')
  assert.equal(saved[0].title, 'edited in T2')
})

test('I-6 (residual L-2, NOT closed): a tab whose view of the slot is stale - B has just taken the slot, and this tab still reads A\'s - forgets B\'s key and (same items) empties B\'s cart', async () => {
  // Browsers do not promise that a write made by one process is visible to the reads of another at once (the HTML standard says not to count on it). The settlement reads the slot
  // inside the turn and again when it forgets the key; both reads are served by the same stale view here. Measuring how long such a view lives in real browsers is part of R1-6.
  const r4 = world()
  const stale = {
    getItem: (key: string) => (key === SLOT ? JSON.stringify({ signature: 'sig-A', totalCents: 4700, key: strongKey('A'), orderId: A }) : r4.browser.getItem(key)),
    setItem: (key: string, value: string) => r4.browser.setItem(key, value),
    removeItem: (key: string) => r4.browser.removeItem(key),
  } as KeyStorage
  startPurchaseB(r4.browser, X)                           // the real storage holds B's slot; T1's view does not know
  const done = settleR4(r4.t1, r4.memory, stale)
  await arm(r4.t1)
  r4.t1.step()
  assert.deepEqual(await done, { kind: 'applied' })
  assert.equal(r4.browser.now().key, 'forgotten', 'B\'s key was forgotten by A\'s settlement - the known residual: the window is the lifetime of a stale view, milliseconds, not zero')
})
