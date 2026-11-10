// R1-3 / KLOSS - P0 CONTROLS: what the checkout already does right, and the one limit the plan does not close. GREEN today, GREEN after every later phase.
//
// The RED proofs of the defects live apart (tests/red/kloss/, run on demand with `npm run test:kloss-red`). What is here must never turn red:
//   C   a terminal order whose pages are ALL provably closed does not hold a new purchase back, and nothing is asked of the provider for it
//   D2c an order older than the window with nothing alive is a new purchase when asked again
//   D3c a requester that proves only its session is told NOTHING more after a paid purchase (no gate, an answer identical to a first purchase); an account outside the window, and any other
//       customer, are never gated
//   F   two guests that are really independent never hold each other back, whatever state the other's order is in, and are told nothing about it
//   G   a cookie that is expired, forged or the token of another order extends nothing: the answer is the one of a request with no cookie, and no link is written
//   E2  THE LIMIT, not closed by P2 (written down so that closing it - only possible by persisting the link, plan REV3 §2.10 - has to update this test): the same browser, a session that
//       changed, an earlier request that proved MORE than the later one: the later request cannot prove the earlier one's order, and two payable pages exist
//   LK  the locks the checkout takes today keep being taken (the plan adds names, it renames none)
// Isolated PostgreSQL, the stand-in for Stripe, the real routes. No Stripe call, real or in Test Mode.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { purchaseKeyFor, purchaseKeyLockName } from '../../lib/purchase-intent'
import {
  accountWho, cancelLikeTheOldCode, closeWithProof, descriptor, holdLock, mentions, orderCount, otherSessionWithCookie, payableAcrossOrders, quotedTotal, restoreMargin, rowsAsStored,
  stillPendingAfter, storedFingerprints, withAccessCookie,
} from './_kloss-kit'

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
async function opsOn(sessionId: string, from: number) {
  return (await k.sim.oplog()).filter((op) => op.seq > from && JSON.stringify(op.detail ?? {}).includes(sessionId))
}
const lastSeq = async () => (await k.sim.oplog()).reduce((max, op) => Math.max(max, op.seq), 0)

// ====================================================================================================================================================================
// C - a terminal order with every page provably closed holds nothing back, and costs the provider nothing
// ====================================================================================================================================================================
test('[KL-C-paid] C (paid): the payment is verified and the paying page is the only one -> a new purchase of the same cart is made, and the provider is not asked about the old page', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  assert.equal((await k.customerPays(first.sessionId)).paid, true)
  const mark = await lastSeq()
  const second = await k.startCheckout(who)
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.notEqual(second.orderId, first.orderId)
  assert.deepEqual(await opsOn(first.sessionId, mark), [], 'nothing was read from, or closed at, the provider for the old page')
  assert.equal((await payableAcrossOrders(k)).length, 1, 'only the new page is payable')
  await k.assertClean('C paid')
})

test('[KL-C-cancelled] C (cancelled): the order is cancelled and its page was closed AT THE PROVIDER with the proof on the row -> a new purchase is made, and the provider is not asked again', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  await closeWithProof(k, first)
  await k.prisma.printOrder.update({ where: { id: first.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  const mark = await lastSeq()
  const second = await k.startCheckout(who)
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.notEqual(second.orderId, first.orderId)
  assert.deepEqual(await opsOn(first.sessionId, mark), [], 'the proof is on the row: nothing is asked of the provider')
  assert.equal((await payableAcrossOrders(k)).length, 1)
  await k.assertClean('C cancelled')
})

// ====================================================================================================================================================================
// D2c / D3c
// ====================================================================================================================================================================
test('[KL-D2-ctrl] D2 control: an order older than the window with nothing alive is a new purchase when asked again', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  await closeWithProof(k, first)
  await k.travel(61 * MIN)
  const again = await k.startCheckout(who)
  assert.equal(again.status, 200, JSON.stringify(again.json))
  assert.notEqual(again.orderId, first.orderId, 'a new order: the old one has no page and is older than the window')
  assert.equal((await payableAcrossOrders(k)).length, 1)
})

test('[KL-D3-ctrl-session] D3 control: a requester that proves only its SESSION is told nothing after a paid purchase - the answer is that of a first purchase', async () => {
  const buyer = k.newBrowser()
  const first = await k.startCheckout(buyer)
  assert.equal((await k.customerPays(first.sessionId)).paid, true)
  const again = await k.startCheckout(buyer)                    // the same session, no access cookie: the only proof is the session
  const newcomer = await k.startCheckout(k.newBrowser())        // a browser that never bought
  assert.equal(again.status, 200, JSON.stringify(again.json))
  assert.equal(descriptor(again), descriptor(newcomer), 'the same status, the same code, the same shape: nothing says that a paid purchase exists')
  assert.deepEqual(mentions(again, first.orderId, String(first.json.orderNumber)), [], 'and no word of the earlier order')
})

test('[KL-D3-ctrl-account] D3 control: an account outside the window, and a different customer at any time, are not asked to confirm anything', async () => {
  const account = accountWho(k)
  const first = await k.startCheckout(account)
  assert.equal((await k.customerPays(first.sessionId)).paid, true)
  const other = await k.prisma.user.create({ data: { email: 'kloss-other@sectest.invalid', passwordHash: 'x', name: 'kloss-other', role: 'customer' } })
  const stranger = await k.startCheckout({ viewer: { id: other.id, role: 'customer' } })
  assert.equal(stranger.status, 200, 'another customer buying the same things is never held back by this one\'s purchase')
  await k.travel(25 * k.HOUR)
  const later = await k.startCheckout(account)
  assert.equal(later.status, 200, 'a day later the same customer buys the same cart again without being asked')
  assert.notEqual(later.orderId, first.orderId)
})

// ====================================================================================================================================================================
// F - two independent guests, the same cart
// ====================================================================================================================================================================
const states: Array<{ name: string; prepare: (who: ReturnType<Kit['newBrowser']>, first: Awaited<ReturnType<Kit['startCheckout']>>) => Promise<void> }> = [
  { name: 'a live payment page', prepare: async () => {} },
  { name: 'a paid purchase', prepare: async (_who, first) => { assert.equal((await k.customerPays(first.sessionId)).paid, true) } },
  { name: 'a payment that waits for a person', prepare: async (_who, first) => { await k.prisma.printOrder.update({ where: { id: first.orderId }, data: { paymentStatus: 'paid', status: 'awaiting_review', paymentReviewReason: 'amount_mismatch', paidAt: new Date() } }) } },
  { name: 'a cancelled order whose page nobody proved closed', prepare: async (_who, first) => { await cancelLikeTheOldCode(k, first, null) } },
]
for (const state of states) {
  test(`[KL-F-independent] F: another guest holds ${state.name} for the same cart -> this guest is not held back, not gated, and told nothing about it`, async () => {
    const other = k.newBrowser()
    const theirs = await k.startCheckout(other)
    await state.prepare(other, theirs)
    const theirRows = await rowsAsStored(k)
    const mine = await k.startCheckout(k.newBrowser(), { allowFailure: true })
    assert.equal(mine.status, 200, JSON.stringify(mine.json))
    assert.notEqual(mine.orderId, theirs.orderId)
    assert.deepEqual(mentions(mine, theirs.orderId, String(theirs.json.orderNumber)), [], 'nothing of the other guest\'s order')
    assert.equal(descriptor(mine), descriptor(theirs), 'the answer of a first purchase')
    const after = JSON.parse(await rowsAsStored(k)).filter((order: any) => order.id === theirs.orderId)
    assert.equal(JSON.stringify(after), JSON.stringify(JSON.parse(theirRows).filter((order: any) => order.id === theirs.orderId)), 'the other guest\'s order was not touched')
  })
}

// ====================================================================================================================================================================
// G - cookies that prove nothing
// ====================================================================================================================================================================
test('[KL-G-invalid-cookies] G: an expired, a forged and a swapped access cookie extend nothing: each is answered like a request with no cookie, and no link to the earlier order is written', async () => {
  const h1 = k.newBrowser()
  const first = await k.startCheckout(h1)
  const stranger = await k.startCheckout(k.newBrowser())
  const cookieOf = (started: typeof first) => (started.accessCookie ?? '').split('=')[1] ?? ''
  const [firstId, firstToken] = cookieOf(first).split('.')
  const [, strangerToken] = cookieOf(stranger).split('.')
  const variants: Array<{ name: string; cookie: string | undefined }> = [
    { name: 'no cookie', cookie: undefined },
    { name: 'a forged token', cookie: `mw_checkout=${firstId}.${firstToken.slice(0, -2)}xx` },
    { name: 'the token of another order under this order id', cookie: `mw_checkout=${firstId}.${strangerToken}` },
    { name: 'garbage', cookie: 'mw_checkout=not-a-cookie' },
  ]
  const answers = [] as Array<{ name: string; answer: Awaited<ReturnType<Kit['startCheckout']>> }>
  for (const variant of variants) {
    const answer = await k.startCheckout({ ...k.newBrowser(), cookie: variant.cookie }, { allowFailure: true })
    answers.push({ name: variant.name, answer })
  }
  // the cookie of the order is valid but its access has run out: the last, because it changes the earlier order's row
  await k.prisma.printOrder.update({ where: { id: first.orderId }, data: { guestAccessExpiresAt: new Date(Date.now() - 60 * MIN) } })
  const expired = await k.startCheckout({ ...k.newBrowser(), cookie: first.accessCookie ?? undefined }, { allowFailure: true })
  answers.push({ name: 'an access cookie that has expired', answer: expired })
  for (const { name, answer } of answers) {
    assert.equal(answer.status, 200, `${name}: ${answer.status} ${JSON.stringify(answer.json)}`)
    assert.equal(descriptor(answer), descriptor(answers[0].answer), `${name}: the answer is the one of a request with no cookie`)
    assert.deepEqual(mentions(answer, first.orderId, String(first.json.orderNumber)), [], `${name}: nothing of the earlier order is named`)
    const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: answer.orderId } })
    assert.equal(JSON.stringify(order.metadata).includes(first.orderId), false, `${name}: no link to the earlier order is written`)
  }
  const earlier = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: first.orderId } })
  assert.equal(earlier.status, 'awaiting_payment', 'and the earlier order is as it was')
})

// ====================================================================================================================================================================
// E2 - THE LIMIT (not closed by P2)
// ====================================================================================================================================================================
test('[KL-E2-limit] E2 LIMIT, NOT CLOSED: the same browser after a change of session - a request that proved more went first, a request that proves less comes later - cannot see the first one\'s order: two payable pages', async () => {
  const h1 = k.newBrowser()
  const earlier = await k.startCheckout(h1)                       // an earlier order of H1, cancelled and provably clean: a new purchase is legitimate
  await closeWithProof(k, earlier)
  await k.prisma.printOrder.update({ where: { id: earlier.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  const broader = otherSessionWithCookie(k, earlier)               // H2 + the cookie of H1's order: proves {H2, H1}
  const narrower = withAccessCookie(h1, earlier)                   // H1 + the same cookie: proves {H1}
  const first = await k.startCheckout(broader)
  assert.equal(first.status, 200, JSON.stringify(first.json))
  const second = await k.startCheckout(narrower, { allowFailure: true })
  const pages = await payableAcrossOrders(k)
  assert.deepEqual(
    { secondStatus: second.status, orders: await orderCount(k), payablePages: pages.length },
    { secondStatus: 200, orders: 3, payablePages: 2 },
    'LIMIT (plan REV3 §2.9, E2): the order made by H2 carries hash H2 and is linked to H1 only by the proof the earlier request carried, which is not stored anywhere; the later request has {H1} and cannot prove it. '
    + 'It is closed only by persisting that link at creation (P2b, a migration that is NOT authorised). If this test ever fails, the limit was closed on purpose: change it together with the plan.')
})

// ====================================================================================================================================================================
// LK - the locks the checkout takes today
// ====================================================================================================================================================================
test('[KL-LK-legacy-locks] LK: the per-session lock `checkout:guest-session:{hash}:{fingerprint}` and the per-key lock `checkout:purchase-key:{hash}` are still taken (a request waits for either)', async () => {
  const probe = await k.startCheckout(k.newBrowser())
  const { fingerprint } = await storedFingerprints(k, probe.orderId)
  // the session lock
  const who = k.newBrowser()
  const total = await quotedTotal(k, who)
  const sessionLock = await holdLock(k.prisma, `checkout:guest-session:${who.browser!.hash}:${fingerprint}`)
  const waitingOnSession = k.post('session', { checkoutKey: k.newKey('s'), expectedTotalCents: total, ...k.cart() }, who)
  assert.equal(await stillPendingAfter(waitingOnSession, 1200), true, 'the request waits for the per-session lock')
  await sessionLock.release()
  assert.equal((await waitingOnSession).status, 200)
  // the key lock
  const other = k.newBrowser()
  const key = k.newKey('k')
  const keyHash = purchaseKeyFor(key)
  assert.ok(keyHash, 'a strong key has a fingerprint')
  const keyLock = await holdLock(k.prisma, purchaseKeyLockName(keyHash as string))
  const waitingOnKey = k.post('session', { checkoutKey: key, expectedTotalCents: await quotedTotal(k, other), ...k.cart() }, other)
  assert.equal(await stillPendingAfter(waitingOnKey, 1200), true, 'the request waits for the per-key lock')
  await keyLock.release()
  assert.equal((await waitingOnKey).status, 200)
})
