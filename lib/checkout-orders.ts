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
import { issueGuestAccess, parseGuestAccessCookieList, verifyGuestAccess } from '@/lib/guest-order-access'
import { derivePublicState } from '@/lib/checkout-status'
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

// The same cart, whatever the total shown and whatever the checkout key: who is buying (account or guest), what, how it is delivered, rush. This is what
// tells "the same purchase" apart from "another purchase of the same things" when the browser's own memory is not to be trusted (another tab, a cleared
// storage): the SERVER keeps it with the order and compares it, for the same customer, before it makes a second order.
export function cartFingerprint(input: {
  principalId: string | null
  items: CheckoutItemPayload[]
  shippingMethod: 'pickup' | 'ship'
  rush: boolean
}): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, principal: input.principalId ?? 'guest', items: input.items, shipping: input.shippingMethod, rush: input.rush }))
    .digest('hex')
}

export function orderCartFingerprint(order: Pick<PrintOrder, 'metadata'>): string | null {
  const metadata = order.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const checkout = (metadata as Record<string, unknown>).checkout
  if (!checkout || typeof checkout !== 'object' || Array.isArray(checkout)) return null
  const value = (checkout as Record<string, unknown>).cartFingerprint
  return typeof value === 'string' ? value : null
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

// A payment that is being confirmed, or that arrived and waits for a person, is NOT a purchase that can be started again: the money may already be taken.
// There is NO time limit on that (step 4.5): it used to end after 72 hours, the life of a guest's access, and a payment still unresolved after that long is
// exactly the one that must not be paid twice. It ends when the SERVER learns (from Stripe, never from the browser) that no money is moving, or when an
// administrator resolves it with a recorded reason (lib/payment-hold.ts). What does end with time is a GUEST's way of being recognised: the access cookie
// lasts 72 hours (GUEST_ACCESS_TTL_MS), and a guest whose cookie is gone is not recognised by this check - a known limit (docs/CHECKOUT-S2-S3.md, "Passo 4.5").

// The orders a guest's browser really holds: every entry of the access cookie is checked against the hash and the expiry stored on that order, so a
// forged or stale entry counts for nothing (the same check as for the status page).
export async function verifiedGuestOrderIds(cookieValue: string | null | undefined, now: Date = new Date()): Promise<string[]> {
  const entries = parseGuestAccessCookieList(cookieValue)
  if (entries.length === 0) return []
  const rows = await prisma.printOrder.findMany({
    where: { id: { in: entries.map((entry) => entry.orderId) }, userId: null },
    select: { id: true, userId: true, guestAccessTokenHash: true, guestAccessExpiresAt: true },
  })
  const tokenOf = new Map(entries.map((entry) => [entry.orderId, entry.token]))
  return rows.filter((row) => verifyGuestAccess(row, tokenOf.get(row.id), now)).map((row) => row.id)
}

export type PurchaseInFlight = { orderId: string; orderNumber: number; state: 'confirming' | 'attention' }

// An order whose payment is being confirmed has a payment page at Stripe that can be asked about: `verify` does that (the payment sync, which writes what
// Stripe says to the order) and resolves when the order was brought up to date; it rejects when Stripe could not be asked (unreachable, asked a moment ago,
// shop-wide cap). Its answer is never taken from the request.
export type InFlightVerifier = (target: { orderId: string; attemptId: string; sessionId: string }) => Promise<void>

// Is there already an order for THIS cart, of THIS customer (the account, or the guest's own orders), whose payment is being confirmed or waits for a
// person? Then a second order for it must not be made. Decided from the database, after asking Stripe (through `verify`) about a payment that is being
// confirmed - never from what the browser says it has paid, and never because time has passed:
//   * confirming + Stripe says no money is moving (canceled, failed, expired)  -> the order waits for its payment again: not in flight;
//   * confirming + Stripe says paid                                            -> the customer HAS paid: answered as in flight once more, so the page leads
//                                                                                 to the order (a second payment right after the first would be a double charge);
//   * confirming + Stripe can not be asked, or says it is still being processed -> in flight;
//   * attention (paid but under review, a payment that did not match)          -> in flight until an administrator resolves it.
export async function findPurchaseInFlight(input: {
  principalId: string | null
  guestOrderIds: readonly string[]
  cartFingerprint: string
  verify?: InFlightVerifier
}): Promise<PurchaseInFlight | null> {
  if (!input.principalId && input.guestOrderIds.length === 0) return null
  const where = {
    paymentMethod: 'card',
    metadata: { path: ['checkout', 'cartFingerprint'], equals: input.cartFingerprint },
    ...(input.principalId ? { userId: input.principalId } : { userId: null, id: { in: [...input.guestOrderIds] } }),
    // only orders that can be in doubt: the many paid-and-done orders of the same cart are not looked at
    OR: [
      { paymentStatus: 'processing' },
      { paymentReviewReason: { not: null } },
      { status: 'awaiting_review', paymentStatus: { in: ['paid', 'free'] } },
      { paymentAttempts: { some: { status: { in: ['processing', 'mismatch'] } } } },
    ],
  }
  const include = { paymentAttempts: { orderBy: { createdAt: 'desc' as const }, take: 10 } }
  const orders = await prisma.printOrder.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, include })
  for (const first of orders) {
    let order = first
    let state = derivePublicState(order, order.paymentAttempts[0] ?? null)
    if (state === 'confirming' && input.verify) {
      const toAsk = order.paymentAttempts.find((attempt) => attempt.stripeSessionId && (attempt.status === 'open' || attempt.status === 'processing'))
      if (toAsk?.stripeSessionId) {
        let asked = false
        try {
          await input.verify({ orderId: order.id, attemptId: toAsk.id, sessionId: toAsk.stripeSessionId })
          asked = true
        } catch { /* Stripe could not be asked: the order stays in doubt */ }
        if (asked) {
          order = (await prisma.printOrder.findUnique({ where: { id: order.id }, include })) ?? order
          state = derivePublicState(order, order.paymentAttempts[0] ?? null)
          if (state === 'paid') state = 'confirming'
        }
      }
    }
    if (state === 'confirming' || state === 'attention') return { orderId: order.id, orderNumber: order.orderNumber, state }
  }
  return null
}

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
  // see cartFingerprint(): stored with the order so that "the same cart again" can be recognised later whatever the key or the total
  cartFingerprint: string
  // the orders this guest's browser really holds (verifiedGuestOrderIds); empty for a registered customer
  guestOrderIds?: readonly string[]
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
      checkout: {
        version: 1,
        fingerprint: input.fingerprint,
        cartFingerprint: input.cartFingerprint,
        // what the production report needs after payment, without asking the cart again
        lines: lineItems.map((line) => ({
          modelId: line.modelId, partName: line.partName ?? null, title: line.title, qty: line.qty, material: line.material,
          finish: line.finish ?? null, scale: line.scale, scaleX: line.scaleX ?? null, scaleY: line.scaleY ?? null, scaleZ: line.scaleZ ?? null,
          targetDimensions: line.targetDimensions ?? null,
        })),
      },
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
      } else if (input.guestOrderIds && input.guestOrderIds.length > 0) {
        // A guest has no account to tie an earlier attempt to, but the browser holds the access cookie of its own orders: an unpaid order of THEIRS for exactly
        // this cart is the same purchase (another tab, a key that was lost), so the second tab opens the same payment page instead of making a second order.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:guest:${input.fingerprint}`}, 0))`
        const duplicate = await tx.printOrder.findFirst({
          where: {
            id: { in: [...input.guestOrderIds] },
            userId: null,
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
