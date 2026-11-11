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
//
// P3 - CHECKOUT_REPEAT_GUARD = off | shadow | on (anything else, or nothing: off), EFFECTIVE ONLY WITH CHECKOUT_OWNER_GUARD=on (with the owner guard in shadow it can at most be counted, with it off
// it is off): the confirmation of a purchase of the same cart made again shortly after a verified payment of it (D3). Asked where P2 said "go on" - never instead of a hold - before an order is made
// (S2) and before a page of an order is given (S3), and only of a request that proves the paid orders with the access cookie or the account. The confirmation is bound to the CONTEXT the server
// proposed (repeatContextValue: `rc1_` and the SHA-256 of the canonical context - not a secret, not a signature, not a proof of a human gesture: it says which context the client was shown), and an
// order made or continued with it keeps an ACCEPTANCE (metadata.checkout.repeatAcceptance) that the next request checks, so that a retry is not asked again while the context is the same.
// What is read for it is the list of siblings P2 already reads under the owner locks. The orders of G are NOT locked: the writers of their money (lib/payment-sync.ts - a payment verified, a
// refund, a dispute -, lib/payment-hold.ts, the administrator's routes) lock the row of THEIR order, not the owner's locks, so G can change after it was read; it is read again at every decision
// (S2, then S3 before a reservation is written and again before a page is handed out), and nothing here claims more than that.
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { canonicalJson } from '@/lib/cart-canonical-core'
import { parseGuestAccessCookieList, verifyGuestAccess } from '@/lib/guest-order-access'
import { closePagesSoon, hasLivePageOfUnpayableOrder, refreshPageSoon } from '@/lib/checkout-pages'
import { JOIN_WINDOW_MS } from '@/lib/checkout-session-plan'
import { incrementMetric } from '@/lib/observability-metrics'
import { logEvent } from '@/lib/observability-logger'
import {
  allLockNames, arbitratePage, canonicalRepeatMembers, disclosureLevelOf, ownerLockNames, planOwnerIntent, proofOf, publicResponseFor, repeatContextOf, repeatGate, repeatSetOf, reservationScope, scopeOf,
  HOLD_CODE, HOLD_MESSAGE,
  type Holder, type HoldCause, type OwnerEvidence, type OwnerIntentDecision, type OwnerScope, type PublicResponse, type RepeatContext, type RepeatMember, type RepeatSubject, type ReservationVerdict,
  type SiblingOrder,
} from '@/lib/owner-intent'

type Db = typeof prisma | Prisma.TransactionClient
// (the checkout's own files reach the pure rules only through this door - a type included)
export type { OwnerEvidence }

// ---- the flag ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type OwnerGuardMode = 'off' | 'shadow' | 'on'
export function ownerGuardMode(): OwnerGuardMode {
  const raw = (process.env.CHECKOUT_OWNER_GUARD ?? '').trim().toLowerCase()
  return raw === 'on' || raw === 'shadow' ? raw : 'off'
}

// At most this many orders of one owner and one cart are read (every state: they add up over the years). One more than that and the list is "not whole": nothing is given (a hold), and it is counted.
export const SIBLING_LIMIT = 200
// Test seams, null in production (the same kind as checkoutOrderHooks / checkoutSessionHooks): `siblingLimit` lets a test reach "the list was cut" with three orders instead of two hundred;
// `afterSiblingsRead` (P3) runs inside the transaction right after the siblings were read - where a writer of the money of another order (a refund, a dispute) can change G after it was read.
export const ownerGuardHooks: { siblingLimit: number | null; afterSiblingsRead: null | ((stage: 'order' | 'page') => Promise<void>) } = { siblingLimit: null, afterSiblingsRead: null }

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

// (P3) the financial revision of every sibling and the `completedAt` of the attempts: a member of G enters the context of a confirmation with its revision, and a verified payment without `paidAt`
// is dated by the page that carried it (lib/owner-intent.ts, verifiedAtOf)
const SIBLING_SELECT = {
  id: true, orderNumber: true, userId: true, guestSessionHash: true, paymentMethod: true, status: true, paymentStatus: true, paymentReviewReason: true, stripePaymentIntentId: true,
  totalCents: true, refundedCents: true, paidAt: true, createdAt: true, financialRevision: true,
  paymentAttempts: { select: { id: true, status: true, stripeSessionId: true, failureReason: true, stripePaymentIntentId: true, completedAt: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
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
// `members` (P3): G - the paid orders of the cart the repeat gate asks about (lib/owner-intent.ts, repeatSetOf), read from the same list; empty unless a repeat window is given. The planner decides
// first, as in P2: a hold is a hold whatever G is; "create" with a non-empty G is the planner's confirmation (its `repeatMs` is the window), and "reuse" carries G for the gate of the order to continue.
export type OwnerIntentOutcome = { kind: 'create'; members: RepeatMember[] } | { kind: 'reuse'; orderId: string; members: RepeatMember[] } | { kind: 'hold'; hold: OwnerHold }

// (`repeatWindowMs` 0 - P2, and the repeat guard off - switches the confirmation off: the planner never asks one here)
export async function decideOwnerIntent(db: Db, input: { evidence: OwnerEvidence; carts: ReadonlyArray<string | null | undefined>; requestTotalCents: number; duplicateMs: number; repeatWindowMs?: number; now?: number }): Promise<OwnerIntentOutcome> {
  const scope = scopeOf(input.evidence)
  const { orders, complete } = await readSiblings(db, scope, input.carts)
  await ownerGuardHooks.afterSiblingsRead?.('order')
  if (!complete) incrementMetric('checkout_owner_guard_incomplete_total', 1, { stage: 'order' })
  const now = input.now ?? Date.now()
  const repeatMs = input.repeatWindowMs ?? 0
  const decision = planOwnerIntent({
    owner: input.evidence, requestTotalCents: input.requestTotalCents, confirmRepeat: false, now,
    windows: { duplicateMs: input.duplicateMs, repeatMs, reservingMs: JOIN_WINDOW_MS }, orders, listIsComplete: complete,
  })
  if (decision.kind === 'hold') return { kind: 'hold', hold: holdOf('order', decision, input.evidence, orders) }
  const members = repeatSetOf({ owner: input.evidence, scope, orders, now, windowMs: repeatMs })
  if (decision.kind === 'reuse') return { kind: 'reuse', orderId: decision.orderId, members }
  // "confirm" (G is not empty) and "create" (G is empty - tests/owner-intent.test.ts proves the two agree) are both a new order: whether it may be made is the gate's (judgeRepeatForNew)
  return { kind: 'create', members }
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
// not held; returns the hold, or null when the page may be given. (P2's arbiter alone: judgeOwnerPage with the repeat gate off.)
export async function arbitrateOwnerPage(tx: Db, input: { order: PageOrder; claim: OwnerClaim | null; carts: ReadonlyArray<string | null | undefined>; held: ReadonlyArray<string> | null }): Promise<OwnerHold | null> {
  const judged = await judgeOwnerPage(tx, { ...input, repeat: NO_REPEAT })
  return judged.kind === 'hold' ? judged.hold : null
}

// (P3) THE JUDGE OF THE PAGE: P2's arbiter first - a hold is a hold whatever the confirmation says - and then, where it says "go on", the repeat gate on the SAME list of siblings, read under the same
// locks: an acceptance that holds goes on; the value of this order's context goes on and is to be KEPT (recordRepeatAcceptance, in the same transaction); otherwise the customer is asked. A call with
// no request (no claim) has nobody to ask: the gate does not apply to it. `order` is the row read after the lock (its metadata, its revision, its lines - for its context).
export type PageJudgement = { kind: 'go' } | { kind: 'hold'; hold: OwnerHold } | { kind: 'record'; acceptance: AcceptanceRecord } | { kind: 'propose'; proposal: RepeatProposal; evidence: OwnerEvidence }
type JudgedOrder = PageOrder & Partial<Omit<SubjectOrder, keyof PageOrder>>
export async function judgeOwnerPage(tx: Db, input: { order: JudgedOrder; claim: OwnerClaim | null; carts: ReadonlyArray<string | null | undefined>; held: ReadonlyArray<string> | null; repeat: RepeatRequest }): Promise<PageJudgement> {
  const cart = lockCartOf(input.order, input.carts)
  if (!cart) return { kind: 'go' }
  const evidence = input.claim ? await ownerEvidenceOf(input.claim, tx) : null
  const scope = reservationScope(evidence, input.order)
  if (input.held !== null) {
    const needed = ownerLockNames(scope, cart)
    if (needed.some((name) => !input.held?.includes(name))) throw new OwnerLocksChanged(needed)
  }
  const { orders, complete } = await readSiblings(tx, scope, [...input.carts, storedCart(input.order)])
  await ownerGuardHooks.afterSiblingsRead?.('page')
  if (!complete) incrementMetric('checkout_owner_guard_incomplete_total', 1, { stage: 'page' })
  const verdict = arbitratePage({ owner: evidence, order: { id: input.order.id, userId: input.order.userId, guestSessionHash: input.order.guestSessionHash || null }, orders, listIsComplete: complete })
  if (verdict.kind === 'hold') return { kind: 'hold', hold: holdOf('page', verdict, evidence, orders) }
  if (evidence === null || input.repeat.mode === 'off') return { kind: 'go' }
  const subject = input.order as SubjectOrder
  if (typeof subject.financialRevision !== 'number' || !Array.isArray(subject.items)) throw new TypeError('The repeat gate of a page needs the order as it was read under its lock (its revision and its lines).')
  const now = Date.now()
  const members = repeatSetOf({ owner: evidence, scope, orders, excludeOrderId: input.order.id, now, windowMs: input.repeat.mode === 'on' ? REPEAT_CONFIRM_WINDOW_MS : REPEAT_SHADOW_WINDOW_MS })
  const judged = judgeRepeatForOrder({ evidence, members, order: subject, cart, repeat: input.repeat, stage: 'page', now })
  if (judged.kind === 'propose') return { kind: 'propose', proposal: judged.proposal, evidence }
  return judged
}

// (P3) The acceptance of a confirmed repeat purchase on an order that EXISTS is written by the transaction that gives the page (lib/checkout-sessions.ts, keepRepeatAcceptance): this file reads, it
// never writes an order.

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
// (P3) `repeat: 'shadow'`: the repeat gate is counted too (countRepeatShadow), over the wider window of the measure; the decision of P2 counted beside it is the same as without it.
export async function shadowOwnerIntent(input: { claim: OwnerClaim; carts: ReadonlyArray<string | null | undefined>; requestTotalCents: number; duplicateMs: number; repeat?: RepeatGuardMode }): Promise<void> {
  try {
    const repeatWindowMs = input.repeat === 'shadow' ? REPEAT_SHADOW_WINDOW_MS : 0
    const outcome = await decideOwnerIntent(prisma, { evidence: await ownerEvidenceOf(input.claim), carts: input.carts, requestTotalCents: input.requestTotalCents, duplicateMs: input.duplicateMs, repeatWindowMs })
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'order', decision: outcome.kind, cause: outcome.kind === 'hold' ? outcome.hold.cause : 'none' })
    if (repeatWindowMs > 0 && outcome.kind !== 'hold') countRepeatShadow('order', outcome.members)
  } catch {
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'order', decision: 'error', cause: 'none' })
  }
}
export async function shadowOwnerPage(input: { orderId: string; claim: OwnerClaim | null; carts: ReadonlyArray<string | null | undefined>; repeat?: RepeatGuardMode }): Promise<void> {
  try {
    const order = await prisma.printOrder.findUnique({ where: { id: input.orderId }, include: { items: { select: { totalCents: true } } } })
    if (!order) return
    // (P3) with the repeat gate in shadow too, it is counted on the same reading - its judgement is never acted on
    const judged = await judgeOwnerPage(prisma, { order, claim: input.claim, carts: input.carts, held: null, repeat: { mode: input.repeat === 'shadow' ? 'shadow' : 'off', value: null } })
    const hold = judged.kind === 'hold' ? judged.hold : null
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'page', decision: hold ? 'hold' : 'proceed', cause: hold ? hold.cause : 'none' })
  } catch {
    incrementMetric('checkout_owner_guard_shadow_total', 1, { stage: 'page', decision: 'error', cause: 'none' })
  }
}

// ======================================================================================================================================================================================================
// P3 - the confirmation of a repeat purchase (D3)
// ======================================================================================================================================================================================================
export type RepeatGuardMode = 'off' | 'shadow' | 'on'
// what the configuration asks for: anything but `shadow` or `on` (nothing at all included) is off
export function requestedRepeatGuardMode(): RepeatGuardMode {
  const raw = (process.env.CHECKOUT_REPEAT_GUARD ?? '').trim().toLowerCase()
  return raw === 'on' || raw === 'shadow' ? raw : 'off'
}
let inertWarned = false
// What applies: the gate asks only where P2's guard is applied (its locks and its holds come first). With the owner guard in shadow the gate can at most be counted; with it off the gate is off - and
// that is said once, in the log and a counter, when the configuration asks for more.
export function repeatGuardMode(owner: OwnerGuardMode = ownerGuardMode()): RepeatGuardMode {
  const asked = requestedRepeatGuardMode()
  if (owner === 'off') {
    if (asked !== 'off' && !inertWarned) {
      inertWarned = true
      incrementMetric('checkout_repeat_guard_inert_total', 1, { asked })
      logEvent({ event: 'checkout.repeat_guard', level: 'warn', outcome: 'inert', message: `CHECKOUT_REPEAT_GUARD=${asked} has no effect while CHECKOUT_OWNER_GUARD is off` })
    }
    return 'off'
  }
  if (owner === 'shadow') return asked === 'off' ? 'off' : 'shadow'
  return asked
}

// The window of the gate: a verified payment of the cart less than an hour old (verifiedAtOf). The measure of `shadow` looks at a day, to tell how often a wider window would ask.
export const REPEAT_CONFIRM_WINDOW_MS = 60 * 60 * 1000
export const REPEAT_SHADOW_WINDOW_MS = 24 * 60 * 60 * 1000
// The version of the format of the cart fingerprint the request computes (lib/checkout-orders.ts, cartFingerprint: `v: 2`): part of the context, so that a new format is a new context.
export const CART_FINGERPRINT_VERSION = 2
// The value of a context: `rc1_` and 64 lower-case hexadecimal digits.
export const REPEAT_CONTEXT_PATTERN = /^rc1_[0-9a-f]{64}$/

// ---- the value of a context, and of G ---------------------------------------------------------------------------------------------------------------------------------------------------------
// SHA-256 of the canonical JSON (lib/cart-canonical-core.ts, keys sorted), with a label of its own: the same context is the same value in every process, and nothing else is. It is NOT a secret and
// authenticates nothing; the server never acts on it except by comparing it with the value of the context it computes itself, under its locks.
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const digestOfCanonicalMembers = (g: ReadonlyArray<[string, number]>) => sha256(`mw:repeat-g:v1\n${canonicalJson(g)}`)
export const repeatMembersDigest = (members: ReadonlyArray<Pick<RepeatMember, 'orderId' | 'financialRevision'>>): string => digestOfCanonicalMembers(canonicalRepeatMembers(members))
export function repeatContextValue(context: RepeatContext): string {
  const body = { v: context.v, owner: context.owner, cart: context.cart, subject: context.subject, g: digestOfCanonicalMembers(context.g), n: context.n }
  return `rc1_${sha256(`mw:repeat-context:v1\n${canonicalJson(body)}`)}`
}

// ---- the subject of a confirmation --------------------------------------------------------------------------------------------------------------------------------------------------------------
// An order that is about to be made: the amounts of the quote it will be made from (the same snapshot createPendingCardOrder writes).
export function newOrderSubject(totals: { amount: number; currencyCode: string; itemsTotalCents: number; shippingAmountCents: number; taxCents: number }): RepeatSubject {
  return { kind: 'new', totalCents: totals.amount, currency: totals.currencyCode, itemsCents: totals.itemsTotalCents, shippingCents: totals.shippingAmountCents, taxCents: totals.taxCents }
}
// An order that exists: its frozen amounts and the financial revision it has NOW (any change of its money situation raises it - lib/financial-revision.ts).
export type SubjectOrder = { id: string; orderNumber: number; userId: string | null; guestSessionHash: string | null; financialRevision: number; totalCents: number; currency: string; shippingCents: number; taxCents: number; metadata: unknown; items: ReadonlyArray<{ totalCents: number }> }
export function existingOrderSubject(order: SubjectOrder): RepeatSubject {
  return {
    kind: 'order', orderId: order.id, financialRevision: order.financialRevision, totalCents: order.totalCents, currency: order.currency,
    itemsCents: order.items.reduce((sum, item) => sum + item.totalCents, 0), shippingCents: order.shippingCents, taxCents: order.taxCents,
  }
}

// ---- the acceptance an order keeps --------------------------------------------------------------------------------------------------------------------------------------------------------------
// In metadata.checkout, beside the fingerprints: `repeatOf` (the ids of G, the newest first - what the order repeats) and `repeatAcceptance` (G's digest and size, the financial revision of the order
// when it was accepted, the value that was confirmed, how G was proved, when). It HOLDS while G is the same set with the same revisions and the order still has that revision. Written only by a valid
// confirmation: for a new order in the INSERT that makes it (revision 0), for an order that exists by recordRepeatAcceptance, under the locks of the page.
export type RepeatAcceptance = { v: 1; g: string; n: number; rev: number; context: string; via: 'account' | 'access'; at: string }
const HEX64 = /^[0-9a-f]{64}$/
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
export function acceptanceOf(metadata: unknown): RepeatAcceptance | null {
  const raw = asObject(asObject(asObject(metadata).checkout).repeatAcceptance)
  const { v, g, n, rev, context, via, at } = raw
  if (v !== 1 || typeof g !== 'string' || !HEX64.test(g) || typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || typeof context !== 'string' || !REPEAT_CONTEXT_PATTERN.test(context)) return null
  if ((via !== 'account' && via !== 'access') || typeof at !== 'string') return null
  return { v, g, n, rev, context, via, at }
}
export function acceptanceHolds(acceptance: RepeatAcceptance | null, members: ReadonlyArray<RepeatMember>, financialRevision: number): boolean {
  return acceptance !== null && members.length > 0 && acceptance.n === members.length && acceptance.g === repeatMembersDigest(members) && acceptance.rev === financialRevision
}
export type AcceptanceRecord = { repeatOf: string[]; repeatAcceptance: RepeatAcceptance }
export function acceptanceRecord(input: { members: ReadonlyArray<RepeatMember>; rev: number; context: string; now?: Date }): AcceptanceRecord {
  return {
    repeatOf: input.members.map((member) => member.orderId),
    repeatAcceptance: { v: 1, g: repeatMembersDigest(input.members), n: input.members.length, rev: input.rev, context: input.context, via: input.members[0].proof, at: (input.now ?? new Date()).toISOString() },
  }
}
// the metadata with the acceptance written into its `checkout` block - everything else as it was
export function withAcceptance(metadata: unknown, record: AcceptanceRecord): Record<string, unknown> {
  const current = asObject(metadata)
  return { ...current, checkout: { ...asObject(current.checkout), repeatOf: record.repeatOf, repeatAcceptance: record.repeatAcceptance } }
}

// ---- the proposal --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the customer is asked: the newest paid order of G (named: G is made only of orders the request proves with the cookie or the account), how many there are, the value of the context - and,
// when the confirmation is about an order that ALREADY EXISTS (it was made a moment ago by this very request, or before), that an order waits for it: named only to a request that proves THAT order
// with the cookie or the account. A proposal writes nothing; where it follows a write of the same request (an order made, a key bound, by a confirmation that was valid then), `pendingOrder` says so.
export type RepeatProposal = { newest: RepeatMember; count: number; value: string; pending: { orderId: string; orderNumber: number; named: boolean } | null }
export class RepeatConfirmationRequired extends Error {
  readonly proposal: RepeatProposal
  readonly evidence: OwnerEvidence
  constructor(proposal: RepeatProposal, evidence: OwnerEvidence) {
    super('A purchase of this cart was paid a short while ago: the customer is asked to confirm a new one.')
    this.name = 'RepeatConfirmationRequired'
    this.proposal = proposal
    this.evidence = evidence
  }
}
export function repeatProposalResponse(proposal: RepeatProposal, evidence: OwnerEvidence): { status: 409; code: string; message: string; extra: Record<string, unknown> } {
  // (publicResponseFor throws if the order it names is not proved with the cookie or the account: an exception is safer than a word too many)
  const base = publicResponseFor({ kind: 'confirm', orderId: proposal.newest.orderId, orderNumber: proposal.newest.orderNumber, proof: proposal.newest.proof }, evidence)
  if (!base) throw new TypeError('A proposal always has an answer.')
  const pending = proposal.pending
  const extra: Record<string, unknown> = { ...base.extra, repeatCount: proposal.count, repeatContext: proposal.value }
  if (pending) {
    extra.pendingOrder = true
    if (pending.named) Object.assign(extra, { pendingOrderId: pending.orderId, pendingOrderNumber: pending.orderNumber })
  }
  return { status: 409, code: base.code, message: base.message, extra }
}

// ---- the gate, as each door asks it ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type RepeatRequest = { mode: RepeatGuardMode; value: string | null }
export const NO_REPEAT: RepeatRequest = { mode: 'off', value: null }
const ageBucket = (members: ReadonlyArray<RepeatMember>, now: number): string => {
  const newest = members.reduce<number | null>((latest, member) => (member.verifiedAtMs === null ? latest : latest === null ? member.verifiedAtMs : Math.max(latest, member.verifiedAtMs)), null)
  if (members.some((member) => member.verifiedAtMs === null)) return 'unknown'
  const age = now - (newest as number)
  return age < 5 * 60_000 ? 'lt5m' : age < 15 * 60_000 ? 'lt15m' : age < REPEAT_CONFIRM_WINDOW_MS ? 'lt60m' : '60m_24h'
}
// shadow: what the gate WOULD do, counted with the age of the newest payment (a payment of 1 to 24 hours ago is counted apart: the measure of a wider window; it would ask nothing today)
export function countRepeatShadow(stage: 'order' | 'page', members: ReadonlyArray<RepeatMember>, now: number = Date.now(), accepted = false): void {
  if (members.length === 0) { incrementMetric('checkout_repeat_guard_shadow_total', 1, { stage, decision: 'none', age: 'none' }); return }
  const bucket = ageBucket(members, now)
  incrementMetric('checkout_repeat_guard_shadow_total', 1, { stage, decision: bucket === '60m_24h' ? 'outside_window' : accepted ? 'would_accept' : 'would_propose', age: bucket })
}
// (a shadow reads G over a day, for its measure: the members of the gate's own hour, to tell whether an acceptance would hold. With the gate on, G was read with the hour itself, at the instant of the
// decision, and is taken as it is.)
const inWindow = (members: ReadonlyArray<RepeatMember>, now: number) => members.filter((member) => member.verifiedAtMs === null || member.verifiedAtMs > now - REPEAT_CONFIRM_WINDOW_MS)

export type NewOrderJudgement = { kind: 'go' } | { kind: 'create_with'; acceptance: AcceptanceRecord } | { kind: 'propose'; proposal: RepeatProposal }
// S2, a new order: with G, only the value of THIS context (the quote's amounts, the cart, G) lets it be made - and it is made with its acceptance.
export function judgeRepeatForNew(input: { evidence: OwnerEvidence; members: ReadonlyArray<RepeatMember>; totals: Parameters<typeof newOrderSubject>[0]; cart: string; repeat: RepeatRequest; now?: number }): NewOrderJudgement {
  const now = input.now ?? Date.now()
  if (input.repeat.mode === 'off') return { kind: 'go' }
  if (input.repeat.mode === 'shadow') { countRepeatShadow('order', input.members, now); return { kind: 'go' } }
  const members = input.members
  const value = members.length > 0 ? repeatContextValue(repeatContextOf({ owner: input.evidence, cart: { v: CART_FINGERPRINT_VERSION, fp: input.cart }, subject: newOrderSubject(input.totals), members })) : null
  const gate = repeatGate({ members, acceptanceHolds: false, valueMatches: value !== null && input.repeat.value === value })
  if (gate.kind === 'none') return { kind: 'go' }
  if (gate.kind === 'confirmed') {
    incrementMetric('checkout_repeat_guard_confirmed_total', 1, { stage: 'order', subject: 'new' })
    return { kind: 'create_with', acceptance: acceptanceRecord({ members, rev: 0, context: value as string }) }
  }
  return { kind: 'propose', proposal: { newest: members[0], count: members.length, value: value as string, pending: null } }
}

export type ExistingOrderJudgement = { kind: 'go' } | { kind: 'record'; acceptance: AcceptanceRecord } | { kind: 'propose'; proposal: RepeatProposal }
// S2 (the order to continue) and S3 (the page of an order, however it was found): an acceptance that holds goes on; the value of THIS context (the order's amounts and revision, the cart, G) goes on and
// is to be kept (S3 keeps it; S2 only lets the order be continued); anything else is a proposal - naming the waiting order only to who proves it strongly.
export function judgeRepeatForOrder(input: { evidence: OwnerEvidence; members: ReadonlyArray<RepeatMember>; order: SubjectOrder; cart: string; repeat: RepeatRequest; stage: 'order' | 'page'; now?: number }): ExistingOrderJudgement {
  const now = input.now ?? Date.now()
  if (input.repeat.mode === 'off') return { kind: 'go' }
  if (input.repeat.mode === 'shadow') {
    countRepeatShadow(input.stage, input.members, now, acceptanceHolds(acceptanceOf(input.order.metadata), inWindow(input.members, now), input.order.financialRevision))
    return { kind: 'go' }
  }
  const members = input.members
  const holds = acceptanceHolds(acceptanceOf(input.order.metadata), members, input.order.financialRevision)
  const value = members.length > 0 && !holds ? repeatContextValue(repeatContextOf({ owner: input.evidence, cart: { v: CART_FINGERPRINT_VERSION, fp: input.cart }, subject: existingOrderSubject(input.order), members })) : null
  const gate = repeatGate({ members, acceptanceHolds: holds, valueMatches: value !== null && input.repeat.value === value })
  if (gate.kind === 'none' || gate.kind === 'accepted') return { kind: 'go' }
  if (gate.kind === 'confirmed') {
    incrementMetric('checkout_repeat_guard_confirmed_total', 1, { stage: input.stage, subject: 'order' })
    return { kind: 'record', acceptance: acceptanceRecord({ members, rev: input.order.financialRevision, context: value as string }) }
  }
  const named = disclosureLevelOf(proofOf({ id: input.order.id, userId: input.order.userId, guestSessionHash: input.order.guestSessionHash || null }, input.evidence)) >= 2
  return { kind: 'propose', proposal: { newest: members[0], count: members.length, value: value as string, pending: { orderId: input.order.id, orderNumber: input.order.orderNumber, named } } }
}

export function countRepeatProposal(stage: 'order' | 'page', proposal: RepeatProposal): void {
  incrementMetric('checkout_repeat_guard_asked_total', 1, { stage, pending: proposal.pending ? 'order' : 'none' })
  logEvent({ event: 'checkout.repeat_guard', level: 'info', outcome: 'asked', stage, count: proposal.count, pending: Boolean(proposal.pending) })
}
