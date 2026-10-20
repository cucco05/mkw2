import { prisma } from '@/lib/db'
import { mapFulfillmentToOrderStatus, mapOrderStatusToFulfillment, type FulfillmentStatusKey } from '@/lib/order-status'
import { maybeConsumeStockForOrder } from '@/lib/stockworks-consumption'
import { findLinkedJobsForOrder, findLinkedOrderForJob } from '@/lib/orderworks-link'
import { isProductionStatus } from '@/lib/order-payment-policy'
import { withReleaseLock } from '@/lib/production-release'
import { withFinancialRevision } from '@/lib/financial-revision'
import type { Prisma } from '@prisma/client'

type OrderStatusUpdate = { id: string; status: string } | null

export async function syncOrderStatusFromFulfillment(paymentIntentId: string, fulfillmentStatus?: FulfillmentStatusKey | null): Promise<OrderStatusUpdate> {
  if (!paymentIntentId || !fulfillmentStatus) return null
  const job = await prisma.jobForm.findUnique({
    where: { paymentIntentId },
    select: { id: true, paymentIntentId: true, metadata: true },
  })
  const order = await findLinkedOrderForJob({
    paymentIntentId,
    jobFormId: job?.id,
    metadata: job?.metadata,
  })
  if (!order || order.status === 'cancelled') return null
  // An order flagged for a person to look at (unverified outside order, payment anomaly) is not moved by an outside service.
  if (order.paymentReviewReason) return null
  const nextStatus = mapFulfillmentToOrderStatus(fulfillmentStatus)
  if (order.status === nextStatus) return order
  // An external fulfilment update can never move an order into production unless it is RELEASED (verified payment, or an authorization - and no payment under
  // review, being confirmed or still open). Decided under the lock on the order, on the facts read after it.
  const updated = await withReleaseLock(order.id, 'orderworks-sync', async ({ tx, order: fresh, decision }) => {
    if (fresh.status === 'cancelled' || fresh.paymentReviewReason) return null
    if (fresh.status === nextStatus) return { id: fresh.id, status: fresh.status }
    if (isProductionStatus(nextStatus) && !decision.released) return null
    // (step 4.6, S6, P2b) a fulfilment update from OrderWorks can cancel an order: that is a change of its money situation, and the financial revision goes up in this
    // same UPDATE. (It can never re-open one: a cancelled order is refused above.)
    return tx.printOrder.update({
      where: { id: fresh.id },
      data: withFinancialRevision(fresh, {
        status: nextStatus,
        failedAt: null,
        failureNote: null,
        ...(nextStatus === 'queued' ? { printerId: null, printerAssignedAt: null, printerAssignedBy: null } : {}),
      }),
      select: { id: true, status: true },
    })
  }, { require: 'none' })
  if (!updated) return null
  try {
    // taking the material out of stock decides for itself whether the order is released
    await maybeConsumeStockForOrder(order.id, 'orderworks-fulfillment')
  } catch (err) {
    console.error('StockWorks consumption after an OrderWorks fulfilment update failed:', err)
  }
  return updated
}

export async function syncJobFulfillmentFromOrderStatus(orderId: string): Promise<{ jobId: string; fulfillmentStatus: FulfillmentStatusKey } | null> {
  if (!orderId) return null
  const order = await prisma.printOrder.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, metadata: true },
  })
  if (!order) return null
  const jobs = await findLinkedJobsForOrder(order.id, order.metadata)
  if (jobs.length === 0) return null
  const fulfillmentStatus = mapOrderStatusToFulfillment(order.status)
  const staleJobs = jobs.filter((job) => job.fulfillmentStatus !== fulfillmentStatus)
  if (staleJobs.length > 0) {
    await prisma.jobForm.updateMany({
      where: { id: { in: staleJobs.map((job) => job.id) } },
      data: { fulfillmentStatus },
    })
  }
  return { jobId: jobs[0].id, fulfillmentStatus }
}

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, any>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return out.length > 0 ? out : undefined
}

function asNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function buildShippingPayload(order: { shippingMethod: string; shippingAddress: unknown }): Prisma.InputJsonValue {
  const method = (order.shippingMethod || '').toLowerCase() === 'ship' ? 'ship' : 'pickup'
  if (method === 'pickup') return { method }
  const address = asRecord(order.shippingAddress)
  return address ? { method, address } : { method }
}

function buildJobLineItemsFromOrder(
  items: Array<{
    modelId: string | null
    partId: string | null
    partName: string | null
    modelTitle: string
    quantity: number
    unitPriceCents: number
    totalCents: number
    material: string
    colors: unknown
    infillPct: number | null
    finish: string | null
    customNotes: string | null
    configuration: unknown
    viewerPath: string | null
  }>,
  currentLineItems: unknown,
): Prisma.InputJsonValue {
  const existingItems = Array.isArray(currentLineItems) ? currentLineItems : []
  const payload = items.map((item, idx) => {
    const existing = asRecord(existingItems[idx])
    const config = asRecord(item.configuration)
    const modelId = asString(item.modelId) || asString(existing?.modelId) || `order-item-${idx + 1}`
    const partId = asString(item.partId) || asString(existing?.partId)
    const title = item.modelTitle || asString(existing?.title) || `Item ${idx + 1}`
    const scale = asNumber(config?.scale) || asNumber(existing?.scale) || 1
    const storagePath = asString(config?.storagePath) || asString(existing?.storagePath) || asString(item.viewerPath)
    const storageUrl = asString(config?.storageUrl) || asString(existing?.storageUrl)
    return {
      modelId,
      partId: partId || undefined,
      partName: asString(item.partName) || asString(existing?.partName) || undefined,
      title,
      qty: item.quantity,
      scale,
      unitPrice: Number((item.unitPriceCents / 100).toFixed(2)),
      lineTotal: Number((item.totalCents / 100).toFixed(2)),
      undiscountedLineTotal: Number((item.totalCents / 100).toFixed(2)),
      material: item.material || asString(existing?.material) || 'PLA',
      colors: asStringArray(item.colors) || asStringArray(existing?.colors),
      finish: asString(item.finish) || asString(existing?.finish) || undefined,
      infillPct: item.infillPct ?? (asNumber(existing?.infillPct) ?? undefined),
      customText: asString(item.customNotes) || asString(existing?.customText) || undefined,
      storagePath: storagePath || undefined,
      storageUrl: storageUrl || undefined,
    }
  })
  return payload as Prisma.InputJsonValue
}

export async function syncLinkedJobsFromOrder(orderId: string): Promise<{ updatedJobCount: number } | null> {
  if (!orderId) return null
  const order = await prisma.printOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      totalCents: true,
      currency: true,
      shippingMethod: true,
      shippingAddress: true,
      customerEmail: true,
      metadata: true,
      items: {
        select: {
          modelId: true,
          partId: true,
          partName: true,
          modelTitle: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
          material: true,
          colors: true,
          infillPct: true,
          finish: true,
          customNotes: true,
          configuration: true,
          viewerPath: true,
        },
      },
    },
  })
  if (!order) return null

  const linkedJobs = await findLinkedJobsForOrder(order.id, order.metadata)
  if (linkedJobs.length === 0) return null

  await prisma.$transaction(
    linkedJobs.map((job) => {
      const existingMetadata = asRecord(job.metadata) || {}
      const nextMetadata: Prisma.InputJsonValue = {
        ...existingMetadata,
        orderId: order.id,
        paymentIntentId: job.paymentIntentId,
      }
      return prisma.jobForm.update({
        where: { id: job.id },
        data: {
          totalCents: order.totalCents,
          currency: (order.currency || job.currency || 'USD').toUpperCase(),
          customerEmail: order.customerEmail || job.customerEmail || null,
          shipping: buildShippingPayload(order),
          lineItems: buildJobLineItemsFromOrder(order.items, job.lineItems),
          metadata: nextMetadata,
        },
        select: { id: true },
      })
    }),
  )

  return { updatedJobCount: linkedJobs.length }
}
