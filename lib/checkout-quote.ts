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
import { estimatePricingDetails, resolveModelPricing, type PricingDetails } from '@/lib/pricing'
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

export class CheckoutQuoteError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'CheckoutQuoteError'
    this.status = status
    this.code = code
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
  targetDimensions: dimensionSchema.optional(),
  material: z.string().max(40).optional().default('PLA'),
  colors: z.array(z.string().max(64)).max(MAX_CART_COLORS).optional(),
  toleranceClass: z.enum(['draft', 'standard', 'cosmetic', 'fit_critical']).optional(),
  finish: z.string().max(40).optional(),
  infillPct: z.number().int().min(0).max(100).optional().nullable(),
  customText: z.string().max(140).optional().nullable(),
  priceMultiplier: z.number().positive().max(5).optional().nullable(),
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
  const [models, cfg, parts] = await Promise.all([
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
            filePath: true,
            previewFilePath: true,
          },
        })
      : Promise.resolve([]),
  ])
  const modelMap = new Map(models.map(m => [m.id, m]))
  if (modelMap.size !== ids.length) {
    throw new CheckoutQuoteError(404, 'One or more models are unavailable')
  }
  const partMap = new Map(parts.map((p) => [p.id, p]))
  return { userId, user, isAdmin, hasElevatedModelAccess, models, modelMap, partMap, cfg }
}

export type CheckoutContext = Awaited<ReturnType<typeof loadCheckoutContext>>

// ---- Step 2: price every cart line --------------------------------------------------------------------------------------
export async function priceLineItems(
  ctx: CheckoutContext,
  input: { items: CheckoutItemPayload[]; rush: boolean; publicBaseUrl: string | null },
) {
  const { items, rush, publicBaseUrl } = input
  const { modelMap, partMap, cfg, isAdmin } = ctx
  const discountSummary = summarizeDiscount(ctx.user)
  const pricingAdjustments = getPricingAdjustmentConfig(cfg || undefined)
  const filamentPalette = await fetch(`${publicBaseUrl}/api/stockworks/filament-colors`, { cache: 'no-store' })
    .then(async (res) => (res.ok ? await res.json() as FilamentPaletteResponse : null))
    .catch(() => null)

  const lineItems: CheckoutLineItem[] = await Promise.all(items.map(async (entry) => {
    const model = modelMap.get(entry.modelId)!
    const cm3 = model.volumeMm3 ? model.volumeMm3 / 1000 : null
    const materialChoice: MaterialType = normalizeMaterialName(entry.material || model.material || 'PLA')
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
      throw new CheckoutQuoteError(400, 'Too many colors selected for model')
    }
    if (allowedTokens && rawColors.some((color) => !isColorAllowed(color, allowedTokens))) {
      throw new CheckoutQuoteError(400, 'One or more selected colors are not allowed for this model')
    }
    if (rawColors.some((color) => !isColorAvailableForMaterial(color, filamentPalette, materialChoice))) {
      throw new CheckoutQuoteError(400, 'One or more selected colors are not available for the selected material')
    }
    const colors = normalizeColors(rawColors, slotLimit)
    const colorCountForPricing = model.flatRatePricing ? 1 : colors.length
    const finishChoice = entry.finish ? String(entry.finish) : null
    const part = entry.partId ? partMap.get(entry.partId) || null : null
    const isMultipart = (model._count?.parts || 0) > 1
    if (entry.partId && (!part || part.modelId !== model.id)) {
      throw new Error('Invalid part specified for model')
    }
    let pricingDetails: PricingDetails | null = null
    const basePrice = (() => {
      if (part) {
        if (isMultipart && model.volumeMm3 != null && Number.isFinite(Number(model.volumeMm3)) && part.volumeMm3 != null && Number.isFinite(Number(part.volumeMm3)) && Number(model.volumeMm3) > 0) {
          const totalPricing = estimatePricingDetails({
            cm3: Number(model.volumeMm3) / 1000,
            material: materialChoice,
            infillPct: entry.infillPct ?? null,
            finish: finishChoice,
            supportRatio: model.supportRatio ?? null,
            colorCount: colorCountForPricing,
            cfg,
            applyMinimum: true,
          })
          pricingDetails = totalPricing
          return Number(((totalPricing.price * Number(part.volumeMm3)) / Number(model.volumeMm3)).toFixed(2))
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
          })
          return pricingDetails.price
        }
        throw new Error(`Part ${part.id} is missing pricing data`)
      }
      if (model.salePriceUsd != null && Number.isFinite(Number(model.salePriceUsd)) && Number(model.salePriceUsd) > 0) {
        return Number(model.salePriceUsd)
      }
      if (entry.productTemplateId) {
        const resolved = resolveModelPricing(model, cfg).priceUsd
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
        })
        return pricingDetails.price
      }
      if (model.priceUsd != null && Number.isFinite(Number(model.priceUsd))) {
        return Number(model.priceUsd)
      }
      throw new Error(`Model ${model.id} is missing pricing data`)
    })()
    if (!isFinite(basePrice) || basePrice <= 0) {
      throw new Error(`Model ${model.id} is missing pricing data`)
    }
    const { scaleX, scaleY, scaleZ, uniformScale } = resolveScaleFromDimensions({
      size: { x: model.sizeXmm ?? null, y: model.sizeYmm ?? null, z: model.sizeZmm ?? null },
      target: entry.targetDimensions ?? null,
      scale: entry.scale ?? 1,
      scaleX: entry.scaleX ?? null,
      scaleY: entry.scaleY ?? null,
      scaleZ: entry.scaleZ ?? null,
      lockDimensions: entry.lockDimensions ?? null,
    })
    const volumeMultiplier = scaleX * scaleY * scaleZ
    const colorMultiplier = model.flatRatePricing ? 1 : getColorMultiplier(colors)
    const optionMultiplier = typeof entry.priceMultiplier === 'number' && Number.isFinite(entry.priceMultiplier)
      ? Math.max(0.1, Math.min(5, entry.priceMultiplier))
      : entry.toleranceClass === 'draft'
        ? 0.94
        : entry.toleranceClass === 'cosmetic'
          ? 1.08
          : entry.toleranceClass === 'fit_critical'
            ? 1.16
            : 1
    const rawUnitPrice = Number((basePrice * volumeMultiplier * colorMultiplier * optionMultiplier).toFixed(2))
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
      targetDimensions: entry.targetDimensions || undefined,
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
      leadTimeHours: leadTime?.hours ?? null,
      leadTimeWindowHours: leadTime ? { min: leadTime.minHours, max: leadTime.maxHours } : null,
      etaConfidenceScore: leadTime?.confidenceScore ?? null,
      leadTimeSignals: leadTime?.signals ?? null,
    }
  }))
  const itemsTotal = lineItems.reduce((sum, item) => sum + item.lineTotal, 0)
  if (!isFinite(itemsTotal) || itemsTotal < 0) {
    throw new CheckoutQuoteError(400, 'Cart total cannot be negative')
  }
  return { lineItems, itemsTotal, discountSummary, pricingAdjustments }
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
  isAdminFreeCheckout: boolean
  shippingPayload: ShippingSelection
  resolveShipping?: ShippingResolver
}) {
  const { cfg, itemsTotal, isAdminFreeCheckout, shippingPayload, resolveShipping = resolveStripeShippingRate } = input
  const currencyCode = getCurrency().toUpperCase() as Currency
  const currency = currencyCode.toLowerCase()
  const minimumOrderSubtotal = cfg?.minimumOrderSubtotalUsd != null && Number.isFinite(Number(cfg.minimumOrderSubtotalUsd))
    ? Number(cfg.minimumOrderSubtotalUsd)
    : null
  if (!isAdminFreeCheckout && minimumOrderSubtotal && itemsTotal < minimumOrderSubtotal) {
    throw new CheckoutQuoteError(400, `Minimum order subtotal is ${formatCurrency(minimumOrderSubtotal, currencyCode)}.`)
  }
  const { shippingAmountCents, shippingRate } = await resolveShipping({ shippingPayload, currencyCode, isAdminFreeCheckout })
  // Whole cents from here on: the same integers are shown to the customer, stored on the order and sent to Stripe.
  const itemsTotalCents = toCents(itemsTotal)
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
    throw new CheckoutQuoteError(400, 'The order total must be greater than zero.')
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
  for (const entry of input.items) {
    if (normalizeColors(entry.colors).length === 0) {
      throw new CheckoutQuoteError(400, 'Select at least one filament color for each item.')
    }
  }
  const ctx = await loadCheckoutContext(input.items)
  const priced = await priceLineItems(ctx, { items: input.items, rush: input.rush, publicBaseUrl: input.publicBaseUrl })
  const shippingPayload: ShippingSelection = { method: input.shippingMethod }
  const totals = await computeCheckoutTotals({
    cfg: ctx.cfg,
    itemsTotal: priced.itemsTotal,
    isAdminFreeCheckout: false,
    shippingPayload,
    resolveShipping: resolveConfiguredShipping,
  })
  return { ctx, ...priced, shippingPayload, totals }
}

export type CardQuote = Awaited<ReturnType<typeof buildCardQuote>>
