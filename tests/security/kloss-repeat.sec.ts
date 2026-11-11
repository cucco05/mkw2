// R1-3 / KLOSS - the proofs of the purchase made again after a paid one (D3) that P3 turned GREEN, now ordinary tests of the security suite (they were tests/red/kloss/window-and-repeat.red.ts until P3;
// the ids in the titles and every assertion are the ones written RED - tests/kloss-red-separation.test.ts pins the expected values - and tests/red/kloss/RED-LEDGER.md keeps the history of each).
// They run with CHECKOUT_OWNER_GUARD=on AND CHECKOUT_REPEAT_GUARD=on: both are OFF by default, and with either off these same scenarios still end the old way. The one proof still RED of this family is
// tests/red/kloss/identity-change.red.ts (KL-E2-login, the limit E2). Isolated PostgreSQL, the stand-in for Stripe, the real routes; nothing here calls Stripe, real or in Test Mode.
//
// P3, PLAN REV2 (approved): the confirmation is bound to the CONTEXT the server proposed (the paid orders G with their financial revisions, the cart, the amounts, the order the page is for), not to a
// boolean. So `KL-D3-confirm` first sends the request without a confirmation - it receives the proposal and its `repeatContext` - and then the same request with `confirmRepeat: true` and that value; its
// assertion and the values the guard pins are those of P0. `KL-D3-confirm-incomplete` proves the boolean alone, or a value that is not the context, makes nothing. `KL-D3-stale-order` and
// `KL-D3-older-reuse` prove the same purchase made again through an ORDER THAT ALREADY EXISTS - by its own key, or as the order to continue - which the three proofs of P0 do not reach.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { accountWho, closeWithProof, orderCount, payableAcrossOrders, quotedTotal, restoreMargin, setMargin, withAccessCookie } from './_kloss-kit'

process.env.CHECKOUT_OWNER_GUARD = 'on'
process.env.CHECKOUT_REPEAT_GUARD = 'on'

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

test('[KL-D3-account] D3 (account): paid a few minutes ago, a new key, the same cart -> a confirmation is asked, nothing is made (was RED until P3: a new order and page are made in silence)', async () => {
  const who = accountWho(k)
  await paidOnce(who)
  const second = await k.startCheckout(who, { allowFailure: true })
  const seen = { status: second.status, code: second.json?.code ?? null, orders: await orderCount(k), providerSessions: await k.sim.createdSessions() }
  assert.deepEqual(seen, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', orders: 1, providerSessions: 1 },
    'CAUSE: "a paid order does not swallow the next one" (cart-after-payment.sec.ts:144, guest-session.sec.ts:491): a paid purchase is not looked at when a new order is made, so the voluntary repeat and the involuntary one cannot be told apart')
})

test('[KL-D3-cookie] D3 (guest with the access cookie of the paid order): same as the account -> a confirmation is asked (was RED until P3)', async () => {
  const browser = k.newBrowser()
  const first = await paidOnce(browser)
  const second = await k.startCheckout(withAccessCookie(browser, first), { allowFailure: true })
  const seen = { status: second.status, code: second.json?.code ?? null, named: second.json?.orderId ?? null, orders: await orderCount(k), providerSessions: await k.sim.createdSessions() }
  assert.deepEqual(seen, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', named: first.orderId, orders: 1, providerSessions: 1 },
    'CAUSE: as for the account; and the paid order is one this requester can already read through the status page (access cookie), so naming it adds nothing to what it can know')
})

test('[KL-D3-confirm] D3 (confirmation given): the server names the context it asks to confirm; sent back with the confirmation, the new order is made and remembers which order it repeats (was RED until P3: no proposal is made and the field is refused by the strict schema)', async () => {
  const who = accountWho(k)
  const first = await paidOnce(who)
  const total = (await k.post('quote', k.cart(), who)).json.totalCents as number
  const body = { checkoutKey: k.newKey('repeat'), expectedTotalCents: total, ...k.cart() }
  // (P3) the request without a confirmation receives the proposal; the same request, confirmed, sends its `repeatContext` back
  const proposal = await k.post('session', body, who)
  const confirmed = await k.post('session', { ...body, confirmRepeat: true, repeatContext: proposal.json?.repeatContext }, who)
  const repeated = confirmed.json?.orderId ? await k.prisma.printOrder.findUnique({ where: { id: confirmed.json.orderId } }) : null
  const seen = { status: confirmed.status, repeatOf: ((repeated?.metadata as any)?.checkout?.repeatOf as string[] | undefined) ?? null }
  assert.deepEqual(seen, { status: 200, repeatOf: [first.orderId] },
    'CAUSE: no proposal names a context today (the first request makes an order), and the body of POST /api/checkout/session is `.strict()` and knows no `confirmRepeat` (app/api/checkout/session/route.ts:56-63): the field is answered 400 INVALID_REQUEST')
})

test('[KL-D3-confirm-incomplete] D3 (a confirmation that does not name the proposed context): the boolean alone, or a value that is not the context, makes nothing - it is answered with the proposal (was RED until P3: the field is refused by the strict schema)', async () => {
  const who = accountWho(k)
  await paidOnce(who)
  const total = await quotedTotal(k, who)
  const body = { expectedTotalCents: total, ...k.cart() }
  const alone = await k.post('session', { ...body, checkoutKey: k.newKey('alone'), confirmRepeat: true }, who)
  const wrong = await k.post('session', { ...body, checkoutKey: k.newKey('wrong'), confirmRepeat: true, repeatContext: `rc1_${'0'.repeat(64)}` }, who)
  const answers = [alone, wrong].map((answer) => ({ status: answer.status, code: answer.json?.code ?? null }))
  assert.deepEqual({ answers, orders: await orderCount(k), providerSessions: await k.sim.createdSessions() },
    { answers: [{ status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED' }, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED' }], orders: 1, providerSessions: 1 },
    'CAUSE: the body of POST /api/checkout/session is `.strict()` and knows no `confirmRepeat` / `repeatContext` (route.ts:56-63): the request is answered 400 INVALID_REQUEST, so a confirmation that names nothing is not even told apart from one that names the context')
})

// ====================================================================================================================================================================
// D3 through an order that ALREADY EXISTS: its own key (a stale tab), or the order to continue (a new key, the same total) - the page, not the order, is what would be paid twice
// ====================================================================================================================================================================
test('[KL-D3-stale-order] D3 at the page (an older order of the same cart, by its own key): after a later order was paid, the stale tab of the older order asks for its page -> a confirmation is asked, no page is made (was RED until P3: a new payable page is made in silence)', async () => {
  const who = accountWho(k)
  const older = await k.startCheckout(who)
  await closeWithProof(k, older)                                  // its page closed AT THE PROVIDER, with the proof on the row: the order is unpaid and may be given a page again
  await setMargin(k, 40)                                          // (another total: the next checkout is another order, not the older one continued)
  const later = await k.startCheckout(who)
  await restoreMargin(k)
  assert.notEqual(later.orderId, older.orderId, 'premise: two orders of the same cart')
  assert.equal((await k.customerPays(later.sessionId)).paid, true, 'premise: the later order was paid')
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: later.orderId } })).paymentStatus, 'paid', 'premise: the payment is verified')
  const before = await k.sim.createdSessions()
  const stale = await k.payAgain(older)                           // the tab of the older order: its key, its total
  const seen = { status: stale.status, code: stale.json?.code ?? null, payablePages: (await payableAcrossOrders(k)).length, newSessions: (await k.sim.createdSessions()) - before }
  assert.deepEqual(seen, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', payablePages: 0, newSessions: 0 },
    'CAUSE: an order found by its own key goes straight to its page (route.ts:162-173, then openCheckoutSession): nothing asks whether the same cart was paid a moment ago through ANOTHER order, so the customer is handed a page to pay it a second time')
})

test('[KL-D3-older-reuse] D3 at the order to continue (a new key, the total of an older unpaid order): after a later order was paid, the older order is continued -> a confirmation is asked, no page is made and the new key is bound to nothing (was RED until P3: the older order is continued and given a page in silence)', async () => {
  const browser = k.newBrowser()
  const older = await k.startCheckout(browser)
  await closeWithProof(k, older)
  await setMargin(k, 40)
  const later = await k.startCheckout(withAccessCookie(browser, older))   // the access cookie of the answer opens BOTH orders
  await restoreMargin(k)
  assert.equal((await k.customerPays(later.sessionId)).paid, true, 'premise: the later order was paid')
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: later.orderId } })).paymentStatus, 'paid', 'premise: the payment is verified')
  const holder = withAccessCookie(browser, later)
  const total = await quotedTotal(k, holder)
  assert.equal(total, older.total, 'premise: the cart costs again what it cost when the older order was made')
  const keysBefore = await k.prisma.guestPurchaseKey.count()
  const sessionsBefore = await k.sim.createdSessions()
  const again = await k.post('session', { checkoutKey: k.newKey('older'), expectedTotalCents: total, ...k.cart() }, holder)
  const seen = {
    status: again.status, code: again.json?.code ?? null, payablePages: (await payableAcrossOrders(k)).length,
    newSessions: (await k.sim.createdSessions()) - sessionsBefore, newKeyBound: (await k.prisma.guestPurchaseKey.count()) - keysBefore,
  }
  assert.deepEqual(seen, { status: 409, code: 'PURCHASE_REPEAT_CONFIRMATION_REQUIRED', payablePages: 0, newSessions: 0, newKeyBound: 0 },
    'CAUSE: the order to continue is chosen before anything looks at the paid orders of the cart (lib/checkout-orders.ts, the duplicate search / planOwnerIntent "reuse" comes before the repeat gate): the new key is bound to the older order and a page is opened for it')
})
