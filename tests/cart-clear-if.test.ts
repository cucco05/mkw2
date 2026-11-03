// R1-2 (S-07, S-10) – "empty the cart, but only if it still is the cart I was told about": the rules of the engine behind CartProvider.clearIf, tried without React.
//
// What is tested here is the ENGINE (lib/cart-clear-if.ts): when it asks, what it queues, what it takes as proof and when it gives up. The engine is driven by a fake "React": a queue
// of the updates it dispatched, which the test runs by hand, as many times and in whatever order it wants (React may run an updater twice, late, or never). What the REAL
// CartProvider and the real React do with those updates is tested in a real browser: tests/e2e/cart-clear-if.responsive.spec.ts.
//
// The rule behind every case: whatever the engine answers other than "cleared", NO update it queued may empty the cart later.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  CLEAR_IF_WAIT_BOUNDS, CLEAR_IF_WAIT_MS, clearIfWaitMs, createClearIfEngine, precheckClearIf,
  type ClearIfEngine, type ClearIfResult, type PersistedCart,
} from '../lib/cart-clear-if'

type Line = { id: string; qty: number }
const X: Line[] = [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }]
const Y: Line[] = [{ id: 'c', qty: 1 }]
const same = (a: readonly Line[], b: readonly Line[]) => JSON.stringify(a) === JSON.stringify(b)
const isX = (items: readonly Line[]) => items.length === 0 || same(items, X)

// A browser storage, a clock and a React that the test moves by hand.
function world(initial: { cart: Line[]; persisted?: string | null | 'throws'; lastWritten?: string | null }) {
  const state = {
    items: initial.cart as readonly Line[],
    persisted: initial.persisted === undefined ? JSON.stringify(initial.cart) : initial.persisted,
    lastWritten: initial.lastWritten === undefined ? JSON.stringify(initial.cart) : initial.lastWritten,
    queue: [] as Array<{ tick: number; apply: (prev: readonly Line[]) => readonly Line[] }>,
    dispatches: 0,
    timers: [] as Array<{ id: number; run: () => void; ms: number; cleared: boolean }>,
    hops: [] as Array<() => void>,
    hopFails: false,
    tick: 0,
  }
  let timerId = 0
  const engine: ClearIfEngine<Line> = createClearIfEngine<Line>({
    readPersisted: (): PersistedCart => (state.persisted === 'throws' ? { available: false } : { available: true, raw: state.persisted }),
    lastWritten: () => state.lastWritten,
    dispatch: (update) => { state.dispatches++; state.queue.push(update) },
    nextTask: () => (state.hopFails ? Promise.reject(new Error('no task')) : new Promise<void>((resolve) => { state.hops.push(resolve) })),
    setTimer: (run, ms) => { const timer = { id: ++timerId, run, ms, cleared: false }; state.timers.push(timer); return timer },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true },
  })
  // The fake React: runs every queued update on the current state, in order, then "commits" and lets the engine look (the observer effect of the provider).
  const render = (opts: { persist?: boolean; observe?: boolean } = {}) => {
    const pending = state.queue.splice(0)
    let next = state.items
    for (const update of pending) { next = update.apply(next); state.tick = Math.max(state.tick, update.tick) }
    state.items = next
    if (opts.persist !== false && state.persisted !== 'throws') { state.lastWritten = JSON.stringify(next); state.persisted = state.lastWritten }
    if (opts.observe !== false) engine.observe({ items: next, tick: state.tick })
    return next
  }
  const hop = async () => { const resolve = state.hops.shift(); assert.ok(resolve, 'the engine asked for a fresh task'); resolve(); await Promise.resolve(); await Promise.resolve() }
  return { state, engine, render, hop }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const runAndHop = async (w: ReturnType<typeof world>, matches: (items: readonly Line[]) => boolean = isX, options?: { waitMs?: number }) => {
  const result = w.engine.run(matches, options)
  await settle()
  await w.hop()
  await settle()
  return result
}

// ---- the options ----------------------------------------------------------------------------------------------------------------------------
test('S-10 U1: the wait is a number of milliseconds inside the bounds - anything else is the default', () => {
  assert.equal(CLEAR_IF_WAIT_MS, 2000)
  assert.equal(clearIfWaitMs(undefined), CLEAR_IF_WAIT_MS)
  assert.equal(clearIfWaitMs(1234), 1234)
  for (const bad of [Number.NaN, Infinity, -Infinity, 0, -5, '500', null, {}, [], true]) assert.equal(clearIfWaitMs(bad), CLEAR_IF_WAIT_MS, String(bad))
  assert.equal(clearIfWaitMs(1), CLEAR_IF_WAIT_BOUNDS.min)
  assert.equal(clearIfWaitMs(10_000_000), CLEAR_IF_WAIT_BOUNDS.max)
})

// ---- the gate: nothing is queued unless the cart saved in this browser is the one this tab wrote ------------------------------------------------
test('S-10 U2: the gate - the saved cart must be what THIS tab wrote last, and readable', () => {
  const written = JSON.stringify(X)
  const rows: Array<[string, { persisted: PersistedCart; lastWritten: string | null }, ReturnType<typeof precheckClearIf>]> = [
    ['same text', { persisted: { available: true, raw: written }, lastWritten: written }, 'go'],
    ['the empty cart, same text', { persisted: { available: true, raw: '[]' }, lastWritten: '[]' }, 'go'],
    ['another tab saved another cart', { persisted: { available: true, raw: JSON.stringify(Y) }, lastWritten: written }, 'other_tab'],
    ['another tab emptied it', { persisted: { available: true, raw: '[]' }, lastWritten: written }, 'other_tab'],
    ['another tab removed the entry', { persisted: { available: true, raw: null }, lastWritten: written }, 'other_tab'],
    ['same cart, different text (spacing)', { persisted: { available: true, raw: ` ${written}` }, lastWritten: written }, 'other_tab'],
    ['this tab has not saved yet', { persisted: { available: true, raw: written }, lastWritten: null }, 'not_ready'],
    ['not saved yet and nothing readable', { persisted: { available: false }, lastWritten: null }, 'not_ready'],
    ['the storage can not be read', { persisted: { available: false }, lastWritten: written }, 'unavailable'],
    ['nothing saved anywhere', { persisted: { available: true, raw: null }, lastWritten: null }, 'not_ready'],
  ]
  for (const [label, input, expected] of rows) assert.equal(precheckClearIf(input), expected, label)
})

test('S-10 U3: a gate that says no queues NOTHING and the answer says why', async () => {
  const cases: Array<[string, Parameters<typeof world>[0], ClearIfResult]> = [
    ['another tab changed the saved cart', { cart: X, persisted: JSON.stringify(Y) }, { kind: 'kept', reason: 'other_tab' }],
    ['not ready', { cart: X, lastWritten: null }, { kind: 'unconfirmed', reason: 'not_ready' }],
    ['unreadable storage', { cart: X, persisted: 'throws' }, { kind: 'unconfirmed', reason: 'not_persisted' }],
  ]
  for (const [label, setup, expected] of cases) {
    const w = world(setup)
    assert.deepEqual(await runAndHop(w), expected, label)
    assert.equal(w.state.dispatches, 0, `${label}: nothing was queued`)
    assert.equal(w.state.timers.filter((t) => !t.cleared).length, 0, `${label}: no timer is left running`)
    assert.equal(w.state.items, X, `${label}: the cart is the cart`)
  }
})

// ---- the way in: a fresh task first, then one update ----------------------------------------------------------------------------------------
test('S-10 U4: the engine waits for a fresh task before it looks at anything - and looks AFTER it, not before', async () => {
  const w = world({ cart: X })
  const result = w.engine.run(isX)
  await settle()
  assert.equal(w.state.dispatches, 0, 'nothing is queued while it waits for the task')
  assert.equal(w.state.timers.length, 0, 'the timer starts when the update is queued, not before')
  // the world changes during the wait: the gate must see the new world
  w.state.persisted = JSON.stringify(Y)
  await w.hop()
  assert.deepEqual(await result, { kind: 'kept', reason: 'other_tab' })
  assert.equal(w.state.dispatches, 0)
})

test('S-10 U5: cleared - the update empties the cart, the commit is seen, the saved cart reads back empty: only then "cleared"', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  const answer = await Promise.race([result.then(() => 'answered'), settle().then(() => 'waiting')])
  assert.equal(answer, 'waiting', 'queued is not cleared')
  assert.equal(w.state.dispatches, 1, 'exactly one update')
  assert.equal(w.state.queue[0].tick, 1)
  assert.equal(w.state.timers.length, 1)
  assert.equal(w.state.timers[0].ms, CLEAR_IF_WAIT_MS)
  w.render()
  assert.deepEqual(await result, { kind: 'cleared' })
  assert.deepEqual(w.state.items, [])
  assert.ok(w.state.timers[0].cleared, 'the timer is cleared when the answer is known')
})

test('S-10 U6: kept - the cart changed before the update ran: the update leaves it alone, and says "changed"', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  await settle()
  // while the update waits in the queue, something else is queued before it was RUN: a line is added (the cart no longer is the paid one)
  w.state.items = [...X, ...Y]
  w.state.persisted = JSON.stringify(w.state.items); w.state.lastWritten = w.state.persisted
  w.render()
  assert.deepEqual(await result, { kind: 'kept', reason: 'changed' })
  assert.deepEqual(w.state.items, [...X, ...Y])
})

test('S-10 U7: the update is an ordinary updater - it may run twice, three times, in any order, and every run says the same', async () => {
  const w = world({ cart: X })
  void runAndHop(w)
  await settle()
  const [update] = w.state.queue
  const first = update.apply(X)
  const second = update.apply(X)
  assert.deepEqual(first, [])
  assert.equal(first, second, 'the same empty list every time, not a new one: React compares what two runs return')
  assert.equal(update.apply(Y), Y, 'a cart that does not match is returned as it is - the same list, not a copy')
  assert.equal(update.apply(Y), Y)
  const frozen = Object.freeze([...X])
  assert.doesNotThrow(() => update.apply(frozen), 'it never changes the list it is given')
  const empty: readonly Line[] = []
  assert.equal(update.apply(empty), empty, 'an empty cart stays the same empty list')
})

test('S-10 U8: a question that throws is not an answer - nothing is cleared, nothing is claimed', async () => {
  const w = world({ cart: X })
  const boom = () => { throw new Error('predicate failed') }
  const result = runAndHop(w, boom)
  await settle()
  assert.equal(w.state.queue[0].apply(X), X, 'a predicate that throws keeps the cart')
  w.render()
  assert.deepEqual(await result, { kind: 'unconfirmed', reason: 'not_flushed' }, 'and the answer is not "changed": nobody knows')
  assert.deepEqual(w.state.items, X)
})

test('S-10 U9: the commit has to carry the update - one that was seen earlier says nothing', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  await settle()
  const pending = w.state.queue.splice(0)
  // a commit of something else, before the update (an older tick)
  w.engine.observe({ items: [], tick: 0 })
  w.engine.observe({ items: Y, tick: 0 })
  assert.equal(await Promise.race([result.then(() => 'answered'), settle().then(() => 'waiting')]), 'waiting', 'an earlier commit does not answer')
  // the commit that carries it
  w.state.queue.push(...pending)
  w.render()
  assert.deepEqual(await result, { kind: 'cleared' })
})

// ---- the proof: what was committed and what is saved ---------------------------------------------------------------------------------------
test('S-10 U10: the cart is empty but the saved cart is not - NOT cleared (the browser kept the old one, or another tab saved a cart)', async () => {
  const cases: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ['saving failed (storage throws on write)', (w) => { w.state.persisted = JSON.stringify(X) }],
    ['another tab saved a cart in between', (w) => { w.state.persisted = JSON.stringify(Y) }],
    ['the entry is gone', (w) => { w.state.persisted = null }],
    ['the saved text is not exactly the empty list', (w) => { w.state.persisted = '[] ' }],
  ]
  for (const [label, damage] of cases) {
    const w = world({ cart: X })
    const result = runAndHop(w)
    await settle()
    w.render({ persist: false, observe: false })
    damage(w)
    w.engine.observe({ items: [], tick: w.state.tick })
    assert.deepEqual(await result, { kind: 'unconfirmed', reason: 'not_persisted' }, label)
    assert.deepEqual(w.state.items, [], `${label}: the cart in memory is empty - the saved one decides what a reload shows`)
  }
})

test('S-10 U11: the storage becomes unreadable after the commit - NOT cleared', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  await settle()
  w.render({ persist: false, observe: false })
  w.state.persisted = 'throws'
  w.engine.observe({ items: [], tick: w.state.tick })
  assert.deepEqual(await result, { kind: 'unconfirmed', reason: 'not_persisted' })
})

test('S-10 U12: an empty cart that was empty already is "cleared" only if the saved cart reads empty - the same proof', async () => {
  const w = world({ cart: [], persisted: '[]', lastWritten: '[]' })
  const result = runAndHop(w)
  await settle()
  w.render()
  assert.deepEqual(await result, { kind: 'cleared' })
  const bad = world({ cart: [], persisted: '[]', lastWritten: '[]' })
  const second = runAndHop(bad)
  await settle()
  bad.render({ persist: false, observe: false })
  bad.state.persisted = '[{"id":"zzz"}]'
  bad.engine.observe({ items: [], tick: bad.state.tick })
  assert.deepEqual(await second, { kind: 'unconfirmed', reason: 'not_persisted' })
})

test('S-10 U13: the cart still matches after the commit but was not emptied - the update did not run: "not flushed", never "changed"', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  await settle()
  w.state.queue.splice(0)
  w.engine.observe({ items: X, tick: w.state.tick + 1 })
  assert.deepEqual(await result, { kind: 'unconfirmed', reason: 'not_flushed' })
})

// ---- giving up: the rule of S-10 ------------------------------------------------------------------------------------------------------------
test('S-10 U14: the wait runs out - "not flushed", and the update that is STILL QUEUED can not empty the cart any more, whenever React runs it', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  await settle()
  assert.equal(w.state.timers.length, 1)
  w.state.timers[0].run()
  assert.deepEqual(await result, { kind: 'unconfirmed', reason: 'not_flushed' })
  // React wakes up late and runs what was queued: the cart is NOT emptied
  const late = w.render()
  assert.deepEqual(late, X, 'the late run keeps the cart')
  assert.equal(late, X, 'and returns the very same list')
  assert.deepEqual(w.state.items, X)
  // a second late run, after the customer started something else on the same items: still nothing
  w.state.queue.length = 0
  assert.equal(w.engine.pending(), 0)
})

test('S-10 U15: the update queued before the give-up is inert - every way of running it, also after the cart changed back to the same items', async () => {
  const w = world({ cart: X })
  void runAndHop(w)
  await settle()
  const [update] = w.state.queue
  w.state.timers[0].run()
  for (const prev of [X, [...X], [], Y]) assert.equal(update.apply(prev), prev, JSON.stringify(prev))
})

test('S-10 U16: the tab goes away (unmount) - every question is answered "not flushed" and every queued update is inert, also one still waiting for its fresh task', async () => {
  const w = world({ cart: X })
  const first = runAndHop(w)
  await settle()
  const second = w.engine.run(isX)
  await settle()
  const [update] = w.state.queue
  assert.equal(w.engine.pending(), 2)
  w.engine.cancelAll()
  assert.deepEqual(await first, { kind: 'unconfirmed', reason: 'not_flushed' })
  assert.deepEqual(await second, { kind: 'unconfirmed', reason: 'not_flushed' })
  assert.equal(update.apply(X), X)
  await w.hop()
  await settle()
  assert.equal(w.state.dispatches, 1, 'the one that was still waiting for its task queued nothing')
  assert.equal(w.engine.pending(), 0)
  assert.ok(w.state.timers.every((t) => t.cleared), 'no timer is left')
})

test('S-10 U17: the answer is given once - a late commit after "cleared" or after the give-up changes nothing', async () => {
  const w = world({ cart: X })
  const result = runAndHop(w)
  await settle()
  w.render()
  assert.deepEqual(await result, { kind: 'cleared' })
  const [timer] = w.state.timers
  timer.run()
  w.engine.observe({ items: X, tick: 99 })
  w.engine.cancelAll()
  assert.equal(w.engine.pending(), 0)
})

test('S-10 U18: a fresh task that never comes (it fails) is a give-up, not a hang', async () => {
  const w = world({ cart: X })
  w.state.hopFails = true
  assert.deepEqual(await w.engine.run(isX), { kind: 'unconfirmed', reason: 'not_flushed' })
  assert.equal(w.state.dispatches, 0)
})

test('S-10 U19: two questions at once get their own ticks, and one commit answers both for what it carries', async () => {
  const w = world({ cart: X })
  const a = w.engine.run(isX)
  const b = w.engine.run((items) => items.length === 0)
  await settle()
  await w.hop(); await w.hop()
  await settle()
  assert.deepEqual(w.state.queue.map((u) => u.tick), [1, 2])
  w.render()
  assert.deepEqual(await a, { kind: 'cleared' })
  assert.deepEqual(await b, { kind: 'cleared' }, 'the second update saw an empty cart, which matches its own question too')
})

test('S-10 U20: a dispatch that throws is a give-up and leaves no timer', async () => {
  const w = world({ cart: X })
  const throwing = createClearIfEngine<Line>({
    readPersisted: () => ({ available: true, raw: JSON.stringify(X) }),
    lastWritten: () => JSON.stringify(X),
    dispatch: () => { throw new Error('setState failed') },
    nextTask: () => Promise.resolve(),
    setTimer: (run, ms) => { const timer = { id: 0, run, ms, cleared: false }; w.state.timers.push(timer); return timer },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true },
  })
  assert.deepEqual(await throwing.run(isX), { kind: 'unconfirmed', reason: 'not_flushed' })
  assert.ok(w.state.timers.every((t) => t.cleared))
})

// ---- the source: what the engine may and may not do ----------------------------------------------------------------------------------------
const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')

test('S-10 U21: the engine touches nothing by itself - no storage write, no network, no React, no clock of its own', () => {
  const text = source('lib/cart-clear-if.ts')
  const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(/\bsetItem\b|\bremoveItem\b|\blocalStorage\b|\bsessionStorage\b|\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b/.test(code), false, 'no storage write, no network')
  assert.equal(/from 'react'|from "react"|flushSync|startTransition|react-dom/.test(code), false, 'no React, no lane of its own')
  assert.equal(/\bsetTimeout\b|\bsetInterval\b|\bDate\.now\b|\bMath\.random\b|\bqueueMicrotask\b|\bMessageChannel\b/.test(code), false, 'time and tasks come from the caller')
  assert.equal(/^import /m.test(code), false, 'a plain module: it imports nothing')
})

test('S-10 U22: the update the engine queues only READS the state of its question - it writes nothing outside itself', () => {
  const text = source('lib/cart-clear-if.ts')
  const start = text.indexOf('const apply =')
  assert.ok(start > 0, 'the updater is written as a named function `apply`')
  const open = text.indexOf('{', text.indexOf('=>', start))
  let depth = 0
  let end = open
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > open, 'the body of the updater was found')
  const code = text.slice(open, end + 1).replace(/\/\/.*$/gm, '')
  assert.equal(/\bop\.[A-Za-z]+\s*(=(?!=)|\+\+|--|\+=)/.test(code), false, 'it never assigns to the question')
  assert.equal(/\.(push|pop|splice|sort|reverse|shift|unshift)\(/.test(code), false, 'it never changes the list it is given')
  assert.equal(/deps\./.test(code), false, 'it does not call the world: no storage, no timer, no dispatch')
})
