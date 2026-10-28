// The PURE rules of the guard that keeps one guest purchase key from making a second order (R1-1b; architecture R3 of the R1-0 plan, docs/SESSIONE-OSPITE.md R1).
// No database, no network, no clock, no environment, no random source: the same input is the same answer (tests/purchase-intent.test.ts pins every rule and reads this file
// to prove it stays so). What touches the database - the table GuestPurchaseKey, the locks, the transaction - is in lib/checkout-orders.ts.
//
// The idea in five lines:
//   * a guest's browser chooses a checkout key K (a strong key: lib/checkout-key-format.ts) and sends it with every attempt. The server keeps, for a K that was shown to belong to an
//     order, ONE row: the FINGERPRINT of K -> that order. The fingerprint is SHA-256("mw:purchase-key:v1:" + K): K itself is never stored, logged or answered;
//   * K only CORRELATES requests. It is never a proof of anything: whose order it is is shown by the guest's session (a non-null, equal hash), by the account, or by the order's own
//     access cookie - never by K (`ownershipProof`). Somebody who sends a bound K and cannot show the order is theirs is REFUSED, and told no more than a verdict;
//   * the verdict has three values and no way out: "in_doubt" (the payment is being confirmed or waits for a person), "paid", and "started" for everything else. Nothing here ever
//     says "free to buy again": a cancelled order, an expired page, a failed attempt, a timer that ran out and a lost answer are NOT proofs that no money can still arrive, so they
//     do not unlock anything (`classifyForeignPurchase`). Unlocking is for the reconciliation work that comes later, with its own proofs;
//   * the support code is ten hex digits of the fingerprint, XXXXX-XXXXX: enough for the shop to find the binding when the customer writes, useless to anybody who does not hold K.
//     It is not a credential - the shop checks who is writing before it says anything;
//   * a refusal is a 409 with a code and a sentence that belong to nobody (`refusalFor`).
import { createHash } from 'node:crypto'
import { isStrongCheckoutKey } from '@/lib/checkout-key-format'

export const PURCHASE_KEY_DOMAIN = 'mw:purchase-key:v1:'
export const PURCHASE_KEY_HASH_PATTERN = /^[0-9a-f]{64}$/
export const SUPPORT_CODE_PATTERN = /^[0-9A-F]{5}-[0-9A-F]{5}$/

/** 64 lower-case hex digits: the only shape a fingerprint has (the table refuses anything else, too). */
export function isPurchaseKeyHash(value: unknown): value is string {
  return typeof value === 'string' && PURCHASE_KEY_HASH_PATTERN.test(value)
}

/**
 * The fingerprint of a checkout key: SHA-256 of the domain text and the key, in its own name space (no other hash of the shop is made from the same text). Only a STRONG key has
 * one - a weak, degenerate, mistyped or non-string value gives null, and nothing throws. The shape filter is a filter and not a proof of randomness (see lib/checkout-key-format.ts):
 * the safety of this guard does not depend on the key being unguessable, because the key is only ever used to REFUSE, never to let anybody in.
 */
export function purchaseKeyFor(clientKey: unknown): string | null {
  if (!isStrongCheckoutKey(clientKey)) return null
  return createHash('sha256').update(`${PURCHASE_KEY_DOMAIN}${clientKey}`).digest('hex')
}

/** The advisory lock that serialises everything about one purchase key. Named by the fingerprint and by nothing else. */
export function purchaseKeyLockName(purchaseKeyHash: string): string {
  if (!isPurchaseKeyHash(purchaseKeyHash)) throw new TypeError('A purchase key lock is named by a purchase key fingerprint.')
  return `checkout:purchase-key:${purchaseKeyHash}`
}

// ---- whose order it is -----------------------------------------------------------------------------------------------------------
export type OwnerProof = 'session' | 'access'

/**
 * How THIS request shows that an order is its own - or null.
 *   * 'session': the order is a guest's, it has a session hash and it is the SAME non-empty hash as the request's. An order without a hash (the retention job empties it; an
 *     order made before it existed) is proved by no session at all - not even by the one that made it, and never by "two empty values are equal";
 *   * 'access': the order's own access cookie was verified for THIS order (`verifiedOrderIds` are the ids a verified cookie opens);
 *   * an order that belongs to an ACCOUNT is proved by neither: it is the account's.
 * The key of the purchase is not an argument: it cannot prove anything.
 */
export function ownershipProof(
  order: { id: string; userId: string | null; guestSessionHash: string | null },
  mySessionHash: string | null | undefined,
  verifiedOrderIds: ReadonlySet<string>,
): OwnerProof | null {
  if (order.userId !== null) return null
  if (typeof mySessionHash === 'string' && mySessionHash.length > 0 && typeof order.guestSessionHash === 'string' && order.guestSessionHash.length > 0 && order.guestSessionHash === mySessionHash) return 'session'
  if (verifiedOrderIds.has(order.id)) return 'access'
  return null
}

// ---- what a request that is not the owner is told --------------------------------------------------------------------------------
export type PurchaseVerdict = 'paid' | 'in_doubt' | 'started'
export type PurchaseOrderFacts = {
  paymentStatus: string
  // the order carries the moment its payment was verified (it stays there whatever happens to the status afterwards)
  paidAtPresent: boolean
  // PAYMENT_IN_DOUBT_WHERE (lib/payment-in-doubt.ts), asked of the database: the only definition of "in doubt" there is, never written a second time here
  inDoubt: boolean
}

/**
 * The verdict for a request that carries a bound key and cannot show the order is its own. Total, and with one direction only:
 *   in doubt first (money may be moving, or waits for a person) - then paid - and EVERYTHING ELSE is "started". There is no verdict that lets the request go on to make an order.
 * Input that is not what the type says does not throw and does not open anything: it is "started".
 */
export function classifyForeignPurchase(facts: PurchaseOrderFacts): PurchaseVerdict {
  const f = (facts && typeof facts === 'object' ? facts : {}) as Partial<PurchaseOrderFacts>
  if (f.inDoubt === true) return 'in_doubt'
  if (f.paymentStatus === 'paid' || f.paymentStatus === 'free' || f.paidAtPresent === true) return 'paid'
  return 'started'
}

/** `XXXXX-XXXXX`: the first ten hex digits of the fingerprint, in capitals. Never the whole fingerprint. */
export function supportCodeFor(purchaseKeyHash: string): string {
  if (!isPurchaseKeyHash(purchaseKeyHash)) throw new TypeError('A support code is made from a purchase key fingerprint.')
  const head = purchaseKeyHash.slice(0, 10).toUpperCase()
  return `${head.slice(0, 5)}-${head.slice(5)}`
}

// ---- the refusal -----------------------------------------------------------------------------------------------------------------
export type PurchaseRefusal = { status: 409; code: 'PURCHASE_ALREADY_PAID' | 'PAYMENT_IN_PROGRESS' | 'PURCHASE_ALREADY_STARTED'; message: string }

// The sentences are for people who read the API; the page shows its own Italian text for the code (lib/checkout-copy.ts). None of them names, hints at or counts anything.
const REFUSALS: Record<PurchaseVerdict, PurchaseRefusal> = {
  paid: { status: 409, code: 'PURCHASE_ALREADY_PAID', message: 'This purchase already has a payment. Nothing new was started.' },
  // the same code and the same sentence as the check that has always refused a second payment while one is being confirmed (app/api/checkout/session/route.ts)
  in_doubt: { status: 409, code: 'PAYMENT_IN_PROGRESS', message: 'A payment for this cart is already being confirmed. Check its status before paying again.' },
  started: { status: 409, code: 'PURCHASE_ALREADY_STARTED', message: 'This purchase was already started. Nothing new was started.' },
}

export function refusalFor(verdict: PurchaseVerdict): PurchaseRefusal {
  const refusal = Object.prototype.hasOwnProperty.call(REFUSALS, verdict) ? REFUSALS[verdict] : undefined
  if (!refusal) throw new TypeError('There is no refusal for this verdict.')
  return { ...refusal }
}
