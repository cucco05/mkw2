// The hash chain of the administrators' audit log (lib/admin-audit.ts) under concurrency.
//
// The chain is meant to be ONE line: every event names, as its predecessor, the event that was written just before it, and the hash of an event covers its predecessor's. Two defects of the
// helper broke that (they were found while diagnosing the intermittent failure of the D10 idempotency test, which saw them in 6 runs out of 110):
//   A. the instant of the event (`createdAt`) was taken BEFORE the chain lock was acquired, and the predecessor was chosen as "the latest by createdAt, then by id". Two operations that take their
//      instants in one order and reach the lock in the other leave an event OLDER than the one stored just before it; the next event then picks the wrong predecessor: two events share one
//      predecessor (a fork), one of them is never named by anybody (it is off the line), and - when the material of the two is the same - they even have the same hash (unique violation).
//   B. `pg_advisory_xact_lock` lives as long as the TRANSACTION. The helper accepted an ordinary client, with no transaction: the lock was gone when its own statement ended, and nothing
//      serialized the read of the predecessor and the insert that follows.
// What is judged here, on a throw-away PostgreSQL database (the ordinary test database) and with the order of the operations CONTROLLED, not hoped for:
//   R1  instants taken out of order (B at T, A at T-5 ms, C at T+5 ms, reaching the lock in that order): one chain, and the order of createdAt follows the order of the chain
//   R2  the same instant and the same material for two concurrent operations, with an older event whose id sorts last: no fork, no equal hash
//   R3  an ordinary client (no transaction of the caller's), many at once, with a pause between the read of the predecessor and the insert: the lock protects the whole sequence
//   R4  a caller that hands over its transaction: audit and operation are ONE transaction (same xid; invisible together until the commit; the lock is that transaction's, not another's)
//   R5  the caller's transaction is rolled back (or the audit can not be written): no trace of the cancelled operation is committed, the lock is released, the chain is untouched
//   R6  four distinct processes: one chain, nothing missing, nothing duplicated, nothing rejected
//   R7  a history that ALREADY holds a fork: the diagnostic names it, a new event rewrites nothing of the past and does not hide the fork, and a history that ends with an inverted pair is
//       continued from its real last event
// plus the guards that keep the fix honest: an ordinary client handed over as if it were a transaction is refused (the lock would not hold); timestamps never go backwards along the chain
// and stay close to the clock; the lock is waited for longer than the default transaction time; and the lock order with an operation that holds a row lock first.
//
// The independent oracle below reads the rows and the xid of the transaction that wrote each one (xmin): the order of the writes is the order of the chain lock, because everything that
// writes to the chain is serialized by it. It does not use the library's own diagnostic.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { db } from './_harness'
import * as audit from '../../lib/admin-audit'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'

// ---- a clock the test can set per operation (the helper reads `new Date()` where it needs the instant) ----------------------------------------------------------------------------------
const RealDate = Date
const clockStore = new AsyncLocalStorage<{ now: number }>()
class ControlledDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(clockStore.getStore()?.now ?? RealDate.now())
    else super(...(args as [any]))
  }
  static now() { return clockStore.getStore()?.now ?? RealDate.now() }
}
;(globalThis as any).Date = ControlledDate
const atInstant = <T,>(now: number, work: () => Promise<T>) => clockStore.run({ now }, work)

const KEY = 98234721                      // the chain lock of lib/admin-audit.ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let prisma: Awaited<ReturnType<typeof db>>
let admin: { id: string; email: string; name: string | null }
let createDelayMs = 0                       // a pause the TEST puts between the read of the predecessor and the insert (R3)
let failNextAuditInsert = false

test.before(async () => {
  prisma = await db()
  ;(prisma as any).$use(async (params: any, next: (p: any) => Promise<any>) => {
    if (params.model === 'AdminAuditEvent' && params.action === 'create') {
      if (createDelayMs > 0) await sleep(createDelayMs)
      if (failNextAuditInsert) { failNextAuditInsert = false; throw new Error('the audit insert failed (test)') }
    }
    return next(params)
  })
  await prisma.adminAuditEvent.deleteMany()
  await prisma.user.deleteMany({ where: { email: { endsWith: '@auditchain.invalid' } } })
  const created = await prisma.user.create({ data: { email: 'operator@auditchain.invalid', passwordHash: 'x', name: 'operator', role: 'admin', isAdmin: true } })
  admin = { id: created.id, email: created.email, name: created.name }
})
test.beforeEach(async () => { createDelayMs = 0; failNextAuditInsert = false; await prisma.adminAuditEvent.deleteMany() })
test.after(async () => {
  ;(globalThis as any).Date = RealDate
  await prisma.adminAuditEvent.deleteMany()
  await prisma.user.deleteMany({ where: { email: { endsWith: '@auditchain.invalid' } } })
})

// ---- fixtures -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const input = (over: Record<string, unknown> = {}) => ({
  adminId: admin.id, action: 'auditchain.test', targetType: 'probe', targetId: 'probe', requestMethod: 'TEST', requestPath: 'tests/security/admin-audit-chain.sec.ts', ...over,
}) as any

type Row = { id: string; action: string; prevHash: string | null; eventHash: string; created: number; xid: number }
// every row, in the order the chain lock let the writers in (the xid of the writing transaction), then by instant and id for the events one transaction wrote
async function executed(): Promise<Row[]> {
  const rows = (await prisma.$queryRawUnsafe(`SELECT id, action, "prevHash", "eventHash", (extract(epoch from "createdAt") * 1000)::float8 AS created, xmin::text::bigint AS xid FROM "AdminAuditEvent" ORDER BY xmin::text::bigint, "createdAt", id`)) as any[]
  return rows.map((r) => ({ id: r.id, action: r.action, prevHash: r.prevHash, eventHash: r.eventHash, created: Number(r.created), xid: Number(r.xid) }))
}
// the oracle: one chain, in the order of the writes; and (for what the fixed helper writes) createdAt strictly increasing along it
function judge(rows: Row[], { time = true }: { time?: boolean } = {}): string[] {
  const short = (h: string | null) => (h ? h.slice(0, 8) : 'null')
  const problems: string[] = []
  rows.forEach((row, i) => {
    const expected = i === 0 ? null : rows[i - 1].eventHash
    if ((row.prevHash ?? null) !== expected) problems.push(`#${i + 1} (${row.action}) names ${short(row.prevHash)} as its predecessor but the event written just before it is ${short(expected)}`)
    if (time && i > 0 && !(row.created > rows[i - 1].created)) problems.push(`#${i + 1} (${row.action}) createdAt ${row.created} is not after its predecessor's ${rows[i - 1].created}`)
  })
  if (new Set(rows.map((r) => r.eventHash)).size !== rows.length) problems.push('two events have the same hash')
  const named = new Set(rows.map((r) => r.prevHash).filter(Boolean))
  const unnamed = rows.filter((r, i) => i < rows.length - 1 && !named.has(r.eventHash))
  if (unnamed.length > 0) problems.push(`${unnamed.length} event(s) are not on the line from the last event back to the first: ${unnamed.map((r) => r.action).join(', ')}`)
  return problems
}

// the same question asked of the LINKS alone, for workloads in which the xid does not tell the order of the chain lock (a caller that writes something else first gets its xid before it asks
// for the chain lock): one head, every event named by exactly one other (except the last), the path from the head covers every event, and the instants strictly increase along it
function judgeByLinks(rows: Row[]): string[] {
  const problems: string[] = []
  const heads = rows.filter((r) => !r.prevHash)
  if (heads.length !== 1) problems.push(`${heads.length} events have no predecessor (a chain has exactly one first event)`)
  const successors = new Map<string, Row[]>()
  for (const row of rows) if (row.prevHash) successors.set(row.prevHash, [...(successors.get(row.prevHash) ?? []), row])
  for (const [hash, list] of successors) if (list.length > 1) problems.push(`${list.length} events name ${hash.slice(0, 8)} as their predecessor: ${list.map((r) => r.action).join(', ')}`)
  const path: Row[] = []
  const seen = new Set<string>()
  for (let current: Row | undefined = heads[0]; current && !seen.has(current.id); current = successors.get(current.eventHash)?.[0]) { path.push(current); seen.add(current.id) }
  if (path.length !== rows.length) problems.push(`the path from the first event reaches ${path.length} of ${rows.length} events`)
  path.forEach((row, i) => { if (i > 0 && !(row.created > path[i - 1].created)) problems.push(`${row.action} createdAt is not after its predecessor's`) })
  if (new Set(rows.map((r) => r.eventHash)).size !== rows.length) problems.push('two events have the same hash')
  return problems
}

// the chain lock held by a transaction of the test, so that operations can be made to queue on it in a known order
async function holdChainLock() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let acquired!: () => void
  const got = new Promise<void>((resolve) => { acquired = resolve })
  const done = prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`; acquired(); await gate }, { timeout: 60_000, maxWait: 10_000 })
  await got
  return { release: () => release(), done }
}
const waiting = async () => Number(((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${KEY} AND NOT granted`)) as any[])[0].n)
async function untilWaiting(n: number) {
  for (let i = 0; i < 500; i++) { if ((await waiting()) === n) return; await sleep(10) }
  throw new Error(`${n} operation(s) never queued on the chain lock (${await waiting()} did)`)
}
type Op = { name: string; now: number; action: string; metadata?: unknown }
// start the operations ONE AFTER THE OTHER, each waited for until PostgreSQL shows it queued on the chain lock, then let the lock go: they are let in in this order
async function arriveInOrder(ops: Op[], mode: 'joined' | 'standalone' = 'joined') {
  const holder = await holdChainLock()
  const settled: Array<Promise<{ name: string; ok: boolean; error?: string }>> = []
  for (const [index, op] of ops.entries()) {
    const run = () => (mode === 'joined'
      ? prisma.$transaction((tx) => audit.recordAdminAuditEvent(input({ action: op.action, metadata: op.metadata ?? { op: op.name } }), tx), { timeout: 30_000, maxWait: 10_000 })
      : audit.recordAdminAuditEvent(input({ action: op.action, metadata: op.metadata ?? { op: op.name } })))
    settled.push(atInstant(op.now, run).then(() => ({ name: op.name, ok: true }), (error: any) => ({ name: op.name, ok: false, error: String(error?.code ?? error?.message ?? error).slice(0, 160) })))
    await untilWaiting(index + 1)
  }
  holder.release()
  await holder.done
  return Promise.all(settled)
}
const say = (problems: string[]) => (problems.length ? `\n  - ${problems.join('\n  - ')}` : '')

// ====================================================================================================================================================================
// R1 - defect A: the instant taken before the lock
// ====================================================================================================================================================================
test('R1: instants taken out of order - B at T, A at T-5 ms, C at T+5 ms, reaching the lock in that order - leave ONE chain, and createdAt follows the chain', async () => {
  const T = RealDate.now()
  const results = await arriveInOrder([
    { name: 'B', now: T, action: 'auditchain.b' }, { name: 'A', now: T - 5, action: 'auditchain.a' }, { name: 'C', now: T + 5, action: 'auditchain.c' },
  ])
  assert.deepEqual(results.filter((r) => !r.ok), [], 'no operation is rejected')
  const rows = await executed()
  assert.deepEqual(rows.map((r) => r.action), ['auditchain.b', 'auditchain.a', 'auditchain.c'], 'they were written in the order they reached the lock')
  const problems = judge(rows)
  assert.deepEqual(problems, [], `the chain broke:${say(problems)}`)
})

// ====================================================================================================================================================================
// R2 - defect A: ties, and material that is the same
// ====================================================================================================================================================================
test('R2: two concurrent operations with the SAME instant and the SAME material, after an event whose id sorts last: no fork and no equal hash (no unique violation)', async () => {
  const T = RealDate.now()
  // an event at the same instant whose id sorts AFTER every id a new event can get (written the way the published helper wrote it)
  await insertAsPublished({ id: 'zzzzzzzzzzzzzzzzzzzzzzzzz', at: T, prev: null, action: 'auditchain.seed' })
  const same = { action: 'auditchain.same', metadata: { same: 'material' } }
  const results = await arriveInOrder([{ name: 'A', now: T, ...same }, { name: 'C', now: T, ...same }])
  assert.deepEqual(results.filter((r) => !r.ok), [], `an operation was rejected: ${JSON.stringify(results)}`)
  const rows = await executed()
  assert.equal(rows.length, 3)
  const problems = judge(rows)
  assert.deepEqual(problems, [], `the chain broke:${say(problems)}`)
})

// ====================================================================================================================================================================
// R3 - defect B: an ordinary client, no transaction of the caller's
// ====================================================================================================================================================================
test('R3: eight operations at once with the ordinary client, a pause between the read of the predecessor and the insert: the lock protects the WHOLE sequence', async () => {
  createDelayMs = 30
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => audit.recordAdminAuditEvent(input({ action: `auditchain.n${i}`, metadata: { i } }))))
  createDelayMs = 0
  const rejected = outcomes.filter((o) => o.status === 'rejected').map((o: any) => String(o.reason?.code ?? o.reason?.message).slice(0, 100))
  assert.deepEqual(rejected, [], 'no operation is rejected')
  const rows = await executed()
  assert.equal(rows.length, 8)
  const problems = judge(rows)
  assert.deepEqual(problems, [], `the chain broke:${say(problems)}`)
})

test('R3b: twelve rounds of eight operations at once with the ordinary client and identical material: always one chain, never a rejection', async () => {
  for (let round = 0; round < 12; round++) {
    await prisma.adminAuditEvent.deleteMany()
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => audit.recordAdminAuditEvent(input({ action: 'auditchain.round', metadata: { same: 'material' } }))))
    const rejected = outcomes.filter((o) => o.status === 'rejected').map((o: any) => String(o.reason?.code ?? o.reason?.message).slice(0, 60))
    assert.deepEqual(rejected, [], `round ${round}: operations rejected`)
    const problems = judge(await executed())
    assert.deepEqual(problems, [], `round ${round}: the chain broke:${say(problems)}`)
  }
})

// ====================================================================================================================================================================
// R4 / R5 - the caller's transaction is the transaction (what the 18 callers that hand it over rely on)
// ====================================================================================================================================================================
test('R4: a caller that hands over its transaction - the audit event and the operation are ONE transaction (same xid), invisible together until the commit, and the chain lock is THIS transaction\'s', async () => {
  const email = 'r4@auditchain.invalid'
  let during: any = null
  await prisma.$transaction(async (tx) => {
    const made = await tx.user.create({ data: { email, passwordHash: 'x', name: 'r4' } })
    await audit.recordAdminAuditEvent(input({ action: 'auditchain.r4', targetId: made.id, metadata: { made: made.id } }), tx)
    const [{ pid }] = (await tx.$queryRawUnsafe(`SELECT pg_backend_pid()::int AS pid`)) as any[]
    // looked at from ANOTHER connection, before the commit
    const [visible] = (await prisma.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "User" WHERE email = '${email}')::int AS users, (SELECT count(*) FROM "AdminAuditEvent" WHERE action = 'auditchain.r4')::int AS events`)) as any[]
    const holders = (await prisma.$queryRawUnsafe(`SELECT pid::int AS pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${KEY} AND granted`)) as any[]
    during = { pid: Number(pid), visible, holders: holders.map((h) => Number(h.pid)) }
  })
  assert.deepEqual(during.visible, { users: 0, events: 0 }, 'neither the operation nor its audit event is visible from outside before the commit')
  assert.deepEqual(during.holders, [during.pid], 'the chain lock is held by the caller\'s own transaction - not by another one that would end before it')
  const [after] = (await prisma.$queryRawUnsafe(`SELECT (SELECT xmin::text FROM "User" WHERE email = '${email}') AS user_xid, (SELECT xmin::text FROM "AdminAuditEvent" WHERE action = 'auditchain.r4') AS event_xid`)) as any[]
  assert.ok(after.user_xid && after.event_xid, 'both are there after the commit')
  assert.equal(after.event_xid, after.user_xid, 'written by the SAME transaction')
  const [left] = (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${KEY} AND granted`)) as any[]
  assert.equal(left.n, 0, 'and the lock is gone with it')
})

test('R5: the caller\'s transaction is rolled back after the audit event was written - no event of the cancelled operation is committed, the lock is released, the chain goes on from where it was', async () => {
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.before' }))
  const before = await executed()
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { email: 'r5@auditchain.invalid', passwordHash: 'x' } })
    await audit.recordAdminAuditEvent(input({ action: 'auditchain.cancelled' }), tx)
    throw new Error('the operation is cancelled')
  }), /cancelled/)
  assert.equal(await prisma.adminAuditEvent.count({ where: { action: 'auditchain.cancelled' } }), 0, 'no trace of the cancelled operation')
  assert.equal(await prisma.user.count({ where: { email: 'r5@auditchain.invalid' } }), 0)
  const [lock] = (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${KEY} AND granted`)) as any[]
  assert.equal(lock.n, 0, 'the lock is released')
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.after' }))
  const rows = await executed()
  assert.deepEqual(rows.map((r) => r.action), ['auditchain.before', 'auditchain.after'])
  assert.equal(rows[1].prevHash, before[0].eventHash, 'the next event continues from the last COMMITTED one')
  assert.deepEqual(judge(rows), [])
})

test('R5b: when the audit event can not be written, the caller\'s whole transaction fails with it - the operation is not committed without its trace', async () => {
  failNextAuditInsert = true
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { email: 'r5b@auditchain.invalid', passwordHash: 'x' } })
    await audit.recordAdminAuditEvent(input({ action: 'auditchain.never' }), tx)
  }), /audit insert failed/)
  assert.equal(await prisma.user.count({ where: { email: 'r5b@auditchain.invalid' } }), 0)
  assert.equal(await prisma.adminAuditEvent.count(), 0)
})

// ====================================================================================================================================================================
// R6 - four distinct processes
// ====================================================================================================================================================================
type ChildReport = { label: string; mode: string; done?: number; failures?: string[]; crashed?: string }
function runChildren(mode: 'standalone' | 'joined', o: { procs: number; rounds: number; perRound: number; identical: boolean }): Promise<ChildReport[]> {
  const startAt = Date.now() + 4000
  return Promise.all(Array.from({ length: o.procs }, (_, i) => new Promise<ChildReport>((resolve, reject) => {
    let out = ''
    const proc = spawn(process.execPath, ['--import', 'tsx', 'tests/security/_admin-audit-child.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, CHILD_MODE: mode, CHILD_LABEL: `p${i}`, CHILD_ADMIN: admin.id, CHILD_ROUNDS: String(o.rounds), CHILD_EVENTS_PER_ROUND: String(o.perRound), CHILD_START_AT: String(startAt), CHILD_SPACING_MS: '150', CHILD_IDENTICAL: o.identical ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.on('data', (c) => { out += c }); proc.stderr?.on('data', (c) => { out += c })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`child p${i} did not finish in 120 s:\n${out}`)) }, 120_000)
    proc.on('exit', () => {
      clearTimeout(timer)
      const line = out.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) return resolve({ label: `p${i}`, mode, crashed: `no result: ${out.slice(-300)}` })
      resolve(JSON.parse(line.slice(7)))
    })
  })))
}
for (const mode of ['standalone', 'joined'] as const) {
  test(`R6 (${mode}): four processes, twelve rounds of two events each, at the same moments and with the same material - one chain, nothing missing, nothing duplicated, nothing rejected`, async () => {
    const reports = await runChildren(mode, { procs: 4, rounds: 12, perRound: 2, identical: true })
    assert.deepEqual(reports.filter((r) => r.crashed), [], 'every process finished')
    assert.deepEqual(reports.flatMap((r) => r.failures ?? []), [], 'no operation was rejected')
    assert.deepEqual(reports.map((r) => r.done), [24, 24, 24, 24])
    const rows = await executed()
    assert.equal(rows.length, 96, 'nothing missing')
    assert.equal(new Set(rows.map((r) => r.eventHash)).size, 96, 'nothing duplicated')
    const problems = judge(rows)
    assert.deepEqual(problems, [], `the chain broke:${say(problems)}`)
  })
}

// ====================================================================================================================================================================
// R7 - a history that is already damaged: said, not mended
// ====================================================================================================================================================================
// the hash of the helper as it was published (copied here, so that the fixtures do not depend on the code under test): same material, same canonical form
function legacyStableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => legacyStableJson(entry)).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${legacyStableJson(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
async function insertAsPublished(e: { id: string; at: number; prev: string | null; action: string; metadata?: unknown }) {
  const material = {
    prevHash: e.prev, createdAt: new RealDate(e.at).toISOString(), adminId: admin.id, adminEmail: admin.email, adminName: admin.name, action: e.action, targetType: 'probe', targetId: 'probe',
    requestMethod: 'TEST', requestPath: 'x', requestIp: null, userAgent: null, metadata: e.metadata ?? null,
  }
  const eventHash = createHash('sha256').update(legacyStableJson(material)).digest('hex')
  await prisma.adminAuditEvent.create({
    data: {
      id: e.id, adminId: admin.id, adminEmail: admin.email, adminName: admin.name, action: e.action, targetType: 'probe', targetId: 'probe', requestMethod: 'TEST', requestPath: 'x',
      requestIp: null, userAgent: null, metadata: (e.metadata ?? undefined) as any, prevHash: e.prev, eventHash, createdAt: new RealDate(e.at),
    },
  })
  return eventHash
}
const verify = () => (audit as any).verifyAdminAuditChain as undefined | ((options?: unknown) => Promise<any>)
const forkCounter = () => getInMemoryMetricsSnapshot().counters.filter((c) => c.name === 'admin_audit_chain_fork_detected_total').reduce((sum, c) => sum + c.value, 0)
const allRows = async () => JSON.stringify(await prisma.adminAuditEvent.findMany({ orderBy: { id: 'asc' } }))

// head <- P <- A, P <- C <- D : the shape the published helper left behind when two events raced (A and C share P; A is a dead end)
async function forkedHistory() {
  const T0 = RealDate.now() - 600_000
  const head = await insertAsPublished({ id: 'h-head', at: T0, prev: null, action: 'legacy.head' })
  const p = await insertAsPublished({ id: 'h-p', at: T0 + 10, prev: head, action: 'legacy.p' })
  const a = await insertAsPublished({ id: 'h-a', at: T0 + 20, prev: p, action: 'legacy.a' })
  const c = await insertAsPublished({ id: 'h-c', at: T0 + 21, prev: p, action: 'legacy.c' })
  const d = await insertAsPublished({ id: 'h-d', at: T0 + 30, prev: c, action: 'legacy.d' })
  return { head, p, a, c, d }
}

test('R7a: the diagnostic NAMES a fork that is already in the history: the shared predecessor, the events that share it, the dead end, the tips', async () => {
  const hashes = await forkedHistory()
  assert.equal(typeof verify(), 'function', 'lib/admin-audit.ts exports verifyAdminAuditChain')
  const report = await verify()!()
  assert.equal(report.ok, false)
  assert.equal(report.events, 5)
  assert.deepEqual(report.heads, ['h-head'])
  assert.deepEqual([...report.tips].sort(), ['h-a', 'h-d'])
  assert.deepEqual(report.forks, [{ prevHash: hashes.p, eventIds: ['h-a', 'h-c'] }])
  assert.deepEqual(report.offChain, ['h-a'], 'the dead end is off the line from the newest tip back to the head')
  assert.deepEqual(report.hashMismatches, [], 'the hashes themselves are right: this is the SHAPE of the chain')
  assert.deepEqual(report.danglingPredecessors, [])
})

test('R7b: a new event rewrites NOTHING of the past, continues from the newest tip, and does not hide the fork - it is still reported, and the helper counts that it saw it', async () => {
  const hashes = await forkedHistory()
  const before = await allRows()
  const counted = forkCounter()
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.new' }))
  const after = await prisma.adminAuditEvent.findMany({ orderBy: { id: 'asc' } })
  const fresh = after.find((e) => e.action === 'auditchain.new')!
  assert.equal(after.length, 6)
  assert.equal(JSON.stringify(after.filter((e) => e.action !== 'auditchain.new')), before, 'every row of the past is exactly as it was')
  assert.equal(fresh.prevHash, hashes.d, 'it continues from the newest tip')
  const report = await verify()!()
  assert.equal(report.ok, false, 'the fork is still there to be seen')
  assert.deepEqual(report.forks.map((f: any) => f.eventIds), [['h-a', 'h-c']])
  assert.deepEqual(report.offChain, ['h-a'])
  assert.ok(forkCounter() > counted, 'the helper said that it saw a fork among the recent events (metric admin_audit_chain_fork_detected_total)')
})

test('R7c: a history that ENDS with an inverted pair (the last event is older than the one before it) is continued from its real last event - the new event does not make a new fork', async () => {
  const T = RealDate.now() - 120_000
  const b = await insertAsPublished({ id: 'i-b', at: T, prev: null, action: 'legacy.b' })
  const a = await insertAsPublished({ id: 'i-a', at: T - 5, prev: b, action: 'legacy.a' })    // written after B, stamped before it
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.next' }))
  const fresh = (await prisma.adminAuditEvent.findFirst({ where: { action: 'auditchain.next' } }))!
  assert.equal(fresh.prevHash, a, 'it names the event that was really written last, not the one that merely has the latest instant')
  assert.ok(fresh.createdAt.getTime() > T, 'and it is stamped after every event of the log')
  const report = await verify()!()
  assert.deepEqual(report.forks, [], 'no fork was made')
  assert.deepEqual(report.tips, [fresh.id])
})

test('R7d: the diagnostic on a chain made by the helper (events written concurrently) says it is whole; on an empty log it says so', async () => {
  const empty = await verify()!()
  assert.equal(empty.ok, true)
  assert.equal(empty.events, 0)
  await Promise.all(Array.from({ length: 6 }, (_, i) => audit.recordAdminAuditEvent(input({ action: `auditchain.w${i}`, metadata: { i, when: new RealDate(1700000000000 + i), skipped: undefined } }))))
  const report = await verify()!()
  assert.deepEqual({ ok: report.ok, events: report.events, forks: report.forks, offChain: report.offChain, hashMismatches: report.hashMismatches, dangling: report.danglingPredecessors }, { ok: true, events: 6, forks: [], offChain: [], hashMismatches: [], dangling: [] })
  assert.equal(report.heads.length, 1)
  assert.equal(report.tips.length, 1)
  assert.deepEqual(judge(await executed()), [])
})

test('R7e: the diagnostic does not take the hashes on trust - a stored event whose fields were changed is reported, the others are not; an event whose administrator is gone can not be re-checked and is counted apart', async () => {
  for (let i = 0; i < 3; i++) await audit.recordAdminAuditEvent(input({ action: `auditchain.e${i}` }))
  const rows = await executed()
  await prisma.$executeRawUnsafe(`UPDATE "AdminAuditEvent" SET action = 'auditchain.tampered' WHERE id = '${rows[1].id}'`)
  await prisma.$executeRawUnsafe(`UPDATE "AdminAuditEvent" SET "adminId" = NULL WHERE id = '${rows[2].id}'`)    // what deleting the administrator does (ON DELETE SET NULL)
  const report = await verify()!()
  assert.equal(report.ok, false)
  assert.deepEqual(report.hashMismatches, [rows[1].id])
  assert.equal(report.unverifiable, 1, 'the one without an administrator can not be recomputed, and is not called wrong')
})

// ====================================================================================================================================================================
// guards
// ====================================================================================================================================================================
test('G1: the ordinary client handed over as if it were a transaction is REFUSED before anything is written (the lock would not hold across the statements)', async () => {
  await assert.rejects(
    () => audit.recordAdminAuditEvent(input({ action: 'auditchain.misuse' }), prisma as any),
    (error: any) => error?.code === 'AUDIT_NOT_IN_TRANSACTION',
  )
  assert.equal(await prisma.adminAuditEvent.count(), 0, 'nothing was written')
})

test('G2: timestamps never go backwards along the chain, even when the clock does, and they follow the clock closely - a burst of thirty events drifts by at most thirty milliseconds', async () => {
  const T = RealDate.now()
  for (const [i, delta] of [0, -1000, -2000, 10].entries()) await atInstant(T + delta, () => audit.recordAdminAuditEvent(input({ action: `auditchain.c${i}` })))
  const stepped = await executed()
  assert.deepEqual(judge(stepped), [], 'a clock that steps back does not reorder the chain')
  assert.deepEqual(stepped.map((r) => r.created - T), [0, 1, 2, 10], 'each event is stamped now, or just after the previous one')
  await prisma.adminAuditEvent.deleteMany()
  const outcomes = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => audit.recordAdminAuditEvent(input({ action: `auditchain.b${i}`, metadata: { i } }))))
  const end = RealDate.now()
  assert.deepEqual(outcomes.filter((o) => o.status === 'rejected').length, 0)
  const burst = await executed()
  assert.deepEqual(judge(burst), [])
  assert.ok(burst[burst.length - 1].created - end <= 30, `the last event is stamped ${burst[burst.length - 1].created - end} ms ahead of the clock (at most one millisecond per event of the burst)`)
})

test('G3: a log whose newest event is dated far ahead of the clock does not break the order - the new event goes after it, and the helper SAYS the clock is behind (metric admin_audit_clock_behind_total)', async () => {
  const ahead = RealDate.now() + 600_000
  const future = await insertAsPublished({ id: 'f-future', at: ahead, prev: null, action: 'legacy.future' })
  const counted = () => getInMemoryMetricsSnapshot().counters.filter((c) => c.name === 'admin_audit_clock_behind_total').reduce((sum, c) => sum + c.value, 0)
  const before = counted()
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.after-future' }))
  const fresh = (await prisma.adminAuditEvent.findFirst({ where: { action: 'auditchain.after-future' } }))!
  assert.equal(fresh.prevHash, future)
  assert.equal(fresh.createdAt.getTime(), ahead + 1, 'one millisecond after the newest event of the log')
  assert.ok(counted() > before, 'the clock being behind the log is counted, not silent')
})

test('G4: the lock is WAITED FOR longer than a default transaction lasts - an operation queued behind a slow holder for six seconds still writes its event', async () => {
  const holder = await holdChainLock()
  const waiter = audit.recordAdminAuditEvent(input({ action: 'auditchain.patient' }))
  await untilWaiting(1)
  await sleep(6_000)
  holder.release()
  await holder.done
  await waiter
  assert.equal(await prisma.adminAuditEvent.count({ where: { action: 'auditchain.patient' } }), 1)
})

test('G5: lock order - operations that take a row lock FIRST and write their audit event last (as the callers that hand over their transaction do) run together with operations that hand over nothing, with no deadlock and one chain', async () => {
  const lockRow = await prisma.user.create({ data: { email: 'lockrow@auditchain.invalid', passwordHash: 'x' } })
  const joined = Array.from({ length: 12 }, (_, i) => prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = '${lockRow.id}' FOR UPDATE`)
    await tx.user.update({ where: { id: lockRow.id }, data: { name: `n${i}` } })
    await audit.recordAdminAuditEvent(input({ action: `auditchain.j${i}`, metadata: { i } }), tx)
  }, { timeout: 30_000, maxWait: 20_000 }))
  const alone = Array.from({ length: 12 }, (_, i) => audit.recordAdminAuditEvent(input({ action: `auditchain.s${i}`, metadata: { i } })))
  const outcomes = await Promise.allSettled([...joined, ...alone])
  assert.deepEqual(outcomes.filter((o) => o.status === 'rejected').map((o: any) => String(o.reason?.code ?? o.reason?.message).slice(0, 80)), [])
  const rows = await executed()
  assert.equal(rows.length, 24)
  const problems = judgeByLinks(rows)
  assert.deepEqual(problems, [], `the chain broke:${say(problems)}`)
})

test('G6: the two explicit entries - one that joins the caller\'s transaction, one that opens its own - return the event they wrote, and the first never opens a second transaction', async () => {
  const joinedFn = (audit as any).recordAdminAuditEventInTransaction
  const standaloneFn = (audit as any).recordAdminAuditEventStandalone
  assert.equal(typeof joinedFn, 'function')
  assert.equal(typeof standaloneFn, 'function')
  const alone = await standaloneFn(input({ action: 'auditchain.alone' }))
  assert.match(alone.eventHash, /^[0-9a-f]{64}$/)
  assert.equal(alone.prevHash, null)
  let joinedRecord: any = null
  let businessXid = ''
  await prisma.$transaction(async (tx) => {
    const made = await tx.user.create({ data: { email: 'g6@auditchain.invalid', passwordHash: 'x' } })
    joinedRecord = await joinedFn(tx, input({ action: 'auditchain.joined', targetId: made.id }))
    businessXid = ((await tx.$queryRawUnsafe(`SELECT xmin::text AS x FROM "User" WHERE id = '${made.id}'`)) as any[])[0].x
  })
  assert.equal(joinedRecord.prevHash, alone.eventHash)
  const [event] = (await prisma.$queryRawUnsafe(`SELECT xmin::text AS x FROM "AdminAuditEvent" WHERE id = '${joinedRecord.id}'`)) as any[]
  assert.equal(event.x, businessXid, 'the same transaction')
  assert.deepEqual(judge(await executed()), [])
})

test('G7: a transaction that reads an OLDER snapshot (repeatable read) is refused - it would not see the event the previous writer stored - before anything is written', async () => {
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.first' }))
  await assert.rejects(
    () => prisma.$transaction((tx) => audit.recordAdminAuditEvent(input({ action: 'auditchain.snapshot' }), tx), { isolationLevel: 'RepeatableRead', timeout: 30_000 }),
    (error: any) => error?.code === 'AUDIT_ISOLATION_UNSUPPORTED',
  )
  assert.equal(await prisma.adminAuditEvent.count({ where: { action: 'auditchain.snapshot' } }), 0, 'nothing was written')
  await audit.recordAdminAuditEvent(input({ action: 'auditchain.second' }))
  assert.deepEqual(judge(await executed()), [], 'and the chain goes on')
})

test('G8: the instant is taken AFTER the lock - an event that waited for the lock is stamped after the moment the lock was released, not at the moment it began to wait', async () => {
  const holder = await holdChainLock()
  const waiter = audit.recordAdminAuditEvent(input({ action: 'auditchain.waited' }))
  await untilWaiting(1)
  await sleep(300)
  const released = RealDate.now()
  holder.release()
  await holder.done
  await waiter
  const [event] = await executed()
  assert.ok(event.created >= released, `the event is stamped ${released - event.created} ms BEFORE the lock was released: the instant was taken before the lock`)
})
