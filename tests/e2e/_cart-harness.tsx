// The browser harness of tests/e2e/cart-clear-if.responsive.spec.ts (S-10): the REAL CartProvider mounted by the REAL React, with a handle on everything the rules of S-10 are about -
// every commit, every text saved at the key of the cart, every run of the question the page asks, and (through window.__sched, installed before this script) the scheduler of React,
// which the test can stop and start again. It is bundled by tests/e2e/_cart-harness-build.ts. It decides nothing: the assertions are in the spec.
import React, { StrictMode, useEffect, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import CartProvider, { useCart, type CartItem } from '@/components/cart/CartProvider'
import { cartItemsSignature } from '@/lib/checkout-client'

const CART_KEY = 'mwv2:cart'
type Cart = ReturnType<typeof useCart>

type Harness = {
  latest: Cart | null
  layoutRenders: number
  commits: Array<{ at: number; count: number }>      // layout effect: runs INSIDE the commit
  passive: Array<{ at: number; count: number }>      // passive effect: after the commit
  writes: string[]                                    // every text saved at the key of the cart
  failWrites: boolean
  failReads: boolean
  calls: Record<string, number>
  callTimes: Array<{ name: string; at: number }>
  callEvents: Array<string | null>                    // the event that was current (window.event) each time a predicate was asked: null = outside any event
  timerFiredAt: number[]
  results: Record<number, unknown>
  resultAt: Record<number, number>
  nextId: number
  paidSignature: string
  errors: string[]
  root: Root | null
  naive: { calls: () => number; plain: () => void; withTick: () => void; guardedSync: () => void; adopt: (items: number[]) => void } | null
  cancelNaive: () => void
  naiveText: () => string | null
  mount: (options: { strict: boolean; seed?: unknown; naive?: boolean }) => void
  unmount: () => void
  clearIf: (name: string, options?: { waitMs?: number }) => number
  clearNow: () => void
  add: (n: number) => void
  setPaid: (items: unknown) => void
  items: () => CartItem[]
  persisted: () => string | null
  externalWrite: (text: string) => void
  fireStorage: (text: string | null) => void
  storageSeen: number                                  // how many `storage` events this page has been given (real ones from other pages, and the ones fireStorage makes)
  ready: () => boolean
}

declare global {
  interface Window {
    __h: Harness
    // installed before the page's scripts (tests/e2e/_cart-harness-build.ts): the messages the scheduler of React posts to itself are held while it is frozen
    __sched: { frozen: boolean; held: unknown[]; posted: number; freeze: () => void; release: () => void }
  }
}

const nativeSetItem = Storage.prototype.setItem
const nativeGetItem = Storage.prototype.getItem
const nativeSetTimeout = window.setTimeout.bind(window)

const h: Harness = {
  latest: null, layoutRenders: 0, commits: [], passive: [], writes: [], failWrites: false, failReads: false, calls: {}, callTimes: [], callEvents: [], timerFiredAt: [], results: {}, resultAt: {}, nextId: 0,
  paidSignature: '', errors: [], root: null, naive: null, cancelNaive: () => undefined, naiveText: () => null,
  mount: () => undefined, unmount: () => undefined, clearIf: () => 0, clearNow: () => undefined, add: () => undefined, setPaid: () => undefined, items: () => [],
  persisted: () => null, externalWrite: () => undefined, fireStorage: () => undefined, storageSeen: 0, ready: () => false,
}
window.__h = h
window.addEventListener('storage', () => { h.storageSeen++ })

Storage.prototype.setItem = function setItem(this: Storage, key: string, value: string) {
  if (key === CART_KEY) {
    h.writes.push(value)
    if (h.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
  }
  return nativeSetItem.call(this, key, value)
}
Storage.prototype.getItem = function getItem(this: Storage, key: string) {
  if (key === CART_KEY && h.failReads) throw new DOMException('Access is denied for this document.', 'SecurityError')
  return nativeGetItem.call(this, key)
}
const nativeConsoleError = console.error.bind(console)
console.error = (...args: unknown[]) => { h.errors.push(args.map((a) => String(a)).join(' ').slice(0, 300)); nativeConsoleError(...args) }
window.addEventListener('error', (event) => { h.errors.push(`error: ${event.message}`) })
// every timer callback of the page leaves the time it ran: the spec uses it to show that nothing ran between a render and its commit
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => nativeSetTimeout(typeof handler === 'function'
  ? (...args: unknown[]) => { h.timerFiredAt.push(performance.now()); return (handler as (...a: unknown[]) => unknown)(...args) }
  : handler, timeout, ...rest)) as typeof window.setTimeout

const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* a slow predicate */ } }
const signatureOf = (items: readonly CartItem[]) => cartItemsSignature(items as CartItem[])

function predicate(name: string): (items: readonly CartItem[]) => boolean {
  const note = () => { h.calls[name] = (h.calls[name] ?? 0) + 1; h.callTimes.push({ name, at: performance.now() }); h.callEvents.push(window.event ? window.event.type : null) }
  const isPaid = (items: readonly CartItem[]) => items.length === 0 || signatureOf(items) === h.paidSignature
  switch (name) {
    case 'always': return () => { note(); return true }
    case 'never': return () => { note(); return false }
    case 'throws': return () => { note(); throw new Error('predicate failed') }
    case 'slow': return (items) => { note(); busy(40); return isPaid(items) }
    default: return (items) => { note(); return isPaid(items) }
  }
}

function Probe() {
  const cart = useCart()
  useLayoutEffect(() => { h.latest = cart; h.layoutRenders++ })
  useLayoutEffect(() => { h.commits.push({ at: performance.now(), count: cart.items.length }) }, [cart.items])
  useEffect(() => { h.passive.push({ at: performance.now(), count: cart.items.length }) }, [cart.items])
  return null
}

// A plain component with a plain state, to show on this very React what a plain `setState(updater)` does and what a tick queued first changes. Nothing here is the cart.
// Its updater is the shape of the one the cart uses: it empties a list of three, keeps any other, and is told to keep everything once `cancelNaive()` has been called.
const naiveCancel = { value: false }
let naiveCalls = 0
const naiveGuard = (prev: number[]) => { naiveCalls++; return naiveCancel.value ? prev : prev.length === 3 ? [] : prev }
function NaiveProbe() {
  const [items, setItems] = useState<number[]>([1, 2, 3])
  const [, setTick] = useState(0)
  useLayoutEffect(() => {
    h.naive = {
      calls: () => naiveCalls,
      plain: () => setItems(naiveGuard),
      withTick: () => { setTick((t) => t + 1); setItems(naiveGuard) },
      guardedSync: () => { flushSync(() => setItems(naiveGuard)) },
      adopt: (next) => setItems(next),
    }
  }, [])
  return <span data-testid="naive">{items.join(',')}</span>
}

function Asker() {
  const cart = useCart()
  return <button type="button" data-testid="ask" onClick={() => { h.clearIf('paid') }}>{cart.items.length}</button>
}

h.mount = ({ strict, seed, naive }) => {
  if (seed !== undefined) nativeSetItem.call(localStorage, CART_KEY, JSON.stringify(seed))
  h.writes.length = 0
  const container = document.getElementById('root')!
  const tree = (
    <CartProvider>
      <Probe />
      <Asker />
      {naive ? <NaiveProbe /> : null}
    </CartProvider>
  )
  h.root = createRoot(container)
  h.root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}
h.unmount = () => { h.root?.unmount(); h.root = null; h.latest = null }
h.cancelNaive = () => { naiveCancel.value = true }
h.naiveText = () => document.querySelector('[data-testid="naive"]')?.textContent ?? null
h.clearIf = (name, options) => {
  const id = ++h.nextId
  h.latest!.clearIf(predicate(name), options).then((result) => { h.results[id] = result; h.resultAt[id] = performance.now() })
  return id
}
h.clearNow = () => h.latest!.clear()
h.add = (n) => h.latest!.add({ modelId: `clmodelmodelmodel9${String(n).padStart(5, '0')}`, title: `Added ${n}`, priceUsd: 5, thumbnail: null, size: { x: 10, y: 10, z: 10 }, colorSlotCount: 1, allowedColors: null }, { qty: 1, material: 'PLA', colors: ['#ffffff'] })
h.setPaid = (items) => { h.paidSignature = signatureOf(items as CartItem[]) }
h.items = () => (h.latest ? h.latest.items : [])
h.persisted = () => nativeGetItem.call(localStorage, CART_KEY)
h.externalWrite = (text) => { nativeSetItem.call(localStorage, CART_KEY, text) }
h.fireStorage = (text) => { window.dispatchEvent(new StorageEvent('storage', { key: CART_KEY, newValue: text, storageArea: localStorage })) }
h.ready = () => Boolean(h.latest?.ready)
