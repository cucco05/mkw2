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

// ---- Is the currency configuration safe to take money with? -------------------------------------------------------------------
// The pages the browser shows (catalogue, product page, cart totals before the quote) read NEXT_PUBLIC_CURRENCY AT BUILD TIME: the value is
// written into the JavaScript when `next build` runs. The server (quote, order, Stripe) reads the environment when it runs. If the two differ
// (a Docker image built without the variable, an edited .env without a rebuild) the customer could see "$" and be charged in euro, or the
// other way round. next.config.mjs stamps the build with the currency the pages were built for (NEXT_PUBLIC_BUILD_CURRENCY); this compares it
// with what the server is configured for NOW and, in production, requires the currency to be set on purpose (a forgotten variable would
// silently become USD). No amount is ever converted: only the label changes (see docs/PROGETTO.md, "Cambio di valuta").
export type CurrencyProblem = { code: 'CURRENCY_NOT_CONFIGURED' | 'CURRENCY_INVALID' | 'CURRENCY_MISMATCH'; message: string }

const cleanEnv = (value: string | undefined) => (value ?? '').trim().toUpperCase()

export function getCurrencyConfigProblem(
  env: Record<string, string | undefined> = process.env,
  // The currency the browser pages were built for. The default is a literal `process.env.X` on purpose: Next replaces it with the build's value.
  builtWith: string | undefined = process.env.NEXT_PUBLIC_BUILD_CURRENCY,
): CurrencyProblem | null {
  const server = cleanEnv(env.CURRENCY)
  const publicValue = cleanEnv(env.NEXT_PUBLIC_CURRENCY)
  for (const [name, value] of [['CURRENCY', server], ['NEXT_PUBLIC_CURRENCY', publicValue]] as const) {
    if (value && !isSupportedCurrency(value)) {
      return { code: 'CURRENCY_INVALID', message: `${name} is "${value}", which is not a supported currency (USD, CAD, AUD, EUR): it would silently fall back to USD.` }
    }
  }
  if (server && publicValue && server !== publicValue) {
    return { code: 'CURRENCY_MISMATCH', message: `CURRENCY (${server}) and NEXT_PUBLIC_CURRENCY (${publicValue}) differ: the server would charge in one currency and the pages would show another.` }
  }
  const configured = publicValue || server
  if (env.NODE_ENV === 'production' && !configured) {
    return { code: 'CURRENCY_NOT_CONFIGURED', message: 'CURRENCY is not set: in production the shop currency must be chosen on purpose (it would otherwise default to USD).' }
  }
  const built = cleanEnv(builtWith)
  if (built && configured && built !== configured) {
    return { code: 'CURRENCY_MISMATCH', message: `The pages were built for ${built} but the server is configured for ${configured}: rebuild the application (Docker: pass the build argument NEXT_PUBLIC_CURRENCY=${configured}).` }
  }
  return null
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
