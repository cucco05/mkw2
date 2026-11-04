// DR-13 follow-up: the test harness itself is part of the proof. These tests judge the harness, not the application:
//   * the unique index of live payment pages (migration 20261104130000_dr13_single_live_page) is the financial backstop of the whole security suite; a test that has to model data made by the
//     OLD code takes it away and the harness puts it back. Putting it back must never destroy rows that are not the test's own legacy fixtures, must fail loudly when the code under test left two
//     live pages that nobody declared, and its presence AND definition are verified after every test and at the end of every file (tests/security/_harness.ts, _live-page-index.ts).
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { db, resetDb } from './_harness'
import { gate } from './_dr13-barrier'
import { Schedule } from './_dr13-schedule'
import {
  allowLegacyTwins, assertLivePageIndexIntact, declareLegacyOrder, guardLivePageIndex, livePageIndexExists, LIVE_PAGE_INDEX, restoreLivePageIndex, withLegacyTwins,
} from './_live-page-index'

test.before(async () => { await resetDb() })

type Prisma = Awaited<ReturnType<typeof db>>
async function orderWith(prisma: Prisma, attempts: Array<{ status: string; session?: string }>) {
  const order = await prisma.printOrder.create({ data: { subtotalCents: 1000, totalCents: 1000, currency: 'EUR' } })
  const ids: string[] = []
  for (const a of attempts) {
    ids.push((await prisma.paymentAttempt.create({ data: { orderId: order.id, amountCents: 1000, currency: 'EUR', status: a.status, stripeSessionId: a.session ?? null, expiresAt: new Date(Date.now() + 600_000) } })).id)
  }
  return { orderId: order.id, ids }
}

test('A1 putting the index back does NOT delete attempts: an unrelated live attempt of another order is still there, and the extra attempt of a DECLARED legacy order is closed - not deleted', async () => {
  const prisma = await db()
  await resetDb()
  const unrelated = await orderWith(prisma, [{ status: 'open', session: 'cs_harness_unrelated' }])
  await allowLegacyTwins(prisma)
  const legacy = await orderWith(prisma, [{ status: 'open', session: 'cs_harness_legacy_a' }, { status: 'open', session: 'cs_harness_legacy_b' }])
  await declareLegacyOrder(prisma, legacy.orderId, 'A1')
  const result = await restoreLivePageIndex(prisma)
  assert.deepEqual(result, { closed: 1, created: true })
  assert.equal(await prisma.paymentAttempt.count({ where: { id: unrelated.ids[0] } }), 1, 'the attempt of an unrelated order was destroyed by the restore of the index')
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: unrelated.ids[0] } })).status, 'open', 'and it was not touched')
  const rows = await prisma.paymentAttempt.findMany({ where: { orderId: legacy.orderId }, orderBy: { createdAt: 'asc' } })
  assert.equal(rows.length, 2, 'the rows of the legacy fixture must be closed, not deleted')
  assert.deepEqual(rows.map((r) => r.status), ['open', 'expired'], 'the oldest stays, the extra one is closed')
  assert.equal(rows[1].failureReason, 'legacy_fixture_closed_by_harness')
  await assertLivePageIndexIntact(prisma, 'A1')
})

test('A2 two live attempts that NOBODY declared: the index can not be put back, the test fails, nothing is deleted - the evidence stays in the database', async () => {
  const prisma = await db()
  await resetDb()
  await allowLegacyTwins(prisma)
  const left = await orderWith(prisma, [{ status: 'open', session: 'cs_harness_left_a' }, { status: 'creating' }])
  await assert.rejects(() => restoreLivePageIndex(prisma), /no test declared as legacy fixtures/)
  assert.equal(await livePageIndexExists(prisma), false, 'the index must stay missing: putting it back would have meant destroying the evidence')
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: left.orderId } }), 2, 'nothing was deleted')
  // the test cleans up after itself, as a test that declares its fixture does
  await declareLegacyOrder(prisma, left.orderId, 'A2 cleanup')
  assert.equal((await restoreLivePageIndex(prisma)).created, true)
})

test('A3 the DEFINITION is verified, not only the name: a different index with the same name (not partial) is detected', async () => {
  const prisma = await db()
  await resetDb()
  await assertLivePageIndexIntact(prisma, 'A3 before')
  await allowLegacyTwins(prisma)
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "${LIVE_PAGE_INDEX}" ON "PaymentAttempt" ("orderId", "status")`)   // same name, another rule
  await assert.rejects(() => assertLivePageIndexIntact(prisma, 'A3'), /not the one of the migration/)
  await assert.rejects(() => restoreLivePageIndex(prisma), /not the one of the migration/)
  await prisma.$executeRawUnsafe(`DROP INDEX "${LIVE_PAGE_INDEX}"`)
  assert.equal((await restoreLivePageIndex(prisma)).created, true)
  await assertLivePageIndexIntact(prisma, 'A3 after')
})

test('A4 an index that is missing although this process never took it away is a DEFECT: the guard fails instead of repairing it silently', async () => {
  const prisma = await db()
  await resetDb()
  await prisma.$executeRawUnsafe(`DROP INDEX "${LIVE_PAGE_INDEX}"`)   // somebody else dropped it (not through allowLegacyTwins)
  await assert.rejects(() => guardLivePageIndex(prisma, 'A4'), /is MISSING/)
  await allowLegacyTwins(prisma)
  assert.equal((await restoreLivePageIndex(prisma)).created, true)     // (repair, so that the hooks after this test find the world as it should be)
})

test('A5 explicit START-UP RECOVERY: a process that died with the index away leaves it missing; the next file puts it back at the start of resetDb - after emptying the tables, with a message, deleting nothing else', async () => {
  const prisma = await db()
  await resetDb()
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    await allowLegacyTwins(prisma)                       // "the previous process"
    await orderWith(prisma, [{ status: 'open', session: 'cs_harness_crashed_a' }, { status: 'open', session: 'cs_harness_crashed_b' }])   // two live pages left by a test that died
    await resetDb()                                      // "the next file"
  } finally { console.warn = warn }
  await assertLivePageIndexIntact(prisma, 'A5')
  assert.equal(warnings.filter((line) => line.includes('RECOVERED at the start of the file')).length, 1, `the recovery must be announced: ${JSON.stringify(warnings)}`)
  assert.equal(await prisma.paymentAttempt.count(), 0, 'resetDb empties the tables by design before the index is created, so there is no duplicate')
})

test('A6 withLegacyTwins puts the index back in a finally, also when the body throws', async () => {
  const prisma = await db()
  await resetDb()
  const legacy = { id: '' }
  await assert.rejects(() => withLegacyTwins(prisma, async () => {
    const made = await orderWith(prisma, [{ status: 'open', session: 'cs_harness_finally_a' }, { status: 'open', session: 'cs_harness_finally_b' }])
    legacy.id = made.orderId
    await declareLegacyOrder(prisma, made.orderId, 'A6')
    throw new Error('the body failed')
  }), /the body failed/)
  await assertLivePageIndexIntact(prisma, 'A6')
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: legacy.id } }), 2)
})

// ---- the tools of the race tests ------------------------------------------------------------------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('A7 the BARRIER: a flow is held until the test releases it, the test goes on exactly when the flow has arrived, later arrivals pass, and a barrier that nobody reaches (or releases) fails with its NAME', async () => {
  const g = gate('seven', { timeoutMs: 400 })
  const events: string[] = []
  const flow = (async () => { events.push('before'); await g.pass(); events.push('after') })()
  await g.arrive()
  await sleep(20)
  assert.deepEqual(events, ['before'], 'the flow waits at the barrier')
  g.release()
  await flow
  assert.deepEqual(events, ['before', 'after'])
  await g.pass()                                   // an arrival after the release passes at once
  const two = gate('two', { times: 2, timeoutMs: 400 })
  const held = [two.pass(), two.pass()]
  await two.arrive(2)
  assert.equal(two.arrivals(), 2)
  await two.pass()                                 // the third is not held
  two.release()
  await Promise.all(held)
  await assert.rejects(() => gate('never-reached', { timeoutMs: 50 }).arrive(), /gate "never-reached".*expected to arrive/)
  await assert.rejects(() => gate('forgotten', { timeoutMs: 50 }).pass(), /gate "forgotten".*nobody released it/)
})

test('A8 the SCHEDULER: the same seed gives the same order and the same trace, other seeds give other orders, an atomic step is never interleaved, a job is a flow of its own, and a stuck flow is reported with the trace', async () => {
  const run = async (seed: number) => {
    const s = new Schedule(seed)
    const log: string[] = []
    const actors = ['a0', 'a1', 'a2'].map((id) => s.actor(id, async () => {
      for (let i = 0; i < 3; i++) { await s.checkpoint(`step${i}`); log.push(`${id}:${i}`) }
      await s.atomic(async () => { log.push(`${id}:begin`); await s.checkpoint('inside'); await sleep(2); log.push(`${id}:end`) })
      void s.job('close', async () => { await s.checkpoint('job-step'); log.push(`${id}:job`) })   // started and not waited for, like the jobs of the code under test
    }))
    await s.run()
    await Promise.all(actors)
    return { log, trace: [...s.trace] }
  }
  const first = await run(5)
  for (let i = 0; i < 5; i++) assert.deepEqual(await run(5), first, 'the same seed, the same order and the same trace')
  const orders = new Set<string>()
  for (let seed = 1; seed <= 12; seed++) {
    const { log } = await run(seed)
    orders.add(JSON.stringify(log))
    for (const id of ['a0', 'a1', 'a2']) assert.equal(log.indexOf(`${id}:end`) - log.indexOf(`${id}:begin`), 1, `seed ${seed}: the atomic step of ${id} was interleaved with another flow: ${log.join(' ')}`)
    assert.equal(log.filter((entry) => entry.endsWith(':job')).length, 3, `seed ${seed}: every job ran`)
  }
  assert.ok(orders.size >= 6, `the seeds explore different orders (${orders.size} different orders in 12 seeds)`)
  assert.ok(first.trace.some((entry) => /a\d\.close\d start/.test(entry)), 'a job appears in the trace as a flow of its own, named after the flow that started it')
  const stuck = new Schedule(1, { watchdogMs: 120 })
  void stuck.actor('a0', async () => { await new Promise(() => { /* never returns and never parks */ }) }).catch(() => {})
  await assert.rejects(() => stuck.run(), /the scheduler is stuck: holder=a0/)
})
