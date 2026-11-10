// R1-3 / KLOSS, P1 of the plan: the PURE rules of "what a new checkout of a cart may do, given what the same owner already has for the same cart".
//
// Nothing here reads a database, calls a provider, looks at a clock or draws a random number: the same facts are the same decision (tests/owner-intent.test.ts pins every rule and reads this
// file, and what it imports, to prove it stays so). NOTHING CALLS IT YET: it is not connected to the checkout route, to createPendingCardOrder or to settleAndPlan - that is P2. What the
// checkout will be asked is written here, and tested over every combination, first.
//
// THE INVARIANT (I-X). A new payment-page reservation for an order is written only if EVERY other order of the same owner and the same cart - in ANY state: unpaid, paid, cancelled, under review -
// has no attempt that may still be payable. "May still be payable" is DR-13's vocabulary and nothing else (lib/checkout-session-plan.ts): a reservation of any age, an open page, a payment that is
// moving, a closed row WITHOUT the provider's word (an identifier is not that word; `session_mismatch:` names a cause; the old clock's `stale_reservation` is no closing), a state nobody knows.
// What shows a page is not payable: the provider's own word written on the row (`closed_by_us:`, `provider_status:expired`), the proof that nothing was ever created (`local_refusal:`,
// `provider_rejected:`), or being the page that carried the order's own verified payment (a `paid` attempt whose PaymentIntent is the order's: the carrier). The state of the ORDER (paid,
// cancelled...), the words failed / expired / paid on a row without that proof, and the time that has passed are NEVER proofs.
//
// WHO MAY BE TOLD WHAT. An answer never reveals about an order more than /api/checkout/status would reveal to the same proof (canViewOrder: the account, or the access cookie verified for THAT
// order). Levels: 0 nothing proved (R1-1b's one refusal, which the route gives before it ever gets here); 1 the browser session alone - or the session of an order the cookie opened ("lineage"):
// ONE coarse answer for every reason to hold, no order named, and NO confirmation gate at all (a distinct answer for "paid" would tell the state); 2 the access cookie of the order; 3 the account.
// To be HANDED an order back (to continue it) asks for more than to be held by it: the request's own session, the order's access cookie or the account. A lineage holds; it is never given an order.
//
// THE LIMIT E2 (not closed here; written down on purpose). The scope of a request is built only from what that request proves. Two requests of the same browser around a change of session
// can prove different things: the one that proved MORE (the new session + the cookie of an order of the old one) makes an order that carries the new hash; a later one that proves LESS (only the old
// session) cannot prove that order, so it is not in its scope. The link "this order was made by a browser that proved the old session" existed in the first request and is stored nowhere.
// Persisting it at creation is the only way to close it (P2b, a migration: NOT authorised). `orderInScope` is deliberately asymmetric in exactly that way, and the tests pin it as a limit.
//
// Not touched: R1-1b (lib/purchase-intent.ts) and DR-13 (lib/checkout-session-plan.ts, lib/checkout-sessions.ts) are used, not changed. A purchase KEY is never an identity here: no function
// takes one, no lock is named by one.
//
// The names of the plan, and where they are here: mayStillBePayable; scopeOf (with scopeOfOrder, unionScopes, reservationScope, orderInScope); ownerLockNames (with allLockNames); classifySiblings;
// planOwnerIntent (the decision before an order is made, S2); arbitrateReservation and arbitratePage (the arbiter under the locks, S3 - `mode: reserve` in the plan); publicResponseFor(decision, owner) - the level
// of disclosure is the one of the proofs the holders were found by (proofOf, disclosureLevelOf), so it needs no argument of its own.
import { closedWithoutProof, toMs } from '@/lib/checkout-session-plan'
import { isPaymentVerified } from '@/lib/order-payment-policy'
import { normalizePaymentStatus } from '@/lib/orderworks-status'
import { PURCHASE_REFUSAL_CODE, purchaseRefusal } from '@/lib/purchase-intent'

// ---- identities (a lock name is built from them: nothing but a plain token is allowed in) ---------------------------------------------------------------------------------------------------
const HASH = /^[0-9a-f]{64}$/
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)
const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort()
type When = Parameters<typeof toMs>[0]

/** What a request can prove it is the owner of. Built ONLY from verified proofs. Account: the viewer's account. Guest: the hash of the verified browser session (null if there is none) and the orders the access cookie really opens. */
export type VerifiedOrder = { id: string; guestSessionHash: string | null }
export type OwnerEvidence =
  | { kind: 'account'; userId: string }
  | { kind: 'guest'; sessionHash: string | null; verifiedOrders: ReadonlyArray<VerifiedOrder> }

/** The identities a request is the owner of: sorted, without duplicates, so that the same proofs are the same scope. `hashlessOrderIds` are the verified orders that carry no session hash (known by their id alone). */
export type OwnerScope = {
  readonly userId: string | null
  readonly hashes: readonly string[]
  readonly orderIds: readonly string[]
  readonly hashlessOrderIds: readonly string[]
}
export const EMPTY_SCOPE: OwnerScope = Object.freeze({ userId: null, hashes: Object.freeze([] as string[]), orderIds: Object.freeze([] as string[]), hashlessOrderIds: Object.freeze([] as string[]) })
export type ScopeOrder = { id: string; userId: string | null; guestSessionHash: string | null }

/** What a request proves. Malformed identities THROW: a scope is never built from text that is not an identity (it would name locks and queries); dropping one would silently narrow it. */
export function scopeOf(evidence: OwnerEvidence | null): OwnerScope {
  if (evidence === null) return EMPTY_SCOPE
  if (evidence.kind === 'account') {
    if (!isToken(evidence.userId)) throw new TypeError('An account scope is made from an account id.')
    return { ...EMPTY_SCOPE, userId: evidence.userId }
  }
  const hashes = new Set<string>()
  const ids = new Set<string>()
  const hashless = new Set<string>()
  if (evidence.sessionHash) {
    if (!isHash(evidence.sessionHash)) throw new TypeError('A session hash is 64 lower-case hexadecimal digits.')
    hashes.add(evidence.sessionHash)
  }
  for (const order of evidence.verifiedOrders) {
    if (!isToken(order.id)) throw new TypeError('A verified order has an order id.')
    ids.add(order.id)
    if (!order.guestSessionHash) hashless.add(order.id)
    else if (isHash(order.guestSessionHash)) hashes.add(order.guestSessionHash)
    else throw new TypeError('A session hash is 64 lower-case hexadecimal digits.')
  }
  return { userId: null, hashes: sortedUnique(hashes), orderIds: sortedUnique(ids), hashlessOrderIds: sortedUnique(hashless) }
}

/** What the order's OWN columns say (S3, the reservation, never reasons from less than this): an account order is its account's; a guest order is its hash's - or its own id if the hash is gone. */
export function scopeOfOrder(order: ScopeOrder): OwnerScope {
  if (order.userId) return scopeOf({ kind: 'account', userId: order.userId })
  return scopeOf({ kind: 'guest', sessionHash: order.guestSessionHash || null, verifiedOrders: order.guestSessionHash ? [] : [{ id: order.id, guestSessionHash: null }] })
}

/** Both at once. Adding proofs never narrows anything. Two different accounts in one scope are a programming error, not a union. */
export function unionScopes(a: OwnerScope, b: OwnerScope): OwnerScope {
  if (a.userId !== null && b.userId !== null && a.userId !== b.userId) throw new TypeError('A scope belongs to one account at most.')
  return {
    userId: a.userId ?? b.userId,
    hashes: sortedUnique([...a.hashes, ...b.hashes]),
    orderIds: sortedUnique([...a.orderIds, ...b.orderIds]),
    hashlessOrderIds: sortedUnique([...a.hashlessOrderIds, ...b.hashlessOrderIds]),
  }
}
/** The scope a reservation for `order` looks at: what the request proves AND what the order's own columns say (an owner that is absent - an internal call - leaves the columns: never weaker than today). */
export const reservationScope = (owner: OwnerEvidence | null, order: ScopeOrder): OwnerScope => unionScopes(scopeOf(owner), scopeOfOrder(order))
export const isEmptyScope = (scope: OwnerScope) => scope.userId === null && scope.hashes.length === 0 && scope.orderIds.length === 0

/**
 * Is this order inside the scope? The predicate the database query will repeat: the account's orders by `userId`; a guest's by a hash the request proves or an id the cookie opens - and ONLY orders of
 * no account. An order of another guest, with no hash and no verified id in common, is never inside: two guests with the same cart are never merged. An order with no hash is no one's by "two empty
 * values are equal".
 */
export function orderInScope(order: ScopeOrder, scope: OwnerScope): boolean {
  if (scope.userId !== null && order.userId === scope.userId) return true
  if (order.userId !== null) return false
  if (order.guestSessionHash && scope.hashes.includes(order.guestSessionHash)) return true
  return scope.orderIds.includes(order.id)
}

// ---- how a request proves an order, and what that allows it to be told ----------------------------------------------------------------------------------------------------------------------
export type ProofKind = 'account' | 'access' | 'session' | 'lineage'
export type DisclosureLevel = 0 | 1 | 2 | 3
/**
 * How THIS request shows that THIS order is its own - the strongest proof there is. 'account': the account's order. 'access': the access cookie opens THIS order. 'session': the order carries the
 * request's own session hash. 'lineage': the order carries the hash of an order the cookie opened (the same browser, an earlier session) - as weak as a session, no more. It is non-null exactly when
 * the order is in the scope of the evidence. The route's `via` (lib/checkout-orders.ts) is 'access' before 'session': so is this.
 */
export function proofOf(order: ScopeOrder, evidence: OwnerEvidence | null): ProofKind | null {
  if (evidence === null) return null
  if (evidence.kind === 'account') return order.userId !== null && order.userId === evidence.userId ? 'account' : null
  if (order.userId !== null) return null
  if (evidence.verifiedOrders.some((verified) => verified.id === order.id)) return 'access'
  const hash = order.guestSessionHash
  if (!hash) return null
  if (evidence.sessionHash && evidence.sessionHash === hash) return 'session'
  if (evidence.verifiedOrders.some((verified) => verified.guestSessionHash === hash)) return 'lineage'
  return null
}
export function disclosureLevelOf(proof: ProofKind | null): DisclosureLevel {
  if (proof === 'account') return 3
  if (proof === 'access') return 2
  if (proof === 'session' || proof === 'lineage') return 1
  return 0
}
const isStrong = (proof: ProofKind | null): proof is 'access' | 'account' => disclosureLevelOf(proof) >= 2
/**
 * May a decision hand this order back to the request - continue it, with its id and its payment page? Only with a proof the checkout already accepts for that: the account, the order's own access cookie,
 * or the request's own session (the proofs R1-1b's `ownershipProof` knows; the two conditions of today's duplicate search). LINEAGE - the same browser at an earlier session - is enough to HOLD the cart,
 * never to be given an order.
 */
export const proofAllowsReuse = (proof: ProofKind | null): proof is 'account' | 'access' | 'session' => proof === 'account' || proof === 'access' || proof === 'session'

// ---- what may still be payable --------------------------------------------------------------------------------------------------------------------------------------------------------------
export type AttemptFacts = { status: string; stripeSessionId: string | null; failureReason?: string | null; stripePaymentIntentId?: string | null }
export type OrderPaymentFacts = { paymentStatus: string; stripePaymentIntentId?: string | null }

// a payment that was verified (and may have been refunded since: the status then says so, the page it was made on is the same)
const paymentWasVerified = (paymentStatus: string | null | undefined) => isPaymentVerified(paymentStatus) || normalizePaymentStatus(paymentStatus) === 'refunded'
/**
 * The page that carried the order's OWN payment: a `paid` attempt whose PaymentIntent is the order's, on an order whose payment was verified. Its session is `complete` - the provider's word - so it
 * can not be paid again, and it is the one page of the order that is never one of "the other pages" (lib/checkout-pages.ts says the same). Anything less is not it: no PaymentIntent, another one, an
 * order that does not say it is paid.
 */
export function isCarrierOfOrderPayment(attempt: AttemptFacts, order: OrderPaymentFacts): boolean {
  if (attempt.status !== 'paid') return false
  const intent = attempt.stripePaymentIntentId
  if (typeof intent !== 'string' || intent === '' || intent !== order.stripePaymentIntentId) return false
  return paymentWasVerified(order.paymentStatus)
}
/**
 * May this attempt's page still be paid? The ONE definition (plan REV3, 1.2), built from DR-13's: nothing is proved by the state of the order, by `failed` / `expired` without the provider's word, by an
 * identifier, or by time. TOTAL: a state nobody knows is "yes" (as `unknown_attempt_status` is in the per-order planner).
 */
export function mayStillBePayable(attempt: AttemptFacts, order: OrderPaymentFacts): boolean {
  switch (attempt.status) {
    case 'creating':
    case 'open':
    case 'processing':
    case 'mismatch':
      return true
    case 'expired':
    case 'failed':
      return closedWithoutProof(attempt)
    case 'paid':
      return !isCarrierOfOrderPayment(attempt, order)
    default:
      return true
  }
}

/** "A payment in doubt": the same four conditions as PAYMENT_IN_DOUBT_WHERE (lib/payment-in-doubt.ts), written for facts already read. tests/security/owner-intent-equivalence.sec.ts proves the two pick the same orders. */
export function isInDoubt(order: { status: string; paymentStatus: string; paymentReviewReason: string | null | undefined }, attempts: ReadonlyArray<{ status: string }>): boolean {
  if (order.paymentStatus === 'processing') return true
  if (order.paymentReviewReason !== null && order.paymentReviewReason !== undefined) return true
  if (order.status === 'awaiting_review' && (order.paymentStatus === 'paid' || order.paymentStatus === 'free')) return true
  return attempts.some((attempt) => attempt.status === 'processing' || attempt.status === 'mismatch')
}

// ---- the siblings ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type SiblingOrder = ScopeOrder & {
  orderNumber: number
  paymentMethod: string
  status: string
  paymentStatus: string
  paymentReviewReason: string | null
  stripePaymentIntentId: string | null
  totalCents: number
  refundedCents: number | null
  paidAt: When
  createdAt: When
  attempts: ReadonlyArray<AttemptFacts & { id: string }>
}
/** in_doubt: a payment is moving or waits for a person (no time limit). paid: verified, nothing in doubt. unpaid: waiting for its payment. terminal: anything else (cancelled, failed, expired...). */
export type SiblingKind = 'in_doubt' | 'paid' | 'unpaid' | 'terminal'
export type SiblingClass = {
  orderId: string
  orderNumber: number
  kind: SiblingKind
  proof: ProofKind | null
  /** at least one attempt of the order may still be payable - whatever state the order is in */
  holdsPage: boolean
  /** the order was just made and has no attempt yet: its page is being opened (see IntentWindows.reservingMs). Only the decision before an order is made looks at it; false when no window is given */
  reserving: boolean
  totalCents: number
  createdAtMs: number
  paidAtMs: number
  refunded: boolean
  cancelled: boolean
}
const orderOfTheNewestFirst = (a: { createdAtMs: number; orderId: string }, b: { createdAtMs: number; orderId: string }) => (b.createdAtMs - a.createdAtMs) || (a.orderId < b.orderId ? 1 : a.orderId > b.orderId ? -1 : 0)
const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)

function kindOf(order: SiblingOrder): SiblingKind {
  if (isInDoubt(order, order.attempts)) return 'in_doubt'
  if (paymentWasVerified(order.paymentStatus)) return 'paid'
  if (order.status === 'awaiting_payment' && order.paymentStatus === 'pending') return 'unpaid'
  return 'terminal'
}
/**
 * The orders of the scope, with what the decision needs to know of each: its kind, how this request proves it, and whether any of its attempts may still be payable. Only CARD orders are siblings (an
 * unpaid cash or invoice order of the same cart is not a card checkout to continue); orders outside the scope do not exist for this request; `excludeOrderId` is the order being reserved (not its own
 * sibling). The newest first, ties by id: the same list for everybody.
 */
export function classifySiblings(input: { owner: OwnerEvidence | null; scope: OwnerScope; orders: ReadonlyArray<SiblingOrder>; excludeOrderId?: string; reserving?: { now: number; windowMs: number } }): SiblingClass[] {
  const out: SiblingClass[] = []
  for (const order of input.orders) {
    if (order.id === input.excludeOrderId || order.paymentMethod !== 'card' || !orderInScope(order, input.scope)) continue
    const created = finiteOr(toMs(order.createdAt), 0)
    const kind = kindOf(order)
    out.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      kind,
      proof: proofOf(order, input.owner),
      holdsPage: order.attempts.some((attempt) => mayStillBePayable(attempt, order)),
      reserving: input.reserving !== undefined && input.reserving.windowMs > 0 && kind === 'unpaid' && order.attempts.length === 0 && created > input.reserving.now - input.reserving.windowMs,
      totalCents: order.totalCents,
      createdAtMs: created,
      paidAtMs: finiteOr(toMs(order.paidAt), created),
      refunded: (order.refundedCents ?? 0) > 0 || normalizePaymentStatus(order.paymentStatus) === 'refunded',
      cancelled: order.status === 'cancelled',
    })
  }
  return out.sort(orderOfTheNewestFirst)
}

// ---- the decision --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type Holder = { orderId: string; orderNumber: number; proof: ProofKind | null; inDoubt: boolean }
/**
 * in_doubt: a payment is being confirmed or waits for a person. sibling_page: another order of this cart has a page that may still be paid (or is being given one). incomplete: not every order of
 * the scope was read (the query hit its limit). unproved: the request does not prove the order it asks a page of.
 */
export type HoldCause = 'in_doubt' | 'sibling_page' | 'incomplete' | 'unproved'
export type IntentWindows = {
  /** an unpaid order of the same cart and total made less than this long ago is the same purchase (DUPLICATE_ORDER_WINDOW_MS, one hour) */
  duplicateMs: number
  /** a verified payment made less than this long ago asks for a confirmation before the same cart is bought again (proposal: one hour; the owner decides). 0 = the gate is OFF: no confirmation is ever asked (P2; P3 switches it on) */
  repeatMs: number
  /**
   * an UNPAID order with NO attempt at all that was made less than this long ago is being given its page by the request that made it (it is between "the order is committed" and "its page is
   * reserved"): it holds the cart like a page does, so that a second request does not make a second order beside it. DR-13's JOIN_WINDOW_MS. Time is only ever a reason to HOLD here: once the window
   * is over an order without a single attempt has no page (the reservation row is written before the provider is called), and the arbiter of the reservation is what decides. 0 = off.
   */
  reservingMs: number
}
export type OwnerIntentInput = {
  owner: OwnerEvidence
  /** the total the server quotes for this request */
  requestTotalCents: number
  /** the explicit gesture of a customer who wants the same cart again; it only matters when a confirmation was asked for */
  confirmRepeat: boolean
  now: number
  windows: IntentWindows
  /** the orders of the same cart (the caller filters by the cart fingerprint, v2 and v1); the scope is applied here again */
  orders: ReadonlyArray<SiblingOrder>
  /** true if the caller read EVERY order of the scope (false when its query hit the limit it was given). A list that was cut gives nothing: no order to continue, no confirmation, no new order */
  listIsComplete: boolean
}
export type OwnerIntentDecision =
  | { kind: 'reuse'; orderId: string }
  | { kind: 'hold'; cause: HoldCause; holders: Holder[] }
  | { kind: 'confirm'; orderId: string; orderNumber: number; proof: 'access' | 'account' }
  | { kind: 'create'; repeatOf: string[] }

const holderOf = (sibling: SiblingClass): Holder => ({ orderId: sibling.orderId, orderNumber: sibling.orderNumber, proof: sibling.proof, inDoubt: sibling.kind === 'in_doubt' })
const hold = (cause: HoldCause, siblings: SiblingClass[]): { kind: 'hold'; cause: HoldCause; holders: Holder[] } => ({ kind: 'hold', cause, holders: siblings.map(holderOf) })
// numbers that decide are checked, not trusted: a NaN window would make every comparison false, and that would be a decision too
function assertNumbers(values: Record<string, number>, whole = false) {
  for (const [name, value] of Object.entries(values)) if (!Number.isFinite(value) || value < 0 || (whole && !Number.isInteger(value))) throw new TypeError(`${name} must be a non-negative ${whole ? 'integer' : 'number'}.`)
}

/**
 * The order of the checks, the same for every combination:
 *   1. a payment in doubt HOLDS                                                                                   (as today, with no limit of time)
 *   2. pages that may still be paid: if MORE THAN ONE order holds one, or the only one that does is not the order to continue, HOLD   (I-X: never a second payable page, never a choice between two)
 *   3. the list was cut: HOLD - a list that is not whole gives nothing: no order to continue, no confirmation, no new order
 *   4. exactly one order holds a page and it is the order to continue: REUSE it                                   (DR-13 then reuses, repairs or refuses its page)
 *   5. no page anywhere: the newest order to continue that was made inside the window is REUSED                   (as today)
 *   6. a verified payment made recently, proved by the account or by the access cookie, asks a CONFIRMATION (and creates only with `confirmRepeat`); otherwise CREATE
 * "The order to continue" is unpaid, at THIS total, and proved the way the checkout already requires before it hands an order back (proofAllowsReuse). An order known by LINEAGE is never that: with a
 * page that may be paid it holds the cart (step 2); without one it is left alone, and nothing of it is told.
 * In steps 2 and 4 an order that was just made and has no attempt yet (`reserving`) counts as holding a page: its page is being opened.
 * A request that proves its browser session alone never meets the confirmation: whether an earlier purchase was PAID is not told to it, not even by a gate it could step over.
 */
export function planOwnerIntent(input: OwnerIntentInput): OwnerIntentDecision {
  assertNumbers({ now: input.now, duplicateMs: input.windows.duplicateMs, repeatMs: input.windows.repeatMs, reservingMs: input.windows.reservingMs })
  assertNumbers({ requestTotalCents: input.requestTotalCents }, true)
  const siblings = classifySiblings({ owner: input.owner, scope: scopeOf(input.owner), orders: input.orders, reserving: { now: input.now, windowMs: input.windows.reservingMs } })

  const inDoubt = siblings.filter((sibling) => sibling.kind === 'in_doubt')
  if (inDoubt.length > 0) return hold('in_doubt', inDoubt)

  const toContinue = (sibling: SiblingClass) => sibling.kind === 'unpaid' && sibling.totalCents === input.requestTotalCents && proofAllowsReuse(sibling.proof)
  const holding = siblings.filter((sibling) => sibling.holdsPage || sibling.reserving)
  if (holding.length > 1 || (holding.length === 1 && !toContinue(holding[0]))) return hold('sibling_page', holding)

  if (!input.listIsComplete) return { kind: 'hold', cause: 'incomplete', holders: [] }

  if (holding.length === 1) return { kind: 'reuse', orderId: holding[0].orderId }
  // (the siblings are the newest first)
  const recent = siblings.find((sibling) => toContinue(sibling) && sibling.createdAtMs > input.now - input.windows.duplicateMs)
  if (recent) return { kind: 'reuse', orderId: recent.orderId }

  // (a window of 0 is "no gate", not "a payment made in this very instant": no comparison with a clock is made at all)
  const gateIsOn = input.windows.repeatMs > 0
  const repeated = siblings.filter((sibling) => gateIsOn && sibling.kind === 'paid' && !sibling.cancelled && !sibling.refunded && sibling.paidAtMs > input.now - input.windows.repeatMs && isStrong(sibling.proof))
  if (repeated.length > 0 && !input.confirmRepeat) {
    return { kind: 'confirm', orderId: repeated[0].orderId, orderNumber: repeated[0].orderNumber, proof: repeated[0].proof as 'access' | 'account' }
  }
  return { kind: 'create', repeatOf: repeated.map((sibling) => sibling.orderId) }
}

export type ReservationInput = {
  /** what the request proves; null for a call that has no request (then only the order's own columns count: never weaker than today) */
  owner: OwnerEvidence | null
  /** the order a reservation is about to be written for */
  order: ScopeOrder
  orders: ReadonlyArray<SiblingOrder>
  listIsComplete: boolean
}
export type ReservationVerdict = { kind: 'proceed' } | { kind: 'hold'; cause: HoldCause; holders: Holder[] }
/**
 * The arbiter, asked under the locks at the moment a reservation would be written (S3): it holds for the same two reasons the decision above does - a payment in doubt, or another order of the scope
 * (any state) with an attempt that may still be payable - and lets the reservation go on otherwise. The order itself is never its own sibling (its own pages are DR-13's, per order). The scope is
 * what the request proves joined with what the order's own columns say.
 */
export function arbitrateReservation(input: ReservationInput): ReservationVerdict {
  const siblings = classifySiblings({ owner: input.owner, scope: reservationScope(input.owner, input.order), orders: input.orders, excludeOrderId: input.order.id })
  const holding = siblings.filter((sibling) => sibling.kind === 'in_doubt' || sibling.holdsPage)
  if (holding.length > 0) return hold(holding.some((sibling) => sibling.kind === 'in_doubt') ? 'in_doubt' : 'sibling_page', holding)
  if (!input.listIsComplete) return { kind: 'hold', cause: 'incomplete', holders: [] }
  return { kind: 'proceed' }
}

/**
 * May THIS request be handed a page of THIS order - a new one (a reservation, or one sent again), or the one the order already has? The question asked, under the locks, wherever the checkout is about
 * to give a payment page, however the order was found (its key, the binding of a purchase key, the order to continue, the winner of a race):
 *   * the request must prove the order the way the checkout requires before it hands an order back (proofAllowsReuse) - a LINEAGE is not that, and nothing of the order is given to it;
 *   * and no OTHER order of the scope may be paid or be in doubt, and the list must be whole (arbitrateReservation). The order's own page is never its sibling: with nothing else in the way its
 *     page is given as before.
 * A call with no request at all (`owner: null`: an internal call, which hands nothing to anybody) is judged by the order's own columns, as before.
 */
export function arbitratePage(input: ReservationInput): ReservationVerdict {
  if (input.owner !== null && !proofAllowsReuse(proofOf(input.order, input.owner))) return { kind: 'hold', cause: 'unproved', holders: [] }
  return arbitrateReservation(input)
}

// ---- what the request is told ------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const HOLD_CODE = 'PAYMENT_IN_PROGRESS'
export const REPEAT_CONFIRMATION_CODE = 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED'
// the sentence the route says today when a payment for the cart is in doubt: the same for every reason to hold
export const HOLD_MESSAGE = 'A payment for this cart is already being confirmed. Check its status before paying again.'
export const REPEAT_CONFIRMATION_MESSAGE = 'A payment for this cart was completed a short while ago. Confirm that you want to buy it again.'
/** `extra` is what the route adds to the body next to `error` and `code`: nothing, or the order the request is shown to own. */
export type PublicResponse =
  | { status: 409; code: typeof HOLD_CODE; message: string; extra: Record<string, never> | { orderId: string; orderNumber: number } }
  | { status: 409; code: typeof REPEAT_CONFIRMATION_CODE; message: string; extra: { orderId: string; orderNumber: number } }
  | { status: 409; code: typeof PURCHASE_REFUSAL_CODE; message: string; extra: { retry: false; supportCode?: string } }

/**
 * The answer a decision gives, or null when the request goes on (reuse / create / proceed).
 *   * a request that proves nothing: R1-1b's one refusal, nothing named (it is given before the planner is reached; this keeps the function total);
 *   * a hold: ONE status, ONE code, ONE sentence for every cause and every number of holders; an order is named only if the request proves it with the access cookie or the account - what the status
 *     page would tell it - and then it is the newest such order;
 *   * a confirmation: its order is named (the request proves it); a proof weaker than that THROWS - an exception is safer than a word too many.
 */
export function publicResponseFor(decision: OwnerIntentDecision | ReservationVerdict, owner: OwnerEvidence | null, options: { supportCode?: string } = {}): PublicResponse | null {
  if (decision.kind === 'reuse' || decision.kind === 'create' || decision.kind === 'proceed') return null
  if (isEmptyScope(scopeOf(owner))) {
    const refusal = purchaseRefusal()
    return { status: refusal.status, code: refusal.code, message: refusal.message, extra: options.supportCode ? { supportCode: options.supportCode, retry: false } : { retry: false } }
  }
  if (decision.kind === 'confirm') {
    if (!isStrong(decision.proof)) throw new TypeError('A confirmation of a repeat purchase is given only to a request that proves the paid order with the access cookie or the account.')
    return { status: 409, code: REPEAT_CONFIRMATION_CODE, message: REPEAT_CONFIRMATION_MESSAGE, extra: { orderId: decision.orderId, orderNumber: decision.orderNumber } }
  }
  const named = decision.holders.find((holder) => isStrong(holder.proof))
  return { status: 409, code: HOLD_CODE, message: HOLD_MESSAGE, extra: named ? { orderId: named.orderId, orderNumber: named.orderNumber } : {} }
}

// ---- the locks (ADDITIVE: the names the checkout takes today are never renamed or dropped) -------------------------------------------------------------------------------------------------
export const OWNER_LOCK_PREFIX = 'checkout:owner:'
/**
 * The lock names of an owner and a cart (plan REV3, 2.4): each named by an identity the request PROVED (a session hash, a hash an order of the cookie carries, an account, the id of a verified order that
 * has no hash) and by the cart WITHOUT the total. Two guests with disjoint proofs share none; the same browser on both sides of a session change shares the old session's. Sorted, without duplicates.
 * Malformed identities THROW. A purchase key is not an identity and takes no part.
 */
export function ownerLockNames(scope: OwnerScope, cartFingerprint: string): string[] {
  if (!isHash(cartFingerprint)) throw new TypeError('An owner lock is named by the fingerprint of the cart: 64 lower-case hexadecimal digits.')
  const names: string[] = []
  if (scope.userId !== null) {
    if (!isToken(scope.userId)) throw new TypeError('An owner lock is named by an account id.')
    names.push(`${OWNER_LOCK_PREFIX}u:${scope.userId}:${cartFingerprint}`)
  }
  for (const hash of scope.hashes) {
    if (!isHash(hash)) throw new TypeError('An owner lock is named by a session hash: 64 lower-case hexadecimal digits.')
    names.push(`${OWNER_LOCK_PREFIX}h:${hash}:${cartFingerprint}`)
  }
  for (const id of scope.hashlessOrderIds) {
    if (!isToken(id)) throw new TypeError('An owner lock is named by an order id.')
    names.push(`${OWNER_LOCK_PREFIX}o:${id}:${cartFingerprint}`)
  }
  return sortedUnique(names)
}
/** Every name a request takes: the ones the checkout takes today (`legacy`, as they are, in no way altered) together with the additive ones, in ONE total order (the one the checkout already sorts by) and without duplicates. */
export const allLockNames = (legacy: readonly string[], additive: readonly string[]): string[] => sortedUnique([...legacy, ...additive])
export const isOwnerLockName = (name: string) => name.startsWith(OWNER_LOCK_PREFIX)
