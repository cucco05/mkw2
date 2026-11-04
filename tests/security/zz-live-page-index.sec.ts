// The LAST file of the security suite (the files run in alphabetical order): the financial backstop of the suite - the unique index of live payment pages - is present AND defined as in the
// migration, and no legacy fixture is left declared. (Every file also checks it after each of its tests and at its own end: tests/security/_harness.ts.)
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from './_harness'
import { assertLivePageIndexIntact } from './_live-page-index'

test('END OF THE SUITE: the unique index of live payment pages is present and is the one of the migration; no legacy fixture is left declared; no order holds two live attempts', async () => {
  const prisma = await db()
  await assertLivePageIndexIntact(prisma, 'at the end of the suite')
  const registry = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT CASE WHEN to_regclass('sectest_support.legacy_order') IS NULL THEN 0 ELSE (SELECT count(*)::int FROM sectest_support.legacy_order) END AS n`)
  assert.equal(Number(registry[0].n), 0, 'a legacy fixture was left declared')
  const duplicates = await prisma.$queryRawUnsafe<Array<{ orderId: string }>>(`SELECT "orderId" FROM "PaymentAttempt" WHERE "status" IN ('creating','open') GROUP BY "orderId" HAVING count(*) > 1`)
  assert.deepEqual(duplicates, [], 'an order holds two live attempts at the end of the suite')
})
