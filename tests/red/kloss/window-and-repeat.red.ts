// R1-3 / KLOSS - P0 RED proofs, part 2: the window of "the same purchase" (D2) and the purchase made again after a paid one (D3).
// RED on purpose, kept out of the ordinary suites (see cross-order.red.ts for how they are run and what the ledger holds).
import '../../security/_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, SESSION_TTL_MS, type Kit } from '../../security/_dr13-kit'
import { checkoutOrderHooks } from '../../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../../lib/checkout-sessions'
import { accountWho, orderCount, payableAcrossOrders, restoreMargin, withAccessCookie } from '../../security/_kloss-kit'

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
test('[KL-D2-window] D2: an order older than 60 minutes whose page is still alive, the key lost -> the same order and the same page (RED: a second order is made)', async () => {
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

// ====================================================================================================================================================================
// D3 - the first purchase is paid; a new checkout of the same cart with a new key
// ====================================================================================================================================================================
async function paidOnce(who: ReturnType<Kit['newBrowser']>) {
  const first = await k.startCheckout(who)
  const payment = await k.customerPays(first.sessionId)
  assert.equal(payment.paid, true, 'premise: the page was paid')
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: first.orderId } })
  assert.equal(order.paymentStatus, 'paid', 'premise: the payment is verified')
  return first
}

test('[KL-D3-account] D3 (account): paid a few minutes ago, a new key, the same cart -> a confirmation is asked, nothing is made (RED: a new order and page are made in silence)', async () => {
  const who = accountWho(k)
  await paidOnce(who)
  const second = await k.startCheckout(who, { allowFailure: true })
  const seen = { status: second.status, code: second.json?.code ?? null, orders: await orderCount(k), providerSessions: await k.sim.createdSessions() }
  assert.deepEqual(seen, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', orders: 1, providerSessions: 1 },
    'CAUSE: "a paid order does not swallow the next one" (cart-after-payment.sec.ts:144, guest-session.sec.ts:491): a paid purchase is not looked at when a new order is made, so the voluntary repeat and the involuntary one cannot be told apart')
})

test('[KL-D3-cookie] D3 (guest with the access cookie of the paid order): same as the account -> a confirmation is asked (RED)', async () => {
  const browser = k.newBrowser()
  const first = await paidOnce(browser)
  const second = await k.startCheckout(withAccessCookie(browser, first), { allowFailure: true })
  const seen = { status: second.status, code: second.json?.code ?? null, named: second.json?.orderId ?? null, orders: await orderCount(k), providerSessions: await k.sim.createdSessions() }
  assert.deepEqual(seen, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', named: first.orderId, orders: 1, providerSessions: 1 },
    'CAUSE: as for the account; and the paid order is one this requester can already read through the status page (access cookie), so naming it adds nothing to what it can know')
})

test('[KL-D3-confirm] D3 (confirmation given): the flag is accepted, the new order is made and remembers which order it repeats (RED: the field is refused by the strict schema)', async () => {
  const who = accountWho(k)
  const first = await paidOnce(who)
  const total = (await k.post('quote', k.cart(), who)).json.totalCents as number
  const confirmed = await k.post('session', { checkoutKey: k.newKey('repeat'), expectedTotalCents: total, ...k.cart(), confirmRepeat: true }, who)
  const repeated = confirmed.json?.orderId ? await k.prisma.printOrder.findUnique({ where: { id: confirmed.json.orderId } }) : null
  const seen = { status: confirmed.status, repeatOf: ((repeated?.metadata as any)?.checkout?.repeatOf as string[] | undefined) ?? null }
  assert.deepEqual(seen, { status: 200, repeatOf: [first.orderId] },
    'CAUSE: the body of POST /api/checkout/session is `.strict()` and knows no `confirmRepeat` (app/api/checkout/session/route.ts:55-62): the field is answered 400 INVALID_REQUEST')
})
