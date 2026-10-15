// What happens AFTER a payment has been verified and committed: receipt, production report, stock, PrintLab, notifications.
//
// Rules:
//  * They never decide anything about the payment and never run inside the payment transaction: a failing effect cannot undo a
//    verified payment, and a slow one cannot hold a database connection.
//  * Each effect is recorded per order in metadata.postPayment.<effect> = { status, attempts, ... }:
//      claimed (running) -> done | skipped | failed.  A "done"/"skipped" effect is never run again; a "failed" or stuck "running"
//      one is run again by runPostPaymentEffects / recoverPostPaymentEffects. Two workers at once: only one claims it.
//  * So an effect is idempotent from our side (it runs to completion once) and recoverable (the failure and the number of attempts
//    are on the order, and the recovery function finds them).
import path from 'path'
import { prisma } from '@/lib/db'
import { metadataRecord, updateOrderMetadata } from '@/lib/order-metadata'
import { generateAndStoreOrderReceipt } from '@/lib/receipts/order-receipts'
import { buildManufacturabilitySnapshot, renderManufacturabilityReportPdf, type ManufacturabilityModelInput } from '@/lib/manufacturability-report'
import { saveBuffer } from '@/lib/storage'
import { consumeProductTemplateInventoryOnCheckout } from '@/lib/stockworks-product-consumption'
import { autoSubmitOrderToPrintLab } from '@/lib/printlab-order-submit'
import { isPrintLabConfigured } from '@/lib/printlab'
import { sendAdminDiscordNotification } from '@/lib/discord'
import { sendAdminPushNotification } from '@/lib/push'
import { formatCurrency, type Currency } from '@/lib/currency'
import { logEvent } from '@/lib/observability-logger'
import type { CheckoutLineItem } from '@/types/checkout'

// The outside services an effect talks to. Tests replace these (the same pattern as viewerGuards / fileRouteGuards).
export const effectHooks = {
  receipt: generateAndStoreOrderReceipt,
  consumeInventory: consumeProductTemplateInventoryOnCheckout,
  printLabConfigured: isPrintLabConfigured,
  submitToPrintLab: autoSubmitOrderToPrintLab,
  notifyDiscord: sendAdminDiscordNotification,
  notifyPush: sendAdminPushNotification,
}

export type EffectKind = 'receipt' | 'report' | 'inventory' | 'printlab' | 'notify'
export const EFFECT_ORDER: EffectKind[] = ['receipt', 'report', 'inventory', 'printlab', 'notify']
type EffectResult = 'done' | 'skipped'

// A "running" claim older than this is considered abandoned (the worker died).
const RUNNING_TTL_MS = 5 * 60 * 1000

async function claim(orderId: string, kind: EffectKind): Promise<boolean> {
  return updateOrderMetadata(orderId, (meta) => {
    const all = metadataRecord(meta.postPayment)
    const current = metadataRecord(all[kind])
    const startedAt = Date.parse(String(current.startedAt || ''))
    const finished = current.status === 'done' || current.status === 'skipped'
    const running = current.status === 'running' && Number.isFinite(startedAt) && Date.now() - startedAt < RUNNING_TTL_MS
    if (finished || running) return { metadata: meta, result: false }
    const now = new Date().toISOString()
    return {
      metadata: { ...meta, postPayment: { ...all, [kind]: { status: 'running', startedAt: now, attempts: (Number(current.attempts) || 0) + 1 } } },
      result: true,
    }
  })
}

async function finish(orderId: string, kind: EffectKind, status: 'done' | 'skipped' | 'failed', error?: string) {
  await updateOrderMetadata(orderId, (meta) => {
    const all = metadataRecord(meta.postPayment)
    const current = metadataRecord(all[kind])
    return {
      metadata: {
        ...meta,
        postPayment: {
          ...all,
          [kind]: { ...current, status, at: new Date().toISOString(), ...(error ? { error: error.slice(0, 300) } : { error: null }) },
        },
      },
      result: undefined,
    }
  })
}

// ---- the effects ----------------------------------------------------------------------------------------------------------------
type FullOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>
const loadOrder = (orderId: string) => prisma.printOrder.findUnique({ where: { id: orderId }, include: { items: true } })

async function receipt(order: FullOrder): Promise<EffectResult> {
  await effectHooks.receipt(order.id)
  return 'done'
}

// Lines kept at order creation (hosted checkout) so the report does not need the cart again; older orders: rebuilt from the items.
function reportLines(order: FullOrder): CheckoutLineItem[] {
  const stored = metadataRecord(metadataRecord(order.metadata).checkout).lines
  if (Array.isArray(stored) && stored.length > 0) return stored as CheckoutLineItem[]
  return order.items.map((item) => {
    const config = metadataRecord(item.configuration)
    return {
      modelId: item.modelId || '',
      title: item.modelTitle,
      partName: item.partName || undefined,
      qty: item.quantity,
      scale: typeof config.scale === 'number' ? config.scale : 1,
      unitPrice: item.unitPriceCents / 100,
      lineTotal: item.totalCents / 100,
      material: item.material,
      finish: item.finish || undefined,
    } as CheckoutLineItem
  })
}

async function report(order: FullOrder): Promise<EffectResult> {
  const artifacts = metadataRecord(metadataRecord(order.metadata).artifacts)
  if (artifacts.manufacturabilityReport) return 'skipped' // the old checkout already made it
  const lineItems = reportLines(order)
  const modelIds = [...new Set(lineItems.map((line) => line.modelId).filter(Boolean))]
  const models = modelIds.length > 0
    ? await prisma.model.findMany({
      where: { id: { in: modelIds } },
      select: { id: true, title: true, material: true, sizeXmm: true, sizeYmm: true, sizeZmm: true, printabilityScore: true, failureRiskScore: true, orientationSuggestion: true, supportLikelihood: true },
    })
    : []
  const modelsById = new Map<string, ManufacturabilityModelInput>(models.map((model) => [model.id, model]))
  const snapshot = buildManufacturabilitySnapshot({ lineItems, modelsById })
  const pdf = renderManufacturabilityReportPdf(snapshot, `Order ${order.orderNumber ?? order.id}`)
  const relativePath = path.posix.join('orders', order.id, 'reports', `manufacturability-${Date.now()}.pdf`)
  await saveBuffer(relativePath, pdf)
  await updateOrderMetadata(order.id, (meta) => ({
    metadata: {
      ...meta,
      artifacts: {
        ...metadataRecord(meta.artifacts),
        manufacturabilityReport: { version: 1, filePath: `/${relativePath}`, generatedAt: snapshot.generatedAt, summary: snapshot.summary },
      },
    },
    result: undefined,
  }))
  return 'done'
}

async function inventory(order: FullOrder): Promise<EffectResult> {
  const cartItems = metadataRecord(order.metadata).cartItems
  const items = Array.isArray(cartItems) ? cartItems.filter((entry) => entry && typeof entry === 'object' && (entry as any).productTemplateId) : []
  if (items.length === 0) return 'skipped'
  const result = await effectHooks.consumeInventory(order.stripePaymentIntentId || order.id, items as any)
  if (result && (result as any).ok === false && (result as any).reason !== 'no_product_templates') {
    throw new Error(`Inventory not updated: ${(result as any).reason || 'unknown'}`)
  }
  return 'done'
}

async function printlab(order: FullOrder): Promise<EffectResult> {
  // Only an order that really is in the queue, and only if PrintLab is in use at all. (Submission itself carries one
  // idempotency key per item, so asking PrintLab twice cannot create two jobs.)
  if (order.status !== 'queued' || !(await effectHooks.printLabConfigured())) return 'skipped'
  const result = await effectHooks.submitToPrintLab(order.id, 'stripe_checkout')
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; ') || 'PrintLab submission failed')
  return 'done'
}

async function notify(order: FullOrder): Promise<EffectResult> {
  const total = formatCurrency(order.totalCents / 100, order.currency as Currency)
  const review = order.paymentReviewReason ? ` — NEEDS REVIEW: ${order.paymentReviewReason}` : ''
  const base = (process.env.BASE_URL || '').replace(/\/+$/, '')
  const adminUrl = base ? `${base}/admin/users/${order.userId || 'guest'}/orders/${order.id}` : undefined
  await effectHooks.notifyDiscord({
    title: `New paid order${review}`,
    body: [
      `Order MW-${String(order.orderNumber).padStart(5, '0')}`,
      `Total: ${total}`,
      `Fulfillment: ${order.shippingMethod === 'ship' ? 'ship' : 'pickup'}`,
      order.customerEmail ? `Email: ${order.customerEmail}` : null,
      adminUrl || null,
    ],
    meta: { orderId: order.id, orderNumber: order.orderNumber ?? undefined, paymentIntentId: order.stripePaymentIntentId ?? undefined },
  })
  await effectHooks.notifyPush({
    title: order.paymentReviewReason ? 'Paid order needs review' : 'Payment received',
    body: `${total} - ${order.shippingMethod === 'ship' ? 'ship' : 'pickup'}`,
    url: adminUrl || `${base || ''}/admin`,
    tag: `payment:${order.id}`,
    data: { orderId: order.id, paymentStatus: order.paymentStatus },
  })
  return 'done'
}

const RUNNERS: Record<EffectKind, (order: FullOrder) => Promise<EffectResult>> = { receipt, report, inventory, printlab, notify }

export async function runPostPaymentEffects(orderId: string): Promise<void> {
  for (const kind of EFFECT_ORDER) {
    try {
      if (!(await claim(orderId, kind))) continue
      const order = await loadOrder(orderId)
      if (!order) return
      try {
        const status = await RUNNERS[kind](order)
        await finish(orderId, kind, status)
      } catch (err) {
        await finish(orderId, kind, 'failed', err instanceof Error ? err.message : String(err))
        logEvent({ event: 'order.effect', level: 'warn', outcome: 'failed', orderId, effect: kind, message: err instanceof Error ? err.message : String(err) })
      }
    } catch (err) {
      // Even the bookkeeping failed (database trouble): the effect stays as it was and is picked up by the recovery.
      console.error(`Post-payment effect "${kind}" could not be recorded for order ${orderId}:`, err)
    }
  }
}

// Paid orders where some effect is missing, failed or abandoned. Safe to call at any time and from several places.
export async function recoverPostPaymentEffects(limit = 50): Promise<{ checked: number; rerun: string[] }> {
  const candidates = await prisma.printOrder.findMany({
    where: { paidAt: { not: null } },
    orderBy: { paidAt: 'desc' },
    take: Math.max(limit * 4, 200),
    select: { id: true, metadata: true },
  })
  const rerun: string[] = []
  for (const order of candidates) {
    if (rerun.length >= limit) break
    const all = metadataRecord(metadataRecord(order.metadata).postPayment)
    const incomplete = EFFECT_ORDER.some((kind) => {
      const status = metadataRecord(all[kind]).status
      return status !== 'done' && status !== 'skipped'
    })
    if (!incomplete) continue
    await runPostPaymentEffects(order.id)
    rerun.push(order.id)
  }
  return { checked: candidates.length, rerun }
}
