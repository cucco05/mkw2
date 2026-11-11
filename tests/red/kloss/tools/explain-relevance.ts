// R1-3 / KLOSS hardening A - prints the statement readSiblings runs (lib/checkout-owner-guard.ts, siblingIdsQuery) with its values written in, for EXPLAIN (tests/red/kloss/explain.sh).
// The statement is the production one, built by the production function: only the values are inlined as SQL literals (strings quoted, numbers as they are). It reads and writes nothing.
// usage: npx tsx tests/red/kloss/tools/explain-relevance.ts <account|guest> <userId | hash1,hash2> <cart>[,<cart>...] [orderId,orderId...]
// Not a test (no test pattern matches it).
import { Prisma } from '@prisma/client'
import { JOIN_WINDOW_MS } from '../../../../lib/checkout-session-plan'
import { REPEAT_CONFIRM_WINDOW_MS, SIBLING_LIMIT, siblingIdsQuery } from '../../../../lib/checkout-owner-guard'
import { scopeOf } from '../../../../lib/owner-intent'

const [kind, who, carts, ids] = process.argv.slice(2)
if ((kind !== 'account' && kind !== 'guest') || !who || !carts) {
  console.error('usage: explain-relevance.ts <account|guest> <userId | hash1,hash2> <cart>[,<cart>] [orderId,...]')
  process.exit(64)
}
const scope = kind === 'account'
  ? scopeOf({ kind: 'account', userId: who })
  : scopeOf({ kind: 'guest', sessionHash: who.split(',')[0], verifiedOrders: [...who.split(',').slice(1).map((hash, index) => ({ id: `none_${index}`, guestSessionHash: hash })), ...(ids ? ids.split(',').map((id) => ({ id, guestSessionHash: null })) : [])] })
const now = Date.now()
// the relevance S2 reads by with the repeat gate on: the reuse window (an hour) and the window of the gate (an hour)
const query = siblingIdsQuery(scope, carts.split(','), { unpaidSince: now - Math.max(60 * 60 * 1000, JOIN_WINDOW_MS), verifiedSince: now - REPEAT_CONFIRM_WINDOW_MS }, SIBLING_LIMIT)
if (!query) { console.error('the scope proves nothing'); process.exit(65) }
const literal = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new TypeError(`a value of another kind: ${typeof value}`)
}
const sql = query as Prisma.Sql
process.stdout.write(sql.strings.reduce((text, part, index) => text + part + (index < sql.values.length ? literal(sql.values[index]) : ''), '').replace(/\s+/g, ' ').trim())
