import Stripe from 'stripe'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { syncPayment } from '@/lib/payment-sync'
import type { CheckoutLineItem } from '@/types/checkout'
import {
  mergeStripeInvoiceMetadata,
  mergeStripePaymentIntentReference,
  mergeStripePaymentMetadata,
  normalizeStripePaymentStatus,
  resolvePaymentIntentIdFromOrder,
} from '@/lib/stripe-metadata'

// Kept exported from here: other modules and tests import them from this path.
export { mergeStripeInvoiceMetadata, mergeStripePaymentIntentReference, mergeStripePaymentMetadata, normalizeStripePaymentStatus, resolvePaymentIntentIdFromOrder }

type InvoiceLineItem = Pick<CheckoutLineItem, 'title' | 'partName' | 'qty' | 'lineTotal'>

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

// ---- Synchronising orders with Stripe ---------------------------------------------------------------
// All of it lives in lib/payment-sync.ts (one lease per order, Stripe read without a transaction, verification in
// lib/payment-verification.ts). These wrappers keep the names the admin tools and the legacy checkout already use.
export async function syncStripePaymentIntent(paymentIntentId: string, eventType?: string | null) {
  const result = await syncPayment({ kind: 'payment_intent', id: paymentIntentId }, { eventType: eventType || 'sync' })
  return { updatedOrders: result.updatedOrders, orderIds: result.orderIds, paymentStatus: result.paymentStatus }
}

// The payment as Stripe itself reports it right now (the administrator's typed identifier is only a claim). Read with a short timeout; nothing is cached.
export async function retrievePaymentIntentForAttach(paymentIntentId: string) {
  return getStripe().paymentIntents.retrieve(paymentIntentId, undefined, { timeout: 10_000 })
}

export const stripePaymentAdminOps = {
  syncStripePaymentIntent,
  retrievePaymentIntent: retrievePaymentIntentForAttach,
}

export async function syncStripeInvoice(invoiceId: string, eventType?: string | null) {
  const result = await syncPayment({ kind: 'invoice', id: invoiceId }, { eventType: eventType || 'sync' })
  return { updatedOrders: result.updatedOrders, orderIds: result.orderIds, paymentStatus: result.paymentStatus }
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
