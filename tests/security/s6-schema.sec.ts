// Step 4.6, S6a (M3a, M3b) - what the two additive migrations promise, proved in the database itself (a throw-away database migrated from scratch by `prisma migrate`).
//   M3a  the table RefundOperation: the record of every refund the application asked Stripe for. Its rules live in the database too, not only in the code:
//        * "abandoned" means PROVED never to have been sent: a CHECK constraint refuses it for an operation that has a first-send time - on insert AND on update, whoever writes;
//        * an order that has refund operations can not be deleted (ON DELETE RESTRICT): they are the record of money that was asked to move;
//        * the operation id is the primary key (the same operation can not exist twice) and a Stripe refund id belongs to one operation only.
//   M3b  the column PrintOrder.financialRevision: an integer that can not be missing and starts at 0 for every row that already exists.
// And the schema file and the database agree (no drift). No Stripe, PayPal, PrintLab, StockWorks or printer is ever contacted.
import './_harness'
import { db } from './_harness'
import { makeOrder, releasedSpec, resetSeams, setup, teardown, world } from './_release-fixtures'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import test, { afterEach } from 'node:test'

test.before(setup)
test.after(teardown)
afterEach(resetSeams)

const rejection = async (run: () => Promise<unknown>) => {
  try { await run() } catch (error) { return String((error as Error)?.message ?? error) }
  return ''
}
async function operation(orderId: string, over: Record<string, unknown> = {}) {
  const prisma = await db()
  return prisma.refundOperation.create({
    data: {
      id: randomUUID(), orderId, paymentIntentId: 'pi_schema_fixture', amountCents: 500, currency: 'EUR', expectedRefundedCents: 0, reason: 'duplicate', note: 'a refund asked for by the schema test',
      status: 'requested', ...over,
    } as any,
  })
}

test('M3a "abandoned" means proved never sent: the database refuses it for an operation that has a first-send time, on insert and on update, however it is written', async () => {
  await world()
  const prisma = await db()
  const order = await makeOrder(releasedSpec())
  // insert
  const typed = await rejection(() => operation(order.id, { status: 'abandoned', firstSentAt: new Date() }))
  assert.match(typed, /RefundOperation_abandoned_never_sent_check|check constraint/i, `the typed API wrote an abandoned operation that may have been sent: ${typed || 'no error'}`)
  const raw = await rejection(() => prisma.$executeRawUnsafe(
    `INSERT INTO "RefundOperation" ("id","orderId","paymentIntentId","amountCents","currency","expectedRefundedCents","reason","note","status","firstSentAt","updatedAt") VALUES ('${randomUUID()}','${order.id}','pi_x',100,'EUR',0,'duplicate','note','abandoned', now(), now())`,
  ))
  assert.match(raw, /RefundOperation_abandoned_never_sent_check/, `a direct INSERT got through: ${raw || 'no error'}`)
  assert.equal(await prisma.refundOperation.count({ where: { orderId: order.id } }), 0, 'a refused insert left a row behind')
  // an abandoned operation WITHOUT a first-send time is the proof, and is allowed
  const proved = await operation(order.id, { status: 'abandoned', firstSentAt: null })
  assert.equal(proved.status, 'abandoned')
  // update: an operation that may have been sent can not be turned into "abandoned" ...
  const sent = await operation(order.id, { status: 'unknown', firstSentAt: new Date(), attempts: 1 })
  const turned = await rejection(() => prisma.refundOperation.update({ where: { id: sent.id }, data: { status: 'abandoned' } }))
  assert.match(turned, /RefundOperation_abandoned_never_sent_check|check constraint/i, `an operation that may have been sent was abandoned: ${turned || 'no error'}`)
  assert.equal((await prisma.refundOperation.findUniqueOrThrow({ where: { id: sent.id } })).status, 'unknown')
  const rawUpdate = await rejection(() => prisma.$executeRawUnsafe(`UPDATE "RefundOperation" SET "status" = 'abandoned' WHERE "id" = '${sent.id}'`))
  assert.match(rawUpdate, /RefundOperation_abandoned_never_sent_check/, `a direct UPDATE got through: ${rawUpdate || 'no error'}`)
  // ... while one that was never sent can
  const never = await operation(order.id, { status: 'requested', firstSentAt: null })
  assert.equal((await prisma.refundOperation.update({ where: { id: never.id }, data: { status: 'abandoned' } })).status, 'abandoned')
  // and a first-send time can not be written AFTER the operation was abandoned
  const late = await rejection(() => prisma.refundOperation.update({ where: { id: never.id }, data: { firstSentAt: new Date() } }))
  assert.match(late, /RefundOperation_abandoned_never_sent_check|check constraint/i, 'a first-send time was written on an abandoned operation')
})

test('M3a an order that has refund operations can not be deleted: ON DELETE RESTRICT, and the operation stays', async () => {
  await world()
  const prisma = await db()
  const order = await makeOrder(releasedSpec())
  const op = await operation(order.id)
  const one = await rejection(() => prisma.printOrder.delete({ where: { id: order.id } }))
  assert.match(one, /foreign key|RefundOperation_orderId_fkey|constraint/i, `the order was deleted under its refund operation: ${one || 'no error'}`)
  const many = await rejection(() => prisma.printOrder.deleteMany({ where: { id: order.id } }))
  assert.match(many, /foreign key|RefundOperation_orderId_fkey|constraint/i)
  assert.ok(await prisma.printOrder.findUnique({ where: { id: order.id } }), 'the order is gone')
  assert.ok(await prisma.refundOperation.findUnique({ where: { id: op.id } }), 'the operation is gone')
  // an operation can not point at an order that does not exist
  const orphan = await rejection(() => operation('cm_no_such_order_00000000'))
  assert.match(orphan, /foreign key|constraint/i)
})

test('M3a the operation id is the primary key; a Stripe refund id belongs to one operation; several operations may not have one yet', async () => {
  await world()
  const prisma = await db()
  const order = await makeOrder(releasedSpec())
  const first = await operation(order.id, { stripeRefundId: 're_schema_1', status: 'pending', stripeRefundStatus: 'pending', firstSentAt: new Date() })
  const same = await rejection(() => operation(order.id, { id: first.id }))
  assert.match(same, /Unique constraint|duplicate key/i, 'the same operation id was accepted twice')
  const twin = await rejection(() => operation(order.id, { stripeRefundId: 're_schema_1', status: 'pending', firstSentAt: new Date() }))
  assert.match(twin, /Unique constraint|duplicate key/i, 'one Stripe refund was attached to two operations')
  await operation(order.id, { stripeRefundId: null })
  await operation(order.id, { stripeRefundId: null })
  assert.equal(await prisma.refundOperation.count({ where: { orderId: order.id, stripeRefundId: null } }), 2, 'operations that have no Stripe refund yet must not collide')
})

test('M3a the columns and defaults of a new operation: attempts 0, no lease, no times, the creation and update times are kept by the database / the client', async () => {
  await world()
  const prisma = await db()
  const order = await makeOrder(releasedSpec())
  const op = await operation(order.id)
  assert.equal(op.attempts, 0)
  for (const field of ['sendLeaseUntil', 'firstSentAt', 'acceptedAt', 'appliedAt', 'lastReconciledAt', 'unresolvedAt', 'completedAt', 'stripeRefundId', 'stripeRefundStatus', 'failureKind', 'failureCode', 'adminId', 'unresolvedReason', 'recoveredBy', 'adoptedBy'] as const) {
    assert.equal((op as any)[field], null, `${field} should start empty`)
  }
  assert.ok(op.createdAt instanceof Date && op.updatedAt instanceof Date)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const touched = await prisma.refundOperation.update({ where: { id: op.id }, data: { attempts: 1 } })
  assert.ok(touched.updatedAt.getTime() > op.updatedAt.getTime(), 'updatedAt did not move')
  // the index the blocking rule reads through: (orderId, status)
  const indexes = (await prisma.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE tablename = 'RefundOperation'`)) as Array<{ indexdef: string }>
  assert.ok(indexes.some((index) => /\("orderId", status\)/.test(index.indexdef)), `no index on (orderId, status): ${indexes.map((index) => index.indexdef).join(' | ')}`)
})

test('M3b financialRevision: an integer that can not be missing, 0 for a row written without it (every order that existed before the migration)', async () => {
  await world()
  const prisma = await db()
  const column = (await prisma.$queryRawUnsafe(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'PrintOrder' AND column_name = 'financialRevision'`)) as Array<{ data_type: string; is_nullable: string; column_default: string }>
  assert.deepEqual(column.map((c) => [c.data_type, c.is_nullable, String(c.column_default)]), [['integer', 'NO', '0']])
  // a row inserted the way the code of step S5 did (it knows nothing of the column): the database gives it 0
  const id = `legacy_${Date.now().toString(36)}`
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PrintOrder" ("id","status","paymentMethod","paymentStatus","subtotalCents","totalCents","currency","updatedAt") VALUES ('${id}','awaiting_payment','card','pending',1000,1000,'EUR', now())`,
  )
  assert.equal((await prisma.printOrder.findUniqueOrThrow({ where: { id } })).financialRevision, 0)
  const nulled = await rejection(() => prisma.$executeRawUnsafe(`UPDATE "PrintOrder" SET "financialRevision" = NULL WHERE "id" = '${id}'`))
  assert.match(nulled, /23502|not-null|null value/i, `the revision was emptied: ${nulled || 'no error'}`)
  await prisma.printOrder.delete({ where: { id } })
})

test('the schema file and the database agree: no drift between prisma/schema.prisma and what the migrations built', () => {
  const url = process.env.SEC_TEST_DATABASE_URL as string
  let output = ''
  try {
    output = execFileSync('npx', ['prisma', 'migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    assert.fail(`prisma sees a difference between the schema file and the database (exit ${failure.status}): ${(failure.stdout ?? '').slice(0, 1500)} ${(failure.stderr ?? '').slice(0, 500)}`)
  }
  assert.match(output, /No difference detected/)
})
