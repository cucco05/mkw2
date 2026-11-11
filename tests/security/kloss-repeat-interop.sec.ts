// R1-3 / KLOSS, P3 - the repeat gate beside what was there before it, with CHECKOUT_OWNER_GUARD=on and CHECKOUT_REPEAT_GUARD=on:
//   * R1-1b decides first: a key bound to an order this browser can not show to be its own is refused whatever the confirmation; the key of the paid order itself is a key of an order that can not be
//     paid any more (ORDER_NOT_PAYABLE), before any gate;
//   * D10 (an operator's reconciliation) is never asked the gate: it hands out no page, so it is not one of the doors;
//   * audit point D: a verified payment whose instant is not known (no `paidAt`, no trace on the page that carried it - a row as old or hand-made data can leave it) is treated as RECENT: the gate holds,
//     however old the order is; dated by its page when the page says when; never by the creation of the order; and a browser session alone is still told nothing;
//   * the writers of an order that run after it was accepted (the payment, its verification) keep its acceptance as it was.
// Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { reconcileAttempt } from '../../lib/checkout-reconcile'
import { accountWho, closeWithProof, quotedTotal, restoreMargin, setMargin, withAccessCookie } from './_kloss-kit'
import { assertProposal, bodyFor, bothOn, checkoutBlockOf, confirmed, paidPurchase, REPEAT_CODE, send, withRepeatOff } from './_repeat-kit'

let k: Kit
const MIN = 60_000
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k); bothOn() })
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.prisma.user.deleteMany({ where: { email: { endsWith: '@repeat.invalid' } } }); await k.sim.close() })

test('[P3-R1-1b] the purchase key decides first: a key bound to another browser\'s order is refused (the one refusal of R1-1b) whatever the confirmation; the key of the paid order is answered ORDER_NOT_PAYABLE', async () => {
  const owner = k.newBrowser()
  const theirs = await withRepeatOff(() => k.startCheckout(owner))
  const other = k.newBrowser()
  const paid = await paidPurchase(k, other)
  const holder = withAccessCookie(other, paid)
  const value = assertProposal(await send(k, holder, await bodyFor(k, holder)), 'the other browser has its own G')
  const refused = await send(k, holder, confirmed({ ...(await bodyFor(k, holder)), checkoutKey: theirs.key }, value))
  assert.deepEqual({ status: refused.status, code: refused.json?.code }, { status: 409, code: 'PURCHASE_KEY_IN_USE' }, JSON.stringify(refused.json))
  // the key of the paid order, sent again with a confirmation of the context of the moment
  const ownKey = await send(k, holder, confirmed({ ...(await bodyFor(k, holder)), checkoutKey: paid.key, expectedTotalCents: paid.total }, value))
  assert.deepEqual({ status: ownKey.status, code: ownKey.json?.code }, { status: 409, code: 'ORDER_NOT_PAYABLE' }, JSON.stringify(ownKey.json))
  // an account: the same for its paid order's key
  const who = accountWho(k)
  const accountPaid = await paidPurchase(k, who)
  const again = await k.payAgain(accountPaid, who)
  assert.deepEqual({ status: again.status, code: again.json?.code }, { status: 409, code: 'ORDER_NOT_PAYABLE' })
})

test('[P3-D10] an operator\'s reconciliation of an order beside a recent paid one is never asked the gate: it applies as it always did, and keeps nothing of a confirmation', async () => {
  const admin = await k.prisma.user.create({ data: { email: 'operator@repeat.invalid', passwordHash: 'x', name: 'operator', role: 'admin', isAdmin: true } })
  const who = accountWho(k)
  await paidPurchase(k, who)
  // an order of the same cart made with the gate off, whose page was made at the provider but its answer lost (and whose stored request is gone: the customer's path will not send it again)
  const blocked = await withRepeatOff(async () => {
    k.sim.faults.createLostAnswer = 1
    const first = await k.startCheckout(who, { allowFailure: true })
    assert.ok(first.status === 502 || first.status === 503, `premise: the answer was lost (${first.status})`)
    const order = await k.onlyOrder()
    const [reservation] = await k.attemptsOf(order.id)
    await k.prisma.paymentAttempt.update({ where: { id: reservation.id }, data: { requestHash: null } })
    const [session] = await k.sim.sessionsOf(order.id)
    return { orderId: order.id, attemptId: reservation.id, sessionId: session.id }
  })
  const before = await checkoutBlockOf(k, blocked.orderId)
  const r = await reconcileAttempt({ attemptId: blocked.attemptId, sessionId: blocked.sessionId, operatorId: admin.id, dryRun: false })
  assert.deepEqual({ outcome: r.outcome, endedAs: r.endedAs, after: r.after?.attempt.status }, { outcome: 'applied', endedAs: 'settled', after: 'open' }, r.message)
  assert.deepEqual(await checkoutBlockOf(k, blocked.orderId), before, 'nothing of a confirmation was kept by the reconciliation')
  // the customer's own request for that page meets the gate (the order exists, G is not empty): asked, the order named - the reconciliation did not stand in for the confirmation
  const customer = await send(k, who, await bodyFor(k, who))
  assert.equal(customer.json?.code, REPEAT_CODE, JSON.stringify(customer.json))
  assert.deepEqual({ pending: customer.json.pendingOrder, pendingOrderId: customer.json.pendingOrderId }, { pending: true, pendingOrderId: blocked.orderId })
})

test('[P3-D-paidAt] audit D: a verified payment with no paidAt is dated by the page that carried it; with no trace at all it is treated as RECENT - the gate holds however old the order is; the creation of the order dates nothing; a session alone is still told nothing', async () => {
  const who = accountWho(k)
  const paid = await paidPurchase(k, who)
  const carrier = (await k.attemptsOf(paid.orderId)).find((attempt) => attempt.status === 'paid')
  assert.ok(carrier, 'premise: the page that carried the payment')
  // the rows as a payment can leave them when its instant was not written (old or hand-made data): no paidAt, no completedAt - and the order made three hours ago
  const old = new Date(Date.now() - 180 * MIN)
  await k.prisma.printOrder.update({ where: { id: paid.orderId }, data: { paidAt: null, createdAt: old } })
  await k.prisma.paymentAttempt.update({ where: { id: carrier.id }, data: { completedAt: null } })
  assertProposal(await send(k, who, await bodyFor(k, who)), 'an instant nobody knows: recent - the gate holds')
  // the page says when: three hours ago - outside, however new the order looks
  await k.prisma.printOrder.update({ where: { id: paid.orderId }, data: { createdAt: new Date(Date.now() - 2 * MIN) } })
  await k.prisma.paymentAttempt.update({ where: { id: carrier.id }, data: { completedAt: old } })
  const outside = await send(k, who, await bodyFor(k, who))
  assert.equal(outside.status, 200, `dated by the page, not by the creation: ${JSON.stringify(outside.json)}`)
  // ...and ten minutes ago - inside, however old the order is
  await k.fresh(); bothOn()
  const paidAgain = await paidPurchase(k, who)
  const carrierAgain = (await k.attemptsOf(paidAgain.orderId)).find((attempt) => attempt.status === 'paid') as { id: string }
  await k.prisma.printOrder.update({ where: { id: paidAgain.orderId }, data: { paidAt: null, createdAt: old } })
  await k.prisma.paymentAttempt.update({ where: { id: carrierAgain.id }, data: { completedAt: new Date(Date.now() - 10 * MIN) } })
  assertProposal(await send(k, who, await bodyFor(k, who)), 'verified ten minutes ago')
  // a browser session alone, beside a payment whose instant nobody knows: nothing - no gate, no word of it
  await k.fresh(); bothOn()
  const browser = k.newBrowser()
  const guestPaid = await paidPurchase(k, browser)
  await k.prisma.printOrder.update({ where: { id: guestPaid.orderId }, data: { paidAt: null, createdAt: old } })
  const alone = await send(k, browser, await bodyFor(k, browser))
  assert.equal(alone.status, 200, JSON.stringify(alone.json))
  assert.equal(JSON.stringify(alone.json).includes(guestPaid.orderId), false)
  assertProposal(await send(k, withAccessCookie(browser, guestPaid), await bodyFor(k, withAccessCookie(browser, guestPaid))), 'the cookie of that order: the gate holds')
})

test('[P3-writers-keep] an order accepted after it existed is then paid: the payment sync and its verification rewrite its metadata and keep its acceptance and what it repeats exactly as they were', async () => {
  const browser = k.newBrowser()
  const older = await withRepeatOff(() => k.startCheckout(browser))
  await closeWithProof(k, older)
  await setMargin(k, 40)
  const later = await paidPurchase(k, withAccessCookie(browser, older))
  await restoreMargin(k)
  const holder = withAccessCookie(browser, later)
  assert.equal(await quotedTotal(k, holder), older.total)
  const body = await bodyFor(k, holder)
  const value = assertProposal(await send(k, holder, body), 'proposal')
  const continued = await send(k, holder, confirmed(body, value))
  assert.equal(continued.status, 200, JSON.stringify(continued.json))
  const accepted = await checkoutBlockOf(k, older.orderId)
  assert.ok(accepted.repeatAcceptance, 'premise: accepted')
  assert.equal((await k.customerPays(k.sessionIdOf(continued.json.url) as string)).paid, true)
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: older.orderId } })
  assert.equal(order.paymentStatus, 'paid', 'the payment sync verified the payment and rewrote the order')
  const after = await checkoutBlockOf(k, older.orderId)
  assert.deepEqual({ repeatOf: after.repeatOf, repeatAcceptance: after.repeatAcceptance, fingerprint: after.fingerprint, cartFingerprint: after.cartFingerprint }, { repeatOf: accepted.repeatOf, repeatAcceptance: accepted.repeatAcceptance, fingerprint: accepted.fingerprint, cartFingerprint: accepted.cartFingerprint })
})
