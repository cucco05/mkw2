// R1-3 / KLOSS hardening C — the payments Stripe told us about (webhook) that no order shows: a READ-ONLY diagnostic of THIS database. The rules, and what it can NOT say, are in
// lib/unmatched-payments.ts.
//
//   npx tsx scripts/unmatched-payments-check.ts [--recent-minutes <n>]
//
//   --recent-minutes  how young a payment nobody claims has to be to count as "recent" (an order of the old flow may still claim it) rather than "orphan". Default 60.
//
// Output: the report as JSON on stdout (nothing else on it); what it found and - always - its limits, in words, on stderr.
// Exit status: 0 no candidate in the database · 1 candidates to reconcile · 2 the diagnostic failed · 64 wrong use.
// Exit status 0 is NOT "every Stripe payment is reconciled": a payment whose webhook never arrived leaves nothing here. It is never, by itself, an authorization to switch the owner guard on
// (docs/RILASCIO-PRODUZIONE.md). It writes nothing (every query runs in a transaction PostgreSQL keeps READ ONLY) and it calls nothing outside the database.
import { prisma } from '@/lib/db'
import { describeUnmatchedPayments, diagnoseUnmatchedPayments, RECENT_DEFAULT_MS } from '@/lib/unmatched-payments'

function usage(message: string): never {
  console.error(`${message}\nusage: npx tsx scripts/unmatched-payments-check.ts [--recent-minutes <n>]`)
  process.exit(64)
}

function parse(argv: string[]): { recentMs: number } {
  let recentMs = RECENT_DEFAULT_MS
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg !== '--recent-minutes') usage(`unknown argument: ${arg}`)
    if (seen) usage(`${arg} given twice`)
    seen = true
    const value = argv[++i]
    if (value === undefined || !/^\d{1,6}$/.test(value)) usage(`${arg} needs a whole number of minutes`)
    recentMs = Number(value) * 60_000
  }
  return { recentMs }
}

async function main() {
  // stdout carries the report and nothing else: the application logs with console.log, which goes to stderr for this command
  const stdout = process.stdout.write.bind(process.stdout)
  console.log = (...args: unknown[]) => console.error(...args)
  const { recentMs } = parse(process.argv.slice(2))
  let code = 2
  try {
    const report = await diagnoseUnmatchedPayments({ recentMs })
    stdout(`${JSON.stringify(report, null, 2)}\n`)
    console.error(describeUnmatchedPayments(report))
    code = report.candidates.length > 0 ? 1 : 0
  } catch (error) {
    console.error(`The diagnostic failed - nothing can be concluded from it: ${String((error as Error)?.message ?? error).slice(0, 300)}`)
    code = 2
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
  process.exit(code)
}

void main()
