// Strong checkout keys for the tests (R1-1b).
//
// The payment route now takes a GUEST's checkout key only if it has the shape a browser makes (lib/checkout-key-format.ts: "k" + 32 base64url characters, at least 16 of them
// different) - anything else is refused before a single thing is read or written. The tests used to make keys such as "gs-key-000001-abcdefghij", which only fit the broad shape the
// route took before; such a key would now be refused and the test would not be about what it says it is about.
//
// `strongTestKey(label)` makes a key of the strong shape from a label. It is DETERMINISTIC (the same label is the same key, in every run and in every process, so a test can send
// "the same key" again by naming it again and a failing run names the same key every time) and it is only a SHAPE: nothing here is random, and nothing in the product may use it.
import { createHash } from 'node:crypto'
import { checkoutKeyFromBytes, isStrongCheckoutKey } from '../../lib/checkout-key-format'

export function strongTestKey(label: string): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const bytes = createHash('sha256').update(`mw-test-checkout-key:${label}:${attempt}`).digest().subarray(0, 24)
    const key = checkoutKeyFromBytes(bytes)
    if (isStrongCheckoutKey(key)) return key
  }
  throw new Error(`no strong test key for "${label}"`)
}
