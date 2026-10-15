// Two different "minimums" that must never be mixed up:
//
//   * the COMMERCIAL minimum order: what the shop decides it is worth taking (SiteConfig.minimumOrderSubtotalUsd, edited by an administrator). It is
//     measured on the value of the PRODUCTS, after discounts, BEFORE shipping and tax. Its amount is the shop's choice - the program never makes one up:
//     in production an unset value stops card payments (checkout-guards.ts) and 0 means "no minimum, on purpose".
//   * the TECHNICAL minimum of the payment provider: the smallest amount Stripe can charge in a currency. It is measured on the TOTAL actually charged
//     (products + shipping + tax added) and is not the shop's decision: below it Stripe refuses the payment, so the order must not even be created.
import type { Currency } from '@/lib/currency'

// Stripe's smallest charge per currency, in minor units (cents). From Stripe's documentation for these four currencies; it is checked against Stripe
// in test mode before launch (docs/CHECKLIST-PRELANCIO.md). STRIPE_MINIMUM_CHARGE_CENTS replaces it for an account that has another limit.
const STRIPE_MINIMUM_CHARGE_CENTS: Record<Currency, number> = { USD: 50, EUR: 50, CAD: 50, AUD: 50 }

export function stripeMinimumChargeCents(currency: Currency, env: Record<string, string | undefined> = process.env): number {
  const override = Number((env.STRIPE_MINIMUM_CHARGE_CENTS ?? '').trim())
  if ((env.STRIPE_MINIMUM_CHARGE_CENTS ?? '').trim() && Number.isInteger(override) && override >= 0 && override <= 100_000) return override
  return STRIPE_MINIMUM_CHARGE_CENTS[currency] ?? 50
}

// Has the shop decided its commercial minimum? `null`/`undefined` = not decided yet; 0 = decided: none; a positive number = that amount.
export function commercialMinimumDecided(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(Number(value)) && Number(value) >= 0
}
