// R1-3 / KLOSS, P1 - the pure rules of lib/owner-intent.ts say the same as the database, on real rows of the isolated PostgreSQL (fake data, throw-away database).
//
// The pure module can not call the database, so three of its rules are written twice: once as a function over facts already read, once as the query that will read them. Here they are run
// side by side over a matrix of real orders, and must pick EXACTLY the same orders:
//   1. isInDoubt            = PAYMENT_IN_DOUBT_WHERE (and its SQL twin): the one definition of "a payment in doubt" the guard against paying twice already uses (lib/payment-in-doubt.ts);
//   2. orderInScope         = the query P2 will use to find the siblings of an owner (written here as the specification of that query): an account's orders by `userId`, a guest's by a
//                             proved hash or a verified id - and only orders of no account;
//   3. the reuse rule       = today's duplicate search in createPendingCardOrder (unpaid, card, same total, made less than an hour ago, same fingerprint, this browser's) - the planner reuses
//                             EXACTLY those orders when no page holds the cart, and in addition the ones whose page is still alive (D2, intended).
//   4. who is handed back   = the ownership half of that same search (the browser's own session, or an id its access cookie opens): proofAllowsReuse says yes for EXACTLY those orders, and no
//                             for an order known only by lineage (the hash of an earlier session) - which may hold the cart but is never given.
// Nothing here changes behaviour: the module is not connected to the checkout.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@prisma/client'
import { PAYMENT_IN_DOUBT_SQL, PAYMENT_IN_DOUBT_WHERE } from '../../lib/payment-in-doubt'
import { classifySiblings, isInDoubt, orderInScope, planOwnerIntent, proofAllowsReuse, proofOf, scopeOf, type OwnerEvidence, type OwnerScope, type SiblingOrder } from '../../lib/owner-intent'

const MIN = 60_000
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'd'.repeat(64)
const CART = 'c'.repeat(64)
let seq = 0
const nextKey = () => `oi-key-${(seq += 1)}-${'x'.repeat(40)}`

test.before(async () => { await resetDb() })
test.after(async () => { await resetDb() })

const base = (createdAt: Date) => ({ currency: 'EUR', subtotalCents: 5000, totalCents: 5000, paymentMethod: 'card', createdAt, updatedAt: createdAt })

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('1. a payment in doubt: the pure rule and PAYMENT_IN_DOUBT_WHERE / PAYMENT_IN_DOUBT_SQL pick the same orders, over every combination of status, payment status, reason and attempts', async () => {
  await resetDb()
  const prisma = await db()
  const statuses = ['awaiting_payment', 'awaiting_review', 'queued', 'cancelled', 'completed']
  const paymentStatuses = ['pending', 'processing', 'paid', 'free', 'canceled', 'failed', 'refunded', 'requires_capture']
  const reasons: Array<string | null> = [null, 'dispute', '']
  const attemptSets: string[][] = [[], ['open'], ['creating'], ['processing'], ['mismatch'], ['paid'], ['expired'], ['failed'], ['expired', 'processing'], ['paid', 'expired'], ['open', 'expired', 'expired']]
  const specs: Array<{ id: string; status: string; paymentStatus: string; reason: string | null; attempts: string[] }> = []
  for (const status of statuses) for (const paymentStatus of paymentStatuses) for (const reason of reasons) for (const attempts of attemptSets) {
    specs.push({ id: `d_${specs.length}`, status, paymentStatus, reason, attempts })
  }
  const createdAt = new Date(Date.now() - 5 * MIN)
  await prisma.printOrder.createMany({
    data: specs.map((spec) => ({ id: spec.id, ...base(createdAt), status: spec.status, paymentStatus: spec.paymentStatus, paymentReviewReason: spec.reason, checkoutKey: nextKey(), guestSessionHash: HASH_A, metadata: { source: 'stripe_checkout' } })),
  })
  const attempts = specs.flatMap((spec) => spec.attempts.map((status, index) => ({ orderId: spec.id, amountCents: 5000, currency: 'EUR', status, expiresAt: new Date(Date.now() + 30 * MIN), stripeSessionId: `cs_test_${spec.id}_${index}` })))
  await prisma.paymentAttempt.createMany({ data: attempts })

  const rows = await prisma.printOrder.findMany({ where: { id: { in: specs.map((spec) => spec.id) } }, select: { id: true, status: true, paymentStatus: true, paymentReviewReason: true, paymentAttempts: { select: { status: true } } } })
  assert.equal(rows.length, specs.length)
  const pure = rows.filter((row) => isInDoubt(row, row.paymentAttempts)).map((row) => row.id).sort()
  const byPrisma = (await prisma.printOrder.findMany({ where: { AND: [{ id: { in: specs.map((spec) => spec.id) } }, PAYMENT_IN_DOUBT_WHERE] }, select: { id: true } })).map((row) => row.id).sort()
  const bySql = (await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PrintOrder" WHERE "id" LIKE 'd\\_%' AND ${PAYMENT_IN_DOUBT_SQL}`)).map((row) => row.id).sort()
  assert.deepEqual(pure, byPrisma, 'the pure rule and the Prisma filter pick different orders')
  assert.deepEqual(bySql, byPrisma, 'the SQL twin and the Prisma filter pick different orders')
  // not vacuous: both kinds exist in a good number
  assert.ok(pure.length > 200 && rows.length - pure.length > 200, `${pure.length} in doubt of ${rows.length}`)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the specification of the query P2 will run to find the siblings of an owner
function scopeWhere(scope: OwnerScope): Prisma.PrintOrderWhereInput {
  const either: Prisma.PrintOrderWhereInput[] = []
  if (scope.userId !== null) either.push({ userId: scope.userId })
  const guest: Prisma.PrintOrderWhereInput[] = []
  if (scope.hashes.length > 0) guest.push({ guestSessionHash: { in: [...scope.hashes] } })
  if (scope.orderIds.length > 0) guest.push({ id: { in: [...scope.orderIds] } })
  if (guest.length > 0) either.push({ userId: null, OR: guest })
  return either.length > 0 ? { OR: either } : { id: { in: [] } }
}

test('2. the scope: the pure orderInScope and the query that repeats it pick the same orders, for an account, for a guest with a session, with cookies, with a rotated session, and for nobody', async () => {
  await resetDb()
  const prisma = await db()
  const users = [await prisma.user.create({ data: { email: 'oi-a@sectest.invalid', passwordHash: 'x', name: 'oi-a', role: 'customer' } }), await prisma.user.create({ data: { email: 'oi-b@sectest.invalid', passwordHash: 'x', name: 'oi-b', role: 'customer' } })]
  const columns: Array<{ userId: string | null; hash: string | null }> = []
  for (const userId of [null, users[0].id, users[1].id]) for (const hash of [null, '', HASH_A, HASH_B, HASH_C]) columns.push({ userId, hash })
  const createdAt = new Date(Date.now() - 5 * MIN)
  const specs = columns.flatMap((column, index) => [0, 1].map((copy) => ({ id: `s_${index}_${copy}`, ...column })))
  await prisma.printOrder.createMany({
    data: specs.map((spec) => ({ id: spec.id, ...base(createdAt), status: 'awaiting_payment', paymentStatus: 'pending', checkoutKey: nextKey(), userId: spec.userId, guestSessionHash: spec.hash, metadata: { source: 'stripe_checkout' } })),
  })
  const everyId = specs.map((spec) => spec.id)
  const evidences: Array<[string, OwnerEvidence]> = [
    ['nobody', { kind: 'guest', sessionHash: null, verifiedOrders: [] }],
    ['empty hash', { kind: 'guest', sessionHash: '', verifiedOrders: [] }],
    ['session A', { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [] }],
    ['session B', { kind: 'guest', sessionHash: HASH_B, verifiedOrders: [] }],
    ['session A + the cookie of a hashless order', { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [{ id: 's_1_0', guestSessionHash: null }] }],
    ['rotated: session C + the cookie of an order of A', { kind: 'guest', sessionHash: HASH_C, verifiedOrders: [{ id: 's_2_0', guestSessionHash: HASH_A }] }],
    ['two cookies, no session', { kind: 'guest', sessionHash: null, verifiedOrders: [{ id: 's_3_1', guestSessionHash: HASH_B }, { id: 's_0_0', guestSessionHash: null }] }],
    ['the cookie of an order of an account (it opens nothing: the order is not a guest\'s)', { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [{ id: 's_5_0', guestSessionHash: HASH_A }] }],
    ['account 1', { kind: 'account', userId: users[0].id }],
    ['account 2', { kind: 'account', userId: users[1].id }],
  ]
  for (const [name, evidence] of evidences) {
    const scope = scopeOf(evidence)
    const rows = await prisma.printOrder.findMany({ where: { AND: [{ id: { in: everyId } }, scopeWhere(scope)] }, select: { id: true } })
    const byQuery = rows.map((row) => row.id).sort()
    const all = await prisma.printOrder.findMany({ where: { id: { in: everyId } }, select: { id: true, userId: true, guestSessionHash: true } })
    const byPure = all.filter((row) => orderInScope(row, scope)).map((row) => row.id).sort()
    assert.deepEqual(byPure, byQuery, `${name}: the pure scope and the query pick different orders`)
    if (name === 'nobody' || name === 'empty hash') assert.deepEqual(byQuery, [], `${name}: proves nothing, sees nothing`)
  }
  // two guests with the same cart are not merged: the sessions of A and B select disjoint sets, and neither contains an account's order
  const a = (await prisma.printOrder.findMany({ where: { AND: [{ id: { in: everyId } }, scopeWhere(scopeOf(evidences[2][1]))] }, select: { id: true, userId: true } }))
  const b = (await prisma.printOrder.findMany({ where: { AND: [{ id: { in: everyId } }, scopeWhere(scopeOf(evidences[3][1]))] }, select: { id: true, userId: true } }))
  assert.ok(a.length > 0 && b.length > 0)
  assert.equal(a.some((row) => b.some((other) => other.id === row.id)), false)
  assert.equal([...a, ...b].some((row) => row.userId !== null), false)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('3. the reuse rule: with no page holding the cart, the planner reuses EXACTLY the orders today\'s duplicate search finds (unpaid, card, same total, less than an hour old, this browser\'s)', async () => {
  await resetDb()
  const prisma = await db()
  const now = Date.now()
  const fingerprint = 'f'.repeat(64)
  type Spec = { id: string; status: string; paymentStatus: string; paymentMethod: string; totalCents: number; ageMin: number; hash: string | null; fingerprint: string; reason: string | null; attempt: string | null }
  const specs: Spec[] = []
  for (const [status, paymentStatus] of [['awaiting_payment', 'pending'], ['awaiting_payment', 'failed'], ['cancelled', 'canceled'], ['queued', 'paid'], ['awaiting_review', 'pending']] as const) {
    for (const paymentMethod of ['card', 'cash']) for (const totalCents of [5000, 6000]) for (const ageMin of [1, 30, 59, 61, 600]) for (const hash of [HASH_A, HASH_B, null]) for (const fp of [fingerprint, 'e'.repeat(64)]) for (const _copy of [0, 1, 2]) {
      specs.push({ id: `r_${specs.length}`, status, paymentStatus, paymentMethod, totalCents, ageMin, hash, fingerprint: fp, reason: null, attempt: null })
    }
  }
  // every attempt that is closed WITH the provider's word, or none: nothing holds a page, so the only reason to reuse is today's
  await prisma.printOrder.createMany({
    data: specs.map((spec) => ({
      id: spec.id, ...base(new Date(now - spec.ageMin * MIN)), status: spec.status, paymentStatus: spec.paymentStatus, paymentMethod: spec.paymentMethod, totalCents: spec.totalCents, subtotalCents: spec.totalCents,
      checkoutKey: nextKey(), guestSessionHash: spec.hash, metadata: { source: 'stripe_checkout', checkout: { version: 1, cartFingerprint: CART, fingerprint: spec.fingerprint } },
    })),
  })
  await prisma.paymentAttempt.createMany({
    data: specs.filter((_, index) => index % 2 === 0).map((spec) => ({ orderId: spec.id, amountCents: spec.totalCents, currency: 'EUR', status: 'expired', failureReason: 'closed_by_us:order_cancelled', expiresAt: new Date(now - 5 * MIN), stripeSessionId: `cs_test_${spec.id}` })),
  })
  const request = { total: 5000, hash: HASH_A, windowMs: 60 * MIN }
  // today's search (lib/checkout-orders.ts, the guest branch of createPendingCardOrder), with the cookie's ids empty
  const today = (await prisma.printOrder.findMany({
    where: {
      id: { in: specs.map((spec) => spec.id) }, userId: null, status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', totalCents: request.total, createdAt: { gt: new Date(now - request.windowMs) },
      AND: [{ OR: [{ metadata: { path: ['checkout', 'fingerprint'], equals: fingerprint } }] }, { OR: [{ guestSessionHash: request.hash }] }],
    },
    select: { id: true },
  })).map((row) => row.id).sort()
  // the planner's candidates: the same cart (the caller filters by the cart fingerprint), this browser's session, and the fingerprint of the cart AND the total
  const rows = await prisma.printOrder.findMany({
    where: { id: { in: specs.map((spec) => spec.id) } },
    select: { id: true, orderNumber: true, userId: true, guestSessionHash: true, paymentMethod: true, status: true, paymentStatus: true, paymentReviewReason: true, stripePaymentIntentId: true, totalCents: true, refundedCents: true, paidAt: true, createdAt: true, metadata: true, paymentAttempts: { select: { id: true, status: true, stripeSessionId: true, failureReason: true, stripePaymentIntentId: true } } },
  })
  const owner: OwnerEvidence = { kind: 'guest', sessionHash: request.hash, verifiedOrders: [] }
  const siblings: SiblingOrder[] = rows
    .filter((row) => (row.metadata as { checkout?: { fingerprint?: string } } | null)?.checkout?.fingerprint === fingerprint)
    .map((row) => ({ ...row, attempts: row.paymentAttempts }))
  const classes = classifySiblings({ owner, scope: scopeOf(owner), orders: siblings })
  assert.equal(classes.some((entry) => entry.holdsPage), false, 'premise: no page holds the cart')
  const reusable = classes.filter((entry) => entry.kind === 'unpaid' && entry.totalCents === request.total && entry.createdAtMs > now - request.windowMs).map((entry) => entry.orderId).sort()
  assert.deepEqual(reusable, today, 'the planner\'s idea of "the same purchase" and the duplicate search of createPendingCardOrder differ')
  assert.ok(today.length >= 9 && today.length < specs.length / 10, `${today.length} of ${specs.length} orders match: the matrix is vacuous or matches everything`)
  // and the decision reuses the newest of exactly those
  const decision = planOwnerIntent({ owner, requestTotalCents: request.total, confirmRepeat: false, now, windows: { duplicateMs: request.windowMs, repeatMs: 60 * MIN }, orders: siblings, listIsComplete: true })
  const newest = today.map((id) => rows.find((row) => row.id === id) as (typeof rows)[number]).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1))[0]
  assert.deepEqual(decision, { kind: 'reuse', orderId: newest.id })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// (added with the correction of P1 after the independent audit, defect A)
test('4. who is handed an order back: the planner continues EXACTLY the orders today\'s duplicate search can return for this browser (its own session, or an id its cookie opens) - never one known only by lineage', async () => {
  await resetDb()
  const prisma = await db()
  const now = Date.now()
  const fingerprint = 'f'.repeat(64)
  // unpaid card orders of the same cart and total, all recent, none with a page; four of each: session A, session B, session C, no session at all
  const specs: Array<{ id: string; hash: string | null; ageMin: number }> = []
  for (const [tag, hash] of [['a', HASH_A], ['b', HASH_B], ['c', HASH_C], ['n', null]] as Array<[string, string | null]>) for (const copy of [0, 1, 2, 3]) {
    // (the orders of B are the NEWEST: if a lineage could be handed back, one of them would be)
    specs.push({ id: `q_${tag}${copy}`, hash, ageMin: (tag === 'b' ? 1 : 20) + copy + specs.length })
  }
  await prisma.printOrder.createMany({
    data: specs.map((spec) => ({
      id: spec.id, ...base(new Date(now - spec.ageMin * MIN)), status: 'awaiting_payment', paymentStatus: 'pending', checkoutKey: nextKey(), guestSessionHash: spec.hash,
      metadata: { source: 'stripe_checkout', checkout: { version: 1, cartFingerprint: CART, fingerprint } },
    })),
  })
  // the request: the session is A; its access cookie opens ONE order of B and ONE order without a session. The other orders of B are the same browser at an earlier session: lineage.
  const guestIds = ['q_b3', 'q_n2']
  const session = HASH_A
  const everyId = specs.map((spec) => spec.id)
  // today's search (lib/checkout-orders.ts, the guest branch of createPendingCardOrder): whose order it may be
  const todayWhere = {
    id: { in: everyId }, userId: null, status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', totalCents: 5000, createdAt: { gt: new Date(now - 60 * MIN) },
    AND: [{ OR: [{ metadata: { path: ['checkout', 'fingerprint'], equals: fingerprint } }] }, { OR: [{ guestSessionHash: session }, { id: { in: guestIds } }] }],
  }
  const today = (await prisma.printOrder.findMany({ where: todayWhere, select: { id: true } })).map((row) => row.id).sort()
  const todayFirst = await prisma.printOrder.findFirst({ where: todayWhere, orderBy: { createdAt: 'desc' }, select: { id: true } })
  // the planner, on the same rows
  const rows = await prisma.printOrder.findMany({
    where: { id: { in: everyId } },
    select: { id: true, orderNumber: true, userId: true, guestSessionHash: true, paymentMethod: true, status: true, paymentStatus: true, paymentReviewReason: true, stripePaymentIntentId: true, totalCents: true, refundedCents: true, paidAt: true, createdAt: true, paymentAttempts: { select: { id: true, status: true, stripeSessionId: true, failureReason: true, stripePaymentIntentId: true } } },
  })
  const opened = rows.filter((row) => guestIds.includes(row.id)).map((row) => ({ id: row.id, guestSessionHash: row.guestSessionHash }))
  assert.equal(opened.length, 2)
  const owner: OwnerEvidence = { kind: 'guest', sessionHash: session, verifiedOrders: opened }
  const siblings: SiblingOrder[] = rows.map((row) => ({ ...row, attempts: row.paymentAttempts }))
  const proofs = new Map(siblings.map((row) => [row.id, proofOf(row, owner)]))
  const handedBack = siblings.filter((row) => proofAllowsReuse(proofs.get(row.id) ?? null)).map((row) => row.id).sort()
  assert.deepEqual(handedBack, today, 'the orders the planner may hand back and the orders today\'s search can return differ')
  assert.deepEqual(today, ['q_a0', 'q_a1', 'q_a2', 'q_a3', 'q_b3', 'q_n2'])
  // the orders of B the cookie does not open are known - by lineage - and are NOT among them; the orders of C and the other hashless ones are nobody's here
  const lineage = siblings.filter((row) => proofs.get(row.id) === 'lineage').map((row) => row.id).sort()
  assert.deepEqual(lineage, ['q_b0', 'q_b1', 'q_b2'])
  assert.equal(lineage.some((id) => today.includes(id)), false)
  assert.deepEqual(siblings.filter((row) => proofs.get(row.id) === null).map((row) => row.id).sort(), ['q_c0', 'q_c1', 'q_c2', 'q_c3', 'q_n0', 'q_n1', 'q_n3'])
  // the decision: the newest order today's search would return - although three lineage orders are newer
  const input = { owner, requestTotalCents: 5000, confirmRepeat: false, now, windows: { duplicateMs: 60 * MIN, repeatMs: 60 * MIN }, listIsComplete: true }
  assert.ok(todayFirst)
  assert.deepEqual(planOwnerIntent({ ...input, orders: siblings }), { kind: 'reuse', orderId: todayFirst.id })
  const newestOfAll = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]
  assert.equal(proofs.get(newestOfAll.id), 'lineage', 'premise: the newest order of all is a lineage one')
  // with only the lineage orders there, nothing is handed back: today's search finds nothing either, and a new order is made
  const onlyLineage = siblings.filter((row) => lineage.includes(row.id))
  assert.equal(await prisma.printOrder.count({ where: { ...todayWhere, id: { in: lineage } } }), 0)
  assert.deepEqual(planOwnerIntent({ ...input, orders: onlyLineage }), { kind: 'create', repeatOf: [] })
})
