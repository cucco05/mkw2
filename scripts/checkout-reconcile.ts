// DR-13 / D10 — reconcile ONE payment attempt with the Stripe session the provider names for it. The rules, the guarantees and what this NEVER does are in lib/checkout-reconcile.ts.
//
//   npx tsx scripts/checkout-reconcile.ts --attempt <attemptId> --operator <administrator id or e-mail> [--session cs_...] [--discover] [--apply]
//
//   --attempt   the payment attempt (scripts/checkout-pages-check.sql lists them: Q2 reservations, Q5 closed without proof, Q6 pages to close)
//   --operator  the administrator on whose behalf this is done (an id, or the e-mail of an account that is an administrator and not suspended); it is written in the audit log
//   --session   the Checkout session of the attempt, copied from the provider (dashboard, webhook, receipt). If it is not given and the attempt holds none, --discover can look for it
//   --discover  look through the sessions created around the reservation for ones whose metadata names the attempt. Finding NOTHING proves nothing and changes nothing
//   --apply     do it. WITHOUT it this is a DRY RUN: it reads the attempt and the session, says what would be done, and writes nothing (no row, no audit event)
//
// Output: the result as JSON on stdout (nothing else on it; the log lines go to stderr). Exit status: 0 planned / applied / nothing to do · 2 refused or no evidence (nothing was changed) · 3 partial
// (something was committed, something is left: run it again) · 64 wrong use · 1 unexpected error.
// It needs the same DATABASE_URL and STRIPE_SECRET_KEY as the application, and it must be run by the person who owns that decision: nothing starts it by itself.
import { prisma } from '@/lib/db'
import { reconcileAttempt } from '@/lib/checkout-reconcile'
import { pageJobsSettled } from '@/lib/checkout-pages'

const KNOWN = new Set(['--attempt', '--operator', '--session', '--discover', '--apply', '--dry-run'])

function usage(message: string): never {
  console.error(`${message}\nusage: npx tsx scripts/checkout-reconcile.ts --attempt <attemptId> --operator <administrator id or e-mail> [--session cs_...] [--discover] [--apply]`)
  process.exit(64)
}

function parse(argv: string[]) {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!KNOWN.has(arg)) usage(`unknown argument: ${arg}`)
    if (arg === '--discover' || arg === '--apply' || arg === '--dry-run') flags.add(arg)
    else {
      const value = argv[++i]
      if (!value || value.startsWith('--')) usage(`${arg} needs a value`)
      if (values.has(arg)) usage(`${arg} given twice`)
      values.set(arg, value)
    }
  }
  if (flags.has('--apply') && flags.has('--dry-run')) usage('--apply and --dry-run exclude each other')
  return { values, flags }
}

async function main() {
  // stdout carries the result and nothing else: the application logs with console.log, which is sent to stderr for this command
  const stdout = process.stdout.write.bind(process.stdout)
  console.log = (...args: unknown[]) => console.error(...args)
  const { values, flags } = parse(process.argv.slice(2))
  const attemptId = values.get('--attempt')
  const operator = values.get('--operator')
  if (!attemptId) usage('--attempt is required')
  if (!operator) usage('--operator is required')
  // an e-mail names an account; anything else is taken as the id (and refused by the library if it is not an administrator)
  const operatorId = operator.includes('@')
    ? (await prisma.user.findUnique({ where: { email: operator.trim().toLowerCase() }, select: { id: true } }))?.id ?? ''
    : operator
  const result = await reconcileAttempt({
    attemptId,
    sessionId: values.get('--session') ?? null,
    discover: flags.has('--discover'),
    operatorId,
    dryRun: !flags.has('--apply'),
  })
  await pageJobsSettled()
  stdout(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.outcome === 'refused' || result.outcome === 'no_evidence' ? 2 : result.outcome === 'partial' ? 3 : 0
}

main()
  .catch((error) => {
    console.error('checkout-reconcile failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
