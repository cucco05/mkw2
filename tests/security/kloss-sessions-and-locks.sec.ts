// R1-3 / KLOSS - the P0 proofs (RED until P2), part 3: a guest whose session changed (H1 -> H2) but who still holds the access cookie of an earlier order (D, E1), and the locks the plan adds (REV3 §2.4).
// R1-3 / KLOSS - the P0 proofs that P2 turned GREEN, now ordinary tests of the security suite (they were tests/red/kloss/sessions-and-locks.red.ts until P2; the ids in the titles and every assertion are the ones of P0,
// unchanged - tests/kloss-red-separation.test.ts pins the expected values - and tests/red/kloss/RED-LEDGER.md keeps the history of each).
// They run with CHECKOUT_OWNER_GUARD=on: the guard is OFF by default, and with it off these same scenarios still end the old way (tests/security/kloss-guard-flags.sec.ts shows that).
// Isolated PostgreSQL, the stand-in for Stripe (tests/security/_stripe-sim.ts), the real routes. Nothing here calls Stripe, real or in Test Mode.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import {
  closeWithProof, holdLock, orderCount, otherSessionWithCookie, payableAcrossOrders, quotedTotal, restoreMargin, setMargin, stillPendingAfter, storedFingerprints, withAccessCookie,
} from './_kloss-kit'

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

// ====================================================================================================================================================================
// D - H1 made an order with a live page; H2 holds H1's access cookie; the same cart at another total
// ====================================================================================================================================================================
test('[KL-D-cookie] D: a new session with the verified access cookie of an order whose page is payable, the same cart at another total -> held, naming that order (was RED until P2: a second order and page are made)', async () => {
  const h1 = k.newBrowser()
  const first = await k.startCheckout(h1)
  assert.ok(first.accessCookie, 'premise: the browser got the access cookie of its order')
  await setMargin(k, 40)
  const h2 = otherSessionWithCookie(k, first)
  const second = await k.startCheckout(h2, { allowFailure: true })
  const seen = { status: second.status, code: second.json?.code ?? null, named: second.json?.orderId ?? null, orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length }
  assert.deepEqual(seen, { status: 409, code: 'PAYMENT_IN_PROGRESS', named: first.orderId, orders: 1, payablePages: 1 },
    'CAUSE: the guest lookups search the orders of the CURRENT session and of the verified cookie ids with the fingerprint that includes the total (checkout-orders.ts:496-511): with another total the order of H1 is not found, and nothing is told or held')
})

// ====================================================================================================================================================================
// E1 - H1 and H2 act at the same time, with different keys; the earlier order is terminal and provably clean, so both may make a new one
// ====================================================================================================================================================================
test('[KL-E1-concurrent] E1: H1 and H2 (both with the cookie of the earlier order) ask at the same time with different keys -> they take turns and one page is payable (was RED until P2: two orders, two payable pages)', async () => {
  const h1 = k.newBrowser()
  const earlier = await k.startCheckout(h1)
  await closeWithProof(k, earlier)
  await k.prisma.printOrder.update({ where: { id: earlier.orderId }, data: { status: 'cancelled', paymentStatus: 'canceled' } })
  const whoA = withAccessCookie(h1, earlier)                 // H1, with the cookie
  const whoB = otherSessionWithCookie(k, earlier)            // H2, with the same cookie
  const total = await quotedTotal(k, whoA)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let inside!: () => void
  const insideP = new Promise<void>((resolve) => { inside = resolve })
  let first = true
  checkoutOrderHooks.afterLock = async () => { if (!first) return; first = false; inside(); await gate }
  const pa = k.post('session', { checkoutKey: k.newKey('h1'), expectedTotalCents: total, ...k.cart() }, whoA)
  await insideP
  const pb = k.post('session', { checkoutKey: k.newKey('h2'), expectedTotalCents: total, ...k.cart() }, whoB)
  const secondWaited = await stillPendingAfter(pb, 1500)
  release()
  const [ra, rb] = await Promise.all([pa, pb])
  const seen = { secondWaitedForFirst: secondWaited, statuses: [ra.status, rb.status], orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length }
  assert.deepEqual(seen, { secondWaitedForFirst: true, statuses: [200, 409], orders: 2, payablePages: 1 },
    'CAUSE: the second request has a lock in common with the first only through the older per-cart name (it waits - premise), but when it runs it searches the orders of H2 and of the cookie ids, not those of H1 that its cookie proves to be the same browser\'s (the order made by H1 has hash H1): it finds nothing and makes its own')
})

// ====================================================================================================================================================================
// the locks of the plan (REV3 §2.4): additive, named by an identity the request proved and by the cart WITHOUT the total
// ====================================================================================================================================================================
test('[KL-LOCK-owner] LOCK (additive name): a request waits for the owner-and-cart lock `checkout:owner:h:{hash}:{cartFingerprint}` (was RED until P2: that lock does not exist, the request does not wait)', async () => {
  const probe = await k.startCheckout(k.newBrowser())               // any guest order of the same cart: its stored fingerprint is what the server computes from this cart
  const { cartFingerprint } = await storedFingerprints(k, probe.orderId)
  const who = k.newBrowser()
  const hash = who.browser!.hash
  const held = await holdLock(k.prisma, `checkout:owner:h:${hash}:${cartFingerprint}`)
  const total = await quotedTotal(k, who)
  const request = k.post('session', { checkoutKey: k.newKey('lock'), expectedTotalCents: total, ...k.cart() }, who)
  const waits = await stillPendingAfter(request, 1200)
  await held.release()
  const answer = await request
  assert.deepEqual({ waitedForTheOwnerLock: waits, afterwards: answer.status }, { waitedForTheOwnerLock: true, afterwards: 200 },
    'CAUSE: the checkout takes only `checkout:guest-session:{hash}:{fingerprint}`, `checkout:guest:{fingerprint}` and `checkout:purchase-key:{hash}` today; none is named by the cart without the total, and no one by the identities a verified cookie proves')
})
