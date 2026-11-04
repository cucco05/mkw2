// A cooperative, SEEDED scheduler for the DR-13 interleavings.
//
// The problem it solves: pausing the actors for a few random milliseconds (the first campaign) explores a different interleaving every time - the same seed gave different outcomes (55 different
// summaries in 397 repetitions) - so a counterexample could not be run again. Here the actors do NOT run at the same time: exactly ONE flow runs, between two CHECKPOINTS; at a checkpoint it parks,
// and the scheduler chooses - from the seed alone, over the parked flows in a fixed order - which one runs next. Two runs of the same seed take the same decisions in the same order, so a failure
// is a trace that can be run again (DR13_SEEDS=1 DR13_FIRST_SEED=<seed>), and the harness proves it (dr13-interleavings.sec.ts, "replay").
//
// A checkpoint is a point where the code under test is OUTSIDE any database transaction and any lease, and has just decided or is about to call the provider:
//   plan:<step>      a decision was taken and its transaction committed          create / created   the provider is about to create / has created (the answer is still in flight)
//   retrieve         the provider is asked about a session                        expire / expired   the provider is about to close / has closed a page (the answer is still in flight)
//   op:<name>        between two operations of an actor                           start              a flow (an actor, a background job) begins
// NOT a checkpoint: anything inside a transaction, or while a payment sync holds the lease of the order (its retrieves carry `expand`): a flow parked there would hold what the others need and the
// interleaving would depend on how long they wait. The operations of the outside world (a status read, a webhook, a payment, an operator, a fault, time passing) and the background jobs that record
// a page found paid run as ONE step (`atomic`); they are interleaved with the others at their boundaries.
// What this does NOT explore: real contention for a lock, a lease or a connection. The tests with real processes (dr13-multiprocess, dr13-crash, payment-sync-multiprocess) and the FREE mode of the
// campaign (DR13_MODE=free: random pauses, inside the lock too; not replayable) do.
// Not a test file (its name does not match the test patterns).
import { AsyncLocalStorage } from 'node:async_hooks'

export type Flow = { id: string; kind: 'actor' | 'job'; atomic: number; jobs: number; counters: Map<string, number>; decidedOn?: string | null }
export type Mode = 'cooperative' | 'free'

export function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// a number in [0, 1) that depends only on its four arguments (the pauses of the free mode)
export function hashed(seed: number, who: string, what: string, n: number): number {
  let h = 2166136261 ^ seed
  for (const ch of `${who}|${what}|${n}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 100000) / 100000
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Parked = { flow: Flow; label: string; resume: () => void }

export class Schedule {
  readonly mode: Mode
  readonly flows = new AsyncLocalStorage<Flow>()
  // what happened, in order, in words that do not depend on identifiers or on time: "<decision> <flow> <checkpoint>"
  readonly trace: string[] = []
  private readonly parked = new Map<string, Parked>()
  private live = 0
  private holder: string | null = null
  private last: string | null = null
  private decisions = 0
  private orphans = 0
  private waiters: Array<() => void> = []
  private readonly rnd: () => number
  private readonly stickiness: number
  private readonly watchdogMs: number

  constructor(readonly seed: number, options: { mode?: Mode; watchdogMs?: number } = {}) {
    this.mode = options.mode ?? 'cooperative'
    this.watchdogMs = options.watchdogMs ?? 30_000
    this.rnd = mulberry32((seed * 2654435761 + 0x9e3779b9) | 0)
    // how often the flow that has just parked is chosen again (long runs of one flow against many short ones): a property of the seed
    this.stickiness = [0, 0.5, 0.8][((seed % 3) + 3) % 3]
  }

  current(): Flow | null { return this.flows.getStore() ?? null }

  private poke() { const waiting = this.waiters; this.waiters = []; for (const wake of waiting) wake() }
  private async until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + this.watchdogMs
    while (!condition()) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the scheduler is stuck: ${this.describe()}`)), Math.max(1, deadline - Date.now()))
        this.waiters.push(() => { clearTimeout(timer); resolve() })
      })
    }
  }
  describe() { return `holder=${this.holder ?? '-'} live=${this.live} parked=[${[...this.parked.values()].map((p) => `${p.flow.id}@${p.label}`).sort().join(', ')}] after ${this.trace.slice(-6).join(' | ')}` }

  private park(flow: Flow, label: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const n = (flow.counters.get(label) ?? 0) + 1
      flow.counters.set(label, n)
      this.parked.set(`${flow.id}|${label}|${n}`, { flow, label, resume: resolve })
      if (this.holder === flow.id) this.holder = null
      this.poke()
    })
  }
  private finish(flow: Flow) {
    if (this.holder === flow.id) this.holder = null
    this.live--
    this.poke()
  }

  // The code under test (through a hook) or an actor reaches a point where another flow may run.
  async checkpoint(label: string): Promise<void> {
    const flow = this.flows.getStore()
    if (!flow) return                       // not a flow of this schedule (the body of the test, the set-up)
    if (this.mode === 'free') {
      const n = (flow.counters.get(label) ?? 0) + 1
      flow.counters.set(label, n)
      const ms = Math.floor(hashed(this.seed, flow.id, label, n) * 5) * 3   // 0, 3, 6, 9 or 12 ms
      if (ms > 0) { this.trace.push(`${flow.id} ${label}#${n} +${ms}ms`); await sleep(ms) }
      return
    }
    if (flow.atomic > 0) return
    await this.park(flow, label)
  }

  // `fn` is ONE step of the flow: no checkpoint inside it parks.
  async atomic<T>(fn: () => Promise<T>): Promise<T> {
    const flow = this.flows.getStore()
    if (!flow || this.mode === 'free') return fn()
    flow.atomic++
    try { return await fn() } finally { flow.atomic-- }
  }

  private newFlow(id: string, kind: Flow['kind'], atomic = 0): Flow {
    return { id, kind, atomic, jobs: 0, counters: new Map() }
  }

  // An actor: a flow that starts parked and runs `body` when the scheduler first chooses it.
  actor(id: string, body: () => Promise<void>, startMs = 0): Promise<void> {
    const flow = this.newFlow(id, 'actor')
    if (this.mode === 'free') return this.flows.run(flow, async () => { await sleep(startMs); await body() })
    this.live++
    return this.flows.run(flow, async () => {
      try { await this.park(flow, 'start'); await body() } finally { this.finish(flow) }
    })
  }

  // A background job of the code under test (checkoutPagesHooks.runJob): a flow of its own, named after the flow that started it. A job that records a page found paid runs as one step: it
  // holds the lease of the order while it reads, and a flow that is parked must not hold what the others wait for.
  job(kind: string, work: () => Promise<unknown>): Promise<unknown> {
    if (this.mode === 'free') return work()
    const parent = this.flows.getStore()
    const id = `${parent ? parent.id : 'bg'}.${kind}${parent ? ++parent.jobs : ++this.orphans}`
    const flow = this.newFlow(id, 'job', kind === 'record' ? 1 : 0)
    this.live++
    return this.flows.run(flow, async () => {
      try { await this.park(flow, 'start'); return await work() } finally { this.finish(flow) }
    })
  }

  // Drives the flows until every one of them (the jobs that were started on the way included) has finished.
  async run(): Promise<void> {
    if (this.mode === 'free') return
    for (;;) {
      await this.until(() => this.holder === null)
      if (this.live === 0) return
      await this.until(() => this.parked.size > 0 || this.live === 0)
      if (this.live === 0) return
      const keys = [...this.parked.keys()].sort()
      const again = this.last === null ? undefined : keys.find((key) => key.startsWith(`${this.last}|`))
      const stay = this.rnd() < this.stickiness
      const pick = Math.floor(this.rnd() * keys.length)
      const key = again && stay ? again : keys[pick]
      const entry = this.parked.get(key) as Parked
      this.parked.delete(key)
      this.holder = entry.flow.id
      this.last = entry.flow.id
      this.trace.push(`${++this.decisions} ${entry.flow.id} ${entry.label}`)
      entry.resume()
    }
  }
}
