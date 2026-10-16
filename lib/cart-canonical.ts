// The "fingerprint" of a cart (lib/checkout-orders.ts): what lets the server tell "the same purchase again" from "another purchase of the
// same things" without trusting the browser's memory. Pure functions.
//
// Version 2 (step 4.6) makes the fingerprint depend ONLY on what is commercially being bought:
//   * the ORDER of the lines is irrelevant (the lines are sorted);
//   * the random `setKey` that groups the lines of a complete model is irrelevant: a group is named by its CONTENT (a hash of its lines), so a
//     cart rebuilt with new keys, or with the lines in another order, is the same purchase;
//   * anything that changes the commercial content (quantity, options, which lines are grouped) changes it.
import { createHash } from 'crypto'
import { canonicalCartItemsWith, canonicalJson } from '@/lib/cart-canonical-core'

export { canonicalJson }

export function canonicalCartItems(items: ReadonlyArray<{ setKey?: string | null | undefined } & Record<string, unknown>>): unknown[] {
  return canonicalCartItemsWith(items, (text) => createHash('sha256').update(text).digest('hex').slice(0, 16))
}
