// R1-2 / S-11 – an unexpected error in the payment request must never leave the customer in front of a button that is busy for ever, and must never be taken for "nothing was sent" when
// a request may have gone out. The audit found that pay() awaited sendPurchase() with no net under it and that runCoordinated() hands the error of its section to whoever called it.
//
// The rules, in the order of the mandate (A-I):
//   A  an error that nobody expected is an OUTCOME the page can show, not a rejection nobody catches (sendPurchase never rejects);
//   B  the outcome tells four situations apart: certainly before any request / after a request may have gone out / the server's answer (with its order) / nobody can tell;
//   C  whatever is not certain is NOT taken to mean "the payment did not start";
//   D  nothing is repeated by itself;
//   E  the key is neither forgotten, nor replaced, nor made again because of an error;
//   F  an order the server named is not lost because the browser could not write it down;
//   G  after an error that may have followed a request the button is NOT given back (a way to check the order is);
//   H  a page that is gone neither shows nor redirects;
//   I  R1-1a, R1-1b and S-01...S-10 stay as they were (tests/checkout-single-flight.test.ts and the others are not touched).
// Everything here runs without a browser: a model of the lock service, a storage that can be told to fail, a scripted fetch. The real component is tests/e2e/checkout-faults.responsive.spec.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'
import { createCheckoutKeyMemory, readCheckoutKeyEntry, type CheckoutKeyMemory, type CheckoutFailure, type KeyStorage } from '../lib/checkout-client'
import { pendingOrderFor, readPendingOrders } from '../lib/order-status-client'
import { PURCHASE_LOCK_NAME, planAfterPurchase, runCoordinated, sendPurchase, type PurchaseOutcome, type PurchaseStore } from '../lib/checkout-single-flight'
// the symbols that S-11 adds are reached through the namespace: a test then fails by itself when one is missing, instead of taking the whole file down
import * as flight from '../lib/checkout-single-flight'
import * as client from '../lib/checkout-client'
import * as copy from '../lib/checkout-copy'

// ---- a storage that can be told to fail, a lock service, a scripted fetch --------------------------------------------------------------------------------
class MemoryStorage implements KeyStorage {
  data = new Map<string, string>()
  writes: Array<{ key: string; value: string | null }> = []
  failReads = false
  failWrites = false
  failOnly: Set<string> | null = null      // only the writes of these keys fail
  getItem(key: string) { if (this.failReads) throw new Error('storage denied'); return this.data.get(key) ?? null }
  setItem(key: string, value: string) { if (this.failWrites || this.failOnly?.has(key)) throw new Error('quota'); this.writes.push({ key, value }); this.data.set(key, value) }
  removeItem(key: string) { if (this.failWrites || this.failOnly?.has(key)) throw new Error('quota'); this.writes.push({ key, value: null }); this.data.delete(key) }
}
const PENDING = 'mw:pending-orders:v2'
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const strongKey = (seed: string) => `k${seed.padEnd(32, 'abcdefghijklmnopqrstuvwxyzABCDEF').slice(0, 32)}`
const ORDER_A = 'clorderAAAAAAAAAAAAAAAA'
const abortError = () => Object.assign(new Error('The request was aborted.'), { name: 'AbortError' })

type LockRequest = { name: string; options: { mode?: string; signal?: AbortSignal }; callback: () => Promise<unknown> | unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }
// exclusive, FIFO per name, a request in the queue is cancelled by its signal, the lock is given back when the callback's promise settles
function createLockHub() {
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
        if (opts.signal?.aborted) { reject(abortError()); return }
        const request: LockRequest = { name, options: opts, callback, resolve, reject }
        queue.push(request)
        opts.signal?.addEventListener('abort', () => { const at = queue.indexOf(request); if (at >= 0) { queue.splice(at, 1); log.push('cancelled'); reject(abortError()) } }, { once: true })
        pump()
      })
    },
  }
  const occupy = (name = PURCHASE_LOCK_NAME) => {
    let release!: () => void
    const owner = new Promise<void>((resolve) => { release = resolve })
    void manager.request(name, { mode: 'exclusive' }, () => owner)
    return release
  }
  return { manager, occupy, held: (name = PURCHASE_LOCK_NAME) => held.has(name), log }
}
const navigatorWith = (locks: unknown) => ({ locks })
const noLocks = {}

const request = { items: [], shipping: { method: 'pickup' as const }, rush: false } as never
const answerOk = (orderId = ORDER_A) => new Response(JSON.stringify({ orderId, orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_1', totalCents: 4700 }), { status: 200 })
function scriptedFetch(...answers: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ body: { checkoutKey: string }; signal: AbortSignal | null | undefined }> = []
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), signal: init.signal })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    return answer()
  }) as typeof fetch
  return { fetcher, calls }
}
const clickOf = (overrides: Partial<{ signature: string; totalCents: number; cartSignature: string }> = {}) => ({ signature: 'sig-A', totalCents: 4700, cartSignature: 'cart-A', ...overrides })
type Args = Parameters<typeof sendPurchase>[0]
function args(store: PurchaseStore | null, fetcher: typeof fetch, over: Partial<Args> = {}): Args {
  return { store, click: clickOf(), request, isCurrent: () => true, lifetime: new AbortController().signal, fetcher, navigator: noLocks, memory: createCheckoutKeyMemory(), makeKey: () => strongKey('A'), ...over }
}
const KEY_ENTRY = { signature: 'sig-A', totalCents: 4700, key: strongKey('A') }
const money = (cents: number) => `${(cents / 100).toFixed(2)} €`
const bomb = (message = 'boom'): never => { throw new Error(message) }

// ---- A, B, C: an error BEFORE the request - sendPurchase answers, it does not reject --------------------------------------------------------------------
const lockModes: Array<[string, () => { navigator: unknown; hub: ReturnType<typeof createLockHub> | null }]> = [
  ['no lock service', () => ({ navigator: noLocks, hub: null })],
  ['a working lock service', () => { const hub = createLockHub(); return { navigator: navigatorWith(hub.manager), hub } }],
]
const beforeRequest: Array<[string, () => Partial<Args>]> = [
  ['isCurrent() throws', () => ({ isCurrent: () => bomb('isCurrent') })],
  ['the signal of the page throws when it is read', () => ({ lifetime: { get aborted(): boolean { return bomb('aborted') }, addEventListener() { /* none */ }, removeEventListener() { /* none */ } } as unknown as AbortSignal })],
  ['the memory of the key throws when it is read', () => ({ memory: Object.defineProperty({}, 'current', { get() { return bomb('memory') }, set() { /* none */ } }) as CheckoutKeyMemory })],
]
for (const [mode, makeMode] of lockModes) {
  for (const [label, inject] of beforeRequest) {
    test(`S-11 F1 [${mode}] ${label}: the error is an outcome - "fault, before the request" - nothing is sent, nothing is written, the turn is given back`, async () => {
      const { navigator, hub } = makeMode()
      const store = new MemoryStorage()
      const { fetcher, calls } = scriptedFetch(() => answerOk())
      const outcome = await sendPurchase({ ...args(store, fetcher, { navigator }), ...inject() })
      assert.deepEqual(outcome, { kind: 'fault', stage: 'before_request' })
      assert.equal(calls.length, 0, 'no request')
      assert.deepEqual(store.writes, [], 'no write')
      await flush()
      assert.equal(calls.length, 0, 'and nothing sent later by itself')
      if (hub) {
        assert.equal(hub.held(), false, 'the turn is not kept by the error')
        // the next press, in the same browser, gets its turn at once and sends its ONE request
        const next = await sendPurchase(args(store, fetcher, { navigator }))
        assert.equal(next.kind, 'answer')
        assert.equal(calls.length, 1)
      }
    })
  }
}

test('S-11 F2: the key is made, THEN the page fails before the request goes out - nothing is sent, the key stays, and the next press sends ONE request with the SAME key', async () => {
  const store = new MemoryStorage()
  const { fetcher, calls } = scriptedFetch(() => answerOk())
  const Real = globalThis.AbortController
  let armed = true
  class Failing extends Real { constructor() { if (armed) { armed = false; bomb('no AbortController today') } super() } }
  const first = args(store, fetcher)         // (its own lifetime signal is made BEFORE the failure is armed)
  globalThis.AbortController = Failing as never
  let outcome: PurchaseOutcome
  try { outcome = await sendPurchase(first) } finally { globalThis.AbortController = Real }
  assert.deepEqual(outcome, { kind: 'fault', stage: 'before_request' })
  assert.equal(calls.length, 0, 'the request had not gone out')
  assert.deepEqual(readCheckoutKeyEntry(store), KEY_ENTRY, 'E: the key that was made is kept - not forgotten, not replaced')
  assert.deepEqual(readPendingOrders(store), [])
  // the customer presses again: ONE request, with the key of the first press (a different makeKey proves nothing was made again)
  const second = await sendPurchase(args(store, fetcher, { makeKey: () => strongKey('B') }))
  assert.equal(second.kind, 'answer')
  assert.equal(calls.length, 1, 'D: one request in all')
  assert.equal(calls[0].body.checkoutKey, strongKey('A'), 'the same key')
})

test('S-11 F3: the section fails INSIDE the turn (the lock was granted) - the lock is given back, the error is an outcome, and the next press is served', async () => {
  const hub = createLockHub()
  const store = new MemoryStorage()
  const { fetcher, calls } = scriptedFetch(() => answerOk())
  const outcome = await sendPurchase(args(store, fetcher, { navigator: navigatorWith(hub.manager), isCurrent: () => bomb('inside the turn') }))
  assert.deepEqual(outcome, { kind: 'fault', stage: 'before_request' })
  await flush()   // the lock service gives the lock back a moment after the callback ends, as the real one does
  assert.deepEqual(hub.log, ['granted', 'released'], 'it was granted and it was given back')
  assert.equal(hub.held(), false)
  assert.equal(calls.length, 0)
  const next = await sendPurchase(args(store, fetcher, { navigator: navigatorWith(hub.manager) }))
  assert.equal(next.kind, 'answer')
  await flush()
  assert.deepEqual(hub.log, ['granted', 'released', 'granted', 'released'])
})

// ---- B, F: an error AFTER the request went out - the server's answer, and the order it names, are not lost ------------------------------------------------------
test('S-11 F4: the page fails while it keeps the answer (after the request) - the answer, with its order, is handed back; the key stays; nothing is repeated', async () => {
  const store = new MemoryStorage()
  const { fetcher, calls } = scriptedFetch(() => answerOk())
  const memory = createCheckoutKeyMemory()
  const click = Object.defineProperty({ signature: 'sig-A', totalCents: 4700 }, 'cartSignature', { get() { return bomb('after the request') }, enumerable: true }) as ReturnType<typeof clickOf>
  const outcome = await sendPurchase(args(store, fetcher, { click, memory }))
  assert.equal(outcome.kind, 'answer', 'the answer of the server is not swallowed by the error')
  if (outcome.kind !== 'answer') return
  assert.equal(outcome.result.ok && outcome.result.orderId, ORDER_A, 'F: the order the server named is in the outcome')
  assert.equal((outcome as { unrecorded?: boolean }).unrecorded, true, 'and it says this browser could not write it down')
  assert.equal(calls.length, 1, 'D: ONE request')
  assert.deepEqual(readCheckoutKeyEntry(store), KEY_ENTRY, 'E: the key is exactly what it was')
  assert.equal(memory.current?.key, strongKey('A'))
  await flush()
  assert.equal(calls.length, 1, 'and nothing was sent later by itself')
  // the page can still do what it would have done: take the customer to the payment page
  assert.deepEqual(planAfterPurchase(outcome, { mounted: true, isCurrentNow: true }), [{ do: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }])
})

test('S-11 F4b: a refusal that names an order is kept as well, with the order - and the key is not touched', async () => {
  const store = new MemoryStorage()
  const { fetcher, calls } = scriptedFetch(() => new Response(JSON.stringify({ code: 'PAYMENT_IN_PROGRESS', orderId: ORDER_A }), { status: 409 }))
  const click = Object.defineProperty({ signature: 'sig-A', totalCents: 4700 }, 'cartSignature', { get() { return bomb('after the request') }, enumerable: true }) as ReturnType<typeof clickOf>
  const outcome = await sendPurchase(args(store, fetcher, { click }))
  assert.equal(outcome.kind, 'answer')
  if (outcome.kind !== 'answer') return
  assert.equal(!outcome.result.ok && outcome.result.failure.orderId, ORDER_A)
  assert.equal((outcome as { unrecorded?: boolean }).unrecorded, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(readCheckoutKeyEntry(store), KEY_ENTRY)
})

test('S-11 F5: the browser can not write down the order the server named (storage refuses, is blocked, or refuses only the memory of the orders) - the outcome says so and still carries the order', async () => {
  const scenarios: Array<[string, () => { store: PurchaseStore | null; fetcher: typeof fetch; calls: ReturnType<typeof scriptedFetch>['calls'] }, (store: PurchaseStore | null) => void]> = [
    ['the storage starts refusing writes when the answer arrives', () => {
      const store = new MemoryStorage()
      const s = scriptedFetch(() => { store.failWrites = true; return answerOk() })
      return { store, ...s }
    }, (store) => assert.deepEqual(readCheckoutKeyEntry(store), KEY_ENTRY, 'the key was written before, and is as it was')],
    ['the storage refuses every write from the start', () => {
      const store = new MemoryStorage(); store.failWrites = true
      return { store, ...scriptedFetch(() => answerOk()) }
    }, () => undefined],
    ['there is no storage at all', () => ({ store: null, ...scriptedFetch(() => answerOk()) }), () => undefined],
    ['only the memory of the orders is refused', () => {
      const store = new MemoryStorage(); store.failOnly = new Set([PENDING])
      return { store, ...scriptedFetch(() => answerOk()) }
    }, (store) => assert.equal(readCheckoutKeyEntry(store)?.orderId, ORDER_A, 'the key still carries its order')],
  ]
  for (const [label, make, extra] of scenarios) {
    const { store, fetcher, calls } = make()
    const memory = createCheckoutKeyMemory()
    const outcome = await sendPurchase(args(store, fetcher, { memory }))
    assert.equal(outcome.kind, 'answer', label)
    if (outcome.kind !== 'answer') continue
    assert.equal(outcome.result.ok && outcome.result.orderId, ORDER_A, `${label}: the order is in the outcome`)
    assert.equal((outcome as { unrecorded?: boolean }).unrecorded, true, `${label}: and the outcome says it was not written down`)
    assert.equal(calls.length, 1, `${label}: one request`)
    assert.equal(memory.current?.key, strongKey('A'), `${label}: the page still remembers its key`)
    assert.equal(pendingOrderFor(store, ORDER_A), null, `${label}: nothing in the memory of the orders`)
    extra(store)
  }
})

test('S-11 D1: nothing is repeated by itself - a request with no usable answer, or an error after it, is ONE request, now and later', async () => {
  const noAnswer: Array<[string, () => Response | Promise<Response>]> = [
    ['the connection is lost', () => { throw new TypeError('offline') }],
    ['the payment service fails', () => new Response('<html>', { status: 502 })],
    ['a success nobody can read', () => new Response('{}', { status: 200 })],
  ]
  for (const [label, answer] of noAnswer) {
    const store = new MemoryStorage()
    const { fetcher, calls } = scriptedFetch(answer)
    const outcome = await sendPurchase(args(store, fetcher))
    assert.equal(outcome.kind === 'answer' && !outcome.result.ok && outcome.result.failure.kind, 'outcome_unknown', label)
    await flush()
    assert.equal(calls.length, 1, `${label}: ONE request`)
    assert.deepEqual(readCheckoutKeyEntry(store), KEY_ENTRY, `${label}: the key is as it was, with no order`)
  }
  // and an error after the answer (the page can not write it down) does not bring a second request either
  const store = new MemoryStorage()
  const { fetcher, calls } = scriptedFetch(() => answerOk())
  const click = Object.defineProperty({ signature: 'sig-A', totalCents: 4700 }, 'cartSignature', { get() { return bomb('after the request') }, enumerable: true }) as ReturnType<typeof clickOf>
  await sendPurchase(args(store, fetcher, { click }))
  await flush()
  assert.equal(calls.length, 1)
})

test('S-11 F7: a timer that can not be cleared does not take the answer in hand down with it - the answer comes back, is written down, and no second request is made', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const mocked = globalThis.clearTimeout
  try {
    // the browser's clearTimeout fails after it has done its work (so nothing is left pending)
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => { mocked(handle); bomb('clearTimeout') }) as typeof clearTimeout
    const store = new MemoryStorage()
    const { fetcher, calls } = scriptedFetch(() => answerOk())
    const outcome = await sendPurchase(args(store, fetcher))
    assert.equal(outcome.kind, 'answer', 'the answer in hand is not swallowed by the error of the clean-up')
    assert.equal(outcome.kind === 'answer' && outcome.result.ok && outcome.result.orderId, ORDER_A)
    assert.equal('unrecorded' in outcome, false, 'and it was written down')
    assert.equal(pendingOrderFor(store, ORDER_A)?.cartSignature, 'cart-A')
    assert.equal(calls.length, 1, 'D: ONE request')
  } finally {
    globalThis.clearTimeout = mocked
    mock.timers.reset()
  }
})

test('S-11 F5b: when everything is written down the outcome is exactly what it always was - no extra field', async () => {
  const store = new MemoryStorage()
  const outcome = await sendPurchase(args(store, scriptedFetch(() => answerOk()).fetcher))
  assert.equal(outcome.kind, 'answer')
  assert.equal('unrecorded' in outcome, false)
  assert.equal(pendingOrderFor(store, ORDER_A)?.cartSignature, 'cart-A')
  assert.equal(readCheckoutKeyEntry(store)?.orderId, ORDER_A)
})

// ---- B, C: the rule that turns what is known into the outcome ----------------------------------------------------------------------------------------------
test('S-11 F6: after an error the outcome is built from what is KNOWN - before the request only if the request was never started; the answer if there is one; otherwise "uncertain"', () => {
  const ok = { ok: true as const, url: 'https://checkout.stripe.com/c/pay/cs_test_1', orderId: ORDER_A, orderNumber: 1, totalCents: 1 }
  assert.deepEqual(flight.outcomeAfterFault({ requested: false, answer: null }), { kind: 'fault', stage: 'before_request' })
  assert.deepEqual(flight.outcomeAfterFault({ requested: true, answer: null }), { kind: 'fault', stage: 'uncertain' })
  assert.deepEqual(flight.outcomeAfterFault({ requested: true, answer: ok }, noLocks), { kind: 'answer', result: ok, coordination: 'unavailable', unrecorded: true })
  assert.deepEqual(flight.outcomeAfterFault({ requested: true, answer: ok }, navigatorWith(createLockHub().manager)), { kind: 'answer', result: ok, coordination: 'locked', unrecorded: true })
})

// ---- G: what the page does with each outcome -------------------------------------------------------------------------------------------------------------------
test('S-11 P1: the plan for an error - "nothing was sent" only for an error that came before the request; after one that may have followed it the button is HELD, not given back', () => {
  const here = { mounted: true, isCurrentNow: true }
  const before = planAfterPurchase({ kind: 'fault', stage: 'before_request' } as PurchaseOutcome, here)
  assert.deepEqual(before.map((action) => action.do), ['show_failure', 'release_button'])
  const beforeFailure = before[0].do === 'show_failure' ? before[0].failure : null
  assert.equal(beforeFailure?.kind, 'purchase_not_started')
  assert.equal(beforeFailure?.code, client.PURCHASE_UNEXPECTED_ERROR)
  const uncertain = planAfterPurchase({ kind: 'fault', stage: 'uncertain' } as PurchaseOutcome, here)
  assert.deepEqual(uncertain.map((action) => action.do), ['show_failure', 'hold_button'])
  const uncertainFailure = uncertain[0].do === 'show_failure' ? uncertain[0].failure : null
  assert.equal(uncertainFailure?.kind, 'outcome_unknown', 'C: not "nothing was sent"')
  assert.equal(uncertainFailure?.code, client.PURCHASE_PAGE_ERROR)
  assert.equal(uncertainFailure?.retry, false)
  assert.equal(uncertain.some((action) => action.do === 'release_button' || action.do === 'redirect' || action.do === 'refresh_quote'), false, 'nothing that could start another payment')
})

test('S-11 P2: an answer the browser could not write down - a success on the cart in front of the customer still goes to the payment page; on another cart the order is shown, not forgotten', () => {
  const ok = { ok: true as const, url: 'https://checkout.stripe.com/c/pay/cs_test_1', orderId: ORDER_A, orderNumber: 1, totalCents: 1 }
  const unrecorded = { kind: 'answer', result: ok, coordination: 'locked', unrecorded: true } as PurchaseOutcome
  assert.deepEqual(planAfterPurchase(unrecorded, { mounted: true, isCurrentNow: true }), [{ do: 'redirect', url: ok.url }])
  const other = planAfterPurchase(unrecorded, { mounted: true, isCurrentNow: false })
  assert.deepEqual(other.map((action) => action.do), ['show_failure', 'release_button'])
  const failure = other[0].do === 'show_failure' ? other[0].failure : null
  assert.equal(failure?.orderId, ORDER_A, 'F: the order id reaches the screen')
  assert.equal(failure?.code, client.REDIRECT_STALLED)
  // and an order that WAS written down is as before: the button is simply given back
  assert.deepEqual(planAfterPurchase({ kind: 'answer', result: ok, coordination: 'locked' }, { mounted: true, isCurrentNow: false }), [{ do: 'release_button' }])
})

test('S-11 P3: a page that is gone gets no plan at all - for any outcome, the new ones included', () => {
  const ok = { ok: true as const, url: 'https://checkout.stripe.com/c/pay/cs_test_1', orderId: ORDER_A, orderNumber: 1, totalCents: 1 }
  const outcomes: PurchaseOutcome[] = [
    { kind: 'fault', stage: 'before_request' } as PurchaseOutcome, { kind: 'fault', stage: 'uncertain' } as PurchaseOutcome,
    { kind: 'answer', result: ok, coordination: 'locked', unrecorded: true } as PurchaseOutcome, { kind: 'answer', result: ok, coordination: 'locked' },
  ]
  for (const outcome of outcomes) for (const isCurrentNow of [true, false]) assert.deepEqual(planAfterPurchase(outcome, { mounted: false, isCurrentNow }), [], `${outcome.kind}`)
})

test('S-11 U1: the page is left while the request is on its way - the request finishes, the order is written down, and the page (gone) is told to do nothing', async () => {
  const store = new MemoryStorage()
  const lifetime = new AbortController()
  const { fetcher, calls } = scriptedFetch(() => { lifetime.abort(); return answerOk() })
  const outcome = await sendPurchase(args(store, fetcher, { lifetime: lifetime.signal }))
  assert.equal(outcome.kind, 'answer')
  assert.equal(calls.length, 1)
  assert.equal(pendingOrderFor(store, ORDER_A)?.cartSignature, 'cart-A', 'the order is remembered whatever the page did')
  assert.equal(readCheckoutKeyEntry(store)?.orderId, ORDER_A)
  assert.deepEqual(planAfterPurchase(outcome, { mounted: false, isCurrentNow: true }), [])
})

// ---- carrying the plan out: an effect of the page that fails does not leave the page half-done ----------------------------------------------------------
function effects(over: Partial<flight.PageEffects> = {}) {
  const calls: string[] = []
  const fx: flight.PageEffects = {
    showFailure: (failure: CheckoutFailure) => { calls.push(`show:${failure.kind}:${failure.code}${failure.orderId ? `:${failure.orderId}` : ''}`) },
    refreshQuote: () => { calls.push('refresh') },
    releaseButton: () => { calls.push('release') },
    holdButton: () => { calls.push('hold') },
    goToPaymentPage: (url: string, orderId?: string) => { calls.push(`go:${url}:${orderId}`) },
    paymentPageDidNotOpen: (orderId?: string) => { calls.push(`stalled:${orderId}`) },
    ...over,
  }
  return { fx, calls }
}
const okResult = { ok: true as const, url: 'https://checkout.stripe.com/c/pay/cs_test_1', orderId: ORDER_A, orderNumber: 1, totalCents: 1 }
const okOutcome = { kind: 'answer', result: okResult, coordination: 'locked' } as PurchaseOutcome

test('S-11 X1: carrying out a plan does what the plan says, in order - and nothing for an empty plan', () => {
  const a = effects()
  flight.carryOutPlan(okOutcome, planAfterPurchase(okOutcome, { mounted: true, isCurrentNow: true }), a.fx)
  assert.deepEqual(a.calls, [`go:${okResult.url}:${ORDER_A}`])
  const refused = { kind: 'answer', result: { ok: false, failure: { kind: 'price_changed', code: 'PRICE_CHANGED', status: 409, retry: false } }, coordination: 'locked' } as PurchaseOutcome
  const b = effects()
  flight.carryOutPlan(refused, planAfterPurchase(refused, { mounted: true, isCurrentNow: true }), b.fx)
  assert.deepEqual(b.calls, ['show:price_changed:PRICE_CHANGED', 'refresh', 'release'])
  const c = effects()
  flight.carryOutPlan(okOutcome, [], c.fx)
  assert.deepEqual(c.calls, [], 'a page that is gone: no effect at all')
})

test('S-11 X2: the browser does not leave for the payment page (the call throws) - the page says so AT ONCE, with the order, and the button is not left busy', () => {
  const a = effects({ goToPaymentPage: () => bomb('navigation blocked') })
  flight.carryOutPlan(okOutcome, planAfterPurchase(okOutcome, { mounted: true, isCurrentNow: true }), a.fx)
  assert.deepEqual(a.calls, [`stalled:${ORDER_A}`], 'not released twice, not held, not shown twice')
})

test('S-11 X3: if even that fails, the page falls back to the safest state - the failure is shown and the button is HELD (a throw is never a reason to offer "pay")', () => {
  const a = effects({ goToPaymentPage: () => bomb('navigation blocked'), paymentPageDidNotOpen: () => bomb('and so does this') })
  flight.carryOutPlan(okOutcome, planAfterPurchase(okOutcome, { mounted: true, isCurrentNow: true }), a.fx)
  assert.deepEqual(a.calls, [`show:outcome_unknown:${client.PURCHASE_PAGE_ERROR}`, 'hold'])
  // the same when the last step of a plan is the one that fails
  const refused = { kind: 'answer', result: { ok: false, failure: { kind: 'price_changed', code: 'PRICE_CHANGED', status: 409, retry: false } }, coordination: 'locked' } as PurchaseOutcome
  const b = effects({ releaseButton: () => bomb('release') })
  flight.carryOutPlan(refused, planAfterPurchase(refused, { mounted: true, isCurrentNow: true }), b.fx)
  assert.deepEqual(b.calls, ['show:price_changed:PRICE_CHANGED', 'refresh', `show:outcome_unknown:${client.PURCHASE_PAGE_ERROR}`, 'hold'])
})

test('S-11 X4: an effect that fails in the middle does not stop the ones after it', () => {
  const refused = { kind: 'answer', result: { ok: false, failure: { kind: 'price_changed', code: 'PRICE_CHANGED', status: 409, retry: false } }, coordination: 'locked' } as PurchaseOutcome
  const a = effects({ showFailure: () => bomb('could not show') })
  flight.carryOutPlan(refused, planAfterPurchase(refused, { mounted: true, isCurrentNow: true }), a.fx)
  assert.deepEqual(a.calls, ['refresh', 'release'])
})

test('S-11 X5: the plans of the two errors are carried out as they are planned', () => {
  const before = effects()
  flight.carryOutPlan({ kind: 'fault', stage: 'before_request' } as PurchaseOutcome, planAfterPurchase({ kind: 'fault', stage: 'before_request' } as PurchaseOutcome, { mounted: true, isCurrentNow: true }), before.fx)
  assert.deepEqual(before.calls, [`show:purchase_not_started:${client.PURCHASE_UNEXPECTED_ERROR}`, 'release'])
  const uncertain = effects()
  flight.carryOutPlan({ kind: 'fault', stage: 'uncertain' } as PurchaseOutcome, planAfterPurchase({ kind: 'fault', stage: 'uncertain' } as PurchaseOutcome, { mounted: true, isCurrentNow: true }), uncertain.fx)
  assert.deepEqual(uncertain.calls, [`show:outcome_unknown:${client.PURCHASE_PAGE_ERROR}`, 'hold'])
})

// ---- the lock service: an error in the wait itself must not keep the promise from ever settling ---------------------------------------------------------
test('S-11 H1: a signal that can not forget its listener does not keep the turn from starting - the section runs and its value comes back (it used to wait for ever)', async () => {
  const hub = createLockHub()
  const stubborn = { aborted: false, addEventListener() { /* none */ }, removeEventListener() { bomb('no') } } as unknown as AbortSignal
  const result = await Promise.race([
    runCoordinated(async () => 'value', { navigator: navigatorWith(hub.manager), signal: stubborn }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 500)),
  ])
  assert.deepEqual(result, { status: 'done', value: 'value', coordination: 'locked' })
  await flush()
  assert.equal(hub.held(), false)
})

test('S-11 H2: the same signal when the wait RUNS OUT - the answer is "not run", not a promise that never settles', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const hub = createLockHub()
    hub.occupy()
    const stubborn = { aborted: false, addEventListener() { /* none */ }, removeEventListener() { bomb('no') } } as unknown as AbortSignal
    const running = runCoordinated(async () => 'never', { navigator: navigatorWith(hub.manager), signal: stubborn, waitMs: 2_000 })
    await flush()
    mock.timers.tick(2_000)
    assert.deepEqual(await Promise.race([running, new Promise((resolve) => setImmediate(() => resolve('HUNG')))]), { status: 'not_run', reason: 'wait_expired' })
  } finally { mock.timers.reset() }
})

test('S-11 H3: what S-05 pinned stays: the error of the SECTION is still the section\'s own (runCoordinated hands it on, sendPurchase is the one that turns it into an outcome)', async () => {
  await assert.rejects(() => runCoordinated(async () => { throw new Error('mine') }, { navigator: noLocks }), /mine/)
  const hub = createLockHub()
  await assert.rejects(() => runCoordinated(async () => { throw new Error('mine') }, { navigator: navigatorWith(hub.manager) }), /mine/)
  await flush()
  assert.equal(hub.held(), false)
})

// ---- the sentences -----------------------------------------------------------------------------------------------------------------------------------------
test('S-11 M1: the sentence for an error that may have followed a request says the page does not know, where to look FIRST, to leave the cart alone - and denies nothing', () => {
  const message = copy.failureMessage(client.pageErrorFailure(), money)
  assert.match(message, /errore imprevisto/)
  assert.match(message, /non possiamo sapere/)
  assert.match(message, /controlla l'ordine/)
  assert.ok(message.indexOf('controlla l\'ordine') < message.search(/ricarica|riprov|un altro pagamento/i), 'it says "check the order" BEFORE anything about the page or about paying')
  assert.match(message, /Non modificare il carrello/)
  assert.match(message, /«Paga» è disattivato/)
  assert.doesNotMatch(message, /addebit|charged|quando vuoi|ricominci|riprova (quando|subito)|order again|nuov[ao] chiave|new key|senza alcun|nothing was|nulla è stato|nessun (costo|pagamento)|non risulta|risulta|gratuit/i)
  assert.ok(message.length >= 20 && message.length <= 560, `${message.length} characters`)
  assert.doesNotMatch(message, /clorder|cs_[a-z]+_|pi_[A-Za-z0-9]|sk_|whsec_|https?:\/\//)
  assert.notEqual(message, copy.failureMessage(client.outcomeUnknownFailure(), money), 'it is not the sentence of a request that went out and got no answer')
})

test('S-11 M2: the sentence of an error that came BEFORE the request is the one for "not started" - and the sentence for a request with no answer is exactly what it was', () => {
  const before = copy.failureMessage(client.purchaseNotStartedFailure(client.PURCHASE_UNEXPECTED_ERROR), money)
  assert.equal(before, copy.failureMessage(client.purchaseNotStartedFailure(), money))
  assert.match(before, /non è stato inviato nulla/)
  const unknown = copy.failureMessage(client.outcomeUnknownFailure(), money)
  assert.match(unknown, /non riusciamo a verificare|non può sapere/i)
  assert.match(unknown, /evita di modificare il carrello/)
  assert.equal(copy.failureMessage(client.outcomeUnknownFailure(0, 'BAD_SESSION_ANSWER'), money), unknown, 'any other code of outcome_unknown keeps its sentence')
})

test('S-11 M3: the page has the words for the held button and for the way back', () => {
  assert.match(copy.HOSTED_CHECKOUT_COPY.payHeld, /Controlla l'ordine prima di pagare di nuovo/)
  assert.equal(copy.HOSTED_CHECKOUT_COPY.reloadPage, 'Ricarica la pagina')
  const failure = client.paymentPageNotOpenedFailure(ORDER_A)
  assert.deepEqual(failure, { kind: 'unknown', code: 'REDIRECT_STALLED', status: 0, retry: true, orderId: ORDER_A })
  assert.deepEqual(client.paymentPageNotOpenedFailure(), { kind: 'unknown', code: 'REDIRECT_STALLED', status: 0, retry: true })
})

// ---- the source: where the net is -----------------------------------------------------------------------------------------------------------------------------
const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('S-11 Z1: sendPurchase has a net of its own, and the page asks nobody else to put a payment on the wire', () => {
  const text = code(source('lib/checkout-single-flight.ts'))
  const start = text.indexOf('export async function sendPurchase')
  const end = text.indexOf('\nasync function purchaseInTurn', start)
  assert.ok(start > 0 && end > start)
  assert.match(text.slice(start, end), /\bcatch\b/, 'sendPurchase catches')
  assert.equal((text.match(/requestSession\(/g) ?? []).length, 1, 'still ONE place sends the request')
  assert.equal((text.match(/resolveCheckoutKey\(/g) ?? []).length, 1, 'and ONE place makes the key')
  assert.equal(/forgetCheckoutKey\(/.test(text.slice(text.indexOf('function outcomeAfterFault'), text.indexOf('function outcomeAfterFault') + 600)), false, 'an error forgets no key')
})

test('S-11 Z2: pay() puts the call inside a try, hands the plan to carryOutPlan, leaves for the payment page in ONE place, and offers no "pay" while the button is held', () => {
  const hosted = source('components/checkout/HostedCheckout.tsx')
  const body = code(hosted)
  const call = body.indexOf('await sendPurchase(')
  assert.ok(call > 0)
  const tryAt = body.lastIndexOf('try {', call)
  const catchAt = body.indexOf('catch', call)
  assert.ok(tryAt > 0 && catchAt > call && body.slice(tryAt, call).split('}').length <= 2, 'await sendPurchase( is inside a try, with a catch after it')
  assert.match(body, /carryOutPlan\(/)
  assert.equal((body.match(/window\.location\.assign\(/g) ?? []).length, 1, 'ONE place leaves for the payment page')
  assert.ok(body.indexOf('goToPaymentPage') < body.indexOf('window.location.assign('), 'and it is the effect called goToPaymentPage')
  assert.match(body, /!payHeld/, 'the button is not offered while it is held')
  assert.match(hosted, /failure\?\.kind\.match\(\/\^\(items\|option\|minimum\|payment_minimum\|invalid\|review\)\$\/\)/, 'the rule of R1-1b about the kinds that keep the button off is as it was')
  assert.equal(/forgetCheckoutKey\(/.test(body), false, 'the page forgets no key')
})
