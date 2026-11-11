// R1-3 / KLOSS, P1 - the pure rules of lib/owner-intent.ts say the same as the database, on real rows of the isolated PostgreSQL (fake data, throw-away database).
//
// The pure module can not call the database, so three of its rules are written twice: once as a function over facts already read, once as the query that will read them. Here they are run
// side by side over a matrix of real orders, and must pick EXACTLY the same orders:
//   1. isInDoubt            = PAYMENT_IN_DOUBT_WHERE (and its SQL twin): the one definition of "a payment in doubt" the guard against paying twice already uses (lib/payment-in-doubt.ts);
//   2. orderInScope         = the query P2 uses to find the siblings of an owner (lib/checkout-owner-guard.ts, scopeWhere - the production query itself): an account's orders by `userId`, a guest's by a
//                             proved hash or a verified id - and only orders of no account;
//   3. the reuse rule       = today's duplicate search in createPendingCardOrder (unpaid, card, same total, made less than an hour ago, same fingerprint, this browser's) - the planner reuses
//                             EXACTLY those orders when no page holds the cart, and in addition the ones whose page is still alive (D2, intended).
//   4. who is handed back   = the ownership half of that same search (the browser's own session, or an id its access cookie opens): proofAllowsReuse says yes for EXACTLY those orders, and no
//                             for an order known only by lineage (the hash of an earlier session) - which may hold the cart but is never given.
//   5. readSiblings         = (hardening A) the query of the guard reads the RELEVANT card orders of the cart in the scope - of every state - and counts only them against its limit. Until A this
//                             test pinned that it read EVERY state, which is exactly the reading A replaces: it now pins the relevant ones (a declared change);
//   6. the relevance        = (hardening A) relevantSiblingSql keeps EVERY order the pure rule isRelevantSibling keeps, over rows written to be hard: NULLs, statuses in other spellings, closing
//                             proofs that only look like one, session ids of other shapes, PaymentIntents that are not the order's, instants on the edge of a window. It may keep more, only for the
//                             documented reasons; and the scope of the query (scopeSql) picks the same orders as scopeWhere (test 2).
//   7. the order of the read = (hardening A) the order of readSiblings is the query's OWN - the newest first, an instant shared by several orders broken by the id in byte order (COLLATE "C"),
//                             the limit cutting THAT order - whatever plan the database picks. Orders written at the SAME instant, in the opposite order: no scan gives them so without sorting.
//                             (Found by the mutant that drops the ORDER BY: with the index of A-idx the scan of a guest's scope - its "userId" IS NULL - can give the rows newest first by
//                             itself, and test 5 alone can no longer tell.)
// Nothing here changes behaviour: the module is not connected to the checkout.
import { db, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@prisma/client'
import { PAYMENT_IN_DOUBT_SQL, PAYMENT_IN_DOUBT_WHERE } from '../../lib/payment-in-doubt'
import { classifySiblings, isInDoubt, orderInScope, planOwnerIntent, proofAllowsReuse, proofOf, scopeOf, type OwnerEvidence, type OwnerScope, type SiblingOrder } from '../../lib/owner-intent'
import {
  isRelevantSibling, NOT_VERIFIED_PAYMENT_STATUSES, ownerGuardHooks, readSiblings, relevantSiblingSql, scopeSql, scopeWhere as productionScopeWhere, VERIFIED_PAYMENT_STATUSES, type SiblingRelevance,
} from '../../lib/checkout-owner-guard'
import { isSessionId, PROVEN_NOT_CREATED_PREFIXES } from '../../lib/checkout-session-plan'

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
// the query P2 runs to find the owner's other orders (lib/checkout-owner-guard.ts, scopeWhere): null for a scope that proves nothing
const scopeWhere = (scope: OwnerScope): Prisma.PrintOrderWhereInput => productionScopeWhere(scope) ?? { id: { in: [] } }

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
    // (hardening A) the same scope written for the query of readSiblings
    const inScope = scopeSql(scope)
    const bySql = inScope === null ? [] : (await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PrintOrder" WHERE "id" IN (${Prisma.join(everyId)}) AND ${inScope}`)).map((row) => row.id).sort()
    assert.deepEqual(bySql, byQuery, `${name}: scopeSql and scopeWhere pick different orders`)
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
  const decision = planOwnerIntent({ owner, requestTotalCents: request.total, confirmRepeat: false, now, windows: { duplicateMs: request.windowMs, repeatMs: 60 * MIN, reservingMs: 0 }, orders: siblings, listIsComplete: true })
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
  const input = { owner, requestTotalCents: 5000, confirmRepeat: false, now, windows: { duplicateMs: 60 * MIN, repeatMs: 60 * MIN, reservingMs: 0 }, listIsComplete: true }
  assert.ok(todayFirst)
  assert.deepEqual(planOwnerIntent({ ...input, orders: siblings }), { kind: 'reuse', orderId: todayFirst.id })
  const newestOfAll = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]
  assert.equal(proofs.get(newestOfAll.id), 'lineage', 'premise: the newest order of all is a lineage one')
  // with only the lineage orders there, nothing is handed back: today's search finds nothing either, and a new order is made
  const onlyLineage = siblings.filter((row) => lineage.includes(row.id))
  assert.equal(await prisma.printOrder.count({ where: { ...todayWhere, id: { in: lineage } } }), 0)
  assert.deepEqual(planOwnerIntent({ ...input, orders: onlyLineage }), { kind: 'create', repeatOf: [] })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// (added with P2: the function the checkout itself calls; rewritten with hardening A - it used to pin that EVERY state was read, which is the reading A replaces)
// the facts of an order as the guard reads them (SIBLING_SELECT)
const FACTS = {
  id: true, orderNumber: true, userId: true, guestSessionHash: true, paymentMethod: true, status: true, paymentStatus: true, paymentReviewReason: true, stripePaymentIntentId: true,
  totalCents: true, refundedCents: true, paidAt: true, createdAt: true, financialRevision: true,
  paymentAttempts: { select: { id: true, status: true, stripeSessionId: true, failureReason: true, stripePaymentIntentId: true, completedAt: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.PrintOrderSelect
async function factsOf(ids: string[]): Promise<SiblingOrder[]> {
  const rows = await (await db()).printOrder.findMany({ where: { id: { in: ids } }, select: FACTS })
  return rows.map(({ paymentAttempts, ...order }) => ({ ...order, attempts: paymentAttempts }))
}

test('5. readSiblings - the query of the guard - returns exactly the RELEVANT card orders of the cart that are in the scope, of every state, with all their attempts, the newest first; the limit counts the relevant ones only, and says when the list was cut', async () => {
  await resetDb()
  const prisma = await db()
  const now = Date.now()
  const otherCart = 'e'.repeat(64)
  // [status, payment status, paid that many minutes ago - or never written]
  const states: Array<[string, string, number | null]> = [
    ['awaiting_payment', 'pending', null], ['cancelled', 'canceled', null], ['queued', 'paid', 5], ['queued', 'paid', 300], ['queued', 'paid', null], ['awaiting_review', 'paid', 300],
    ['completed', 'paid', 300], ['awaiting_payment', 'processing', null], ['completed', 'refunded', 10],
  ]
  const specs: Array<{ id: string; hash: string | null; cart: string; method: string; status: string; paymentStatus: string; paidMin: number | null; ageMin: number; attempt: 'closed' | 'open' | null }> = []
  for (const [status, paymentStatus, paidMin] of states) for (const hash of [HASH_A, HASH_B, null]) for (const cart of [CART, otherCart]) for (const method of ['card', 'cash']) {
    const index = specs.length
    // (the age is a permutation of the index: the rows are not written in the order the query must give them)
    specs.push({ id: `rs_${index}`, hash, cart, method, status, paymentStatus, paidMin, ageMin: ((index * 37) % 108) + 1, attempt: index % 5 === 0 ? 'closed' : index % 5 === 1 ? 'open' : null })
  }
  assert.equal(new Set(specs.map((spec) => spec.ageMin)).size, specs.length, 'premise: every age once')
  await prisma.printOrder.createMany({
    data: specs.map((spec) => ({
      id: spec.id, ...base(new Date(now - spec.ageMin * MIN)), status: spec.status, paymentStatus: spec.paymentStatus, paymentMethod: spec.method, checkoutKey: nextKey(), guestSessionHash: spec.hash,
      paidAt: spec.paidMin === null ? null : new Date(now - spec.paidMin * MIN), metadata: { source: 'stripe_checkout', checkout: { version: 1, cartFingerprint: spec.cart, fingerprint: 'f'.repeat(64) } },
    })),
  })
  await prisma.paymentAttempt.createMany({
    data: specs.filter((spec) => spec.attempt !== null).map((spec) => ({
      orderId: spec.id, amountCents: 5000, currency: 'EUR', expiresAt: new Date(now + 30 * MIN), stripeSessionId: `cs_test_${spec.id}`,
      ...(spec.attempt === 'closed' ? { status: 'expired', failureReason: 'closed_by_us:x' } : { status: 'open' }),
    })),
  })
  // three orders of the cart that are no orders of this checkout's shape: never read
  await prisma.printOrder.createMany({
    data: [{ checkout: { cartFingerprint: 7 } }, { checkout: null }, null].map((metadata, index) => ({ id: `rs_odd_${index}`, ...base(new Date(now - MIN)), status: 'awaiting_payment', paymentStatus: 'pending', checkoutKey: nextKey(), guestSessionHash: HASH_A, ...(metadata === null ? {} : { metadata }) })),
  })
  const hashlessOpened = specs.find((spec) => spec.hash === null && spec.cart === CART && spec.method === 'card') as (typeof specs)[number]
  const evidences: OwnerEvidence[] = [
    { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [] },
    { kind: 'guest', sessionHash: HASH_B, verifiedOrders: [{ id: hashlessOpened.id, guestSessionHash: null }] },
    { kind: 'guest', sessionHash: HASH_C, verifiedOrders: [] },
    { kind: 'guest', sessionHash: null, verifiedOrders: [] },
  ]
  // the reuse window of an hour; the repeat gate not asking, then asking with its window of an hour
  const relevances: SiblingRelevance[] = [{ unpaidSince: now - 60 * MIN, verifiedSince: null }, { unpaidSince: now - 60 * MIN, verifiedSince: now - 60 * MIN }]
  const facts = await factsOf(specs.map((spec) => spec.id))
  const factOf = new Map(facts.map((fact) => [fact.id, fact]))
  for (const relevance of relevances) {
    for (const evidence of evidences) {
      const scope = scopeOf(evidence)
      const read = await readSiblings(prisma, scope, [CART, null, CART], relevance)
      const inScope = specs.filter((spec) => spec.cart === CART && spec.method === 'card' && orderInScope({ id: spec.id, userId: null, guestSessionHash: spec.hash }, scope))
      const expected = inScope.filter((spec) => isRelevantSibling(factOf.get(spec.id) as SiblingOrder, relevance)).sort((x, y) => x.ageMin - y.ageMin).map((spec) => spec.id)
      const label = JSON.stringify({ evidence, repeat: relevance.verifiedSince !== null })
      assert.deepEqual(read.orders.map((order) => order.id), expected, label)
      assert.equal(read.complete, true, label)
      // the attempts come with the orders - all of them
      assert.deepEqual(read.orders.map((order) => order.attempts.length), expected.map((id) => (specs.find((spec) => spec.id === id)?.attempt ? 1 : 0)), label)
      if (evidence === evidences[0]) {
        // not vacuous: some orders of the scope are left out, and the relevant ones are of several states and for each reason
        assert.ok(expected.length > 0 && expected.length < inScope.length, `${label}: ${expected.length} of ${inScope.length}`)
        const reasons = new Set(read.orders.map((order) => (isInDoubt(order, order.attempts) ? 'doubt' : order.attempts.some((attempt) => attempt.status === 'open') ? 'page' : order.paymentStatus === 'pending' ? 'unpaid' : 'paid')))
        assert.deepEqual([...reasons].sort(), relevance.verifiedSince === null ? ['doubt', 'page', 'unpaid'] : ['doubt', 'page', 'paid', 'unpaid'], label)
      }
    }
  }
  // no cart, or a scope that proves nothing: nothing is read, and that is a whole list
  assert.deepEqual(await readSiblings(prisma, scopeOf(evidences[0]), [null, ''], relevances[1]), { orders: [], complete: true })
  assert.deepEqual(await readSiblings(prisma, scopeOf(evidences[3]), [CART], relevances[1]), { orders: [], complete: true })
  // the limit counts the RELEVANT orders: the newest of them are kept and `complete` says so; exactly at their number the list is whole - however many other orders the scope has
  const relevant = (await readSiblings(prisma, scopeOf(evidences[0]), [CART], relevances[1])).orders.map((order) => order.id)
  const inScopeA = specs.filter((spec) => spec.cart === CART && spec.method === 'card' && spec.hash === HASH_A)
  assert.ok(relevant.length > 2 && inScopeA.length > relevant.length, `premise: ${relevant.length} relevant of ${inScopeA.length}`)
  ownerGuardHooks.siblingLimit = 2
  try {
    const cut = await readSiblings(prisma, scopeOf(evidences[0]), [CART], relevances[1])
    assert.deepEqual({ ids: cut.orders.map((order) => order.id), complete: cut.complete }, { ids: relevant.slice(0, 2), complete: false })
    ownerGuardHooks.siblingLimit = relevant.length
    assert.equal((await readSiblings(prisma, scopeOf(evidences[0]), [CART], relevances[1])).complete, true, 'exactly at the number of the relevant orders the list is whole')
    ownerGuardHooks.siblingLimit = relevant.length - 1
    assert.equal((await readSiblings(prisma, scopeOf(evidences[0]), [CART], relevances[1])).complete, false, 'one relevant order more than the limit: not whole')
  } finally { ownerGuardHooks.siblingLimit = null }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// (hardening A) the query never leaves out an order the pure rule keeps. A seeded generator, so that a failure can be run again.
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// what the query may keep beyond the pure rule - and nothing else: words the application does not write (a payment status in another spelling: the carrier of a payment and the window of a
// verified payment are recognised only by the exact words), an identifier of another shape on a closed row (it proves nothing to the query), and a verified payment whose `paidAt` is not
// written (the query can not date it by its page: it keeps it)
function whyKeptMore(order: SiblingOrder): string[] {
  const out: string[] = []
  if (![...VERIFIED_PAYMENT_STATUSES, ...NOT_VERIFIED_PAYMENT_STATUSES].includes(order.paymentStatus)) out.push('payment status in other words')
  if (order.attempts.some((attempt) => (attempt.stripeSessionId ?? '') !== '' && !isSessionId(attempt.stripeSessionId) && PROVEN_NOT_CREATED_PREFIXES.some((prefix) => (attempt.failureReason ?? '').startsWith(prefix)))) out.push('identifier of another shape')
  if (order.paidAt === null) out.push('verified payment not dated')
  return out
}

test('6. the relevance: relevantSiblingSql keeps EVERY order isRelevantSibling keeps - NULLs, other spellings, proofs that only look like one, session ids of other shapes, PaymentIntents that are not the order\'s, instants on the edge of the windows - and keeps more only for the documented reasons', async () => {
  await resetDb()
  const prisma = await db()
  const now = Date.now()
  const unpaidCut = now - 60 * MIN
  const verifiedCut = now - 60 * MIN
  const random = prng(20261111)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]
  const STATUSES = ['awaiting_payment', 'awaiting_payment', 'awaiting_review', 'queued', 'cancelled', 'completed', 'Awaiting_Payment', 'awaiting_payment ', '']
  const PAYMENT = ['pending', 'pending', 'processing', 'paid', 'paid', 'free', 'refunded', 'canceled', 'cancelled', 'failed', 'requires_capture', 'quote', 'succeeded', 'success', ' PAID ', 'Paid', 'paid\t', ' paid', 'unknown', 'partially_refunded', 'PENDING', '']
  const REVIEW = [null, null, null, null, '', 'amount']
  const CREATED = [now - MIN, unpaidCut + 1, unpaidCut, unpaidCut - 1, now - 180 * MIN, now + 5 * MIN]
  const PAID = [null, verifiedCut + 1, verifiedCut, verifiedCut - 1, now - 5 * MIN, now - 180 * MIN, now + 5 * MIN]
  const ATTEMPT = ['creating', 'open', 'processing', 'mismatch', 'paid', 'paid', 'paid', 'expired', 'expired', 'expired', 'failed', 'failed', 'canceled', 'OPEN', '', 'unknown']
  const SESSION = ['null', 'valid', 'valid', 'valid', 'newline', 'upper', 'dash', 'max', 'toolong', 'accent', 'arabic', 'fullwidth', 'prefix_only', 'empty']
  const REASON = [
    null, '', 'closed_by_us:x', 'closed_by_us:x', 'closedXbyXus:x', 'closed_by_us', 'provider_status:expired', 'provider_status:expired (session_mismatch:amount)', 'Provider_status:expired', 'provider_statusXexpired',
    'local_refusal:x', 'local_refusal:x', 'localXrefusal:x', 'provider_rejected:x', 'provider_rejected:x', 'stale_reservation', 'stale_reservation:x', ' closed_by_us:x', 'session_mismatch:x',
  ]
  const COMPLETED = [null, verifiedCut + 1, verifiedCut - 1, now - 180 * MIN]
  let n = 0
  const used = { emptySession: false, emptyIntent: false, prefixOnly: false, emptyOrderIntent: false }
  const sessionOf = (kind: string): string | null => {
    n += 1
    switch (kind) {
      case 'null': return null
      case 'valid': return `cs_test_${n}`
      case 'newline': return `cs_test_${n}\n`
      case 'upper': return `CS_test_${n}`
      case 'dash': return `cs_test-${n}`
      case 'max': return `cs_${String(n).padEnd(255, 'a')}`
      case 'toolong': return `cs_${String(n).padEnd(256, 'a')}`
      case 'accent': return `cs_tést_${n}`
      case 'arabic': return `cs_${n}٣`
      case 'fullwidth': return `cs_Ａ${n}`
      case 'prefix_only': if (used.prefixOnly) return `cs_test_${n}`; used.prefixOnly = true; return 'cs_'
      default: if (used.emptySession) return null; used.emptySession = true; return ''
    }
  }
  const orders: any[] = []
  const attempts: any[] = []
  // (two orders in five are written the way the application writes them - its own words, pages closed with proof or carrying the payment -, the others with anything at all)
  const CLEAN_STATUSES = ['awaiting_payment', 'queued', 'cancelled', 'completed']
  const CLEAN_PAYMENT = ['pending', 'paid', 'paid', 'canceled', 'refunded', 'failed', 'free']
  for (let i = 0; i < 1500; i++) {
    const id = `eq_${i}`
    const clean = random() < 0.4
    let orderIntent: string | null = clean || random() < 0.6 ? `pi_o_${i}` : null
    if (orderIntent === null && !used.emptyOrderIntent && random() < 0.05) { used.emptyOrderIntent = true; orderIntent = '' }
    const paidAt = pick(PAID)
    orders.push({
      id, ...base(new Date(pick(CREATED))), status: pick(clean ? CLEAN_STATUSES : STATUSES), paymentStatus: pick(clean ? CLEAN_PAYMENT : PAYMENT), paymentReviewReason: clean ? null : pick(REVIEW), checkoutKey: nextKey(),
      stripePaymentIntentId: orderIntent, paidAt: paidAt === null ? null : new Date(paidAt), guestSessionHash: HASH_A, metadata: { checkout: { cartFingerprint: CART } },
    })
    if (clean) {
      // its pages: closed with the provider's word, never created, or the one that carried its payment
      let carried = false
      for (let j = Math.floor(random() * 3); j > 0; j--) {
        const kind = pick(['closed', 'closed', 'refused', 'carrier'])
        const completedAt = pick(COMPLETED)
        const common = { orderId: id, amountCents: 5000, currency: 'EUR', expiresAt: new Date(now + 30 * MIN), createdAt: new Date(now - (10 + j) * MIN), completedAt: completedAt === null ? null : new Date(completedAt) }
        if (kind === 'carrier' && !carried) { carried = true; attempts.push({ ...common, status: 'paid', stripeSessionId: sessionOf('valid'), stripePaymentIntentId: orderIntent }) }
        else if (kind === 'refused') attempts.push({ ...common, status: 'failed', stripeSessionId: null, failureReason: pick(['local_refusal:x', 'provider_rejected:x']) })
        else attempts.push({ ...common, status: pick(['expired', 'failed']), stripeSessionId: sessionOf('valid'), failureReason: pick(['closed_by_us:x', 'provider_status:expired']) })
      }
      continue
    }
    let orderIntentUsed = false
    // (the schema allows ONE live page - a reservation or an open page - per order: migration 20261104130000_dr13_single_live_page)
    let livePage = false
    for (let j = Math.floor(random() * 4); j > 0; j--) {
      const intentKind = pick(['null', 'null', 'order', 'order', 'other', 'empty'])
      let intent: string | null = null
      if (intentKind === 'order' && orderIntent && !orderIntentUsed) { intent = orderIntent; orderIntentUsed = true }
      else if (intentKind === 'other') intent = `pi_a_${i}_${j}`
      else if (intentKind === 'empty' && !used.emptyIntent) { used.emptyIntent = true; intent = '' }
      const completedAt = pick(COMPLETED)
      let status = pick(ATTEMPT)
      if (status === 'creating' || status === 'open') { if (livePage) status = 'processing'; livePage = true }
      attempts.push({ orderId: id, amountCents: 5000, currency: 'EUR', status, stripeSessionId: sessionOf(pick(SESSION)), failureReason: pick(REASON), stripePaymentIntentId: intent, completedAt: completedAt === null ? null : new Date(completedAt), expiresAt: new Date(now + 30 * MIN), createdAt: new Date(now - (10 + j) * MIN) })
    }
  }
  await prisma.printOrder.createMany({ data: orders })
  await prisma.paymentAttempt.createMany({ data: attempts })
  const facts = await factsOf(orders.map((order) => order.id))
  assert.equal(facts.length, orders.length)
  const tally: Record<string, number> = {}
  for (const relevance of [{ unpaidSince: unpaidCut, verifiedSince: null }, { unpaidSince: unpaidCut, verifiedSince: verifiedCut }] as SiblingRelevance[]) {
    const bySql = new Set((await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PrintOrder" WHERE "id" LIKE 'eq\\_%' AND ${relevantSiblingSql(relevance)}`)).map((row) => row.id))
    const byPure = facts.filter((fact) => isRelevantSibling(fact, relevance))
    const label = relevance.verifiedSince === null ? 'repeat gate not asking' : 'repeat gate asking'
    // THE STOP CONDITION: an order the pure rule keeps and the query leaves out
    assert.deepEqual(byPure.filter((fact) => !bySql.has(fact.id)).map((fact) => fact.id), [], `${label}: the query leaves out orders the pure rule keeps`)
    // what the query keeps beyond the pure rule has a documented reason, every time
    const pure = new Set(byPure.map((fact) => fact.id))
    for (const fact of facts.filter((candidate) => bySql.has(candidate.id) && !pure.has(candidate.id))) {
      const why = whyKeptMore(fact)
      assert.ok(why.length > 0, `${label}: ${fact.id} is kept by the query for no documented reason: ${JSON.stringify(fact)}`)
      for (const reason of why) tally[`${label}: ${reason}`] = (tally[`${label}: ${reason}`] ?? 0) + 1
    }
    // not vacuous: both kinds in a good number, and the query does keep more where it must
    assert.ok(byPure.length > 300 && facts.length - bySql.size > 300, `${label}: ${byPure.length} relevant, ${facts.length - bySql.size} left out by the query`)
  }
  assert.ok(Object.keys(tally).length >= 3, JSON.stringify(tally))
  console.log(`relevance SQL kept more than the pure rule, by reason: ${JSON.stringify(tally)}`)
  // an instant the column can hold and a Date can not (+/- infinity): a verified payment dated so is kept, with the repeat gate asking
  await prisma.$executeRaw`INSERT INTO "PrintOrder" ("id", "orderNumber", "status", "paymentStatus", "paymentMethod", "subtotalCents", "totalCents", "currency", "paidAt", "createdAt", "updatedAt")
    VALUES ('inf_plus', 900001, 'queued', 'paid', 'card', 5000, 5000, 'EUR', 'infinity', now(), now()), ('inf_minus', 900002, 'queued', 'paid', 'card', 5000, 5000, 'EUR', '-infinity', now(), now())`
  const infinite = (await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PrintOrder" WHERE "id" LIKE 'inf\\_%' AND ${relevantSiblingSql({ unpaidSince: unpaidCut, verifiedSince: verifiedCut })}`)).map((row) => row.id).sort()
  assert.deepEqual(infinite, ['inf_minus', 'inf_plus'])
  await prisma.$executeRaw`DELETE FROM "PrintOrder" WHERE "id" LIKE 'inf\\_%'`
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('7. the order of readSiblings is the query\'s own: the newest first, an instant shared by several orders broken by the id in byte order, the limit cutting THAT order - for an account and for a guest, whatever plan the database picks (orders of one instant written in the opposite order)', async () => {
  await resetDb()
  const prisma = await db()
  const user = await prisma.user.create({ data: { email: 'oi-order@sectest.invalid', passwordHash: 'x', name: 'oi-order', role: 'customer' } })
  const now = Date.now()
  // three instants, written neither newest first nor oldest first; at each instant several orders, written in ASCENDING byte order of their ids - the query must give them in DESCENDING order.
  // Every scan gives orders of one instant in the order they were written (a sequential or bitmap scan: the order on disk; an index on "userId", "createdAt" or on "guestSessionHash": the
  // same, its ties kept in the order on disk; the primary key: ascending ids) - none gives them descending without the sort the query asks for.
  const instants = [5, 9, 2]
  const suffixes = ['A', 'B', 'Z', '_', 'a', 'z']
  assert.deepEqual([...suffixes].sort(), suffixes, 'premise: the suffixes are written in ascending byte order')
  const owners = [
    { label: 'account', evidence: { kind: 'account', userId: user.id } as OwnerEvidence, columns: { userId: user.id, guestSessionHash: null } },
    { label: 'guest', evidence: { kind: 'guest', sessionHash: HASH_A, verifiedOrders: [] } as OwnerEvidence, columns: { userId: null, guestSessionHash: HASH_A } },
  ]
  const specs = owners.flatMap((owner) => instants.flatMap((ageMin) => suffixes.map((suffix) => ({ id: `ord_${owner.label}_${ageMin}_${suffix}`, owner: owner.label, ageMin, columns: owner.columns }))))
  await prisma.printOrder.createMany({
    data: specs.map((spec) => ({
      id: spec.id, ...base(new Date(now - spec.ageMin * MIN)), status: 'awaiting_payment', paymentStatus: 'pending', checkoutKey: nextKey(), ...spec.columns,
      metadata: { source: 'stripe_checkout', checkout: { version: 1, cartFingerprint: CART, fingerprint: 'f'.repeat(64) } },
    })),
  })
  // (all of them relevant: unpaid card orders of the cart, made inside the window of the reuse)
  const relevance: SiblingRelevance = { unpaidSince: now - 60 * MIN, verifiedSince: null }
  for (const owner of owners) {
    const mine = specs.filter((spec) => spec.owner === owner.label)
    // the order the query asks for, computed here: the newest first, then the id in byte order, descending
    const expected = [...mine].sort((x, y) => x.ageMin - y.ageMin || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)).map((spec) => spec.id)
    const written = mine.map((spec) => spec.id)
    assert.notDeepEqual(written, expected, 'premise: the orders are not written in the order the query must give them')
    assert.notDeepEqual([...written].sort(), expected, 'premise: nor in the order of the primary key')
    const scope = scopeOf(owner.evidence)
    const whole = await readSiblings(prisma, scope, [CART], relevance)
    assert.deepEqual({ ids: whole.orders.map((order) => order.id), complete: whole.complete }, { ids: expected, complete: true }, `${owner.label}: the whole list, in the query's order`)
    // the limit keeps the FIRST of that order - however it is cut (an instant cut in its middle included) - and says the list is not whole
    try {
      for (let limit = 1; limit < expected.length; limit++) {
        ownerGuardHooks.siblingLimit = limit
        const cut = await readSiblings(prisma, scope, [CART], relevance)
        assert.deepEqual({ ids: cut.orders.map((order) => order.id), complete: cut.complete }, { ids: expected.slice(0, limit), complete: false }, `${owner.label}: cut at ${limit}`)
      }
    } finally { ownerGuardHooks.siblingLimit = null }
  }
})
