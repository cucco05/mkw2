// Helper process for admin-audit-chain.sec.ts: a REAL separate Node process (its own memory, its own database connections) that records audit events with the helper of lib/admin-audit.ts,
// at wall-clock moments it shares with its siblings, against the shared test database.
//   CHILD_MODE=standalone   the helper is called with no transaction of the caller's (the way thirteen routes call it)
//   CHILD_MODE=joined       the helper is called with the caller's own transaction (the way the others call it)
//   CHILD_ROUNDS            how many rounds; each round starts at CHILD_START_AT + round * CHILD_SPACING_MS (the same moment in every process)
//   CHILD_EVENTS_PER_ROUND  how many events one round records (default 1)
//   CHILD_IDENTICAL=1       every process records, in a round, exactly the same material (same action, same metadata)
// It prints ONE line, `RESULT {json}`. Not a test file (its name does not match the test patterns).
import './_harness'
import { prisma } from '../../lib/db'
import * as audit from '../../lib/admin-audit'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const mode = process.env.CHILD_MODE || 'standalone'
  const label = process.env.CHILD_LABEL || 'p'
  const adminId = process.env.CHILD_ADMIN as string
  const rounds = Number(process.env.CHILD_ROUNDS || 1)
  const perRound = Number(process.env.CHILD_EVENTS_PER_ROUND || 1)
  const startAt = Number(process.env.CHILD_START_AT || 0)
  const spacing = Number(process.env.CHILD_SPACING_MS || 150)
  const identical = process.env.CHILD_IDENTICAL === '1'
  await prisma.$queryRaw`SELECT 1`   // the connection is open before the start signal
  let done = 0
  const failures: string[] = []
  for (let round = 0; round < rounds; round++) {
    const wait = startAt + round * spacing - Date.now()
    if (wait > 0) await sleep(wait)
    for (let n = 0; n < perRound; n++) {
      const input = {
        adminId, action: 'auditchain.child', targetType: 'probe', targetId: `round-${round}-${n}`, requestMethod: 'TEST', requestPath: 'tests/security/_admin-audit-child.ts',
        metadata: identical ? { round, n, same: 'material' } : { round, n, process: label },
      }
      try {
        if (mode === 'joined') await prisma.$transaction((tx) => audit.recordAdminAuditEvent(input, tx), { timeout: 30_000, maxWait: 20_000 })
        else await audit.recordAdminAuditEvent(input)
        done++
      } catch (error: any) {
        failures.push(String(error?.code ?? error?.message ?? 'error').slice(0, 80))
      }
    }
  }
  console.log(`RESULT ${JSON.stringify({ label, mode, done, failures })}`)
  await prisma.$disconnect()
  process.exit(0)
}
main().catch((error) => { console.log(`RESULT ${JSON.stringify({ label: process.env.CHILD_LABEL, crashed: String(error?.message ?? error).slice(0, 200) })}`); process.exit(0) })
