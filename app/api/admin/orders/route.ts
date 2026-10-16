import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { randomUUID } from 'crypto'
import { requireAdmin, requireRole } from '@/app/api/admin/_utils'
import { ORDER_STATUSES } from '@/lib/order-status'
import { normalizeContributionType, normalizeReceiptStatus } from '@/lib/community-contributions'
import { generateOrderReceiptBestEffort } from '@/lib/receipts/order-receipts'
import { checkManualTransition } from '@/lib/order-payment-policy'
import { getAdminAuditRequestMeta, recordAdminAuditEvent } from '@/lib/admin-audit'
import { resolveMinimumUnitPrice } from '@/lib/pricing'
import { toCents } from '@/lib/currency'
import { ADMIN_ACTION_REASON_MAX_LENGTH, ADMIN_ACTION_REASON_MIN_LENGTH } from '@/lib/order-payment-evidence'

const orderStatusKeys = ORDER_STATUSES.map((entry) => entry.key) as [string, ...string[]]

const addressSchema = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
})

const itemSchema = z.object({
  modelTitle: z.string().min(1),
  material: z.string().min(1),
  quantity: z.number().int().min(1).max(1000),
  unitPriceCents: z.number().int().min(0),
  totalCents: z.number().int().min(0).optional(),
  colors: z.array(z.string().min(1)).optional(),
  finish: z.string().optional(),
  infillPct: z.number().int().min(0).max(100).optional(),
  customNotes: z.string().optional(),
  modelId: z.string().optional(),
  partId: z.string().optional(),
  partName: z.string().optional(),
  thumbnailPath: z.string().optional(),
  viewerPath: z.string().optional(),
})

const payloadSchema = z.object({
  userId: z.string().min(1),
  customerName: z.string().optional(),
  customerEmail: z.string().email().optional(),
  status: z.enum(orderStatusKeys).optional(),
  paymentMethod: z.enum(['card', 'cash', 'invoice', 'po', 'quote', 'comped']).optional(),
  shippingMethod: z.enum(['pickup', 'ship']).optional(),
  shippingAddress: addressSchema.optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  contributionType: z.string().optional(),
  donatedAmountCents: z.number().int().min(0).optional(),
  materialCostCents: z.number().int().min(0).optional(),
  machineTimeMinutes: z.number().int().min(0).optional(),
  receiptStatus: z.string().optional(),
  contributionNotes: z.string().optional(),
  notes: z.string().optional(),
  currency: z.string().min(1).optional(),
  // Explicit decision to start production although no payment is verified (recorded on the order).
  authorizeUnpaid: z.boolean().optional(),
  authorizationReason: z.string().max(300).optional(),
  // Step 4.6: a line priced under the shop's minimum per unit is the administrator's deliberate decision, with a written reason (administrators only).
  belowMinimumReason: z.string().max(ADMIN_ACTION_REASON_MAX_LENGTH).optional(),
  items: z.array(itemSchema).min(1),
}).refine((data) => data.shippingMethod !== 'ship' || data.shippingAddress, {
  message: 'Shipping address is required for shipping orders.',
  path: ['shippingAddress'],
})

export async function POST(req: NextRequest) {
  let adminId: string
  try { adminId = await requireAdmin() } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 })
  }

  try {
    const payload = payloadSchema.parse(await req.json())
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 })
    }

    const items = payload.items.map((item) => {
      const totalCents = item.totalCents ?? item.unitPriceCents * item.quantity
      return {
        modelId: item.modelId || undefined,
        modelTitle: item.modelTitle,
        partId: item.partId || undefined,
        partName: item.partName || undefined,
        material: item.material,
        colors: item.colors && item.colors.length ? item.colors : undefined,
        infillPct: item.infillPct ?? undefined,
        finish: item.finish || undefined,
        customNotes: item.customNotes || undefined,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents,
        thumbnailPath: item.thumbnailPath || undefined,
        viewerPath: item.viewerPath || undefined,
      }
    })

    const subtotalCents = items.reduce((sum, item) => sum + item.totalCents, 0)
    const discountPercent = payload.discountPercent ?? undefined
    const totalCents = discountPercent
      ? Math.max(0, Math.round(subtotalCents * (1 - discountPercent / 100)))
      : subtotalCents
    const paymentIntentId = `admin_${randomUUID()}`
    const contributionType = normalizeContributionType(payload.contributionType)
    const receiptStatus = normalizeReceiptStatus(payload.receiptStatus)
    const paymentMethod = payload.paymentMethod ?? (totalCents === 0 ? 'comped' : 'cash')
    // Production without a verified payment (a no-charge order, or an explicit authorization) is an administrator
    // decision, not a staff one.
    const requestedStatus = payload.status ?? 'queued'
    const paymentStatus = totalCents === 0 ? 'free' : 'pending'
    if (totalCents === 0 || payload.authorizeUnpaid) {
      try { await requireRole(['admin']) } catch (e: any) {
        return NextResponse.json({ error: 'Only administrators can create no-charge orders or authorize production without a verified payment.' }, { status: e.status || 403 })
      }
    }
    // A line under the shop's minimum per unit (an order made by hand does not go through the price engine) needs an administrator and a written reason; a
    // fully free order is the existing no-charge flow above and keeps its own rule.
    const cfg = await prisma.siteConfig.findUnique({ where: { id: 'main' } })
    const commonMinimumCents = toCents(resolveMinimumUnitPrice(cfg))
    const belowMinimum = items.flatMap((item, index) => (item.unitPriceCents < commonMinimumCents ? [{ index, unitPriceCents: item.unitPriceCents }] : []))
    let adminPricing: { by: string; at: string; reason: string; commonMinimumCents: number; lines: Array<{ index: number; unitPriceCents: number }> } | null = null
    if (belowMinimum.length > 0 && totalCents > 0) {
      try { await requireRole(['admin']) } catch (e: any) {
        return NextResponse.json({ error: 'Only administrators can price a line under the shop\'s minimum.', code: 'BELOW_MINIMUM_ADMIN_ONLY' }, { status: e.status || 403 })
      }
      const belowReason = (payload.belowMinimumReason ?? '').trim()
      if (belowReason.length < ADMIN_ACTION_REASON_MIN_LENGTH) {
        return NextResponse.json({ error: `A line is priced under the shop's minimum (${commonMinimumCents} cents): a written reason of at least ${ADMIN_ACTION_REASON_MIN_LENGTH} characters is required (belowMinimumReason).`, code: 'BELOW_MINIMUM_REASON_REQUIRED', details: { minimumCents: commonMinimumCents, lines: belowMinimum } }, { status: 400 })
      }
      adminPricing = { by: adminId, at: new Date().toISOString(), reason: belowReason, commonMinimumCents, lines: belowMinimum }
    }
    const baseMetadata = { paymentIntentId, adminCreatedAt: new Date().toISOString(), adminCreatedBy: adminId, ...(adminPricing ? { adminPricing } : {}) }
    const transition = checkManualTransition({ paymentStatus, metadata: baseMetadata }, requestedStatus, {
      authorizeUnpaid: payload.authorizeUnpaid,
      adminId,
      reason: payload.authorizationReason,
    })
    if (!transition.allowed) {
      return NextResponse.json({ error: transition.error, code: 'PAYMENT_NOT_VERIFIED' }, { status: 409 })
    }

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.printOrder.create({
      data: {
        userId: user.id,
        customerEmail: payload.customerEmail || user.email || undefined,
        customerName: payload.customerName || user.name || undefined,
        status: requestedStatus,
        paymentMethod,
        paymentStatus,
        shippingMethod: payload.shippingMethod ?? 'pickup',
        shippingAddress: payload.shippingMethod === 'ship' ? payload.shippingAddress : undefined,
        subtotalCents,
        discountPercent,
        totalCents,
        currency: payload.currency?.toUpperCase() || 'USD',
        contributionType,
        donatedAmountCents: typeof payload.donatedAmountCents === 'number' ? payload.donatedAmountCents : undefined,
        materialCostCents: typeof payload.materialCostCents === 'number' ? payload.materialCostCents : undefined,
        machineTimeMinutes: typeof payload.machineTimeMinutes === 'number' ? payload.machineTimeMinutes : undefined,
        receiptStatus,
        contributionNotes: payload.contributionNotes || undefined,
        notes: payload.notes || undefined,
        metadata: (transition.metadata ?? baseMetadata) as any,
        items: { create: items },
      },
      select: { id: true, orderNumber: true, status: true },
      })
      // an order made by hand leaves a trace: who, with which payment decision, and any price under the minimum
      await recordAdminAuditEvent({
        adminId,
        action: 'admin.order.create',
        targetType: 'order',
        targetId: created.id,
        ...getAdminAuditRequestMeta(req),
        metadata: {
          userId: user.id, paymentMethod, paymentStatus, status: requestedStatus, totalCents, itemCount: items.length,
          authorizedUnpaid: Boolean(payload.authorizeUnpaid), ...(adminPricing ? { adminPricing } : {}),
        },
      }, tx)
      return created
    })

    await generateOrderReceiptBestEffort(order.id, 'adminOrderCreate')

    return NextResponse.json({ order })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Invalid request.' }, { status: 400 })
  }
}
