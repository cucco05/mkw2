// R1-3 / KLOSS, P2 - the flag CHECKOUT_OWNER_GUARD = off | shadow | on (lib/checkout-owner-guard.ts).
//   * unset, or anything that is not `shadow` or `on`: OFF. With it off the checkout is what it was before P2 - the very scenarios the P0 proofs describe still end the old way (a second
//     order and a second payable page), no owner lock is taken, nothing is counted, the provider is asked nothing more;
//   * shadow: the same answers, the same rows and the same calls to the provider as off - and the decision that WOULD have been taken is counted. No request is held, no lock is added, no
//     page is asked about or closed;
//   * on: the decisions are applied (the fifteen P0 proofs in kloss-cross-order / kloss-sessions-and-locks / kloss-window run with it).
// Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { ownerGuardMode } from '../../lib/checkout-owner-guard'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import { cancelLikeTheOldCode, closeWithProof, holdLock, orderCount, payableAcrossOrders, quotedTotal, restoreMargin, setMargin, stillPendingAfter, storedFingerprints } from './_kloss-kit'

let k: Kit
const setFlag = (value?: string) => { if (value === undefined) delete process.env.CHECKOUT_OWNER_GUARD; else process.env.CHECKOUT_OWNER_GUARD = value }
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await restoreMargin(k)
  setFlag(undefined)
  checkoutOrderHooks.afterLock = null
  checkoutSessionHooks.withoutFollowUp = false
  checkoutSessionHooks.afterLoad = null
})
test.after(async () => { setFlag(undefined); await restoreMargin(k); await k.fresh(); await k.sim.close() })

// how many times a counter of the guard was incremented so far (all label sets that match)
function counted(name: string, labels: Record<string, string> = {}): number {
  return getInMemoryMetricsSnapshot().counters
    .filter((counter) => counter.name === name && Object.entries(labels).every(([key, value]) => String((counter.labels as Record<string, unknown> | undefined)?.[key]) === value))
    .reduce((sum, counter) => sum + counter.value, 0)
}
const guardCounters = () => getInMemoryMetricsSnapshot().counters.filter((counter) => counter.name.startsWith('checkout_owner_guard')).reduce((sum, counter) => sum + counter.value, 0)
// what the provider was asked, without the identifiers (two runs make different sessions)
const opKinds = async () => (await k.opNames()).map((name) => name.split(':')[0])
const expires = async () => (await opKinds()).filter((op) => op === 'expire.executed').length
// every order and its attempts, without identifiers and times: "the same rows"
async function rowShapes() {
  const orders = await k.prisma.printOrder.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { paymentAttempts: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } })
  return orders.map((o) => `${o.status}/${o.paymentStatus}/${o.totalCents}:${o.paymentAttempts.map((a) => `${a.status}${a.failureReason ? `(${a.failureReason.split(':')[0]})` : ''}${a.stripeSessionId ? '+id' : ''}`).join(',')}`)
}

// the three scenarios of P0 in one run: D1 (the total changed), A (a cancelled order whose page is still open), the stale tab (D1-stale)
async function threeScenarios() {
  // D1
  const d1 = k.newBrowser()
  await k.startCheckout(d1)
  await setMargin(k, 40)
  const d1Second = await k.startCheckout(d1, { allowFailure: true })
  await restoreMargin(k)
  // A
  const a = k.newBrowser()
  const old = await k.startCheckout(a)
  await cancelLikeTheOldCode(k, old, null)
  const aSecond = await k.startCheckout(a, { allowFailure: true })
  const oldPageStillOpen = (await k.sim.payable(old.orderId)).length
  // the stale tab
  const s = k.newBrowser()
  const first = await k.startCheckout(s)
  const expiresBeforeFixture = await expires()
  await closeWithProof(k, first)
  const fixtureExpires = (await expires()) - expiresBeforeFixture   // (the fixture closes a page itself: not the checkout's doing)
  await setMargin(k, 40)
  const second = await k.startCheckout(s)
  const stale = await k.payAgain(first)
  await restoreMargin(k)
  return {
    statuses: { d1Second: d1Second.status, aSecond: aSecond.status, second: second.status, stale: stale.status },
    orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions(), oldPageStillOpen,
    pagesClosedByTheCheckout: (await expires()) - fixtureExpires, ops: await opKinds(), rows: await rowShapes(),
  }
}
const OLD_WAY = { statuses: { d1Second: 200, aSecond: 200, second: 200, stale: 200 }, orders: 6, payablePages: 6, providerSessions: 7, oldPageStillOpen: 1, pagesClosedByTheCheckout: 0 }

test('[P2-flag-default] the flag is OFF unless it says `shadow` or `on` - unset, empty, misspelt or "true" are all off', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['OFF', 'off'], ['0', 'off'], ['1', 'off'], ['true', 'off'], ['yes', 'off'], ['enabled', 'off'], ['on!', 'off'], ['onn', 'off'], ['shadow-on', 'off'],
    ['on', 'on'], ['ON', 'on'], [' on ', 'on'], ['shadow', 'shadow'], ['Shadow', 'shadow'],
  ]
  for (const [value, expected] of cases) {
    setFlag(value)
    assert.equal(ownerGuardMode(), expected, `CHECKOUT_OWNER_GUARD=${JSON.stringify(value)}`)
  }
})

test('[P2-flag-off] off (unset, and said out loud): the three P0 scenarios end the OLD way, nothing of the guard is counted, no owner lock is taken, the provider is asked nothing more', async () => {
  const before = guardCounters()
  const { ops: opsUnset, rows: rowsUnset, ...seenUnset } = await threeScenarios()
  assert.deepEqual(seenUnset, OLD_WAY, 'with the flag unset the checkout is what it was: a second order and a second payable page in every scenario, and no page closed by a checkout')
  await k.fresh()
  setFlag('off')
  const { ops: opsOff, rows: rowsOff, ...seenOff } = await threeScenarios()
  assert.deepEqual(seenOff, OLD_WAY)
  assert.deepEqual(opsOff, opsUnset, 'the same calls to the provider, in the same order')
  assert.deepEqual(rowsOff, rowsUnset, 'the same rows')
  assert.equal(guardCounters(), before, 'nothing of the guard was counted')
  // no owner lock: a request does not wait for one that is held from outside
  await k.fresh()
  const probe = await k.startCheckout(k.newBrowser())
  const { cartFingerprint } = await storedFingerprints(k, probe.orderId)
  const who = k.newBrowser()
  const held = await holdLock(k.prisma, `checkout:owner:h:${who.browser!.hash}:${cartFingerprint}`)
  const total = await quotedTotal(k, who)
  const request = k.post('session', { checkoutKey: k.newKey('off'), expectedTotalCents: total, ...k.cart() }, who)
  const waited = await stillPendingAfter(request, 1200)
  await held.release()
  assert.deepEqual({ waited, status: (await request).status }, { waited: false, status: 200 })
})

test('[P2-flag-shadow] shadow: the same answers, the same rows and the same calls to the provider as off; what WOULD have been decided is counted; no lock is added and no page is asked about or closed', async () => {
  const { ops: opsOff, rows: rowsOff, ...seenOff } = await threeScenarios()
  await k.fresh()
  setFlag('shadow')
  const heldBefore = counted('checkout_owner_guard_held_total')
  const recoveryBefore = counted('checkout_owner_guard_recovery_total')
  const shadowBefore = { order: counted('checkout_owner_guard_shadow_total', { stage: 'order', decision: 'hold' }), page: counted('checkout_owner_guard_shadow_total', { stage: 'page', decision: 'hold' }), create: counted('checkout_owner_guard_shadow_total', { stage: 'order', decision: 'create' }) }
  const { ops: opsShadow, rows: rowsShadow, ...seenShadow } = await threeScenarios()
  assert.deepEqual(seenShadow, seenOff, 'shadow answers exactly as off does')
  assert.deepEqual(seenShadow, OLD_WAY)
  assert.deepEqual(opsShadow, opsOff, 'shadow asks the provider exactly what off asks - nothing is read or closed for the guard')
  assert.deepEqual(rowsShadow, rowsOff, 'and leaves exactly the rows off leaves')
  // counted: D1 and A would have been held before an order was made; the stale tab would have been held before its page was given
  assert.ok(counted('checkout_owner_guard_shadow_total', { stage: 'order', decision: 'hold' }) - shadowBefore.order >= 2, 'the two holds before an order are counted')
  assert.ok(counted('checkout_owner_guard_shadow_total', { stage: 'page', decision: 'hold' }) - shadowBefore.page >= 1, 'the hold before a page is counted')
  assert.ok(counted('checkout_owner_guard_shadow_total', { stage: 'order', decision: 'create' }) - shadowBefore.create >= 3, 'and so are the first checkouts, which would have gone on')
  assert.equal(counted('checkout_owner_guard_held_total'), heldBefore, 'nothing was held')
  assert.equal(counted('checkout_owner_guard_recovery_total'), recoveryBefore, 'nothing was asked of, or closed at, the provider')
  // no lock is added in shadow
  await k.fresh()
  const probe = await k.startCheckout(k.newBrowser())
  const { cartFingerprint } = await storedFingerprints(k, probe.orderId)
  const who = k.newBrowser()
  const held = await holdLock(k.prisma, `checkout:owner:h:${who.browser!.hash}:${cartFingerprint}`)
  const total = await quotedTotal(k, who)
  const request = k.post('session', { checkoutKey: k.newKey('shadow'), expectedTotalCents: total, ...k.cart() }, who)
  const waited = await stillPendingAfter(request, 1200)
  await held.release()
  assert.deepEqual({ waited, status: (await request).status }, { waited: false, status: 200 })
})

test('[P2-flag-on] on: the same three scenarios are HELD - one order and one payable page each - and a hold is counted with its stage and cause', async () => {
  setFlag('on')
  const heldBefore = { order: counted('checkout_owner_guard_held_total', { stage: 'order', cause: 'sibling_page' }), page: counted('checkout_owner_guard_held_total', { stage: 'page', cause: 'sibling_page' }) }
  const { ops, rows, ...seen } = await threeScenarios()
  void ops; void rows
  // D1: 1 order, 1 page. A: the cancelled order + nothing new; its hidden page is closed at the provider AFTER the hold. Stale tab: 2 orders, the page of the second only.
  // The ONE page the checkout closed is the page of the order that can not be paid any more (A) - never the page of an order that can still be paid.
  assert.deepEqual(seen, { statuses: { d1Second: 409, aSecond: 409, second: 200, stale: 409 }, orders: 4, payablePages: 2, providerSessions: 4, oldPageStillOpen: 0, pagesClosedByTheCheckout: 1 })
  assert.ok(counted('checkout_owner_guard_held_total', { stage: 'order', cause: 'sibling_page' }) - heldBefore.order >= 2)
  assert.ok(counted('checkout_owner_guard_held_total', { stage: 'page', cause: 'sibling_page' }) - heldBefore.page >= 1)
})
