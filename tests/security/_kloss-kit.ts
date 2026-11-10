// Helpers for the R1-3 / KLOSS proofs (P0 of docs/KLOSS plan REV3): the DR-13 kit (a customer's browser calling the REAL routes, the faithful stand-in for Stripe) plus the few things these
// scenarios need that the DR-13 tests did not: a price that changes between two requests, the pages that are payable ACROSS several orders (the stand-in's monitor judges ONE order at a time),
// rows written the way the OLD code left them, an advisory lock held from outside, and a "fingerprint" of an answer to compare what two requesters are told.
// Not a test file (its name does not match the test patterns). Import './_harness' FIRST in the test file.
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import type { Kit, Started, Who } from './_dr13-kit'
import { REASON_CLOSED_BY_US } from '../../lib/checkout-session-plan'

// ---- who is asking ----------------------------------------------------------------------------------------------------------------------------------------------------------------
export const accountWho = (k: Kit): Who => ({ viewer: { id: k.customer.id, role: 'customer' } })
/** the same browser (same signed session) that also holds the access cookie of an order it made: what a guest has after paying */
export const withAccessCookie = (who: Who, started: Started): Who => ({ ...who, cookie: started.accessCookie ?? undefined })
/** another browser (another session) that holds the access cookie of an order made by someone else's session - the H2-with-the-cookie-of-H1 case */
export const otherSessionWithCookie = (k: Kit, started: Started): Who => ({ ...k.newBrowser(), cookie: started.accessCookie ?? undefined })

// ---- a price that changes between two requests -----------------------------------------------------------------------------------------------------------------------------------
const BASE_MARGIN = 20
export async function setMargin(k: Kit, percent: number) {
  await k.prisma.siteConfig.update({ where: { id: 'main' }, data: { targetMarginPercent: percent } })
}
export const restoreMargin = (k: Kit) => setMargin(k, BASE_MARGIN)
/** the total (cents) the server quotes right now for the kit's cart */
export async function quotedTotal(k: Kit, who: Who): Promise<number> {
  const quote = await k.post('quote', k.cart(), who)
  assert.equal(quote.status, 200, quote.text)
  return quote.json.totalCents as number
}

// ---- what is payable at the provider, across orders ----------------------------------------------------------------------------------------------------------------------------
export async function payableAcrossOrders(k: Kit): Promise<Array<{ orderId: string; sessionId: string }>> {
  const orders = await k.prisma.printOrder.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })
  const out: Array<{ orderId: string; sessionId: string }> = []
  for (const order of orders) for (const sessionId of await k.sim.payable(order.id)) out.push({ orderId: order.id, sessionId })
  return out
}
export const orderCount = (k: Kit) => k.prisma.printOrder.count()

// ---- rows the way the OLD code (or a lost answer) left them -------------------------------------------------------------------------------------------------------------------------
/** the order was cancelled by the code that was published BEFORE DR-13 without asking the provider to close its page: the page at the provider stays open and payable */
export async function cancelLikeTheOldCode(k: Kit, started: Started, attemptReason: string | null) {
  await k.prisma.printOrder.update({
    where: { id: started.orderId },
    data: { status: 'cancelled', paymentStatus: 'canceled', metadata: { ...(((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: started.orderId } })).metadata as object) ?? {}), cancellation: { reason: 'checkout_expired', at: new Date().toISOString() } } },
  })
  await k.prisma.paymentAttempt.update({ where: { id: started.attemptId }, data: { status: 'expired', ...(attemptReason === null ? {} : { failureReason: attemptReason }) } })
}
/** the page is closed AT THE PROVIDER (its own answer) and the proof is on the row: what the new code writes. The order is left as it is. */
export async function closeWithProof(k: Kit, started: Started) {
  const closed = await k.sim.expire(started.sessionId)
  assert.equal(closed.status, 'expired', 'the stand-in closed the page')
  await k.prisma.paymentAttempt.update({ where: { id: started.attemptId }, data: { status: 'expired', failureReason: `${REASON_CLOSED_BY_US}kloss-fixture` } })
}

// ---- an advisory lock held from outside, the way another request holds it ---------------------------------------------------------------------------------------------------------
/** holds `pg_advisory_xact_lock(hashtextextended(name, 0))` (the call the checkout makes) in a transaction of its own until `release()` */
export async function holdLock(prisma: PrismaClient, name: string): Promise<{ release: () => Promise<void> }> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldPromise = new Promise<void>((resolve) => { held = resolve })
  const done = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`
    held()
    await gate
  }, { timeout: 60_000, maxWait: 10_000 })
  await heldPromise
  return { release: async () => { release(); await done } }
}
/** true if `work` is still pending after `ms` (it is waiting for something), false if it finished */
export async function stillPendingAfter(work: Promise<unknown>, ms: number): Promise<boolean> {
  const timeout = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))
  const first = await Promise.race([work.then(() => 'done' as const, () => 'done' as const), timeout])
  return first === 'pending'
}

// ---- comparing what two requesters are told ---------------------------------------------------------------------------------------------------------------------------------------------
type Answer = { status: number; json: any; res?: Response }
const shapeOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(shapeOf)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]))
  return typeof value
}
/** status, application code and the SHAPE of the body (keys and types, not values): what an answer says about itself. Two requesters that must not be told apart have the same descriptor. */
export const descriptor = (answer: Answer) => JSON.stringify({ status: answer.status, code: answer.json?.code ?? null, shape: shapeOf(answer.json) })
export const mentions = (answer: Answer, ...needles: string[]) => needles.filter((needle) => JSON.stringify(answer.json ?? {}).includes(needle))

/** every order and every attempt, as stored: "the rows were not touched" */
export async function rowsAsStored(k: Kit): Promise<string> {
  const orders = await k.prisma.printOrder.findMany({ orderBy: { id: 'asc' }, include: { paymentAttempts: { orderBy: { id: 'asc' } } } })
  return JSON.stringify(orders)
}

/** the fingerprints the server stored on an order (the exact values the locks and the lookups are made from) */
export async function storedFingerprints(k: Kit, orderId: string): Promise<{ fingerprint: string; cartFingerprint: string }> {
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  const checkout = (order.metadata as any)?.checkout
  assert.ok(checkout?.fingerprint && checkout?.cartFingerprint, 'the order carries its fingerprints')
  return { fingerprint: checkout.fingerprint, cartFingerprint: checkout.cartFingerprint }
}
