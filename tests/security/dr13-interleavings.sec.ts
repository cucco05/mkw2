// DR-13 phase 5: SEEDED INTERLEAVINGS. Each seed builds a scenario at random - how the order starts (a page, a page at the margin, a reservation whose answer was lost, no page at all, twin pages
// made by the old code), who acts (2 to 4 actors: a customer pressing "Pay", a confirmation page, a customer paying, an operator closing a page, the provider expiring one, a webhook, an
// administrator attesting a payment, a fault of the provider, time passing) - and runs the actors AT THE SAME TIME, with a pause drawn from the seed at every point where the code under test
// calls the provider, takes the lock of the order or has just decided (the hooks of the code and of the stand-in). The pause of an actor at its n-th such point depends only on (seed,
// actor, point, n): the same seed gives the same plan and, apart from the jitter of the database (about a millisecond against pauses that are multiples of three), the same interleaving.
// The judge is the same for every seed - the invariants, read from what the provider really holds - and a failure says the seed, the plan and the trace:
//   V1 never more than one payable session for an order (unknown ones included; sessions made by the old code are declared)      V3 at most one page that was handed out is payable
//   V2 a page is handed out only if registered on a live attempt                                                                    V4 never for an order that is not payable
//   and, once everything has settled: an order that is paid, being confirmed or cancelled has no payable page; each effect of a payment happened at most once; no order has two live
//   attempts unless the old code left them; and - where the provider is not made to refuse replays - the customer can always get a page again, or is told why not.
// DR13_SEEDS (default 100) and DR13_FIRST_SEED (default 1) choose the seeds; the validation of DR-13 runs 400.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { bootKit, SESSION_TTL_MS, type Kit, type Started } from './_dr13-kit'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { syncHooks } from '../../lib/payment-sync'
import { closePagesOfOrder, pageJobsSettled } from '../../lib/checkout-pages'

const SEEDS = Number(process.env.DR13_SEEDS || 100)
const FIRST_SEED = Number(process.env.DR13_FIRST_SEED || 1)
const MIN = 60_000
const HOUR = 3_600_000

let k: Kit
test.before(async () => { k = await bootKit() })
test.after(async () => { clearHooks(); await k.fresh(); await k.sim.close() })

// ---- the seed ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// a number in [0, 1) that depends only on its four arguments
function hashed(seed: number, who: string, what: string, n: number): number {
  let h = 2166136261 ^ seed
  for (const ch of `${who}|${what}|${n}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 100000) / 100000
}

// ---- the pauses -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// `decidedOn`: why the order was NOT payable at the moment of this actor's latest decision (read under the lock of the order, which nobody can change meanwhile), or null if it was payable
type Actor = { id: string; counters: Map<string, number>; decidedOn?: string | null }
const who = new AsyncLocalStorage<Actor>()
let currentSeed = 0
let trace: string[] = []
let violations: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function pause(what: string) {
  const actor = who.getStore()
  if (!actor) return
  const n = (actor.counters.get(what) ?? 0) + 1
  actor.counters.set(what, n)
  const ms = Math.floor(hashed(currentSeed, actor.id, what, n) * 5) * 3   // 0, 3, 6, 9 or 12 ms
  if (ms > 0) { trace.push(`${actor.id} ${what}#${n} +${ms}ms`); await sleep(ms) }
}
let orderUnderTest = ''
function installHooks() {
  checkoutSessionHooks.afterLock = async () => {
    const actor = who.getStore()
    if (actor && orderUnderTest) actor.decidedOn = await k.orderIsPayable(orderUnderTest)
    await pause('lock')
  }
  checkoutSessionHooks.afterPlan = (step) => pause(`plan:${step}`)
  k.sim.hooks.beforeCreate = () => pause('create')
  k.sim.hooks.duringCreate = () => pause('created')
  k.sim.hooks.beforeRetrieve = () => pause('retrieve')
  k.sim.hooks.duringExpire = () => pause('expire')
  k.sim.hooks.afterExpire = () => pause('expired')
  syncHooks.afterRead = () => pause('syncRead')
}
function clearHooks() {
  checkoutSessionHooks.afterLock = null
  checkoutSessionHooks.afterLoad = null
  checkoutSessionHooks.afterPlan = null
  checkoutSessionHooks.withoutFollowUp = false
  delete syncHooks.afterRead
  if (k) k.sim.hooks = {}
}

// ---- the scenario ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Setup = 'page' | 'margin' | 'lost' | 'twin' | 'nopage'
type Op = 'pay' | 'status' | 'travel' | 'customerPays' | 'operatorExpire' | 'natural' | 'attest' | 'fault' | 'webhookExpired'
const MENU: Op[] = ['pay', 'pay', 'pay', 'pay', 'status', 'travel', 'customerPays', 'operatorExpire', 'natural', 'attest', 'fault', 'webhookExpired']
const FAULTS = [{ createUnreachable: 1 }, { createLostAnswer: 1 }, { retrieveUnreachable: 1 }, { expireUnreachable: 2 }, { createRateLimited: 1 }, { createKeyInUse: 1 }, { expireLostAnswer: 1 }]

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
  const setup = pick<Setup>(['page', 'page', 'margin', 'margin', 'lost', 'lost', 'twin', 'nopage'])
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

async function perform(started: Started, op: Op, arg: number) {
  const orderId = started.orderId
  const pages = async () => k.sim.payable(orderId)
  const choose = <T,>(list: T[]) => (list.length ? list[Math.floor(arg * list.length) % list.length] : null)
  switch (op) {
    case 'pay': {
      const actor = who.getStore()
      if (actor) actor.decidedOn = undefined
      const r = await k.payAgain(started)
      // V4, judged at the moment of the decision: a page is handed out only if, under the lock of the order, the order could be paid
      if (r.status === 200 && actor && actor.decidedOn) violations.push(`V4 ${actor.id} was handed a page (${k.sessionIdOf(r.json.url)}) on a decision taken while the order was not payable (${actor.decidedOn})`)
      break
    }
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
}

async function runSeed(seed: number) {
  const plan = planOf(seed)
  currentSeed = seed
  trace = []
  violations = []
  await k.fresh()
  clearHooks()
  orderUnderTest = ''
  const started = await start(plan)
  orderUnderTest = started.orderId
  k.observing.strict = false
  installHooks()
  const outcomes: string[] = []
  try {
    // every actor runs to its end, whatever the others do: one that is left running would go on acting on the next seed
    const settled = await Promise.allSettled(plan.actors.map((actor) => who.run({ id: actor.id, counters: new Map() }, async () => {
      await sleep(actor.startMs)
      for (const { op, arg } of actor.ops) {
        try { await perform(started, op, arg); outcomes.push(`${actor.id}:${op}`) } catch (error) { throw new Error(`${actor.id} ${op} threw: ${String((error as Error)?.stack || error)}`) }
      }
    })))
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
    assert.ok(reachable.length <= 1 || plan.setup === 'twin', `${reachable.length} payable pages known to somebody at the end`)
    if (['paid', 'free', 'processing'].includes(end.order.paymentStatus) || end.order.status === 'cancelled') {
      assert.deepEqual(reachable, [], `an order that is ${end.order.paymentStatus}/${end.order.status} has payable pages that somebody knows`)
    }
    if (plan.setup !== 'twin') assert.ok(live.length <= 1, `${live.length} live attempts: ${JSON.stringify(attempts.map((a) => [a.status, a.stripeSessionId]))}`)
    for (const [name, count] of Object.entries(k.effects)) assert.ok(count <= 1, `the effect "${name}" of a payment ran ${count} times`)
    assert.ok(await k.sim.createdSessions() <= 6, 'too many sessions were created')
    if (process.env.DR13_VERBOSE) {
      const ops = await k.opNames()
      const count = (prefix: string) => ops.filter((op) => op.startsWith(prefix)).length
      console.log('SEEDSUM ' + JSON.stringify({ seed, setup: plan.setup, revalidates: plan.revalidates, ops: plan.actors.map((x) => x.ops.map((o) => o.op).join('+')), answers, sessions: await k.sim.createdSessions(), creates: count('create.call'), replays: count('create.replay'), expires: count('expire.executed'), refused: count('expire.refused'), retrieves: count('retrieve'), order: `${end.order.status}/${end.order.paymentStatus}${end.order.review ? '/' + end.order.review : ''}`, attempts: attempts.map((a) => a.status).join(',') }))
    }
    // liveness: with a provider that honours a replay, the customer is never left without an answer that moves things on
    if (!plan.revalidates && answers.length > 0) {
      const last = answers[answers.length - 1]
      const waits = attempts.some((a) => a.status === 'creating') || (await k.sim.sessionsOf(orderId)).length === 0
      assert.ok(last === 200 || last === 409 || waits || plan.setup === 'lost', `the customer ended with ${last} (${answers.join(',')}) although nothing is unresolved`)
    }
  } catch (error) {
    throw new Error(`SEED ${seed} (${plan.setup}${plan.revalidates ? ', replays revalidated' : ''}) failed\n  plan: ${JSON.stringify(plan.actors.map((a) => [a.id, a.startMs, a.ops.map((o) => o.op)]))}\n  done: ${outcomes.join(' ')}\n  trace: ${trace.slice(0, 40).join(' | ')}\n  ${String((error as Error)?.stack || error)}`)
  } finally {
    clearHooks()
  }
}

for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
  test(`seed ${seed}`, async () => { await runSeed(seed) })
}
