// The "option" part of a unit price (tolerance class, product variant), worked out by the SERVER.
//
// Until Step 4.2 the cart line carried a `priceMultiplier` chosen by the browser and the server multiplied the price by it
// (0.1 to 5): anybody could send 0.1 and pay a tenth. The browser may still SHOW a multiplier for its own estimate, but the
// charged price never reads it: the multiplier comes from the two places a customer can legitimately choose it, both kept here:
//   * the tolerance class of a custom part (a fixed table, below), and
//   * a ready-made product (ProductTemplate): its own multiplier times the one of the colour variant picked, both read from the
//     template as stored in the database. A product is also pinned to its locked material/finish/scale (see applyProductTemplate).
import { normalizeMaterialName } from '@/lib/cartPricing'

export const MULTIPLIER_MIN = 0.1
export const MULTIPLIER_MAX = 5

export type ToleranceClass = 'draft' | 'standard' | 'cosmetic' | 'fit_critical'

// Same numbers the instant-quote page shows next to each choice.
export const TOLERANCE_PRICE_MULTIPLIER: Record<ToleranceClass, number> = {
  draft: 0.94,
  standard: 1,
  cosmetic: 1.08,
  fit_critical: 1.16,
}

export function toleranceMultiplier(toleranceClass?: string | null): number {
  if (toleranceClass && Object.prototype.hasOwnProperty.call(TOLERANCE_PRICE_MULTIPLIER, toleranceClass)) {
    return TOLERANCE_PRICE_MULTIPLIER[toleranceClass as ToleranceClass]
  }
  return 1
}

function clampMultiplier(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 1
  return Math.max(MULTIPLIER_MIN, Math.min(MULTIPLIER_MAX, numeric))
}

// The part of a ProductTemplate row the checkout needs.
export type ProductTemplatePricing = {
  id: string
  baseModelId: string | null
  isActive: boolean
  lockedMaterial: string | null
  lockedFinish: string | null
  lockedScale: number
  lockedPriceMultiplier: number
  colorOptions: unknown
}

type ColorOptionRow = { value: string; priceMultiplier: number }

// The colour variants a product offers: `value` (or `label`) is the colour, as in the product page. Rows without a colour are dropped.
export function readColorOptions(raw: unknown): ColorOptionRow[] {
  if (!Array.isArray(raw)) return []
  const rows: ColorOptionRow[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const color = String(record.value ?? record.label ?? '').trim()
    if (!color) continue
    rows.push({ value: color, priceMultiplier: clampMultiplier(record.priceMultiplier ?? 1) })
  }
  return rows
}

export type ProductVariantResult =
  | { ok: true; multiplier: number }
  | { ok: false; reason: 'variant_unavailable' }

// A product's multiplier for the colour picked: the product's own times the variant's, rounded like the product page does.
// When the product lists colour variants, a colour that is not one of them is refused (it would otherwise be priced as "no premium").
export function productMultiplier(template: ProductTemplatePricing, pickedColor: string | null | undefined): ProductVariantResult {
  const base = clampMultiplier(template.lockedPriceMultiplier)
  const options = readColorOptions(template.colorOptions)
  if (options.length === 0) return { ok: true, multiplier: Number(base.toFixed(4)) }
  const wanted = (pickedColor || '').trim().toLowerCase()
  const row = options.find((option) => option.value.toLowerCase() === wanted)
  if (!row) return { ok: false, reason: 'variant_unavailable' }
  return { ok: true, multiplier: Number((base * row.priceMultiplier).toFixed(4)) }
}

// A product is sold as configured by the shop: the material, finish and scale come from the template, not from the cart line
// (the price of a product does not depend on them, so letting the browser pick would hand out another material or size for free).
export function lockedProductConfig(template: ProductTemplatePricing, modelMaterial: string | null | undefined) {
  const scale = Number(template.lockedScale)
  return {
    material: normalizeMaterialName(template.lockedMaterial || modelMaterial || 'PLA'),
    finish: (template.lockedFinish || 'standard').trim().toLowerCase() || 'standard',
    scale: Number.isFinite(scale) && scale > 0 ? Math.max(0.1, Math.min(5, scale)) : 1,
  }
}
