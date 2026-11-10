// R1-3 / KLOSS - the P0 proof of D2 (the window of "the same purchase" follows the life of the page, not the age of the order), which P2 turned GREEN: an ordinary test of the security suite now.
// It was in tests/red/kloss/window-and-repeat.red.ts until P2; its id and its assertion are the ones of P0, unchanged (tests/kloss-red-separation.test.ts pins the expected value).
// It runs with CHECKOUT_OWNER_GUARD=on (the guard is OFF by default). Isolated PostgreSQL, the stand-in for Stripe, the real routes; nothing here calls Stripe, real or in Test Mode.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, SESSION_TTL_MS, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { orderCount, payableAcrossOrders, restoreMargin } from './_kloss-kit'

process.env.CHECKOUT_OWNER_GUARD = 'on'

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

const MIN = 60_000

// ====================================================================================================================================================================
// D2 - the order is more than an hour old but its page is alive
// ====================================================================================================================================================================
test('[KL-D2-window] D2: an order older than 60 minutes whose page is still alive, the key lost -> the same order and the same page (was RED until P2: a second order is made)', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  // in the last minute of its life the page is renewed for the SAME order (DR-13): the new page lives until minute ~63.5
  await k.travel(SESSION_TTL_MS - 30_000)
  const renewed = await k.payAgain(first)
  assert.equal(renewed.status, 200, renewed.text)
  assert.equal((await k.sim.payable(first.orderId)).length, 1, 'premise: the renewed page is payable')
  // minute 61: the order is older than the window of one hour, its page is alive; the key is lost (a new one is sent)
  await k.travel(61 * MIN - (SESSION_TTL_MS - 30_000))
  const lostKey = await k.startCheckout(who, { allowFailure: true })
  const seen = { status: lostKey.status, sameOrder: lostKey.orderId === first.orderId, orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length }
  assert.deepEqual(seen, { status: 200, sameOrder: true, orders: 1, payablePages: 1 },
    'CAUSE: the window of recognition is "created less than an hour ago" (DUPLICATE_ORDER_WINDOW_MS, lib/checkout-orders.ts:257,464,503), measured from the creation of the ORDER and not from the life of its page')
})
