// R1-3 / KLOSS - a RED proof of the limit E2 (the identity of the owner changes between two checkouts of the same cart): a guest who signs in. Written in P3 (PLAN REV2, audit point F) to put the
// limit on record as a FAILING test, not to close it: closing it needs the links between identities to be stored (P2b, a migration that is not authorised). It is expected to STAY RED after P3.
// RED on purpose and apart from the ordinary suites, like the other proofs of this directory (run with `npm run test:kloss-red`); tests/red/kloss/RED-LEDGER.md has its row.
import '../../security/_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit, type Who } from '../../security/_dr13-kit'
import { payableAcrossOrders, restoreMargin, withAccessCookie } from '../../security/_kloss-kit'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k) })
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

test('[KL-E2-login] E2 (a guest who signs in): the same person and cart - first as a guest with a page that may be paid, then from the account in the same browser -> at most one payable page (RED, and it stays RED after P3)', async () => {
  const browser = k.newBrowser()
  const asGuest = await k.startCheckout(browser)
  assert.equal((await k.sim.payable(asGuest.orderId)).length, 1, 'premise: the page the guest was given may be paid')
  // the same browser (its session cookie and the access cookie of the guest's order), now signed in
  const signedIn: Who = { ...withAccessCookie(browser, asGuest), viewer: { id: k.customer.id, role: 'customer' } }
  await k.startCheckout(signedIn, { allowFailure: true })
  const seen = { payablePages: (await payableAcrossOrders(k)).length }
  assert.deepEqual(seen, { payablePages: 1 },
    'CAUSE: a request of an account proves the account and nothing else (app/api/checkout/session/route.ts:92 and :134 - no guest session, no access cookie is read for it): the order the same person made a moment ago as a guest is outside its scope, so a second order with a second payable page is made. The link "this account was that guest" is stored nowhere (E2; closing it is P2b)')
})
