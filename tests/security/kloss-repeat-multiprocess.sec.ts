// R1-3 / KLOSS, P3 - the confirmation of a repeat purchase across REAL processes (their own memory, their own database connections; the shared stand-in for Stripe), CHECKOUT_OWNER_GUARD=on and
// CHECKOUT_REPEAT_GUARD=on in every process. Several processes send the SAME confirmed purchase at the same instant, with different keys: the owner-and-cart lock - an advisory lock of PostgreSQL, so it
// holds across processes - lets one of them make the order; every other one finds it, and its acceptance, and is given the same order and page. A process that dies after the order was made and its
// reservation written, before the provider is called: the next request - with no value - is given the order's page (the acceptance holds; DR-13 resolves the reservation).
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { killChildren, runChild } from './_dr13-procs'
import { accountWho, orderCount, payableAcrossOrders, restoreMargin } from './_kloss-kit'
import { assertProposal, bodyFor, bothOn, checkoutBlockOf, confirmed, paidPurchase, send } from './_repeat-kit'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k); bothOn() })
test.afterEach(() => killChildren())
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

const GUARDS = { CHECKOUT_OWNER_GUARD: 'on', CHECKOUT_REPEAT_GUARD: 'on' }

test('[P3-multiprocess] four processes send the same confirmed purchase at the same instant, four keys: ONE order is made; every process is given that order and its one page', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const startAt = Date.now() + 3500
  const results = await Promise.all([0, 1, 2, 3].map((index) => runChild(k, `c${index}`, 'none', startAt, {
    ...GUARDS, CHILD_MODE: 'route', CHILD_VIEWER_ID: k.customer.id, CHILD_BODY: JSON.stringify(confirmed({ ...body, checkoutKey: k.newKey(`process-${index}`) }, value)),
  })))
  const seen = results.map((result) => ({ label: result.label, status: result.status, code: result.code, orderId: result.kind, exit: result.exit }))
  assert.deepEqual(seen.map((result) => result.status), [200, 200, 200, 200], JSON.stringify(seen))
  assert.equal(new Set(results.map((result) => result.kind)).size, 1, 'one order')
  assert.equal(new Set(results.map((result) => result.url)).size, 1, 'one page')
  assert.deepEqual({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length }, { orders: 2, payablePages: 1 })
  assert.deepEqual(await k.sim.violations(), [])
})

test('[P3-multiprocess-crash] the process dies after the confirmed order was made and its reservation written, before the provider is called: the next request, with NO value, is given the order\'s page - no second confirmation, no second order', async () => {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const body = await bodyFor(k, who)
  const value = assertProposal(await send(k, who, body), 'proposal')
  const died = await runChild(k, 'dies', 'none', Date.now() + 1500, { ...GUARDS, CHILD_MODE: 'route', CHILD_CRASH: 'send', CHILD_VIEWER_ID: k.customer.id, CHILD_BODY: JSON.stringify(confirmed(body, value)) })
  assert.equal(died.exit, 137, `the process died where it was told to (${died.kind})`)
  const made = await k.prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  assert.equal((await checkoutBlockOf(k, made.id)).repeatAcceptance?.context, value, 'the order was made with its acceptance')
  assert.equal((await k.attemptsOf(made.id))[0]?.status, 'creating', 'its reservation was written, the provider never called')
  const retry = await send(k, who, body)
  assert.deepEqual({ status: retry.status, orderId: retry.json?.orderId }, { status: 200, orderId: made.id }, JSON.stringify(retry.json))
  assert.deepEqual({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length }, { orders: 2, payablePages: 1 })
  assert.deepEqual(await k.sim.violations(), [])
})
