export type Currency = 'USD' | 'CAD' | 'AUD' | 'EUR'

const SUPPORTED_CURRENCIES = new Set<Currency>(['USD', 'CAD', 'AUD', 'EUR'])

export function isSupportedCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && SUPPORTED_CURRENCIES.has(value.toUpperCase() as Currency)
}

// The active currency of the shop. It is a deployment setting (CURRENCY / NEXT_PUBLIC_CURRENCY); the default stays USD until
// it is set explicitly. Switching it does NOT convert anything: the numbers stored in the catalog and in the pricing
// settings are used as they are (see docs/PROGETTO.md, "Cambio di valuta"), and every existing order keeps its own currency.
export function getCurrency(): Currency {
  const env = (process.env.NEXT_PUBLIC_CURRENCY || process.env.CURRENCY || 'USD').toString().toUpperCase()
  return isSupportedCurrency(env) ? env as Currency : 'USD'
}

export function getCurrencySymbol(cur?: Currency): string {
  const c = cur || getCurrency()
  if (c === 'AUD') return 'A$'
  if (c === 'EUR') return '€'
  return c === 'CAD' ? 'CA$' : '$'
}

export function formatCurrency(amount: number, cur?: Currency): string {
  const c = cur || getCurrency()
  const locale = c === 'EUR' ? 'it-IT' : c === 'CAD' ? 'en-CA' : 'en-US'
  return new Intl.NumberFormat(locale, { style: 'currency', currency: c }).format(amount)
}

// Money moves in whole cents everywhere in checkout: convert a decimal amount once, here.
export function toCents(amount: number): number {
  return Math.max(0, Math.round(amount * 100))
}
