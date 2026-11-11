// R1-3 / KLOSS - prints the statement findPurchaseInFlight (lib/checkout-orders.ts) sends for an account, EXACTLY as Prisma writes it, with its values written in, for EXPLAIN
// (tests/red/kloss/explain-index.py). The function is called as it is, unchanged: a Prisma client that logs its queries is put where lib/db.ts takes its client from (outside production it
// reuses global.prisma), and the first statement the function sends - the one that picks the orders in doubt - is printed. It reads only (findPurchaseInFlight is a read).
// usage: DATABASE_URL=<a local *_sectest database> npx tsx tests/red/kloss/tools/explain-in-flight.ts <userId> <cart> [<legacy cart>]
// Not a test (no test pattern matches it).
import { PrismaClient } from '@prisma/client'

async function main() {
  const [userId, cart, legacy] = process.argv.slice(2)
  const url = new URL(process.env.DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_sectest') || !userId || !cart) {
    console.error('usage: DATABASE_URL=<a local *_sectest database> explain-in-flight.ts <userId> <cart> [<legacy cart>]')
    process.exit(64)
  }
  const captured: Array<{ query: string; params: string }> = []
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  client.$on('query' as never, (event: { query: string; params: string }) => { captured.push({ query: event.query, params: event.params }) })
  ;(globalThis as unknown as { prisma: PrismaClient }).prisma = client
  const { findPurchaseInFlight } = await import('../../../../lib/checkout-orders')
  await findPurchaseInFlight({ principalId: userId, guestOrderIds: [], cartFingerprint: cart, legacyCartFingerprint: legacy })
  await client.$disconnect()
  const first = captured.find((entry) => /FROM "public"\."PrintOrder"/.test(entry.query))
  if (!first) { console.error('no statement on PrintOrder was sent'); process.exit(65) }
  const params = JSON.parse(first.params) as unknown[]
  const literal = (value: unknown): string => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    throw new TypeError(`a value of another kind: ${JSON.stringify(value)}`)
  }
  // ($10 before $1; a value compared with a jsonb is written as the JSON it stands for, as Prisma sends it)
  let sql = first.query
  for (let index = params.length; index >= 1; index--) {
    sql = sql.split(`::jsonb = $${index}`).join(`::jsonb = ${literal(JSON.stringify(params[index - 1]))}`)
    sql = sql.split(`$${index}`).join(literal(params[index - 1]))
  }
  process.stdout.write(sql.replace(/\s+/g, ' ').trim())
}
main().catch((error) => { console.error(error); process.exit(1) })
