// R1-3 / KLOSS - P0 RED proofs, part 1: payable pages ACROSS orders of the same owner and cart (plan REV3, I-X).
//
// These tests describe defects of the code AS IT IS TODAY. They are RED on purpose and they are NOT part of the ordinary suites (`npm test`, `npm run test:security`): their extension
// (`.red.ts`) matches no pattern of either. They are kept, unchanged, to be run on demand (`npm run test:kloss-red`, which needs the same isolated database as `test:security`) and to turn GREEN
// when P2 of the plan is implemented - then they move into the ordinary suite. Never delete one, never weaken one: the expected value of each is the one the plan gives, and the message names
// the cause. tests/red/kloss/RED-LEDGER.md keeps, for every test, the expected result, the actual result of the last run and the cause.
//
// Isolated PostgreSQL, the stand-in for Stripe (tests/security/_stripe-sim.ts), the real routes. Nothing here calls Stripe, real or in Test Mode.
import '../../security/_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from '../../security/_dr13-kit'
import { checkoutOrderHooks } from '../../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../../lib/checkout-sessions'
import {
  cancelLikeTheOldCode, closeWithProof, descriptor, orderCount, payableAcrossOrders, quotedTotal, restoreMargin, rowsAsStored, setMargin, stillPendingAfter,
} from '../../security/_kloss-kit'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await restoreMargin(k)
  checkoutOrderHooks.afterLock = null
  checkoutSessionHooks.withoutFollowUp = false
  checkoutSessionHooks.afterLoad = null
})
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

const observe = async () => ({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions() })

// ====================================================================================================================================================================
// D1 - same owner and cart, the total changed, the previous page is still payable
// ====================================================================================================================================================================
test('[KL-D1-price] D1: the total changed while the previous page is payable -> no second order and no second payable page (RED: today a second order and a second page are made)', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  const before = await quotedTotal(k, who)
  await setMargin(k, 40)
  const after = await quotedTotal(k, who)
  assert.notEqual(after, before, 'premise: the same cart now quotes another total')
  const second = await k.startCheckout(who, { allowFailure: true })
  const seen = { secondStatus: second.status, ...(await observe()) }
  assert.deepEqual(seen, { secondStatus: 409, orders: 1, payablePages: 1, providerSessions: 1 },
    `CAUSE: the lookup of "the same purchase" compares the total (fingerprint v2, lib/checkout-orders.ts:89-107,496-511), so the first order (page ${first.sessionId}) is not found and a second order is made; nothing looks at the pages of the owner's OTHER orders`)
})

for (const variant of [
  { name: 'a reservation whose answer was lost (no session id), the page exists at the provider', mutate: { status: 'creating', stripeSessionId: null } },
  { name: 'a row closed with a session id and no proof of closing (payment_failed), the page is still open at the provider', mutate: { status: 'expired', failureReason: 'payment_failed' } },
]) {
  test(`[KL-D1-uncertain] D1: the previous page is uncertain (${variant.name}) -> no second order while the uncertainty lasts (RED: a second order and page are made)`, async () => {
    const who = k.newBrowser()
    const first = await k.startCheckout(who)
    await k.prisma.paymentAttempt.update({ where: { id: first.attemptId }, data: variant.mutate as any })
    await setMargin(k, 40)
    const second = await k.startCheckout(who, { allowFailure: true })
    const seen = { secondStatus: second.status, ...(await observe()) }
    assert.deepEqual(seen, { secondStatus: 409, orders: 1, payablePages: 1, providerSessions: 1 },
      'CAUSE: an attempt whose page was never shown closed (creating, or closed without the provider\'s word) is "possibly payable" (DR-13 closedWithoutProof / closedWithIdUnproven) but only the SAME order\'s planner looks at it')
  })
}

test('[KL-D1-stale] D1: a stale tab asks for the older total after a newer order has a live page -> no twin page (RED: the old order opens another page)', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  await closeWithProof(k, first)                      // the first page is provably closed: a newer order is legitimate
  await setMargin(k, 40)
  const second = await k.startCheckout(who)           // a new order at the new total, with a live page
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.notEqual(second.orderId, first.orderId)
  const stale = await k.payAgain(first)               // the old tab: the key of the first order, its own total
  const seen = { staleStatus: stale.status, payablePages: (await payableAcrossOrders(k)).length }
  assert.deepEqual(seen, { staleStatus: 409, payablePages: 1 },
    'CAUSE: a request that finds its order by its key skips every check of the other orders; DR-13 then opens a page for the first order because ITS page is closed, next to the live page of the second order')
})

test('[KL-D1-concurrent] D1 concurrent: two requests, different keys and different totals, the first held inside its lock -> they take turns and one page is payable (RED: they do not meet)', async () => {
  const who = k.newBrowser()
  const totalA = await quotedTotal(k, who)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let inside!: () => void
  const insideP = new Promise<void>((resolve) => { inside = resolve })
  let first = true
  checkoutOrderHooks.afterLock = async () => { if (!first) return; first = false; inside(); await gate }
  const pa = k.post('session', { checkoutKey: k.newKey('a'), expectedTotalCents: totalA, ...k.cart() }, who)
  await insideP
  await setMargin(k, 40)
  const totalB = await quotedTotal(k, who)
  assert.notEqual(totalA, totalB, 'premise: the second request quotes another total')
  const pb = k.post('session', { checkoutKey: k.newKey('b'), expectedTotalCents: totalB, ...k.cart() }, who)
  const secondWaited = await stillPendingAfter(pb, 1500)
  release()
  const [ra, rb] = await Promise.all([pa, pb])
  const seen = { secondWaitedForFirst: secondWaited, statuses: [ra.status, rb.status], ...(await observe()) }
  assert.deepEqual(seen, { secondWaitedForFirst: true, statuses: [200, 409], orders: 1, payablePages: 1, providerSessions: 1 },
    'CAUSE: the locks are named by the fingerprint WITH the total (checkout-orders.ts:481-486), so two requests of one owner and one cart with different totals share no lock and each makes its own order and page')
})

test('[KL-HOLD-uniform] HOLD answers: for a requester that proves only its session, every reason to hold looks the same - in doubt, a live page at another total, a hidden page (RED for the two new reasons)', async () => {
  // (i) a payment that waits for a person (this is held today)
  const whoDoubt = k.newBrowser()
  const doubt = await k.startCheckout(whoDoubt)
  await k.prisma.printOrder.update({ where: { id: doubt.orderId }, data: { paymentStatus: 'paid', status: 'awaiting_review', paymentReviewReason: 'amount_mismatch', paidAt: new Date() } })
  const heldDoubt = await k.startCheckout(whoDoubt, { allowFailure: true })
  // (ii) a live page at another total
  const whoLive = k.newBrowser()
  await k.startCheckout(whoLive)
  await setMargin(k, 40)
  const heldLive = await k.startCheckout(whoLive, { allowFailure: true })
  await restoreMargin(k)
  // (iii) a hidden page of a cancelled order
  const whoHidden = k.newBrowser()
  const hidden = await k.startCheckout(whoHidden)
  await cancelLikeTheOldCode(k, hidden, null)
  const heldHidden = await k.startCheckout(whoHidden, { allowFailure: true })
  const seen = [descriptor(heldDoubt), descriptor(heldLive), descriptor(heldHidden)]
  assert.deepEqual(seen, [descriptor(heldDoubt), descriptor(heldDoubt), descriptor(heldDoubt)],
    `CAUSE: only "in doubt" is held today; the two other reasons are not reasons at all yet (actual statuses ${heldDoubt.status}, ${heldLive.status}, ${heldHidden.status})`)
  assert.equal(heldDoubt.status, 409, 'and the common answer is the 409 of the existing in-doubt hold')
})

// ====================================================================================================================================================================
// A / B - pages of TERMINAL orders (cancelled, paid) that nobody proved closed
// ====================================================================================================================================================================
const noTwoPagesNorWithoutClosing = async (seen: { payable: number; sessions: number; closedBeforeCreate: boolean }) => seen.payable <= 1 && (seen.sessions === 1 || seen.closedBeforeCreate)
async function pageFacts(oldSessionId: string) {
  const ops = await k.opNames()
  const created = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.startsWith('create.executed'))
  const closedAt = ops.indexOf(`expire.executed:${oldSessionId}`)
  return { payable: (await payableAcrossOrders(k)).length, sessions: await k.sim.createdSessions(), closedBeforeCreate: created.length >= 2 && closedAt >= 0 && closedAt < created[1].index }
}

for (const reason of [null, 'session_mismatch:amount', 'stale_reservation']) {
  test(`[KL-A-legacy] A: an order cancelled by the old code (row reason ${reason === null ? 'none' : `"${reason}"`}) whose page is still open at the provider -> the new purchase does not open a second payable page (RED)`, async () => {
    const who = k.newBrowser()
    const old = await k.startCheckout(who)
    await cancelLikeTheOldCode(k, old, reason)
    assert.equal((await k.sim.payable(old.orderId)).length, 1, 'premise: the page of the cancelled order is still payable at the provider')
    await k.startCheckout(who, { allowFailure: true })
    const seen = await pageFacts(old.sessionId)
    assert.equal(await noTwoPagesNorWithoutClosing(seen), true,
      `EXPECTED at most one payable page, and a second session only after the old page was closed AT THE PROVIDER; ACTUAL ${JSON.stringify(seen)}. CAUSE: a cancelled order is not "payable", so no check looks at its pages, and the new order's reservation is written next to a page that was never proved closed`)
  })
}

test('[KL-A-unreachable] A (provider cannot be asked): the old page cannot be proved closed -> fail closed: no new order, no new page, the rows exactly as they were (RED)', async () => {
  const who = k.newBrowser()
  const old = await k.startCheckout(who)
  await cancelLikeTheOldCode(k, old, null)
  k.sim.faults.expireUnreachable = 99
  k.sim.faults.retrieveUnreachable = 99
  const rowsBefore = await rowsAsStored(k)
  const second = await k.startCheckout(who, { allowFailure: true })
  const seen = { status: second.status, providerSessions: await k.sim.createdSessions(), orders: await orderCount(k), rowsUnchanged: (await rowsAsStored(k)) === rowsBefore }
  assert.deepEqual(seen, { status: 409, providerSessions: 1, orders: 1, rowsUnchanged: true },
    'CAUSE: the closing of a terminal order\'s hidden page is never attempted before a new page is reserved, so a provider that cannot be asked changes nothing about what is done')
})

test('[KL-B-paid-hidden] B: a paid order with a second page that nobody proved closed -> the next purchase does not open a second payable page (RED)', async () => {
  const who = k.newBrowser()
  const paid = await k.startCheckout(who)
  const payment = await k.customerPays(paid.sessionId)
  assert.equal(payment.paid, true, 'premise: the customer paid the first page')
  await k.addLegacyTwin(paid.orderId)                  // a second page of the SAME paid order that the old code left open (not closed by anyone yet)
  assert.equal((await k.sim.payable(paid.orderId)).length, 1, 'premise: the hidden page is payable')
  await k.startCheckout(who, { allowFailure: true })
  const seen = await pageFacts(paid.sessionId)
  const hiddenSession = (await k.sim.sessionsOf(paid.orderId)).find((session) => session.legacy)?.id ?? ''
  const closedFirst = (await k.opNames()).indexOf(`expire.executed:${hiddenSession}`)
  assert.equal(seen.payable <= 1 && (closedFirst >= 0 || seen.sessions <= 2), true,
    `EXPECTED at most one payable page across the owner's orders (the hidden page closed with proof before another is opened, or nothing opened); ACTUAL ${JSON.stringify({ ...seen, hiddenPageClosed: closedFirst >= 0 })}. CAUSE: "the order is paid" is taken as "its pages are closed": a page is closed only when something touches that order again`)
})
