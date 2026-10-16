// Authorised, traced exceptions to the shop's minimum price per unit (step 4.6, S3). The rules, in one place:
//
//   * a waiver is for ONE model or ONE ready-made product (the catalogue level - the only place where the server prices the customer's cart on its own);
//   * only an administrator grants or revokes one, with a written reason, and the grant/revocation and its audit event are written in ONE transaction: if
//     the audit cannot be written the waiver does not exist;
//   * the price engine reads the ACTIVE waivers from the database when it prices a cart (loadActiveWaivers). Nothing a customer sends can name, choose or
//     imply one. A waiver changes ONLY the threshold used in the unit price: it never marks anything paid, authorises production, or touches a payment
//     under review;
//   * NOT retroactive: an order keeps the price it was made with. Granting, revoking, expiring a waiver or changing the shop's minimum never touches an
//     existing order, its lines or its payment attempts (nothing here writes to those tables);
//   * a waiver can only LOWER the floor: the floor of a line is min(waiver, the shop's minimum). If the shop's minimum is later set below a waiver, the waiver
//     simply has no effect.
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { recordAdminAuditEvent, type AdminAuditInput } from '@/lib/admin-audit'
import { resolveMinimumUnitPrice } from '@/lib/pricing'
import { toCents } from '@/lib/currency'

export const WAIVER_REASON_MIN_LENGTH = 10
export const WAIVER_REASON_MAX_LENGTH = 300

type Db = PrismaClient | Prisma.TransactionClient

export type ActiveWaiver = {
  id: string
  modelId: string | null
  productTemplateId: string | null
  minimumPriceCents: number
  expiresAt: Date | null
  createdAt: Date
}

export const isWaiverActive = (waiver: { revokedAt?: Date | null; expiresAt?: Date | null }, now: Date = new Date()) =>
  !waiver.revokedAt && (!waiver.expiresAt || waiver.expiresAt.getTime() > now.getTime())

// The waivers that are in force NOW for these models and products. If (against the rule of one active waiver per target) there are several, the MOST
// RESTRICTIVE one (the highest floor) is used: a duplicate never makes a price lower than the one waiver an administrator meant.
export async function loadActiveWaivers(
  db: Db,
  targets: { modelIds: string[]; productTemplateIds: string[] },
  now: Date = new Date(),
): Promise<{ byModel: Map<string, ActiveWaiver>; byProduct: Map<string, ActiveWaiver> }> {
  const byModel = new Map<string, ActiveWaiver>()
  const byProduct = new Map<string, ActiveWaiver>()
  const modelIds = Array.from(new Set(targets.modelIds))
  const productTemplateIds = Array.from(new Set(targets.productTemplateIds))
  if (modelIds.length === 0 && productTemplateIds.length === 0) return { byModel, byProduct }
  const rows = await db.minimumPriceWaiver.findMany({
    where: {
      revokedAt: null,
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      OR: [
        ...(modelIds.length > 0 ? [{ modelId: { in: modelIds } }] : []),
        ...(productTemplateIds.length > 0 ? [{ productTemplateId: { in: productTemplateIds } }] : []),
      ],
    },
    orderBy: [{ minimumPriceCents: 'desc' }, { createdAt: 'asc' }],
  })
  const keep = (map: Map<string, ActiveWaiver>, key: string, row: ActiveWaiver) => { if (!map.has(key)) map.set(key, row) }
  for (const row of rows) {
    const waiver: ActiveWaiver = { id: row.id, modelId: row.modelId, productTemplateId: row.productTemplateId, minimumPriceCents: row.minimumPriceCents, expiresAt: row.expiresAt, createdAt: row.createdAt }
    if (row.modelId && !row.productTemplateId) keep(byModel, row.modelId, waiver)
    else if (row.productTemplateId && !row.modelId) keep(byProduct, row.productTemplateId, waiver)
  }
  return { byModel, byProduct }
}

// The floor of one unit, in whole cents, and the waiver behind it when it is the waiver that lowered it.
export function effectiveMinimum(commonMinimumCents: number, waiver: ActiveWaiver | undefined | null): { cents: number; waiverId: string | null } {
  const common = Math.max(0, Math.round(commonMinimumCents))
  if (!waiver || !Number.isInteger(waiver.minimumPriceCents) || waiver.minimumPriceCents < 0 || waiver.minimumPriceCents >= common) return { cents: common, waiverId: null }
  return { cents: waiver.minimumPriceCents, waiverId: waiver.id }
}

// A line with a ready-made product counts only the product's waiver; any other line counts only its model's.
export function waiverForLine(
  waivers: { byModel: Map<string, ActiveWaiver>; byProduct: Map<string, ActiveWaiver> },
  modelId: string,
  productTemplateId: string | null | undefined,
): ActiveWaiver | undefined {
  return productTemplateId ? waivers.byProduct.get(productTemplateId) : waivers.byModel.get(modelId)
}

// ---- granting and revoking (administrators only; the routes check the role) -----------------------------------------------------------------------

// Optional second lock: when PRICE_WAIVER_ADMIN_IDS (comma-separated user ids) is set, only those administrators may grant or revoke a waiver.
export function isWaiverAdmin(adminId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = String(env.PRICE_WAIVER_ADMIN_IDS || '').split(',').map((entry) => entry.trim()).filter(Boolean)
  return list.length === 0 || list.includes(adminId)
}

export class WaiverError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

export type WaiverTarget = { modelId: string } | { productTemplateId: string }

export type GrantInput = {
  adminId: string
  target: WaiverTarget
  // the least ONE unit may cost with the waiver, in whole cents
  minimumPriceCents: number
  reason: string
  expiresAt?: Date | null
  audit: Pick<AdminAuditInput, 'requestMethod' | 'requestPath' | 'requestIp' | 'userAgent'>
}

export function cleanReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (reason.length < WAIVER_REASON_MIN_LENGTH) throw new WaiverError('REASON_REQUIRED', `A written reason of at least ${WAIVER_REASON_MIN_LENGTH} characters is required.`)
  if (reason.length > WAIVER_REASON_MAX_LENGTH) throw new WaiverError('REASON_TOO_LONG', `The reason can be at most ${WAIVER_REASON_MAX_LENGTH} characters.`)
  return reason
}

export async function grantWaiver(input: GrantInput) {
  const reason = cleanReason(input.reason)
  const modelId = 'modelId' in input.target ? input.target.modelId : null
  const productTemplateId = 'productTemplateId' in input.target ? input.target.productTemplateId : null
  if ((modelId ? 1 : 0) + (productTemplateId ? 1 : 0) !== 1) throw new WaiverError('TARGET_REQUIRED', 'A waiver is for exactly one model or one product.')
  if (!Number.isInteger(input.minimumPriceCents) || input.minimumPriceCents < 0) throw new WaiverError('INVALID_AMOUNT', 'The minimum price must be a whole number of cents, zero or more.')
  const now = new Date()
  if (input.expiresAt && !(input.expiresAt.getTime() > now.getTime())) throw new WaiverError('INVALID_EXPIRY', 'The expiry must be in the future.')
  return prisma.$transaction(async (tx) => {
    const cfg = await tx.siteConfig.findUnique({ where: { id: 'main' } })
    const commonCents = toCents(resolveMinimumUnitPrice(cfg))
    if (input.minimumPriceCents >= commonCents) {
      throw new WaiverError('NOT_BELOW_MINIMUM', `A waiver must be below the shop's minimum (${commonCents} cents): at or above it there is nothing to waive.`)
    }
    const target = modelId
      ? await tx.model.findUnique({ where: { id: modelId }, select: { id: true, title: true } })
      : await tx.productTemplate.findUnique({ where: { id: productTemplateId as string }, select: { id: true, title: true } })
    if (!target) throw new WaiverError('TARGET_NOT_FOUND', 'The model or product does not exist.', 404)
    // one active waiver per target, even when two grants arrive at the same moment
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`waiver:${modelId ?? productTemplateId}`}, 0))`
    const active = await tx.minimumPriceWaiver.findFirst({
      where: {
        revokedAt: null,
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
        ...(modelId ? { modelId } : { productTemplateId }),
      },
      select: { id: true },
    })
    if (active) throw new WaiverError('ALREADY_ACTIVE', 'This model or product already has an active waiver: revoke it first.', 409)
    const waiver = await tx.minimumPriceWaiver.create({
      data: { modelId, productTemplateId, minimumPriceCents: input.minimumPriceCents, reason, createdById: input.adminId, expiresAt: input.expiresAt ?? null },
    })
    await recordAdminAuditEvent({
      adminId: input.adminId,
      action: 'admin.price_waiver.grant',
      targetType: modelId ? 'model' : 'product_template',
      targetId: (modelId ?? productTemplateId) as string,
      ...input.audit,
      metadata: {
        waiverId: waiver.id, targetTitle: target.title, minimumPriceCents: input.minimumPriceCents, commonMinimumCents: commonCents, reason,
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
    }, tx)
    return waiver
  })
}

export async function revokeWaiver(input: { adminId: string; waiverId: string; reason: string; audit: GrantInput['audit'] }) {
  const reason = cleanReason(input.reason)
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`waiver-id:${input.waiverId}`}, 0))`
    const waiver = await tx.minimumPriceWaiver.findUnique({ where: { id: input.waiverId } })
    if (!waiver) throw new WaiverError('NOT_FOUND', 'Waiver not found.', 404)
    if (waiver.revokedAt) throw new WaiverError('ALREADY_REVOKED', 'This waiver was already revoked.', 409)
    const updated = await tx.minimumPriceWaiver.update({ where: { id: waiver.id }, data: { revokedAt: new Date(), revokedById: input.adminId, revokeReason: reason } })
    await recordAdminAuditEvent({
      adminId: input.adminId,
      action: 'admin.price_waiver.revoke',
      targetType: waiver.modelId ? 'model' : 'product_template',
      targetId: (waiver.modelId ?? waiver.productTemplateId) as string,
      ...input.audit,
      metadata: { waiverId: waiver.id, minimumPriceCents: waiver.minimumPriceCents, reason },
    }, tx)
    return updated
  })
}

// ---- what the admin page shows ------------------------------------------------------------------------------------------------------------------

// Models whose price the shop set by hand BELOW the shop's minimum and that have no active waiver: the engine sells them at the minimum (a hand-set price is not
// an exemption), so the page tells the administrator which ones to look at. Products whose fixed multiplier is below 1 can also end under the minimum.
export async function listWaiverOverview(db: Db = prisma, now: Date = new Date()) {
  const cfg = await db.siteConfig.findUnique({ where: { id: 'main' } })
  const commonCents = toCents(resolveMinimumUnitPrice(cfg))
  const waivers = await db.minimumPriceWaiver.findMany({ orderBy: [{ createdAt: 'desc' }], take: 200 })
  const modelIds = Array.from(new Set(waivers.flatMap((w) => (w.modelId ? [w.modelId] : []))))
  const productIds = Array.from(new Set(waivers.flatMap((w) => (w.productTemplateId ? [w.productTemplateId] : []))))
  const [models, products, cheapModels, cheapProducts] = await Promise.all([
    modelIds.length ? db.model.findMany({ where: { id: { in: modelIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    productIds.length ? db.productTemplate.findMany({ where: { id: { in: productIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    commonCents > 0
      ? db.model.findMany({ where: { salePriceUsd: { not: null, lt: commonCents / 100 } }, select: { id: true, title: true, salePriceUsd: true }, orderBy: { updatedAt: 'desc' }, take: 200 })
      : Promise.resolve([]),
    db.productTemplate.findMany({ where: { isActive: true, lockedPriceMultiplier: { lt: 1 } }, select: { id: true, title: true, lockedPriceMultiplier: true }, take: 200 }),
  ])
  const titleOf = new Map<string, string>([...models, ...products].map((entry) => [entry.id, entry.title]))
  const rows = waivers.map((waiver) => ({
    id: waiver.id,
    targetType: waiver.modelId ? ('model' as const) : ('product' as const),
    targetId: (waiver.modelId ?? waiver.productTemplateId) as string,
    targetTitle: titleOf.get((waiver.modelId ?? waiver.productTemplateId) as string) ?? null,
    minimumPriceCents: waiver.minimumPriceCents,
    reason: waiver.reason,
    createdById: waiver.createdById,
    createdAt: waiver.createdAt.toISOString(),
    expiresAt: waiver.expiresAt ? waiver.expiresAt.toISOString() : null,
    revokedAt: waiver.revokedAt ? waiver.revokedAt.toISOString() : null,
    revokeReason: waiver.revokeReason,
    active: isWaiverActive(waiver, now),
  }))
  const covered = new Set(rows.filter((row) => row.active).map((row) => `${row.targetType}:${row.targetId}`))
  return {
    commonMinimumCents: commonCents,
    waivers: rows,
    // hand-set prices under the minimum with no waiver: sold at the minimum
    fixedPricesWithoutWaiver: cheapModels
      .filter((model) => !covered.has(`model:${model.id}`))
      .map((model) => ({ id: model.id, title: model.title, salePriceCents: toCents(Number(model.salePriceUsd)) })),
    productsToCheck: cheapProducts
      .filter((product) => !covered.has(`product:${product.id}`))
      .map((product) => ({ id: product.id, title: product.title, multiplier: Number(product.lockedPriceMultiplier) })),
  }
}
