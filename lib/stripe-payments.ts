import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { normalizePaymentStatus } from '@/lib/orderworks-status'
import { generateOrderReceiptBestEffort } from '@/lib/receipts/order-receipts'
import { isPaymentVerified } from '@/lib/order-payment-policy'
import type { CheckoutLineItem } from '@/types/checkout'

type StripePaymentRecord = {
  paymentIntentId: string
  paymentStatus?: string | null
  chargeId?: string | null
  receiptUrl?: string | null
  customerId?: string | null
  refundedCents?: number | null
  eventType?: string | null
}

type StripeInvoiceRecord = {
  invoiceId: string
  invoiceStatus?: string | null
  paymentStatus?: string | null
  customerId?: string | null
  hostedInvoiceUrl?: string | null
  invoicePdfUrl?: string | null
  paymentIntentId?: string | null
  eventType?: string | null
}

type OrderLike = {
  stripePaymentIntentId?: string | null
  metadata?: unknown
}

type InvoiceLineItem = Pick<CheckoutLineItem, 'title' | 'partName' | 'qty' | 'lineTotal'>

export function normalizeStripePaymentStatus(status?: string | null) {
  if (!status) return null
  if (status === 'succeeded') return 'paid'
  if (status === 'processing') return 'processing'
  if (status === 'requires_capture') return 'authorized'
  if (status === 'requires_payment_method' || status === 'requires_action') return 'failed'
  if (status === 'canceled') return 'canceled'
  return normalizePaymentStatus(status) || status
}

export function resolvePaymentIntentIdFromOrder(order: OrderLike) {
  if (order.stripePaymentIntentId) return order.stripePaymentIntentId
  const metadata = order.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const record = metadata as Record<string, any>
  if (typeof record.paymentIntentId === 'string' && record.paymentIntentId.trim()) return record.paymentIntentId.trim()
  if (record.stripe && typeof record.stripe === 'object' && typeof record.stripe.paymentIntentId === 'string') {
    return record.stripe.paymentIntentId.trim() || null
  }
  return null
}

export function mergeStripePaymentMetadata(existing: unknown, stripe: StripePaymentRecord): Prisma.InputJsonValue {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  const priorStripe = base.stripe && typeof base.stripe === 'object' && !Array.isArray(base.stripe)
    ? base.stripe as Record<string, unknown>
    : {}
  return {
    ...base,
    stripe: {
      ...priorStripe,
      paymentIntentId: stripe.paymentIntentId,
      paymentStatus: stripe.paymentStatus ?? priorStripe.paymentStatus ?? null,
      chargeId: stripe.chargeId ?? priorStripe.chargeId ?? null,
      receiptUrl: stripe.receiptUrl ?? priorStripe.receiptUrl ?? null,
      customerId: stripe.customerId ?? priorStripe.customerId ?? null,
      refundedCents: stripe.refundedCents ?? priorStripe.refundedCents ?? 0,
      lastEventType: stripe.eventType ?? priorStripe.lastEventType ?? null,
      syncedAt: new Date().toISOString(),
    },
  }
}

export function mergeStripePaymentIntentReference(existing: unknown, paymentIntentId: string): Prisma.InputJsonValue {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  const priorStripe = base.stripe && typeof base.stripe === 'object' && !Array.isArray(base.stripe)
    ? base.stripe as Record<string, unknown>
    : {}
  return {
    ...base,
    paymentIntentId,
    stripe: {
      ...priorStripe,
      paymentIntentId,
    },
  }
}

export function mergeStripeInvoiceMetadata(existing: unknown, stripeInvoice: StripeInvoiceRecord): Prisma.InputJsonValue {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  const priorInvoice = base.stripeInvoice && typeof base.stripeInvoice === 'object' && !Array.isArray(base.stripeInvoice)
    ? base.stripeInvoice as Record<string, unknown>
    : {}
  const priorStripe = base.stripe && typeof base.stripe === 'object' && !Array.isArray(base.stripe)
    ? base.stripe as Record<string, unknown>
    : {}
  return {
    ...base,
    stripe: {
      ...priorStripe,
      customerId: stripeInvoice.customerId ?? priorStripe.customerId ?? null,
      paymentIntentId: stripeInvoice.paymentIntentId ?? priorStripe.paymentIntentId ?? null,
      paymentStatus: stripeInvoice.paymentStatus ?? priorStripe.paymentStatus ?? null,
    },
    stripeInvoice: {
      ...priorInvoice,
      invoiceId: stripeInvoice.invoiceId,
      status: stripeInvoice.invoiceStatus ?? priorInvoice.status ?? null,
      paymentStatus: stripeInvoice.paymentStatus ?? priorInvoice.paymentStatus ?? null,
      hostedInvoiceUrl: stripeInvoice.hostedInvoiceUrl ?? priorInvoice.hostedInvoiceUrl ?? null,
      invoicePdfUrl: stripeInvoice.invoicePdfUrl ?? priorInvoice.invoicePdfUrl ?? null,
      paymentIntentId: stripeInvoice.paymentIntentId ?? priorInvoice.paymentIntentId ?? null,
      lastEventType: stripeInvoice.eventType ?? priorInvoice.lastEventType ?? null,
      syncedAt: new Date().toISOString(),
    },
  }
}

export async function getOrCreateStripeCustomer(params: {
  userId?: string | null
  email?: string | null
  name?: string | null
}) {
  const stripe = getStripe()
  if (params.userId) {
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, email: true, name: true, stripeCustomerId: true },
    } as any)
    if (user?.stripeCustomerId) return user.stripeCustomerId
    if (user) {
      const customer = await stripe.customers.create({
        email: params.email || user.email || undefined,
        name: params.name || user.name || undefined,
        metadata: { makerworksUserId: user.id },
      })
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customer.id },
      } as any)
      return customer.id
    }
  }
  if (!params.email && !params.name) return null
  const customer = await stripe.customers.create({
    email: params.email || undefined,
    name: params.name || undefined,
    metadata: params.userId ? { makerworksUserId: params.userId } : undefined,
  })
  return customer.id
}

export async function createMakerWorksPaymentIntent(params: {
  amount: number
  currency: string
  checkoutId: string
  userId?: string | null
  customerEmail?: string | null
  customerName?: string | null
  metadata?: Record<string, string>
}) {
  const stripe = getStripe()
  const customer = await getOrCreateStripeCustomer({
    userId: params.userId,
    email: params.customerEmail,
    name: params.customerName,
  })
  return stripe.paymentIntents.create({
    amount: params.amount,
    currency: params.currency,
    automatic_payment_methods: { enabled: true },
    receipt_email: params.customerEmail || undefined,
    customer: customer || undefined,
    metadata: {
      checkoutId: params.checkoutId,
      ...(params.userId ? { makerworksUserId: params.userId } : {}),
      ...(params.metadata || {}),
    },
  }, {
    idempotencyKey: `makerworks:checkout:${params.checkoutId}`,
  })
}

export function resolveStripeInvoiceDaysUntilDue(raw?: string | null) {
  const parsed = Number(raw ?? process.env.STRIPE_INVOICE_DAYS_UNTIL_DUE ?? '14')
  if (!Number.isFinite(parsed)) return 14
  return Math.max(1, Math.min(365, Math.round(parsed)))
}

export function buildStripeInvoiceItemParams(params: {
  customerId: string
  currency: string
  lineItems: InvoiceLineItem[]
  metadata?: Record<string, string>
}): Stripe.InvoiceItemCreateParams[] {
  return params.lineItems.map((item) => {
    const name = `${item.title}${item.partName ? ` (${item.partName})` : ''} x${item.qty}`
    return {
      customer: params.customerId,
      amount: Math.max(0, Math.round(item.lineTotal * 100)),
      currency: params.currency.toLowerCase(),
      description: name,
      metadata: params.metadata,
    }
  }).filter((item) => item.amount > 0)
}

export function buildStripeInvoiceCreateParams(params: {
  customerId: string
  daysUntilDue: number
  description?: string | null
  metadata?: Record<string, string>
}): Stripe.InvoiceCreateParams {
  return {
    customer: params.customerId,
    collection_method: 'send_invoice',
    days_until_due: resolveStripeInvoiceDaysUntilDue(String(params.daysUntilDue)),
    auto_advance: true,
    description: params.description || undefined,
    metadata: params.metadata,
  }
}

export async function createAndSendStripeInvoice(params: {
  orderId: string
  orderNumber?: number | null
  amountCents: number
  currency: string
  lineItems: InvoiceLineItem[]
  userId?: string | null
  customerEmail?: string | null
  customerName?: string | null
  daysUntilDue?: number | null
}) {
  const stripe = getStripe()
  const customerId = await getOrCreateStripeCustomer({
    userId: params.userId,
    email: params.customerEmail,
    name: params.customerName,
  })
  if (!customerId) {
    throw Object.assign(new Error('Customer email or name is required to create a Stripe invoice'), { status: 400 })
  }
  const metadata = {
    makerworksOrderId: params.orderId,
    ...(params.orderNumber ? { makerworksOrderNumber: String(params.orderNumber) } : {}),
  }
  const invoiceItems = buildStripeInvoiceItemParams({
    customerId,
    currency: params.currency,
    lineItems: params.lineItems,
    metadata,
  })
  if (invoiceItems.length === 0 && params.amountCents > 0) {
    invoiceItems.push({
      customer: customerId,
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      description: params.orderNumber ? `MakerWorks order MW-${String(params.orderNumber).padStart(5, '0')}` : 'MakerWorks order',
      metadata,
    })
  }
  for (const item of invoiceItems) {
    await stripe.invoiceItems.create(item)
  }
  const invoice = await stripe.invoices.create(
    buildStripeInvoiceCreateParams({
      customerId,
      daysUntilDue: params.daysUntilDue ?? resolveStripeInvoiceDaysUntilDue(),
      description: params.orderNumber ? `MakerWorks order MW-${String(params.orderNumber).padStart(5, '0')}` : 'MakerWorks order',
      metadata,
    }),
    { idempotencyKey: `makerworks:invoice:${params.orderId}` },
  )
  const sent = await stripe.invoices.sendInvoice(invoice.id)
  return {
    invoice: sent,
    customerId,
    invoiceId: sent.id,
    hostedInvoiceUrl: sent.hosted_invoice_url || null,
    invoicePdfUrl: sent.invoice_pdf || null,
    invoiceStatus: sent.status || null,
  }
}

function chargeFromIntent(intent: Stripe.PaymentIntent) {
  const latest = intent.latest_charge
  if (!latest || typeof latest === 'string') return { chargeId: typeof latest === 'string' ? latest : null, receiptUrl: null, refundedCents: 0 }
  return {
    chargeId: latest.id,
    receiptUrl: latest.receipt_url || null,
    refundedCents: latest.amount_refunded || 0,
  }
}

// ---- Synchronising orders with Stripe ---------------------------------------------------------------
//
// Both syncs follow the same safe pattern, inside ONE database transaction:
//   1. find the orders for the payment, 2. LOCK them (SELECT ... FOR UPDATE), 3. read the CURRENT state from Stripe,
//   4. write the orders from that state.
// Locking before reading means two handlers for the same payment run one after the other and the later one always sees
// the later Stripe state, so events that arrive out of order or at the same time cannot overwrite newer data with older.
// Receipts (a PDF file + a database update) are generated AFTER the commit: they are idempotent and best-effort.
export type DbClient = Prisma.TransactionClient
export const SYNC_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const
// A webhook must answer quickly; do not let a slow Stripe call hold the transaction open.
const STRIPE_READ_TIMEOUT_MS = 10_000

async function lockOrders(tx: DbClient, orderIds: string[]) {
  if (orderIds.length === 0) return
  await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" IN (${Prisma.join(orderIds)}) ORDER BY "id" FOR UPDATE`
}

export async function generateReceiptsBestEffort(orderIds: string[], source: string) {
  for (const orderId of orderIds) {
    await generateOrderReceiptBestEffort(orderId, source)
  }
}

export type PaymentSyncResult = {
  intent: Stripe.PaymentIntent
  updatedOrders: number
  orderIds: string[]
  paymentStatus: string | null | undefined
}

export async function applyPaymentIntentToOrders(tx: DbClient, paymentIntentId: string, eventType?: string | null): Promise<PaymentSyncResult> {
  const candidates = await tx.printOrder.findMany({
    where: {
      OR: [
        { stripePaymentIntentId: paymentIntentId },
        { metadata: { path: ['paymentIntentId'], equals: paymentIntentId } },
        { metadata: { path: ['stripe', 'paymentIntentId'], equals: paymentIntentId } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  const orderIds = candidates.map((order) => order.id)
  await lockOrders(tx, orderIds)

  const stripe = getStripe()
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge', 'customer'],
  }, { timeout: STRIPE_READ_TIMEOUT_MS })
  const charge = chargeFromIntent(intent)
  const paymentStatus = normalizeStripePaymentStatus(intent.status)
  const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id || null
  const record: StripePaymentRecord = {
    paymentIntentId: intent.id,
    paymentStatus,
    chargeId: charge.chargeId,
    receiptUrl: charge.receiptUrl,
    customerId,
    refundedCents: charge.refundedCents,
    eventType,
  }

  await tx.jobForm.updateMany({
    where: { paymentIntentId: intent.id },
    data: { paymentStatus: paymentStatus || undefined },
  })

  // Re-read AFTER taking the locks so we merge into the latest metadata.
  const orders = orderIds.length
    ? await tx.printOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, metadata: true, status: true }, orderBy: { id: 'asc' } })
    : []

  for (const order of orders) {
    await tx.printOrder.update({
      where: { id: order.id },
      data: {
        // Payment confirmed by Stripe: an order that was waiting for payment enters the production queue (S5 gate).
        ...(order.status === 'awaiting_payment' && isPaymentVerified(paymentStatus) ? { status: 'queued' } : {}),
        stripePaymentIntentId: intent.id,
        stripeChargeId: charge.chargeId || undefined,
        stripeCustomerId: customerId || undefined,
        paymentStatus: paymentStatus || undefined,
        refundedCents: charge.refundedCents,
        receiptUrl: charge.receiptUrl || undefined,
        metadata: mergeStripePaymentMetadata(order.metadata, record),
      },
    })
  }

  return { intent, updatedOrders: orders.length, orderIds: orders.map((order) => order.id), paymentStatus }
}

// Standalone use (admin tools, refunds): runs its own transaction. Inside the webhook the caller passes its transaction.
export async function syncStripePaymentIntent(paymentIntentId: string, eventType?: string | null, client?: DbClient): Promise<PaymentSyncResult> {
  if (client) return applyPaymentIntentToOrders(client, paymentIntentId, eventType)
  const result = await prisma.$transaction((tx) => applyPaymentIntentToOrders(tx, paymentIntentId, eventType), SYNC_TX_OPTIONS)
  await generateReceiptsBestEffort(result.orderIds, 'syncStripePaymentIntent')
  return result
}

export const stripePaymentAdminOps = {
  syncStripePaymentIntent,
}

function invoicePaymentStatus(invoice: Stripe.Invoice) {
  if (invoice.status === 'paid') return 'paid'
  if (invoice.status === 'void') return 'canceled'
  if (invoice.status === 'uncollectible') return 'failed'
  return 'pending'
}

export type InvoiceSyncResult = {
  invoice: Stripe.Invoice
  updatedOrders: number
  orderIds: string[]
  paymentStatus: string
}

export async function applyInvoiceToOrders(tx: DbClient, invoiceId: string, eventType?: string | null): Promise<InvoiceSyncResult> {
  const candidates = await tx.printOrder.findMany({
    where: {
      OR: [
        { stripeInvoiceId: invoiceId },
        { metadata: { path: ['stripeInvoice', 'invoiceId'], equals: invoiceId } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  const orderIds = candidates.map((order) => order.id)
  await lockOrders(tx, orderIds)

  const stripe = getStripe()
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ['customer', 'payment_intent'],
  } as any, { timeout: STRIPE_READ_TIMEOUT_MS } as any)
  const paymentStatus = invoicePaymentStatus(invoice)
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null
  const paymentIntentId = typeof (invoice as any).payment_intent === 'string'
    ? (invoice as any).payment_intent
    : (invoice as any).payment_intent?.id || null
  const record: StripeInvoiceRecord = {
    invoiceId: invoice.id,
    invoiceStatus: invoice.status || null,
    paymentStatus,
    customerId,
    hostedInvoiceUrl: invoice.hosted_invoice_url || null,
    invoicePdfUrl: invoice.invoice_pdf || null,
    paymentIntentId,
    eventType,
  }
  const orders = orderIds.length
    ? await tx.printOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, metadata: true, status: true }, orderBy: { id: 'asc' } })
    : []

  for (const order of orders) {
    await tx.printOrder.update({
      where: { id: order.id },
      data: {
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: paymentIntentId || undefined,
        stripeCustomerId: customerId || undefined,
        hostedInvoiceUrl: invoice.hosted_invoice_url || undefined,
        invoicePdfUrl: invoice.invoice_pdf || undefined,
        paymentStatus,
        // A paid invoice is a verified payment: release an order that was waiting for it (S5 gate).
        status: isPaymentVerified(paymentStatus) && order.status === 'awaiting_payment' ? 'queued' : undefined,
        metadata: mergeStripeInvoiceMetadata(order.metadata, record),
      } as any,
    })
  }
  return { invoice, updatedOrders: orders.length, orderIds: orders.map((order) => order.id), paymentStatus }
}

export async function syncStripeInvoice(invoiceId: string, eventType?: string | null, client?: DbClient): Promise<InvoiceSyncResult> {
  if (client) return applyInvoiceToOrders(client, invoiceId, eventType)
  const result = await prisma.$transaction((tx) => applyInvoiceToOrders(tx, invoiceId, eventType), SYNC_TX_OPTIONS)
  await generateReceiptsBestEffort(result.orderIds, 'syncStripeInvoice')
  return result
}

export async function refundStripeOrder(params: { orderId: string; amountCents?: number | null; reason?: Stripe.RefundCreateParams.Reason }) {
  const order = await prisma.printOrder.findUnique({
    where: { id: params.orderId },
    select: { id: true, totalCents: true, refundedCents: true, stripePaymentIntentId: true, metadata: true },
  } as any)
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 })
  const paymentIntentId = resolvePaymentIntentIdFromOrder(order)
  if (!paymentIntentId) throw Object.assign(new Error('Order does not have a Stripe payment intent'), { status: 400 })
  const remaining = Math.max(0, Number(order.totalCents || 0) - Number(order.refundedCents || 0))
  const amount = params.amountCents == null ? remaining : Math.max(0, Math.min(remaining, params.amountCents))
  if (amount <= 0) throw Object.assign(new Error('No refundable amount remains'), { status: 400 })
  const stripe = getStripe()
  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount,
    reason: params.reason,
    metadata: { makerworksOrderId: order.id },
  }, {
    idempotencyKey: `makerworks:refund:${order.id}:${amount}`,
  })
  await syncStripePaymentIntent(paymentIntentId, 'refund.created')
  return refund
}
