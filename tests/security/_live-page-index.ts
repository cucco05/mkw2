// The unique index that allows ONE live payment page per order (migration 20261104130000_dr13_single_live_page), as the tests of the security suite meet it.
//
// The database of a test has the index, so every test runs against the schema the application will have: a statement that would leave two live pages (a reservation or an open page) for one order
// fails with a unique violation, and the code under test decides again. But data made BEFORE DR-13 may hold several live pages for one order (the twin pages the old code could leave behind), and
// the code must read them correctly (the planner closes the extras with proof; the payment sync closes the others when one is paid). A test that models such data takes the index away
// (`allowLegacyTwins`) and DECLARES the order as a legacy fixture (`declareLegacyOrder`); the harness puts the index back after the test (`restoreLivePageIndex`), and:
//   * it never deletes a payment attempt. The only thing it ever does to a row is to close - not delete - the EXTRA live attempts of an order that the test declared;
//   * if an order that nobody declared holds two live attempts, the index can not be put back and the test FAILS: those rows are not a fixture, they are what the code under test left behind;
//   * the presence AND the definition of the index are checked after every test and at the end of every file (tests/security/_harness.ts), and by the last file of the suite
//     (tests/security/zz-live-page-index.sec.ts);
//   * a process that died with the index missing is recovered EXPLICITLY at the start of the next file (`recoverLivePageIndexAtStart`, called by resetDb after it emptied the tables), with a message.
// Not a test file (its name does not match the test patterns).
import type { PrismaClient } from '@prisma/client'

export const LIVE_PAGE_INDEX = 'PaymentAttempt_orderId_live_page_key'
// the definition as PostgreSQL reports it for the migration (pg_indexes.indexdef)
export const LIVE_PAGE_INDEX_DEFINITION = `CREATE UNIQUE INDEX "${LIVE_PAGE_INDEX}" ON public."PaymentAttempt" USING btree ("orderId") WHERE (status = ANY (ARRAY['creating'::text, 'open'::text]))`
const CREATE = `CREATE UNIQUE INDEX IF NOT EXISTS "${LIVE_PAGE_INDEX}" ON "PaymentAttempt" ("orderId") WHERE "status" IN ('creating', 'open')`
const REGISTRY = 'sectest_support.legacy_order'

let lifted = false   // this process took the index away and has not put it back yet

export async function livePageIndexDefinition(prisma: PrismaClient): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${LIVE_PAGE_INDEX}'`)
  return rows[0]?.indexdef ?? null
}
export async function livePageIndexExists(prisma: PrismaClient): Promise<boolean> {
  return (await livePageIndexDefinition(prisma)) !== null
}

// Throws unless the index is there AND is the one the migration creates (unique, btree, on "orderId", only for status creating / open).
export async function assertLivePageIndexIntact(prisma: PrismaClient, where: string): Promise<void> {
  const definition = await livePageIndexDefinition(prisma)
  if (definition === null) throw new Error(`[live-page index] ${where}: the unique index "${LIVE_PAGE_INDEX}" is MISSING`)
  if (definition !== LIVE_PAGE_INDEX_DEFINITION) throw new Error(`[live-page index] ${where}: the index is not the one of the migration.\n  found:    ${definition}\n  expected: ${LIVE_PAGE_INDEX_DEFINITION}`)
}

async function ensureRegistry(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS sectest_support')
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${REGISTRY} (order_id text PRIMARY KEY, label text NOT NULL, declared_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
}

// The index is taken away: from now on a test may write several live pages for one order. The test must declare every such order.
export async function allowLegacyTwins(prisma: PrismaClient): Promise<void> {
  await ensureRegistry(prisma)
  lifted = true
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${LIVE_PAGE_INDEX}"`)
}

// "this order is data made by the old code": the harness may close the extra live attempts of THIS order when it puts the index back
export async function declareLegacyOrder(prisma: PrismaClient, orderId: string, label = 'legacy fixture'): Promise<void> {
  await ensureRegistry(prisma)
  await prisma.$executeRawUnsafe(`INSERT INTO ${REGISTRY} (order_id, label) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`, orderId, label)
}

// The index is put back. It can only be created while no order holds two live attempts, and nothing is ever deleted here:
//   * an order that a test declared: its extra live attempts (all but the oldest) are CLOSED (expired, with a reason that says so);
//   * an order nobody declared with two live attempts: the call throws and the index stays missing - the test fails, the evidence stays in the database.
export async function restoreLivePageIndex(prisma: PrismaClient): Promise<{ closed: number; created: boolean }> {
  const definition = await livePageIndexDefinition(prisma)
  if (definition !== null) {
    await assertLivePageIndexIntact(prisma, 'while putting it back')
    lifted = false
    return { closed: 0, created: false }
  }
  await ensureRegistry(prisma)
  const offenders = await prisma.$queryRawUnsafe<Array<{ orderId: string; n: number; declared: boolean }>>(
    `SELECT a."orderId" AS "orderId", count(*)::int AS n, (l.order_id IS NOT NULL) AS declared
     FROM "PaymentAttempt" a LEFT JOIN ${REGISTRY} l ON l.order_id = a."orderId"
     WHERE a."status" IN ('creating', 'open') GROUP BY a."orderId", l.order_id HAVING count(*) > 1`)
  const undeclared = offenders.filter((o) => !o.declared)
  if (undeclared.length > 0) {
    throw new Error(`[live-page index] the unique index can not be put back: ${undeclared.length} order(s) hold several live payment attempts that no test declared as legacy fixtures `
      + `(${undeclared.slice(0, 5).map((o) => `${o.orderId}:${o.n}`).join(', ')}). They are what the code under test left behind, or a fixture that must call declareLegacyOrder; nothing was deleted.`)
  }
  let closed = 0
  for (const offender of offenders) {
    closed += Number(await prisma.$executeRawUnsafe(
      `UPDATE "PaymentAttempt" SET "status" = 'expired', "failureReason" = 'legacy_fixture_closed_by_harness', "updatedAt" = now()
       WHERE "orderId" = $1 AND "status" IN ('creating', 'open')
         AND "id" NOT IN (SELECT "id" FROM "PaymentAttempt" WHERE "orderId" = $1 AND "status" IN ('creating', 'open') ORDER BY "createdAt", "id" LIMIT 1)`, offender.orderId))
  }
  await prisma.$executeRawUnsafe(CREATE)
  await prisma.$executeRawUnsafe(`DELETE FROM ${REGISTRY}`)
  await assertLivePageIndexIntact(prisma, 'after putting it back')
  lifted = false
  return { closed, created: true }
}

// Called by resetDb AFTER it emptied the orders (and with them the attempts): a process that died while the index was away leaves it missing, and this is where it is put back - explicitly.
export async function recoverLivePageIndexAtStart(prisma: PrismaClient): Promise<boolean> {
  if (await livePageIndexExists(prisma)) { await assertLivePageIndexIntact(prisma, 'at the start of the file'); return false }
  const result = await restoreLivePageIndex(prisma)
  console.warn(`[live-page index] RECOVERED at the start of the file: the index was missing (a previous process died before putting it back); ${result.closed} attempt(s) closed, none deleted`)
  return true
}

// What runs after every test and at the end of every file. An index that is missing although THIS process never took it away is a defect, not something to repair silently.
export async function guardLivePageIndex(prisma: PrismaClient, where: string): Promise<void> {
  if (!lifted) { await assertLivePageIndexIntact(prisma, where); return }
  await restoreLivePageIndex(prisma)
  await assertLivePageIndexIntact(prisma, where)
}

export async function withLegacyTwins<T>(prisma: PrismaClient, body: () => Promise<T>): Promise<T> {
  await allowLegacyTwins(prisma)
  try {
    return await body()
  } finally {
    await restoreLivePageIndex(prisma)
  }
}
