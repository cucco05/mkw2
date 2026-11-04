// ONLY for the "lost answer" harness of tests/e2e/checkout-faults.responsive.spec.ts (tests/e2e/_checkout-harness-build.ts substitutes this module for lib/checkout-client.ts in that build and
// in no other). Everything is the real module except cartItemsSignature, which can be told - from the test, once the page is up - to throw:
// that is the way to make the REAL pay() fail inside its own `try`, at the click and BEFORE it has handed anything to sendPurchase (an error that is certainly before the request).
// It is inert until `window.__signatureFault` is set, and the page reads the cart's signature at render time through a memo, so arming it after the mount and disarming it after the click
// does not touch the render.
export * from '../../lib/checkout-client'
import { cartItemsSignature as realCartItemsSignature } from '../../lib/checkout-client'

declare global {
  interface Window { __signatureFault?: boolean }
}

export const cartItemsSignature: typeof realCartItemsSignature = (items) => {
  if (typeof window !== 'undefined' && window.__signatureFault) throw new Error('the cart can not be read (injected by the test)')
  return realCartItemsSignature(items)
}
