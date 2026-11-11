// R1-3 / KLOSS hardening B - the fingerprints of a cart and their VERSIONS: one registry, which every door of the checkout reads. Pure.
//
// A fingerprint says "the same purchase" without trusting the browser's memory:
//   * the CHECKOUT fingerprint (who buys, the lines, delivery, rush AND the total shown) finds the order of a request sent again (the duplicate search, assertSameCheckout) and names the
//     per-request locks of lib/checkout-orders.ts;
//   * the CART fingerprint (the same, without the total) finds the owner's other orders of the cart (the owner guard, the payment in flight) and names the owner locks.
// Both are stored with the order (metadata.checkout.fingerprint / .cartFingerprint), and - from hardening B - so is the version that computed them (.cartFingerprintVersion; under `checkout.*`,
// which is no financial fact: lib/financial-revision.ts).
//
// A VERSION never changes once it is registered: its golden values (tests/fixtures/cart-fingerprint-golden.json, recomputed independently by scripts/cart-fingerprint-golden.py) pin it. A new way
// of computing a fingerprint is a NEW version, and it is introduced in TWO phases (docs/RILASCIO-PRODUZIONE.md, section 23):
//   phase 1  the new version is registered as `lookup` in EVERY instance: every instance FINDS the orders stored with it; nobody writes it yet;
//   phase 2  only once phase 1 runs everywhere: the new version becomes `current` (written), the previous one `transitional` (still found, and the locks are still named by it too);
//   then     once phase 2 runs everywhere: the previous one becomes `lookup` (found, no lock named by it).
// The roles:
//   current       written on new orders; the locks are named by it; found;
//   transitional  not written; the locks are named by it TOO - an instance that still writes it and one that writes the new one meet at the same lock; found;
//   lookup        found only: the orders stored with it are recognised.
// A shared lock is NOT enough on its own: an instance that does not KNOW a version can not find an order stored with it, whatever lock it holds - it makes a second order. That is why every
// instance must know a version before any instance writes it (tests/security/cart-fingerprint-rollout.sec.ts shows both: one order across the two phases, a second order beside an instance
// that does not know the version). A version leaves the registry only after scripts/cart-fingerprint-retirement.sql (read only) shows that no order still needs it.
import { createHash } from 'crypto'
import { canonicalCartItems, canonicalJson } from '@/lib/cart-canonical'
import type { CheckoutItemPayload } from '@/lib/checkout-quote'

export type CartFingerprintInput = { principalId: string | null; items: CheckoutItemPayload[]; shippingMethod: 'pickup' | 'ship'; rush: boolean }
export type CheckoutFingerprintInput = CartFingerprintInput & {
  // The total the customer was shown. It is only ever COMPARED with the server's total, never used as a price.
  expectedTotalCents: number
}

// ---- version 2 (step 4.6): the order of the lines and the random `setKey` that groups the lines of a complete model are NOT part of it (lib/cart-canonical.ts) - a cart rebuilt with other keys, or
// with its lines in another order, is the same purchase. (Moved here unchanged from lib/checkout-orders.ts, which exports it under the same name.)
export function checkoutFingerprint(input: CheckoutFingerprintInput): string {
  return createHash('sha256')
    .update(canonicalJson({
      v: 2,
      principal: input.principalId ?? 'guest',
      items: canonicalCartItems(input.items as Array<Record<string, unknown>>),
      shipping: input.shippingMethod,
      rush: input.rush,
      expectedTotal: input.expectedTotalCents,
    }))
    .digest('hex')
}
// The same cart, whatever the total shown and whatever the checkout key: who is buying (account or guest), what, how it is delivered, rush. This is what tells "the same purchase" apart from
// "another purchase of the same things" when the browser's own memory is not to be trusted (another tab, a cleared storage): the SERVER keeps it with the order and compares it, for the same
// customer, before it makes a second order.
export function cartFingerprint(input: CartFingerprintInput): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 2, principal: input.principalId ?? 'guest', items: canonicalCartItems(input.items as Array<Record<string, unknown>>), shipping: input.shippingMethod, rush: input.rush }))
    .digest('hex')
}

// ---- version 1, as step 4.5 computed it: the lines exactly as sent. Kept ONLY to recognise orders created before step 4.6 (their stored fingerprints are v1).
export function checkoutFingerprintV1(input: CheckoutFingerprintInput): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, principal: input.principalId ?? 'guest', items: input.items, shipping: input.shippingMethod, rush: input.rush, expectedTotal: input.expectedTotalCents }))
    .digest('hex')
}
export function cartFingerprintV1(input: CartFingerprintInput): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, principal: input.principalId ?? 'guest', items: input.items, shipping: input.shippingMethod, rush: input.rush }))
    .digest('hex')
}

// ---- the registry ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type FingerprintRole = 'current' | 'transitional' | 'lookup'
export type FingerprintVersion = {
  readonly v: number
  readonly role: FingerprintRole
  readonly cart: (input: CartFingerprintInput) => string
  readonly checkout: (input: CheckoutFingerprintInput) => string
}
// TODAY: version 2 is written, version 1 is found (the orders of step 4.5). No version is transitional, so the locks are exactly the ones the checkout took before hardening B.
export const CART_FINGERPRINT_REGISTRY: readonly FingerprintVersion[] = Object.freeze([
  Object.freeze({ v: 2, role: 'current' as const, cart: cartFingerprint, checkout: checkoutFingerprint }),
  Object.freeze({ v: 1, role: 'lookup' as const, cart: cartFingerprintV1, checkout: checkoutFingerprintV1 }),
])

// Test seam, null in production (the same kind as checkoutOrderHooks): a TEST puts another registry here - the child processes of tests/security/cart-fingerprint-rollout.sec.ts, to play the
// instances of a rollout with a version of the test's own. Nothing but a test sets it.
export const cartFingerprintHooks: { registry: readonly FingerprintVersion[] | null } = { registry: null }

const ROLES: readonly FingerprintRole[] = ['current', 'transitional', 'lookup']
/** Throws unless the registry is one the checkout can work with: versions that are distinct positive integers, known roles, EXACTLY one `current`. */
export function assertRegistry(registry: readonly FingerprintVersion[]): void {
  const versions = registry.map((entry) => entry.v)
  if (versions.some((v) => !Number.isInteger(v) || v <= 0) || new Set(versions).size !== versions.length) throw new TypeError('The versions of the cart fingerprint are distinct positive integers.')
  if (registry.some((entry) => !ROLES.includes(entry.role) || typeof entry.cart !== 'function' || typeof entry.checkout !== 'function')) throw new TypeError('A version of the cart fingerprint has a role and its two functions.')
  if (registry.filter((entry) => entry.role === 'current').length !== 1) throw new TypeError('Exactly one version of the cart fingerprint is current.')
}
/** The registry in force: the production one, or the one a test put in the seam. */
export function fingerprintRegistry(): readonly FingerprintVersion[] {
  const registry = cartFingerprintHooks.registry ?? CART_FINGERPRINT_REGISTRY
  assertRegistry(registry)
  return registry
}
/** The version new orders are written with. */
export const currentFingerprintVersion = (registry: readonly FingerprintVersion[] = fingerprintRegistry()): number => (registry.find((entry) => entry.role === 'current') as FingerprintVersion).v

export type CartFingerprints = { v: number; checkout: string; cart: string }
/**
 * The fingerprints of ONE request, by role:
 *   current  what is written on a new order;
 *   lock     the versions the locks are named by: current, then transitional (newest first);
 *   lookup   every registered version - current, transitional, lookup (newest first within each): what an order stored with is recognised by.
 */
export type FingerprintSet = { current: CartFingerprints; lock: CartFingerprints[]; lookup: CartFingerprints[] }
const RANK: Record<FingerprintRole, number> = { current: 0, transitional: 1, lookup: 2 }
export function fingerprintSetOf(input: CheckoutFingerprintInput, registry: readonly FingerprintVersion[] = fingerprintRegistry()): FingerprintSet {
  assertRegistry(registry)
  const ordered = [...registry].sort((a, b) => RANK[a.role] - RANK[b.role] || b.v - a.v)
  const computed = ordered.map((entry) => ({ role: entry.role, value: { v: entry.v, checkout: entry.checkout(input), cart: entry.cart(input) } }))
  return {
    current: computed[0].value,
    lock: computed.filter((entry) => entry.role !== 'lookup').map((entry) => entry.value),
    lookup: computed.map((entry) => entry.value),
  }
}
