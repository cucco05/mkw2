// The PURE rules of the guard that keeps one guest purchase key from making a second order (R1-1b; architecture R3 of the R1-0 plan, docs/SESSIONE-OSPITE.md R1).
// No database, no network, no clock, no environment, no random source: the same input is the same answer (tests/purchase-intent.test.ts pins every rule and reads this file
// to prove it stays so). What touches the database - the table GuestPurchaseKey, the locks, the transaction - is in lib/checkout-orders.ts.
//
// The idea in five lines:
//   * a guest's browser chooses a checkout key K (a strong key: lib/checkout-key-format.ts) and sends it with every attempt. The server keeps, for a K that was shown to belong to an
//     order, ONE row: the FINGERPRINT of K -> that order. The fingerprint is SHA-256("mw:purchase-key:v1:" + K): K itself is never stored, logged or answered;
//   * K only CORRELATES. It is never a proof of anything: whose order it is is shown by the guest's session (a non-null, equal hash), by the account, or by the order's own
//     access cookie - never by K (`ownershipProof`). Somebody who sends a bound K and cannot show the order is theirs is REFUSED - and the refusal is ONE refusal, the same for
//     every order and every state of it: K alone must not be a way to read whether somebody else's purchase was paid, is being confirmed, was cancelled or failed (S-01 of the
//     independent audit). The refusal tells what THIS request did (nothing) and gives a support code; it does not read the order's state at all (`purchaseRefusal`);
//   * the state of an order can still be classified - "in_doubt", "paid", or "started" for everything else (`classifyForeignPurchase`) - for the reconciliation work that comes
//     later and for the people who answer customers. It is INTERNAL: no public answer is built from it. Nothing here ever says "free to buy again": a cancelled order, an expired
//     page, a failed attempt, a timer that ran out and a lost answer are NOT proofs that no money can still arrive, so they do not unlock anything;
//   * the support code is ten hex digits of the fingerprint, XXXXX-XXXXX: enough for the shop to find the binding when the customer writes, useless to anybody who does not hold K,
//     and independent of the order and of its state. It is not a credential - the shop checks who is writing before it says anything.
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

// ---- the INTERNAL classification of a purchase (never an answer to a request) -----------------------------------------------------
// For the reconciliation work (R1-3) and for the people who answer customers; kept pure and total. Nothing in the public path calls it (tests/security/purchase-key.sec.ts reads the sources).
export type PurchaseVerdict = 'paid' | 'in_doubt' | 'started'
export type PurchaseOrderFacts = {
  paymentStatus: string
  // the order carries the moment its payment was verified (it stays there whatever happens to the status afterwards)
  paidAtPresent: boolean
  // PAYMENT_IN_DOUBT_WHERE (lib/payment-in-doubt.ts), asked of the database: the only definition of "in doubt" there is, never written a second time here
  inDoubt: boolean
}

/**
 * The internal verdict for an order whose key is bound. Total, and with one direction only:
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

// ---- the refusal ------------------------------------------------------------------------------------------------------------------
// ONE refusal for a request that carries a bound key and cannot show the order is its own: the same status, the same code, the same body, whatever the order is and whatever
// state it is in (paid, being confirmed, started, cancelled, with a failed attempt...). It is built without reading the order at all. The sentence is for people who read the API;
// the page shows its own Italian text for the code (lib/checkout-copy.ts). Neither names, hints at or counts anything.
export const PURCHASE_REFUSAL_CODE = 'PURCHASE_KEY_IN_USE'
export type PurchaseRefusal = { status: 409; code: typeof PURCHASE_REFUSAL_CODE; message: string }

export function purchaseRefusal(): PurchaseRefusal {
  return { status: 409, code: PURCHASE_REFUSAL_CODE, message: 'This checkout key is already linked to a purchase; this request created nothing.' }
}
