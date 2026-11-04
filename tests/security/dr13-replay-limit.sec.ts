// DR-13 follow-up (plan REVISIONE 1, C1): a reservation whose request can only bring EVIDENCE back is sent again at a measured pace, not once per click. The limiter is per order and lives in the
// database (the counter the other limiters of the checkout use), so it holds across requests AND across processes. Two things are never paced, and are tested as such:
//   * a reservation whose session is already IDENTIFIED: asking about a session (retrieve) is not sending anything;
//   * a replay in the first 90 seconds (FRESH_OK): the request is still a NEW one for the provider, duplicates collapse onto one session by the key, and it is the normal path of a double click or
//     of a retry after a lost answer.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit, type Started } from './_dr13-kit'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { EVIDENCE_REPLAY_PACE, REPLAY_PACE_KEY_PREFIX } from '../../lib/checkout-session-plan'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import { killChildren, runTogether } from './_dr13-procs'

let k: Kit
// a way to make the ONE statement that counts the pace fail, the way a database that is unavailable would make it fail
const inject = { counter: 0 }
test.before(async () => {
  k = await bootKit()
  ;(k.prisma as any).$use(async (params: any, next: (p: any) => Promise<any>) => {
    if (inject.counter > 0 && (params.action === 'queryRaw' || params.action === 'executeRaw') && JSON.stringify(params.args ?? '').includes(REPLAY_PACE_KEY_PREFIX)) {   // (only the statement that counts THIS pace: the endpoint's own limiter is not what is tested)
      inject.counter--
      throw new Error('simulated: the counter of the pace could not be written')
    }
    return next(params)
  })
})
test.beforeEach(async () => { inject.counter = 0; await k.fresh(); checkoutSessionHooks.afterLock = null; checkoutSessionHooks.afterLoad = null; checkoutSessionHooks.afterPlan = null; checkoutSessionHooks.withoutFollowUp = false })
test.afterEach(() => killChildren())
test.after(async () => { await k.fresh(); await k.sim.close() })

const MIN = 60_000
const sends = () => k.sim.countOps('create.call')
// the window of a limiter lives in the clock of the database, which a test cannot move: "the window has passed" is said by forgetting the keys of the replay limiter
const windowPasses = () => k.prisma.rateLimit.deleteMany({ where: { key: { startsWith: REPLAY_PACE_KEY_PREFIX } } })
const counter = (name: string, mode?: string) => getInMemoryMetricsSnapshot().counters.filter((c) => c.name === name && (!mode || JSON.stringify(c.labels ?? {}).includes(mode))).reduce((n, c) => n + c.value, 0)

async function lostReservation(): Promise<{ first: Started; orderId: string; attemptId: string }> {
  k.sim.faults.createLostAnswer = 1
  const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  const order = await k.onlyOrder()
  const [attempt] = await k.attemptsOf(order.id)
  assert.equal(attempt.status, 'creating')
  return { first: { ...first, orderId: order.id }, orderId: order.id, attemptId: attempt.id }
}

test('LIMIT evidence-only: a reservation that can only be asked "what did the first call make?" is replayed ONCE per window, however many times the customer presses Pay', async () => {
  const { first } = await lostReservation()
  k.sim.options.replayRevalidatesExpiresAt = true     // the provider will not honour the replay (its expiry is no longer valid for a new request): nothing resolves
  await k.travel(5 * MIN)                              // older than 90 s: the replay can only bring evidence
  await windowPasses()
  const before = await sends()
  const throttledBefore = counter('checkout_reservation_replay_throttled_total', 'EVIDENCE_ONLY')
  const codes: Array<number | string> = []
  for (let i = 0; i < 4; i++) { const r = await k.payAgain(first); codes.push(`${r.status}:${r.json?.code ?? ''}`) }
  assert.equal((await sends()) - before, 1, `the request was sent ${(await sends()) - before} times in a few seconds (answers ${codes.join(' ')})`)
  assert.ok(codes.every((c) => c === '503:RESERVATION_UNRESOLVED'), codes.join(' '))
  assert.equal(counter('checkout_reservation_replay_throttled_total', 'EVIDENCE_ONLY') - throttledBefore, 3, 'the three presses that were not sent were counted as throttled')
  assert.deepEqual(EVIDENCE_REPLAY_PACE, { windowMs: 30_000, max: 1 }, 'one send per window')
  // when the window has passed it is sent again - once
  await windowPasses()
  await k.payAgain(first)
  await k.payAgain(first)
  assert.equal((await sends()) - before, 2)
  await k.assertClean('LIMIT evidence-only')
  assert.equal((await k.attemptsOf(first.orderId)).length, 1, 'still the one reservation')
})

test('LIMIT does not slow the normal path: in the first 90 seconds every press is sent (a double click, a retry after a lost answer) - the pace is for replays that can only bring evidence', async () => {
  const { first } = await lostReservation()
  k.sim.faults.createRateLimited = 50                  // every send is refused with a 429: nothing resolves, every send is counted
  const before = await sends()
  const throttledBefore = counter('checkout_reservation_replay_throttled_total')
  const answers: number[] = []
  for (let i = 0; i < 6; i++) answers.push((await k.payAgain(first)).status)
  assert.equal((await sends()) - before, 6, `sent ${(await sends()) - before} times (answers ${answers.join(' ')})`)
  assert.deepEqual(answers, [502, 502, 502, 502, 502, 502], 'the customer is told the provider is not reachable (a thing to try again), not that the page is being checked')
  assert.equal(counter('checkout_reservation_replay_throttled_total') - throttledBefore, 0, 'nothing was throttled')
  assert.equal(await k.prisma.rateLimit.count({ where: { key: { startsWith: REPLAY_PACE_KEY_PREFIX } } }), 0, 'and nothing was counted')
  await k.assertClean('LIMIT fresh')
})

test('LIMIT does not stand in the way of a session that is already IDENTIFIED: asking about it is not sending; every request reads it', async () => {
  const { first, orderId, attemptId } = await lostReservation()
  const [orphan] = await k.sim.sessionsOf(orderId)
  await k.prisma.paymentAttempt.update({ where: { id: attemptId }, data: { stripeSessionId: orphan.id } })   // the identifier is known (a webhook, an earlier request)
  k.sim.faults.retrieveUnreachable = 5
  const sendsBefore = await sends()
  const reads = await k.sim.countOps('retrieve')
  const answers: number[] = []
  for (let i = 0; i < 5; i++) answers.push((await k.payAgain(first)).status)
  assert.deepEqual(answers, [502, 502, 502, 502, 502])
  assert.equal(await k.sim.countOps('retrieve') - reads, 5, 'every request asked about the session')
  assert.equal(await sends() - sendsBefore, 0, 'and nothing was sent')
  const ok = await k.payAgain(first)
  assert.equal(ok.status, 200, ok.text)
})

test('LIMIT across PROCESSES: six real processes press Pay on the same reservation at the same moment -> ONE of them sends the request again, the others are told to wait', async () => {
  const { orderId } = await lostReservation()
  k.sim.options.replayRevalidatesExpiresAt = true
  await k.travel(5 * MIN)
  await windowPasses()
  const before = await sends()
  const results = await runTogether(k, 6, orderId, { SIM_OPTIONS: JSON.stringify({ replayRevalidatesExpiresAt: true }) })
  assert.deepEqual(results.map((r) => r.exit), [0, 0, 0, 0, 0, 0], JSON.stringify(results.map((r) => [r.label, r.exit, r.kind])))
  assert.equal((await sends()) - before, 1, `the request was sent ${(await sends()) - before} times by six processes`)
  assert.ok(results.every((r) => r.kind === 'error' && r.status === 503 && r.code === 'RESERVATION_UNRESOLVED'), JSON.stringify(results.map((r) => [r.kind, r.status, r.code])))
  await k.assertClean('LIMIT processes')
})

test('LIMIT unavailable: when the pace can NOT be counted nothing is sent (a send nobody counts is what the pace exists to prevent) - the reservation is untouched, and the next press after the fault sends once', async () => {
  const { first, orderId, attemptId } = await lostReservation()
  k.sim.options.replayRevalidatesExpiresAt = true
  await k.travel(5 * MIN)
  await windowPasses()
  const before = await sends()
  inject.counter = 1
  const down = await k.payAgain(first)
  assert.equal(down.status, 503, down.text)
  assert.equal(down.json?.code, 'RESERVATION_UNRESOLVED')
  assert.equal((await sends()) - before, 0, 'nothing was sent')
  const [row] = await k.attemptsOf(orderId)
  assert.deepEqual([row.id, row.status, row.stripeSessionId], [attemptId, 'creating', null], 'the reservation is exactly as it was')
  const up = await k.payAgain(first)
  assert.equal(up.status, 503)
  assert.equal((await sends()) - before, 1, 'once the counter works, the request is sent - once')
  await k.assertClean('LIMIT unavailable')
})
