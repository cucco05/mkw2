// Step 4.3 – what the return page does with the order status endpoint: reading the answer, how often to ask, and when the cart is emptied.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_POLLS, POLL_DELAYS_MS, classifyStatusAnswer, emptiesCart, fetchOrderStatus, forgetPendingOrder, nextPollDelayMs, parsePublicStatus,
  pendingOrderIs, rememberPendingOrder, shouldKeepAsking, PUBLIC_STATES,
} from '../lib/order-status-client'
import type { PublicCheckoutState } from '../lib/checkout-status'

const good = { orderNumber: 12, state: 'paid', totalCents: 1234, currency: 'EUR', final: true, pollAfterMs: null }

// ---- reading the answer -------------------------------------------------------------------------------------------------------------------
test('a good answer is read; anything that is not exactly what the endpoint sends is an error, never a state', () => {
  assert.deepEqual(parsePublicStatus(good), good)
  assert.equal(parsePublicStatus({ ...good, currency: 'eur' })?.currency, 'EUR')
  const bad: unknown[] = [
    null, undefined, 'paid', 42, [], {}, { ...good, state: 'PAID' }, { ...good, state: 'completed' }, { ...good, state: '' }, { ...good, state: undefined },
    { ...good, orderNumber: 0 }, { ...good, orderNumber: -3 }, { ...good, orderNumber: 1.5 }, { ...good, orderNumber: '12' },
    { ...good, totalCents: -1 }, { ...good, totalCents: 12.5 }, { ...good, totalCents: '1234' }, { ...good, totalCents: Number.NaN },
    { ...good, currency: 'GBP' }, { ...good, currency: 5 }, { ...good, final: 'yes' }, { ...good, final: undefined },
    { ...good, pollAfterMs: -1 }, { ...good, pollAfterMs: 'soon' }, { ...good, pollAfterMs: 10_000_000 },
  ]
  for (const body of bad) assert.equal(parsePublicStatus(body), null, JSON.stringify(body))
  // extra fields are dropped, not passed on
  assert.deepEqual(Object.keys(parsePublicStatus({ ...good, stripeSessionId: 'cs_x', email: 'a@b.test' })!).sort(), ['currency', 'final', 'orderNumber', 'pollAfterMs', 'state', 'totalCents'])
})

test('every state the endpoint can send is accepted', () => {
  for (const state of PUBLIC_STATES) assert.ok(parsePublicStatus({ ...good, state }), state)
})

test('answers are told apart: not found, too many requests, error', () => {
  assert.deepEqual(classifyStatusAnswer(404, { code: 'NOT_FOUND' }), { kind: 'not_found' })
  assert.deepEqual(classifyStatusAnswer(200, good), { kind: 'status', status: good })
  assert.deepEqual(classifyStatusAnswer(200, { state: 'paid' }), { kind: 'error' })
  assert.deepEqual(classifyStatusAnswer(200, null), { kind: 'error' })
  for (const code of [400, 401, 403, 500, 502, 503]) assert.deepEqual(classifyStatusAnswer(code, { error: 'x' }), { kind: 'error' }, String(code))
  assert.deepEqual(classifyStatusAnswer(429, { retryAfterSeconds: 30 }), { kind: 'busy', retryAfterSeconds: 30 })
  assert.deepEqual(classifyStatusAnswer(429, null, '20'), { kind: 'busy', retryAfterSeconds: 20 })
  assert.deepEqual(classifyStatusAnswer(429, null), { kind: 'busy', retryAfterSeconds: 10 })
  assert.deepEqual(classifyStatusAnswer(429, { retryAfterSeconds: 99999 }), { kind: 'busy', retryAfterSeconds: 120 }, 'a huge pause is capped')
  assert.deepEqual(classifyStatusAnswer(429, { retryAfterSeconds: 0 }), { kind: 'busy', retryAfterSeconds: 2 }, 'and a zero is not a busy loop')
})

test('the request: the order id is encoded, the browser says it came back, nothing else is sent, an impossible id is never asked about', async () => {
  const seen: Array<{ url: string; init: any }> = []
  const answer = (status: number, body: unknown) => (async (url: any, init: any) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }) as any
  const ok = await fetchOrderStatus('clorder0000000001', { returned: true }, undefined, answer(200, good))
  assert.equal(ok.kind, 'status')
  assert.equal(seen[0].url, '/api/checkout/status?order=clorder0000000001&return=1')
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.cache, 'no-store')
  assert.equal(seen[0].init.body, undefined)
  await fetchOrderStatus('clorder0000000001', { returned: false }, undefined, answer(200, good))
  assert.equal(seen[1].url, '/api/checkout/status?order=clorder0000000001')
  const before = seen.length
  for (const id of ['', 'x', '../../etc/passwd', 'a b c d e f g h', 'a'.repeat(65), 'order?x=1&y=2']) {
    assert.deepEqual(await fetchOrderStatus(id, { returned: true }, undefined, answer(200, good)), { kind: 'not_found' }, id)
  }
  assert.equal(seen.length, before, 'no request was made for those')
  assert.deepEqual(await fetchOrderStatus('clorder0000000001', { returned: true }, undefined, (async () => { throw new TypeError('offline') }) as any), { kind: 'error' })
  await assert.rejects(fetchOrderStatus('clorder0000000001', { returned: true }, undefined, (async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) }) as any), (err: any) => err.name === 'AbortError')
  assert.deepEqual(await fetchOrderStatus('clorder0000000001', { returned: true }, undefined, (async () => new Response('<html>bad gateway</html>', { status: 502 })) as any), { kind: 'error' })
})

// ---- how often to ask -----------------------------------------------------------------------------------------------------------------------
test('polling: pauses grow, never go below what the server asked, and stop on their own after about two minutes', () => {
  assert.equal(nextPollDelayMs(0, null), 2500)
  assert.equal(nextPollDelayMs(0, 2500), 2500)
  assert.equal(nextPollDelayMs(0, 9000), 9000, 'the server\'s hint is a minimum')
  let total = 0
  let previous = 0
  for (let i = 0; i < MAX_POLLS; i++) {
    const delay = nextPollDelayMs(i, null)
    assert.ok(delay !== null && delay >= previous && delay <= 15_000, `pause ${i}: ${delay}`)
    previous = delay!
    total += delay!
  }
  assert.equal(nextPollDelayMs(MAX_POLLS, null), null, 'after the last one it stops')
  assert.equal(nextPollDelayMs(MAX_POLLS + 50, null), null)
  assert.equal(nextPollDelayMs(-1, null), null)
  assert.equal(nextPollDelayMs(1.5, null), null)
  assert.ok(total >= 100_000 && total <= 150_000, `the whole schedule lasts ${Math.round(total / 1000)} s`)
  assert.ok(MAX_POLLS <= 15, 'a small, fixed number of questions')
  assert.equal(POLL_DELAYS_MS.length, MAX_POLLS)
})

test('only "being confirmed" keeps the page asking; a final answer or "not paid" stops it', () => {
  const states: Record<PublicCheckoutState, boolean> = { confirming: true, pending: false, paid: false, attention: false, canceled: false }
  for (const [state, expected] of Object.entries(states) as Array<[PublicCheckoutState, boolean]>) {
    const final = state === 'paid' || state === 'attention' || state === 'canceled'
    assert.equal(shouldKeepAsking({ orderNumber: 1, state, totalCents: 1, currency: 'EUR', final, pollAfterMs: state === 'confirming' ? 2500 : null }), expected, state)
  }
  assert.equal(shouldKeepAsking(null), false)
})

// ---- the cart -------------------------------------------------------------------------------------------------------------------------------
test('the cart is emptied when the customer has been through the payment page, not when the payment page expired or was left', () => {
  assert.deepEqual((['confirming', 'paid', 'attention'] as const).map(emptiesCart), [true, true, true])
  assert.deepEqual((['pending', 'canceled'] as const).map(emptiesCart), [false, false])
})

test('the browser remembers which order it sent to the payment page: only that one may empty the cart', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  assert.equal(pendingOrderIs(storage, 'clorder0000000001'), false)
  rememberPendingOrder(storage, 'clorder0000000001')
  assert.equal(pendingOrderIs(storage, 'clorder0000000001'), true)
  assert.equal(pendingOrderIs(storage, 'clorder0000000002'), false, 'another order')
  forgetPendingOrder(storage)
  assert.equal(pendingOrderIs(storage, 'clorder0000000001'), false)
  rememberPendingOrder(storage, '../../x')
  assert.equal(store.size, 0, 'an impossible id is not stored')
  // blocked storage (private mode, cookies off) never throws: the cart is simply left alone
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
  assert.doesNotThrow(() => rememberPendingOrder(broken, 'clorder0000000001'))
  assert.equal(pendingOrderIs(broken, 'clorder0000000001'), false)
  assert.doesNotThrow(() => forgetPendingOrder(broken))
  assert.equal(pendingOrderIs(null, 'clorder0000000001'), false)
})
