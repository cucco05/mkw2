// Can the shop make this cart line AUTOMATICALLY, so that the customer may pay for it online? A pure function of the line and of the machines
// (rows of PrinterMachine: data, not code). Anything that cannot be established reliably is NOT accepted: the line goes to a person for a
// manual review instead of being priced as if it were an ordinary PLA print.
//
//   * material: it must be one the shop knows (MATERIAL_OPTIONS) AND one an active machine can print. An unknown name is never priced as PLA.
//   * finish: it must be one the shop has a price for (lib/pricing.ts knownFinishes) AND one an active machine offers. Never "standard" by default.
//   * size: from the stored size of the model or of the PART (never from the browser) times the validated scale of each axis. The size must be
//     known, in millimetres and plausible; the thinnest extent must be printable; and the model must fit the usable volume in at least one of
//     the six axis-aligned orientations, after the technical margins (and the extra margin for supports when they may be needed).
//     There is no slicing here: a model that does not clearly fit goes to a person, and it is never resized or split automatically.
//
// The line is accepted if at least ONE active machine can make it entirely; otherwise the reasons of the closest machine are returned.
import { MATERIAL_OPTIONS } from '@/lib/cartPricing'
import { roundToTenthMm, scaledSize, sizeOf, type AxisScales, type SizeMm, type SizeSource } from '@/lib/geometry'

export type MachineProfile = {
  key: string
  label: string
  build: SizeMm
  marginXYmm: number
  marginZmm: number
  supportMarginXYmm: number
  nozzleDiameterMm: number
  minFeatureMm: number | null
  maxSupportRatio: number | null
  allowedMaterials: string[]
  allowedFinishes: string[]
}

export type ReviewCode =
  | 'NO_ACTIVE_MACHINE'
  | 'MATERIAL_UNKNOWN'
  | 'MATERIAL_NOT_AVAILABLE'
  | 'FINISH_UNKNOWN'
  | 'FINISH_NOT_AVAILABLE'
  | 'SIZE_UNKNOWN'
  | 'UNIT_NOT_MM'
  | 'SIZE_IMPLAUSIBLE'
  | 'TOO_LARGE'
  | 'TOO_THIN'
  | 'SUPPORT_HEAVY'

export type ReviewReason = {
  code: ReviewCode
  // what the customer is told, in whole millimetres (no internal figure beyond the machine's usable volume)
  sizeMm?: SizeMm
  usableMm?: SizeMm
  value?: string
}

export type LineToCheck = {
  // as asked for (the customer's choice, or the product's locked one)
  material: string | null | undefined
  finish: string | null | undefined
  // the model, or the PART being sold: its stored size and the scales the server validated
  reference: SizeSource | null | undefined
  scales: AxisScales
  // the unit the stored size is expressed in (Model.unit); anything but millimetres cannot be trusted as it is
  modelUnit?: string | null
  supportRatio?: number | null
}

export type PrintabilityOptions = {
  knownFinishes: string[]
  // set to false to leave the size out (only materials and finishes are checked)
  checkGeometry?: boolean
}

export type LineVerdict =
  | { ok: true; machineKey: string; material: string; finish: string; printedSizeMm: SizeMm | null }
  | { ok: false; reasons: ReviewReason[] }

// Extents outside this range (of the STORED, unscaled size) almost always mean a file exported in another unit (metres, inches, micrometres).
export const PLAUSIBLE_MIN_EXTENT_MM = 1
export const PLAUSIBLE_MAX_EXTENT_MM = 3000
// A support ratio at or below this is treated as "no supports needed"; null (never analysed) is treated as "supports may be needed".
const SUPPORT_NEGLIGIBLE = 0.02

export function resolveMaterialKey(raw: string | null | undefined): string | null {
  const key = String(raw ?? '').trim().toUpperCase()
  return (MATERIAL_OPTIONS as readonly string[]).includes(key) ? key : null
}

export function resolveFinishKey(raw: string | null | undefined, known: string[]): string | null {
  const key = String(raw ?? '').trim().toLowerCase()
  if (!key) return 'standard'
  return known.map((entry) => entry.toLowerCase()).includes(key) ? key : null
}

const whole = (size: SizeMm): SizeMm => ({ x: Math.round(size.x), y: Math.round(size.y), z: Math.round(size.z) })

// The volume left for the model once the margins are taken away.
export function usableVolume(machine: MachineProfile, supportsMayBeNeeded: boolean): SizeMm {
  const xy = 2 * (machine.marginXYmm + (supportsMayBeNeeded ? machine.supportMarginXYmm : 0))
  return {
    x: Math.max(0, machine.build.x - xy),
    y: Math.max(0, machine.build.y - xy),
    z: Math.max(0, machine.build.z - machine.marginZmm),
  }
}

const PERMUTATIONS: Array<[keyof SizeMm, keyof SizeMm, keyof SizeMm]> = [
  ['x', 'y', 'z'], ['x', 'z', 'y'], ['y', 'x', 'z'], ['y', 'z', 'x'], ['z', 'x', 'y'], ['z', 'y', 'x'],
]

// Does a box of this size fit the usable volume in some axis-aligned orientation? (The three sides are tried against the three axes.)
export function fitsInAnyOrientation(printed: SizeMm, usable: SizeMm): boolean {
  return PERMUTATIONS.some(([a, b, c]) => printed[a] <= usable.x + 1e-9 && printed[b] <= usable.y + 1e-9 && printed[c] <= usable.z + 1e-9)
}

// Reasons that do not depend on which machine would make the line: what the stored size is worth.
function sizeReliability(line: LineToCheck): { reasons: ReviewReason[]; size: SizeMm | null } {
  const size = sizeOf(line.reference)
  if (!size) return { reasons: [{ code: 'SIZE_UNKNOWN' }], size: null }
  const unit = String(line.modelUnit ?? 'mm').trim().toLowerCase()
  if (unit && unit !== 'mm') return { reasons: [{ code: 'UNIT_NOT_MM', value: unit }], size }
  const biggest = Math.max(size.x, size.y, size.z)
  const smallest = Math.min(size.x, size.y, size.z)
  if (biggest < PLAUSIBLE_MIN_EXTENT_MM || biggest > PLAUSIBLE_MAX_EXTENT_MM || smallest <= 0) return { reasons: [{ code: 'SIZE_IMPLAUSIBLE', sizeMm: whole(size) }], size }
  return { reasons: [], size }
}

function machineReasons(line: LineToCheck, machine: MachineProfile, material: string, finish: string, printed: SizeMm | null, geometry: boolean): ReviewReason[] {
  const reasons: ReviewReason[] = []
  if (!machine.allowedMaterials.map((entry) => entry.toUpperCase()).includes(material)) reasons.push({ code: 'MATERIAL_NOT_AVAILABLE', value: material })
  if (!machine.allowedFinishes.map((entry) => entry.toLowerCase()).includes(finish)) reasons.push({ code: 'FINISH_NOT_AVAILABLE', value: finish })
  if (!geometry || !printed) return reasons
  const ratio = line.supportRatio
  const supportsMayBeNeeded = ratio == null || !Number.isFinite(Number(ratio)) || Number(ratio) > SUPPORT_NEGLIGIBLE
  const usable = usableVolume(machine, supportsMayBeNeeded)
  const thinnest = machine.minFeatureMm ?? machine.nozzleDiameterMm
  if (Math.min(printed.x, printed.y, printed.z) < thinnest) reasons.push({ code: 'TOO_THIN', sizeMm: { x: roundToTenthMm(printed.x), y: roundToTenthMm(printed.y), z: roundToTenthMm(printed.z) } })
  if (!fitsInAnyOrientation(printed, usable)) reasons.push({ code: 'TOO_LARGE', sizeMm: whole(printed), usableMm: whole(usable) })
  if (machine.maxSupportRatio != null && ratio != null && Number.isFinite(Number(ratio)) && Number(ratio) > machine.maxSupportRatio) reasons.push({ code: 'SUPPORT_HEAVY', value: String(Math.round(Number(ratio) * 100)) })
  return reasons
}

export function evaluateLine(line: LineToCheck, machines: MachineProfile[], options: PrintabilityOptions): LineVerdict {
  const geometry = options.checkGeometry !== false
  const active = machines
  if (active.length === 0) return { ok: false, reasons: [{ code: 'NO_ACTIVE_MACHINE' }] }
  const material = resolveMaterialKey(line.material)
  if (!material) return { ok: false, reasons: [{ code: 'MATERIAL_UNKNOWN', value: String(line.material ?? '').slice(0, 40) }] }
  const finish = resolveFinishKey(line.finish, options.knownFinishes)
  if (!finish) return { ok: false, reasons: [{ code: 'FINISH_UNKNOWN', value: String(line.finish ?? '').slice(0, 40) }] }

  const reliability = geometry ? sizeReliability(line) : { reasons: [] as ReviewReason[], size: null }
  const printed = geometry && reliability.size && reliability.reasons.length === 0 ? scaledSize(reliability.size, line.scales) : null

  let best: ReviewReason[] | null = null
  for (const machine of active) {
    const reasons = machineReasons(line, machine, material, finish, printed, geometry)
    if (reasons.length === 0 && reliability.reasons.length === 0) {
      return { ok: true, machineKey: machine.key, material, finish, printedSizeMm: printed ? { x: roundToTenthMm(printed.x), y: roundToTenthMm(printed.y), z: roundToTenthMm(printed.z) } : null }
    }
    if (!best || reasons.length < best.length) best = reasons
  }
  return { ok: false, reasons: [...reliability.reasons, ...(best ?? [])] }
}
