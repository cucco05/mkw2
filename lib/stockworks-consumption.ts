import { prisma } from '@/lib/db'
import { estimatePricingDetails } from '@/lib/pricing'
import { normalizeOrderStatus } from '@/lib/order-status'
import { stockworksJson, stockworksList } from '@/lib/stockworks-client'
import { refundOperationBlocksWhere, releaseDecision } from '@/lib/order-payment-policy'
import { withFinancialRevision } from '@/lib/financial-revision'
import { BAD_RESPONSE, beginEffects, confirmEffectByProof, readJournal, type EffectOutcome, type ExternalEffectRecord } from '@/lib/external-effects'
import { noteRefusal, runGuardedEffect, withReleaseLock } from '@/lib/production-release'

const MATERIAL_KEY_ALIASES: Record<string, string> = {
  PLA: 'PLA',
  PETG: 'PETG',
  ABS: 'ABS',
  ASA: 'ASA',
  TPU: 'TPU',
  NYLON: 'NYLON',
  PA6: 'PA6',
  PA12: 'PA12',
  PC: 'PC',
  RESIN: 'RESIN',
}

export type InventoryItem = {
  id: number
  quantity_grams: number
  reorder_level: number
  location: string
  material?: {
    id: number
    name: string
    filament_type?: string | null
    color?: string | null
  } | null
}

export type ConsumptionLine = {
  inventory_item_id: number
  change_grams: number
  movement_type: 'outgoing'
  reference: string
  note?: string
}

function normalizeMaterialKey(value?: string | null) {
  const raw = (value || '').trim().toUpperCase()
  if (!raw) return 'PLA'
  if (raw in MATERIAL_KEY_ALIASES) return raw
  if (raw.includes('PA6')) return 'PA6'
  if (raw.includes('PA12')) return 'PA12'
  if (raw.includes('NYLON')) return 'NYLON'
  if (raw.includes('TPU')) return 'TPU'
  if (raw.includes('ASA')) return 'ASA'
  if (raw.includes('ABS')) return 'ABS'
  if (raw.includes('PC')) return 'PC'
  return 'PLA'
}

function normalizeColor(value?: string | null) {
  return (value || '').trim().toLowerCase()
}

function resolveScale(config: any) {
  if (!config || typeof config !== 'object') return { sx: 1, sy: 1, sz: 1 }
  const sx = Number(config.scaleX ?? config.scale ?? 1)
  const sy = Number(config.scaleY ?? config.scale ?? 1)
  const sz = Number(config.scaleZ ?? config.scale ?? 1)
  return {
    sx: Number.isFinite(sx) && sx > 0 ? sx : 1,
    sy: Number.isFinite(sy) && sy > 0 ? sy : 1,
    sz: Number.isFinite(sz) && sz > 0 ? sz : 1,
  }
}

function extractSlicerStats(metadata: Record<string, any> | null) {
  const raw = metadata?.slicerStats
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const materials = Array.isArray((raw as any).materials) ? (raw as any).materials : []
  if (!materials.length) return null
  return materials
    .map((entry: any) => {
      if (!entry || typeof entry !== 'object') return null
      const material = typeof entry.material === 'string' ? entry.material : null
      const grams = Number(entry.grams)
      if (!material || !Number.isFinite(grams) || grams <= 0) return null
      const colors = Array.isArray(entry.colors)
        ? entry.colors.filter((c: any) => typeof c === 'string')
        : typeof entry.color === 'string'
          ? [entry.color]
          : []
      return { material, colors, grams }
    })
    .filter(Boolean) as { material: string; colors: string[]; grams: number }[]
}

function buildConsumptionFromSlicerStats(
  metadata: Record<string, any> | null,
  inventory: InventoryItem[],
  reference: string,
): ConsumptionLine[] {
  const entries = extractSlicerStats(metadata)
  if (!entries || entries.length === 0) return []
  const lines: ConsumptionLine[] = []
  for (const entry of entries) {
    const materialKey = normalizeMaterialKey(entry.material)
    lines.push(...buildConsumptionLines(inventory, materialKey, entry.colors, entry.grams, reference))
  }
  return lines
}

function buildConsumptionLines(
  inventory: InventoryItem[],
  materialKey: string,
  colors: string[],
  grams: number,
  reference: string,
): ConsumptionLine[] {
  if (!Number.isFinite(grams) || grams <= 0) return []
  const normalizedColors = colors.map(normalizeColor).filter(Boolean)
  const fallback = inventory.find((item) => normalizeMaterialKey(item.material?.filament_type) === materialKey)
  const lines: ConsumptionLine[] = []

  if (normalizedColors.length === 0) {
    if (!fallback) return []
    lines.push({
      inventory_item_id: fallback.id,
      change_grams: -Math.abs(Number(grams.toFixed(1))),
      movement_type: 'outgoing',
      reference,
      note: `Auto consumption for ${materialKey} (no color specified).`,
    })
    return lines
  }

  const perColor = grams / normalizedColors.length
  for (const color of normalizedColors) {
    const match = inventory.find((item) =>
      normalizeMaterialKey(item.material?.filament_type) === materialKey
      && normalizeColor(item.material?.color) === color
    ) || fallback
    if (!match) continue
    lines.push({
      inventory_item_id: match.id,
      change_grams: -Math.abs(Number(perColor.toFixed(1))),
      movement_type: 'outgoing',
      reference,
      note: `Auto consumption for ${materialKey} (${color || 'unknown color'}).`,
    })
  }
  return lines
}

export async function buildConsumptionLinesForOrder(
  order: {
    id: string
    orderNumber: number | null
    metadata?: unknown
    items: Array<{
      modelId?: string | null
      partId?: string | null
      material?: string | null
      colors?: any
      infillPct?: number | null
      finish?: string | null
      quantity?: number | null
      configuration?: any
    }>
  },
  cfg: any,
  inventory: InventoryItem[],
  reference: string,
) {
  const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
    ? (order.metadata as Record<string, any>)
    : null
  const slicerLines = buildConsumptionFromSlicerStats(metadata, inventory, reference)
  if (slicerLines.length > 0) {
    return { lines: slicerLines, source: 'slicer_stats' as const }
  }

  const consumption: ConsumptionLine[] = []
  const modelIds = Array.from(new Set(order.items.map((i) => i.modelId).filter(Boolean))) as string[]
  const partIds = Array.from(new Set(order.items.map((i) => i.partId).filter(Boolean))) as string[]
  const [models, parts] = await Promise.all([
    modelIds.length ? prisma.model.findMany({ where: { id: { in: modelIds } }, select: { id: true, volumeMm3: true, supportRatio: true } }) : [],
    partIds.length ? prisma.modelPart.findMany({ where: { id: { in: partIds } }, select: { id: true, volumeMm3: true, supportRatio: true, modelId: true } }) : [],
  ])
  const modelMap = new Map(models.map((m) => [m.id, m]))
  const partMap = new Map(parts.map((p) => [p.id, p]))

  for (const item of order.items) {
    const qty = Math.max(1, item.quantity || 1)
    const part = item.partId ? partMap.get(item.partId) : null
    const model = item.modelId ? modelMap.get(item.modelId) : null
    const volumeMm3 = part?.volumeMm3 ?? model?.volumeMm3
    if (!volumeMm3 || !Number.isFinite(Number(volumeMm3))) continue
    const supportRatio = part?.supportRatio ?? model?.supportRatio ?? null
    const { sx, sy, sz } = resolveScale(item.configuration)
    const volumeMultiplier = sx * sy * sz
    const cm3 = (Number(volumeMm3) / 1000) * volumeMultiplier

    const breakdown = estimatePricingDetails({
      cm3,
      material: item.material ?? undefined,
      infillPct: item.infillPct ?? undefined,
      finish: item.finish ?? undefined,
      supportRatio,
      colorCount: Array.isArray(item.colors) ? item.colors.length : null,
      cfg,
      applyMinimum: false,
    })

    const grams = breakdown.grams * qty
    const materialKey = normalizeMaterialKey(item.material ?? undefined)
    const colors = Array.isArray(item.colors)
      ? item.colors.filter((entry): entry is string => typeof entry === 'string')
      : []
    consumption.push(...buildConsumptionLines(inventory, materialKey, colors, grams, reference))
  }

  return { lines: consumption, source: 'estimate' as const }
}

// ---- taking the material out of stock (step 4.6, S4) ---------------------------------------------------------------------------------------------------
// One movement per line, each recorded in the order's journal BEFORE StockWorks is called (lib/external-effects.ts). The order must be RELEASED to production;
// a movement whose end is unknown (timeout, dropped connection, 5xx) is never written again - it is looked for on StockWorks (a movement with this reference, item and
// amount) and stays uncertain, and reported, if it is not found. A retry after a partial failure writes only the lines that are not done.
const CONSUMABLE_STATUSES = ['shipped', 'completed']
const isConsumableStatus = (status: string) => CONSUMABLE_STATUSES.includes(normalizeOrderStatus(status))
const RECONCILE_TIMEOUT_NOTE = 'looked for on StockWorks by reference, item and amount'

type MovementRecord = { id?: number | string | null; movement_type?: string | null; change_grams?: number | null; reference?: string | null }

export function stockEffectKeys(lines: readonly ConsumptionLine[]): Array<{ key: string; line: ConsumptionLine; occurrence: number }> {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const signature = `${line.reference}:${line.inventory_item_id}:${line.change_grams}`
    const occurrence = seen.get(signature) ?? 0
    seen.set(signature, occurrence + 1)
    return { key: `stockworks:${signature}:${occurrence}`, line, occurrence }
  })
}

function sameMovement(move: MovementRecord, detail: Record<string, unknown>) {
  return String(move?.reference ?? '').trim() === String(detail.reference ?? '').trim()
    && String(move?.movement_type ?? '').toLowerCase() === 'outgoing'
    && Math.abs(Number(move?.change_grams) - Number(detail.changeGrams)) < 0.0001
}

export type StockPresence = { checked: boolean; found: { id: string } | null; problem: string | null }

// Reconciliation BY PRESENCE: the n-th identical line is found if StockWorks shows more than n matching movements. Not found proves nothing.
export async function findStockMovementForEffect(record: Pick<ExternalEffectRecord, 'detail'>, occurrence: number): Promise<StockPresence> {
  try {
    const inventoryItemId = Number(record.detail.inventoryItemId)
    const movements = stockworksList<MovementRecord>(await stockworksJson(`/inventory/${inventoryItemId}/movements`))
    const matches = movements.filter((move) => sameMovement(move, record.detail))
    return matches.length > occurrence ? { checked: true, found: { id: String(matches[occurrence]?.id ?? '') }, problem: null } : { checked: true, found: null, problem: null }
  } catch (err) {
    return { checked: false, found: null, problem: err instanceof Error ? err.message : String(err) }
  }
}

// An administrator names a StockWorks movement as the proof: the SERVER looks it up on StockWorks and checks reference, item and amount.
export async function verifyStockMovementForEffect(record: Pick<ExternalEffectRecord, 'detail'>, movementId: string): Promise<{ verified: boolean; reason: string | null }> {
  try {
    const inventoryItemId = Number(record.detail.inventoryItemId)
    const movements = stockworksList<MovementRecord>(await stockworksJson(`/inventory/${inventoryItemId}/movements`))
    const named = movements.find((move) => String(move?.id ?? '') === movementId.trim())
    if (!named) return { verified: false, reason: 'StockWorks does not list a movement with that identifier for this inventory item.' }
    return sameMovement(named, record.detail)
      ? { verified: true, reason: null }
      : { verified: false, reason: 'That StockWorks movement does not have this order\'s reference, item and amount.' }
  } catch (err) {
    return { verified: false, reason: `StockWorks could not be asked: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export type StockConsumeResult =
  | { ok: true; movements: number }
  | {
    ok: false
    reason: 'order_not_found' | 'status_not_consumable' | 'already_consumed' | 'no_consumption_lines' | 'not_released' | 'in_progress' | 'outcome_unknown' | 'stopped' | 'movement_failed'
    code?: string
    releaseState?: string
    errors?: string[]
    movements?: number
  }

export async function maybeConsumeStockForOrder(orderId: string, trigger: string): Promise<StockConsumeResult> {
  const order = await prisma.printOrder.findUnique({
    where: { id: orderId },
    include: { items: true, paymentAttempts: true, refundOperations: { where: refundOperationBlocksWhere } },
  })
  if (!order) return { ok: false, reason: 'order_not_found' }

  if (!isConsumableStatus(order.status)) return { ok: false, reason: 'status_not_consumable' }

  const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
    ? (order.metadata as Record<string, any>)
    : {}
  if (metadata.stockworksConsumedAt) return { ok: false, reason: 'already_consumed' }

  // Material is taken out of stock for an order that is RELEASED to production, not for one that was only moved to "completed" by a signal.
  const early = releaseDecision(order)
  if (!early.released) {
    noteRefusal('stock-consume', order.id, early, early.code ?? 'NOT_RELEASED')
    return { ok: false, reason: 'not_released', code: early.code ?? undefined, releaseState: early.state }
  }

  const [cfg, inventory] = await Promise.all([
    prisma.siteConfig.findUnique({ where: { id: 'main' } }),
    stockworksJson('/inventory').then((payload) => stockworksList<InventoryItem>(payload)),
  ])

  const reference = order.orderNumber ? `MW-${String(order.orderNumber).padStart(5, '0')}` : order.id
  const { lines: consumption, source } = await buildConsumptionLinesForOrder(order, cfg, inventory, reference)

  if (consumption.length === 0) {
    return { ok: false, reason: 'no_consumption_lines' }
  }
  const keyed = stockEffectKeys(consumption)

  // ---- A. under the lock: released, still consumable, not consumed, and an intent for every line that has to be written ----
  type Begun = { kind: 'skip'; reason: 'status_not_consumable' | 'already_consumed' | 'in_progress' } | { kind: 'go'; verdicts: ReturnType<typeof beginEffects>['verdicts'] }
  let begun: Begun
  try {
    begun = await withReleaseLock(order.id, 'stock-consume', async ({ tx, order: fresh }): Promise<Begun> => {
      if (!isConsumableStatus(fresh.status)) return { kind: 'skip', reason: 'status_not_consumable' }
      const freshMetadata = fresh.metadata && typeof fresh.metadata === 'object' && !Array.isArray(fresh.metadata) ? fresh.metadata as Record<string, any> : {}
      if (freshMetadata.stockworksConsumedAt) return { kind: 'skip', reason: 'already_consumed' }
      const result = beginEffects(fresh.metadata, keyed.map(({ key, line }) => ({
        key,
        kind: 'stockworks_movement' as const,
        by: trigger,
        adminId: null,
        detail: { reference: line.reference, inventoryItemId: line.inventory_item_id, changeGrams: line.change_grams },
      })), { metadataLost: fresh.metadata === null })
      if (Object.values(result.verdicts).some((entry) => entry.verdict === 'in_progress')) return { kind: 'skip', reason: 'in_progress' }
      if (Object.values(result.verdicts).some((entry) => entry.verdict !== 'already_done')) {
        await tx.printOrder.update({ where: { id: order.id }, data: withFinancialRevision(fresh, { metadata: result.metadata as any }) })
      }
      return { kind: 'go', verdicts: result.verdicts }
    }, { require: 'released' })
  } catch (err: any) {
    if (err?.name === 'ProductionReleaseError' && err.status === 409) return { ok: false, reason: 'not_released', code: err.code, releaseState: err.releaseState ?? undefined }
    throw err
  }
  if (begun.kind === 'skip') return { ok: false, reason: begun.reason }

  const errors: string[] = []
  let confirmedNow = 0

  // ---- B. lines whose earlier attempt is unknown: look for them on StockWorks (presence only) ----
  for (const { key, occurrence } of keyed) {
    const verdict = begun.verdicts[key]
    if (verdict.verdict !== 'unknown_outcome') continue
    const presence = await findStockMovementForEffect(verdict.record, occurrence)
    if (presence.found) {
      await withReleaseLock(order.id, 'stock-consume', async ({ tx, order: fresh }) => {
        const proven = confirmEffectByProof(fresh.metadata, key, { externalId: presence.found!.id, confirmedBy: 'reconciliation', note: RECONCILE_TIMEOUT_NOTE })
        if (proven.applied) await tx.printOrder.update({ where: { id: order.id }, data: withFinancialRevision(fresh, { metadata: proven.metadata as any }) })
      }, { require: 'none' })
      confirmedNow += 1
      continue
    }
    errors.push(`${key}: the outcome of an earlier attempt is not known${presence.checked ? ' and StockWorks does not list the movement' : ` (StockWorks could not be asked: ${presence.problem})`}; it was NOT written again.`)
  }

  // ---- C. lines with a fresh intent: check again right before each call, write the movement, record how it ended ----
  const toWrite = keyed.filter(({ key }) => begun.verdicts[key].verdict === 'proceed')
  const owned = toWrite.map(({ key }) => ({ key, intentId: begun.verdicts[key].record.intentId }))
  let stopped = false
  for (let index = 0; index < toWrite.length; index++) {
    const { key, line } = toWrite[index]
    const run = await runGuardedEffect<any>({
      orderId: order.id,
      action: 'stock-consume',
      key,
      intentId: begun.verdicts[key].record.intentId,
      owned: owned.slice(index),
      statusOk: isConsumableStatus,
      call: () => stockworksJson('/movements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(line),
      }),
      interpret: (movement): EffectOutcome => (movement && typeof movement === 'object' && !Array.isArray(movement)
        ? { state: 'confirmed', externalId: movement.id != null ? String(movement.id) : null, httpStatus: 200 }
        : { state: 'uncertain', cause: BAD_RESPONSE.cause, message: BAD_RESPONSE.message, httpStatus: null }),
    })
    if (!run.ran) { stopped = true; errors.push(`${key}: not written - the order is no longer released to production (or no longer completed).`); break }
    if (run.outcome.state === 'confirmed') confirmedNow += 1
    else errors.push(`${key}: ${run.outcome.state === 'uncertain' ? 'the outcome is not known' : run.outcome.state === 'rejected' ? 'refused by StockWorks' : 'not sent'} (${run.outcome.message})`)
  }

  // ---- D. everything confirmed? then the order is marked as consumed - the marker the rest of the system reads ----
  const final = await withReleaseLock(order.id, 'stock-consume', async ({ tx, order: fresh }) => {
    const journal = readJournal(fresh.metadata)
    const all = keyed.every(({ key }) => journal[key]?.state === 'confirmed')
    if (all) {
      const next = {
        ...(fresh.metadata && typeof fresh.metadata === 'object' && !Array.isArray(fresh.metadata) ? fresh.metadata as Record<string, unknown> : {}),
        stockworksConsumedAt: new Date().toISOString(),
        stockworksConsumption: consumption,
        stockworksConsumptionTrigger: trigger,
        stockworksConsumptionSource: source,
      }
      await tx.printOrder.update({ where: { id: order.id }, data: withFinancialRevision(fresh, { metadata: next as any }) })
    }
    return { all, unknown: keyed.some(({ key }) => journal[key]?.state === 'uncertain' || journal[key]?.state === 'intent') }
  }, { require: 'none' })

  if (final.all) return { ok: true, movements: keyed.length }
  return {
    ok: false,
    reason: final.unknown ? 'outcome_unknown' : stopped ? 'stopped' : 'movement_failed',
    errors,
    movements: confirmedNow,
  }
}
