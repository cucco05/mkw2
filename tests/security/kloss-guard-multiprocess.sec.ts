// R1-3 / KLOSS, P2 - the arbiter of the page across REAL processes (their own memory, their own database connections; the shared stand-in for Stripe), CHECKOUT_OWNER_GUARD=on.
// Two orders of the same owner and cart both need a NEW page (their pages are provably closed). Processes ask for a page of each AT THE SAME INSTANT: the owner-and-cart lock - an advisory
// lock of PostgreSQL, so it holds across processes - lets ONE reservation be written; every other request is held. Never two payable pages, never a deadlock, never a failure.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { killChildren, runChild } from './_dr13-procs'
import { closeWithProof, payableAcrossOrders, restoreMargin, setMargin, storedFingerprints } from './_kloss-kit'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k); delete process.env.CHECKOUT_OWNER_GUARD })
test.afterEach(() => killChildren())
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

// two unpaid orders of one browser for one cart (different totals), neither with a page that may be paid: each needs a new one
async function twoOrdersWithoutAPage() {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  await closeWithProof(k, first)
  await setMargin(k, 40)
  const second = await k.startCheckout(who)
  await closeWithProof(k, second)
  await restoreMargin(k)
  assert.equal((await payableAcrossOrders(k)).length, 0, 'premise: no page may be paid')
  const { cartFingerprint } = await storedFingerprints(k, first.orderId)
  return { first, second, extra: { CHECKOUT_OWNER_GUARD: 'on', CHILD_OWNER_HASH: who.browser!.hash as string, CHILD_OWNER_CART: cartFingerprint } }
}

test('[P2-multiprocess] two processes, two sibling orders, the same instant: one is given a page, the other is held - never two payable pages', async () => {
  for (let run = 0; run < 3; run += 1) {
    await k.fresh()
    const { first, second, extra } = await twoOrdersWithoutAPage()
    const startAt = Date.now() + 3000
    const results = await Promise.all([runChild(k, 'a', first.orderId, startAt, extra), runChild(k, 'b', second.orderId, startAt, extra)])
    assert.deepEqual(results.map((result) => result.kind).sort(), ['held', 'open'], `run ${run}: ${JSON.stringify(results.map((result) => ({ label: result.label, kind: result.kind, exit: result.exit })))}`)
    assert.equal((await payableAcrossOrders(k)).length, 1, `run ${run}: one page may be paid`)
    assert.deepEqual(await k.sim.violations(), [])
  }
})

test('[P2-multiprocess] six processes (three for each of the two sibling orders) at the same instant: the pages that are given are all pages of ONE order, the rest are held; nothing fails', async () => {
  const { first, second, extra } = await twoOrdersWithoutAPage()
  const startAt = Date.now() + 3500
  const results = await Promise.all([first, second, first, second, first, second].map((order, index) => runChild(k, `p${index}`, order.orderId, startAt, extra)))
  const kinds = results.map((result) => result.kind)
  assert.deepEqual(kinds.filter((kind) => kind !== 'open' && kind !== 'held'), [], JSON.stringify(results.map((result) => ({ label: result.label, kind: result.kind, exit: result.exit, code: result.code }))))
  assert.ok(kinds.includes('open') && kinds.includes('held'))
  const payable = await payableAcrossOrders(k)
  assert.equal(payable.length, 1, 'one page may be paid')
  assert.equal(new Set(results.filter((result) => result.kind === 'open').map((result) => result.url)).size, 1, 'every process that was given a page was given the same one')
  assert.deepEqual(await k.sim.violations(), [])
})
