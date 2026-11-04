// DR-13 phase 5: the two migrations (20261104120000_dr13_request_hash: a nullable column; 20261104130000_dr13_single_live_page: the partial unique index of live pages), proved on THROWAWAY
// databases of the isolated test cluster - never on the database of the other tests, never on a shared or production one (the harness refuses anything but a local "*_sectest" database, and
// every database made here is a sibling of that one, with a name of its own, dropped at the end):
//   * an EMPTY database: all migrations apply, the index has the expected definition, `prisma migrate diff` finds no drift;
//   * a database with data of the shape the OLD code left (reservations closed by the clock, orphans, paid orders, one live page per order): the two migrations apply, no row changes, the new
//     column is empty everywhere;
//   * a database where an order holds TWO live attempts: the index migration FAILS and changes nothing (one DDL statement, one transaction); after the data is put right the migration is marked
//     rolled back and applied again;
//   * the rollback written in the migration (DROP INDEX) leaves every row as it was, and the statement can be applied again (and again: IF NOT EXISTS);
//   * the schema in prisma/schema.prisma and the migrations agree (shadow database).
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const ROOT = process.cwd()
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations')
const COLUMN = '20261104120000_dr13_request_hash'
const INDEX = '20261104130000_dr13_single_live_page'
const INDEX_NAME = 'PaymentAttempt_orderId_live_page_key'

const base = new URL(process.env.SEC_TEST_DATABASE_URL as string)
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'these tests create and drop databases: only on a local cluster')
const urlOf = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString() }
const made: string[] = []
const clients: PrismaClient[] = []
const admin = new PrismaClient({ datasourceUrl: urlOf('postgres') })

async function newDatabase(label: string) {
  const name = `mkw_dr13mig_${label}_${process.pid}_sectest`
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`)
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const client = new PrismaClient({ datasourceUrl: urlOf(name) })
  clients.push(client)
  return { name, url: urlOf(name), client }
}
test.after(async () => {
  for (const client of clients) await client.$disconnect().catch(() => undefined)
  for (const name of made) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined)
  await admin.$disconnect()
})

// `prisma migrate deploy` with the migrations of `schemaDir` (the real ones, or a copy without the DR-13 pair: the database as it was before)
function prisma(args: string[], url: string) {
  try {
    return { code: 0, output: execFileSync('npx', ['prisma', ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error: any) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}
const deploy = (url: string, schema?: string) => prisma(['migrate', 'deploy', ...(schema ? ['--schema', schema] : [])], url)

// the migrations as they were BEFORE DR-13: every migration but the two
let beforeDir: string | null = null
function schemaBeforeDr13() {
  if (beforeDir) return path.join(beforeDir, 'prisma', 'schema.prisma')
  beforeDir = mkdtempSync(path.join(os.tmpdir(), 'dr13-before-'))
  mkdirSync(path.join(beforeDir, 'prisma', 'migrations'), { recursive: true })
  cpSync(path.join(ROOT, 'prisma', 'schema.prisma'), path.join(beforeDir, 'prisma', 'schema.prisma'))
  for (const entry of readdirSync(MIGRATIONS)) {
    if (entry === COLUMN || entry === INDEX) continue
    cpSync(path.join(MIGRATIONS, entry), path.join(beforeDir, 'prisma', 'migrations', entry), { recursive: true })
  }
  return path.join(beforeDir, 'prisma', 'schema.prisma')
}
test.after(() => { if (beforeDir) rmSync(beforeDir, { recursive: true, force: true }) })

type Db = Awaited<ReturnType<typeof newDatabase>>
const one = async <T,>(db: Db, sql: string): Promise<T> => ((await db.client.$queryRawUnsafe(sql)) as T[])[0]
const indexExists = async (db: Db) => Number((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${INDEX_NAME}'`)).n) === 1
const hasColumn = async (db: Db) => Number((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PaymentAttempt' AND column_name = 'requestHash'`)).n) === 1
// a fingerprint of every attempt, without the column the migration adds and without the clock of the last update
const fingerprint = async (db: Db) => (await one<{ h: string }>(db, `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), 'empty') AS h FROM (SELECT "id","orderId","stripeSessionId","stripePaymentIntentId","amountCents","currency","status","amountReceivedCents","expiresAt","completedAt","failureReason","createdAt" FROM "PaymentAttempt") t`)).h

let seq = 0
async function order(db: Db, extra: { status?: string; paymentStatus?: string } = {}) {
  const id = `ord_mig_${++seq}_${process.pid}`
  await db.client.$executeRawUnsafe(`INSERT INTO "PrintOrder" ("id","subtotalCents","totalCents","currency","status","paymentStatus","updatedAt") VALUES ('${id}',2000,2000,'EUR','${extra.status ?? 'awaiting_payment'}','${extra.paymentStatus ?? 'pending'}',now())`)
  return id
}
async function attempt(db: Db, orderId: string, a: { status: string; session?: string; reason?: string; ageMin?: number; pi?: string }) {
  const id = `att_mig_${++seq}_${process.pid}`
  await db.client.$executeRawUnsafe(`INSERT INTO "PaymentAttempt" ("id","orderId","amountCents","currency","status","stripeSessionId","stripePaymentIntentId","failureReason","expiresAt","createdAt","updatedAt")
    VALUES ('${id}','${orderId}',2000,'EUR','${a.status}',${a.session ? `'${a.session}'` : 'NULL'},${a.pi ? `'${a.pi}'` : 'NULL'},${a.reason ? `'${a.reason}'` : 'NULL'}, now() + interval '30 minutes', now() - interval '${a.ageMin ?? 5} minutes', now())`)
  return id
}
// what the OLD code left: one live attempt per order at most (it tried to keep that), reservations it had closed by the clock, orphans, paid orders
async function legacyData(db: Db) {
  const o1 = await order(db); await attempt(db, o1, { status: 'open', session: 'cs_mig_open_1' })
  const o2 = await order(db); await attempt(db, o2, { status: 'expired', reason: 'stale_reservation', ageMin: 600 }); await attempt(db, o2, { status: 'creating', ageMin: 3 })
  const o3 = await order(db, { status: 'queued', paymentStatus: 'paid' }); await attempt(db, o3, { status: 'paid', session: 'cs_mig_paid_1', pi: 'pi_mig_1' }); await attempt(db, o3, { status: 'expired', session: 'cs_mig_exp_1', ageMin: 90 })
  const o4 = await order(db); await attempt(db, o4, { status: 'failed', reason: 'StripeInvalidRequestError:x', ageMin: 1000 }); await attempt(db, o4, { status: 'failed', session: 'cs_mig_fail_1', reason: 'payment_failed' })
  const o5 = await order(db); await attempt(db, o5, { status: 'processing', session: 'cs_mig_proc_1' })
  return { o1, o2, o3, o4, o5 }
}

test('EMPTY database: every migration applies, the index is the one the migration says, no drift against prisma/schema.prisma', async () => {
  const db = await newDatabase('empty')
  const r = deploy(db.url)
  assert.equal(r.code, 0, r.output)
  assert.equal(await hasColumn(db), true)
  assert.equal(await indexExists(db), true)
  const def = (await one<{ indexdef: string }>(db, `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX_NAME}'`)).indexdef
  assert.match(def, /CREATE UNIQUE INDEX "PaymentAttempt_orderId_live_page_key" ON public\."PaymentAttempt" USING btree \("orderId"\) WHERE \(status = ANY \(ARRAY\['creating'::text, 'open'::text\]\)\)/)
  const failed = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)
  assert.equal(failed.n, 0, 'no migration is left half done')
  const diff = prisma(['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], db.url)
  assert.equal(diff.code, 0, `drift against the schema:\n${diff.output}`)
  // and a second deploy has nothing to do
  const again = deploy(db.url)
  assert.equal(again.code, 0, again.output)
  assert.match(again.output, /No pending migrations/)
})

test('DATA made by the old code: the two migrations apply, no attempt changes, the new column is empty everywhere, and the operator report runs on it', async () => {
  const db = await newDatabase('legacy')
  const before = deploy(db.url, schemaBeforeDr13())
  assert.equal(before.code, 0, before.output)
  assert.equal(await hasColumn(db), false, 'the premise: a database as it was before DR-13')
  assert.equal(await indexExists(db), false)
  const ids = await legacyData(db)
  const fingerprintBefore = await fingerprint(db)
  assert.notEqual(fingerprintBefore, 'empty')
  const r = deploy(db.url)
  assert.equal(r.code, 0, r.output)
  assert.equal(await indexExists(db), true)
  assert.equal(await fingerprint(db), fingerprintBefore, 'a migration changed the attempts')
  assert.equal(Number((await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM "PaymentAttempt" WHERE "requestHash" IS NOT NULL`)).n), 0, 'rows made before DR-13 have no stored request')
  // the report (read only) on migrated data: nothing waits for the index, and the rows of the old code are listed for what they are
  const sql = readFileSync(path.join(ROOT, 'scripts', 'checkout-pages-check.sql'), 'utf8')
  const queries = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((q) => q.trim()).filter(Boolean)
  assert.equal(queries.length, 6)
  assert.deepEqual(await db.client.$queryRawUnsafe(queries[0]), [], 'Q1: no order with several live attempts')
  const reservations = (await db.client.$queryRawUnsafe(queries[1])) as Array<{ attempt: string; has_stored_request: boolean }>
  assert.equal(reservations.length, 1)
  assert.equal(reservations[0].has_stored_request, false)
  const unproved = (await db.client.$queryRawUnsafe(queries[4])) as Array<{ orderId: string }>
  assert.deepEqual(unproved.map((x) => x.orderId).sort(), [ids.o2, ids.o4].sort(), 'Q5: the rows the old code closed without proof')
})

test('TWO live attempts for one order: the index migration FAILS, changes nothing, and after the data is put right it is marked rolled back and applied again', async () => {
  const db = await newDatabase('twins')
  assert.equal(deploy(db.url, schemaBeforeDr13()).code, 0)
  await legacyData(db)
  const o = await order(db)
  const twinA = await attempt(db, o, { status: 'open', session: 'cs_mig_twin_a' })
  const twinB = await attempt(db, o, { status: 'open', session: 'cs_mig_twin_b' })
  const fingerprintBefore = await fingerprint(db)
  const failure = deploy(db.url)
  assert.notEqual(failure.code, 0, 'the migration must refuse a database that holds two live pages for an order')
  assert.equal(await indexExists(db), false, 'nothing was created')
  assert.equal(await fingerprint(db), fingerprintBefore, 'nothing was changed')
  const recorded = await one<{ migration_name: string; finished_at: unknown; rolled_back_at: unknown }>(db, `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '${INDEX}'`)
  assert.equal(recorded.migration_name, INDEX)
  assert.equal(recorded.finished_at, null, 'recorded as started and never finished')
  // the data is put right (here by hand, as a stand-in for the application closing the extra page with the provider's proof), the failed migration is marked, and it is applied again
  await db.client.$executeRawUnsafe(`UPDATE "PaymentAttempt" SET "status" = 'expired', "failureReason" = 'closed_by_us:twin' WHERE "id" = '${twinB}'`)
  const resolved = prisma(['migrate', 'resolve', '--rolled-back', INDEX], db.url)
  assert.equal(resolved.code, 0, resolved.output)
  const retry = deploy(db.url)
  assert.equal(retry.code, 0, retry.output)
  assert.equal(await indexExists(db), true)
  const left = (await db.client.$queryRawUnsafe(`SELECT "id" FROM "PaymentAttempt" WHERE "orderId" = '${o}' AND "status" = 'open'`)) as Array<{ id: string }>
  assert.deepEqual(left.map((x) => x.id), [twinA])
})

test('ROLLBACK of the index (DROP INDEX) leaves every row exactly as it was, and the statement of the migration can be applied again and again', async () => {
  const db = await newDatabase('rollback')
  assert.equal(deploy(db.url).code, 0)
  await legacyData(db)
  const fingerprintBefore = await fingerprint(db)
  await db.client.$executeRawUnsafe(`DROP INDEX "${INDEX_NAME}"`)
  assert.equal(await indexExists(db), false)
  assert.equal(await fingerprint(db), fingerprintBefore, 'dropping the index changed a row')
  const statement = readFileSync(path.join(MIGRATIONS, INDEX, 'migration.sql'), 'utf8').split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim()
  assert.match(statement, /^CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAttempt_orderId_live_page_key"/)
  await db.client.$executeRawUnsafe(statement)
  await db.client.$executeRawUnsafe(statement) // IF NOT EXISTS: a second application is a no-op
  assert.equal(await indexExists(db), true)
  assert.equal(await fingerprint(db), fingerprintBefore)
  // and with the index back, a second live attempt for an order is refused again
  const o = await order(db)
  await attempt(db, o, { status: 'creating' })
  // (23505: a unique violation, on the key "orderId" - the only unique rule on that column alone is this index)
  await assert.rejects(() => attempt(db, o, { status: 'open', session: 'cs_mig_dup' }), /23505[\s\S]*\("orderId"\)/)
})

test('the migrations and prisma/schema.prisma agree (a shadow database), and the files are where the schema says', async () => {
  assert.ok(existsSync(path.join(MIGRATIONS, COLUMN, 'migration.sql')))
  assert.ok(existsSync(path.join(MIGRATIONS, INDEX, 'migration.sql')))
  assert.ok(readdirSync(MIGRATIONS).indexOf(INDEX) > readdirSync(MIGRATIONS).indexOf(COLUMN), 'the index migration comes after the column migration')
  const shadow = await newDatabase('shadow')
  const diff = prisma(['migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel', 'prisma/schema.prisma', '--shadow-database-url', shadow.url, '--exit-code'], shadow.url)
  assert.equal(diff.code, 0, `the migrations and the schema differ:\n${diff.output}`)
  writeFileSync(path.join(os.tmpdir(), `dr13-migration-diff-${process.pid}.txt`), diff.output)
})
