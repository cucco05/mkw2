// R1-3 / KLOSS, P3 - THE CONTRACT of the confirmation of a repeat purchase (docs/CHECKOUT-REPEAT-CONFIRMATION.md), with CHECKOUT_OWNER_GUARD=on and CHECKOUT_REPEAT_GUARD=on.
// The proposal and what it says; the confirmation bound to the CONTEXT it named - the paid orders G with their financial revisions, the cart, the amounts (total, items, shipping, tax, currency) -
// so that a price, a tax, a revision, a new payment or a member that leaves the window makes the old value worthless; a G of any size in one value; another cart; the holds of P2 always first; and
// nothing at all for a browser session alone or a lineage. Isolated PostgreSQL, the stand-in for Stripe, the real routes; nothing here calls Stripe, real or in Test Mode.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { ownerGuardHooks } from '../../lib/checkout-owner-guard'
import { updateOrderMetadata } from '../../lib/order-metadata'
import { accountWho, closeWithProof, descriptor, mentions, orderCount, otherSessionWithCookie, payableAcrossOrders, restoreMargin, rowsAsStored, setMargin, withAccessCookie } from './_kloss-kit'
import { assertProposal, bodyFor, bothOn, checkoutBlockOf, confirmed, keysOf, paidPurchase, REPEAT_CODE, send, startWithCart, withRepeatOff } from './_repeat-kit'

let k: Kit
const MIN = 60_000
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => {
  await k.fresh()
  await restoreMargin(k)
  bothOn()
  ownerGuardHooks.siblingLimit = null
  ownerGuardHooks.afterSiblingsRead = null
  checkoutOrderHooks.afterLock = null
  checkoutSessionHooks.afterLock = null
  checkoutSessionHooks.afterPlan = null
  checkoutSessionHooks.withoutFollowUp = false
  delete process.env.TAX_MODE
  delete process.env.TAX_RATE_PERCENT
})
test.after(async () => { delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT; await restoreMargin(k); await k.fresh(); await k.sim.close() })

test('[P3-contract-proposal] the proposal names the newest paid order, how many, the value of the context - and nothing else; it writes nothing; the same context gives the same value; the confirmation makes the order with its acceptance', async () => {
  const who = accountWho(k)
  const paid = await paidPurchase(k, who)
  const number = (await k.prisma.printOrder.findUniqueOrThrow({ where: { id: paid.orderId } })).orderNumber
  const body = await bodyFor(k, who)
  const rowsBefore = await rowsAsStored(k)
  const opsBefore = await k.opNames()
  const proposal = await send(k, who, body)
  const value = assertProposal(proposal, 'proposal')
  assert.equal(keysOf(proposal), 'code,error,orderId,orderNumber,repeatContext,repeatCount', 'nothing but the newest paid order, the count and the value')
  assert.deepEqual({ orderId: proposal.json.orderId, orderNumber: proposal.json.orderNumber, repeatCount: proposal.json.repeatCount }, { orderId: paid.orderId, orderNumber: number, repeatCount: 1 })
  assert.equal(await rowsAsStored(k), rowsBefore, 'a proposal writes nothing')
  assert.deepEqual(await k.opNames(), opsBefore, 'and asks the provider nothing')
  assert.equal((await send(k, who, { ...body, checkoutKey: k.newKey('again') })).json?.repeatContext, value, 'the same context is the same value, whatever the key')
  // the fields of a confirmation, malformed: refused before anything is read (400) - a value without `confirmRepeat`, a value of another shape, `confirmRepeat` that is not `true`
  for (const bad of [{ repeatContext: value }, { confirmRepeat: true, repeatContext: value.toUpperCase() }, { confirmRepeat: true, repeatContext: `${value}0` }, { confirmRepeat: false, repeatContext: value }, { confirmRepeat: 'yes' }]) {
    const refused = await send(k, who, { ...body, checkoutKey: k.newKey('bad'), ...bad })
    assert.deepEqual({ status: refused.status, code: refused.json?.code }, { status: 400, code: 'INVALID_REQUEST' }, JSON.stringify(bad))
  }
  assert.equal(await rowsAsStored(k), rowsBefore, 'and none of them wrote anything')
  const made = await send(k, who, confirmed(body, value))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  const block = await checkoutBlockOf(k, made.json.orderId)
  assert.deepEqual(block.repeatOf, [paid.orderId])
  assert.deepEqual({ ...block.repeatAcceptance, g: typeof block.repeatAcceptance.g, at: typeof block.repeatAcceptance.at }, { v: 1, g: 'string', n: 1, rev: 0, context: value, via: 'account', at: 'string' })
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: made.json.orderId } })).financialRevision, 0)
  assert.deepEqual({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions() }, { orders: 2, payablePages: 1, providerSessions: 2 })
  await k.assertClean('proposal')
})

test('[P3-price-changed] a price that changed after the proposal: the old confirmation does not authorise the checkout - PRICE_CHANGED, then a NEW proposal; the new value makes the order at the new total', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const oldValue = assertProposal(await send(k, who, body), 'proposal')
  await setMargin(k, 40)
  const stale = await send(k, who, confirmed(body, oldValue))
  assert.deepEqual({ status: stale.status, code: stale.json?.code, orders: await orderCount(k) }, { status: 409, code: 'PRICE_CHANGED', orders: 1 }, 'the total the customer confirmed is not the total: nothing is made')
  const newTotal = stale.json.currentTotalCents as number
  const repriced = { ...body, expectedTotalCents: newTotal }
  const asked = await send(k, who, confirmed(repriced, oldValue))
  const newValue = assertProposal(asked, 'the old value with the new total')
  assert.notEqual(newValue, oldValue)
  assert.equal(await orderCount(k), 1, 'nothing made by the old value')
  const made = await send(k, who, confirmed(repriced, newValue))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.equal(made.json.totalCents, newTotal)
})

test('[P3-tax-changed] the tax of the same total changed after the proposal (inclusive VAT, another rate): the old value confirms nothing - a new proposal; an exclusive VAT changes the total: PRICE_CHANGED', async () => {
  process.env.TAX_MODE = 'inclusive'
  process.env.TAX_RATE_PERCENT = '22'
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const oldValue = assertProposal(await send(k, who, body), 'proposal')
  process.env.TAX_RATE_PERCENT = '10'
  const sameTotal = await bodyFor(k, who, { key: body.checkoutKey })
  assert.equal(sameTotal.expectedTotalCents, body.expectedTotalCents, 'premise: an inclusive tax does not change the total')
  const asked = await send(k, who, confirmed(body, oldValue))
  const newValue = assertProposal(asked, 'the old value, another tax')
  assert.notEqual(newValue, oldValue, 'the tax is part of the context')
  assert.equal(await orderCount(k), 1)
  const made = await send(k, who, confirmed(body, newValue))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.equal(made.json.taxCents, Math.round((body.expectedTotalCents * 10) / 110), 'the order carries the tax the customer confirmed')
  process.env.TAX_MODE = 'exclusive'
  const exclusive = await send(k, who, confirmed({ ...body, checkoutKey: k.newKey('exclusive') }, newValue))
  assert.equal(exclusive.json?.code, 'PRICE_CHANGED', 'an exclusive tax changes the total: the price check comes first')
})

test('[P3-revision-changed] a member of G changes its money situation after the proposal (its financial revision goes up): the old value confirms nothing; the order a confirmation continued changes it: the acceptance holds no more', async () => {
  const who = accountWho(k)
  const paid = await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const oldValue = assertProposal(await send(k, who, body), 'proposal')
  const before = (await k.prisma.printOrder.findUniqueOrThrow({ where: { id: paid.orderId } })).financialRevision
  // a financial fact of the paid order changes through the writer production uses (lib/order-metadata.ts - E7, a Stripe proof): the revision goes up, the order stays paid and in G
  await updateOrderMetadata(paid.orderId, (current) => ({ metadata: { ...current, stripe: { ...((current.stripe as object) ?? {}), dispute: { status: 'won', at: new Date().toISOString() } } }, result: undefined }))
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: paid.orderId } })).financialRevision, before + 1, 'premise: the revision went up')
  const newValue = assertProposal(await send(k, who, confirmed(body, oldValue)), 'the old value')
  assert.notEqual(newValue, oldValue)
  const made = await send(k, who, confirmed(body, newValue))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  // the order made by the confirmation: its own revision moves (E10, a new entry of its payment review log) -> its acceptance holds no more: the next request for its page is asked again
  await updateOrderMetadata(made.json.orderId, (current) => ({ metadata: { ...current, paymentReview: [{ reason: 'checked', at: new Date().toISOString() }] }, result: undefined }))
  const retry = await send(k, who, body)
  const value = assertProposal(retry, 'the order changed after it was accepted')
  assert.equal(retry.json.pendingOrder, true, 'the order exists and waits for the confirmation')
  assert.equal(retry.json.pendingOrderId, made.json.orderId, 'named: the account proves it')
  const again = await send(k, who, confirmed(body, value))
  assert.deepEqual({ status: again.status, orderId: again.json?.orderId, url: again.json?.url }, { status: 200, orderId: made.json.orderId, url: made.json.url }, 'confirmed again: the same order, the same page')
})

test('[P3-new-payment] a payment of the same cart verified AFTER the first confirmation: the old value is worthless - a new proposal names two paid orders', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const made = await send(k, who, confirmed(body, value))
  assert.equal(made.status, 200)
  const session = k.sessionIdOf(made.json.url) as string
  assert.equal((await k.customerPays(session)).paid, true, 'the repeat purchase is paid')
  const third = await bodyFor(k, who)
  const asked = await send(k, who, confirmed(third, value))
  const newValue = assertProposal(asked, 'the value of before')
  assert.deepEqual({ repeatCount: asked.json.repeatCount, newest: asked.json.orderId, changed: newValue !== value }, { repeatCount: 2, newest: made.json.orderId, changed: true })
  assert.equal(await orderCount(k), 2, 'one confirmation, one payment: nothing more was made by it')
})

test('[P3-window] a member of G leaves the window after the proposal: the old value confirms nothing (exact comparison) and a new proposal names one; when G empties there is nothing to confirm', async () => {
  const who = accountWho(k)
  const older = await paidPurchase(k, who)
  await k.travel(30 * MIN)
  const newer = await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const asked = await send(k, who, body)
  const value = assertProposal(asked, 'G of two')
  assert.equal(asked.json.repeatCount, 2)
  await k.travel(31 * MIN)                                        // the older payment is 61 minutes old now, the newer 31
  const narrowed = await send(k, who, confirmed(body, value))
  const newValue = assertProposal(narrowed, 'a member left')
  assert.deepEqual({ repeatCount: narrowed.json.repeatCount, newest: narrowed.json.orderId }, { repeatCount: 1, newest: newer.orderId })
  const made = await send(k, who, confirmed(body, newValue))
  assert.equal(made.status, 200)
  assert.deepEqual((await checkoutBlockOf(k, made.json.orderId)).repeatOf, [newer.orderId], `the payment of an hour ago (${older.orderId}) is not what this purchase repeats`)
  // G empties: nothing to confirm, the confirmation sent is ignored and nothing of it is kept
  await k.fresh()
  bothOn()
  await paidPurchase(k, who)
  const lone = await bodyFor(k, who)
  const loneValue = assertProposal(await send(k, who, lone), 'G of one')
  await k.travel(61 * MIN)
  const free = await send(k, who, confirmed(lone, loneValue))
  assert.equal(free.status, 200, JSON.stringify(free.json))
  const block = await checkoutBlockOf(k, free.json.orderId)
  assert.deepEqual({ repeatOf: block.repeatOf ?? null, repeatAcceptance: block.repeatAcceptance ?? null }, { repeatOf: null, repeatAcceptance: null })
})

test('[P3-more-than-20] twenty-one purchases of the cart paid within the hour: ONE value confirms them all - the customer is never unable to confirm because G is large', async () => {
  const who = accountWho(k)
  const paid: string[] = []
  for (let index = 0; index < 21; index += 1) paid.push((await paidPurchase(k, who)).orderId)
  const body = await bodyFor(k, who)
  const asked = await send(k, who, body)
  const value = assertProposal(asked, 'G of twenty-one')
  assert.deepEqual({ repeatCount: asked.json.repeatCount, newest: asked.json.orderId, keys: keysOf(asked) }, { repeatCount: 21, newest: paid[20], keys: 'code,error,orderId,orderNumber,repeatContext,repeatCount' })
  const made = await send(k, who, confirmed(body, value))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.deepEqual([...(await checkoutBlockOf(k, made.json.orderId)).repeatOf].sort(), [...paid].sort())
})

test('[P3-other-cart] the value of one cart confirms nothing of another: a cart with its own recent payment is asked about itself; a cart never bought is made as a first purchase, nothing of the confirmation kept', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const first = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, first), 'the first cart')
  const otherCart = k.cart({ items: [{ modelId: k.modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }] })
  await paidPurchase(k, who, otherCart)
  const other = await bodyFor(k, who, { cart: otherCart })
  const asked = await send(k, who, confirmed(other, value))
  const otherValue = assertProposal(asked, 'another cart with its own payment')
  assert.notEqual(otherValue, value)
  const neverBought = k.cart({ items: [{ modelId: k.modelId, qty: 4, colors: ['#ffffff'], material: 'PLA' }] })
  const fresh = await send(k, who, confirmed(await bodyFor(k, who, { cart: neverBought }), value))
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json))
  const block = await checkoutBlockOf(k, fresh.json.orderId)
  assert.deepEqual({ repeatOf: block.repeatOf ?? null, repeatAcceptance: block.repeatAcceptance ?? null }, { repeatOf: null, repeatAcceptance: null })
})

test('[P3-holds-first] a valid confirmation never passes a hold of P2: a payment in doubt, the hidden page of a paid order, a live page of a sibling, a list that was cut - each answers PAYMENT_IN_PROGRESS', async () => {
  const who = accountWho(k)
  // (a) a payment in doubt: the confirmed repeat purchase is being confirmed at the provider
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const made = await send(k, who, confirmed(body, value))
  assert.equal(made.status, 200)
  assert.equal((await k.customerPays(k.sessionIdOf(made.json.url) as string, { piStatus: 'processing' })).paid, true, 'premise: the page was completed, the payment is being confirmed')
  const doubt = await send(k, who, confirmed(await bodyFor(k, who), value))
  assert.equal(doubt.json?.code, 'PAYMENT_IN_PROGRESS', JSON.stringify(doubt.json))
  // (b) the hidden page of the paid order
  await k.fresh(); bothOn()
  const paid = await paidPurchase(k, who)
  const b = await bodyFor(k, who)
  const bValue = assertProposal(await send(k, who, b), 'proposal')
  await k.addLegacyTwin(paid.orderId)
  assert.equal((await send(k, who, confirmed(b, bValue))).json?.code, 'PAYMENT_IN_PROGRESS')
  // (c) a sibling with a live page (another total: not the order to continue)
  await k.fresh(); bothOn()
  await paidPurchase(k, who)
  const c = await bodyFor(k, who)
  const cValue = assertProposal(await send(k, who, c), 'proposal')
  assert.equal((await send(k, who, confirmed(c, cValue))).status, 200, 'the repeat purchase has its page')
  await setMargin(k, 40)
  const repriced = await bodyFor(k, who)
  assert.equal((await send(k, who, confirmed(repriced, cValue))).json?.code, 'PAYMENT_IN_PROGRESS', 'another page may be paid')
  await restoreMargin(k)
  // (d) a list that was cut
  await k.fresh(); bothOn()
  await paidPurchase(k, who)
  const d = await bodyFor(k, who)
  const dValue = assertProposal(await send(k, who, d), 'proposal')
  ownerGuardHooks.siblingLimit = 0
  assert.equal((await send(k, who, confirmed(d, dValue))).json?.code, 'PAYMENT_IN_PROGRESS')
  ownerGuardHooks.siblingLimit = null
})

test('[P3-privacy] a browser session alone and a lineage are told nothing and asked nothing - with no value, a valid one, a wrong one; nothing of a confirmation is ever kept for them', async () => {
  const browser = k.newBrowser()
  const paid = await paidPurchase(k, browser)
  const holder = withAccessCookie(browser, paid)
  const value = assertProposal(await send(k, holder, await bodyFor(k, holder)), 'the access cookie proves the paid order')
  const newcomer = await k.startCheckout(k.newBrowser())
  const tries = [
    await send(k, browser, await bodyFor(k, browser)),
    await send(k, browser, confirmed(await bodyFor(k, browser), value)),
    await send(k, browser, confirmed(await bodyFor(k, browser), `rc1_${'1'.repeat(64)}`)),
  ]
  for (const [index, answer] of tries.entries()) {
    assert.equal(answer.status, 200, `session alone #${index}: ${JSON.stringify(answer.json)}`)
    assert.equal(descriptor(answer), descriptor(newcomer), `session alone #${index}: answered as a first purchase`)
    assert.deepEqual(mentions(answer, paid.orderId, String(paid.json.orderNumber)), [], `session alone #${index}: no word of the paid order`)
    const block = await checkoutBlockOf(k, answer.json.orderId)
    assert.deepEqual({ repeatOf: block.repeatOf ?? null, repeatAcceptance: block.repeatAcceptance ?? null }, { repeatOf: null, repeatAcceptance: null }, `session alone #${index}: nothing kept`)
  }
  // a lineage: another session with the access cookie of an unpaid order of the same browser - the paid order carries that browser's session, which the lineage only "knows"
  await k.fresh(); bothOn()
  const first = k.newBrowser()
  const unpaid = await withRepeatOff(() => k.startCheckout(first))
  await closeWithProof(k, unpaid)
  await setMargin(k, 40)
  const paidToo = await paidPurchase(k, first)
  await restoreMargin(k)
  const lineage = otherSessionWithCookie(k, unpaid)
  const viaLineage = await send(k, lineage, confirmed(await bodyFor(k, lineage), value))
  assert.equal(viaLineage.status, 200, JSON.stringify(viaLineage.json))
  assert.notEqual(viaLineage.json?.code, REPEAT_CODE)
  assert.deepEqual(mentions(viaLineage, paidToo.orderId, String(paidToo.json.orderNumber)), [], 'a lineage is told nothing of the paid order')
  const block = await checkoutBlockOf(k, viaLineage.json.orderId)
  assert.deepEqual({ repeatOf: block.repeatOf ?? null, repeatAcceptance: block.repeatAcceptance ?? null }, { repeatOf: null, repeatAcceptance: null })
})

test('[P3-guest-cookie] a guest with the access cookie of the paid order: the same contract as an account - the order named, the confirmation made into an order with its acceptance (via access)', async () => {
  const browser = k.newBrowser()
  const paid = await paidPurchase(k, browser)
  const holder = withAccessCookie(browser, paid)
  const body = await bodyFor(k, holder)
  const keysBefore = await k.prisma.guestPurchaseKey.count()
  const asked = await send(k, holder, body)
  const value = assertProposal(asked, 'guest with the cookie')
  assert.equal(asked.json.orderId, paid.orderId)
  assert.equal(await k.prisma.guestPurchaseKey.count(), keysBefore, 'the proposal bound no key')
  const made = await send(k, holder, confirmed(body, value))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.equal((await checkoutBlockOf(k, made.json.orderId)).repeatAcceptance.via, 'access')
  assert.equal(await k.prisma.guestPurchaseKey.count(), keysBefore + 1, 'the key of the confirmed purchase is bound to its order, in the transaction that made it')
  const started = await startWithCart(k, holder, k.cart({ items: [{ modelId: k.modelId, qty: 5, colors: ['#ffffff'], material: 'PLA' }] }))
  assert.equal(started.status, 200, 'another cart is another purchase')
})
