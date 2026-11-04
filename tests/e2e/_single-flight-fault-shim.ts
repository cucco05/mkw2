// ONLY for the "lost answer" harness of tests/e2e/checkout-faults.responsive.spec.ts (tests/e2e/_checkout-harness-build.ts substitutes this module for lib/checkout-single-flight.ts in that build
// and in no other). Everything is the real module except sendPurchase, which can be told - once, from the test - to behave as if an unexpected error had come out of it AFTER the payment request
// may have gone out:
//   'uncertain'  the REAL request goes out (the stubbed server sees it, the key is the real one, the storage is really written) and what comes back to the page is "fault, uncertain": the answer
//                is lost to an error, which is what this outcome stands for;
//   'reject'     sendPurchase rejects, which the real one never does: it is what the net under the page's call (the catch in pay()) is for.
// Why a shim at all: in the real module no error can come out of the turn once the request has been started (askForSession answers for everything inside it), so the page's reaction to an
// "uncertain" outcome could not be driven from outside in any other way. The real sendPurchase is tried without a browser in tests/checkout-single-flight-faults.test.ts.
export * from '../../lib/checkout-single-flight'
import { sendPurchase as realSendPurchase, type PurchaseOutcome } from '../../lib/checkout-single-flight'

declare global {
  interface Window { __sendPurchaseFault?: 'uncertain' | 'reject' | null }
}

export async function sendPurchase(input: Parameters<typeof realSendPurchase>[0]): Promise<PurchaseOutcome> {
  const fault = window.__sendPurchaseFault
  if (!fault) return realSendPurchase(input)
  window.__sendPurchaseFault = null
  if (fault === 'reject') throw new Error('a mistake nobody expected')
  await realSendPurchase(input)
  return { kind: 'fault', stage: 'uncertain' }
}
