// R1-3 / KLOSS, P2 - THE ARBITER OF THE PAGE (lib/checkout-owner-guard.ts, lib/checkout-sessions.ts), with CHECKOUT_OWNER_GUARD=on.
//
// Wherever the checkout is about to GIVE a payment page of an order, it first asks whether another order of the same owner and cart may still be paid, is in doubt, or could not all be read.
// That is asked for a new reservation, for a reservation that is sent again, AND for the page the order already has (the "reuse" of DR-13) - however the order was found:
//   * by the binding of a guest's purchase key (GuestPurchaseKey), by its stored checkout key (an account; a guest's order made before the keys were bound), as "the order to continue", or
//     after a crash;
//   * beside a legacy sibling page (two orders that may both be paid: the state the checkout could leave before the guard), beside the page of an order that can not be paid any more and was
//     never shown closed (cancelled, paid), beside a payment in doubt, or with a list of orders that was cut.
// When nothing else is in the way, the page of the order is given exactly as before. A hold writes nothing; the provider is asked only AFTER it, outside every transaction; a page of an order
// that can still be paid is never closed to make room. Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit, type Started, type Who } from './_dr13-kit'
import { checkoutOrderHooks, verifiedGuestOrderIds } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { ownerGuardHooks, verifiedGuestOrders } from '../../lib/checkout-owner-guard'
import { deriveGuestAccessToken, mergeGuestAccessCookie } from '../../lib/guest-order-access'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import {
  accountWho, cancelLikeTheOldCode, closeWithProof, orderCount, otherSessionWithCookie, payableAcrossOrders, quotedTotal, restoreMargin, rowsAsStored, setMargin, withAccessCookie,
} from './_kloss-kit'
import { withCheckoutFlags } from './_checkout-flags'

let k: Kit
const on = () => { process.env.CHECKOUT_OWNER_GUARD = 'on' }
const off = () => { delete process.env.CHECKOUT_OWNER_GUARD }
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await restoreMargin(k)
  on()
  ownerGuardHooks.siblingLimit = null
  checkoutOrderHooks.afterLock = null
  checkoutSessionHooks.afterLock = null
  checkoutSessionHooks.afterPlan = null
  checkoutSessionHooks.withoutFollowUp = false
  checkoutSessionHooks.afterLoad = null
})
test.after(async () => { off(); ownerGuardHooks.siblingLimit = null; await restoreMargin(k); await k.fresh(); await k.sim.close() })

type Answer = { status: number; json: any }
// what an answer says about itself: a hold is 409 PAYMENT_IN_PROGRESS with nothing but the sentence and the code - or, to who proves the order that holds, that order
const told = (answer: Answer) => ({ status: answer.status, code: answer.json?.code ?? null, keys: Object.keys(answer.json ?? {}).sort().join(',') })
const HELD_UNNAMED = { status: 409, code: 'PAYMENT_IN_PROGRESS', keys: 'code,error' }
const HELD_NAMED = { status: 409, code: 'PAYMENT_IN_PROGRESS', keys: 'code,error,orderId,orderNumber' }
const world = async () => ({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions() })
// which columns of which rows differ between two readings of rowsAsStored (nothing, when "the rows are as they were")
function differences(before: string, after: string): string[] {
  const flat = (text: string) => {
    const out = new Map<string, string>()
    for (const order of JSON.parse(text) as Array<Record<string, unknown> & { id: string; paymentAttempts: Array<Record<string, unknown> & { id: string }> }>) {
      for (const [column, value] of Object.entries(order)) if (column !== 'paymentAttempts') out.set(`order.${column}@${order.id}`, JSON.stringify(value))
      for (const attempt of order.paymentAttempts) for (const [column, value] of Object.entries(attempt)) out.set(`attempt.${column}@${attempt.id}`, JSON.stringify(value))
    }
    return out
  }
  const a = flat(before)
  const b = flat(after)
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).map((key) => key.split('@')[0]).sort()
}
const counted = (name: string) => getInMemoryMetricsSnapshot().counters.filter((counter) => counter.name === name).reduce((sum, counter) => sum + counter.value, 0)

// Two orders of the same owner and cart, EACH with a page that may be paid: what the checkout could leave before the guard (made here with the flag off, the total changed in between).
async function twins(who: Who): Promise<{ first: Started; second: Started }> {
  off()
  const first = await k.startCheckout(who)
  await setMargin(k, 40)
  const second = await k.startCheckout(who)
  await restoreMargin(k)
  on()
  assert.notEqual(first.orderId, second.orderId)
  assert.equal((await payableAcrossOrders(k)).length, 2, 'premise: two orders of the same owner and cart may both be paid')
  return { first, second }
}

// ====================================================================================================================================================================
// the page the order already has (reuse)
// ====================================================================================================================================================================
test('[P2-reuse-purchase-key] an order found by the binding of its purchase key: its own page is given again when nothing else may be paid; NOT while a sibling page may - for either order; given again once the other is provably closed', async () => {
  const alone = await k.startCheckout(k.newBrowser())
  const again = await k.payAgain(alone)
  assert.deepEqual({ status: again.status, samePage: again.json?.url === alone.url, ...(await world()) }, { status: 200, samePage: true, orders: 1, payablePages: 1, providerSessions: 1 },
    'the only page that may be paid is the order\'s own: it is given again, as before')

  await k.fresh()
  const { first, second } = await twins(k.newBrowser())
  const rowsBefore = await rowsAsStored(k)
  const keysBefore = await k.prisma.guestPurchaseKey.count()
  for (const started of [first, second]) {
    const opsBefore = (await k.opNames()).length
    const answer = await k.payAgain(started)
    assert.deepEqual(told(answer), HELD_UNNAMED, 'the page is not handed out while the other order may be paid; a session alone is told which order by nobody')
    assert.equal(JSON.stringify(answer.json).includes('cs_'), false, 'no address of a payment page is in the answer')
    // the arbiter is asked BEFORE the provider is: the page that is not given is not even read (what is asked afterwards is the page of the OTHER order, the one that holds)
    assert.equal((await k.opNames()).slice(opsBefore).some((name) => name.includes(started.sessionId)), false, 'the page of the order that was held was not read at the provider')
  }
  // A hold writes NOTHING. Afterwards, outside every transaction, the provider was ASKED about the two open pages (never told to close them): the only trace is the mark of that question on the
  // orders - the one a look at the status page leaves - and no state, no total and no attempt changed.
  assert.deepEqual([...new Set(differences(rowsBefore, await rowsAsStored(k)))], ['order.paymentSyncedAt', 'order.updatedAt'])
  assert.equal(await k.prisma.guestPurchaseKey.count(), keysBefore)
  assert.deepEqual(await world(), { orders: 2, payablePages: 2, providerSessions: 2 }, 'nothing was opened and nothing was closed: a page of an order that can still be paid is never closed to make room')
  assert.equal((await k.opNames()).some((name) => name.startsWith('expire.')), false)

  // the other page is closed AT THE PROVIDER, with the proof on its row: the page of the first order is given again - the same page
  await closeWithProof(k, second)
  const after = await k.payAgain(first)
  assert.deepEqual({ status: after.status, samePage: after.json?.url === first.url, ...(await world()) }, { status: 200, samePage: true, orders: 2, payablePages: 1, providerSessions: 2 })
})

test('[P2-reuse-checkout-key] an order found by its stored checkout key (an account; a guest\'s order from before the keys were bound): the same rule - and the account is told WHICH order holds the cart, never given a page', async () => {
  const account = accountWho(k)
  const { first, second } = await twins(account)
  const heldFirst = await k.payAgain(first)
  const heldSecond = await k.payAgain(second)
  assert.deepEqual([told(heldFirst), told(heldSecond)], [HELD_NAMED, HELD_NAMED])
  assert.deepEqual([heldFirst.json.orderId, heldSecond.json.orderId], [second.orderId, first.orderId], 'the order that is named is the OTHER one - the one that holds - which the account can read anyway')
  assert.deepEqual(await world(), { orders: 2, payablePages: 2, providerSessions: 2 })
  await closeWithProof(k, first)
  const given = await k.payAgain(second)
  assert.deepEqual({ status: given.status, samePage: given.json?.url === second.url }, { status: 200, samePage: true })

  // a guest's order whose key is NOT bound (made before R1-1b): found by the stored key, bound now (R1-1b, unchanged) - and its page still waits for the arbiter
  await k.fresh()
  const guest = k.newBrowser()
  const pair = await twins(guest)
  await k.prisma.guestPurchaseKey.deleteMany({ where: { orderId: pair.first.orderId } })
  const viaStoredKey = await k.payAgain(pair.first)
  assert.deepEqual(told(viaStoredKey), HELD_UNNAMED)
  assert.equal(await k.prisma.guestPurchaseKey.count({ where: { orderId: pair.first.orderId } }), 1, 'the key is bound to its order as R1-1b always did; the page is another matter')
  assert.deepEqual(await world(), { orders: 2, payablePages: 2, providerSessions: 2 })
})

test('[P2-reuse-terminal] beside the page of an order that can NOT be paid any more and was never shown closed (cancelled; paid with a hidden page): held - then the provider closes it with proof, and the next request is given its page', async () => {
  // (a) a cancelled order whose page is still open at the provider
  const who = k.newBrowser()
  off()
  const cancelled = await k.startCheckout(who)
  await cancelLikeTheOldCode(k, cancelled, null)
  const current = await k.startCheckout(who)
  on()
  assert.deepEqual([(await k.sim.payable(cancelled.orderId)).length, (await k.sim.payable(current.orderId)).length], [1, 1], 'premise: the hidden page and the current one may both be paid')
  const held = await k.payAgain(current)
  assert.deepEqual(told(held), HELD_UNNAMED)
  // AFTER the hold, outside every transaction, the page of the order that can not be paid was closed at the provider and the proof is on its row
  const proved = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: cancelled.attemptId } })
  assert.deepEqual({ hiddenStillPayable: (await k.sim.payable(cancelled.orderId)).length, proof: (proved.failureReason ?? '').startsWith('closed_by_us:'), currentUntouched: (await k.sim.payable(current.orderId)).length }, { hiddenStillPayable: 0, proof: true, currentUntouched: 1 })
  const given = await k.payAgain(current)
  assert.deepEqual({ status: given.status, samePage: given.json?.url === current.url, ...(await world()) }, { status: 200, samePage: true, orders: 2, payablePages: 1, providerSessions: 2 })

  // (b) a PAID order with a second page nobody closed
  await k.fresh()
  const buyer = k.newBrowser()
  off()
  const paid = await k.startCheckout(buyer)
  assert.equal((await k.customerPays(paid.sessionId)).paid, true)
  await k.addLegacyTwin(paid.orderId)
  const next = await k.startCheckout(buyer)
  on()
  assert.equal((await k.sim.payable(paid.orderId)).length, 1, 'premise: the hidden page of the paid order may be paid')
  assert.deepEqual(told(await k.payAgain(next)), HELD_UNNAMED)
  assert.equal((await k.sim.payable(paid.orderId)).length, 0, 'the hidden page was closed at the provider after the hold')
  const afterwards = await k.payAgain(next)
  assert.deepEqual({ status: afterwards.status, samePage: afterwards.json?.url === next.url }, { status: 200, samePage: true })

  // (c) the provider can not be asked: the hold stays, and nothing is changed
  await k.fresh()
  const stuck = k.newBrowser()
  off()
  const old = await k.startCheckout(stuck)
  await cancelLikeTheOldCode(k, old, 'stale_reservation')
  const mine = await k.startCheckout(stuck)
  on()
  k.sim.faults.expireUnreachable = 99
  k.sim.faults.retrieveUnreachable = 99
  const rowsBefore = await rowsAsStored(k)
  assert.deepEqual([told(await k.payAgain(mine)), told(await k.payAgain(mine))], [HELD_UNNAMED, HELD_UNNAMED])
  assert.deepEqual(differences(rowsBefore, await rowsAsStored(k)), [], 'no proof, no change: the rows are exactly what they were')
  assert.deepEqual(await world(), { orders: 2, payablePages: 2, providerSessions: 2 })
})

test('[P2-reuse-in-doubt-and-cut] beside a payment in doubt, or with a list of the owner\'s orders that was cut: no page is given - of an order that is found by its key either', async () => {
  const who = k.newBrowser()
  const { first, second } = await twins(who)
  await closeWithProof(k, first)
  // the other order holds no page any more...
  assert.equal((await k.payAgain(second)).status, 200)
  // ...but its payment is in doubt (money may be moving): the page of this order is not given
  await k.prisma.printOrder.update({ where: { id: first.orderId }, data: { paymentStatus: 'processing' } })
  assert.deepEqual(told(await k.payAgain(second)), HELD_UNNAMED)
  await k.prisma.printOrder.update({ where: { id: first.orderId }, data: { paymentStatus: 'pending' } })
  assert.equal((await k.payAgain(second)).status, 200)

  // the list of the owner's orders of this cart is cut (two orders, a limit of one): nothing is given
  const incompleteBefore = counted('checkout_owner_guard_incomplete_total')
  ownerGuardHooks.siblingLimit = 1
  assert.deepEqual(told(await k.payAgain(second)), HELD_UNNAMED)
  assert.ok(counted('checkout_owner_guard_incomplete_total') > incompleteBefore, 'a list that was cut is counted')
  // ...and no order is made or continued from it either
  await closeWithProof(k, second)
  const ordersBefore = await orderCount(k)
  assert.deepEqual(told(await k.startCheckout(who, { allowFailure: true })), HELD_UNNAMED)
  assert.equal(await orderCount(k), ordersBefore)
  ownerGuardHooks.siblingLimit = null
  // read to the end, the same request continues the order of this total (nothing holds any more)
  const whole = await k.startCheckout(who)
  assert.deepEqual({ status: whole.status, continued: whole.orderId === first.orderId, orders: await orderCount(k) }, { status: 200, continued: true, orders: ordersBefore })
})

test('[P2-reuse-race] the page was about to be handed out again and ANOTHER order of the same owner and cart gets a page in between (after the decision, before the publication): it is not handed out', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  let happened = false
  checkoutSessionHooks.afterPlan = async (step) => {
    if (step !== 'reuse' || happened) return
    happened = true
    // rows as another process would write them, exactly now: a sibling order with an open page
    const mine = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: first.orderId } })
    const sibling = await k.prisma.printOrder.create({
      data: {
        status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', currency: mine.currency, subtotalCents: mine.subtotalCents + 100, totalCents: mine.totalCents + 100,
        checkoutKey: `race-${'x'.repeat(48)}`, guestSessionHash: mine.guestSessionHash, metadata: mine.metadata as object,
      },
    })
    await k.prisma.paymentAttempt.create({ data: { orderId: sibling.id, amountCents: sibling.totalCents, currency: sibling.currency, status: 'open', expiresAt: new Date(Date.now() + 30 * 60_000), stripeSessionId: 'cs_test_race_sibling' } })
  }
  const answer = await k.payAgain(first)
  checkoutSessionHooks.afterPlan = null
  assert.equal(happened, true, 'premise: the request had decided to hand its page out again')
  assert.deepEqual(told(answer), HELD_UNNAMED, 'the decision is taken again under the locks at the moment the page would be published')
  assert.equal(JSON.stringify(answer.json).includes('cs_'), false)
})

test('[P2-arbiter-cookie-scope] the arbiter looks at what the REQUEST proves, not only at the order\'s own columns: with the cookie of an order whose page may be paid, no page of the request\'s own order is opened - without it, two guests are never merged', async () => {
  // H1's order O1 has a live page. H2 - another session - has its OWN order of the same cart (another total), whose page is provably closed. Both made before the guard.
  off()
  const o1 = await k.startCheckout(k.newBrowser())
  await setMargin(k, 40)
  const h2 = k.newBrowser()
  const own = await k.startCheckout(h2)
  await closeWithProof(k, own)
  await restoreMargin(k)
  on()
  const h2WithCookie: Who = { ...h2, cookie: o1.accessCookie ?? undefined }
  const held = await k.payAgain(own, h2WithCookie)
  assert.deepEqual({ ...told(held), named: held.json?.orderId }, { ...HELD_NAMED, named: o1.orderId }, 'the request proves O1 with its cookie, and O1 may be paid: no page of its own order - and O1 is named (the cookie opens it)')
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })
  // the same request without the cookie proves nothing of O1: an independent guest, and its page is opened
  const independent = await k.payAgain(own)
  assert.deepEqual({ status: independent.status, ...(await world()) }, { status: 200, orders: 2, payablePages: 2, providerSessions: 3 })
})

test('[P2-no-repeat-gate] the purchase made again after a PAID one is not P2\'s business (D3 is P3): with the guard on - and the repeat gate of P3 OFF - it is neither held nor asked a confirmation - an account, a guest with the cookie of the paid order, a session alone', async () => {
  // (the repeat gate on is P3's: the same three requesters are in tests/security/kloss-repeat-interop.sec.ts, [P3-after-a-paid-one])
  await withCheckoutFlags({ repeat: 'off' }, async () => {
    const paidOnce = async (who: Who) => {
      const first = await k.startCheckout(who)
      assert.equal((await k.customerPays(first.sessionId)).paid, true)
      return first
    }
    const account = accountWho(k)
    const a1 = await paidOnce(account)
    const a2 = await k.startCheckout(account, { allowFailure: true })
    assert.deepEqual({ status: a2.status, another: a2.orderId !== a1.orderId, ...(await world()) }, { status: 200, another: true, orders: 2, payablePages: 1, providerSessions: 2 })
    await k.fresh()
    const browser = k.newBrowser()
    const g1 = await paidOnce(browser)
    const g2 = await k.startCheckout(withAccessCookie(browser, g1), { allowFailure: true })
    assert.deepEqual({ status: g2.status, another: g2.orderId !== g1.orderId }, { status: 200, another: true })
    await k.fresh()
    const alone = k.newBrowser()
    const s1 = await paidOnce(alone)
    const s2 = await k.startCheckout(alone, { allowFailure: true })
    assert.deepEqual({ status: s2.status, another: s2.orderId !== s1.orderId }, { status: 200, another: true })
  })
})

// ====================================================================================================================================================================
// a reservation that is sent again; a crash between the order and its page
// ====================================================================================================================================================================
async function orphanReservation(who: Who) {
  const key = k.newKey('orphan')
  const total = await quotedTotal(k, who)
  const body = { checkoutKey: key, expectedTotalCents: total, ...k.cart() }
  checkoutSessionHooks.afterPlan = async (step) => { if (step === 'send') throw new Error('the process died after it reserved, before it called the provider') }
  const died = await k.post('session', body, who)
  checkoutSessionHooks.afterPlan = null
  assert.equal(died.status, 500)
  const reservation = await k.prisma.paymentAttempt.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  assert.deepEqual({ status: reservation.status, session: reservation.stripeSessionId }, { status: 'creating', session: null }, 'premise: a reservation whose request was never sent')
  return { body, reservation }
}

test('[P2-replay] a reservation that is sent again: alone, it is resolved as before; beside a sibling page it is NOT sent - nothing reaches the provider, the reservation stays what it is', async () => {
  const who = k.newBrowser()
  const alone = await orphanReservation(who)
  const resolved = await k.post('session', alone.body, who)
  assert.deepEqual({ status: resolved.status, ...(await world()) }, { status: 200, orders: 1, payablePages: 1, providerSessions: 1 })

  await k.fresh()
  const browser = k.newBrowser()
  const orphan = await orphanReservation(browser)
  // a sibling order with a live page (made with the flag off: with it on the reservation above already holds the cart - shown first)
  await setMargin(k, 40)
  assert.deepEqual(told(await k.startCheckout(browser, { allowFailure: true })), HELD_UNNAMED, 'with the guard on, a reservation of any age holds the cart: no second order')
  off()
  const sibling = await k.startCheckout(browser)
  on()
  await restoreMargin(k)
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 1 })
  const opsBefore = (await k.opNames()).length
  const heldReplay = await k.post('session', orphan.body, browser)
  assert.deepEqual(told(heldReplay), HELD_UNNAMED)
  const after = await k.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: orphan.reservation.id } })
  assert.deepEqual({ status: after.status, session: after.stripeSessionId, ...(await world()) }, { status: 'creating', session: null, orders: 2, payablePages: 1, providerSessions: 1 })
  assert.equal((await k.opNames()).slice(opsBefore).some((name) => name.startsWith('create.')), false, 'no request to create a page was sent')
  assert.equal((await k.sim.payable(sibling.orderId)).length, 1, 'the sibling page is untouched')
})

test('[P2-crash] a request that dies between its order and its page: inside the join window the order holds the cart (no second order at another total) and its own key gets its page; after the window the arbiter still allows ONE page', async () => {
  const who = k.newBrowser()
  const key = k.newKey('crash')
  const total = await quotedTotal(k, who)
  const body = { checkoutKey: key, expectedTotalCents: total, ...k.cart() }
  const dieBeforeReserving = async () => {
    checkoutSessionHooks.afterLock = async () => { throw new Error('the first request died before it reserved anything') }
    const died = await k.post('session', body, who)
    checkoutSessionHooks.afterLock = null
    assert.equal(died.status, 500)
    assert.deepEqual({ orders: await orderCount(k), attempts: await k.prisma.paymentAttempt.count() }, { orders: 1, attempts: 0 }, 'premise: an order with no attempt at all')
  }
  await dieBeforeReserving()
  await setMargin(k, 40)
  assert.deepEqual(told(await k.startCheckout(who, { allowFailure: true })), HELD_UNNAMED, 'the order was just made: its page is being opened')
  assert.equal(await orderCount(k), 1)
  await restoreMargin(k)
  const own = await k.post('session', body, who)
  assert.deepEqual({ status: own.status, ...(await world()) }, { status: 200, orders: 1, payablePages: 1, providerSessions: 1 })

  // after the window: the order without a single attempt has no page - a new order may be made; then its own key is held by the arbiter (never two pages)
  await k.fresh()
  await dieBeforeReserving()
  await k.travel(91_000)
  await setMargin(k, 40)
  const later = await k.startCheckout(who)
  await restoreMargin(k)
  assert.deepEqual({ status: later.status, ...(await world()) }, { status: 200, orders: 2, payablePages: 1, providerSessions: 1 })
  assert.deepEqual(told(await k.post('session', body, who)), HELD_UNNAMED)
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 1 })
})

// ====================================================================================================================================================================
// what a request proves is read again under the locks; what it is told
// ====================================================================================================================================================================
const cookieValueOf = (started: Started) => decodeURIComponent((started.accessCookie as string).split('=').slice(1).join('='))

test('[P2-proofs] the orders an access cookie opens: the guard reads exactly what the checkout already reads (valid, expired, forged, another guest\'s, an account\'s) - with the session each carries', async () => {
  off()
  const a = await k.startCheckout(k.newBrowser())
  const b = await k.startCheckout(k.newBrowser())
  const expired = await k.startCheckout(k.newBrowser())
  await k.prisma.printOrder.update({ where: { id: expired.orderId }, data: { guestAccessExpiresAt: new Date(Date.now() - 60_000) } })
  const hashless = await k.startCheckout(k.newBrowser())
  await k.prisma.printOrder.update({ where: { id: hashless.orderId }, data: { guestSessionHash: null } })
  const ofAccount = await k.startCheckout(accountWho(k))
  let cookie = cookieValueOf(a)
  cookie = mergeGuestAccessCookie(cookie, b.orderId, 'x'.repeat(43))                              // forged token
  cookie = mergeGuestAccessCookie(cookie, expired.orderId, deriveGuestAccessToken(expired.orderId))   // right token, run out
  cookie = mergeGuestAccessCookie(cookie, hashless.orderId, deriveGuestAccessToken(hashless.orderId))
  cookie = mergeGuestAccessCookie(cookie, ofAccount.orderId, deriveGuestAccessToken(ofAccount.orderId))
  const mine = await verifiedGuestOrders(cookie)
  assert.deepEqual(mine.map((order) => order.id).sort(), (await verifiedGuestOrderIds(cookie)).sort(), 'the same orders as verifiedGuestOrderIds')
  assert.deepEqual(mine.map((order) => order.id).sort(), [a.orderId, hashless.orderId].sort())
  const stored = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: a.orderId } })
  assert.deepEqual(mine.find((order) => order.id === a.orderId)?.guestSessionHash, stored.guestSessionHash)
  assert.equal(mine.find((order) => order.id === hashless.orderId)?.guestSessionHash, null)
  for (const junk of [null, undefined, '', 'garbage', 'a.b.c']) assert.deepEqual(await verifiedGuestOrders(junk), [])
})

test('[P2-privacy] a new session with the cookie of an order: that order is named; an order known only by LINEAGE holds without a name; a cookie that runs out - even inside the lock - proves nothing', async () => {
  // H1 has two orders that may be paid (made before the guard): O1, whose cookie H2 holds, and O2
  const h1 = k.newBrowser()
  off()
  const o1 = await k.startCheckout(h1)
  on()
  const h2: Who = otherSessionWithCookie(k, o1)
  await setMargin(k, 40)
  const namedO1 = await k.startCheckout(h2, { allowFailure: true })
  assert.deepEqual({ ...told(namedO1), named: namedO1.json?.orderId }, { ...HELD_NAMED, named: o1.orderId }, 'the cookie opens O1: it is named (its status page would tell the same)')
  await restoreMargin(k)

  // O1 is provably closed; O2 (same session H1, not in the cookie) has a live page at the SAME total: known by lineage only -> held, nothing of O2 is told, and it is not handed over
  await closeWithProof(k, o1)
  off()
  await setMargin(k, 40)
  const o2 = await k.startCheckout(h1)
  on()
  const viaLineage = await k.startCheckout(h2, { allowFailure: true })
  assert.deepEqual(told(viaLineage), HELD_UNNAMED)
  assert.equal(JSON.stringify(viaLineage.json).includes(o2.orderId), false)
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })

  // the cookie runs out (guestAccessExpiresAt in the past): H2 proves nothing of H1's - it is an independent guest again, told nothing and held by nothing
  await k.prisma.printOrder.update({ where: { id: o1.orderId }, data: { guestAccessExpiresAt: new Date(Date.now() - 60_000) } })
  const independent = await k.startCheckout(h2, { allowFailure: true })
  assert.deepEqual({ status: independent.status, own: ![o1.orderId, o2.orderId].includes(independent.orderId) }, { status: 200, own: true })

  // ...and a cookie that runs out INSIDE the lock (after the route verified it) counts for nothing either: the proofs are read again under the locks
  await k.fresh()
  await restoreMargin(k)
  const g1 = k.newBrowser()
  off()
  const p1 = await k.startCheckout(g1)
  on()
  const g2 = otherSessionWithCookie(k, p1)
  await setMargin(k, 40)
  assert.equal((await k.startCheckout(g2, { allowFailure: true })).status, 409, 'control: with the cookie valid the request is held')
  let once = true
  checkoutOrderHooks.afterLock = async () => {
    if (!once) return
    once = false
    await k.prisma.printOrder.update({ where: { id: p1.orderId }, data: { guestAccessExpiresAt: new Date(Date.now() - 60_000) } })
  }
  const afterExpiry = await k.startCheckout(g2, { allowFailure: true })
  checkoutOrderHooks.afterLock = null
  assert.deepEqual({ status: afterExpiry.status, own: afterExpiry.orderId !== p1.orderId, named: JSON.stringify(afterExpiry.json).includes(p1.orderId) }, { status: 200, own: true, named: false })
})

test('[P2-lock-set] what is proved under the locks needs a lock that was not taken (an order of the cookie lost its session hash meanwhile): the transaction is run again with both sets, and it converges', async () => {
  const h1 = k.newBrowser()
  off()
  const o1 = await k.startCheckout(h1)
  await closeWithProof(k, o1)
  on()
  const h2 = otherSessionWithCookie(k, o1)
  let rounds = 0
  checkoutOrderHooks.afterLock = async () => {
    rounds += 1
    // (what the retention job does to an old order, here at the worst moment: between the two reads of the proofs)
    if (rounds === 1) await k.prisma.printOrder.update({ where: { id: o1.orderId }, data: { guestSessionHash: null } })
  }
  const answer = await k.startCheckout(h2, { allowFailure: true })
  checkoutOrderHooks.afterLock = null
  // the order the cookie opens is the order to continue (same total, its page provably closed): it is continued - by the cookie, not by a session hash it no longer has
  assert.deepEqual({ status: answer.status, rounds, continued: answer.orderId === o1.orderId, ...(await world()) }, { status: 200, rounds: 2, continued: true, orders: 1, payablePages: 1, providerSessions: 2 })
})

test('[P2-lock-set] the same when a PAGE is about to be given: the proofs read under the locks need a lock that was not taken - the transaction is run again with both sets and the page is given', async () => {
  off()
  const o1 = await k.startCheckout(k.newBrowser())
  await closeWithProof(k, o1)
  await setMargin(k, 40)
  const h2 = k.newBrowser()
  const own = await k.startCheckout(h2)
  await closeWithProof(k, own)
  await restoreMargin(k)
  on()
  let transactions = 0
  checkoutSessionHooks.afterLock = async () => {
    transactions += 1
    if (transactions === 1) await k.prisma.printOrder.update({ where: { id: o1.orderId }, data: { guestSessionHash: null } })
  }
  const answer = await k.payAgain(own, { ...h2, cookie: o1.accessCookie ?? undefined })
  checkoutSessionHooks.afterLock = null
  assert.deepEqual({ status: answer.status, ranAgain: transactions >= 3, ...(await world()) }, { status: 200, ranAgain: true, orders: 2, payablePages: 1, providerSessions: 3 })
})
