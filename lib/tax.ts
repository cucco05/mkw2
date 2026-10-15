// Tax on an order, kept deliberately small and in one place.
//
// What it does: given the amount subject to tax (items after discounts + shipping, in cents) it says how much tax that
// contains / adds. What it does NOT do: choose a fiscal regime, handle several rates, per-line rounding rules, reverse charge,
// exemptions or invoicing. Those decisions belong to the shop's accountant and come later; the checkout only needs one number
// that the server computes, stores on the order (taxCents) and that therefore ends up in the total Stripe is asked to collect.
//
// Configuration (environment):
//   TAX_MODE          none | inclusive | exclusive     (unset = NOT configured)
//   TAX_RATE_PERCENT  e.g. 22                          (required for inclusive / exclusive)
//   * none       no tax is shown or added (e.g. a regime that does not charge VAT). It is an explicit choice, not a default.
//   * inclusive  listed prices already contain the tax; the tax part is computed for the record, the total is unchanged.
//   * exclusive  the tax is added on top of the listed prices.
//
// A shop that sells with TAX_MODE unset is not ready for commercial use: getTaxSalesBlocker() says so and checkout refuses to
// charge in production until a valid configuration exists.

export type TaxMode = 'none' | 'inclusive' | 'exclusive'

export type TaxConfig = {
  mode: TaxMode
  ratePercent: number
  // true only when the operator made an explicit, valid choice
  configured: boolean
  problem: string | null
}

type Env = Record<string, string | undefined>

export function getTaxConfig(env: Env = process.env): TaxConfig {
  const rawMode = (env.TAX_MODE || '').trim().toLowerCase()
  if (!rawMode) {
    return { mode: 'none', ratePercent: 0, configured: false, problem: 'TAX_MODE is not set' }
  }
  if (rawMode !== 'none' && rawMode !== 'inclusive' && rawMode !== 'exclusive') {
    return { mode: 'none', ratePercent: 0, configured: false, problem: `TAX_MODE "${rawMode}" is not one of none, inclusive, exclusive` }
  }
  if (rawMode === 'none') {
    return { mode: 'none', ratePercent: 0, configured: true, problem: null }
  }
  const rate = Number((env.TAX_RATE_PERCENT || '').trim())
  if (!(env.TAX_RATE_PERCENT || '').trim() || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return { mode: 'none', ratePercent: 0, configured: false, problem: 'TAX_RATE_PERCENT must be a number greater than 0 and at most 100' }
  }
  return { mode: rawMode, ratePercent: rate, configured: true, problem: null }
}

export type TaxResult = {
  // tax contained in (inclusive) or added to (exclusive) the amount; what is stored in PrintOrder.taxCents
  taxCents: number
  // what the customer pays on top of the amount: 0 for none/inclusive, the tax for exclusive
  addedCents: number
}

export function computeTax(taxableCents: number, config: TaxConfig = getTaxConfig()): TaxResult {
  const base = Math.max(0, Math.round(taxableCents))
  if (config.mode === 'exclusive') {
    const tax = Math.round((base * config.ratePercent) / 100)
    return { taxCents: tax, addedCents: tax }
  }
  if (config.mode === 'inclusive') {
    const tax = Math.round((base * config.ratePercent) / (100 + config.ratePercent))
    return { taxCents: tax, addedCents: 0 }
  }
  return { taxCents: 0, addedCents: 0 }
}

// In production, charging customers without a valid tax configuration is refused. Elsewhere (development, tests) it is allowed
// so that the rest of the system can be built and tried before the fiscal setup exists.
export function getTaxSalesBlocker(env: Env = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null
  const config = getTaxConfig(env)
  return config.configured ? null : `Tax configuration is missing or invalid (${config.problem}). Online sales are disabled until it is set.`
}
