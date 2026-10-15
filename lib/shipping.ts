// Shipping, first version: Italy only, ONE flat rate set by the shop (no carrier integration; Shippo comes after launch).
//
//   SHIPPING_FLAT_RATE_CENTS   whole cents, in the shop currency (e.g. 700 = 7.00). "0" is a deliberate choice (free shipping).
//
// A missing or invalid value is NOT treated as "free": shipping simply is not available until it is configured, so a forgotten
// setting can never produce an order that silently ships for nothing.
export const SHIPPING_COUNTRIES = ['IT'] as const
export const SHIPPING_LABEL = 'Spedizione in Italia'

type Env = Record<string, string | undefined>

export type ShippingConfig =
  | { configured: true; cents: number }
  | { configured: false; problem: string }

export function getShippingConfig(env: Env = process.env): ShippingConfig {
  const raw = (env.SHIPPING_FLAT_RATE_CENTS ?? '').trim()
  if (!raw) return { configured: false, problem: 'SHIPPING_FLAT_RATE_CENTS is not set' }
  if (!/^\d{1,7}$/.test(raw)) {
    return { configured: false, problem: 'SHIPPING_FLAT_RATE_CENTS must be a whole number of cents (0 or more)' }
  }
  return { configured: true, cents: Number(raw) }
}

export function isShippingCountryAllowed(country: unknown): boolean {
  return typeof country === 'string' && (SHIPPING_COUNTRIES as readonly string[]).includes(country.trim().toUpperCase())
}
