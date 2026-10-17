// Orders for the hosted card checkout: created BEFORE the customer pays, with the total fixed by the server.
//
// One checkout key = one order. The key is chosen by the browser (a random value, kept while the cart does not change) and sent
// with every attempt, so a double click, a lost response or a retry all land on the SAME order. The database decides: the key is
// unique, so of several simultaneous first requests exactly one inserts and the others read its order.
// The key only counts inside the session of whoever sent it (step 4.6, S5: a signed-in customer, or a guest's browser session - lib/guest-session.ts), and
// one browser session making one purchase attempt gets ONE order even with a different key each time.
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import type { PrintOrder, PrintOrderItem } from '@prisma/client'
import { prisma } from '@/lib/db'
import { buildOrderCreateData } from '@/lib/orders'
import { issueGuestAccess, parseGuestAccessCookieList, verifyGuestAccess } from '@/lib/guest-order-access'
import { derivePublicState } from '@/lib/checkout-status'
import { PAYMENT_IN_DOUBT_WHERE } from '@/lib/payment-in-doubt'
import { toCents } from '@/lib/currency'
import type { CardQuote, CheckoutItemPayload } from '@/lib/checkout-quote'
import { canonicalCartItems, canonicalJson } from '@/lib/cart-canonical'

export { canonicalJson }

export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export type OrderWithItems = PrintOrder & { items: PrintOrderItem[] }

export class CheckoutKeyConflictError extends Error {
  constructor() {
    super('This checkout key was already used for a different cart.')
    this.name = 'CheckoutKeyConflictError'
  }
}

// Who is asking, for the repeat-key: an account (by its id), or ONE browser of a guest (by the hash of its session, lib/guest-session.ts).
export type CheckoutOwner = { kind: 'account'; userId: string } | { kind: 'guest'; sessionHash: string }

// What is stored: the key is bound to who is asking, so two people can never collide on, or probe, each other's keys. For a guest "who" is the browser's
// session (step 4.6, S5): two guests that send the same key - by chance or on purpose - are two different keys here, hence two different orders, and neither
// can ever be handed the other's. (Until step 4.5 every guest shared one namespace and only the 192 random bits of the key kept them apart.) The keys of
// accounts are computed exactly as before, so their orders are still found.
export function storedCheckoutKey(owner: CheckoutOwner, clientKey: string): string {
  if (owner.kind === 'account') return createHash('sha256').update(`mw:checkout-key:v1:${owner.userId}:${clientKey}`).digest('hex')
  return createHash('sha256').update(`mw:checkout-key:v2:guest-session:${owner.sessionHash}:${clientKey}`).digest('hex')
}

// An order found by its key must be one that THIS account or THIS browser session made. The key already carries the owner, so this can only fail through a
// bug or a collision of SHA-256: it is the second lock on the door. It says nothing about why (CHECKOUT_KEY_CONFLICT, no details).
export function assertKeyBelongsTo(order: Pick<PrintOrder, 'userId' | 'guestSessionHash'>, owner: CheckoutOwner) {
  const mine = owner.kind === 'account'
    ? order.userId === owner.userId
    : order.userId === null && order.guestSessionHash === owner.sessionHash
  if (!mine) throw new CheckoutKeyConflictError()
}

// A fingerprint of everything that decides the price. Repeating a request with the same key is only accepted for the same cart
// AND the same total shown to the customer.
//
// Version 2 (step 4.6): the order of the lines and the random `setKey` that groups the lines of a complete model are NOT part of it (lib/cart-canonical.ts), so a
// cart rebuilt with other keys, or with its lines in another order, is the same purchase. Version 1 (the lines as sent) is still computed for the orders
// that were made before: see the `...V1` functions.
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
      v: 2,
      principal: input.principalId ?? 'guest',
      items: canonicalCartItems(input.items as Array<Record<string, unknown>>),
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
    .update(canonicalJson({ v: 2, principal: input.principalId ?? 'guest', items: canonicalCartItems(input.items as Array<Record<string, unknown>>), shipping: input.shippingMethod, rush: input.rush }))
    .digest('hex')
}

// Version 1, as step 4.5 computed it: the lines exactly as sent. Kept ONLY to recognise orders created before step 4.6 (their stored fingerprints are v1).
export function checkoutFingerprintV1(input: { principalId: string | null; items: CheckoutItemPayload[]; shippingMethod: 'pickup' | 'ship'; rush: boolean; expectedTotalCents: number }): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, principal: input.principalId ?? 'guest', items: input.items, shipping: input.shippingMethod, rush: input.rush, expectedTotal: input.expectedTotalCents }))
    .digest('hex')
}
export function cartFingerprintV1(input: { principalId: string | null; items: CheckoutItemPayload[]; shippingMethod: 'pickup' | 'ship'; rush: boolean }): string {
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
export function assertSameCheckout(order: OrderWithItems, principalId: string | null, fingerprint: string, legacyFingerprint?: string) {
  const stored = orderFingerprint(order)
  if ((order.userId ?? null) !== (principalId ?? null) || (stored !== fingerprint && (!legacyFingerprint || stored !== legacyFingerprint))) {
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

// `via`: how this customer is known to own the order. 'account' and 'access' (the order's own access cookie) prove it; 'session' only says "the same browser
// session made it" - which is enough to refuse a second payment, but NOT to tell the browser which order it is (the answer then carries no identifier).
export type PurchaseInFlight = { orderId: string; orderNumber: number; state: 'confirming' | 'attention'; via: 'account' | 'access' | 'session' }

// An order whose payment is being confirmed has a payment page at Stripe that can be asked about: `verify` does that (the payment sync, which writes what
// Stripe says to the order) and resolves when the order was brought up to date; it rejects when Stripe could not be asked (unreachable, asked a moment ago,
// shop-wide cap). Its answer is never taken from the request.
export type InFlightVerifier = (target: { orderId: string; attemptId: string; sessionId: string }) => Promise<void>

// Is there already an order for THIS cart, of THIS customer (the account, or the guest's own orders: the ones its access cookie opens, and the ones its browser
// session made), whose payment is being confirmed or waits for a person? Then a second order for it must not be made. Decided from the database, after asking
// Stripe (through `verify`) about a payment that is being confirmed - never from what the browser says it has paid, and never because time has passed:
//   * confirming + Stripe says no money is moving (canceled, failed, expired)  -> the order waits for its payment again: not in flight;
//   * confirming + Stripe says paid                                            -> the customer HAS paid: answered as in flight once more, so the page leads
//                                                                                 to the order (a second payment right after the first would be a double charge);
//   * confirming + Stripe can not be asked, or says it is still being processed -> in flight;
//   * attention (paid but under review, a payment that did not match)          -> in flight until an administrator resolves it.
export async function findPurchaseInFlight(input: {
  principalId: string | null
  guestOrderIds: readonly string[]
  // hash of the guest's browser session (lib/guest-session.ts): the orders THIS browser made count as the guest's own, even when its access cookie is gone
  guestSessionHash?: string | null
  cartFingerprint: string
  // the same cart as version 1 of the fingerprint computed it (orders made before step 4.6 carry that one)
  legacyCartFingerprint?: string
  verify?: InFlightVerifier
}): Promise<PurchaseInFlight | null> {
  const guestSessionHash = input.guestSessionHash || null
  if (!input.principalId && input.guestOrderIds.length === 0 && !guestSessionHash) return null
  const sameCart = [input.cartFingerprint, ...(input.legacyCartFingerprint && input.legacyCartFingerprint !== input.cartFingerprint ? [input.legacyCartFingerprint] : [])]
  const where = {
    paymentMethod: 'card',
    ...(input.principalId
      ? { userId: input.principalId }
      : { userId: null, OR: [...(guestSessionHash ? [{ guestSessionHash }] : []), ...(input.guestOrderIds.length > 0 ? [{ id: { in: [...input.guestOrderIds] } }] : [])] }),
    AND: [
      { OR: sameCart.map((value) => ({ metadata: { path: ['checkout', 'cartFingerprint'], equals: value } })) },
      // only orders that can be in doubt: the many paid-and-done orders of the same cart are not looked at
      PAYMENT_IN_DOUBT_WHERE,
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
    if (state === 'confirming' || state === 'attention') {
      const via = input.principalId ? 'account' : input.guestOrderIds.includes(order.id) ? 'access' : 'session'
      return { orderId: order.id, orderNumber: order.orderNumber, state, via }
    }
  }
  return null
}

// Test seam, null in production (the same kind as effectHooks and releaseHooks): lets a test hold a request INSIDE the lock that decides "one purchase attempt,
// one order", so that simultaneous requests - in this process or in another - really meet at it instead of happening to follow each other.
export const checkoutOrderHooks: { afterLock: null | (() => Promise<void>) } = { afterLock: null }

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
  // the fingerprint as version 1 computed it: an unpaid order made before step 4.6 for the same cart is the same purchase
  legacyFingerprint?: string
  // the orders this guest's browser really holds (verifiedGuestOrderIds); empty for a registered customer
  guestOrderIds?: readonly string[]
  // hash of the guest's browser session (lib/guest-session.ts). REQUIRED for a guest: without a session no order is made. Stored with the order, and what
  // "the same browser" means for the checks below. Ignored for a registered customer.
  guestSessionHash?: string | null
  quote: CardQuote
  items: CheckoutItemPayload[]
  rush: boolean
}): Promise<{ order: OrderWithItems; created: boolean }> {
  const { quote, items, rush } = input
  const { ctx, lineItems, discountSummary, pricingAdjustments, shippingPayload, totals } = quote
  const guestSessionHash = ctx.userId ? null : (input.guestSessionHash || null)
  // The server's own rule, not only the route's: a guest without a session gets no order (nothing to tie the key, the limits or the "same purchase" check to).
  if (!ctx.userId && !guestSessionHash) throw new Error('A guest order needs a guest session; order not created.')

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
          // step 4.6: the unit of sale (the production report groups the parts of one complete copy by `setOrdinal`)
          unit: line.unit ? { kind: line.unit.kind, setOrdinal: line.unit.setOrdinal, copies: line.unit.copies, parts: line.unit.partCount } : null,
        })),
        // the waivers behind the prices of this order, when there are any (lib/minimum-waivers.ts)
        waiverIds: Array.from(new Set(lineItems.map((line) => line.minimum?.waiverId).filter((id): id is string => Boolean(id)))),
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

  const sameFingerprint = [input.fingerprint, ...(input.legacyFingerprint && input.legacyFingerprint !== input.fingerprint ? [input.legacyFingerprint] : [])]
  try {
    return await prisma.$transaction(async (tx) => {
      if (ctx.userId) {
        // Serialises this customer's requests for this cart: simultaneous requests with different keys still give ONE order.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${ctx.userId}:${input.fingerprint}`}, 0))`
        await checkoutOrderHooks.afterLock?.()
        const duplicate = await tx.printOrder.findFirst({
          where: {
            userId: ctx.userId,
            status: 'awaiting_payment',
            paymentStatus: 'pending',
            paymentMethod: 'card',
            totalCents: totals.amount,
            createdAt: { gt: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS) },
            OR: sameFingerprint.map((value) => ({ metadata: { path: ['checkout', 'fingerprint'], equals: value } })),
          },
          orderBy: { createdAt: 'desc' },
          include: { items: { orderBy: { createdAt: 'asc' } } },
        })
        if (duplicate) return { order: duplicate, created: false }
      } else {
        // A guest has no account to tie an earlier attempt to, but the server knows two things about the BROWSER: its session (which made the orders it stored
        // the hash on) and the access cookies of its own orders. An unpaid order of that browser for exactly this cart is the same purchase (another tab, a key
        // that was lost, a second click with another key), so the second request opens the same payment page instead of making a second order.
        // The lock is per session AND cart: simultaneous requests of one browser take turns and the second finds the first one's order. The older lock per cart
        // (taken when the browser also holds access cookies) is kept, and the two are always taken in the same order, so they can not wait for each other.
        const guestIds = [...(input.guestOrderIds ?? [])]
        const lockNames = [`checkout:guest-session:${guestSessionHash}:${input.fingerprint}`, ...(guestIds.length > 0 ? [`checkout:guest:${input.fingerprint}`] : [])].sort()
        for (const name of lockNames) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`
        await checkoutOrderHooks.afterLock?.()
        const duplicate = await tx.printOrder.findFirst({
          where: {
            userId: null,
            status: 'awaiting_payment',
            paymentStatus: 'pending',
            paymentMethod: 'card',
            totalCents: totals.amount,
            createdAt: { gt: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS) },
            AND: [
              { OR: sameFingerprint.map((value) => ({ metadata: { path: ['checkout', 'fingerprint'], equals: value } })) },
              { OR: [{ guestSessionHash: guestSessionHash as string }, ...(guestIds.length > 0 ? [{ id: { in: guestIds } }] : [])] },
            ],
          },
          orderBy: { createdAt: 'desc' },
          include: { items: { orderBy: { createdAt: 'asc' } } },
        })
        if (duplicate) return { order: duplicate, created: false }
      }
      // (the session hash is written in the same statement that creates the order: an order of a guest never exists without it)
      const created = await tx.printOrder.create({ data: { ...data, checkoutKey: input.storedKey, ...(guestSessionHash ? { guestSessionHash } : {}) } })
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
    // lost the race on the key to a simultaneous request: that order is the one - but only if it is this customer's own
    assertKeyBelongsTo(existing, ctx.userId ? { kind: 'account', userId: ctx.userId } : { kind: 'guest', sessionHash: guestSessionHash as string })
    return { order: existing, created: false }
  }
}
