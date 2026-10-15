// Payment-method and production-entry policy for orders (S5). One place, used by every code path that
// creates an order or changes its status.
//
// 1. Which payment methods a person may use is decided on the SERVER from the session, never from the request:
//      guests and customers: card (Stripe) or a quote request (no payment, no production)
//      administrators:       everything, including cash / invoice / purchase order / no-charge
// 2. An order enters PRODUCTION only if its payment is VERIFIED or an administrator explicitly authorized it.
//    "Verified" is strict: `paid` (Stripe confirmed the money) or `free` (a no-charge order created by an administrator).
//    Pending, processing, authorized-only, failed, quote... are NOT verified.
//    The authorization is recorded in `metadata.productionAuthorization` ({ authorized, by, at, reason }).
import { normalizePaymentStatus } from '@/lib/orderworks-status'

export type PaymentMethodKey = 'card' | 'paypal' | 'cash' | 'invoice' | 'po' | 'quote' | 'comped'
export type CheckoutRole = 'guest' | 'customer' | 'staff' | 'admin'

// ---- Who may use which payment method --------------------------------------------------------------
const PUBLIC_PAYMENT_METHODS: readonly PaymentMethodKey[] = ['card', 'quote']
const ADMIN_PAYMENT_METHODS: readonly PaymentMethodKey[] = ['card', 'quote', 'cash', 'invoice', 'po', 'comped', 'paypal']

export function checkoutRoleOf(user: { isAdmin?: boolean | null; role?: string | null } | null | undefined): CheckoutRole {
  if (!user) return 'guest'
  if (user.isAdmin || user.role === 'admin') return 'admin'
  if (user.role === 'staff') return 'staff'
  return 'customer'
}

export function allowedPaymentMethods(role: CheckoutRole): readonly PaymentMethodKey[] {
  return role === 'admin' ? ADMIN_PAYMENT_METHODS : PUBLIC_PAYMENT_METHODS
}

export function isPaymentMethodAllowed(method: string, role: CheckoutRole) {
  return (allowedPaymentMethods(role) as readonly string[]).includes(method)
}

// ---- Production entry -------------------------------------------------------------------------------
// Statuses that mean "this order is in the production pipeline" (legacy aliases included).
const PRODUCTION_STATUSES = new Set(['queued', 'printing', 'post_process', 'shipped', 'completed', 'in_production', 'ready'])

export function isProductionStatus(status: string | null | undefined) {
  return PRODUCTION_STATUSES.has(String(status || ''))
}

export function isPaymentVerified(paymentStatus: string | null | undefined) {
  const normalized = normalizePaymentStatus(paymentStatus)
  return normalized === 'paid' || normalized === 'free'
}

type Json = Record<string, unknown>
function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

export function getProductionAuthorization(metadata: unknown): { by: string; at: string; reason: string | null } | null {
  const raw = asRecord(asRecord(metadata).productionAuthorization)
  if (raw.authorized !== true || typeof raw.by !== 'string' || !raw.by) return null
  return { by: raw.by, at: typeof raw.at === 'string' ? raw.at : '', reason: typeof raw.reason === 'string' ? raw.reason : null }
}

// Metadata keys written ONLY by our own code (administrator routes, payment verification, reprint requests). Whatever an outside
// service or a customer sends as "metadata" must never be able to set them: `productionAuthorization`, for one, makes an order
// eligible for production (isProductionEligible).
export const RESERVED_ORDER_METADATA_KEYS: readonly string[] = [
  'productionAuthorization', 'productionAuthorizedWithoutPayment', 'paymentReview', 'postPayment', 'cancellation', 'reprint',
  'checkout', 'stripe', 'stripeInvoice', 'artifacts', 'adminFreeCheckout',
]

export function sanitizeExternalMetadata(value: unknown): Record<string, unknown> {
  const input = asRecord(value)
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(input)) {
    if (!RESERVED_ORDER_METADATA_KEYS.includes(key)) out[key] = entry
  }
  return out
}

export type OrderPaymentState = { paymentStatus?: string | null; metadata?: unknown }

export function isProductionEligible(order: OrderPaymentState) {
  return isPaymentVerified(order.paymentStatus) || getProductionAuthorization(order.metadata) !== null
}

// Prisma filter equivalent of isProductionEligible (for queries that pick orders for production).
export const productionEligibleOrderWhere = {
  OR: [
    { paymentStatus: { in: ['paid', 'free'] } },
    { metadata: { path: ['productionAuthorization', 'authorized'], equals: true } },
  ],
}

export function withProductionAuthorization(metadata: unknown, adminId: string, reason?: string | null): Json {
  return {
    ...asRecord(metadata),
    productionAuthorization: {
      authorized: true,
      by: adminId,
      at: new Date().toISOString(),
      reason: reason?.trim() ? reason.trim().slice(0, 300) : null,
    },
  }
}

export type ProductionTransition =
  | { allowed: true; metadata?: Json }
  | { allowed: false; error: string; code?: string }

// A free reprint is a deliberate decision: it must say why (kept on the order with the administrator's id and the date).
export const REPRINT_AUTHORIZATION_REASON_MIN_LENGTH = 10

export function isReprintMetadata(metadata: unknown) {
  return Object.keys(asRecord(asRecord(metadata).reprint)).length > 0
}

// Manual (administrator) transition: a production status for an order that is not eligible needs
// `authorizeUnpaid`, which is recorded in the order metadata.
export function checkManualTransition(
  order: OrderPaymentState,
  nextStatus: string,
  opts: { authorizeUnpaid?: boolean; adminId: string; reason?: string | null },
): ProductionTransition {
  if (!isProductionStatus(nextStatus) || isProductionEligible(order)) return { allowed: true }
  if (opts.authorizeUnpaid) {
    if (isReprintMetadata(order.metadata) && (opts.reason ?? '').trim().length < REPRINT_AUTHORIZATION_REASON_MIN_LENGTH) {
      return {
        allowed: false,
        code: 'AUTHORIZATION_REASON_REQUIRED',
        error: `A free reprint needs a written reason (at least ${REPRINT_AUTHORIZATION_REASON_MIN_LENGTH} characters).`,
      }
    }
    return { allowed: true, metadata: withProductionAuthorization(order.metadata, opts.adminId, opts.reason) }
  }
  return {
    allowed: false,
    error: 'Payment has not been verified for this order. Production can only start after a verified payment or an explicit administrator authorization.',
  }
}

// Automatic transition (webhooks, other services, approvals): never lets an ineligible order into production.
// Returns the status the order may take: `requested` when allowed, otherwise `fallback`.
export function gateAutomaticStatus(order: OrderPaymentState, requested: string, fallback = 'awaiting_payment') {
  return !isProductionStatus(requested) || isProductionEligible(order) ? requested : fallback
}
