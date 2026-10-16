// Checkout calculation: everything that turns a cart into prices, discounts, shipping and totals. The SERVER does all of it;
// nothing a browser sends is trusted for a price, a discount, a shipping cost or a total.
//
// Extracted unchanged from app/api/checkout/route.ts (S2/S3 step 1) so that the card flow with Stripe Checkout, the quote
// preview and the legacy checkout all use the same code. The steps stay separate because the caller has to do permission checks
// between them (organization billing, allowed payment method) and the order of the checks decides which error a request gets:
//
//   loadCheckoutContext  -> who is asking, which models/parts/settings          (404 if a model is unavailable)
//   priceLineItems       -> every cart line: price, scale, colors, discounts     (400 for invalid colors / negative total)
//   computeCheckoutTotals-> minimum order, shipping, tax, total in whole cents   (400 / 500 for the rules below)
//
// A failed rule throws CheckoutQuoteError (HTTP status + message); anything else is an unexpected error.
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { effectiveMinimum, loadActiveWaivers, waiverForLine } from '@/lib/minimum-waivers'
import { applyMinimumAfterScale, estimatePricingDetails, resolveMinimumUnitPrice, resolveModelPricing, type PricingDetails } from '@/lib/pricing'
import { allocateCents, allocatePartPriceCents, floorUnitCents } from '@/lib/unit-pricing'
import { resolveSaleUnits, type SaleUnit, type UnitNotice } from '@/lib/sale-units'
import { formatCurrency, getCurrency, toCents, type Currency } from '@/lib/currency'
import { getStripe } from '@/lib/stripe'
import { viewerGuards } from '@/lib/viewer'
import type { CheckoutLineItem, ShippingSelection } from '@/types/checkout'
import { getColorMultiplier, normalizeColors, normalizeMaterialName, resolveScaleFromDimensions, type MaterialType, MAX_CART_COLORS } from '@/lib/cartPricing'
import { buildAllowedColorTokenSet, isColorAllowed, normalizeModelColorSlotCount } from '@/lib/color-constraints'
import { isColorAvailableForMaterial, type FilamentPaletteResponse } from '@/lib/filament-palette-validation'
import { summarizeDiscount } from '@/lib/discounts'
import { applyPricingAdjustments, getPricingAdjustmentConfig, resolveBatchDiscountPercent } from '@/lib/estimate-adjustments'
import { estimateLeadTimeHours } from '@/lib/lead-time-estimator'
import { checkoutVisibleModelWhere, checkoutVisiblePartWhere } from '@/lib/model-visibility'
import { computeTax, getTaxConfig } from '@/lib/tax'
import { getShippingConfig, SHIPPING_LABEL } from '@/lib/shipping'
import { lockedProductConfig, productMultiplier, toleranceMultiplier } from '@/lib/price-multiplier'
import { roundToTenthMm, scaledSize, sizeOf } from '@/lib/geometry'
import { evaluateLine, type ReviewReason } from '@/lib/printability'
import { loadActiveMachines } from '@/lib/printer-machines'
import { knownFinishes } from '@/lib/pricing'
import { stripeMinimumChargeCents } from '@/lib/payment-limits'

// A rule of the checkout that a request broke. `code` is what the page acts on (see lib/checkout-client.ts); `message` is for people
// and logs; `details` points at the cart line concerned (itemIndex / itemIndexes) or carries the figure that matters (minimumCents).
export type CheckoutQuoteErrorDetails = {
  itemIndex?: number
  itemIndexes?: number[]
  minimumCents?: number
  itemsTotalCents?: number
  // BELOW_PAYMENT_MINIMUM: the total that would have been charged (products + shipping + tax added), in cents
  totalCents?: number
  currency?: string
  // MANUAL_REVIEW_REQUIRED: for each line a person has to look at, why (lib/printability.ts)
  reviews?: Array<{ itemIndex: number; reasons: ReviewReason[] }>
}
export class CheckoutQuoteError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: CheckoutQuoteErrorDetails | null
  constructor(status: number, message: string, code: string | null = null, details: CheckoutQuoteErrorDetails | null = null) {
    super(message)
    this.name = 'CheckoutQuoteError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const checkoutShippingSchema = z.object({
  method: z.enum(['pickup', 'ship']),
  address: z.object({
    name: z.string().max(120).optional(),
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    state: z.string().max(120).optional(),
    postalCode: z.string().max(40).optional(),
    country: z.string().max(120).optional(),
  }).optional(),
}).optional()

const dimensionSchema = z.object({
  x: z.number().positive().max(5000).optional(),
  y: z.number().positive().max(5000).optional(),
  z: z.number().positive().max(5000).optional(),
}).partial()

export const checkoutItemSchema = z.object({
  modelId: z.string().min(1),
  partId: z.string().min(1).optional(),
  productTemplateId: z.string().cuid().optional(),
  qty: z.number().int().positive().max(50),
  scale: z.number().positive().max(5).default(1),
  scaleX: z.number().positive().max(5).optional(),
  scaleY: z.number().positive().max(5).optional(),
  scaleZ: z.number().positive().max(5).optional(),
  lockDimensions: z.boolean().optional(),
  // Accepted so that older pages are not refused, but NEVER read: the server works the size in millimetres out from the validated scale.
  targetDimensions: dimensionSchema.optional(),
  material: z.string().max(40).optional().default('PLA'),
  colors: z.array(z.string().max(64)).max(MAX_CART_COLORS).optional(),
  toleranceClass: z.enum(['draft', 'standard', 'cosmetic', 'fit_critical']).optional(),
  finish: z.string().max(40).optional(),
  infillPct: z.number().int().min(0).max(100).optional().nullable(),
  customText: z.string().max(140).optional().nullable(),
  // Accepted so that older carts are not refused, but NEVER used: the server works the multiplier out itself (lib/price-multiplier.ts).
  priceMultiplier: z.number().positive().max(5).optional().nullable(),
  // Step 4.6: "these lines are ONE complete copy of the model" - the browser's claim, believed only when lib/sale-units.ts can check it. A malformed key is
  // refused; a null (an older client) means no key.
  setKey: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).nullish().transform((value) => value ?? undefined),
})

export type CheckoutItemPayload = z.infer<typeof checkoutItemSchema>

function normalizeStoragePath(pathValue?: string | null) {
  if (!pathValue) return null
  const trimmed = String(pathValue).trim()
  if (!trimmed) return null
  return `/${trimmed.replace(/^\/+/, '')}`
}

// ---- Step 1: who is asking, and what exists -------------------------------------------------------------------------
export async function loadCheckoutContext(items: CheckoutItemPayload[]) {
  const ids = Array.from(new Set(items.map(i => i.modelId)))
  const partIds = Array.from(new Set(items.map(i => i.partId).filter((id): id is string => typeof id === 'string' && id.length > 0)))
  // Identity of the person making the request (session). Roles are always read from the server, never from the request body.
  const userId = (await viewerGuards.getViewer())?.id ?? null
  const user = userId
    ? await prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        discountPercent: true,
        friendsAndFamilyPercent: true,
        isFriendsAndFamily: true,
        isAdmin: true,
        role: true,
      },
    })
    : null
  const isAdmin = Boolean(user?.isAdmin || user?.role === 'admin')
  const hasElevatedModelAccess = Boolean(
    user?.isAdmin
    || user?.role === 'admin'
    || user?.role === 'staff',
  )
  const modelWhere = checkoutVisibleModelWhere(ids, userId, hasElevatedModelAccess)
  const partWhere = checkoutVisiblePartWhere(partIds, userId, hasElevatedModelAccess)
  const templateIds = Array.from(new Set(items.map(i => i.productTemplateId).filter((id): id is string => typeof id === 'string' && id.length > 0)))
  const [models, cfg, parts, templates, machines] = await Promise.all([
    prisma.model.findMany({
      where: modelWhere,
      select: {
        id: true,
        title: true,
        priceUsd: true,
        effectivePriceUsd: true,
        salePriceUsd: true,
        disableCustomerDiscounts: true,
        flatRatePricing: true,
        volumeMm3: true,
        material: true,
        unit: true,
        sizeXmm: true,
        sizeYmm: true,
        sizeZmm: true,
        supportRatio: true,
        printabilityScore: true,
        failureRiskScore: true,
        orientationSuggestion: true,
        supportLikelihood: true,
        colorSlotCount: true,
        allowedColors: true,
        filePath: true,
        viewerFilePath: true,
        _count: { select: { parts: true } },
      },
    }),
    prisma.siteConfig.findUnique({ where: { id: 'main' } }),
    partIds.length > 0
      ? prisma.modelPart.findMany({
          where: partWhere,
          select: {
            id: true,
            modelId: true,
            name: true,
            priceUsd: true,
            volumeMm3: true,
            supportRatio: true,
            sizeXmm: true,
            sizeYmm: true,
            sizeZmm: true,
            filePath: true,
            previewFilePath: true,
          },
        })
      : Promise.resolve([]),
    // Ready-made products: read from the database, so that what a product costs and is made of is never the browser's word.
    templateIds.length > 0
      ? prisma.productTemplate.findMany({
          where: { id: { in: templateIds } },
          select: {
            id: true,
            baseModelId: true,
            isActive: true,
            lockedMaterial: true,
            lockedFinish: true,
            lockedScale: true,
            lockedPriceMultiplier: true,
            colorOptions: true,
          },
        })
      : Promise.resolve([]),
    // The machines that can make the order (configuration in the database): what they can print decides what may be paid online.
    loadActiveMachines(),
  ])
  const modelMap = new Map(models.map(m => [m.id, m]))
  if (modelMap.size !== ids.length) {
    const missing = items.flatMap((item, index) => (modelMap.has(item.modelId) ? [] : [index]))
    throw new CheckoutQuoteError(404, 'One or more models are unavailable', 'ITEM_UNAVAILABLE', { itemIndexes: missing })
  }
  const partMap = new Map(parts.map((p) => [p.id, p]))
  const templateMap = new Map(templates.map((t) => [t.id, t]))
  // Every part of every model made of several parts that the cart touches, as a whole line or part by part. Needed for three things: a whole model is printed
  // part by part, so every part's size is needed to check that each one fits (the model's own size may describe only one of them); the price of the model
  // is shared between its parts by volume (lib/unit-pricing.ts); and a set is believed to be complete only against the list of ALL the parts the server knows
  // (lib/sale-units.ts). Never the browser's list.
  const multipartIds = ids.filter((id) => (modelMap.get(id)?._count?.parts || 0) > 1)
  const siblingParts = multipartIds.length > 0
    ? await prisma.modelPart.findMany({
      where: { modelId: { in: multipartIds } },
      orderBy: [{ index: 'asc' }, { id: 'asc' }],
      select: { id: true, modelId: true, volumeMm3: true, sizeXmm: true, sizeYmm: true, sizeZmm: true, supportRatio: true },
    })
    : []
  const partsByModel = new Map<string, typeof siblingParts>()
  for (const part of siblingParts) partsByModel.set(part.modelId, [...(partsByModel.get(part.modelId) ?? []), part])
  const partIdsByModel = new Map<string, string[]>()
  for (const part of siblingParts) partIdsByModel.set(part.modelId, [...(partIdsByModel.get(part.modelId) ?? []), part.id])
  // The least ONE unit of a model or of a ready-made product may cost, in whole cents: the shop's commercial minimum, or - for a model or product for which an
  // administrator has granted a waiver - the floor that waiver names (lib/minimum-waivers.ts). Read from the database here, never from a request.
  const commercialMinimumCents = toCents(resolveMinimumUnitPrice(cfg))
  const waivers = await loadActiveWaivers(prisma, { modelIds: ids, productTemplateIds: templateIds })
  const minimumFor = (modelId: string, templateId: string | null | undefined): { cents: number; waiverId: string | null } =>
    effectiveMinimum(commercialMinimumCents, waiverForLine(waivers, modelId, templateId && templateMap.has(templateId) ? templateId : null))
  return { userId, user, isAdmin, hasElevatedModelAccess, models, modelMap, partMap, templateMap, partsByModel, partIdsByModel, cfg, machines, commercialMinimumCents, minimumFor }
}

export type CheckoutContext = Awaited<ReturnType<typeof loadCheckoutContext>>

// One cart line after it was validated and given its base price, before its unit price is finished (priceLineItems, pass 1).
type LineDraft = {
  model: CheckoutContext['models'][number]
  part: NonNullable<ReturnType<CheckoutContext['partMap']['get']>> | null
  template: NonNullable<ReturnType<CheckoutContext['templateMap']['get']>> | null
  entry: CheckoutItemPayload
  isMultipart: boolean
  basePrice: number
  volumeMultiplier: number
  colorMultiplier: number
  optionMultiplier: number
  pricingDetails: PricingDetails | null
  materialChoice: MaterialType
  colors: string[]
  finishChoice: string | null
  colorCountForPricing: number
  cm3: number | null
  scaleX: number
  scaleY: number
  scaleZ: number
  uniformScale: number
  printedSize: ReturnType<typeof scaledSize> | null
  qty: number
  // the least ONE unit of this line may cost (whole cents), and the waiver behind it when it is not the shop's own minimum
  minimumCents: number
  waiverId: string | null
}

// ---- Step 2: price every cart line --------------------------------------------------------------------------------------
export async function priceLineItems(
  ctx: CheckoutContext,
  input: { items: CheckoutItemPayload[]; rush: boolean; publicBaseUrl: string | null },
) {
  const { items, rush, publicBaseUrl } = input
  const { modelMap, partMap, templateMap, partsByModel, cfg, isAdmin, machines } = ctx
  const finishes = knownFinishes()
  // Lines no machine can make automatically (unknown or unavailable material or finish, ...): collected for ALL lines, then refused together.
  const reviews: Array<{ itemIndex: number; reasons: ReviewReason[] }> = []
  const discountSummary = summarizeDiscount(ctx.user)
  const pricingAdjustments = getPricingAdjustmentConfig(cfg || undefined)
  const filamentPalette = await fetch(`${publicBaseUrl}/api/stockworks/filament-colors`, { cache: 'no-store' })
    .then(async (res) => (res.ok ? await res.json() as FilamentPaletteResponse : null))
    .catch(() => null)

  // PASS 1 - everything that is known about a line before its unit price is finished: the model, the part, the validated scales, the base price. Nothing
  // here waits for anything, so a refusal comes out in the order of the lines. The commercial minimum (pass 2 below) needs ALL the lines of the cart: the
  // parts of one model are counted together.
  const drafts = items.map((rawEntry, itemIndex): LineDraft | null => {
    const model = modelMap.get(rawEntry.modelId)!
    // A ready-made product must exist, be on sale and belong to THIS model: the cart's word is not enough.
    const template = rawEntry.productTemplateId ? templateMap.get(rawEntry.productTemplateId) ?? null : null
    if (rawEntry.productTemplateId && (!template || !template.isActive || template.baseModelId !== model.id)) {
      throw new CheckoutQuoteError(404, 'This product is no longer available.', 'ITEM_UNAVAILABLE', { itemIndex })
    }
    // The option multiplier is the server's own (lib/price-multiplier.ts): a tolerance class, or the product's price and variant.
    let entry = rawEntry
    let optionMultiplier = toleranceMultiplier(rawEntry.toleranceClass)
    if (template) {
      const variant = productMultiplier(template, rawEntry.colors?.[0])
      if (!variant.ok) throw new CheckoutQuoteError(409, 'The selected option of this product is no longer available.', 'OPTION_UNAVAILABLE', { itemIndex })
      const locked = lockedProductConfig(template, model.material)
      optionMultiplier = variant.multiplier
      entry = {
        ...rawEntry,
        material: locked.material,
        finish: locked.finish,
        scale: locked.scale,
        scaleX: undefined,
        scaleY: undefined,
        scaleZ: undefined,
        lockDimensions: undefined,
        targetDimensions: undefined,
        infillPct: undefined,
        toleranceClass: 'standard',
      }
    }
    // The scale is the customer's choice (bounded 0.1 to 5 by the server). A size in millimetres sent by the browser (`targetDimensions`) is NOT
    // read: it used to be turned into a scale against the size of the WHOLE model, which shrank the price of a part (its own size is smaller).
    const { scaleX, scaleY, scaleZ, uniformScale } = resolveScaleFromDimensions({
      size: null,
      target: null,
      scale: entry.scale ?? 1,
      scaleX: entry.scaleX ?? null,
      scaleY: entry.scaleY ?? null,
      scaleZ: entry.scaleZ ?? null,
      lockDimensions: null,
    })
    const part = entry.partId ? partMap.get(entry.partId) || null : null
    if (entry.partId && (!part || part.modelId !== model.id)) {
      throw new CheckoutQuoteError(400, 'Invalid part specified for model', 'ITEM_UNAVAILABLE', { itemIndex })
    }
    // Can a machine make this line automatically? If not it is NEVER priced as an ordinary PLA print: it waits for a person (manual review).
    const verdict = evaluateLine({
      material: entry.material || model.material || 'PLA',
      finish: entry.finish,
      reference: part ?? model,
      references: part ? null : partsByModel.get(model.id) ?? null,
      scales: { x: scaleX, y: scaleY, z: scaleZ },
      modelUnit: model.unit,
      supportRatio: (part ?? model).supportRatio,
    }, machines, { knownFinishes: finishes, checkGeometry: true })
    if (!verdict.ok) {
      reviews.push({ itemIndex, reasons: verdict.reasons })
      return null
    }
    const cm3 = model.volumeMm3 ? model.volumeMm3 / 1000 : null
    const materialChoice: MaterialType = normalizeMaterialName(verdict.material)
    const colorSlotCount = normalizeModelColorSlotCount(model.colorSlotCount)
    const allowedColors = Array.isArray(model.allowedColors)
      ? model.allowedColors.map((value) => String(value || '')).filter((value) => value.trim().length > 0)
      : null
    const allowedTokens = buildAllowedColorTokenSet(allowedColors)
    const rawColors = Array.isArray(entry.colors)
      ? entry.colors.map((value) => String(value || '').trim()).filter(Boolean)
      : []
    const slotLimit = colorSlotCount ?? MAX_CART_COLORS
    if (rawColors.length > slotLimit) {
      throw new CheckoutQuoteError(400, 'Too many colors selected for model', 'COLOR_INVALID', { itemIndex })
    }
    if (allowedTokens && rawColors.some((color) => !isColorAllowed(color, allowedTokens))) {
      throw new CheckoutQuoteError(400, 'One or more selected colors are not allowed for this model', 'COLOR_NOT_ALLOWED', { itemIndex })
    }
    if (rawColors.some((color) => !isColorAvailableForMaterial(color, filamentPalette, materialChoice))) {
      throw new CheckoutQuoteError(400, 'One or more selected colors are not available for the selected material', 'COLOR_UNAVAILABLE', { itemIndex })
    }
    const colors = normalizeColors(rawColors, slotLimit)
    const colorCountForPricing = model.flatRatePricing ? 1 : colors.length
    const finishChoice = entry.finish ? String(entry.finish) : null
    const isMultipart = (model._count?.parts || 0) > 1
    const minimum = ctx.minimumFor(model.id, rawEntry.productTemplateId)
    const minimumPrice = minimum.cents / 100
    let pricingDetails: PricingDetails | null = null
    const basePrice = (() => {
      if (part) {
        if (isMultipart) {
          // A part of a model made of several parts costs its SHARE of the price of the model - the price the model page advertises (the sale price when there
          // is one) - shared by volume in whole cents that add up to that price (lib/unit-pricing.ts). The model priced with THIS line's options.
          const siblings = ctx.partsByModel.get(model.id) ?? []
          const modelVolume = model.volumeMm3 != null && Number.isFinite(Number(model.volumeMm3)) && Number(model.volumeMm3) > 0 ? Number(model.volumeMm3) : null
          const onSale = model.salePriceUsd != null && Number.isFinite(Number(model.salePriceUsd)) && Number(model.salePriceUsd) > 0
          let wholePrice: number | null = null
          if (modelVolume != null) {
            const totalPricing = estimatePricingDetails({
              cm3: modelVolume / 1000,
              material: materialChoice,
              infillPct: entry.infillPct ?? null,
              finish: finishChoice,
              supportRatio: model.supportRatio ?? null,
              colorCount: colorCountForPricing,
              cfg,
              applyMinimum: true,
              minimumPrice,
            })
            pricingDetails = totalPricing
            wholePrice = onSale ? Number(model.salePriceUsd) : totalPricing.price
          } else if (onSale) {
            wholePrice = Number(model.salePriceUsd)
          }
          if (wholePrice != null) {
            const shares = allocatePartPriceCents({ wholePriceCents: toCents(wholePrice), partVolumes: siblings.map((sibling) => sibling.volumeMm3) })
            const at = siblings.findIndex((sibling) => sibling.id === part.id)
            if (shares && at >= 0) return shares[at] / 100
          }
        }
        if (part.priceUsd != null && Number.isFinite(Number(part.priceUsd))) {
          return Number(part.priceUsd)
        }
        if (part.volumeMm3 != null && Number.isFinite(Number(part.volumeMm3))) {
          pricingDetails = estimatePricingDetails({
            cm3: Number(part.volumeMm3) / 1000,
            material: materialChoice,
            infillPct: entry.infillPct ?? null,
            finish: finishChoice,
            supportRatio: part.supportRatio ?? null,
            colorCount: colorCountForPricing,
            cfg,
            minimumPrice,
          })
          return pricingDetails.price
        }
        throw new CheckoutQuoteError(422, 'This item cannot be priced right now.', 'ITEM_NOT_PRICEABLE', { itemIndex })
      }
      if (model.salePriceUsd != null && Number.isFinite(Number(model.salePriceUsd)) && Number(model.salePriceUsd) > 0) {
        return Number(model.salePriceUsd)
      }
      if (entry.productTemplateId) {
        const resolved = resolveModelPricing(model, cfg, { minimumPrice }).priceUsd
        if (resolved != null && Number.isFinite(Number(resolved)) && Number(resolved) > 0) {
          return Number(resolved)
        }
      }
      if (cm3 != null) {
        pricingDetails = estimatePricingDetails({
          cm3,
          material: materialChoice,
          infillPct: entry.infillPct ?? null,
          finish: finishChoice,
          supportRatio: model.supportRatio ?? null,
          colorCount: colorCountForPricing,
          cfg,
          minimumPrice,
        })
        return pricingDetails.price
      }
      if (model.priceUsd != null && Number.isFinite(Number(model.priceUsd))) {
        return Number(model.priceUsd)
      }
      throw new CheckoutQuoteError(422, 'This item cannot be priced right now.', 'ITEM_NOT_PRICEABLE', { itemIndex })
    })()
    if (!isFinite(basePrice) || basePrice <= 0) {
      throw new CheckoutQuoteError(422, 'This item cannot be priced right now.', 'ITEM_NOT_PRICEABLE', { itemIndex })
    }
    // What the production report shows: the size of THIS part (or of the model when the whole model is sold) times the validated scales.
    const referenceSize = sizeOf(part ?? model)
    const printedSize = referenceSize ? scaledSize(referenceSize, { x: scaleX, y: scaleY, z: scaleZ }) : null
    const volumeMultiplier = scaleX * scaleY * scaleZ
    const colorMultiplier = model.flatRatePricing ? 1 : getColorMultiplier(colors)
    return {
      model, part, template, entry, isMultipart, basePrice, volumeMultiplier, colorMultiplier, optionMultiplier,
      pricingDetails: pricingDetails as PricingDetails | null, materialChoice, colors, finishChoice, colorCountForPricing, cm3,
      scaleX, scaleY, scaleZ, uniformScale, printedSize, qty: entry.qty || 1,
      minimumCents: minimum.cents, waiverId: minimum.waiverId,
    }
  })
  // A line that no machine can make automatically stops the whole cart from being paid online: nothing is priced "as if" it were plain PLA.
  if (reviews.length > 0) {
    reviews.sort((a, b) => a.itemIndex - b.itemIndex)
    throw new CheckoutQuoteError(422, 'This cart needs a manual review before it can be paid online.', 'MANUAL_REVIEW_REQUIRED', { itemIndexes: reviews.map((entry) => entry.itemIndex), reviews })
  }
  const lines = drafts as LineDraft[]

  // PASS 2 - what is SOLD, and the commercial minimum on it. The minimum is the least ONE SOLD UNIT may cost (SiteConfig "Minimum price", or the floor of a
  // waiver an administrator granted for the model), after the customer resized it and WHATEVER the way its base price was found (worked out from the volume,
  // a flat rate, a price the shop set by hand, a ready-made product with a fixed scale): a fixed price or a locked scale is not an exemption - only a
  // recorded waiver is (lib/minimum-waivers.ts). Quantity discounts, the customer's discounts and rush come AFTER it.
  //   * which lines make one unit is decided by lib/sale-units.ts: a whole model, a product, a part, or - only when the claim of the `setKey` can be checked
  //     against the model's real list of parts - a COMPLETE COPY of a model made of several parts;
  //   * a unit that is one line is floored by itself (applyMinimumAfterScale), as in step 4.5;
  //   * a complete copy costs the price of the model: its parts are floored TOGETHER, once, and the cents are shared between them so that they add up exactly.
  const plan = resolveSaleUnits(
    lines.map((line, index) => ({
      index,
      modelId: line.model.id,
      partId: line.part?.id ?? null,
      productTemplateId: line.template ? (line.entry.productTemplateId ?? null) : null,
      setKey: line.entry.setKey ?? null,
      qty: line.qty,
      scaleX: line.scaleX,
      scaleY: line.scaleY,
      scaleZ: line.scaleZ,
    })),
    (modelId) => ctx.partIdsByModel.get(modelId) ?? [],
  )
  const scaledBases = lines.map((line) => applyMinimumAfterScale({ basePrice: line.basePrice, volumeMultiplier: line.volumeMultiplier, minimumPrice: line.minimumCents / 100 }).price)
  const floored = lines.map((line) => applyMinimumAfterScale({ basePrice: line.basePrice, volumeMultiplier: line.volumeMultiplier, minimumPrice: line.minimumCents / 100 }).floored)
  for (const unit of plan.units) {
    if (unit.kind !== 'set') continue
    const members = unit.lineIndexes
    const exact = members.map((index) => lines[index].basePrice * lines[index].volumeMultiplier)
    const minimum = lines[members[0]].minimumCents / 100
    const exactTotal = exact.reduce((sum, value) => sum + value, 0)
    // (rounded to two decimals the way a whole-model line is, so that the complete model and the model sold as one line agree to the cent)
    const shares = allocateCents(toCents(Number(Math.max(exactTotal, minimum).toFixed(2))), exact)
    members.forEach((index, k) => { scaledBases[index] = shares[k] / 100; floored[index] = exactTotal < minimum })
  }

  // The options that apply to the unit (colours, tolerance, ready-made product) come on top of the floor, as they do at the original size. One that LOWERS the
  // price (the draft tolerance, x0.94, or a product variant under 1) must not take a unit under the minimum: the unit is floored again, as a whole, on what
  // it costs with its options - and before rush and discounts, which stay distinct (they are visible discounts, not a way round the minimum).
  const rawUnitPrices = lines.map((line, index) => Number((scaledBases[index] * line.colorMultiplier * line.optionMultiplier).toFixed(2)))
  for (const unit of plan.units) {
    const members = unit.lineIndexes
    const raised = floorUnitCents(members.map((index) => toCents(rawUnitPrices[index])), lines[members[0]].minimumCents)
    if (!raised.floored) continue
    members.forEach((index, k) => { rawUnitPrices[index] = raised.cents[k] / 100; floored[index] = true })
  }

  // PASS 3 - the rest of the unit price, the line, the lead time.
  const lineItems: CheckoutLineItem[] = await Promise.all(lines.map(async (line, lineIndex) => {
    const { model, part, entry, pricingDetails, materialChoice, colors, finishChoice, colorCountForPricing, cm3, scaleX, scaleY, scaleZ, uniformScale, printedSize, volumeMultiplier, colorMultiplier, optionMultiplier } = line
    const rawUnitPrice = rawUnitPrices[lineIndex]
    const batchDiscountPercent = resolveBatchDiscountPercent(entry.qty || 1, pricingAdjustments.batchDiscountTiers)
    const adjusted = applyPricingAdjustments({
      unitPrice: rawUnitPrice,
      qty: entry.qty || 1,
      rush,
      demandSurgeMultiplier: pricingAdjustments.demandSurgeMultiplier,
      rushMultiplier: pricingAdjustments.rushMultiplier,
      batchDiscountPercent,
    })
    const discountBlockedForModel = Boolean(model.disableCustomerDiscounts) && !isAdmin
    const lineDiscountPercent = discountBlockedForModel ? 0 : discountSummary.totalPercent
    const lineDiscountMultiplier = Math.max(0, 1 - lineDiscountPercent / 100)
    const unitPrice = Number((adjusted.adjustedUnitPrice * lineDiscountMultiplier).toFixed(2))
    const qty = entry.qty || 1
    const undiscountedLineTotal = Number((adjusted.adjustedUnitPrice * qty).toFixed(2))
    const lineTotal = Number((unitPrice * qty).toFixed(2))
    const leadTimePricing = pricingDetails || (() => {
      if (part?.volumeMm3 != null && Number.isFinite(Number(part.volumeMm3))) {
        return estimatePricingDetails({
          cm3: Number(part.volumeMm3) / 1000,
          material: materialChoice,
          infillPct: entry.infillPct ?? null,
          finish: finishChoice,
          supportRatio: part.supportRatio ?? null,
          colorCount: colorCountForPricing,
          cfg,
          applyMinimum: false,
        })
      }
      if (cm3 != null) {
        return estimatePricingDetails({
          cm3,
          material: materialChoice,
          infillPct: entry.infillPct ?? null,
          finish: finishChoice,
          supportRatio: model.supportRatio ?? null,
          colorCount: colorCountForPricing,
          cfg,
          applyMinimum: false,
        })
      }
      return null
    })()
    const leadTime = leadTimePricing
      ? await estimateLeadTimeHours({
          baseHours: Math.max(0.25, leadTimePricing.hours * qty),
          material: materialChoice,
        })
      : null
    const storagePath = normalizeStoragePath(
      part?.filePath ||
        model.filePath ||
        part?.previewFilePath ||
        model.viewerFilePath ||
        null,
    )
    const storageUrl = storagePath && publicBaseUrl ? `${publicBaseUrl}/files${storagePath}` : null
    return {
      modelId: model.id,
      partId: part?.id || undefined,
      productTemplateId: entry.productTemplateId || undefined,
      partName: part?.name || undefined,
      title: model.title,
      qty,
      scale: uniformScale,
      scaleX,
      scaleY,
      scaleZ,
      unitPrice,
      lineTotal,
      undiscountedLineTotal,
      discountPercent: lineDiscountPercent || undefined,
      material: materialChoice,
      colors,
      toleranceClass: entry.toleranceClass || 'standard',
      finish: finishChoice || undefined,
      infillPct: entry.infillPct ?? undefined,
      customText: entry.customText || undefined,
      targetDimensions: printedSize ? { x: roundToTenthMm(printedSize.x), y: roundToTenthMm(printedSize.y), z: roundToTenthMm(printedSize.z) } : undefined,
      storagePath,
      storageUrl,
      pricingBreakdown: {
        base: leadTimePricing,
        volumeMultiplier,
        colorMultiplier,
        discountMultiplier: lineDiscountMultiplier,
        priceMultiplier: optionMultiplier,
        rawUnitPrice,
        unitPrice,
        batchDiscountPercent,
        rush,
        demandSurgeMultiplier: pricingAdjustments.demandSurgeMultiplier,
        rushMultiplier: pricingAdjustments.rushMultiplier,
      },
      unit: describeUnit(plan.units[plan.unitOfLine[lineIndex]]),
      minimum: { unitCents: line.minimumCents, floored: floored[lineIndex], waiverId: line.waiverId },
      leadTimeHours: leadTime?.hours ?? null,
      leadTimeWindowHours: leadTime ? { min: leadTime.minHours, max: leadTime.maxHours } : null,
      etaConfidenceScore: leadTime?.confidenceScore ?? null,
      leadTimeSignals: leadTime?.signals ?? null,
    }
  }))
  // Whole cents from the line to the total: the lines are already exact to the cent, so this sum is an integer addition - no floating-point noise on the
  // edge of a threshold (the minimum order is compared on it).
  const itemsTotalCents = lineItems.reduce((sum, item) => sum + toCents(item.lineTotal), 0)
  const itemsTotal = Number((itemsTotalCents / 100).toFixed(2))
  if (!isFinite(itemsTotal) || itemsTotal < 0) {
    throw new CheckoutQuoteError(400, 'Cart total cannot be negative', 'TOTAL_INVALID')
  }
  return { lineItems, itemsTotal, itemsTotalCents, discountSummary, pricingAdjustments, unitNotices: plan.notices as UnitNotice[] }
}

function describeUnit(unit: SaleUnit): NonNullable<CheckoutLineItem['unit']> {
  return { kind: unit.kind, setOrdinal: unit.setOrdinal, copies: unit.copies, partCount: unit.partCount }
}

export type ShippingRateInfo = { id: string; label: string; amount: number; currency: Currency }
export type ShippingResolution = { shippingAmountCents: number; shippingRate: ShippingRateInfo | null }
export type ShippingResolver = (input: {
  shippingPayload: ShippingSelection
  currencyCode: Currency
  isAdminFreeCheckout: boolean
}) => Promise<ShippingResolution>

// Current checkout: the rate is read from Stripe (STRIPE_SHIPPING_RATE_ID). Goes away with the legacy card path.
export const resolveStripeShippingRate: ShippingResolver = async ({ shippingPayload, currencyCode, isAdminFreeCheckout }) => {
  const shippingRateId = (process.env.STRIPE_SHIPPING_RATE_ID || '').trim()
  let shippingRate: { id: string; label: string; amount: number; currency: Currency } | null = null
  let shippingAmountCents = 0
  if (shippingPayload.method === 'ship' && !isAdminFreeCheckout) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new CheckoutQuoteError(500, 'Stripe is not configured for shipping rates')
    }
    if (!shippingRateId) {
      throw new CheckoutQuoteError(500, 'Shipping rate is not configured')
    }
    const stripe = getStripe()
    const rate = await stripe.shippingRates.retrieve(shippingRateId)
    if (!rate || rate.active === false) {
      throw new CheckoutQuoteError(500, 'Shipping rate is unavailable')
    }
    if (!rate.fixed_amount || typeof rate.fixed_amount.amount !== 'number') {
      throw new CheckoutQuoteError(500, 'Shipping rate must be a fixed amount')
    }
    const rateCurrency = (rate.fixed_amount.currency || '').toUpperCase()
    if (rateCurrency !== currencyCode) {
      throw new CheckoutQuoteError(500, `Shipping rate currency must be ${currencyCode}`)
    }
    shippingAmountCents = rate.fixed_amount.amount
    shippingRate = {
      id: rate.id,
      label: rate.display_name || 'Shipping',
      amount: Number((rate.fixed_amount.amount / 100).toFixed(2)),
      currency: currencyCode,
    }
  }
  return { shippingAmountCents, shippingRate }
}

// Hosted checkout: one flat rate from the shop's configuration (lib/shipping.ts). Pickup is free; shipping without a valid
// configuration is refused instead of being priced at zero.
export const resolveConfiguredShipping: ShippingResolver = async ({ shippingPayload, currencyCode }) => {
  if (shippingPayload.method !== 'ship') return { shippingAmountCents: 0, shippingRate: null }
  const config = getShippingConfig()
  if (!config.configured) {
    throw new CheckoutQuoteError(503, 'Shipping is not available right now.', 'SHIPPING_NOT_CONFIGURED')
  }
  return {
    shippingAmountCents: config.cents,
    shippingRate: { id: 'flat-it', label: SHIPPING_LABEL, amount: Number((config.cents / 100).toFixed(2)), currency: currencyCode },
  }
}

// ---- Step 3: minimum order, shipping, tax and the total ----------------------------------------------------------------------
export async function computeCheckoutTotals(input: {
  cfg: CheckoutContext['cfg']
  itemsTotal: number
  // the same total in whole cents, when the caller has it from the lines (priceLineItems): otherwise it is worked out from `itemsTotal`
  itemsTotalCents?: number
  isAdminFreeCheckout: boolean
  shippingPayload: ShippingSelection
  resolveShipping?: ShippingResolver
}) {
  const { cfg, itemsTotal, isAdminFreeCheckout, shippingPayload, resolveShipping = resolveStripeShippingRate } = input
  const itemsTotalCents = input.itemsTotalCents ?? toCents(itemsTotal)
  const currencyCode = getCurrency().toUpperCase() as Currency
  const currency = currencyCode.toLowerCase()
  const minimumOrderSubtotal = cfg?.minimumOrderSubtotalUsd != null && Number.isFinite(Number(cfg.minimumOrderSubtotalUsd))
    ? Number(cfg.minimumOrderSubtotalUsd)
    : null
  // Compared in WHOLE CENTS (step 4.6): the configured number is an amount in the shop's currency (the field is called ...Usd for historical reasons and is
  // never converted), and a sum of euros in floating point can fall a hair under the amount it equals (8.70 + 1.10 is 9.799999999999999).
  const minimumOrderCents = minimumOrderSubtotal ? toCents(minimumOrderSubtotal) : 0
  if (!isAdminFreeCheckout && minimumOrderCents > 0 && itemsTotalCents < minimumOrderCents) {
    throw new CheckoutQuoteError(400, `Minimum order subtotal is ${formatCurrency(minimumOrderCents / 100, currencyCode)}.`, 'MINIMUM_ORDER', { minimumCents: minimumOrderCents, itemsTotalCents, currency: currencyCode })
  }
  const { shippingAmountCents, shippingRate } = await resolveShipping({ shippingPayload, currencyCode, isAdminFreeCheckout })
  // Whole cents from here on: the same integers are shown to the customer, stored on the order and sent to Stripe.
  const taxable = itemsTotalCents + shippingAmountCents
  const tax = computeTax(taxable, getTaxConfig())
  const estimatedTotalCents = taxable + tax.addedCents
  const amount = isAdminFreeCheckout ? 0 : estimatedTotalCents
  const taxCents = isAdminFreeCheckout ? 0 : tax.taxCents
  const total = Number((amount / 100).toFixed(2))
  const isFreeOrder = amount === 0
  // A zero total can only come from an administrator's no-charge order; for anyone else it means a pricing fault
  // and would otherwise create a "free" order that enters production.
  if (isFreeOrder && !isAdminFreeCheckout) {
    throw new CheckoutQuoteError(400, 'The order total must be greater than zero.', 'TOTAL_INVALID')
  }
  // The payment provider's own minimum (not the shop's: lib/payment-limits.ts). Refused HERE, before an order exists, so that Stripe never has to
  // turn down a session for an order that is already stored.
  const providerMinimumCents = stripeMinimumChargeCents(currencyCode)
  if (!isAdminFreeCheckout && amount < providerMinimumCents) {
    throw new CheckoutQuoteError(400, `The total is below the smallest card payment (${formatCurrency(providerMinimumCents / 100, currencyCode)}).`, 'BELOW_PAYMENT_MINIMUM', { minimumCents: providerMinimumCents, totalCents: amount, currency: currencyCode })
  }
  return {
    currencyCode,
    currency,
    itemsTotalCents,
    shippingAmountCents,
    shippingRate,
    taxCents,
    estimatedTotalCents,
    amount,
    total,
    isFreeOrder,
  }
}

// ---- The whole calculation for the hosted card checkout ---------------------------------------------------------------
// Used by BOTH the quote preview and the order creation, so what a customer is shown is what the server stores and charges.
// Same rules as the legacy checkout, except: the payment method is always card, nobody gets a "free" admin checkout, and
// shipping comes from the shop's own flat rate (lib/shipping.ts), not from a Stripe shipping rate.
export async function buildCardQuote(input: {
  items: CheckoutItemPayload[]
  shippingMethod: 'pickup' | 'ship'
  rush: boolean
  publicBaseUrl: string | null
}) {
  for (const [itemIndex, entry] of input.items.entries()) {
    if (normalizeColors(entry.colors).length === 0) {
      throw new CheckoutQuoteError(400, 'Select at least one filament color for each item.', 'COLOR_REQUIRED', { itemIndex })
    }
  }
  const ctx = await loadCheckoutContext(input.items)
  const priced = await priceLineItems(ctx, { items: input.items, rush: input.rush, publicBaseUrl: input.publicBaseUrl })
  const shippingPayload: ShippingSelection = { method: input.shippingMethod }
  const totals = await computeCheckoutTotals({
    cfg: ctx.cfg,
    itemsTotal: priced.itemsTotal,
    itemsTotalCents: priced.itemsTotalCents,
    isAdminFreeCheckout: false,
    shippingPayload,
    resolveShipping: resolveConfiguredShipping,
  })
  return { ctx, ...priced, shippingPayload, totals }
}

export type CardQuote = Awaited<ReturnType<typeof buildCardQuote>>
