// R1-2 (S-01, S-03, S-04, S-05) – the payment request of a customer who has several tabs open: one request at a time, the key made and kept INSIDE that turn, the lock service never trusted
// to be there or to work, a request that is never taken for "nothing happened", and an answer that is registered for the cart that was clicked - whatever the tabs did meanwhile.
// Everything here runs without a browser: a model of the lock service (FIFO per name, signals, an owner that does not let go), the clock of node:test, the storage as a Map.
// What the real pages do with it is tests/e2e/checkout-tabs.responsive.spec.ts and tests/e2e/checkout-paid-provenance.responsive.spec.ts.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'
import {
  CHECKOUT_ORDER_ID_PATTERN, createCheckoutKeyMemory, readCheckoutKeyEntry, readCheckoutKeySlot, resolveCheckoutKey, stampCheckoutKeyOrder, forgetCheckoutKey,
  type CheckoutKeyMemory, type KeyStorage,
} from '../lib/checkout-client'
import { ORDER_ID_PATTERN } from '../lib/checkout-status'
import { pendingOrderFor, readPendingOrders } from '../lib/order-status-client'
import {
  LOCK_WAIT_BOUNDS, LOCK_WAIT_MS, PURCHASE_LOCK_NAME, REQUEST_TIMEOUT_BOUNDS, REQUEST_TIMEOUT_MS, accessLocks, lockWaitMs, planAfterPurchase, requestTimeoutMs, runCoordinated, sendPurchase,
  type PurchaseOutcome,
} from '../lib/checkout-single-flight'

// ---- a storage, a clock, a lock service ------------------------------------------------------------------------------------------------------
class MemoryStorage implements KeyStorage {
  data = new Map<string, string>()
  writes: Array<{ key: string; value: string | null }> = []
  failReads = false
  failWrites = false
  getItem(key: string) { if (this.failReads) throw new Error('storage denied'); return this.data.get(key) ?? null }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('quota'); this.writes.push({ key, value }); this.data.set(key, value) }
  removeItem(key: string) { if (this.failWrites) throw new Error('quota'); this.writes.push({ key, value: null }); this.data.delete(key) }
}
const KEY_SLOT = 'mw:checkout-key:v1'
const PENDING = 'mw:pending-orders:v2'
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
// a key of the shape the page makes: 'k' + 32 characters, many of them different
const strongKey = (seed: string) => `k${seed.padEnd(32, 'abcdefghijklmnopqrstuvwxyzABCDEF').slice(0, 32)}`

type LockRequest = { name: string; options: { mode?: string; signal?: AbortSignal }; callback: () => Promise<unknown> | unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }
const abortError = () => Object.assign(new Error('The request was aborted.'), { name: 'AbortError' })

// A faithful-enough lock service: exclusive, FIFO per name, a request in the queue is cancelled by its signal, the lock is given back when the callback's promise settles.
function createLockHub(options: { ignoreAbort?: boolean } = {}) {
  const queue: LockRequest[] = []
  const held = new Set<string>()
  const log: string[] = []
  const pump = () => {
    for (const request of [...queue]) {
      if (held.has(request.name)) continue
      queue.splice(queue.indexOf(request), 1)
      held.add(request.name)
      log.push('granted')
      Promise.resolve().then(() => request.callback()).then((value) => request.resolve(value), (error) => request.reject(error)).finally(() => { held.delete(request.name); log.push('released'); pump() })
    }
  }
  const manager = {
    request(name: string, opts: { mode?: string; signal?: AbortSignal }, callback: () => Promise<unknown> | unknown) {
      return new Promise<unknown>((resolve, reject) => {
        if (opts.signal?.aborted && !options.ignoreAbort) { reject(abortError()); return }
        const request: LockRequest = { name, options: opts, callback, resolve, reject }
        queue.push(request)
        if (!options.ignoreAbort) opts.signal?.addEventListener('abort', () => { const at = queue.indexOf(request); if (at >= 0) { queue.splice(at, 1); log.push('cancelled'); reject(abortError()) } }, { once: true })
        pump()
      })
    },
  }
  // another tab that owns the lock until `release()`
  const occupy = (name = PURCHASE_LOCK_NAME) => {
    let release!: () => void
    const owner = new Promise<void>((resolve) => { release = resolve })
    void manager.request(name, { mode: 'exclusive' }, () => owner)
    return release
  }
  return { manager, occupy, held: (name = PURCHASE_LOCK_NAME) => held.has(name), queued: () => queue.length, log }
}
const navigatorWith = (locks: unknown) => ({ locks })

// ---- the options -------------------------------------------------------------------------------------------------------------------------------
test('S-01 U1: the waits are numbers of milliseconds inside their bounds, and the defaults are the provisional ones', () => {
  assert.equal(LOCK_WAIT_MS, 30_000)
  assert.equal(REQUEST_TIMEOUT_MS, 45_000)
  assert.equal(lockWaitMs(undefined), LOCK_WAIT_MS)
  assert.equal(requestTimeoutMs(undefined), REQUEST_TIMEOUT_MS)
  for (const bad of [Number.NaN, Infinity, -1, 0, '30', null, {}, true]) {
    assert.equal(lockWaitMs(bad), LOCK_WAIT_MS, String(bad))
    assert.equal(requestTimeoutMs(bad), REQUEST_TIMEOUT_MS, String(bad))
  }
  assert.equal(lockWaitMs(2_000), 2_000)
  assert.equal(lockWaitMs(1), LOCK_WAIT_BOUNDS.min)
  assert.equal(lockWaitMs(10_000_000), LOCK_WAIT_BOUNDS.max)
  assert.equal(requestTimeoutMs(1), REQUEST_TIMEOUT_BOUNDS.min)
  assert.equal(requestTimeoutMs(10_000_000), REQUEST_TIMEOUT_BOUNDS.max)
  assert.equal(PURCHASE_LOCK_NAME, 'mw:checkout:purchase:v1')
})

test('S-04 U2: an order id has the shape the server holds it to', () => {
  assert.equal(CHECKOUT_ORDER_ID_PATTERN.source, ORDER_ID_PATTERN.source)
})

// ---- the lock service: what is there, what is broken (S-05) -------------------------------------------------------------------------------------
test('S-05 W1: only a lock service that is really NOT THERE lets a section run without the lock - and looking never calls the getter', () => {
  assert.deepEqual(accessLocks(undefined), { kind: 'absent' })
  assert.deepEqual(accessLocks(null), { kind: 'absent' })
  assert.deepEqual(accessLocks({}), { kind: 'absent' })
  let touched = 0
  const hidden = Object.defineProperty({}, 'locks', { get() { touched++; throw new Error('SecurityError') }, enumerable: false })
  assert.equal(accessLocks(hidden).kind, 'broken', 'present (the getter exists) but not usable')
  assert.ok(touched <= 1)
})

test('S-05 W2/W3: present but broken - a getter that throws, an `in` that throws, null, an object without request - is never "absent"', () => {
  const errors: unknown[] = [new Error('SecurityError'), Object.assign(new Error('x'), { name: 'SecurityError' }), 'a string', 42, undefined]
  for (const error of errors) {
    const nav = Object.defineProperty({}, 'locks', { get() { throw error } })
    assert.equal(accessLocks(nav).kind, 'broken', String(error))
  }
  const proxy = new Proxy({}, { has() { throw new Error('boom') } })
  assert.equal(accessLocks(proxy).kind, 'broken', 'the `in` operator throws')
  for (const locks of [null, {}, { request: 5 }, 'locks', 7]) assert.equal(accessLocks(navigatorWith(locks)).kind, 'broken', String(locks))
  const real = { request() { return Promise.resolve() } }
  assert.deepEqual(accessLocks(navigatorWith(real)), { kind: 'present', manager: real })
})

test('S-05 W1b: absent - the section runs once, without the lock, and says so', async () => {
  let runs = 0
  const result = await runCoordinated(async () => { runs++; return 'value' }, { navigator: {} })
  assert.deepEqual(result, { status: 'done', value: 'value', coordination: 'unavailable' })
  assert.equal(runs, 1)
  await assert.rejects(() => runCoordinated(async () => { throw new Error('mine') }, { navigator: undefined }), /mine/)
})

test('S-05 W2-W6: broken in any way - the section is NEVER run, whatever the error is called', async () => {
  const scenarios: Array<[string, unknown]> = []
  for (const name of ['SecurityError', 'NotSupportedError', 'TypeError', 'InvalidStateError', 'SomethingNew']) {
    const error = Object.assign(new Error(name), { name })
    scenarios.push([`${name}: request throws at once`, navigatorWith({ request() { throw error } })])
    scenarios.push([`${name}: request rejects before the callback`, navigatorWith({ request() { return Promise.reject(error) } })])
    scenarios.push([`${name}: the getter throws`, Object.defineProperty({}, 'locks', { get() { throw error } })])
  }
  scenarios.push(['an error that is not an Error', navigatorWith({ request() { throw 'plain text' } })])
  scenarios.push(['request resolves and never calls the callback', navigatorWith({ request() { return Promise.resolve() } })])
  scenarios.push(['locks is null', navigatorWith(null)])
  scenarios.push(['locks is {}', navigatorWith({})])
  for (const [label, nav] of scenarios) {
    let runs = 0
    const result = await runCoordinated(async () => { runs++ }, { navigator: nav })
    assert.deepEqual(result, { status: 'not_run', reason: 'lock_error' }, label)
    assert.equal(runs, 0, label)
  }
})

test('S-05 W7/W9: once the callback has started, the section ran once - its error is its own, and a lock service that fails afterwards changes nothing', async () => {
  const hub = createLockHub()
  let runs = 0
  await assert.rejects(() => runCoordinated(async () => { runs++; throw new Error('the section failed') }, { navigator: navigatorWith(hub.manager) }), /the section failed/)
  assert.equal(runs, 1)
  await flush()
  assert.equal(hub.held(), false, 'the lock was given back')
  // the service rejects AFTER the callback has returned: the value is still the section's, the section is not run again
  runs = 0
  const afterwards = navigatorWith({ request(_name: string, _opts: unknown, callback: () => Promise<unknown>) { return callback().then(() => { throw Object.assign(new Error('release failed'), { name: 'InvalidStateError' }) }) } })
  const result = await runCoordinated(async () => { runs++; return 7 }, { navigator: afterwards })
  assert.deepEqual(result, { status: 'done', value: 7, coordination: 'locked' })
  assert.equal(runs, 1)
})

test('S-01 W11/T1: the wait runs out - nothing runs, the request for the lock is cancelled, and a grant that comes later runs nothing either', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const hub = createLockHub()
    const release = hub.occupy()
    let runs = 0
    const pending = runCoordinated(async () => { runs++ }, { navigator: navigatorWith(hub.manager), waitMs: 5_000 })
    await flush()
    assert.equal(hub.queued(), 1)
    mock.timers.tick(4_999)
    await flush()
    assert.equal(hub.queued(), 1, 'still waiting')
    mock.timers.tick(1)
    assert.deepEqual(await pending, { status: 'not_run', reason: 'wait_expired' })
    assert.equal(hub.queued(), 0, 'the request was cancelled')
    release()
    await flush()
    assert.equal(runs, 0)
  } finally { mock.timers.reset() }
})

test('S-01 W11b: a lock service that ignores the cancel and grants after the wait ran out - the callback returns without running the section and gives the lock back', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const hub = createLockHub({ ignoreAbort: true })
    const release = hub.occupy()
    let runs = 0
    const pending = runCoordinated(async () => { runs++ }, { navigator: navigatorWith(hub.manager), waitMs: 1_000 })
    await flush()
    mock.timers.tick(1_000)
    assert.deepEqual(await pending, { status: 'not_run', reason: 'wait_expired' })
    release()
    await flush()
    await flush()
    assert.equal(runs, 0, 'the late grant ran nothing')
    assert.equal(hub.held(), false, 'and gave the lock back')
  } finally { mock.timers.reset() }
})

test('S-01 W10/T3: the page is left - before asking, or while waiting - and a grant that comes later runs nothing', async () => {
  const hub = createLockHub()
  const release = hub.occupy()
  let runs = 0
  const gone = new AbortController()
  gone.abort()
  assert.deepEqual(await runCoordinated(async () => { runs++ }, { navigator: navigatorWith(hub.manager), signal: gone.signal }), { status: 'not_run', reason: 'abandoned' })
  const leaving = new AbortController()
  const waiting = runCoordinated(async () => { runs++ }, { navigator: navigatorWith(hub.manager), signal: leaving.signal })
  await flush()
  leaving.abort()
  assert.deepEqual(await waiting, { status: 'not_run', reason: 'abandoned' })
  release()
  await flush()
  assert.equal(runs, 0)
})

test('S-01 T4: the grant and the end of the wait at the same moment - the section runs once, or never, never twice', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // (a) the grant comes first: the section runs, the timer is of no consequence
    const first = createLockHub()
    const releaseFirst = first.occupy()
    let runsA = 0
    const a = runCoordinated(async () => { runsA++; return 'a' }, { navigator: navigatorWith(first.manager), waitMs: 1_000 })
    await flush()
    releaseFirst()
    mock.timers.tick(1_000)
    const resultA = await a
    assert.equal(runsA, resultA.status === 'done' ? 1 : 0)
    // (b) the timer first, then the grant
    const second = createLockHub({ ignoreAbort: true })
    const releaseSecond = second.occupy()
    let runsB = 0
    const b = runCoordinated(async () => { runsB++ }, { navigator: navigatorWith(second.manager), waitMs: 1_000 })
    await flush()
    mock.timers.tick(1_000)
    releaseSecond()
    assert.deepEqual(await b, { status: 'not_run', reason: 'wait_expired' })
    await flush()
    assert.equal(runsB, 0)
  } finally { mock.timers.reset() }
})

test('S-01 U3: one turn at a time - the second section starts when the first is over, never before', async () => {
  const hub = createLockHub()
  const nav = navigatorWith(hub.manager)
  const order: string[] = []
  let opened!: () => void
  const gate = new Promise<void>((resolve) => { opened = resolve })
  const first = runCoordinated(async () => { order.push('first in'); await gate; order.push('first out') }, { navigator: nav })
  const second = runCoordinated(async () => { order.push('second in'); order.push('second out') }, { navigator: nav })
  await flush()
  assert.deepEqual(order, ['first in'])
  opened()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first in', 'first out', 'second in', 'second out'])
})

// ---- the source: where the lock service is touched ---------------------------------------------------------------------------------------------
const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('S-05 W13: `navigator.locks` is read in ONE place, inside a try, and only by accessLocks; nothing else in the app touches it', () => {
  const walk = (dir: string, found: string[]) => {
    for (const item of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const relative = path.join(dir, item.name)
      if (item.isDirectory()) { walk(relative, found); continue }
      if (/\.(ts|tsx)$/.test(item.name) && /\.locks\b|'locks' in|"locks" in/.test(code(readFileSync(path.join(process.cwd(), relative), 'utf8')))) found.push(relative.split(path.sep).join('/'))
    }
  }
  const found: string[] = []
  for (const dir of ['app', 'components', 'lib']) walk(dir, found)
  assert.deepEqual(found, ['lib/checkout-single-flight.ts'])
  const text = code(source('lib/checkout-single-flight.ts'))
  assert.equal((text.match(/\.locks\b/g) ?? []).length, 1)
  assert.equal((text.match(/'locks' in/g) ?? []).length, 1)
  const at = text.indexOf('.locks')
  const fn = text.lastIndexOf('function accessLocks')
  assert.ok(fn >= 0 && fn < at && text.indexOf('try {', fn) < at, 'inside accessLocks, after a `try {`')
  assert.equal(/^[^\n]*navigator\.locks/m.test(text.slice(0, fn)), false, 'not at module level')
})

test('S-05 W13b: the section is called from two places only - the branch with no lock service, and the callback of the lock - and never from the lock\'s own error paths', () => {
  const text = code(source('lib/checkout-single-flight.ts'))
  const start = text.indexOf('export async function runCoordinated')
  const end = text.indexOf('\nexport', start + 10) > 0 ? text.indexOf('\nexport', start + 10) : text.length
  const body = text.slice(start, end)
  assert.equal((body.match(/\bsection\(\)/g) ?? []).length, 2)
})

// ---- the key made INSIDE the turn (S-03 P4), the answer kept for the cart that was CLICKED (P1/P2) ----------------------------------------------------------
const request = { items: [], shipping: { method: 'pickup' as const }, rush: false } as never
const answerOk = (orderId = 'clorder0000000000000001') => new Response(JSON.stringify({ orderId, orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_1', totalCents: 4700 }), { status: 200 })
function scriptedFetch(...answers: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ body: { checkoutKey: string }; signal: AbortSignal | null | undefined }> = []
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), signal: init.signal })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    return answer()
  }) as typeof fetch
  return { fetcher, calls }
}
const click = (overrides: Partial<{ signature: string; totalCents: number; cartSignature: string }> = {}) => ({ signature: 'sig-A', totalCents: 4700, cartSignature: 'cart-A', ...overrides })
const noLocks = {} // a browser without the lock service
function purchase(over: Partial<Parameters<typeof sendPurchase>[0]> & { store: KeyStorage | null }, fetcher: typeof fetch, extra: { memory?: CheckoutKeyMemory } = {}) {
  const lifetime = new AbortController()
  return { lifetime, run: () => sendPurchase({ click: click(), request, isCurrent: () => true, lifetime: lifetime.signal, fetcher, navigator: noLocks, memory: extra.memory ?? createCheckoutKeyMemory(), makeKey: () => strongKey('A'), ...over }) }
}

test('S-03 P1/P2/S-04: a success is registered for the cart that was CLICKED, with the order named on the very key the request used - and the answer is handed back', async () => {
  const store = new MemoryStorage()
  const { fetcher, calls } = scriptedFetch(() => answerOk('clorderAAAAAAAAAAAAAAAA'))
  const outcome = await purchase({ store, click: click({ cartSignature: 'cart-CLICKED' }) }, fetcher).run()
  assert.equal(outcome.kind, 'answer')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.checkoutKey, strongKey('A'))
  assert.deepEqual(pendingOrderFor(store, 'clorderAAAAAAAAAAAAAAAA'), { orderId: 'clorderAAAAAAAAAAAAAAAA', cartSignature: 'cart-CLICKED', at: pendingOrderFor(store, 'clorderAAAAAAAAAAAAAAAA')!.at })
  assert.deepEqual(readCheckoutKeyEntry(store), { signature: 'sig-A', totalCents: 4700, key: strongKey('A'), orderId: 'clorderAAAAAAAAAAAAAAAA' })
})

test('S-03 P1: the cart changed while the request was on its way - the order is the CLICKED cart\'s, no entry is made for the new cart, and the page is not sent to the payment page', async () => {
  const store = new MemoryStorage()
  let current = true
  const { fetcher } = scriptedFetch(() => { current = false; return answerOk('clorderBBBBBBBBBBBBBBBB') })
  const outcome = await purchase({ store, isCurrent: () => current, click: click({ cartSignature: 'cart-A' }) }, fetcher).run()
  assert.deepEqual(readPendingOrders(store).map((entry) => [entry.orderId, entry.cartSignature]), [['clorderBBBBBBBBBBBBBBBB', 'cart-A']])
  assert.deepEqual(planAfterPurchase(outcome, { mounted: true, isCurrentNow: false }), [{ do: 'release_button' }])
  assert.equal(planAfterPurchase(outcome, { mounted: true, isCurrentNow: true })[0]?.do, 'redirect')
})

test('S-03 P4: the key is read or made only AFTER the turn is granted - never while waiting for it', async () => {
  const hub = createLockHub()
  const release = hub.occupy()
  const store = new MemoryStorage()
  const reads: string[] = []
  const spy = { getItem: (key: string) => { reads.push(`get:${hub.held() ? 'held' : 'free'}`); return store.getItem(key) }, setItem: (key: string, value: string) => store.setItem(key, value), removeItem: (key: string) => store.removeItem(key) }
  const { fetcher } = scriptedFetch(() => answerOk())
  const run = purchase({ store: spy, navigator: navigatorWith(hub.manager) }, fetcher).run()
  await flush()
  assert.deepEqual(reads, [], 'nothing is read while the turn belongs to somebody else')
  assert.equal(store.writes.length, 0)
  release()
  const outcome = await run
  assert.equal(outcome.kind, 'answer')
  assert.ok(reads.length > 0)
})

test('S-03 IC-3/IC-5: not granted, left, or no longer the cart - NOTHING is sent and NOTHING is written', async () => {
  const cases: Array<[string, Partial<Parameters<typeof sendPurchase>[0]>, PurchaseOutcome]> = [
    ['the page was left', { lifetime: (() => { const c = new AbortController(); c.abort(); return c.signal })() }, { kind: 'gone' }],
    ['the cart is not the one clicked any more', { isCurrent: () => false }, { kind: 'stale' }],
    ['the lock service is broken', { navigator: navigatorWith({ request() { throw new Error('x') } }) }, { kind: 'not_run', reason: 'lock_error' }],
  ]
  for (const [label, over, expected] of cases) {
    const store = new MemoryStorage()
    const { fetcher, calls } = scriptedFetch(() => answerOk())
    const outcome = await purchase({ store, ...over }, fetcher).run()
    assert.deepEqual(outcome, expected, label)
    assert.equal(calls.length, 0, `${label}: no request`)
    assert.deepEqual(store.writes, [], `${label}: no write`)
  }
})

test('S-01 T1/T2: the wait for the turn runs out - nothing is sent, no key is made, the storage is not touched', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const hub = createLockHub()
    hub.occupy()
    const store = new MemoryStorage()
    const { fetcher, calls } = scriptedFetch(() => answerOk())
    const running = purchase({ store, navigator: navigatorWith(hub.manager), waitMs: 2_000 }, fetcher).run()
    await flush()
    mock.timers.tick(2_000)
    assert.deepEqual(await running, { kind: 'not_run', reason: 'wait_expired' })
    assert.equal(calls.length, 0)
    assert.deepEqual(store.writes, [])
    assert.equal(readCheckoutKeySlot(store).kind, 'absent')
  } finally { mock.timers.reset() }
})

test('S-03 IC-14: a request that goes unanswered is cut after the limit - `outcome_unknown`, ONE request, the key kept, nothing registered, nothing repeated', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const store = new MemoryStorage()
    const memory = createCheckoutKeyMemory()
    const { fetcher, calls } = scriptedFetch(() => new Promise<Response>(() => undefined))
    const lifetime = new AbortController()
    // the fake fetch ignores the signal, as a hung connection would: the cut has to come from the caller
    const hung = (async (url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => { calls.push({ body: JSON.parse(String(init.body)), signal: init.signal }); init.signal?.addEventListener('abort', () => reject(abortError()), { once: true }); void url })) as typeof fetch
    void fetcher
    const running = sendPurchase({ store, click: click(), request, isCurrent: () => true, lifetime: lifetime.signal, fetcher: hung, navigator: noLocks, memory, makeKey: () => strongKey('A'), requestTimeoutMs: 10_000 })
    await flush()
    assert.equal(calls.length, 1)
    mock.timers.tick(9_999)
    await flush()
    assert.equal(calls[0].signal?.aborted, false)
    mock.timers.tick(1)
    const outcome = await running
    assert.equal(outcome.kind, 'answer')
    assert.equal(outcome.kind === 'answer' && !outcome.result.ok && outcome.result.failure.kind, 'outcome_unknown')
    assert.equal(calls.length, 1, 'nothing was repeated')
    assert.deepEqual(readCheckoutKeyEntry(store), { signature: 'sig-A', totalCents: 4700, key: strongKey('A') }, 'the key is kept and has no order')
    assert.deepEqual(readPendingOrders(store), [])
  } finally { mock.timers.reset() }
})

test('S-02/S-03 IC-4: every way of not getting an answer is `outcome_unknown` and changes neither the key nor the storage; a refusal keeps its own kind', async () => {
  const rows: Array<[string, () => Response | Promise<Response>, string]> = [
    ['connection lost', () => { throw new TypeError('offline') }, 'outcome_unknown'],
    ['server error', () => new Response('<html>', { status: 502 }), 'outcome_unknown'],
    ['unusable success', () => new Response('{}', { status: 200 }), 'outcome_unknown'],
    ['a code nobody knows', () => new Response(JSON.stringify({ code: 'SOMETHING_NEW' }), { status: 418 }), 'outcome_unknown'],
    ['the price moved', () => new Response(JSON.stringify({ code: 'PRICE_CHANGED', currentTotalCents: 4900 }), { status: 409 }), 'price_changed'],
    ['too many requests', () => new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429 }), 'busy'],
  ]
  for (const [label, answer, kind] of rows) {
    const store = new MemoryStorage()
    const { fetcher, calls } = scriptedFetch(answer)
    const outcome = await purchase({ store }, fetcher).run()
    assert.equal(outcome.kind === 'answer' && !outcome.result.ok && outcome.result.failure.kind, kind, label)
    assert.equal(calls.length, 1, label)
    assert.deepEqual(readCheckoutKeyEntry(store), { signature: 'sig-A', totalCents: 4700, key: strongKey('A') }, `${label}: the same key, no order`)
    assert.deepEqual(readPendingOrders(store), [], label)
  }
})

test('S-03 P3/S-04: `conflict` forgets the key that was refused - and only if the slot still holds it', async () => {
  const conflict = () => new Response(JSON.stringify({ code: 'CHECKOUT_KEY_CONFLICT' }), { status: 409 })
  const store = new MemoryStorage()
  const first = await purchase({ store }, scriptedFetch(conflict).fetcher).run()
  assert.equal(first.kind === 'answer' && !first.result.ok && first.result.failure.kind, 'conflict')
  assert.equal(readCheckoutKeySlot(store).kind, 'forgotten')
  // another tab took the slot over while the answer was on its way: it is left alone
  const moved = new MemoryStorage()
  const fetcher = (async () => {
    moved.data.set(KEY_SLOT, JSON.stringify({ signature: 'sig-B', totalCents: 100, key: strongKey('B'), orderId: 'clorderBBBBBBBBBBBBBBBB' }))
    return conflict()
  }) as typeof fetch
  await purchase({ store: moved }, fetcher).run()
  assert.deepEqual(readCheckoutKeyEntry(moved), { signature: 'sig-B', totalCents: 100, key: strongKey('B'), orderId: 'clorderBBBBBBBBBBBBBBBB' })
})

test('S-04: an order named by a refusal ("payment in progress", "not payable") is remembered and stamped; one that is not named is not', async () => {
  for (const code of ['PAYMENT_IN_PROGRESS', 'ORDER_NOT_PAYABLE']) {
    const named = new MemoryStorage()
    await purchase({ store: named }, scriptedFetch(() => new Response(JSON.stringify({ code, orderId: 'clorderCCCCCCCCCCCCCCCC' }), { status: 409 })).fetcher).run()
    assert.equal(pendingOrderFor(named, 'clorderCCCCCCCCCCCCCCCC')?.cartSignature, 'cart-A', code)
    assert.equal(readCheckoutKeyEntry(named)?.orderId, 'clorderCCCCCCCCCCCCCCCC', code)
    const silent = new MemoryStorage()
    await purchase({ store: silent }, scriptedFetch(() => new Response(JSON.stringify({ code }), { status: 409 })).fetcher).run()
    assert.deepEqual(readPendingOrders(silent), [], `${code} without an order`)
    assert.equal(readCheckoutKeyEntry(silent)?.orderId, undefined, code)
  }
})

test('S-04: stamping never overwrites another order, never touches another key or total, and never throws', () => {
  const store = new MemoryStorage()
  const memory = createCheckoutKeyMemory()
  const key = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('A'), memory)
  const made = { key, signature: 'sig-A', totalCents: 4700 }
  assert.equal(stampCheckoutKeyOrder(store, { ...made, key: strongKey('Z') }, 'clorderAAAAAAAAAAAAAAAA'), false, 'another key')
  assert.equal(stampCheckoutKeyOrder(store, { ...made, totalCents: 1 }, 'clorderAAAAAAAAAAAAAAAA'), false, 'another total')
  assert.equal(stampCheckoutKeyOrder(store, { ...made, signature: 'other' }, 'clorderAAAAAAAAAAAAAAAA'), false, 'another cart')
  assert.equal(stampCheckoutKeyOrder(store, made, 'not an id'), false)
  assert.equal(stampCheckoutKeyOrder(store, made, 'clorderAAAAAAAAAAAAAAAA'), true)
  assert.equal(stampCheckoutKeyOrder(store, made, 'clorderAAAAAAAAAAAAAAAA'), true, 'again: nothing to do')
  const written = store.writes.length
  assert.equal(stampCheckoutKeyOrder(store, made, 'clorderBBBBBBBBBBBBBBBB'), false, 'never over another order')
  assert.equal(store.writes.length, written)
  assert.deepEqual(readCheckoutKeyEntry(store), { signature: 'sig-A', totalCents: 4700, key, orderId: 'clorderAAAAAAAAAAAAAAAA' })
  store.failWrites = true
  const fresh = new MemoryStorage(); fresh.failWrites = false
  resolveCheckoutKey(fresh, 'sig-A', 4700, () => strongKey('A'), createCheckoutKeyMemory())
  fresh.failWrites = true
  assert.equal(stampCheckoutKeyOrder(fresh, made, 'clorderAAAAAAAAAAAAAAAA'), false, 'a storage that refuses to write')
  assert.equal(stampCheckoutKeyOrder(null, made, 'clorderAAAAAAAAAAAAAAAA'), false)
})

test('S-04: the slot keeps `orderId` only when it is an order id; a key that is reused keeps its order; a new cart makes a new key without one', () => {
  const store = new MemoryStorage()
  const memory = createCheckoutKeyMemory()
  const key = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('A'), memory)
  stampCheckoutKeyOrder(store, { key, signature: 'sig-A', totalCents: 4700 }, 'clorderAAAAAAAAAAAAAAAA')
  assert.equal(resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('Q'), memory), key, 'the same cart and total: the same key')
  assert.equal(readCheckoutKeyEntry(store)?.orderId, 'clorderAAAAAAAAAAAAAAAA', 'and it still carries its order')
  const other = resolveCheckoutKey(store, 'sig-B', 4700, () => strongKey('B'), memory)
  assert.equal(other, strongKey('B'))
  assert.equal(readCheckoutKeyEntry(store)?.orderId, undefined, 'a new purchase starts without one')
  store.data.set(KEY_SLOT, JSON.stringify({ signature: 'sig-A', totalCents: 4700, key, orderId: '../../etc' }))
  assert.equal(readCheckoutKeyEntry(store)?.orderId, undefined, 'something that is not an order id is no provenance')
})

test('S-04: the slot is told apart - absent, forgotten, damaged, unreadable, entry', () => {
  const store = new MemoryStorage()
  assert.equal(readCheckoutKeySlot(store).kind, 'absent')
  assert.equal(readCheckoutKeySlot(null).kind, 'unreadable')
  store.data.set(KEY_SLOT, '')
  assert.equal(readCheckoutKeySlot(store).kind, 'forgotten')
  for (const raw of ['not json', '[]', 'null', '{"signature":"s","totalCents":1,"key":"short"}', '{"signature":"","totalCents":1,"key":"' + strongKey('A') + '"}', '{"signature":"s","totalCents":-1,"key":"' + strongKey('A') + '"}', '{"signature":"s","totalCents":1.5,"key":"' + strongKey('A') + '"}']) {
    store.data.set(KEY_SLOT, raw)
    assert.equal(readCheckoutKeySlot(store).kind, 'damaged', raw)
  }
  store.failReads = true
  assert.equal(readCheckoutKeySlot(store).kind, 'unreadable')
  assert.equal(readCheckoutKeyEntry(store), null)
})

test('S-03 P7: a key that was forgotten does not come back from the memory of a page - the placeholder wins; an empty or blocked storage still lets the page protect a double click', () => {
  const store = new MemoryStorage()
  const tabOne = createCheckoutKeyMemory()
  const tabTwo = createCheckoutKeyMemory()
  // (a page only keeps a copy of the keys it MADE itself: tab two makes the key, tab one merely reads it from the storage)
  const key = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('A'), tabTwo)
  assert.equal(tabTwo.current?.key, key, 'tab two holds the key it made in its memory')
  assert.equal(resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('B'), tabOne), key, 'the first tab takes the key from the storage')
  forgetCheckoutKey(store, undefined, tabOne)           // tab one forgets it (the payment was verified): the placeholder is written - tab two's memory is out of its reach
  assert.equal(tabTwo.current?.key, key, 'and tab two still holds its copy')
  const next = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('C'), tabTwo)
  assert.equal(next, strongKey('C'), 'tab two still held the old key in its memory and does NOT reuse it')
  // storage that refuses everything: the memory is the only protection against a double click
  const blocked: KeyStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const memory = createCheckoutKeyMemory()
  const first = resolveCheckoutKey(blocked, 'sig-A', 4700, () => strongKey('D'), memory)
  assert.equal(resolveCheckoutKey(blocked, 'sig-A', 4700, () => strongKey('E'), memory), first)
})

test('S-04/IS-1: forgetting with an expectation reads the slot AGAIN and writes only if it still holds what was meant', () => {
  const store = new MemoryStorage()
  const memory = createCheckoutKeyMemory()
  const key = resolveCheckoutKey(store, 'sig-A', 4700, () => strongKey('A'), memory)
  assert.equal(forgetCheckoutKey(store, { orderId: 'clorderAAAAAAAAAAAAAAAA' }, memory), false, 'no order on the slot: nothing to forget for an order')
  stampCheckoutKeyOrder(store, { key, signature: 'sig-A', totalCents: 4700 }, 'clorderAAAAAAAAAAAAAAAA')
  assert.equal(forgetCheckoutKey(store, { orderId: 'clorderBBBBBBBBBBBBBBBB' }, memory), false, 'another order')
  assert.equal(forgetCheckoutKey(store, { key: strongKey('Z') }, memory), false, 'another key')
  const before = store.writes.length
  assert.equal(readCheckoutKeySlot(store).kind, 'entry')
  assert.equal(store.writes.length, before)
  assert.equal(forgetCheckoutKey(store, { orderId: 'clorderAAAAAAAAAAAAAAAA' }, memory), true)
  assert.equal(readCheckoutKeySlot(store).kind, 'forgotten')
  assert.equal(forgetCheckoutKey(store, { orderId: 'clorderAAAAAAAAAAAAAAAA' }, memory), false, 'twice: the second finds the placeholder')
  assert.equal(forgetCheckoutKey(null, { orderId: 'clorderAAAAAAAAAAAAAAAA' }, memory), false)
})

// ---- what happens after the answer: the plan --------------------------------------------------------------------------------------------------------
test('S-03 P5/P8: the plan after a purchase - nothing for a page that is gone; a redirect only for a success on the cart still in front of the customer', () => {
  const ok = { ok: true as const, url: 'https://checkout.stripe.com/c/pay/cs_test_1', orderId: 'clorderAAAAAAAAAAAAAAAA', orderNumber: 1, totalCents: 1 }
  const refused = { ok: false as const, failure: { kind: 'price_changed' as const, code: 'PRICE_CHANGED', status: 409, retry: false } }
  const unknown = { ok: false as const, failure: { kind: 'outcome_unknown' as const, code: 'X', status: 0, retry: false } }
  const here = { mounted: true, isCurrentNow: true }
  // a page that is gone: nothing at all
  for (const outcome of [{ kind: 'gone' }, { kind: 'stale' }, { kind: 'not_run', reason: 'wait_expired' }, { kind: 'answer', result: ok, coordination: 'locked' }] as PurchaseOutcome[]) {
    assert.deepEqual(planAfterPurchase(outcome, { mounted: false, isCurrentNow: true }), [], outcome.kind)
  }
  assert.deepEqual(planAfterPurchase({ kind: 'not_run', reason: 'abandoned' }, here), [])
  assert.deepEqual(planAfterPurchase({ kind: 'gone' }, here), [])
  assert.deepEqual(planAfterPurchase({ kind: 'stale' }, here), [{ do: 'release_button' }])
  const notStarted = planAfterPurchase({ kind: 'not_run', reason: 'wait_expired' }, here)
  assert.equal(notStarted[0].do, 'show_failure')
  assert.equal(notStarted[0].do === 'show_failure' && notStarted[0].failure.kind, 'purchase_not_started')
  assert.equal(planAfterPurchase({ kind: 'not_run', reason: 'lock_error' }, here)[0].do, 'show_failure')
  assert.deepEqual(planAfterPurchase({ kind: 'answer', result: ok, coordination: 'unavailable' }, here), [{ do: 'redirect', url: ok.url }])
  assert.deepEqual(planAfterPurchase({ kind: 'answer', result: ok, coordination: 'locked' }, { mounted: true, isCurrentNow: false }), [{ do: 'release_button' }])
  assert.deepEqual(planAfterPurchase({ kind: 'answer', result: refused, coordination: 'locked' }, here).map((action) => action.do), ['show_failure', 'refresh_quote', 'release_button'])
  assert.deepEqual(planAfterPurchase({ kind: 'answer', result: unknown, coordination: 'locked' }, here).map((action) => action.do), ['show_failure', 'release_button'], 'an unknown outcome asks for no new quote and repeats nothing')
})

test('S-03: nothing in this module sends a request by itself, repeats one, or rotates a key - the ONE request is requestSession\'s, and a key is made only by resolveCheckoutKey', () => {
  const text = code(source('lib/checkout-single-flight.ts'))
  assert.equal((text.match(/requestSession\(/g) ?? []).length, 1)
  assert.equal(/\bfetch\(/.test(text), false)
  assert.equal((text.match(/resolveCheckoutKey\(/g) ?? []).length, 1)
  assert.equal(/newCheckoutKey|makeKey\(\)/.test(text.replace(/makeKey\??:[^\n]*/g, '')), false, 'no key made here')
  assert.equal(/localStorage|sessionStorage/.test(text), false, 'the storage is a parameter')
})
