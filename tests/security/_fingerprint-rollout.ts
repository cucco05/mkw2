// The registries of the PHASES of a rollout of a new version of the cart fingerprint (lib/cart-fingerprint.ts), with a version of the TEST's own - version 9, another canonicalisation of the same
// purchase - that is never registered in production. A child process of tests/security/cart-fingerprint-rollout.sec.ts puts one of them in the seam (cartFingerprintHooks.registry) to play an
// instance of that phase (tests/security/_dr13-child.ts, CHILD_FINGERPRINT_PHASE). Not a test file (its name matches no test pattern).
import { createHash } from 'node:crypto'
import { CART_FINGERPRINT_REGISTRY, cartFingerprint, checkoutFingerprint, type FingerprintVersion } from '../../lib/cart-fingerprint'

export type RolloutPhase = 'before' | 'phase1' | 'phase2' | 'after'
export const TEST_VERSION = 9
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const v9 = { v: TEST_VERSION, cart: (input: Parameters<typeof cartFingerprint>[0]) => sha(`test-v9:${cartFingerprint(input)}`), checkout: (input: Parameters<typeof checkoutFingerprint>[0]) => sha(`test-v9:${checkoutFingerprint(input)}`) }
const [v2, v1] = CART_FINGERPRINT_REGISTRY
const as = (entry: Omit<FingerprintVersion, 'role'>, role: FingerprintVersion['role']): FingerprintVersion => Object.freeze({ v: entry.v, cart: entry.cart, checkout: entry.checkout, role })

export function rolloutRegistry(phase: string): readonly FingerprintVersion[] {
  switch (phase) {
    case 'before': return CART_FINGERPRINT_REGISTRY                                     // an instance that does not know version 9
    case 'phase1': return [as(v2, 'current'), as(v9, 'lookup'), as(v1, 'lookup')]          // knows it, does not write it
    case 'phase2': return [as(v9, 'current'), as(v2, 'transitional'), as(v1, 'lookup')]    // writes it; still locks and finds version 2
    case 'after': return [as(v9, 'current'), as(v2, 'lookup'), as(v1, 'lookup')]
    default: throw new Error(`unknown rollout phase ${phase}`)
  }
}
