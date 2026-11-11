// R1-3 / KLOSS A-idx - the migration 20261111150000_kloss_owner_orders_index (the index of an account's orders, built CONCURRENTLY), proved on THROWAWAY databases of the isolated test cluster
// - never on the database of the other tests, never on a shared or production one (only a local cluster; every database made here has a name of its own, and is dropped at the end):
//   * an EMPTY database: every migration applies with `prisma migrate deploy`, the index is VALID and is the one the migration says, nothing is left half done, no drift against the schema;
//   * a database WITH DATA, deployed while the table is in use: the build waits for a transaction that is writing, and meanwhile the writes and the reads of other sessions go on - they are NOT
//     blocked (a plain CREATE INDEX, shown beside it, blocks them); then the migration ends, the index is valid, no row changed;
//   * a build that FAILS (cancelled while it waits): the migration is marked failed, the index it left is INVALID, the next deploy refuses; without dropping that index the migration fails again
//     (it is never taken for done); with the recovery written in the migration (DROP INDEX CONCURRENTLY, `migrate resolve --rolled-back`, deploy) it applies and the index is valid;
//   * the ROLLBACK (DROP INDEX CONCURRENTLY) changes no row, the same orders are read without the index (by a scan), and the index can be built again.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { stillPendingAfter } from './_kloss-kit'

const ROOT = process.cwd()
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations')
const MIGRATION = '20261111150000_kloss_owner_orders_index'
const INDEX = 'PrintOrder_userId_createdAt_idx'
const DEFINITION = `CREATE INDEX "${INDEX}" ON public."PrintOrder" USING btree ("userId", "createdAt" DESC)`

const base = new URL(process.env.SEC_TEST_DATABASE_URL as string)
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'these tests create and drop databases: only on a local cluster')
const urlOf = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString() }
const made: string[] = []
const clients: PrismaClient[] = []
const admin = new PrismaClient({ datasourceUrl: urlOf('postgres') })

async function newDatabase(label: string) {
  const name = `mkw_klossidx_${label}_${process.pid}_sectest`
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const client = (): PrismaClient => { const c = new PrismaClient({ datasourceUrl: urlOf(name) }); clients.push(c); return c }
  return { name, url: urlOf(name), client: client(), another: client }
}
type Db = Awaited<ReturnType<typeof newDatabase>>

// the migrations as they were BEFORE A-idx (every one but this)
let beforeDir: string | null = null
function schemaBefore(): string {
  if (beforeDir) return path.join(beforeDir, 'prisma', 'schema.prisma')
  beforeDir = mkdtempSync(path.join(os.tmpdir(), 'kloss-idx-before-'))
  mkdirSync(path.join(beforeDir, 'prisma', 'migrations'), { recursive: true })
  cpSync(path.join(ROOT, 'prisma', 'schema.prisma'), path.join(beforeDir, 'prisma', 'schema.prisma'))
  for (const entry of readdirSync(MIGRATIONS)) if (entry !== MIGRATION) cpSync(path.join(MIGRATIONS, entry), path.join(beforeDir, 'prisma', 'migrations', entry), { recursive: true })
  return path.join(beforeDir, 'prisma', 'schema.prisma')
}
test.after(async () => {
  for (const client of clients) await client.$disconnect().catch(() => undefined)
  for (const name of made) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined)
  await admin.$disconnect()
  if (beforeDir) rmSync(beforeDir, { recursive: true, force: true })
})

// the project's own command, as the container runs it at every start (scripts/start-production.js)
function prisma(args: string[], url: string) {
  try {
    return { code: 0, output: execFileSync('npx', ['prisma', ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error: any) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}
const deploy = (url: string, schema?: string) => prisma(['migrate', 'deploy', ...(schema ? ['--schema', schema] : [])], url)
// the same, in the background: a deploy that is going to wait
function deployInBackground(url: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url } })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('exit', (code) => resolve({ code: code ?? 1, output }))
  })
}

const one = async <T,>(db: Db, sql: string): Promise<T> => ((await db.client.$queryRawUnsafe(sql)) as T[])[0]
const index = async (db: Db) => one<{ def: string | null; valid: boolean | null }>(db, `SELECT (SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}') AS def, (SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${INDEX}') AS valid`)
const migrationState = async (db: Db) => one<{ finished: boolean; rolledBack: boolean } | undefined>(db, `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack" FROM _prisma_migrations WHERE migration_name = '${MIGRATION}' ORDER BY started_at DESC LIMIT 1`)
// every order and attempt, as stored (the rows the test itself writes are left out by their ids)
const fingerprint = async (db: Db) => (await one<{ h: string }>(db, `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) AS h FROM (SELECT * FROM "PrintOrder" WHERE id LIKE 'o%') t`)).h
// the account's orders, newest first: what the owner guard reads for an account, with the index if it is there
const ACCOUNT_ORDERS = `SELECT id FROM "PrintOrder" WHERE "userId" = 'u00042' ORDER BY "createdAt" DESC`
const accountOrders = async (db: Db) => ((await db.client.$queryRawUnsafe(ACCOUNT_ORDERS)) as Array<{ id: string }>).map((row) => row.id)
const plan = async (db: Db) => ((await db.client.$queryRawUnsafe(`EXPLAIN ${ACCOUNT_ORDERS}`)) as Array<{ 'QUERY PLAN': string }>).map((row) => row['QUERY PLAN']).join('\n')

// a database with the migrations of before and the orders of 2000 accounts and of guests, with their attempts
async function populated(label: string): Promise<Db> {
  const db = await newDatabase(label)
  const before = deploy(db.url, schemaBefore())
  assert.equal(before.code, 0, before.output)
  // (the accounts the orders belong to: the foreign key of "userId" is kept, as in production)
  await db.client.$executeRawUnsafe(`INSERT INTO "User" (id, email, "passwordHash") SELECT 'u' || lpad(g::text, 5, '0'), 'u' || g || '@klossidx.sectest.invalid', 'x' FROM generate_series(0, 1999) g`)
  await db.client.$executeRawUnsafe(`INSERT INTO "PrintOrder" (id, status, "paymentStatus", "paymentMethod", "subtotalCents", "totalCents", currency, "createdAt", "updatedAt", "userId", "guestSessionHash", metadata)
    SELECT 'o' || lpad(g::text, 6, '0'), CASE WHEN g % 3 = 0 THEN 'queued' ELSE 'cancelled' END, CASE WHEN g % 3 = 0 THEN 'paid' ELSE 'canceled' END, 'card', 2000, 2000, 'EUR',
           timestamp '2026-01-01' + (g || ' minutes')::interval, now(), CASE WHEN g % 2 = 0 THEN 'u' || lpad((g % 2000)::text, 5, '0') ELSE NULL END,
           CASE WHEN g % 2 = 1 THEN md5('h' || (g % 3000)::text) || md5('k' || (g % 3000)::text) ELSE NULL END, jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', md5('c' || (g % 50)::text)))
    FROM generate_series(1, 40000) g`)
  await db.client.$executeRawUnsafe(`INSERT INTO "PaymentAttempt" (id, "orderId", "amountCents", currency, status, "stripeSessionId", "failureReason", "expiresAt", "createdAt", "updatedAt")
    SELECT 'a' || lpad(g::text, 6, '0'), 'o' || lpad(g::text, 6, '0'), 2000, 'EUR', 'expired', 'cs_test_idx_' || g, 'closed_by_us:x', now(), now(), now() FROM generate_series(1, 40000) g`)
  await db.client.$executeRawUnsafe('ANALYZE "PrintOrder"')
  return db
}
// a transaction that has WRITTEN to "PrintOrder" and stays open until released: what CREATE INDEX CONCURRENTLY has to wait for (a checkout that is making an order, say)
async function openWriter(db: Db) {
  const client = db.another()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const startedPromise = new Promise<void>((resolve) => { started = resolve })
  const done = client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`INSERT INTO "PrintOrder" (id, "subtotalCents", "totalCents", currency, "updatedAt", "userId") VALUES ('t_open_writer', 1000, 1000, 'EUR', now(), 'u00042')`)
    started()
    await gate
  }, { timeout: 120_000, maxWait: 10_000 })
  await startedPromise
  return { release: async () => { release(); await done } }
}
// the backend that is building the index CONCURRENTLY, once it is there - read from pg_stat_progress_create_index (the text of the statement in pg_stat_activity is cut after its first
// kilobyte, which here is the comment of the migration), with the phase it is in; polled, nothing is assumed about time
async function concurrentBuild(db: Db): Promise<{ pid: number; command: string; phase: string }> {
  for (let i = 0; i < 300; i++) {
    const row = await one<{ pid: number; command: string; phase: string } | undefined>(db, `SELECT pid, command, phase FROM pg_stat_progress_create_index WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database()) LIMIT 1`)
    if (row) return { pid: Number(row.pid), command: row.command, phase: row.phase }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the concurrent build never started')
}
const timed = async <T,>(work: () => Promise<T>): Promise<{ ms: number; value: T }> => { const t0 = Date.now(); const value = await work(); return { ms: Date.now() - t0, value } }

test('EMPTY database: every migration applies with migrate deploy, the index is VALID and is the one the migration says, nothing is half done, no drift against prisma/schema.prisma', async () => {
  const db = await newDatabase('empty')
  const r = deploy(db.url)
  assert.equal(r.code, 0, r.output)
  assert.match(r.output, new RegExp(`Applying migration \`${MIGRATION}\``))
  assert.deepEqual(await index(db), { def: DEFINITION, valid: true })
  assert.equal((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)).n, 0, 'no migration is left half done')
  const diff = prisma(['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], db.url)
  assert.equal(diff.code, 0, `drift against the schema:\n${diff.output}`)
  assert.equal(deploy(db.url).code, 0, 'deployed again: nothing to do')
})

test('a database WITH DATA, deployed while the table is in use: the build waits for the transaction that is writing, the writes and reads of the others are NOT blocked meanwhile; then the index is valid and no row changed', async () => {
  const db = await populated('busy')
  const rows = await fingerprint(db)
  const ordersBefore = await accountOrders(db)
  assert.equal(ordersBefore.length, 20, 'premise: the account has its orders')
  const writer = await openWriter(db)
  const deploying = deployInBackground(db.url)
  try {
    const build = await concurrentBuild(db)
    // (it is WAITING - for the open writer)
    assert.equal(await stillPendingAfter(deploying, 1500), true, 'the build waits for the transaction that is writing')
    assert.deepEqual({ command: build.command, waiting: (await concurrentBuild(db)).phase.startsWith('waiting for') }, { command: 'CREATE INDEX CONCURRENTLY', waiting: true })
    // meanwhile another session writes and reads, and is not made to wait
    const other = db.another()
    const insert = await timed(() => other.$executeRawUnsafe(`INSERT INTO "PrintOrder" (id, "subtotalCents", "totalCents", currency, "updatedAt", "userId") VALUES ('w_during_build', 1000, 1000, 'EUR', now(), 'u00007')`))
    const update = await timed(() => other.$executeRawUnsafe(`UPDATE "PrintOrder" SET notes = 'updated while the index is built' WHERE id = 'w_during_build'`))
    const read = await timed(() => other.$queryRawUnsafe(ACCOUNT_ORDERS))
    assert.ok(insert.ms < 1000 && update.ms < 1000 && read.ms < 1000, `writes and reads are not blocked: insert ${insert.ms} ms, update ${update.ms} ms, read ${read.ms} ms`)
    assert.equal((await concurrentBuild(db)).pid, build.pid, 'and the build is still going on')
  } finally {
    await writer.release()
  }
  const result = await deploying
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(await index(db), { def: DEFINITION, valid: true })
  assert.deepEqual(await migrationState(db), { finished: true, rolledBack: false })
  assert.equal(await fingerprint(db), rows, 'no row of before changed')
  assert.deepEqual((await accountOrders(db)).filter((id) => id.startsWith('o')), ordersBefore, 'the same orders, in the same order')
  assert.match(await plan(db), new RegExp(INDEX), 'and the account\'s orders are read by the index')
})

test('beside it, the PLAIN statement (what an ordinary CREATE INDEX does) blocks the writes of the table until it is done - the reason the migration builds CONCURRENTLY', async () => {
  const db = await populated('plain')
  const builder = db.another()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let built!: () => void
  const builtPromise = new Promise<void>((resolve) => { built = resolve })
  const building = builder.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE INDEX "PrintOrder_userId_createdAt_plain_idx" ON "PrintOrder"("userId", "createdAt" DESC)`)
    built()
    await gate
    throw new Error('rolled back on purpose')
  }, { timeout: 120_000, maxWait: 10_000 }).catch(() => undefined)
  await builtPromise
  const other = db.another()
  const insert = other.$executeRawUnsafe(`INSERT INTO "PrintOrder" (id, "subtotalCents", "totalCents", currency, "updatedAt") VALUES ('w_blocked', 1000, 1000, 'EUR', now())`)
  assert.equal(await stillPendingAfter(insert, 1500), true, 'an INSERT waits for the plain CREATE INDEX')
  release()
  await building
  await insert
  assert.equal((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM "PrintOrder" WHERE id = 'w_blocked'`)).n, 1)
})

test('a build that FAILS (cancelled while it waits): the migration is failed, its index INVALID, the next deploy refuses; without the DROP it fails again; with the recovery of the migration it applies, valid', async () => {
  const db = await populated('failed')
  const rows = await fingerprint(db)
  const writer = await openWriter(db)
  const deploying = deployInBackground(db.url)
  const build = await concurrentBuild(db)
  await db.client.$queryRawUnsafe(`SELECT pg_cancel_backend(${build.pid})`)
  const failed = await deploying
  await writer.release()
  assert.notEqual(failed.code, 0, 'the deploy fails')
  assert.match(failed.output, /P3018/)
  assert.deepEqual(await migrationState(db), { finished: false, rolledBack: false }, 'the migration is marked failed')
  assert.equal((await index(db)).valid, false, 'the index the build left is INVALID')
  const refused = deploy(db.url)
  assert.notEqual(refused.code, 0, 'the next deploy refuses while a migration is failed')
  assert.match(refused.output, /P3009/)
  // marked rolled back WITHOUT dropping the invalid index: the migration fails again - an invalid index is never taken for done (no IF NOT EXISTS)
  assert.equal(prisma(['migrate', 'resolve', '--rolled-back', MIGRATION], db.url).code, 0)
  const again = deploy(db.url)
  assert.notEqual(again.code, 0)
  assert.match(again.output, /already exists/)
  assert.equal((await index(db)).valid, false)
  // the recovery written in the migration
  await db.client.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`)
  assert.equal(prisma(['migrate', 'resolve', '--rolled-back', MIGRATION], db.url).code, 0)
  const recovered = deploy(db.url)
  assert.equal(recovered.code, 0, recovered.output)
  assert.deepEqual(await index(db), { def: DEFINITION, valid: true })
  assert.deepEqual(await migrationState(db), { finished: true, rolledBack: false })
  assert.equal(await fingerprint(db), rows, 'no row of before changed')
})

test('ROLLBACK: DROP INDEX CONCURRENTLY changes no row and the same orders are read without the index (by a scan); the statement of the migration builds it again, valid', async () => {
  const db = await populated('rollback')
  assert.equal(deploy(db.url).code, 0)
  const rows = await fingerprint(db)
  const withIndex = await accountOrders(db)
  assert.match(await plan(db), new RegExp(INDEX))
  await db.client.$executeRawUnsafe(`DROP INDEX CONCURRENTLY "${INDEX}"`)
  assert.deepEqual(await index(db), { def: null, valid: null })
  assert.equal(await fingerprint(db), rows)
  assert.deepEqual(await accountOrders(db), withIndex, 'the same orders, in the same order, without the index')
  assert.doesNotMatch(await plan(db), new RegExp(INDEX))
  assert.deepEqual(await migrationState(db), { finished: true, rolledBack: false }, 'the migration stays recorded as applied')
  // built again with the statement of the migration (what the procedure says to run to put it back)
  await db.client.$executeRawUnsafe(`CREATE INDEX CONCURRENTLY "${INDEX}" ON "PrintOrder"("userId", "createdAt" DESC)`)
  assert.deepEqual(await index(db), { def: DEFINITION, valid: true })
  const diff = prisma(['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], db.url)
  assert.equal(diff.code, 0, diff.output)
})
