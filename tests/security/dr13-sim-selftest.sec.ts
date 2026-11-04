// DR-13 phase 1: the stand-in for Stripe is tested BEFORE it is used to judge anything. If it were forgiving where the provider is not, every "green" below would be worth nothing;
// if it were harsher than the provider, a RED test would prove nothing about the code. So each rule it claims to follow (see the header of _stripe-sim.ts) is checked here, once.
// These tests do not touch the application at all; they pass on any version of it.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { paramsHash, StripeSim, canonical } from './_stripe-sim'
import { clock } from './_clock'

const sim = new StripeSim()
const ORDER = 'ordSimSelfTest0001'
// `expires_at` is fixed ONCE per test: two sets of parameters built a few milliseconds apart must be the same request (the application takes it from the stored reservation, which never moves)
let baseExpires = 0
const params = (over: Record<string, any> = {}) => ({
  mode: 'payment', payment_method_types: ['card'], client_reference_id: ORDER, metadata: { orderId: ORDER, attemptId: 'att1' },
  line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 1000, product_data: { name: 'x' } } }],
  expires_at: baseExpires, success_url: 'https://x.test/ok', ...over,
})
const key = (label: string) => `sim-selftest-${label}-${Math.random().toString(36).slice(2, 8)}`
const refused = async (promise: Promise<unknown>) => promise.then(() => null, (error) => error as any)

test.before(async () => { await sim.install() })
test.beforeEach(async () => { clock.reset(); await sim.reset(); baseExpires = Math.floor((Date.now() + 32 * 60_000) / 1000) })
test.after(async () => { clock.reset(); await sim.reset(); await sim.close() })

test('time travel: the clock moves, the stored things do not - a page expires at its expires_at, a saved result outlives it, a key is pruned after a day', async () => {
  const k = key('time')
  const p = params()
  const s = await sim.create(p, { idempotencyKey: k })
  clock.shift(31 * 60_000)
  assert.deepEqual(await sim.payable(ORDER), [s.id], '31 minutes after: one minute left')
  clock.shift(2 * 60_000)
  assert.deepEqual(await sim.payable(ORDER), [], '33 minutes after: expired at the provider')
  assert.equal((await sim.pay(s.id)).paid, false)
  // the SAME parameters (their expires_at is now in the past) with the key still kept: optimistic answer = the saved result
  sim.options.replayRevalidatesExpiresAt = false
  assert.equal((await sim.create(p, { idempotencyKey: k })).id, s.id)
  sim.options.replayRevalidatesExpiresAt = true
  assert.equal((await refused(sim.create(p, { idempotencyKey: k }))).param, 'expires_at')
  // a day later the key may be gone: the replay is a new request, and its expires_at is long past: refused, nothing created
  clock.shift(24 * 3_600_000)
  sim.options.replayRevalidatesExpiresAt = false
  const afterPrune = await refused(sim.create(p, { idempotencyKey: k }))
  assert.equal(afterPrune.param, 'expires_at')
  assert.equal(await sim.createdSessions(), 1)
  assert.equal(new Date().getTime() - clock.realNow() >= 24 * 3_600_000, true, 'new Date() follows the clock too')
})

test('a replay returns the SNAPSHOT of the first answer ("open"), never the current state; retrieve shows the real state', async () => {
  const k = key('snapshot')
  const first = await sim.create(params(), { idempotencyKey: k })
  assert.equal(first.status, 'open')
  assert.equal((await sim.pay(first.id)).paid, true)
  const replay = await sim.create(params(), { idempotencyKey: k })
  assert.equal(replay.id, first.id)
  assert.equal(replay.status, 'open', 'the replay is the first answer, as it was')
  assert.equal((await sim.retrieve(first.id)).status, 'complete', 'the session itself has moved on')
  assert.equal(await sim.createdSessions(), 1)
})

test('the same key with other parameters is an idempotency error and creates nothing', async () => {
  const k = key('mismatch')
  await sim.create(params(), { idempotencyKey: k })
  const error = await refused(sim.create(params({ success_url: 'https://other.test/ok' }), { idempotencyKey: k }))
  assert.equal(error.type, 'StripeIdempotencyError')
  assert.equal(error.statusCode, 400)
  assert.equal(await sim.createdSessions(), 1)
})

test('a request that fails validation saves NOTHING: the same key can be used again with valid parameters', async () => {
  const k = key('validation')
  const tooSoon = params({ expires_at: Math.floor((Date.now() + 10 * 60_000) / 1000) })
  const error = await refused(sim.create(tooSoon, { idempotencyKey: k }))
  assert.equal(error.type, 'StripeInvalidRequestError')
  assert.equal(error.param, 'expires_at')
  assert.equal(await sim.createdSessions(), 0)
  const created = await sim.create(params(), { idempotencyKey: k })
  assert.ok(created.id)
  assert.equal(await sim.createdSessions(), 1)
})

test('a stored 500 is replayed as the same 500 (no second session), and the session it may have created exists', async () => {
  const k = key('stored500')
  sim.faults.createStored500Created = 1
  const first = await refused(sim.create(params(), { idempotencyKey: k }))
  assert.equal(first.statusCode, 500)
  assert.equal(await sim.createdSessions(), 1, 'the execution had created it')
  const replay = await refused(sim.create(params(), { idempotencyKey: k }))
  assert.equal(replay.statusCode, 500, 'the saved result is the error')
  assert.equal(await sim.createdSessions(), 1)
  // and a 500 of an execution that created nothing looks exactly the same from outside
  const k2 = key('stored500none')
  sim.faults.createStored500NotCreated = 1
  assert.equal((await refused(sim.create(params({ metadata: { orderId: ORDER, attemptId: 'att2' } }), { idempotencyKey: k2 }))).statusCode, 500)
  assert.equal((await refused(sim.create(params({ metadata: { orderId: ORDER, attemptId: 'att2' } }), { idempotencyKey: k2 }))).statusCode, 500)
  assert.equal(await sim.createdSessions(), 1, 'nothing was created by the second key: the caller cannot tell the two cases apart')
})

test('a lost answer: the session exists, the caller saw a connection error, a replay returns it', async () => {
  const k = key('lost')
  sim.faults.createLostAnswer = 1
  const first = await refused(sim.create(params(), { idempotencyKey: k }))
  assert.equal(first.type, 'StripeConnectionError')
  assert.equal(await sim.createdSessions(), 1)
  const replay = await sim.create(params(), { idempotencyKey: k })
  assert.equal(await sim.createdSessions(), 1)
  assert.equal(replay.status, 'open')
})

test('a key older than the retention horizon may be gone: the same key then makes a NEW request (a second session)', async () => {
  const k = key('pruned')
  const first = await sim.create(params(), { idempotencyKey: k })
  await sim.ageKey(k, 25 * 3_600_000)
  const again = await sim.create(params(), { idempotencyKey: k })
  assert.notEqual(again.id, first.id)
  assert.equal(await sim.createdSessions(), 2)
})

test('replay of a saved result whose expires_at is no longer valid for a NEW request: both answers of the open question are modelled', async () => {
  const k = key('replay-expiry')
  // the parameters of a reservation made a few minutes ago: their expires_at is now only 20 minutes ahead (a NEW request with it is invalid)
  const p = params({ expires_at: Math.floor((Date.now() + 20 * 60_000) / 1000) })
  const id = await sim.seedSession({ orderId: ORDER, attemptId: 'att1', key: k, params: p })
  sim.options.replayRevalidatesExpiresAt = false
  const optimistic = await sim.create(p, { idempotencyKey: k })
  assert.equal(optimistic.id, id, 'optimistic: the saved result comes back')
  sim.options.replayRevalidatesExpiresAt = true
  const pessimistic = await refused(sim.create(p, { idempotencyKey: k }))
  assert.equal(pessimistic.param, 'expires_at', 'pessimistic: the provider re-checks the expiry and refuses')
  const brandNew = await refused(sim.create(p, { idempotencyKey: key('replay-expiry-new') }))
  assert.equal(brandNew.param, 'expires_at', 'and a NEW request with that expiry is invalid in both modes')
  assert.equal(await sim.createdSessions(), 1, 'nothing was created by any of the three calls')
})

test('expire: works on an open session, is REFUSED on a complete one and on an expired one (HTTP 400)', async () => {
  const open = await sim.create(params({ metadata: { orderId: ORDER, attemptId: 'a1' } }), { idempotencyKey: key('e1') })
  const done = await sim.expire(open.id)
  assert.equal(done.status, 'expired')
  const again = await refused(sim.expire(open.id))
  assert.equal(again.statusCode, 400)
  assert.match(again.message, /can be expired/)
  const other = await sim.create(params({ client_reference_id: 'ordOther', metadata: { orderId: 'ordOther', attemptId: 'a2' } }), { idempotencyKey: key('e2') })
  assert.equal((await sim.pay(other.id)).paid, true)
  const onComplete = await refused(sim.expire(other.id))
  assert.equal(onComplete.statusCode, 400)
  assert.equal((await sim.retrieve(other.id)).status, 'complete', 'the refusal left the session as it was')
})

test('pay and expire race ATOMICALLY: exactly one of them wins, over many tries', async () => {
  for (let i = 0; i < 25; i++) {
    const order = `ordRace${i}`
    const session = await sim.create(params({ client_reference_id: order, metadata: { orderId: order, attemptId: `r${i}` } }), { idempotencyKey: key(`race${i}`) })
    const [paid, expired] = await Promise.all([sim.pay(session.id), refused(sim.expire(session.id)).then((error) => error === null)])
    assert.equal(Number(paid.paid) + Number(expired), 1, `try ${i}: paid=${paid.paid} expired=${expired}`)
    const status = (await sim.retrieve(session.id)).status
    assert.equal(status, paid.paid ? 'complete' : 'expired')
  }
})

test('a session stops being payable at its expires_at (marked expired when somebody looks), and a payment is then refused', async () => {
  const s = await sim.create(params(), { idempotencyKey: key('natural') })
  await sim.expiresIn(s.id, -1000)
  assert.equal((await sim.pay(s.id)).paid, false)
  assert.equal((await sim.retrieve(s.id)).status, 'expired')
  assert.deepEqual(await sim.payable(ORDER), [])
})

test('two simultaneous creates with the same key give ONE session (wait), or the 409 for the loser (inflight=409)', async () => {
  sim.faults.createDelayMs = 200
  sim.faults.delayFirstCreateOnly = true
  const k = key('inflight')
  // ONE set of parameters per scenario: `expires_at` is computed from the clock, and two sets built a few milliseconds apart can differ by a second - that would be another request
  const p = params()
  const both = await Promise.all([sim.create(p, { idempotencyKey: k }), sim.create(p, { idempotencyKey: k })])
  assert.equal(both[0].id, both[1].id)
  assert.equal(await sim.createdSessions(), 1)
  await sim.reset()
  sim.options.inflight = '409'
  sim.faults.createDelayMs = 200
  sim.faults.delayFirstCreateOnly = true
  const k2 = key('inflight409')
  const p2 = params()
  const settled = await Promise.allSettled([sim.create(p2, { idempotencyKey: k2 }), new Promise((r) => setTimeout(r, 60)).then(() => sim.create(p2, { idempotencyKey: k2 }))])
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1)
  const loser: any = (settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason
  assert.equal(loser.statusCode, 409)
  assert.equal(loser.code, 'idempotency_key_in_use')
})

test('the monitor: a second payable session for an order is a recorded violation; sessions seeded as legacy are a premise, not a violation', async () => {
  await sim.create(params(), { idempotencyKey: key('m1') })
  assert.deepEqual(await sim.violations(), [])
  await sim.create(params({ metadata: { orderId: ORDER, attemptId: 'att2' } }), { idempotencyKey: key('m2') })
  const found = await sim.violations()
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'payable_gt_1')
  await sim.reset()
  await sim.seedSession({ orderId: ORDER, attemptId: 'x1', legacy: true })
  await sim.seedSession({ orderId: ORDER, attemptId: 'x2', legacy: true })
  assert.deepEqual(await sim.violations(), [], 'twins made by the old code are the premise')
  await sim.create(params({ metadata: { orderId: ORDER, attemptId: 'att3' } }), { idempotencyKey: key('m3') })
  assert.equal((await sim.violations()).length, 1, 'but a NEW payable session next to them is a violation')
})

test('canonical form and hash ignore key order and undefined, and notice any real difference', () => {
  assert.equal(paramsHash({ a: 1, b: { c: [1, 2], d: undefined } }), paramsHash({ b: { c: [1, 2] }, a: 1 }))
  assert.notEqual(paramsHash({ a: 1 }), paramsHash({ a: 2 }))
  assert.deepEqual(canonical({ z: 1, a: undefined, m: { y: 2, x: 1 } }), { m: { x: 1, y: 2 }, z: 1 })
})

test('payment intents and the expanded session look like the provider\'s (what payment-sync and payment-hold read)', async () => {
  const s = await sim.create(params(), { idempotencyKey: key('pi') })
  const { paid, piId } = await sim.pay(s.id)
  assert.equal(paid, true)
  const plain = await sim.retrieve(s.id)
  assert.equal(plain.payment_intent, piId)
  const expanded = await sim.retrieve(s.id, { expand: ['payment_intent.latest_charge'] })
  assert.equal(expanded.payment_intent.status, 'succeeded')
  assert.equal(expanded.payment_intent.amount_received, 1000)
  assert.equal(expanded.payment_intent.latest_charge.id.startsWith('ch_SIM_'), true)
  assert.equal(expanded.payment_status, 'paid')
  assert.equal(expanded.url, null, 'a session that is not open has no page')
})
