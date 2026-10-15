// Orders for the hosted card checkout: created BEFORE the customer pays, with the total fixed by the server.
//
// One checkout key = one order. The key is chosen by the browser (a random value, kept while the cart does not change) and sent
// with every attempt, so a double click, a lost response or a retry all land on the SAME order. The database decides: the key is
// unique, so of several simultaneous first requests exactly one inserts and the others read its order.
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import type { PrintOrder, PrintOrderItem } from '@prisma/client'
import { prisma } from '@/lib/db'
import { buildOrderCreateData } from '@/lib/orders'
import { issueGuestAccess } from '@/lib/guest-order-access'
import { toCents } from '@/lib/currency'
import type { CardQuote, CheckoutItemPayload } from '@/lib/checkout-quote'

export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export type OrderWithItems = PrintOrder & { items: PrintOrderItem[] }

export class CheckoutKeyConflictError extends Error {
  constructor() {
    super('This checkout key was already used for a different cart.')
    this.name = 'CheckoutKeyConflictError'
  }
}

// What is stored: the key is bound to who is asking, so two people can never collide on, or probe, each other's keys.
export function storedCheckoutKey(principalId: string | null, clientKey: string): string {
  return createHash('sha256').update(`mw:checkout-key:v1:${principalId ?? 'guest'}:${clientKey}`).digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// A fingerprint of everything that decides the price. Repeating a request with the same key is only accepted for the same cart
// AND the same total shown to the customer.
export function checkoutFingerprint(input: {
  principalId: string | null
  items: CheckoutItemPayload[]
  shippingMethod: 'pickup' | 'ship'
  rush: boolean
  // The total the customer was shown. It is only ever COMPARED with the server's total, never used as a price.
  expectedTotalCents: number
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      v: 1,
      principal: input.principalId ?? 'guest',
      items: input.items,
      shipping: input.shippingMethod,
      rush: input.rush,
      expectedTotal: input.expectedTotalCents,
    }))
    .digest('hex')
}

export function orderFingerprint(order: Pick<PrintOrder, 'metadata'>): string | null {
  const metadata = order.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const checkout = (metadata as Record<string, unknown>).checkout
  if (!checkout || typeof checkout !== 'object' || Array.isArray(checkout)) return null
  const value = (checkout as Record<string, unknown>).fingerprint
  return typeof value === 'string' ? value : null
}

export async function findOrderByCheckoutKey(key: string): Promise<OrderWithItems | null> {
  return prisma.printOrder.findUnique({ where: { checkoutKey: key }, include: { items: { orderBy: { createdAt: 'asc' } } } })
}

// A repeated request must come from the same kind of caller and carry the same cart. Anything else is refused.
export function assertSameCheckout(order: OrderWithItems, principalId: string | null, fingerprint: string) {
  if ((order.userId ?? null) !== (principalId ?? null) || orderFingerprint(order) !== fingerprint) {
    throw new CheckoutKeyConflictError()
  }
}

function isCheckoutKeyCollision(err: unknown) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = err.meta?.target
  return Array.isArray(target) ? target.includes('checkoutKey') : String(target ?? '').includes('checkoutKey')
}

// An unpaid order for exactly the same cart, total and customer, created this recently, is the same purchase.
export const DUPLICATE_ORDER_WINDOW_MS = 60 * 60 * 1000

export class PriceChangedError extends Error {
  readonly currentTotalCents: number
  readonly currency: string
  constructor(currentTotalCents: number, currency: string) {
    super('The price changed since it was shown. Please review the new total.')
    this.name = 'PriceChangedError'
    this.currentTotalCents = currentTotalCents
    this.currency = currency
  }
}

export async function createPendingCardOrder(input: {
  storedKey: string
  fingerprint: string
  quote: CardQuote
  items: CheckoutItemPayload[]
  rush: boolean
}): Promise<{ order: OrderWithItems; created: boolean }> {
  const { quote, items, rush } = input
  const { ctx, lineItems, discountSummary, pricingAdjustments, shippingPayload, totals } = quote

  // The total is the sum of the stored lines, shipping and added tax: if the parts do not add up, nothing is created.
  const linesCents = lineItems.reduce((sum, item) => sum + toCents(item.lineTotal), 0)
  if (linesCents !== totals.itemsTotalCents) {
    throw new Error('Checkout totals are inconsistent; order not created.')
  }
  const addedTaxCents = totals.amount - totals.itemsTotalCents - totals.shippingAmountCents
  if (addedTaxCents < 0 || (addedTaxCents !== 0 && addedTaxCents !== totals.taxCents)) {
    throw new Error('Checkout tax is inconsistent; order not created.')
  }

  const data = buildOrderCreateData({
    amountCents: totals.amount,
    shippingCents: totals.shippingAmountCents,
    taxCents: totals.taxCents,
    currency: totals.currencyCode,
    lineItems,
    shipping: shippingPayload,
    paymentMethod: 'card',
    paymentStatus: 'pending',
    userId: ctx.userId,
    customerEmail: ctx.user?.email ?? null,
    customerName: ctx.user?.name ?? null,
    discountPercent: discountSummary.totalPercent ?? null,
    metadata: {
      source: 'stripe_checkout',
      checkout: { version: 1, fingerprint: input.fingerprint },
      cartItems: items,
      shipping: shippingPayload,
      paymentMethod: 'card',
      rush,
      demandSurgeMultiplier: pricingAdjustments.demandSurgeMultiplier,
      rushMultiplier: pricingAdjustments.rushMultiplier,
      adminFreeCheckout: false,
      estimatedTotalCents: totals.estimatedTotalCents,
    },
  })
  // Never let an order created before payment look paid or sit in the production queue.
  if (data.status !== 'awaiting_payment' || data.paymentStatus !== 'pending') {
    throw new Error('A checkout order must start awaiting payment; order not created.')
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (ctx.userId) {
        // Serialises this customer's requests for this cart: simultaneous requests with different keys still give ONE order.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${ctx.userId}:${input.fingerprint}`}, 0))`
        const duplicate = await tx.printOrder.findFirst({
          where: {
            userId: ctx.userId,
            status: 'awaiting_payment',
            paymentStatus: 'pending',
            paymentMethod: 'card',
            totalCents: totals.amount,
            createdAt: { gt: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS) },
            metadata: { path: ['checkout', 'fingerprint'], equals: input.fingerprint },
          },
          orderBy: { createdAt: 'desc' },
          include: { items: { orderBy: { createdAt: 'asc' } } },
        })
        if (duplicate) return { order: duplicate, created: false }
      }
      const created = await tx.printOrder.create({ data: { ...data, checkoutKey: input.storedKey } })
      if (!created.userId) {
        const access = issueGuestAccess(created.id)
        await tx.printOrder.update({
          where: { id: created.id },
          data: { guestAccessTokenHash: access.hash, guestAccessExpiresAt: access.expiresAt },
        })
      }
      const order = await tx.printOrder.findUniqueOrThrow({ where: { id: created.id }, include: { items: { orderBy: { createdAt: 'asc' } } } })
      return { order, created: true }
    }, { maxWait: 10_000, timeout: 15_000 })
  } catch (err) {
    if (!isCheckoutKeyCollision(err)) throw err
    const existing = await findOrderByCheckoutKey(input.storedKey)
    if (!existing) throw err
    return { order: existing, created: false }
  }
}
