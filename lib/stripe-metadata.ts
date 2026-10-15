// Pure helpers that read and merge the Stripe-related parts of an order (no database, no network).
// They live here so that lib/payment-sync.ts and lib/stripe-payments.ts can both use them without importing each other.
import { Prisma } from '@prisma/client'
import { normalizePaymentStatus } from '@/lib/orderworks-status'

export type StripePaymentRecord = {
  paymentIntentId: string
  paymentStatus?: string | null
  chargeId?: string | null
  receiptUrl?: string | null
  customerId?: string | null
  refundedCents?: number | null
  eventType?: string | null
}

export type StripeInvoiceRecord = {
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

