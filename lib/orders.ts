import path from 'path'
import { randomUUID } from 'crypto'
import type { Prisma, PrintOrder, PrintOrderApprovalRequest, PrintOrderItem, PrintOrderMessage, PrintOrderRevision } from '@prisma/client'
import type { JobForm } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { CheckoutLineItem, ShippingSelection, CheckoutPaymentMethod } from '@/types/checkout'
import { saveBuffer } from '@/lib/storage'
import type { OrderStatus } from '@/lib/order-status'
import { normalizePaymentMethod as normalizeOrderWorksPaymentMethod } from '@/lib/orderworks-status'
import { listOrganizationIdsForUser } from '@/lib/organizations'
import { autoSubmitOrderToPrintLab } from '@/lib/printlab-order-submit'
import { generateOrderReceiptBestEffort } from '@/lib/receipts/order-receipts'
import { hasManualPaymentRecord, isPaymentVerified, sanitizeExternalMetadata } from '@/lib/order-payment-policy'
import { AdminActionError, stripeEvidenceReasons } from '@/lib/order-payment-evidence'
import { recordAdminAuditEvent, type AdminAuditInput } from '@/lib/admin-audit'
import { withReleaseLock } from '@/lib/production-release'
import { withFinancialRevision } from '@/lib/financial-revision'
import { canRequestReprint, findOpenReprint, ReprintNotAllowedError } from '@/lib/reprint'
import { syncStripePaymentIntent } from '@/lib/stripe-payments'

export type PersistOrderPayload = {
  // Absent for an order created BEFORE payment (hosted checkout): the payment is linked to it later, by verified Stripe data.
  paymentIntentId?: string | null
  amountCents: number
  // Parts of amountCents that are not items: shipping, and tax that was added on top (see lib/tax.ts)
  shippingCents?: number
  taxCents?: number
  currency: string
  lineItems: CheckoutLineItem[]
  shipping: ShippingSelection
  paymentMethod: CheckoutPaymentMethod
  userId?: string | null
  customerEmail?: string | null
  customerName?: string | null
  discountPercent?: number | null
  organizationId?: string | null
  paymentStatus?: string | null
  stripeChargeId?: string | null
  stripeCustomerId?: string | null
  receiptUrl?: string | null
  metadata?: Prisma.InputJsonValue
  // The order comes from an outside service whose payment claim is not verified here (OrderWorks inbound webhook): it is created
  // unpaid, waiting for review, flagged for a person, and never enters production by itself.
  untrustedSource?: boolean
}

type InitialOrderStatusInput = {
  amountCents: number
  paymentMethod: CheckoutPaymentMethod
  shipping: ShippingSelection
  // The payment status the order is created with. Only a VERIFIED payment (see lib/order-payment-policy.ts)
  // lets a new order into the production queue; anything else waits for payment.
  paymentStatus?: string | null
  // True when an administrator explicitly authorized production without a verified payment.
  productionAuthorized?: boolean
}

export function resolveInitialOrderStatus({ paymentMethod, paymentStatus, productionAuthorized }: InitialOrderStatusInput): OrderStatus {
  // A quote request is a request for an offer: it is never an order in production.
  if (paymentMethod === 'quote') return 'awaiting_review'
  if (isPaymentVerified(paymentStatus) || productionAuthorized) return 'queued'
  return 'awaiting_payment'
}

function normalizeCurrency(code: string) {
  if (!code) return 'USD'
  return code.toUpperCase()
}

function normalizeShippingSelection(raw: unknown): ShippingSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { method: 'pickup' }
  }
  const value = raw as ShippingSelection
  if (value.method === 'ship') {
    return { method: 'ship', address: value.address || undefined }
  }
  return { method: 'pickup' }
}

function normalizePaymentMethod(raw?: string | null): CheckoutPaymentMethod {
  const normalized = normalizeOrderWorksPaymentMethod(raw)
  if (normalized === 'paypal' || normalized === 'cash' || normalized === 'invoice' || normalized === 'po' || normalized === 'quote' || normalized === 'comped') {
    return normalized
  }
  return 'card'
}

function coerceLineItems(raw: unknown): CheckoutLineItem[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item) => item && typeof item === 'object') as CheckoutLineItem[]
}

// The one place that turns a priced cart into the rows of an order (status, items, totals, metadata). Used for orders that
// are written after payment (recordCustomerOrder) and for orders created before payment (lib/checkout-orders.ts), so both
// follow the same rules, including the production gate in resolveInitialOrderStatus.
export function buildOrderCreateData(payload: PersistOrderPayload): Prisma.PrintOrderUncheckedCreateInput {
  const paymentIntentId = payload.paymentIntentId || null
  const subtotal = payload.lineItems.reduce((sum, item) => {
    const base = item.undiscountedLineTotal ?? item.lineTotal
    return sum + Math.max(0, base)
  }, 0)
  const subtotalCents = Math.max(0, Math.round((subtotal > 0 ? subtotal : payload.amountCents / 100) * 100))
  const shippingData = payload.shipping || { method: 'pickup' }
  const isQuote = payload.paymentMethod === 'quote'
  // Only an explicit status coming from a verified payment (or a no-charge order) can start production.
  const untrusted = payload.untrustedSource === true
  const initialPaymentStatus = untrusted ? 'pending' : (payload.paymentStatus || 'pending')
  const status = untrusted
    ? 'awaiting_review'
    : resolveInitialOrderStatus({
      amountCents: payload.amountCents,
      paymentMethod: payload.paymentMethod,
      shipping: shippingData,
      paymentStatus: initialPaymentStatus,
    })
  const itemsData: Prisma.PrintOrderItemCreateWithoutOrderInput[] = payload.lineItems.map((item) => ({
    modelId: item.modelId,
    modelTitle: item.title,
    partId: item.partId || undefined,
    partName: item.partName || undefined,
    material: item.material,
    colors: item.colors && item.colors.length > 0 ? item.colors : undefined,
    infillPct: item.infillPct ?? undefined,
    finish: item.finish ?? undefined,
    customNotes: item.customText || undefined,
    quantity: item.qty,
    unitPriceCents: Math.max(0, Math.round(item.unitPrice * 100)),
    totalCents: Math.max(0, Math.round(item.lineTotal * 100)),
    configuration: {
      productTemplateId: item.productTemplateId,
      scale: item.scale,
      colors: item.colors,
      toleranceClass: item.toleranceClass ?? 'standard',
      infillPct: item.infillPct,
      finish: item.finish,
      customText: item.customText,
      leadTimeHours: item.leadTimeHours ?? null,
      leadTimeWindowHours: item.leadTimeWindowHours ?? null,
      etaConfidenceScore: item.etaConfidenceScore ?? null,
      priceMultiplier: item.pricingBreakdown?.priceMultiplier,
      storagePath: item.storagePath,
      storageUrl: item.storageUrl,
      // step 4.6: what was SOLD on this line (a whole model, a product, a single part, or one part of a complete copy of a model: `setOrdinal` is the same on
      // every line of the copy) and the minimum that applied. A snapshot written once, by the server; orders from before have none, and it is never rebuilt.
      unit: item.unit ? { kind: item.unit.kind, setOrdinal: item.unit.setOrdinal, copies: item.unit.copies, parts: item.unit.partCount } : undefined,
      pricing: item.minimum ? { minimumUnitCents: item.minimum.unitCents, floored: item.minimum.floored, waiverId: item.minimum.waiverId } : undefined,
    },
    viewerPath: item.storagePath || undefined,
  }))
  const metadataPayload: Prisma.InputJsonValue = (() => {
    if (payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)) {
      return {
        // (step 4.6, S6, F21) what came with the request first, the identifier the SERVER holds for the payment last: nothing the sender wrote can replace it. For an
        // outside order the proofs and markers are stripped again here; the links (job, payment identifier) are the caller's own and are kept.
        ...(untrusted ? sanitizeExternalMetadata(payload.metadata, { keepLinks: true }) : (payload.metadata as Record<string, any>)),
        ...(paymentIntentId ? { paymentIntentId } : {}),
      }
    }
    if (Array.isArray(payload.metadata)) {
      return {
        ...(paymentIntentId ? { paymentIntentId } : {}),
        details: payload.metadata,
      }
    }
    return paymentIntentId ? { paymentIntentId } : {}
  })()
  const metadataRecord = metadataPayload as Record<string, unknown>
  const organizationRole = typeof metadataRecord.organizationRole === 'string' ? metadataRecord.organizationRole : null
  const orgRequiresApproval = metadataRecord.quoteApprovalRequired === true

  return {
      paymentMethod: payload.paymentMethod,
      shippingMethod: shippingData.method || 'pickup',
      shippingAddress: shippingData.address ? shippingData.address : undefined,
      status,
      subtotalCents,
      discountPercent: payload.discountPercent ?? undefined,
      totalCents: payload.amountCents,
      shippingCents: Math.max(0, Math.round(payload.shippingCents ?? 0)),
      taxCents: Math.max(0, Math.round(payload.taxCents ?? 0)),
      currency: normalizeCurrency(payload.currency),
      // Never assume "paid": the caller must pass a payment status confirmed with the payment provider.
      paymentStatus: initialPaymentStatus,
      ...(untrusted ? { paymentReviewReason: 'external_order' } : {}),
      stripePaymentIntentId: paymentIntentId?.startsWith('pi_') ? paymentIntentId : undefined,
      stripeChargeId: payload.stripeChargeId || undefined,
      stripeCustomerId: payload.stripeCustomerId || undefined,
      receiptUrl: payload.receiptUrl || undefined,
      metadata: metadataPayload,
      organizationId: payload.organizationId || undefined,
      userId: payload.userId || undefined,
      customerEmail: payload.customerEmail || undefined,
      customerName: payload.customerName || undefined,
      items: {
        create: itemsData,
      },
      ...(isQuote
        ? {
          approvalRequests: {
            create: {
              message: organizationRole === 'requester' || orgRequiresApproval
                ? 'Requester submitted quote. Approver review is required before production.'
                : 'Please approve this quote to move your order into production.',
            },
          },
        }
        : {}),
  }
}

export async function recordCustomerOrder(payload: PersistOrderPayload & { paymentIntentId: string }) {
  const order = await prisma.printOrder.create({ data: buildOrderCreateData(payload) })
  // A Stripe webhook that arrived BEFORE this order existed found nothing to update and was (correctly) answered "done".
  // Re-reading the payment now closes that gap: any change before this point is applied here, any later one by the webhook.
  if (payload.paymentIntentId.startsWith('pi_')) {
    try {
      await syncStripePaymentIntent(payload.paymentIntentId, 'order.created')
    } catch (err) {
      console.error('Stripe reconciliation after order creation failed (webhook retries will cover it):', err)
    }
  }
  await generateOrderReceiptBestEffort(order.id, 'recordCustomerOrder')
  return order
}

export type OrderListEntry = PrintOrder & { items: Pick<PrintOrderItem, 'id' | 'modelTitle' | 'quantity' | 'totalCents' | 'thumbnailPath'>[] }

type OrderWorksLink = {
  paymentIntentId: string | null
  jobFormId: string | null
}

function extractOrderWorksLink(metadata: unknown): OrderWorksLink | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const record = metadata as Record<string, unknown>
  const source = typeof record.source === 'string' ? record.source.trim().toLowerCase() : null
  const paymentIntentId = typeof record.paymentIntentId === 'string' && record.paymentIntentId.trim().length > 0
    ? record.paymentIntentId.trim()
    : null
  const jobFormId = typeof record.jobFormId === 'string' && record.jobFormId.trim().length > 0
    ? record.jobFormId.trim()
    : null

  if (source !== 'orderworks' && !jobFormId) return null
  return { paymentIntentId, jobFormId }
}

async function filterVisibleOrdersForUser<T extends { id: string; metadata: unknown }>(orders: T[]): Promise<T[]> {
  if (orders.length === 0) return orders

  const linked = orders
    .map((order) => ({ orderId: order.id, link: extractOrderWorksLink(order.metadata) }))
    .filter((entry): entry is { orderId: string; link: OrderWorksLink } => Boolean(entry.link))

  if (linked.length === 0) return orders

  const paymentIntentIds = Array.from(new Set(linked.map((entry) => entry.link.paymentIntentId).filter((v): v is string => Boolean(v))))
  const jobFormIds = Array.from(new Set(linked.map((entry) => entry.link.jobFormId).filter((v): v is string => Boolean(v))))
  const jobWhere: Prisma.JobFormWhereInput[] = []
  if (paymentIntentIds.length > 0) jobWhere.push({ paymentIntentId: { in: paymentIntentIds } })
  if (jobFormIds.length > 0) jobWhere.push({ id: { in: jobFormIds } })
  if (jobWhere.length === 0) return orders

  const jobs = await prisma.jobForm.findMany({
    where: { OR: jobWhere },
    select: { id: true, paymentIntentId: true },
  })
  const jobIds = new Set(jobs.map((job) => job.id))
  const paymentIds = new Set(jobs.map((job) => job.paymentIntentId))

  return orders.filter((order) => {
    const link = extractOrderWorksLink(order.metadata)
    if (!link) return true
    if (link.jobFormId && jobIds.has(link.jobFormId)) return true
    if (link.paymentIntentId && paymentIds.has(link.paymentIntentId)) return true
    return false
  })
}

export async function listOrdersForUser(userId: string, limit = 20): Promise<OrderListEntry[]> {
  if (!userId) return []
  const orgIds = await listOrganizationIdsForUser(userId)
  const orders = await prisma.printOrder.findMany({
    where: {
      OR: [
        { userId },
        ...(orgIds.length > 0 ? [{ organizationId: { in: orgIds } }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      items: {
        select: {
          id: true,
          modelTitle: true,
          quantity: true,
          totalCents: true,
          thumbnailPath: true,
        },
      },
    },
  })
  return filterVisibleOrdersForUser(orders)
}

export type OrderDetail = PrintOrder & {
  items: PrintOrderItem[]
  revisions: (PrintOrderRevision & { user?: { id: string; name: string | null; email: string } | null })[]
  messages: (PrintOrderMessage & { user?: { id: string; name: string | null; email: string } | null })[]
  approvalRequests: (PrintOrderApprovalRequest & { requestedBy?: { id: string; name: string | null; email: string } | null })[]
  failurePhotos: { id: string; filePath: string; label: string; confidence: number | null; note: string | null; createdAt: Date }[]
  reprintOf: { id: string; orderNumber: number | null } | null
  reprints: { id: string; orderNumber: number | null; status: string; createdAt: Date }[]
}

// How the payment of the order made from a job form is established (step 4.6, D8). Three states are kept DISTINCT and none is ever taken from a typed identifier:
//   * the job came from an outside service (`trusted: false`, the OrderWorks webhook): the sender's claim is ignored; the order is created unpaid and in review;
//   * `payment.kind === 'stripe'` (the default): the order is created UNPAID and only the verification with Stripe (lib/payment-sync.ts) can mark it paid - an
//     administrator's word is not enough for a card payment;
//   * `payment.kind === 'manual'`: an administrator registered a payment taken outside Stripe (cash, transfer, ...). The order carries `metadata.manualPayment =
//     { by, at, reason, method }` and NEVER a Stripe id, a payment date or Stripe data: it is accountable, and it is not a verified Stripe payment.
// (step 4.6, S6) an attested payment says HOW the money was received (`receivedVia`: cash or a bank transfer, with the reference of the bank statement; 'none' for a
// no-charge decision), and HOW MUCH - which is never typed: it is the total of the order and its currency, taken here.
export type ReceivedVia = 'cash' | 'bank_transfer' | 'none'
export type JobPaymentMode =
  | { kind: 'stripe' }
  | { kind: 'manual'; by: string; at: string; reason: string; method: string; receivedVia: ReceivedVia; reference?: string | null }

export function buildManualPaymentRecord(mode: { by: string; at: string; reason: string; method: string; receivedVia: ReceivedVia; reference?: string | null }, order: { totalCents: number; currency: string }) {
  const comped = mode.method === 'comped'
  return {
    by: mode.by, at: mode.at, reason: mode.reason, method: mode.method, receivedVia: mode.receivedVia,
    ...(mode.reference ? { reference: mode.reference } : {}),
    amountCents: comped ? 0 : Math.max(0, Math.round(order.totalCents)),
    currency: String(order.currency || '').toUpperCase(),
  }
}

export async function createOrderFromJobForm(
  job: JobForm & { user?: { id: string; name: string | null; email: string | null } | null },
  opts: { trusted?: boolean; payment?: JobPaymentMode } = {},
) {
  if (!job?.paymentIntentId) return null
  const existing = await prisma.printOrder.findFirst({
    where: {
      metadata: {
        path: ['paymentIntentId'],
        equals: job.paymentIntentId,
      },
    },
  })
  if (existing) return existing

  const lineItems = coerceLineItems(job.lineItems)
  if (lineItems.length === 0) return null
  const shipping = normalizeShippingSelection(job.shipping)
  const paymentMethod = normalizePaymentMethod(job.paymentMethod)
  const untrusted = opts.trusted === false
  const manual = !untrusted && opts.payment?.kind === 'manual' ? opts.payment : null
  // a payment registered by hand never carries a Stripe identifier: a typed `pi_...` must not be mistaken for a verified Stripe payment
  if (manual && job.paymentIntentId.startsWith('pi_')) throw new Error('A payment registered by hand cannot carry a Stripe identifier.')
  if (manual && !hasManualPaymentRecord({ manualPayment: buildManualPaymentRecord(manual, { totalCents: job.totalCents, currency: normalizeCurrency(job.currency) }) })) {
    throw new Error('A payment registered by hand must be complete: who, when, why, the agreed method, how the money was received (and the bank reference for a transfer).')
  }

  const order = await recordCustomerOrder({
    paymentIntentId: job.paymentIntentId,
    amountCents: job.totalCents,
    currency: normalizeCurrency(job.currency),
    lineItems,
    shipping,
    paymentMethod,
    // Only a payment an administrator registered by hand is taken as declared; otherwise the order waits for the verification with Stripe.
    paymentStatus: manual ? (job.paymentStatus || undefined) : undefined,
    untrustedSource: untrusted,
    userId: job.userId || undefined,
    customerEmail: job.customerEmail || job.user?.email || undefined,
    customerName: job.user?.name || undefined,
    metadata: {
      // The job form's metadata came from an outside service: it cannot carry our own markers (e.g. a production authorization) nor the ids the server writes below.
      ...sanitizeExternalMetadata(job.metadata),
      // (step 4.6, S6, F21) what the server knows is written AFTER what came from outside, so it always wins
      source: 'orderworks',
      jobFormId: job.id,
      shipping: job.shipping,
      ...(manual ? { manualPayment: buildManualPaymentRecord(manual, { totalCents: job.totalCents, currency: normalizeCurrency(job.currency) }) } : {}),
    },
  })
  if (order.status === 'queued') {
    await autoSubmitOrderToPrintLab(order.id, 'makerworks_job_webhook')
  }
  return order
}

// ---- An attested payment on an order that ALREADY EXISTS (step 4.6, S6, P6) ---------------------------------------------------------------------------------------
// `createOrderFromJobForm` records a payment attested by an administrator only when it MAKES the order; an order made earlier (an outside order, an order awaiting payment)
// was returned unchanged and the receipt was silently dropped. This is the one place that writes a receipt on an order that exists: under the lock of the release, on the
// facts read after it, in one transaction with its audit event. It writes the payment status and the record together (events E1 and E9 of the financial revision), never a
// Stripe id, a payment date or Stripe data, and it refuses an order that carries proof of a Stripe payment, a payment under review, a refund or a payment attempt: money that
// moved through Stripe is not overwritten by a word. A receipt that was registered is not changed or erased from here: the correction of a mistake is a separate procedure.
export type AttestedReceiptInput = {
  orderId: string
  adminId: string
  reason: string
  // the agreed method of the job / order and how the money was received; the amount and the currency are the order's, taken under the lock
  method: 'cash' | 'invoice' | 'po' | 'comped'
  receivedVia: ReceivedVia
  reference?: string | null
  audit: Omit<AdminAuditInput, 'adminId' | 'action' | 'targetType' | 'targetId' | 'metadata'>
  // extra facts for the audit event (e.g. the job the receipt came from)
  auditDetail?: Record<string, unknown>
}
export async function recordAttestedReceipt(input: AttestedReceiptInput) {
  return withReleaseLock(input.orderId, 'attested-receipt', async ({ tx, order }) => {
    const evidence = stripeEvidenceReasons(order, order.paymentAttempts.length, order.refundOperations.length)
    if (evidence.length > 0) {
      throw new AdminActionError('ORDER_HAS_PAYMENT_EVIDENCE', 'This order has a Stripe payment (or one on hold, or a refund) recorded against it: a payment taken outside Stripe can not be registered on it.', 409, { reasons: evidence })
    }
    const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? order.metadata as Record<string, unknown> : {}
    if (hasManualPaymentRecord(metadata) && isPaymentVerified(order.paymentStatus)) {
      throw new AdminActionError('RECEIPT_ALREADY_REGISTERED', 'A payment was already registered on this order. A registered payment is not changed or erased from here.', 409)
    }
    const record = buildManualPaymentRecord(
      { by: input.adminId, at: new Date().toISOString(), reason: input.reason, method: input.method, receivedVia: input.receivedVia, reference: input.reference ?? null },
      { totalCents: order.totalCents, currency: order.currency },
    )
    if (!hasManualPaymentRecord({ manualPayment: record })) {
      throw new AdminActionError('RECEIPT_INCOMPLETE', 'The payment record is not complete: the agreed method, how the money was received and, for a bank transfer, its reference are needed.', 400)
    }
    const nextPaymentStatus = input.method === 'comped' ? 'free' : 'paid'
    const updated = await tx.printOrder.update({
      where: { id: order.id },
      data: withFinancialRevision(order, { paymentStatus: nextPaymentStatus, metadata: { ...metadata, manualPayment: record } as Prisma.InputJsonValue }),
      select: { id: true, paymentStatus: true, financialRevision: true },
    })
    await recordAdminAuditEvent({
      ...input.audit,
      adminId: input.adminId,
      action: 'admin.order.receipt.attest',
      targetType: 'print_order',
      targetId: order.id,
      metadata: {
        reason: input.reason, method: input.method, receivedVia: input.receivedVia, reference: input.reference ?? null, amountCents: record.amountCents, currency: record.currency,
        previousPaymentStatus: order.paymentStatus, paymentStatus: nextPaymentStatus, ...(input.auditDetail ?? {}),
      } as Prisma.InputJsonValue,
    }, tx)
    return updated
  }, { require: 'none' })
}

export async function getOrderForUser(orderId: string, userId: string): Promise<OrderDetail | null> {
  if (!userId) return null
  const orgIds = await listOrganizationIdsForUser(userId)
  const order = await prisma.printOrder.findFirst({
    where: {
      id: orderId,
      OR: [
        { userId },
        ...(orgIds.length > 0 ? [{ organizationId: { in: orgIds } }] : []),
      ],
    },
    include: {
      items: true,
      revisions: {
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true, email: true } } },
      },
      approvalRequests: {
        orderBy: { createdAt: 'asc' },
        include: { requestedBy: { select: { id: true, name: true, email: true } } },
      },
      failurePhotos: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, filePath: true, label: true, confidence: true, note: true, createdAt: true },
      },
      reprintOf: { select: { id: true, orderNumber: true } },
      reprints: { select: { id: true, orderNumber: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
    },
  })
  if (!order) return null
  const visible = await filterVisibleOrdersForUser([order])
  return visible.length > 0 ? order : null
}

// A reprint REQUESTED BY THE CUSTOMER (rules in lib/reprint.ts): a request for a new quote, not an order that can be produced.
// Nothing is inherited from the original except what describes the part: no payment state, no price, no authorization, no metadata.
// One open request per original order, even when two arrive at the same moment.
export async function createReprintOrder(orderId: string, userId: string): Promise<{ order: PrintOrder; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const source = await tx.printOrder.findFirst({
      where: { id: orderId, userId },
      include: { items: true },
    })
    if (!source) throw new ReprintNotAllowedError('ORDER_NOT_FOUND', 'Order not found')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reprint:${source.id}`}, 0))`
    if (!canRequestReprint(source)) {
      throw new ReprintNotAllowedError('REPRINT_NOT_ALLOWED', 'A reprint can only be requested for an order that has been produced.')
    }
    const open = findOpenReprint(await tx.printOrder.findMany({ where: { reprintOfId: source.id }, select: { id: true, status: true } }))
    if (open) {
      return { order: await tx.printOrder.findUniqueOrThrow({ where: { id: open.id } }), created: false }
    }
    const requestedAt = new Date().toISOString()
    const order = await tx.printOrder.create({
      data: {
        userId: source.userId,
        customerEmail: source.customerEmail,
        customerName: source.customerName,
        paymentMethod: 'quote',
        paymentStatus: 'quote',
        shippingMethod: source.shippingMethod,
        shippingAddress: source.shippingAddress ?? undefined,
        status: 'awaiting_review',
        subtotalCents: 0,
        totalCents: 0,
        shippingCents: 0,
        taxCents: 0,
        currency: source.currency,
        metadata: {
          reprint: {
            kind: 'customer_request',
            sourceOrderId: source.id,
            sourceOrderNumber: source.orderNumber,
            priceStatus: 'to_be_quoted',
            requestedAt,
          },
          reprintRequestedAt: requestedAt,
          reprintSourceOrderId: source.id,
        },
        reprintOfId: source.id,
        items: {
          create: source.items.map((item) => {
            // what describes the part is kept; anything that influences a price (the price multiplier) is not
            const { priceMultiplier: _price, ...configuration } = (item.configuration && typeof item.configuration === 'object' && !Array.isArray(item.configuration)
              ? item.configuration
              : {}) as Record<string, unknown>
            void _price
            return {
              modelId: item.modelId,
              modelTitle: item.modelTitle,
              partId: item.partId ?? undefined,
              partName: item.partName ?? undefined,
              material: item.material,
              colors: item.colors ?? undefined,
              infillPct: item.infillPct ?? undefined,
              finish: item.finish ?? undefined,
              customNotes: item.customNotes ?? undefined,
              quantity: item.quantity,
              unitPriceCents: 0,
              totalCents: 0,
              configuration: configuration as Prisma.InputJsonValue,
              thumbnailPath: item.thumbnailPath ?? undefined,
              viewerPath: item.viewerPath ?? undefined,
            }
          }),
        },
      },
    })
    return { order, created: true }
  }, { timeout: 15_000 })
}

export type RevisionPayload = {
  orderId: string
  userId: string
  filename: string
  note?: string
  buffer: Buffer
}

export async function addOrderRevision({ orderId, userId, filename, note, buffer }: RevisionPayload) {
  const order = await prisma.printOrder.findFirst({ where: { id: orderId, userId }, select: { id: true } })
  if (!order) throw new Error('Order not found')
  const sanitizedName = filename.replace(/[^a-z0-9_.-]+/gi, '-')
  const relDir = path.posix.join('orders', orderId, 'revisions')
  const relPath = path.posix.join(relDir, `${Date.now()}-${randomUUID()}-${sanitizedName}`)
  await saveBuffer(relPath, buffer)
  const revisionCount = await prisma.printOrderRevision.count({ where: { orderId } })
  return prisma.printOrderRevision.create({
    data: {
      orderId,
      userId,
      label: filename,
      note: note || undefined,
      filePath: relPath,
      version: revisionCount + 1,
    },
  })
}
