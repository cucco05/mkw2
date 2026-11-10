// R1-3 / KLOSS, P2 - the guard under concurrency (CHECKOUT_OWNER_GUARD=on): the additive locks serialise the requests of one owner for one cart WITHOUT a deadlock, whatever each was quoted and
// whatever else holds the row of an order; a lock that can not be had in time fails the request cleanly (nothing made, nothing sent, the next try works).
//   * requests of one browser for one cart at the same time: one order, one page (as before the guard);
//   * the same while the price changes between them: never a second order, never a second payable page;
//   * while the row of the order is held by somebody else (a payment being recorded takes that lock, and no advisory lock): the requests WAIT - advisory locks first, the row after - and end;
//   * the owner lock held longer than a transaction may last: a clean failure, and nothing left behind.
// Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { bootKit, type Kit } from './_dr13-kit'
import { checkoutOrderHooks } from '../../lib/checkout-orders'
import { checkoutSessionHooks } from '../../lib/checkout-sessions'
import { accountWho, holdLock, orderCount, payableAcrossOrders, quotedTotal, restoreMargin, setMargin, stillPendingAfter, storedFingerprints } from './_kloss-kit'

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

const world = async () => ({ orders: await orderCount(k), payablePages: (await payableAcrossOrders(k)).length, providerSessions: await k.sim.createdSessions() })
const waitingLocks = async () => Number((await k.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`)[0].n)

// the row of an order locked FOR UPDATE by another transaction (what the payment sync, the payment hold and the release to production take) until `release()`
async function holdRow(prisma: PrismaClient, orderId: string): Promise<{ release: () => Promise<void> }> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldPromise = new Promise<void>((resolve) => { held = resolve })
  const done = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    held()
    await gate
  }, { timeout: 60_000, maxWait: 10_000 })
  await heldPromise
  return { release: async () => { release(); await done } }
}

test('[P2-concurrent-same-total] six requests of one browser for one cart at the same time, each with its own key: one order and one page, as before the guard', async () => {
  const who = k.newBrowser()
  const total = await quotedTotal(k, who)
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => k.post('session', { checkoutKey: k.newKey(`same${i}`), expectedTotalCents: total, ...k.cart() }, who)))
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200, 200, 200, 200], JSON.stringify(answers.map((answer) => answer.json?.code)))
  assert.equal(new Set(answers.map((answer) => answer.json.orderId)).size, 1, 'the same order for all')
  assert.equal(new Set(answers.map((answer) => answer.json.url)).size, 1, 'the same page for all')
  assert.deepEqual(await world(), { orders: 1, payablePages: 1, providerSessions: 1 })
  await k.assertClean('same total')
})

test('[P2-concurrent-price-change] eight requests of one browser for one cart while the price changes between them: never a second order, never a second payable page, never a failure', async () => {
  for (let run = 0; run < 3; run += 1) {
    await k.fresh()
    await restoreMargin(k)
    const who = k.newBrowser()
    const totalA = await quotedTotal(k, who)
    const waveA = Array.from({ length: 4 }, (_, i) => k.post('session', { checkoutKey: k.newKey(`a${run}${i}`), expectedTotalCents: totalA, ...k.cart() }, who))
    await setMargin(k, 40)
    const totalB = await quotedTotal(k, who)
    assert.notEqual(totalA, totalB)
    const waveB = Array.from({ length: 4 }, (_, i) => k.post('session', { checkoutKey: k.newKey(`b${run}${i}`), expectedTotalCents: totalB, ...k.cart() }, who))
    const answers = await Promise.all([...waveA, ...waveB])
    const seen = answers.map((answer) => `${answer.status}${answer.status === 200 ? '' : `:${answer.json?.code}`}`)
    // (a request of the first wave that is quoted after the change is told the price changed: that is the checkout's own answer, not the guard's)
    assert.deepEqual(seen.filter((entry) => !['200', '409:PAYMENT_IN_PROGRESS', '409:PRICE_CHANGED'].includes(entry)), [], `run ${run}: ${seen.join(' ')}`)
    assert.ok(seen.includes('200'), `run ${run}: somebody was given the page (${seen.join(' ')})`)
    assert.equal(new Set(answers.filter((answer) => answer.status === 200).map((answer) => answer.json.orderId)).size, 1, `run ${run}: one order for every page that was given`)
    assert.deepEqual(await world(), { orders: 1, payablePages: 1, providerSessions: 1 }, `run ${run}: ${seen.join(' ')}`)
    await k.assertClean(`price change, run ${run}`)
  }
})

test('[P2-concurrent-random] a seeded mix of new keys, old keys and price changes, three at a time: at every step at most one page of this owner and cart may be paid, and nothing fails', async () => {
  let state = 20261110
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const who = k.newBrowser()
  const bodies: Array<{ checkoutKey: string; expectedTotalCents: number }> = []
  let margin = 20
  for (let round = 0; round < 8; round += 1) {
    if (next() < 0.5) { margin = margin === 20 ? 40 : 20; await setMargin(k, margin) }
    const total = await quotedTotal(k, who)
    const batch = Array.from({ length: 3 }, (_, i) => {
      const body = bodies.length > 0 && next() < 0.4 ? bodies[Math.floor(next() * bodies.length)] : { checkoutKey: k.newKey(`r${round}${i}`), expectedTotalCents: total }
      if (!bodies.includes(body)) bodies.push(body)
      return k.post('session', { ...body, ...k.cart() }, who)
    })
    const answers = await Promise.all(batch)
    const seen = answers.map((answer) => `${answer.status}${answer.status === 200 ? '' : `:${answer.json?.code}`}`)
    assert.deepEqual(seen.filter((entry) => !['200', '409:PAYMENT_IN_PROGRESS', '409:PRICE_CHANGED', '409:CHECKOUT_KEY_CONFLICT'].includes(entry)), [], `round ${round}: ${seen.join(' ')}`)
    assert.ok((await payableAcrossOrders(k)).length <= 1, `round ${round}: more than one page of this owner and cart may be paid (${seen.join(' ')})`)
  }
  assert.equal((await payableAcrossOrders(k)).length, 1)
  await k.assertClean('random')
})

test('[P2-row-lock] while the row of the order is held by another transaction the requests WAIT - advisory locks first, the row after - and end when it is released: no deadlock, no failure', async () => {
  const who = k.newBrowser()
  const first = await k.startCheckout(who)
  const row = await holdRow(k.prisma, first.orderId)
  const again = k.payAgain(first)                                   // asks a page of the order: owner lock, then the row (held)
  await setMargin(k, 40)
  const other = k.startCheckout(who, { allowFailure: true })        // a new checkout at another total: the owner lock (held by the request above, which waits for the row)
  const both = Promise.all([again, other])
  assert.equal(await stillPendingAfter(both, 1200), true, 'both wait')
  assert.ok((await waitingLocks()) >= 1, 'a lock is being waited for - and nothing was aborted')
  await row.release()
  const [mine, second] = await both
  assert.deepEqual({ mine: mine.status, samePage: mine.json?.url === first.url, second: second.status, code: second.json?.code }, { mine: 200, samePage: true, second: 409, code: 'PAYMENT_IN_PROGRESS' })
  assert.deepEqual(await world(), { orders: 1, payablePages: 1, providerSessions: 1 })
  assert.equal(await waitingLocks(), 0)
  await k.assertClean('row lock')
})

test('[P2-lock-owner-account] an ACCOUNT takes its owner-and-cart lock too (`checkout:owner:u:{account}:{cart}`, named without the total) beside the lock it always took', async () => {
  const account = accountWho(k)
  const probe = await k.startCheckout(account)
  const { cartFingerprint } = await storedFingerprints(k, probe.orderId)
  await setMargin(k, 40)
  const total = await quotedTotal(k, account)
  const held = await holdLock(k.prisma, `checkout:owner:u:${k.customer.id}:${cartFingerprint}`)
  const request = k.post('session', { checkoutKey: k.newKey('account'), expectedTotalCents: total, ...k.cart() }, account)
  const waits = await stillPendingAfter(request, 1200)
  await held.release()
  const answer = await request
  // (the first order's page may be paid: the request - another total - is held, and the account is told which order holds)
  assert.deepEqual({ waits, status: answer.status, code: answer.json?.code, named: answer.json?.orderId, ...(await world()) }, { waits: true, status: 409, code: 'PAYMENT_IN_PROGRESS', named: probe.orderId, orders: 1, payablePages: 1, providerSessions: 1 })
})

test('[P2-lock-timeout] the owner lock held longer than a transaction may last: the request fails cleanly - nothing made, nothing sent - and the same request works once the lock is free', async () => {
  const probe = await k.startCheckout(k.newBrowser())
  const { cartFingerprint } = await storedFingerprints(k, probe.orderId)
  const who = k.newBrowser()
  const total = await quotedTotal(k, who)
  const body = { checkoutKey: k.newKey('timeout'), expectedTotalCents: total, ...k.cart() }
  const before = await world()
  const held = await holdLock(k.prisma, `checkout:owner:h:${who.browser!.hash}:${cartFingerprint}`)
  const request = k.post('session', body, who)
  assert.equal(await stillPendingAfter(request, 16_500), true, 'the request waits for the lock for as long as its transaction may last')
  await held.release()
  const failed = await request
  assert.deepEqual({ failed: failed.status >= 500, retry: failed.json?.retry, ...(await world()) }, { failed: true, retry: true, ...before })
  const retried = await k.post('session', body, who)
  assert.deepEqual({ status: retried.status, ...(await world()) }, { status: 200, orders: before.orders + 1, payablePages: before.payablePages + 1, providerSessions: before.providerSessions + 1 })
})
