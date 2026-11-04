// DR-13 SEEDED INTERLEAVINGS. Each seed builds a scenario at random - how the order starts (a page, a page at the margin, a reservation whose answer was lost, no page at all, twin pages made by
// the old code), who acts (2 to 4 actors: a customer pressing "Pay", a confirmation page, a customer paying, an operator closing a page, the provider expiring one, a webhook, an administrator
// attesting a payment, a fault of the provider, time passing) - and runs the actors against each other under a SCHEDULER (tests/security/_dr13-schedule.ts):
//   cooperative (default)  exactly one flow runs between two checkpoints (the points where the code under test has decided, or is about to call the provider, outside any transaction); which parked
//                          flow runs next is decided by the seed alone. The same seed takes the same decisions in the same order: a failure is a TRACE that can be run again, and the last test of this
//                          file proves that (the same seeds, three times, the same trace and the same outcome). It does not explore contention for a lock or the lease.
//   free (DR13_MODE=free)  the actors run at the same time with pauses drawn from the seed at every checkpoint, the lock of the order and the payment sync's lease included. It explores real
//                          contention; it is NOT replayable (the jitter of the database decides), so it is a soak, not a proof.
// The judge is the same for every seed and every mode - the invariants, read from what the provider really holds - and a failure says the seed, the plan and the trace:
//   V1 never more than one payable session for an order (unknown ones included; sessions made by the old code are declared)      V3 at most one page that was handed out is payable
//   V2 a page is handed out only if registered on a live attempt                                                                    V4 never for an order that is not payable
//   and, once everything has settled: an order that is paid, being confirmed or cancelled has no payable page; each effect of a payment happened at most once; no order has two live attempts -
//   the twin pages of the old code included: the next request that is answered closes them, with proof; and - where the provider is not made to refuse replays - the customer can always get a
//   page again, or is told why not.
// DR13_SEEDS (default 100) and DR13_FIRST_SEED (default 1) choose the seeds; the validation of DR-13 runs 400. DR13_TRACE_DIR=<dir> writes the trace of every seed there.
import './_harness'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { bootKit, SESSION_TTL_MS, type Kit, type Started } from './_dr13-kit'
import { mulberry32, Schedule, type Mode } from './_dr13-schedule'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { syncHooks } from '../../lib/payment-sync'
import { checkoutPagesHooks, closePagesOfOrder, pageJobsSettled } from '../../lib/checkout-pages'

const SEEDS = Number(process.env.DR13_SEEDS || 100)
const FIRST_SEED = Number(process.env.DR13_FIRST_SEED || 1)
const MODE: Mode = process.env.DR13_MODE === 'free' ? 'free' : 'cooperative'
const MIN = 60_000
const HOUR = 3_600_000

let k: Kit
test.before(async () => { k = await bootKit() })
test.after(async () => { clearHooks(); await k.fresh(); await k.sim.close() })

// ---- the hooks: every checkpoint of the code under test goes through the scheduler ------------------------------------------------------------------------------------------------
let schedule: Schedule
let orderUnderTest = ''
let violations: string[] = []
function installHooks() {
  // inside the transaction that decides, right after the order was locked: what the order was AT THE MOMENT of the decision (nobody can change it meanwhile). Not a checkpoint - except in the free mode,
  // where the actors pause in here with the lock held.
  checkoutSessionHooks.afterLock = async () => {
    const flow = schedule.current()
    if (flow && orderUnderTest) flow.decidedOn = await k.orderIsPayable(orderUnderTest)
    if (schedule.mode === 'free') await schedule.checkpoint('lock')
  }
  checkoutSessionHooks.afterPlan = (step) => schedule.checkpoint(`plan:${step}`)
  k.sim.hooks.beforeCreate = () => schedule.checkpoint('create')
  k.sim.hooks.duringCreate = () => schedule.checkpoint('created')
  // (the retrieves of the payment sync carry `expand` and are made while it holds the lease of the order: a flow is never parked there)
  k.sim.hooks.beforeRetrieve = (_id, params) => ((params as any)?.expand?.length ? Promise.resolve() : schedule.checkpoint('retrieve'))
  k.sim.hooks.duringExpire = () => schedule.checkpoint('expire')
  k.sim.hooks.afterExpire = () => schedule.checkpoint('expired')
  checkoutPagesHooks.runJob = (kind, work) => schedule.job(kind, work)
  if (schedule.mode === 'free') syncHooks.afterRead = () => schedule.checkpoint('syncRead')
}
function clearHooks() {
  checkoutSessionHooks.afterLock = null
  checkoutSessionHooks.afterLoad = null
  checkoutSessionHooks.afterPlan = null
  checkoutSessionHooks.withoutFollowUp = false
  checkoutPagesHooks.runJob = null
  delete syncHooks.afterRead
  if (k) { k.sim.hooks = {}; k.jobs.wait = true }
}

// ---- the scenario ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Setup = 'page' | 'margin' | 'lost' | 'twin' | 'nopage'
type Op = 'pay' | 'status' | 'travel' | 'customerPays' | 'operatorExpire' | 'natural' | 'attest' | 'fault' | 'webhookExpired'
const MENU: Op[] = ['pay', 'pay', 'pay', 'pay', 'status', 'travel', 'customerPays', 'operatorExpire', 'natural', 'attest', 'fault', 'webhookExpired']
const FAULTS = [{ createUnreachable: 1 }, { createLostAnswer: 1 }, { retrieveUnreachable: 1 }, { expireUnreachable: 2 }, { createRateLimited: 1 }, { createKeyInUse: 1 }, { expireLostAnswer: 1 }]
const SETUPS: Setup[] = ['page', 'page', 'margin', 'margin', 'lost', 'lost', 'twin', 'nopage']

async function orderWithoutPage(): Promise<Started> {
  const keep = { lock: checkoutSessionHooks.afterLock }
  checkoutSessionHooks.afterLock = async () => { throw new Error('the first request died before it reserved anything') }
  const started = await k.startCheckout(k.newBrowser(), { allowFailure: true })
  checkoutSessionHooks.afterLock = keep.lock
  const order = await k.onlyOrder()
  return { ...started, orderId: order.id }
}

type Plan = { seed: number; setup: Setup; revalidates: boolean; actors: Array<{ id: string; startMs: number; ops: Array<{ op: Op; arg: number }> }> }
function planOf(seed: number): Plan {
  const rnd = mulberry32(seed * 7919 + 13)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]
  const setup = pick<Setup>(SETUPS)
  const actors = Array.from({ length: 2 + Math.floor(rnd() * 3) }, (_, i) => ({
    id: `a${i}`,
    startMs: Math.floor(rnd() * 4) * 5,
    ops: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ op: pick(MENU), arg: rnd() })),
  }))
  // one actor always asks for a page: a scenario without the question has nothing to judge
  actors[0].ops[0] = { op: 'pay', arg: rnd() }
  return { seed, setup, revalidates: rnd() < 0.3, actors }
}

async function start(plan: Plan): Promise<Started> {
  const rnd = mulberry32(plan.seed * 31 + 5)
  k.sim.options.replayRevalidatesExpiresAt = plan.revalidates
  // A request that meets the SAME key while the first one is still being executed: the provider makes it wait for the result ('wait') or refuses it with the 409 `idempotency_key_in_use` ('409', what
  // the real provider documents). A flow parked inside the provider's call (`created`: the answer is in flight) must not be waited for by the flow that holds the turn - so the scheduled mode uses
  // the 409 (and so explores the code's answer to it); the free mode, where the actors really overlap, keeps the waiting.
  k.sim.options.inflight = MODE === 'free' ? 'wait' : '409'
  if (plan.setup === 'nopage') return orderWithoutPage()
  if (plan.setup === 'lost') {
    k.sim.faults.createLostAnswer = 1
    const first = await k.startCheckout(k.newBrowser(), { allowFailure: true })
    const order = await k.onlyOrder()
    await k.travel([0, 20_000, 2 * MIN, 5 * MIN, 40 * MIN, 5 * HOUR][Math.floor(rnd() * 6)])
    return { ...first, orderId: order.id }
  }
  const a = await k.startCheckout(k.newBrowser())
  if (plan.setup === 'margin') await k.travel(SESSION_TTL_MS - [15_000, 45_000, 59_000, 61_000, 90_000, 5 * MIN][Math.floor(rnd() * 6)])
  if (plan.setup === 'twin') {
    const twin = await k.addLegacyTwin(a.orderId)
    await k.sim.recordDelivery(a.orderId, twin.sessionId, 'legacy twin')   // both pages are in somebody's hands
  }
  return a
}

// What the provider and the customer do on their own (the provider expires a page, the customer pays) is not the code under test: a fault that is injected for the code under test (a connection that
// drops) must not make THEM fail - when the stand-in refuses them for that reason they simply did not get to act. Anything else that goes wrong in them is a failure.
async function theirs<T>(action: () => Promise<T>): Promise<T | null> {
  try { return await action() } catch (error: any) {
    if (error?.type === 'StripeConnectionError') return null
    throw error
  }
}

// `pay` is the code under test: it runs with its checkpoints. Everything else is the outside world, and is ONE step.
async function perform(started: Started, op: Op, arg: number, outcomes: string[], actorId: string) {
  const orderId = started.orderId
  const pages = async () => k.sim.payable(orderId)
  const choose = <T,>(list: T[]) => (list.length ? list[Math.floor(arg * list.length) % list.length] : null)
  if (op === 'pay') {
    const flow = schedule.current()
    if (flow) flow.decidedOn = undefined
    const r = await k.payAgain(started)
    outcomes.push(`${actorId}:pay:${r.status}${r.json?.code ? `:${r.json.code}` : ''}`)
    // V4, judged at the moment of the decision: a page is handed out only if, under the lock of the order, the order could be paid
    if (r.status === 200 && flow && flow.decidedOn) violations.push(`V4 ${actorId} was handed a page (${k.sessionIdOf(r.json.url)}) on a decision taken while the order was not payable (${flow.decidedOn})`)
    return
  }
  await schedule.atomic(async () => {
    switch (op) {
      case 'status': await k.getStatus(orderId, { ...started.who, cookie: started.accessCookie ?? undefined }, arg < 0.5); break
      case 'travel': await k.travel([5_000, 40_000, 25 * MIN, 31 * MIN, 33 * MIN, 2 * HOUR][Math.floor(arg * 6) % 6]); break
      case 'customerPays': {
        const delivered = new Set(await k.sim.deliveries(orderId))
        const id = choose((await pages()).filter((p) => delivered.has(p)))
        if (id) await theirs(() => k.customerPays(id))
        break
      }
      case 'operatorExpire': {
        const id = choose(await pages())
        if (id) { try { await k.sim.expire(id) } catch { /* already closed */ } if (arg < 0.6) await k.announceExpired(id) }
        break
      }
      case 'natural': { const id = choose(await pages()); if (id) await theirs(() => k.expireNaturally(id)); break }
      case 'attest': await k.prisma.printOrder.updateMany({ where: { id: orderId, paymentStatus: 'pending' }, data: { paymentStatus: 'paid', status: 'queued', paidAt: new Date() } }); break
      case 'fault': Object.assign(k.sim.faults, FAULTS[Math.floor(arg * FAULTS.length) % FAULTS.length]); break
      case 'webhookExpired': {
        const expired = (await k.sim.sessionsOf(orderId)).filter((s) => s.status === 'expired').map((s) => s.id)
        const id = choose(expired)
        if (id) await k.announceExpired(id)
        break
      }
    }
  })
}

// ---- one seed ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What a run of a seed leaves, in words that do not depend on identifiers or on time: two runs of the same seed must give the same.
type Outcome = { trace: string[]; summary: Record<string, unknown> }

async function runSeed(seed: number): Promise<Outcome> {
  const plan = planOf(seed)
  schedule = new Schedule(seed, { mode: MODE })
  violations = []
  await k.fresh()
  clearHooks()
  orderUnderTest = ''
  const started = await start(plan)
  orderUnderTest = started.orderId
  k.observing.strict = false
  const outcomes: string[] = []
  const dump = () => {
    if (!process.env.DR13_TRACE_DIR) return
    mkdirSync(process.env.DR13_TRACE_DIR, { recursive: true })
    writeFileSync(`${process.env.DR13_TRACE_DIR}/seed-${seed}.trace`, `${JSON.stringify(plan.actors.map((a) => [a.id, a.ops.map((o) => o.op)]))}\n${schedule.trace.join('\n')}\n`)
  }
  try {
    installHooks()
    k.jobs.wait = MODE === 'free'   // (cooperative: the background jobs are flows of the schedule - a flow that holds the turn can not wait for them)
    // every actor runs to its end, whatever the others do: one that is left running would go on acting on the next seed
    const flows = plan.actors.map((actor) => schedule.actor(actor.id, async () => {
      for (const { op, arg } of actor.ops) {
        await schedule.checkpoint(`op:${op}`)
        try { await perform(started, op, arg, outcomes, actor.id) } catch (error) { throw new Error(`${actor.id} ${op} threw: ${String((error as Error)?.stack || error)}`) }
      }
    }, actor.startMs))
    await schedule.run()
    const settled = await Promise.allSettled(flows)
    const rejected = settled.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
    if (rejected) throw rejected.reason
    await pageJobsSettled()
    clearHooks()
    assert.deepEqual(violations, [], 'the decision of an actor was taken on an order that could not be paid')
    k.sim.faults = { ...k.sim.faults, createUnreachable: 0, createRateLimited: 0, createKeyInUse: 0, createInvalid: 0, createLostAnswer: 0, retrieveUnreachable: 0, expireUnreachable: 0, expireLostAnswer: 0, expireStored500: 0, retrieveInconclusive: 0 }
    const orderId = started.orderId
    await k.assertClean(`seed ${seed} after the actors`)

    // ---- everything settles: the next sign of life of the order, the customer asks again
    await closePagesOfOrder(orderId)
    await pageJobsSettled()
    const snap = await k.snapshot(orderId)
    const answers: number[] = []
    if (!['paid', 'free', 'processing'].includes(snap.order.paymentStatus) && snap.order.status !== 'cancelled') {
      for (let i = 0; i < 3; i++) {
        const r = await k.payAgain(started)
        answers.push(r.status)
        if (r.status === 200 || r.status === 409) break
        await k.travel(MIN)
      }
    }
    await pageJobsSettled()
    await k.assertClean(`seed ${seed} at the end`)

    const end = await k.snapshot(orderId)
    const attempts = await k.attemptsOf(orderId)
    const live = attempts.filter((a) => a.status === 'creating' || a.status === 'open')
    // the accepted window (I-5): a session the provider made whose answer the database never got, and that nobody was given, may be payable for as long as it lives - nobody can reach it
    const known = new Set([...attempts.map((a) => a.stripeSessionId).filter(Boolean), ...(await k.sim.deliveries(orderId))])
    const reachable = end.payable.filter((id) => known.has(id))
    // (no exemption for the twin pages of the old code: once the customer's request has been answered they have been closed, with proof, whatever the others did)
    assert.ok(reachable.length <= 1, `${reachable.length} payable pages known to somebody at the end`)
    if (['paid', 'free', 'processing'].includes(end.order.paymentStatus) || end.order.status === 'cancelled') {
      assert.deepEqual(reachable, [], `an order that is ${end.order.paymentStatus}/${end.order.status} has payable pages that somebody knows`)
    }
    assert.ok(live.length <= 1, `${live.length} live attempts: ${JSON.stringify(attempts.map((a) => [a.status, a.stripeSessionId]))}`)
    for (const [name, count] of Object.entries(k.effects)) assert.ok(count <= 1, `the effect "${name}" of a payment ran ${count} times`)
    assert.ok(await k.sim.createdSessions() <= 6, 'too many sessions were created')
    const ops = (await k.opNames()).map((op) => op.split(':')[0])
    const count = (prefix: string) => ops.filter((op) => op.startsWith(prefix)).length
    if (process.env.DR13_VERBOSE) {
      console.log('SEEDSUM ' + JSON.stringify({ seed, setup: plan.setup, revalidates: plan.revalidates, ops: plan.actors.map((x) => x.ops.map((o) => o.op).join('+')), answers, sessions: await k.sim.createdSessions(), creates: count('create.call'), replays: count('create.replay'), expires: count('expire.executed'), refused: count('expire.refused'), retrieves: count('retrieve'), order: `${end.order.status}/${end.order.paymentStatus}${end.order.review ? '/' + end.order.review : ''}`, attempts: attempts.map((a) => a.status).join(',') }))
    }
    // liveness: with a provider that honours a replay, the customer is never left without an answer that moves things on
    if (!plan.revalidates && answers.length > 0) {
      const last = answers[answers.length - 1]
      const waits = attempts.some((a) => a.status === 'creating') || (await k.sim.sessionsOf(orderId)).length === 0
      assert.ok(last === 200 || last === 409 || waits || plan.setup === 'lost', `the customer ended with ${last} (${answers.join(',')}) although nothing is unresolved`)
    }
    dump()
    return {
      trace: [...schedule.trace],
      summary: {
        setup: plan.setup, outcomes, answers, order: `${end.order.status}/${end.order.paymentStatus}${end.order.review ? `/${end.order.review}` : ''}`,
        attempts: attempts.map((a) => `${a.status}${a.failureReason ? `:${a.failureReason}` : ''}`), payable: end.payable.length, sessions: await k.sim.createdSessions(),
        ops, effects: { ...k.effects },
      },
    }
  } catch (error) {
    dump()
    throw new Error(`SEED ${seed} (${plan.setup}${plan.revalidates ? ', replays revalidated' : ''}, ${MODE}) failed\n  plan: ${JSON.stringify(plan.actors.map((a) => [a.id, a.startMs, a.ops.map((o) => o.op)]))}\n  done: ${outcomes.join(' ')}\n  trace: ${schedule.trace.slice(-60).join(' | ')}\n  replay: DR13_SEEDS=1 DR13_FIRST_SEED=${seed} DR13_TRACE_DIR=<dir> node --test --import tsx tests/security/dr13-interleavings.sec.ts\n  ${String((error as Error)?.stack || error)}`)
  } finally {
    clearHooks()
  }
}

for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
  test(`seed ${seed}`, async () => { await runSeed(seed) })
}

// ---- replay: the point of the scheduler ---------------------------------------------------------------------------------------------------------------------------------------
// The same seed, run again, takes the same decisions in the same order and ends in the same place. Checked on the first seeds of every kind of set-up, three times each; a seed whose runs differ is a
// seed whose counterexample could not be replayed, and the test says which, with the first place the traces part.
if (MODE === 'cooperative') {
  test('replay: the same seed gives the same schedule (the same decisions in the same order) and the same outcome - three runs of the first seeds of every kind of set-up', async () => {
    const chosen: number[] = []
    for (const setup of new Set(SETUPS)) {
      let found = 0
      for (let seed = 1; seed < 400 && found < 2; seed++) if (planOf(seed).setup === setup) { chosen.push(seed); found++ }
    }
    assert.ok(chosen.length >= 10, 'seeds of every kind of set-up were found')
    const differing: string[] = []
    for (const seed of chosen) {
      const runs: Outcome[] = []
      for (let i = 0; i < 3; i++) runs.push(await runSeed(seed))
      const [first, ...others] = runs
      for (const [i, other] of others.entries()) {
        const at = first.trace.findIndex((entry, n) => entry !== other.trace[n])
        const sameTrace = first.trace.length === other.trace.length && at === -1
        const sameSummary = JSON.stringify(first.summary) === JSON.stringify(other.summary)
        if (!sameTrace || !sameSummary) {
          differing.push(`seed ${seed} (${planOf(seed).setup}) run ${i + 2}: ${sameTrace ? 'same trace' : `traces part at decision ${at === -1 ? Math.min(first.trace.length, other.trace.length) : at + 1} (${first.trace[at] ?? 'end'} vs ${other.trace[at] ?? 'end'})`}; ${sameSummary ? 'same outcome' : `outcomes differ:\n   ${JSON.stringify(first.summary)}\n   ${JSON.stringify(other.summary)}`}`)
        }
      }
      assert.ok(first.trace.length > 0, `seed ${seed} took no scheduling decision at all`)
    }
    assert.deepEqual(differing, [], 'a seed must be replayable')
  })
}
