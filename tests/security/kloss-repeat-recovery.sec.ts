// R1-3 / KLOSS, P3 - RECOVERY and IDEMPOTENCE of the confirmation of a repeat purchase (audit points A and B), with CHECKOUT_OWNER_GUARD=on and CHECKOUT_REPEAT_GUARD=on.
//   A  an order about to be made is confirmed by the value of ITS context (no order yet); the order made carries an acceptance, which the page checks by what it records - G and the order's revision -
//      never by comparing the two values; an order that EXISTS is confirmed by the value of its own context, the same at both doors, and keeps the acceptance on the order.
//   B  a proposal refused before an order is made writes nothing; a confirmation that was valid when the order was made, followed by a change of G before the page: the order exists (and, for a
//      guest, its key is bound) - the answer says an order waits (`pendingOrder`), no page is made before the new confirmation, a retry finds the same order, a new confirmation completes it.
//   Crashes, lost answers, a provider that can not be reached after the acceptance: a retry with the same key, or a new one, gets the same order and page without a second confirmation while the context
//   is the same. Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { ownerGuardHooks } from '../../lib/checkout-owner-guard'
import { accountWho, closeWithProof, orderCount, payableAcrossOrders, quotedTotal, restoreMargin, rowsAsStored, setMargin, withAccessCookie } from './_kloss-kit'
import { assertProposal, bodyFor, bothOn, checkoutBlockOf, confirmed, keysOf, moneyOf, once, paidPurchase, refundAtProvider, send, withRepeatOff } from './_repeat-kit'

let k: Kit
const MIN = 60_000
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await restoreMargin(k)
  bothOn()
  ownerGuardHooks.afterSiblingsRead = null
  checkoutOrderHooks.afterLock = null
  checkoutSessionHooks.afterLock = null
  checkoutSessionHooks.afterPlan = null
  checkoutSessionHooks.withoutFollowUp = false
})
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

const world = async () => ({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions() })

// an older unpaid order of the cart (its page provably closed), then a later order of another total, paid; the browser's access cookie opens both
async function olderBesideAPaidOne() {
  const browser = k.newBrowser()
  const older = await withRepeatOff(() => k.startCheckout(browser))
  await closeWithProof(k, older)
  await setMargin(k, 40)
  const later = await paidPurchase(k, withAccessCookie(browser, older))
  await restoreMargin(k)
  const holder = withAccessCookie(browser, later)
  assert.equal(await quotedTotal(k, holder), older.total, 'premise: the cart costs again what the older order costs')
  return { older, later, holder }
}

test('[P3-A-new-order] a confirmed NEW order carries its acceptance (revision 0, G as it was): the page is checked by it - a retry with the same key, or a new one, gets the same order and page with no value at all', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const made = await send(k, who, confirmed(body, value))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  const acceptance = (await checkoutBlockOf(k, made.json.orderId)).repeatAcceptance
  assert.deepEqual({ rev: acceptance.rev, context: acceptance.context }, { rev: 0, context: value }, 'the value kept is the one of the order before it existed - it is never compared with the order\'s own')
  const sameKey = await send(k, who, body)
  assert.deepEqual({ status: sameKey.status, orderId: sameKey.json?.orderId, url: sameKey.json?.url }, { status: 200, orderId: made.json.orderId, url: made.json.url }, 'the same key, no value: the same order, the same page')
  const newKey = await send(k, who, { ...body, checkoutKey: k.newKey('again') })
  assert.deepEqual({ status: newKey.status, orderId: newKey.json?.orderId, url: newKey.json?.url }, { status: 200, orderId: made.json.orderId, url: made.json.url }, 'a new key, no value: the same order, the same page')
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })
  await k.assertClean('A new')
})

test('[P3-A-existing-order] an order that EXISTS is confirmed by the value of ITS context - the same at the order door and at the page door; the acceptance is kept ON it, its money untouched; retries need no second confirmation', async () => {
  const { older, later, holder } = await olderBesideAPaidOne()
  const moneyBefore = await moneyOf(k, older.orderId)
  const keysBefore = await k.prisma.guestPurchaseKey.count()
  const body = await bodyFor(k, holder)
  const asked = await send(k, holder, body)
  const value = assertProposal(asked, 'the order to continue')
  assert.deepEqual({ newest: asked.json.orderId, pending: asked.json.pendingOrder, pendingOrderId: asked.json.pendingOrderId, keys: keysOf(asked) },
    { newest: later.orderId, pending: true, pendingOrderId: older.orderId, keys: 'code,error,orderId,orderNumber,pendingOrder,pendingOrderId,pendingOrderNumber,repeatContext,repeatCount' },
    'an order waits for the confirmation: said, and named - the access cookie opens it')
  assert.equal(await k.prisma.guestPurchaseKey.count(), keysBefore, 'nothing written: not even the key')
  const continued = await send(k, holder, confirmed(body, value))
  assert.equal(continued.status, 200, JSON.stringify(continued.json))
  assert.equal(continued.json.orderId, older.orderId, 'the older order is continued, not a new one made')
  const block = await checkoutBlockOf(k, older.orderId)
  assert.deepEqual({ repeatOf: block.repeatOf, context: block.repeatAcceptance?.context, via: block.repeatAcceptance?.via }, { repeatOf: [later.orderId], context: value, via: 'access' })
  assert.equal(await moneyOf(k, older.orderId), moneyBefore, 'the acceptance touched no financial fact of the order: columns, lines, financial keys, revision')
  const again = await send(k, holder, body)
  assert.deepEqual({ status: again.status, orderId: again.json?.orderId, url: again.json?.url }, { status: 200, orderId: older.orderId, url: continued.json.url }, 'the same key, no value')
  const otherKey = await send(k, holder, { ...body, checkoutKey: k.newKey('other') })
  assert.deepEqual({ status: otherKey.status, orderId: otherKey.json?.orderId, url: otherKey.json?.url }, { status: 200, orderId: older.orderId, url: continued.json.url }, 'a new key, no value')
  assert.equal(await k.prisma.guestPurchaseKey.count({ where: { orderId: older.orderId } }), 3, 'its own key, the key of the confirmation and the key of the retry: all bound to the order they continue')
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 3 })
  await k.assertClean('A existing')
})

test('[P3-B1-refused] a proposal refused before an order is made writes nothing - no order, no attempt, no key bound, no row changed - and says no order waits', async () => {
  const browser = k.newBrowser()
  const paid = await paidPurchase(k, browser)
  const holder = withAccessCookie(browser, paid)
  const body = await bodyFor(k, holder)
  const rows = await rowsAsStored(k)
  const keys = await k.prisma.guestPurchaseKey.count()
  const asked = await send(k, holder, body)
  assertProposal(asked, 'proposal')
  assert.equal(asked.json.pendingOrder, undefined, 'no order waits: none was made')
  assert.deepEqual({ rows: await rowsAsStored(k) === rows, keys: await k.prisma.guestPurchaseKey.count() }, { rows: true, keys })
})

test('[P3-B2-after-S2] a confirmation valid when the order was made, then G changes before its page (a refund announced by the webhook): no page before a new confirmation; the answer says the order waits; the retry finds it; the new confirmation completes it', async () => {
  const who = accountWho(k)
  const first = await paidPurchase(k, who)
  await k.travel(MIN)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const asked = await send(k, who, body)
  const value = assertProposal(asked, 'G of two')
  assert.equal(asked.json.repeatCount, 2)
  const sessionsBefore = await k.sim.createdSessions()
  // the order is made (S2, the value is the context's); then, inside the transaction of its page and before anything is decided there, the first payment is refunded - by payment-sync, which
  // locks THAT order's row and none of the checkout's locks
  checkoutSessionHooks.afterLock = once(async () => { await refundAtProvider(k, first.orderId) })
  const held = await send(k, who, confirmed(body, value))
  const newValue = assertProposal(held, 'the context changed after the order was made')
  assert.deepEqual({ pending: held.json.pendingOrder, count: held.json.repeatCount, changed: newValue !== value }, { pending: true, count: 1, changed: true }, 'an order waits: it is said')
  const madeId = held.json.pendingOrderId as string
  assert.ok(madeId, 'named: the account proves the order it made')
  assert.equal((await k.attemptsOf(madeId)).length, 0, 'no reservation was written for it')
  assert.equal(await k.sim.createdSessions(), sessionsBefore, 'no page was made at the provider')
  // the retry: the same key finds the same order and is asked the same; the new value completes it; a new key then needs no value
  const retry = await send(k, who, body)
  assert.equal(assertProposal(retry, 'the retry'), newValue)
  assert.equal(retry.json.pendingOrderId, madeId)
  const done = await send(k, who, confirmed(body, newValue))
  assert.deepEqual({ status: done.status, orderId: done.json?.orderId }, { status: 200, orderId: madeId }, JSON.stringify(done.json))
  const otherKey = await send(k, who, { ...body, checkoutKey: k.newKey('later') })
  assert.deepEqual({ status: otherKey.status, orderId: otherKey.json?.orderId, url: otherKey.json?.url }, { status: 200, orderId: madeId, url: done.json.url })
  assert.deepEqual(await world(), { orders: 3, payablePages: 1, providerSessions: sessionsBefore + 1 })
})

test('[P3-B-guest-after-S2] the same for a guest: its purchase key was bound to the order in the transaction that made it - the retry with that key finds it, a new key continues it; nothing is made twice', async () => {
  const browser = k.newBrowser()
  const first = await paidPurchase(k, browser)
  await k.travel(MIN)
  const second = await paidPurchase(k, withAccessCookie(browser, first))
  const holder = withAccessCookie(browser, second)
  const body = await bodyFor(k, holder)
  const value = assertProposal(await send(k, holder, body), 'G of two')
  checkoutSessionHooks.afterLock = once(async () => { await refundAtProvider(k, first.orderId) })
  const held = await send(k, holder, confirmed(body, value))
  const newValue = assertProposal(held, 'after the order was made')
  assert.equal(held.json.pendingOrder, true)
  assert.equal(held.json.pendingOrderId, undefined, 'a guest proves the order it just made by its session alone: it is said to exist, not named')
  const made = await k.prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  assert.equal((await k.prisma.guestPurchaseKey.findMany({ where: { orderId: made.id } })).length, 1, 'the key was bound to it when it was made')
  const done = await send(k, holder, confirmed(body, newValue))
  assert.deepEqual({ status: done.status, orderId: done.json?.orderId }, { status: 200, orderId: made.id })
  const otherKey = await send(k, withAccessCookie(browser, second), { ...body, checkoutKey: k.newKey('guest-later') })
  assert.deepEqual({ status: otherKey.status, orderId: otherKey.json?.orderId }, { status: 200, orderId: made.id })
  assert.equal(await orderCount(k), 3)
})

test('[P3-B-crash] the request stops between the order and its page (S2 committed, S3 never ran): the order exists with its acceptance - the retry, same key or a new one, gets its page with no second confirmation', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  checkoutSessionHooks.afterLock = once(async () => { throw new Error('the process stopped here (test)') })
  const crashed = await send(k, who, confirmed(body, value))
  assert.equal(crashed.status, 500, JSON.stringify(crashed.json))
  const made = await k.prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  assert.equal((await checkoutBlockOf(k, made.id)).repeatAcceptance?.context, value, 'the order was made with its acceptance')
  assert.equal((await k.attemptsOf(made.id)).length, 0, 'and no page yet')
  const retry = await send(k, who, body)
  assert.deepEqual({ status: retry.status, orderId: retry.json?.orderId }, { status: 200, orderId: made.id }, JSON.stringify(retry.json))
  const otherKey = await send(k, who, { ...body, checkoutKey: k.newKey('after-crash') })
  assert.deepEqual({ status: otherKey.status, orderId: otherKey.json?.orderId, url: otherKey.json?.url }, { status: 200, orderId: made.id, url: retry.json.url })
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })
  await k.assertClean('crash')
})

test('[P3-B-lost-answer] the answer of a confirmed request is lost: the same key, or a new one, gets the same order and the same page - nothing is made twice, nothing asked again', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const lost = await send(k, who, confirmed(body, value))
  assert.equal(lost.status, 200)
  for (const retry of [await send(k, who, body), await send(k, who, confirmed(body, value)), await send(k, who, { ...body, checkoutKey: k.newKey('lost') })]) {
    assert.deepEqual({ status: retry.status, orderId: retry.json?.orderId, url: retry.json?.url }, { status: 200, orderId: lost.json.orderId, url: lost.json.url })
  }
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })
})

test('[P3-B-provider-down] an order that exists is confirmed and the provider can not be reached when its page is made: the acceptance is already kept - the retry gets the page with no second confirmation', async () => {
  const { older, holder } = await olderBesideAPaidOne()
  const body = await bodyFor(k, holder)
  const value = assertProposal(await send(k, holder, body), 'proposal')
  k.sim.faults.createUnreachable = 1
  const down = await send(k, holder, confirmed(body, value))
  assert.equal(down.status, 502, JSON.stringify(down.json))
  assert.equal((await checkoutBlockOf(k, older.orderId)).repeatAcceptance?.context, value, 'kept with the decision, before the provider was called')
  const retry = await send(k, holder, body)
  assert.deepEqual({ status: retry.status, orderId: retry.json?.orderId }, { status: 200, orderId: older.orderId }, JSON.stringify(retry.json))
  assert.equal((await payableAcrossOrders(k)).length, 1)
  await k.assertClean('provider down')
})
