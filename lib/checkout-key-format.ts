// The SHAPE of a checkout key (R1-1a). Pure: no import, no I/O, no clock, no random source, no global state - it runs unchanged in a browser and, later, on a server.
//
// A strong key is "k" + exactly 32 base64url characters (24 random bytes = 192 bits, no padding), at least 16 of them different. That is all this file knows.
//   * The "at least 16 different" rule is a FILTER against degenerate keys (a constant, a short cycle, the same byte every time). Genuine random bytes fail it about 1.5 times in
//     10 million, so a few redraws are always enough (tests/checkout-key-format.test.ts computes the exact figure).
//   * A key that passes is only WELL-FORMED. This code can not tell random bytes from a predictable but varied sequence (a counter passes). The safety of a key rests on
//     where its bytes come from - crypto.getRandomValues, lib/checkout-client.ts - never on its shape. Nobody may read "isStrongCheckoutKey" as "unpredictable".
// No hash for the server's per-purchase table is made here: that is lib/purchase-intent.ts (R1-1b), which asks this file whether a key is strong before it makes one.

export const CHECKOUT_KEY_PREFIX = 'k'
export const CHECKOUT_KEY_RANDOM_BYTES = 24
export const CHECKOUT_KEY_BODY_LENGTH = 32
export const MIN_DISTINCT_BODY_CHARS = 16
export const STRONG_CHECKOUT_KEY_PATTERN = /^k[A-Za-z0-9_-]{32}$/

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const isByte = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255

/** How many different characters follow the one-character prefix. 0 for anything that is not a string. */
export function distinctBodyChars(key: string): number {
  if (typeof key !== 'string') return 0
  return new Set(key.slice(1)).size
}

/** True for "k" + 32 base64url characters with at least 16 different ones. A shape check, NOT a proof of randomness (see the top of the file). */
export function isStrongCheckoutKey(value: unknown): value is string {
  return typeof value === 'string' && STRONG_CHECKOUT_KEY_PATTERN.test(value) && distinctBodyChars(value) >= MIN_DISTINCT_BODY_CHARS
}

/**
 * "k" + the base64url of exactly 24 bytes, written by hand so that it does not lean on btoa or Buffer. Anything that is not exactly 24 integers between 0 and 255 gives ""
 * - no key at all - and the function never throws. It does not check that the result is strong: the caller does (isStrongCheckoutKey).
 */
export function checkoutKeyFromBytes(bytes: ArrayLike<number>): string {
  try {
    if (bytes === null || typeof bytes !== 'object' || bytes.length !== CHECKOUT_KEY_RANDOM_BYTES) return ''
    let body = ''
    for (let i = 0; i < CHECKOUT_KEY_RANDOM_BYTES; i += 3) {
      const a = bytes[i]
      const b = bytes[i + 1]
      const c = bytes[i + 2]
      if (!isByte(a) || !isByte(b) || !isByte(c)) return ''
      body += BASE64URL[a >> 2] + BASE64URL[((a & 3) << 4) | (b >> 4)] + BASE64URL[((b & 15) << 2) | (c >> 6)] + BASE64URL[c & 63]
    }
    return CHECKOUT_KEY_PREFIX + body
  } catch {
    return ''
  }
}
