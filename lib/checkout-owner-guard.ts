// R1-3 / KLOSS, P2 - the ONE door between the checkout and the pure rules of lib/owner-intent.ts: "what may a new checkout of this cart do, given what the same owner already has for it".
//
// CHECKOUT_OWNER_GUARD = off | shadow | on (anything else, or nothing: off).
//   off     nothing of this file runs. The checkout is what it was.
//   shadow  the decisions are computed and COUNTED (metrics, one log line), outside every transaction, without one more lock, and nothing is done with them: no request is held, no provider
//           is asked, no page is touched.
//   on      the decisions are applied (NOT authorised outside local tests with the isolated database and the stand-in for the provider, until the owner says so).
//
// What "on" adds, and where:
//   * S2, the transaction that makes an order (lib/checkout-orders.ts): the names of the owner-and-cart locks are ADDED to the ones it already takes and sorted with them; the proofs of the request
//     are read AGAIN under the locks; the owner's other orders of the cart - of EVERY state - are read, and planOwnerIntent decides: the order to continue, a hold, or a new order.
//   * S3, the transaction that is about to GIVE a payment page of an order (lib/checkout-sessions.ts) - a new reservation, a reservation sent again, or the page the order already has, however the
//     order was found (its key, the binding of a purchase key, the order to continue, the winner of a race): the same locks first, then the row of the order, then arbitratePage.
//   * A hold is one answer (409 PAYMENT_IN_PROGRESS, the body of the hold the checkout already has for a payment in doubt); an order is named only to who proves it with the access cookie or the
//     account. NOTHING is written by a hold.
//   * AFTER a hold, outside every transaction and through what already exists: the pages of an order that can NOT be paid any more (cancelled, paid...) and were never shown closed are closed at
//     the provider with proof (closePagesSoon: by construction it never touches an order that can still be paid), and the open page of an order that can still be paid is ASKED about, never
//     closed (the payment sync writes what the provider says). The NEXT request finds what was proved. A provider that can not be asked changes nothing: the hold stays.
// Nothing here calls the provider inside a transaction, and nothing here takes time, or the state of an order, as a proof that a page is closed.
//
// THE LIMIT E2 IS NOT CLOSED: a request that proves less than an earlier request of the same browser did (the old session alone, after the new session made an order) can not see that order - the
// link is stored nowhere. See lib/owner-intent.ts.
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { parseGuestAccessCookieList, verifyGuestAccess } from '@/lib/guest-order-access'
import { closePagesSoon, hasLivePageOfUnpayableOrder, refreshPageSoon } from '@/lib/checkout-pages'
import { JOIN_WINDOW_MS } from '@/lib/checkout-session-plan'
import { incrementMetric } from '@/lib/observability-metrics'
import { logEvent } from '@/lib/observability-logger'
import {
  allLockNames, arbitratePage, ownerLockNames, planOwnerIntent, publicResponseFor, reservationScope, scopeOf,
  HOLD_CODE, HOLD_MESSAGE,
  type Holder, type HoldCause, type OwnerEvidence, type OwnerIntentDecision, type OwnerScope, type PublicResponse, type ReservationVerdict, type SiblingOrder,
} from '@/lib/owner-intent'

type Db = typeof prisma | Prisma.TransactionClient

// ---- the flag ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type OwnerGuardMode = 'off' | 'shadow' | 'on'
export function ownerGuardMode(): OwnerGuardMode {
  const raw = (process.env.CHECKOUT_OWNER_GUARD ?? '').trim().toLowerCase()
  return raw === 'on' || raw === 'shadow' ? raw : 'off'
}

// At most this many orders of one owner and one cart are read (every state: they add up over the years). One more than that and the list is "not whole": nothing is given (a hold), and it is counted.
export const SIBLING_LIMIT = 200
// Test seams, null in production (the same kind as checkoutOrderHooks / checkoutSessionHooks): `siblingLimit` lets a test reach "the list was cut" with three orders instead of two hundred.
export const ownerGuardHooks: { siblingLimit: number | null } = { siblingLimit: null }

// ---- who is asking, as the route has verified it; and what that proves NOW ----------------------------------------------------------------------------------------------------------------
// (the access cookie is carried as it came: what it opens is decided against the database every time it is needed - under the locks, when there are locks)
export type OwnerClaim = { kind: 'account'; userId: string } | { kind: 'guest'; sessionHash: string; accessCookie: string | null }

// The orders a guest's access cookie really opens, each with the session hash it carries: the same check as verifiedGuestOrderIds (lib/checkout-orders.ts) - every entry against the hash and the
// expiry stored on its order, an order of an account never - read through `db`, so that it can be asked again inside a transaction. tests/security/kloss-guard-arbiter.sec.ts proves the two agree.
export async function verifiedGuestOrders(cookieValue: string | null | undefined, now: Date = new Date(), db: Db = prisma): Promise<Array<{ id: string; guestSessionHash: string | null }>> {
  const entries = parseGuestAccessCookieList(cookieValue)
  if (entries.length === 0) return []
  const rows = await db.printOrder.findMany({
    where: { id: { in: entries.map((entry) => entry.orderId) }, userId: null },
    select: { id: true, userId: true, guestAccessTokenHash: true, guestAccessExpiresAt: true, guestSessionHash: true },
  })
  const tokenOf = new Map(entries.map((entry) => [entry.orderId, entry.token]))
  return rows.filter((row) => verifyGuestAccess(row, tokenOf.get(row.id), now)).map((row) => ({ id: row.id, guestSessionHash: row.guestSessionHash || null }))
}

export async function ownerEvidenceOf(claim: OwnerClaim, db: Db = prisma, now: Date = new Date()): Promise<OwnerEvidence> {
  if (claim.kind === 'account') return { kind: 'account', userId: claim.userId }
  return { kind: 'guest', sessionHash: claim.sessionHash, verifiedOrders: await verifiedGuestOrders(claim.accessCookie, now, db) }
}

// ---- the owner's other orders of the cart ----------------------------------------------------------------------------------------------------------------------------------------------------
// The query that repeats orderInScope (tests/security/owner-intent-equivalence.sec.ts proves the two pick the same orders): an account's orders by `userId`; a guest's by a hash the request
// proves or an id its cookie opens - and only orders of no account. Null: the scope proves nothing, there is nothing to read.
export function scopeWhere(scope: OwnerScope): Prisma.PrintOrderWhereInput | null {
  const either: Prisma.PrintOrderWhereInput[] = []
  if (scope.userId !== null) either.push({ userId: scope.userId })
  const guest: Prisma.PrintOrderWhereInput[] = []
  if (scope.hashes.length > 0) guest.push({ guestSessionHash: { in: [...scope.hashes] } })
  if (scope.orderIds.length > 0) guest.push({ id: { in: [...scope.orderIds] } })
  if (guest.length > 0) either.push({ userId: null, OR: guest })
  return either.length > 0 ? { OR: either } : null
}

const SIBLING_SELECT = {
  id: true, orderNumber: true, userId: true, guestSessionHash: true, paymentMethod: true, status: true, paymentStatus: true, paymentReviewReason: true, stripePaymentIntentId: true,
  totalCents: true, refundedCents: true, paidAt: true, createdAt: true,
  paymentAttempts: { select: { id: true, status: true, stripeSessionId: true, failureReason: true, stripePaymentIntentId: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.PrintOrderSelect

const uniqueCarts = (carts: ReadonlyArray<string | null | undefined>) => [...new Set(carts.filter((value): value is string => typeof value === 'string' && value.length > 0))]

// EVERY state (unpaid, paid, cancelled, under review): the state of an order says nothing about its pages. Only the columns the rules need, and the attempts.
export async function readSiblings(db: Db, scope: OwnerScope, carts: ReadonlyArray<string | null | undefined>): Promise<{ orders: SiblingOrder[]; complete: boolean }> {
  const where = scopeWhere(scope)
  const fingerprints = uniqueCarts(carts)
  if (!where || fingerprints.length === 0) return { orders: [], complete: true }
  const limit = ownerGuardHooks.siblingLimit ?? SIBLING_LIMIT
  const rows = await db.printOrder.findMany({
    where: { paymentMethod: 'card', AND: [where, { OR: fingerprints.map((value) => ({ metadata: { path: ['checkout', 'cartFingerprint'], equals: value } })) }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: SIBLING_SELECT,
  })
  return { orders: rows.slice(0, limit).map(({ paymentAttempts, ...order }) => ({ ...order, attempts: paymentAttempts })), complete: rows.length <= limit }
}

// ---- a hold ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What may be done AFTER a hold, outside every transaction, to learn what the provider knows: `close` - the pages of an order that can not be paid any more; `ask` - the open page of an order
// that can still be paid (asked about, never closed).
export type RecoveryTarget = { kind: 'close'; orderId: string } | { kind: 'ask'; orderId: string; attemptId: string; sessionId: string }
export type OwnerHold = { stage: 'order' | 'page'; cause: HoldCause | 'locks'; response: PublicResponse; recover: RecoveryTarget[] }

export class OwnerHoldError extends Error {
  readonly hold: OwnerHold
  constructor(hold: OwnerHold) {
    super('Another order of this cart holds the payment.')
    this.name = 'OwnerHoldError'
    this.hold = hold
  }
}

// The proofs read under the locks need a lock that is not held (an order lost its session hash between the two reads, for one): the transaction is rolled back and run again with both sets.
export class OwnerLocksChanged extends Error {
  readonly names: string[]
  constructor(names: string[]) {
    super('The owner locks changed while they were being taken.')
    this.name = 'OwnerLocksChanged'
    this.names = names
  }
}

// the one coarse answer, with nothing named: what is said when nothing may be said
const coarseHold = (): PublicResponse => ({ status: 409, code: HOLD_CODE, message: HOLD_MESSAGE, extra: {} })
export const lockHold = (stage: OwnerHold['stage']): OwnerHold => ({ stage, cause: 'locks', response: coarseHold(), recover: [] })

function recoveryTargets(holders: ReadonlyArray<Holder>, orders: ReadonlyArray<SiblingOrder>): RecoveryTarget[] {
  const out: RecoveryTarget[] = []
  for (const holder of holders) {
    const order = orders.find((row) => row.id === holder.orderId)
    if (!order || holder.inDoubt) continue   // (a payment in doubt is asked about by the checkout itself, before it gets here)
    if (hasLivePageOfUnpayableOrder(order, order.attempts.map((attempt) => ({ id: attempt.id, status: attempt.status, stripeSessionId: attempt.stripeSessionId, failureReason: attempt.failureReason ?? null })))) {
      out.push({ kind: 'close', orderId: order.id })
      continue
    }
    const open = order.attempts.find((attempt) => attempt.status === 'open' && attempt.stripeSessionId)
    if (order.status === 'awaiting_payment' && open?.stripeSessionId) out.push({ kind: 'ask', orderId: order.id, attemptId: open.id, sessionId: open.stripeSessionId })
  }
  return out.slice(0, 3)
}

function holdOf(stage: OwnerHold['stage'], decision: Extract<OwnerIntentDecision, { kind: 'hold' }> | Extract<ReservationVerdict, { kind: 'hold' }>, evidence: OwnerEvidence | null, orders: ReadonlyArray<SiblingOrder>): OwnerHold {
  // (a call with no request has nobody to tell: the coarse answer)
  const response = evidence === null ? coarseHold() : publicResponseFor(decision, evidence) ?? coarseHold()
  return { stage, cause: decision.cause, response, recover: recoveryTargets(decision.holders, orders) }
}

// ---- S2: before an order is made --------------------------------------------------------------------------------------------------------------------------------------------------------
export type OwnerIntentOutcome = { kind: 'create' } | { kind: 'reuse'; orderId: string } | { kind: 'hold'; hold: OwnerHold }

// (the repeat gate - D3 - is P3: `repeatMs: 0` switches it off, so the planner never asks a confirmation here)
export async function decideOwnerIntent(db: Db, input: { evidence: OwnerEvidence; carts: ReadonlyArray<string | null | undefined>; requestTotalCents: number; duplicateMs: number; now?: number }): Promise<OwnerIntentOutcome> {
  const { orders, complete } = await readSiblings(db, scopeOf(input.evidence), input.carts)
  if (!complete) incrementMetric('checkout_owner_guard_incomplete_total', 1, { stage: 'order' })
  const decision = planOwnerIntent({
    owner: input.evidence, requestTotalCents: input.requestTotalCents, confirmRepeat: false, now: input.now ?? Date.now(),
    windows: { duplicateMs: input.duplicateMs, repeatMs: 0, reservingMs: JOIN_WINDOW_MS }, orders, listIsComplete: complete,
  })
  if (decision.kind === 'create') return { kind: 'create' }
  if (decision.kind === 'reuse') return { kind: 'reuse', orderId: decision.orderId }
  if (decision.kind === 'hold') return { kind: 'hold', hold: holdOf('order', decision, input.evidence, orders) }
  // (a confirmation can not be asked with the gate off; if it ever were, nothing is given)
  return { kind: 'hold', hold: lockHold('order') }
}

// The names of the owner locks a request needs for a cart: one per identity it proves (lib/owner-intent.ts, ownerLockNames).
export const ownerLocksOf = (evidence: OwnerEvidence, cartFingerprint: string): string[] => ownerLockNames(scopeOf(evidence), cartFingerprint)
export { allLockNames }

// ---- S3: before a page of an order is given ----------------------------------------------------------------------------------------------------------------------------------------------
type PageOrder = { id: string; userId: string | null; guestSessionHash: string | null; metadata: unknown }
const storedCart = (order: Pick<PageOrder, 'metadata'>): string | null => {
  const checkout = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? (order.metadata as Record<string, unknown>).checkout : null
  const value = checkout && typeof checkout === 'object' && !Array.isArray(checkout) ? (checkout as Record<string, unknown>).cartFingerprint : null
  return typeof value === 'string' && value.length > 0 ? value : null
}

// The cart the locks are named by: the one the REQUEST computed (the same value S2 names its locks by), or - for a call with no request - the one stored on the order. Null: the order carries no
// cart at all (not an order of this checkout): there is nothing to name a lock by, and nothing to look for.
const lockCartOf = (order: Pick<PageOrder, 'metadata'>, carts: ReadonlyArray<string | null | undefined>): string | null => uniqueCarts(carts)[0] ?? storedCart(order)

// What the request proves, joined with what the order's own columns say: never less than the columns (lib/owner-intent.ts, reservationScope).
export async function pageLocksOf(db: Db, input: { order: PageOrder; claim: OwnerClaim | null; carts: ReadonlyArray<string | null | undefined> }): Promise<string[]> {
  const cart = lockCartOf(input.order, input.carts)
  if (!cart) return []
  const evidence = input.claim ? await ownerEvidenceOf(input.claim, db) : null
  return ownerLockNames(reservationScope(evidence, input.order), cart)
}

// Asked INSIDE the transaction that is about to give a page, after the locks in `held` and the row of the order were taken. Throws OwnerLocksChanged if what is proved NOW needs a lock that is
// not held; returns the hold, or null when the page may be given.
export async function arbitrateOwnerPage(tx: Db, input: { order: PageOrder; claim: OwnerClaim | null; carts: ReadonlyArray<string | null | undefined>; held: ReadonlyArray<string> | null }): Promise<OwnerHold | null> {
  const cart = lockCartOf(input.order, input.carts)
  if (!cart) return null
  const evidence = input.claim ? await ownerEvidenceOf(input.claim, tx) : null
  const scope = reservationScope(evidence, input.order)
  if (input.held !== null) {
    const needed = ownerLockNames(scope, cart)
    if (needed.some((name) => !input.held?.includes(name))) throw new OwnerLocksChanged(needed)
  }
  const { orders, complete } = await readSiblings(tx, scope, [...input.carts, storedCart(input.order)])
  if (!complete) incrementMetric('checkout_owner_guard_incomplete_total', 1, { stage: 'page' })
  const verdict = arbitratePage({ owner: evidence, order: { id: input.order.id, userId: input.order.userId, guestSessionHash: input.order.guestSessionHash || null }, orders, listIsComplete: complete })
  return verdict.kind === 'hold' ? holdOf('page', verdict, evidence, orders) : null
}

// ---- after a hold (on only; outside every transaction) ------------------------------------------------------------------------------------------------------------------------------------
// The two limiters are the ones the status page already uses (lib/checkout-api.ts: once every few seconds per order, and a cap for the whole shop); they are handed in by the route so that this
// file - which the checkout's libraries load - does not load the route's helpers.
export async function recoverAfterHold(hold: OwnerHold, limits: { allowClose: (orderId: string) => Promise<boolean>; allowAsk: (orderId: string) => Promise<boolean> }): Promise<void> {
  if (ownerGuardMode() !== 'on') return
  for (const target of hold.recover) {
    try {
      if (target.kind === 'close') {
        if (await limits.allowClose(target.orderId)) { incrementMetric('checkout_owner_guard_recovery_total', 1, { kind: 'close' }); closePagesSoon(target.orderId) }
      } else if (await limits.allowAsk(target.orderId)) {
        incrementMetric('checkout_owner_guard_recovery_total', 1, { kind: 'ask' })
        refreshPageSoon({ orderId: target.orderId, attemptId: target.attemptId, sessionId: target.sessionId })
      }
    } catch (error) {
      // (a limiter that can not be asked: nothing is started, the hold stays what it is)
      logEvent({ event: 'checkout.owner_guard', level: 'warn', outcome: 'recovery_not_started', orderId: target.orderId, message: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

export function countHold(hold: OwnerHold): void {
  incrementMetric('checkout_owner_guard_held_total', 1, { stage: hold.stage, cause: hold.cause })
  logEvent({ event: 'checkout.owner_guard', level: 'info', outcome: 'held', stage: hold.stage, cause: hold.cause, named: 'orderId' in hold.response.extra })
}

// ---- shadow: computed, counted, never applied -------------------------------------------------------------------------------------------------------------------------------------------------
// Outside every transaction, with no lock, reading only; whatever goes wrong here is swallowed and counted - a shadow can not fail a request.
export async function shadowOwnerIntent(input: { claim: OwnerClaim; carts: ReadonlyArray<string | null | undefined>; requestTotalCents: number; duplicateMs: number }): Promise<void> {
  try {
    const outcome = await decideOwnerIntent(prisma, { evidence: await ownerEvidenceOf(input.claim), carts: input.carts, requestTotalCents: input.requestTotalCents, duplicateMs: input.duplicateMs })
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'order', decision: outcome.kind, cause: outcome.kind === 'hold' ? outcome.hold.cause : 'none' })
  } catch {
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'order', decision: 'error', cause: 'none' })
  }
}
export async function shadowOwnerPage(input: { orderId: string; claim: OwnerClaim | null; carts: ReadonlyArray<string | null | undefined> }): Promise<void> {
  try {
    const order = await prisma.printOrder.findUnique({ where: { id: input.orderId }, select: { id: true, userId: true, guestSessionHash: true, metadata: true } })
    if (!order) return
    const hold = await arbitrateOwnerPage(prisma, { order, claim: input.claim, carts: input.carts, held: null })
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'page', decision: hold ? 'hold' : 'proceed', cause: hold ? hold.cause : 'none' })
  } catch {
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'page', decision: 'error', cause: 'none' })
  }
}
