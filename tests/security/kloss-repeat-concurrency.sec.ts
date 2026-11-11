// R1-3 / KLOSS, P3 - the repeat gate beside the WRITERS OF THE MONEY OF OTHER ORDERS (audit point C), with CHECKOUT_OWNER_GUARD=on and CHECKOUT_REPEAT_GUARD=on.
// What locks what (read in the code, not assumed): the checkout's decisions take the owner-and-cart advisory locks and the row of the ONE order they are about (S3: FOR UPDATE); the orders of G are only
// READ. A payment verified, a refund, a dispute are written by lib/payment-sync.ts under the row lock of THEIR order and its lease - never the checkout's locks - and so are the administrator's writes
// (lib/payment-hold.ts, the routes of lib/production-release.ts). So G CAN change after it was read: these tests put a refund or a dispute exactly between the reading and the decision that follows it,
// at each door, and show what is promised - the context is read again at the next door (the page, before a reservation is written, and again before a page that was just made is handed out), no page
// is handed out on a context that changed, and the next request asks again. Nothing more is promised: no serialisation with those writers is claimed.
// Concurrent confirmations, and a confirmed request beside an unconfirmed one in both orders of arrival. Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { ownerGuardHooks } from '../../lib/checkout-owner-guard'
import { accountWho, orderCount, payableAcrossOrders, restoreMargin, stillPendingAfter } from './_kloss-kit'
import { assertProposal, bodyFor, bothOn, checkoutBlockOf, confirmed, disputeAtProvider, paidPurchase, refundAtProvider, send } from './_repeat-kit'

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
test.after(async () => { ownerGuardHooks.afterSiblingsRead = null; await restoreMargin(k); await k.fresh(); await k.sim.close() })

const world = async () => ({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions() })
async function twoPaid() {
  const who = accountWho(k)
  const first = await paidPurchase(k, who)
  await k.travel(MIN)
  const second = await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const asked = await send(k, who, body)
  const value = assertProposal(asked, 'G of two')
  assert.equal(asked.json.repeatCount, 2)
  return { who, first, second, body, value }
}
// a door that stays shut until it is opened: the first request that reaches it waits there
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  let entered!: () => void
  const inside = new Promise<void>((resolve) => { entered = resolve })
  let used = false
  return { hook: async () => { if (used) return; used = true; entered(); await opened }, inside, open }
}

test('[P3-C-after-the-reading] S2 reads G, then a refund of a member is written by payment-sync (no checkout lock is shared): the order is made on the context the customer confirmed, and the page door, which reads G again, asks again - no page before it', async () => {
  const { who, first, body, value } = await twoPaid()
  let done = false
  ownerGuardHooks.afterSiblingsRead = async (stage) => { if (stage === 'order' && !done) { done = true; await refundAtProvider(k, first.orderId) } }
  const sessionsBefore = await k.sim.createdSessions()
  const answer = await send(k, who, confirmed(body, value))
  const newValue = assertProposal(answer, 'the page door read G again')
  assert.deepEqual({ pending: answer.json.pendingOrder, count: answer.json.repeatCount }, { pending: true, count: 1 })
  const made = answer.json.pendingOrderId as string
  assert.equal((await checkoutBlockOf(k, made)).repeatAcceptance?.n, 2, 'the order was made on the context that was confirmed (G as it was read)')
  assert.equal(await k.sim.createdSessions(), sessionsBefore, 'no page was made on a context that changed')
  const done2 = await send(k, who, confirmed(body, newValue))
  assert.deepEqual({ status: done2.status, orderId: done2.json?.orderId }, { status: 200, orderId: made })
  assert.deepEqual(await world(), { orders: 3, payablePages: 1, providerSessions: sessionsBefore + 1 })
})

test('[P3-C-before-the-handing-out] the page is made, and while the provider makes it a refund changes G: the page that was just made is NOT handed out on the old context; the next confirmation hands out THAT page - none is made twice', async () => {
  const { who, first, body, value } = await twoPaid()
  let done = false
  checkoutSessionHooks.afterPlan = async (step) => { if (step === 'send' && !done) { done = true; await refundAtProvider(k, first.orderId) } }
  const sessionsBefore = await k.sim.createdSessions()
  const answer = await send(k, who, confirmed(body, value))
  const newValue = assertProposal(answer, 'checked again before the page was handed out')
  assert.equal(answer.json.url, undefined, 'no page in the answer')
  const made = answer.json.pendingOrderId as string
  assert.equal(await k.sim.createdSessions(), sessionsBefore + 1, 'the page exists at the provider (it was made before G changed), registered on the order')
  const [attempt] = await k.attemptsOf(made)
  assert.equal(attempt?.status, 'open')
  const handed = await send(k, who, confirmed(body, newValue))
  assert.deepEqual({ status: handed.status, orderId: handed.json?.orderId, session: k.sessionIdOf(handed.json?.url) }, { status: 200, orderId: made, session: attempt.stripeSessionId })
  assert.equal(await k.sim.createdSessions(), sessionsBefore + 1, 'the same page: none was made twice')
  await k.assertClean('before the handing out')
})

test('[P3-C-dispute] a dispute of the paid order arrives while the page is being made: the order is in doubt, P2 holds - the page is not handed out (PAYMENT_IN_PROGRESS), whatever the confirmation said', async () => {
  const who = accountWho(k)
  const paid = await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  let done = false
  checkoutSessionHooks.afterPlan = async (step) => { if (step === 'send' && !done) { done = true; await disputeAtProvider(k, paid.orderId) } }
  const answer = await send(k, who, confirmed(body, value))
  assert.deepEqual({ status: answer.status, code: answer.json?.code, url: answer.json?.url ?? null }, { status: 409, code: 'PAYMENT_IN_PROGRESS', url: null }, JSON.stringify(answer.json))
  assert.equal((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: paid.orderId } })).paymentReviewReason, 'dispute', 'premise: payment-sync recorded the dispute')
})

test('[P3-C-concurrent-confirmations] five confirmed requests of the same purchase at once, five keys: ONE order, one page, every answer the same order and page', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const answers = await Promise.all(Array.from({ length: 5 }, (_, index) => send(k, who, confirmed({ ...body, checkoutKey: k.newKey(`together-${index}`) }, value))))
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200, 200, 200], JSON.stringify(answers.map((answer) => answer.json)))
  assert.equal(new Set(answers.map((answer) => answer.json.orderId)).size, 1, 'one order')
  assert.equal(new Set(answers.map((answer) => answer.json.url)).size, 1, 'one page')
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })
  await k.assertClean('concurrent')
})

test('[P3-C-confirmed-beside-unconfirmed] a confirmed and an unconfirmed request of the same purchase meet at the owner lock, in both orders: the unconfirmed one first is asked; the confirmed one first makes the order, and the other is given that order (its acceptance holds) - one order either way', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  // (a) the unconfirmed request holds the lock first
  const a = gate()
  checkoutOrderHooks.afterLock = a.hook
  const unconfirmedFirst = send(k, who, { ...body, checkoutKey: k.newKey('plain-first') })
  await a.inside
  const confirmedSecond = send(k, who, confirmed({ ...body, checkoutKey: k.newKey('confirmed-second') }, value))
  assert.equal(await stillPendingAfter(confirmedSecond, 800), true, 'the confirmed request waits for the owner lock')
  a.open()
  const [plain, made] = await Promise.all([unconfirmedFirst, confirmedSecond])
  assertProposal(plain, 'the unconfirmed request')
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.equal(await orderCount(k), 2)
  // (b) the confirmed request holds the lock first
  await k.fresh(); bothOn()
  await paidPurchase(k, who)
  const b2 = await bodyFor(k, who)
  const value2 = assertProposal(await send(k, who, b2), 'proposal')
  const b = gate()
  checkoutOrderHooks.afterLock = b.hook
  const confirmedFirst = send(k, who, confirmed({ ...b2, checkoutKey: k.newKey('confirmed-first') }, value2))
  await b.inside
  const plainSecond = send(k, who, { ...b2, checkoutKey: k.newKey('plain-second') })
  assert.equal(await stillPendingAfter(plainSecond, 800), true)
  b.open()
  const [first, second] = await Promise.all([confirmedFirst, plainSecond])
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.deepEqual({ status: second.status, orderId: second.json?.orderId, url: second.json?.url }, { status: 200, orderId: first.json.orderId, url: first.json.url }, 'the unconfirmed request continues the order a confirmation made: its acceptance holds')
  assert.deepEqual(await world(), { orders: 2, payablePages: 1, providerSessions: 2 })
})
