// R1-3 / KLOSS hardening A - the owner guard reads only the siblings that can change its decision (lib/checkout-owner-guard.ts, RELEVANT_SIBLING_SQL / readSiblings), with
// CHECKOUT_OWNER_GUARD=on and CHECKOUT_REPEAT_GUARD=on.
//
// Before A the guard read EVERY order of the owner and the cart, of every state, up to 200, and held (`incomplete`) as soon as there were more: a customer who had bought the same cart 200 times
// could never buy it again, and an order that DID matter - the oldest, with a page that may still be paid, or a payment in doubt, or a recent payment beyond the 200 newest orders - was not seen.
// Now the limit counts only the RELEVANT orders (a payment in doubt; an attempt that may still be payable; an unpaid order young enough to be continued; a verified payment inside the window of
// the repeat gate, or at an unknown instant). More than 200 RELEVANT orders still hold (fail-closed). Isolated PostgreSQL, the stand-in for Stripe, the real routes; the many orders are written
// as the checkout and the payment sync leave them.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit, type Started } from './_dr13-kit'
import { ownerGuardHooks } from '../../lib/checkout-owner-guard'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import { REASON_CLOSED_BY_US } from '../../lib/checkout-session-plan'
import { accountWho, cancelLikeTheOldCode, orderCount, restoreMargin } from './_kloss-kit'
import { paidPurchase, REPEAT_CODE } from './_repeat-kit'
import { checkoutFlagsForThisFile } from './_checkout-flags'

checkoutFlagsForThisFile({ owner: 'on', repeat: 'on' })

let k: Kit
const MIN = 60_000
const HOUR = 60 * MIN
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await restoreMargin(k)
  ownerGuardHooks.siblingLimit = null
  ownerGuardHooks.afterSiblingsRead = null
})
test.after(async () => { await k.fresh(); await k.sim.close() })

const counted = (name: string, labels: Record<string, string> = {}) => getInMemoryMetricsSnapshot().counters
  .filter((counter) => counter.name === name && Object.entries(labels).every(([key, value]) => String((counter.labels as Record<string, unknown> | undefined)?.[key]) === value))
  .reduce((sum, counter) => sum + counter.value, 0)

// ---- many orders of the same owner and cart, as the checkout and the payment sync leave them -----------------------------------------------------------------------------------------------
type Shape = {
  status: string
  paymentStatus: string
  createdAt: Date
  paidAt: Date | null
  // its one attempt: the page that carried the order's own payment (`carrier`), or a page closed with the provider's word (closed_by_us), or none
  attempt: 'carrier' | 'closed_with_proof' | null
}
let batch = 0
/** `count` orders of the template's owner and cart (its fingerprints, its amounts), each of the shape `shape(i)`; the ids of the orders, in the order they were made */
async function siblingsLike(template: Started, count: number, shape: (i: number) => Shape): Promise<string[]> {
  const t = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: template.orderId } })
  const tag = `${Date.now().toString(36)}${(batch += 1)}`
  const orders: any[] = []
  const attempts: any[] = []
  for (let i = 0; i < count; i++) {
    const s = shape(i)
    const id = `ha_${tag}_${i}`
    const intent = s.attempt === 'carrier' ? `pi_ha_${tag}_${i}` : null
    orders.push({
      id, userId: t.userId, guestSessionHash: t.guestSessionHash, status: s.status, paymentStatus: s.paymentStatus, paymentMethod: 'card', subtotalCents: t.subtotalCents, totalCents: t.totalCents,
      currency: t.currency, shippingCents: t.shippingCents, taxCents: t.taxCents, shippingMethod: t.shippingMethod, metadata: t.metadata, createdAt: s.createdAt, updatedAt: s.createdAt, paidAt: s.paidAt,
      stripePaymentIntentId: intent,
    })
    if (s.attempt) {
      attempts.push({
        orderId: id, amountCents: t.totalCents, currency: t.currency.toLowerCase(), stripeSessionId: `cs_ha_${tag}_${i}`, createdAt: s.createdAt, expiresAt: new Date(s.createdAt.getTime() + 32 * MIN),
        ...(s.attempt === 'carrier'
          ? { status: 'paid', stripePaymentIntentId: intent, amountReceivedCents: t.totalCents, completedAt: s.paidAt }
          : { status: 'expired', failureReason: `${REASON_CLOSED_BY_US}kloss-relevance` }),
      })
    }
  }
  await k.prisma.printOrder.createMany({ data: orders })
  if (attempts.length > 0) await k.prisma.paymentAttempt.createMany({ data: attempts })
  return orders.map((order) => order.id as string)
}
const ago = (ms: number) => new Date(Date.now() - ms)
/** paid and done long ago: the page that carried the payment is the order's own, nothing is in doubt, the payment is outside every window */
const paidLongAgo = (i: number): Shape => ({ status: 'completed', paymentStatus: 'paid', createdAt: ago(3 * HOUR - i * 1000), paidAt: ago(3 * HOUR - i * 1000 - 5000), attempt: 'carrier' })
/** cancelled, its page closed with the provider's word */
const closedLongAgo = (i: number): Shape => ({ status: 'cancelled', paymentStatus: 'canceled', createdAt: ago(3 * HOUR - i * 1000), paidAt: null, attempt: 'closed_with_proof' })
/** an order made long ago (older than every order of the batch) */
async function makeOldest(started: Started) {
  await k.prisma.printOrder.update({ where: { id: started.orderId }, data: { createdAt: ago(5 * HOUR) } })
  await k.prisma.paymentAttempt.updateMany({ where: { orderId: started.orderId }, data: { createdAt: ago(5 * HOUR) } })
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('[HA-201-irrelevant] 250 purchases of the same cart, paid and done hours ago, and nothing else: the customer can buy the cart again - a new order, no hold, no proposal', async () => {
  const who = accountWho(k)
  const first = await paidPurchase(k, who)
  // (the purchase itself is hours old too)
  await k.prisma.printOrder.update({ where: { id: first.orderId }, data: { createdAt: ago(4 * HOUR), paidAt: ago(4 * HOUR) } })
  await k.prisma.paymentAttempt.updateMany({ where: { orderId: first.orderId }, data: { createdAt: ago(4 * HOUR), completedAt: ago(4 * HOUR) } })
  await siblingsLike(first, 250, paidLongAgo)
  const before = await orderCount(k)
  const again = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: again.status, code: again.json?.code ?? null, newOrder: Boolean(again.orderId) && again.orderId !== first.orderId, orders: await orderCount(k) }, { status: 200, code: null, newOrder: true, orders: before + 1 })
})

test('[HA-oldest-relevant] 250 orders closed with the provider\'s word, and the OLDEST order - cancelled, its page never shown closed - may still be paid: the hold names it to the account, its page is closed with proof, and the next request goes on', async () => {
  const who = accountWho(k)
  const oldest = await k.startCheckout(who)
  await cancelLikeTheOldCode(k, oldest, null)
  await makeOldest(oldest)
  await siblingsLike(oldest, 250, closedLongAgo)
  const heldBefore = counted('checkout_owner_guard_held_total', { stage: 'order', cause: 'sibling_page' })
  const held = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: held.status, code: held.json?.code ?? null, orderId: held.json?.orderId ?? null }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: oldest.orderId })
  assert.equal(counted('checkout_owner_guard_held_total', { stage: 'order', cause: 'sibling_page' }), heldBefore + 1, 'held because of that page, not because the list was cut')
  // the recovery after the hold closed that page AT THE PROVIDER, with proof on the row
  assert.equal((await k.sim.payable(oldest.orderId)).length, 0, 'the page of the cancelled order is not payable any more')
  const attempt = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: oldest.attemptId } })
  assert.ok(String(attempt.failureReason).startsWith(REASON_CLOSED_BY_US), String(attempt.failureReason))
  // and the next request is not held any more: a new order
  const before = await orderCount(k)
  const again = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: again.status, orders: await orderCount(k) }, { status: 200, orders: before + 1 })
})

test('[HA-oldest-doubt] 250 orders closed with the provider\'s word, and the OLDEST order has a payment in doubt (a payment still moving on an order that was cancelled): the hold is for THAT payment, named to the account', async () => {
  const who = accountWho(k)
  const oldest = await k.startCheckout(who)
  // (cancelled while its payment was moving: the in-flight check of the route calls it "canceled" and lets the request through; the guard must see the payment in doubt)
  await k.prisma.printOrder.update({ where: { id: oldest.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  await k.prisma.paymentAttempt.update({ where: { id: oldest.attemptId }, data: { status: 'processing' } })
  await makeOldest(oldest)
  await siblingsLike(oldest, 250, closedLongAgo)
  const heldBefore = counted('checkout_owner_guard_held_total', { stage: 'order', cause: 'in_doubt' })
  const before = await orderCount(k)
  const held = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: held.status, code: held.json?.code ?? null, orderId: held.json?.orderId ?? null, orders: await orderCount(k) }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: oldest.orderId, orders: before })
  assert.equal(counted('checkout_owner_guard_held_total', { stage: 'order', cause: 'in_doubt' }), heldBefore + 1, 'held because of the payment in doubt, not because the list was cut')
})

test('[HA-G-beyond] three purchases paid a few minutes ago - but MADE hours ago, older than 205 other orders of the cart paid and done long ago: the repeat gate sees all three and asks the confirmation for them', async () => {
  const who = accountWho(k)
  const paid = [await paidPurchase(k, who), await paidPurchase(k, who), await paidPurchase(k, who)]
  for (const purchase of paid) await makeOldest(purchase)
  await siblingsLike(paid[0], 205, paidLongAgo)
  const before = await orderCount(k)
  const asked = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: asked.status, code: asked.json?.code ?? null, count: asked.json?.repeatCount ?? null, orders: await orderCount(k) }, { status: 409, code: REPEAT_CODE, count: 3, orders: before })
  assert.ok(paid.some((purchase) => purchase.orderId === asked.json?.orderId), 'the proposal names one of the three')
})

test('[HA-200-201] the limit counts the RELEVANT orders only: 200 recent purchases beside 60 old ones are read whole (the proposal counts 200); one more recent purchase and the list is not whole - held, and counted', async () => {
  const who = accountWho(k)
  const first = await paidPurchase(k, who)
  await siblingsLike(first, 60, paidLongAgo)
  // 199 more purchases paid in the last minutes: with the first one, 200 orders the repeat gate must see
  await siblingsLike(first, 199, (i) => ({ status: 'queued', paymentStatus: 'paid', createdAt: ago(50 * MIN - i * 1000), paidAt: ago(40 * MIN - i * 1000), attempt: 'carrier' }))
  const whole = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: whole.status, code: whole.json?.code ?? null, count: whole.json?.repeatCount ?? null }, { status: 409, code: REPEAT_CODE, count: 200 })
  // one more: 201 relevant orders - more than can be read - and the guard holds (fail-closed), whatever else is true
  await siblingsLike(first, 1, () => ({ status: 'queued', paymentStatus: 'paid', createdAt: ago(55 * MIN), paidAt: ago(45 * MIN), attempt: 'carrier' }))
  const incompleteBefore = counted('checkout_owner_guard_incomplete_total', { stage: 'order' })
  const before = await orderCount(k)
  const cut = await k.startCheckout(who, { allowFailure: true })
  assert.deepEqual({ status: cut.status, code: cut.json?.code ?? null, keys: Object.keys(cut.json ?? {}).sort().join(','), orders: await orderCount(k) }, { status: 409, code: 'PAYMENT_IN_PROGRESS', keys: 'code,error', orders: before })
  assert.equal(counted('checkout_owner_guard_incomplete_total', { stage: 'order' }), incompleteBefore + 1)
})
