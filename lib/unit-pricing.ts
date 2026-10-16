// Money arithmetic of a SOLD UNIT, in whole cents (step 4.6). Pure functions, no database, no currency: the checkout engine
// (lib/checkout-quote.ts) and the model page (lib/model-detail.ts) share them, so that what a page advertises, what the quote
// shows, what the order stores and what Stripe charges are the same integers.
//
// Why integers: a price is shared between the parts of a complete model, and a floor is raised for a unit as a whole. Doing
// that with decimals (x.toFixed(2) line by line) leaves cents that appear or disappear; with the largest-remainder method the
// parts ALWAYS add up to the amount that was shared.

const toInt = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0)

// Shares `totalCents` between the lines in proportion to `weights` (largest remainder: every line gets its integer part, the
// cents that are left go to the lines with the biggest fractions, the earlier line first on a tie). The result adds up to
// `totalCents` exactly and has no negative entry. A weight that is negative, not a number or zero counts as 0; when every
// weight is 0 the total is shared equally.
export function allocateCents(totalCents: number, weights: ReadonlyArray<number>): number[] {
  const count = weights.length
  if (count === 0) return []
  const total = Math.max(0, toInt(totalCents))
  const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0))
  const sum = clean.reduce((acc, weight) => acc + weight, 0)
  const usable = sum > 0 ? clean : clean.map(() => 1)
  const usableSum = sum > 0 ? sum : count
  const exact = usable.map((weight) => (total * weight) / usableSum)
  const parts = exact.map((value) => Math.floor(value))
  let left = total - parts.reduce((acc, value) => acc + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index))
  for (let i = 0; left > 0 && i < order.length; i++, left--) parts[order[i].index] += 1
  // (cannot happen: `left` is always smaller than the number of lines; kept so that a rounding oddity can never lose a cent)
  if (left > 0) parts[0] += left
  return parts
}

// The floor of ONE unit. `lineCents` are the prices of the lines that make one copy of the unit (a single line for a part, a
// whole model or a ready-made product; one line per part for a complete model). When the lines cost less than the minimum
// together, the minimum is shared between them in proportion to what each costs; otherwise nothing changes.
export function floorUnitCents(lineCents: ReadonlyArray<number>, minimumCents: number): { cents: number[]; floored: boolean } {
  const cents = lineCents.map((value) => Math.max(0, toInt(value)))
  const minimum = Math.max(0, toInt(minimumCents))
  const sum = cents.reduce((acc, value) => acc + value, 0)
  if (cents.length === 0 || minimum <= 0 || sum >= minimum) return { cents, floored: false }
  return { cents: allocateCents(minimum, cents), floored: true }
}

// The price of a model shared between its parts, by volume, in whole cents that add up to the model's price. null when it can
// not be done reliably (fewer than two parts, a part with no usable volume): the caller then keeps the part's own price.
export function allocatePartPriceCents(input: { wholePriceCents: number; partVolumes: ReadonlyArray<number | null | undefined> }): number[] | null {
  const { wholePriceCents, partVolumes } = input
  if (partVolumes.length < 2) return null
  const volumes = partVolumes.map((volume) => (volume != null && Number.isFinite(Number(volume)) ? Number(volume) : NaN))
  if (volumes.some((volume) => !(volume > 0))) return null
  if (!Number.isFinite(wholePriceCents) || wholePriceCents < 0) return null
  return allocateCents(wholePriceCents, volumes)
}
