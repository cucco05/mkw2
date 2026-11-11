// Is the hosted card checkout allowed to take money right now? One list of reasons, used by the quote (to tell the page) and by
// the session endpoint (to refuse). Each reason is a machine-readable code plus an HTTP status.
import { getShippingConfig } from '@/lib/shipping'
import { sanitizeBaseUrl } from '@/lib/public-url'
import { getTaxSalesBlocker } from '@/lib/tax'
import { getCurrencyConfigProblem } from '@/lib/currency'
import { commercialMinimumDecided } from '@/lib/payment-limits'
import { ownerGuardModeOf, unrecognisedGuardFlags } from '@/lib/checkout-flags'

export type CheckoutBlocker = { code: string; message: string; status: number }

type Env = Record<string, string | undefined>

// The hosted checkout can create real Stripe sessions before the webhook that confirms them exists (S2/S3 step 3) and before the
// customer pages exist (step 4). In production it therefore stays OFF until it is switched on on purpose.
export function isHostedCheckoutEnabled(env: Env = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true
  return (env.HOSTED_CHECKOUT_ENABLED || '').trim().toLowerCase() === 'true'
}

// `minimumOrderSubtotal` is the shop's commercial minimum as stored (SiteConfig): pass it once the configuration has been read. `undefined` = not looked
// at (only the environment is checked); `null` = read, and nobody has decided yet.
export function getCheckoutBlocker(input: { shippingMethod: 'pickup' | 'ship'; env?: Env; minimumOrderSubtotal?: number | null }): CheckoutBlocker | null {
  const env = input.env ?? process.env
  if (!isHostedCheckoutEnabled(env)) {
    return { code: 'CHECKOUT_DISABLED', message: 'Online card checkout is not enabled yet.', status: 503 }
  }
  if (!(env.STRIPE_SECRET_KEY || '').trim()) {
    return { code: 'PAYMENTS_NOT_CONFIGURED', message: 'Card payments are not configured.', status: 503 }
  }
  // (R1-3 / KLOSS hardening C) the owner guard's flags must say what the operator meant: in production a value nobody can read stops the card checkout (fail-closed) until it is fixed
  if (checkoutConfigurationProblems(env).some((problem) => problem.kind === 'unrecognised_flag')) {
    return { code: 'CHECKOUT_MISCONFIGURED', message: 'Online card checkout is not available right now.', status: 503 }
  }
  const tax = getTaxSalesBlocker(env)
  if (tax) {
    return { code: 'TAX_NOT_CONFIGURED', message: 'Online sales are not available until the tax configuration is complete.', status: 503 }
  }
  // The shop must choose its minimum order on purpose (0 = none). In production no figure is invented for it: until it is chosen nothing is sold online.
  if (env.NODE_ENV === 'production' && input.minimumOrderSubtotal !== undefined && !commercialMinimumDecided(input.minimumOrderSubtotal)) {
    return { code: 'MINIMUM_ORDER_NOT_CONFIGURED', message: 'Online sales are not available until the minimum order has been set.', status: 503 }
  }
  // What the page shows and what Stripe charges must be the same currency: refuse while the build and the server's configuration disagree.
  const currency = getCurrencyConfigProblem(env)
  if (currency) {
    return { code: currency.code, message: 'Online sales are not available until the currency configuration is consistent.', status: 503 }
  }
  // Stripe sends the customer back to BASE_URL: in production it must be our public https address, never taken from a request.
  if (env.NODE_ENV === 'production' && !sanitizeBaseUrl(env.BASE_URL)?.startsWith('https://')) {
    return { code: 'CHECKOUT_UNAVAILABLE', message: 'Online card checkout is not available right now.', status: 503 }
  }
  if (input.shippingMethod === 'ship' && !getShippingConfig(env).configured) {
    return { code: 'SHIPPING_NOT_CONFIGURED', message: 'Shipping is not available right now.', status: 503 }
  }
  return null
}

// The OLD card checkout (/api/checkout with a PaymentIntent confirmed by the browser) is kept only so the new one can be built
// and compared with it. It creates the order after payment, from the browser, so a customer who closes the page loses the order
// (S3). Its amount is now verified, but it must not take real money in production: there it is OFF unless
// LEGACY_CARD_CHECKOUT_ENABLED=true is set on purpose. Removed for good in step 6 of S2/S3.
//
// (R1-3 / KLOSS hardening C) It is also the one card path that the owner guard of the hosted checkout does not see: it records the order AFTER the payment, with no cart fingerprint, no owner
// lock and none of the arbiters of P2/P3. So, beside the guard:
//   * CHECKOUT_OWNER_GUARD=on     - no card payment of the old checkout: neither a new PaymentIntent nor the finalization of one. The finalization is refused too because the old path does not
//                                   show where a PaymentIntent comes from (it accepts any PaymentIntent paid with the right amount and currency that no recorded order carries - one of the hosted
//                                   checkout not recorded yet, or of another browser's checkout, included);
//   * CHECKOUT_OWNER_GUARD=shadow - EXACTLY as with the guard off: the shadow of P2 changes nothing; the combination is only counted and logged by the route (`besideShadow`);
//   * in production, a guard flag nobody can read: refused, like the hosted checkout (fail-closed).
export type LegacyCardVerdict = { allowed: true; besideShadow: boolean } | { allowed: false; reason: 'disabled' | 'owner_guard' | 'misconfigured' }
export function legacyCardCheckoutVerdict(env: Env = process.env): LegacyCardVerdict {
  const production = env.NODE_ENV === 'production'
  if (production && (env.LEGACY_CARD_CHECKOUT_ENABLED || '').trim().toLowerCase() !== 'true') return { allowed: false, reason: 'disabled' }
  if (production && unrecognisedGuardFlags(env).length > 0) return { allowed: false, reason: 'misconfigured' }
  const owner = ownerGuardModeOf(env)
  if (owner === 'on') return { allowed: false, reason: 'owner_guard' }
  return { allowed: true, besideShadow: owner === 'shadow' }
}
export function isLegacyCardCheckoutEnabled(env: Env = process.env): boolean {
  return legacyCardCheckoutVerdict(env).allowed
}

// (R1-3 / KLOSS hardening C) What the configuration of the owner guard says that nobody meant - the fail-closed check of the checkout and the administrator's environment check read the same list:
//   * `unrecognised_flag` - in production, CHECKOUT_OWNER_GUARD or CHECKOUT_REPEAT_GUARD set to something that is not off / shadow / on: the card checkout is refused (getCheckoutBlocker,
//                           legacyCardCheckoutVerdict). Outside production such a value is "off", as it always was;
//   * `legacy_beside_owner_guard` - the old card checkout switched on while the owner guard is on or in shadow (on: refused by the route; shadow: only told).
export type CheckoutConfigurationProblem = { kind: 'unrecognised_flag'; flags: string[] } | { kind: 'legacy_beside_owner_guard'; mode: 'on' | 'shadow' }
export function checkoutConfigurationProblems(env: Env = process.env): CheckoutConfigurationProblem[] {
  const out: CheckoutConfigurationProblem[] = []
  const production = env.NODE_ENV === 'production'
  const unreadable = unrecognisedGuardFlags(env)
  if (production && unreadable.length > 0) out.push({ kind: 'unrecognised_flag', flags: unreadable })
  const owner = ownerGuardModeOf(env)
  const legacyAsked = !production || (env.LEGACY_CARD_CHECKOUT_ENABLED || '').trim().toLowerCase() === 'true'
  if (legacyAsked && owner !== 'off') out.push({ kind: 'legacy_beside_owner_guard', mode: owner })
  return out
}
