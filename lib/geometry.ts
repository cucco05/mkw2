// The size of what is being sold, in millimetres, from DATA THE SERVER HOLDS (the model or the part row) and the scale the server validated.
// Nothing a browser sends about millimetres is ever read: a size dictated by the browser could shrink a price or hide a part that does not
// fit the machine. Used by the checkout price (lib/checkout-quote.ts) and by the build-volume check (lib/printability.ts).
export type SizeMm = { x: number; y: number; z: number }
export type SizeSource = { sizeXmm?: number | null; sizeYmm?: number | null; sizeZmm?: number | null }
export type AxisScales = { x: number; y: number; z: number }

// The stored size of a model or of ONE part, or null when any axis is missing, not a number, zero or negative.
export function sizeOf(source?: SizeSource | null): SizeMm | null {
  if (!source) return null
  const x = Number(source.sizeXmm)
  const y = Number(source.sizeYmm)
  const z = Number(source.sizeZmm)
  if (![x, y, z].every((value) => Number.isFinite(value) && value > 0)) return null
  return { x, y, z }
}

// The size a part is printed at: its own stored size (never the whole model's) times the validated scale of each axis.
export function scaledSize(size: SizeMm, scales: AxisScales): SizeMm {
  return { x: size.x * scales.x, y: size.y * scales.y, z: size.z * scales.z }
}

export const roundToTenthMm = (value: number) => Math.round(value * 10) / 10
