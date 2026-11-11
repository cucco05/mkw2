// R1-3 / KLOSS A-idx - the migration of the index of an account's orders (prisma/migrations/20261111150000_kloss_owner_orders_index), read as a file: no database.
//
// `prisma migrate deploy` sends a migration file as ONE batch, and PostgreSQL runs a batch of several statements as one transaction: CREATE INDEX CONCURRENTLY refuses to run inside a
// transaction block (25001), so the migration would fail on every database it is deployed to (proved on the isolated cluster: tests/security/kloss-index-migration.sec.ts). What is pinned here:
//   * the file has exactly ONE statement, and it is CREATE INDEX CONCURRENTLY of "PrintOrder_userId_createdAt_idx" on "PrintOrder"("userId", "createdAt" DESC);
//   * no IF NOT EXISTS: an invalid index left by a failed build must make the migration fail, never be taken for done;
//   * prisma/schema.prisma declares the same index (the drift check compares the schema with what the migrations build);
//   * it comes after the migrations it was written on (DR-13's index the last of them), and it touches nothing else.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const NAME = '20261111150000_kloss_owner_orders_index'
const FILE = path.join(ROOT, 'prisma', 'migrations', NAME, 'migration.sql')
// the statements of a SQL file: comments and blank lines are no statements
const statementsOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(';').map((part) => part.trim()).filter(Boolean)

test('A-idx migration: ONE statement - CREATE INDEX CONCURRENTLY of the index of an account\'s orders, newest first - and nothing else', () => {
  const statements = statementsOf(readFileSync(FILE, 'utf8'))
  assert.equal(statements.length, 1, `a second statement would make the batch a transaction, and CONCURRENTLY would fail: ${JSON.stringify(statements)}`)
  assert.equal(statements[0].replace(/\s+/g, ' '), 'CREATE INDEX CONCURRENTLY "PrintOrder_userId_createdAt_idx" ON "PrintOrder"("userId", "createdAt" DESC)')
  assert.equal(/IF\s+NOT\s+EXISTS/i.test(statements[0]), false, 'an invalid index left behind must make the migration fail')
  assert.equal(/\b(BEGIN|COMMIT|DROP|ALTER|UPDATE|DELETE|INSERT)\b/i.test(statements[0]), false)
})

test('A-idx migration: the schema declares the same index, and the migration comes after the ones it was written on', () => {
  const schema = readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8')
  const model = schema.slice(schema.indexOf('model PrintOrder {'), schema.indexOf('\n}', schema.indexOf('model PrintOrder {')))
  assert.ok(model.includes('@@index([userId, createdAt(sort: Desc)])'), 'prisma/schema.prisma declares @@index([userId, createdAt(sort: Desc)]) on PrintOrder')
  const migrations = readdirSync(path.join(ROOT, 'prisma', 'migrations')).filter((entry) => /^\d{14}_/.test(entry)).sort()
  assert.ok(migrations.indexOf(NAME) > migrations.indexOf('20261104130000_dr13_single_live_page') && migrations.indexOf('20261104130000_dr13_single_live_page') >= 0)
})
