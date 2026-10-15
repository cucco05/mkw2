// Is the hosted card checkout allowed to take money right now? One list of reasons, used by the quote (to tell the page) and by
// the session endpoint (to refuse). Each reason is a machine-readable code plus an HTTP status.
import { getShippingConfig } from '@/lib/shipping'
import { sanitizeBaseUrl } from '@/lib/public-url'
import { getTaxSalesBlocker } from '@/lib/tax'
import { getCurrencyConfigProblem } from '@/lib/currency'
import { commercialMinimumDecided } from '@/lib/payment-limits'

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
export function isLegacyCardCheckoutEnabled(env: Env = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true
  return (env.LEGACY_CARD_CHECKOUT_ENABLED || '').trim().toLowerCase() === 'true'
}
