// The unique index that allows ONE live payment page per order (migration 20261104130000_dr13_single_live_page), as the tests of the security suite meet it.
//
// The database of a test has the index, so every test runs against the schema the application will have: a statement that would leave two live pages (a reservation or an open page) for one order
// fails with a unique violation, and the code under test decides again. But data made BEFORE DR-13 may hold several live pages for one order (the twin pages the old code could leave behind), and
// the code must read them correctly (the planner closes the extras with proof; the payment sync closes the others when one is paid). A test that models such data says so: it takes the index away
// for as long as it needs (`allowLegacyTwins`, or the wrapper `withLegacyTwins`) and the harness puts it back before the next test (`restoreLivePageIndex`, called by every reset).
// Not a test file (its name does not match the test patterns).
import type { PrismaClient } from '@prisma/client'

export const LIVE_PAGE_INDEX = 'PaymentAttempt_orderId_live_page_key'
const CREATE = `CREATE UNIQUE INDEX IF NOT EXISTS "${LIVE_PAGE_INDEX}" ON "PaymentAttempt" ("orderId") WHERE "status" IN ('creating', 'open')`

export async function livePageIndexExists(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${LIVE_PAGE_INDEX}'`)
  return Number(rows[0]?.n ?? 0) === 1
}

// The index is taken away: from now on a test may write several live pages for one order.
export async function allowLegacyTwins(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${LIVE_PAGE_INDEX}"`)
}

// The index is put back. It can only be created while no order holds two live pages, so when it is missing the payment attempts of the test database are removed first (a reset removes them anyway;
// nothing a test did survives into the next one).
export async function restoreLivePageIndex(prisma: PrismaClient): Promise<void> {
  if (await livePageIndexExists(prisma)) return
  await prisma.paymentAttempt.deleteMany({})
  await prisma.$executeRawUnsafe(CREATE)
}

export async function withLegacyTwins<T>(prisma: PrismaClient, body: () => Promise<T>): Promise<T> {
  await allowLegacyTwins(prisma)
  try {
    return await body()
  } finally {
    await restoreLivePageIndex(prisma)
  }
}
