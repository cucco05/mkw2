// R1-3 / KLOSS, P3 - the flag CHECKOUT_REPEAT_GUARD = off | shadow | on, and what it can do beside CHECKOUT_OWNER_GUARD (lib/checkout-owner-guard.ts, repeatGuardMode):
//   * off (unset, empty, anything else) - with the owner guard on, everything is P2: the purchase made again after a paid one is a new order, and the body of the request refuses confirmRepeat /
//     repeatContext (400) exactly as before; nothing of the gate is counted, nothing written;
//   * on beside the owner guard OFF: off - said once (log, counter); the owner guard in shadow: at most counted;
//   * shadow: the same answers, the same rows and the same calls to the provider as off; what the gate WOULD do is counted, with the age of the payment (a payment of one to 24 hours ago apart).
// Isolated PostgreSQL, the stand-in for Stripe, the real routes.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import { accountWho, restoreMargin } from './_kloss-kit'
import { bodyFor, checkoutBlockOf, confirmed, paidPurchase, send } from './_repeat-kit'

let k: Kit
const HOUR = 3_600_000
const set = (owner?: string, repeat?: string) => {
  if (owner === undefined) delete process.env.CHECKOUT_OWNER_GUARD; else process.env.CHECKOUT_OWNER_GUARD = owner
  if (repeat === undefined) delete process.env.CHECKOUT_REPEAT_GUARD; else process.env.CHECKOUT_REPEAT_GUARD = repeat
}
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k); set(undefined, undefined) })
test.after(async () => { set(undefined, undefined); await restoreMargin(k); await k.fresh(); await k.sim.close() })

function counted(name: string, labels: Record<string, string> = {}): number {
  return getInMemoryMetricsSnapshot().counters
    .filter((counter) => counter.name === name && Object.entries(labels).every(([key, value]) => String((counter.labels as Record<string, unknown> | undefined)?.[key]) === value))
    .reduce((sum, counter) => sum + counter.value, 0)
}
const repeatCounters = () => getInMemoryMetricsSnapshot().counters.filter((counter) => counter.name.startsWith('checkout_repeat_guard') && counter.name !== 'checkout_repeat_guard_inert_total').reduce((sum, counter) => sum + counter.value, 0)
const opKinds = async () => (await k.opNames()).map((name) => name.split(':')[0])
async function rowShapes() {
  const orders = await k.prisma.printOrder.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { paymentAttempts: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } })
  return orders.map((o) => `${o.status}/${o.paymentStatus}/${o.totalCents}/${Object.keys(((o.metadata as any)?.checkout) ?? {}).sort().join('+')}:${o.paymentAttempts.map((a) => `${a.status}${a.stripeSessionId ? '+id' : ''}`).join(',')}`)
}
// the scenario of D3: a purchase paid, the same cart again with a new key; then the same request with the fields of a confirmation
async function scenario() {
  const who = accountWho(k)
  await paidPurchase(k, who)
  const again = await send(k, who, await bodyFor(k, who))
  const withFields = await send(k, who, confirmed(await bodyFor(k, who), `rc1_${'2'.repeat(64)}`))
  return { statuses: [again.status, withFields.status], codes: [again.json?.code ?? null, withFields.json?.code ?? null], ops: await opKinds(), rows: await rowShapes(), madeWith: again.json?.orderId ?? null }
}
const OLD_WAY = { statuses: [200, 400], codes: [null, 'INVALID_REQUEST'] }

test('[P3-flag-off] the repeat guard off (unset, said, misspelt) beside the owner guard on: P2 exactly - a new order, the fields refused (400), nothing counted, nothing of a confirmation written', async () => {
  set('on', undefined)
  const before = repeatCounters()
  const unset = await scenario()
  assert.deepEqual({ statuses: unset.statuses, codes: unset.codes }, OLD_WAY)
  assert.deepEqual(await checkoutBlockOf(k, unset.madeWith as string).then((block) => [block.repeatOf ?? null, block.repeatAcceptance ?? null]), [null, null])
  for (const value of ['off', 'OFF', 'true', '1', 'onn', 'on!']) {
    await k.fresh(); set('on', value)
    const run = await scenario()
    assert.deepEqual({ statuses: run.statuses, codes: run.codes }, OLD_WAY, `CHECKOUT_REPEAT_GUARD=${value}`)
    assert.deepEqual(run.ops, unset.ops, `the same calls to the provider (${value})`)
    assert.deepEqual(run.rows, unset.rows, `the same rows (${value})`)
  }
  assert.equal(repeatCounters(), before, 'nothing of the gate was counted')
})

test('[P3-flag-inert] the repeat guard on while the owner guard is OFF: it is off - a new order, the fields refused - and that is said once', async () => {
  set(undefined, 'on')
  const inertBefore = counted('checkout_repeat_guard_inert_total')
  const run = await scenario()
  assert.deepEqual({ statuses: run.statuses, codes: run.codes }, OLD_WAY)
  const inertAfter = counted('checkout_repeat_guard_inert_total')
  assert.ok(inertAfter >= 1, 'said')
  await k.fresh(); set('off', 'on')
  assert.deepEqual(await scenario().then((again) => ({ statuses: again.statuses, codes: again.codes })), OLD_WAY)
  assert.equal(counted('checkout_repeat_guard_inert_total'), inertAfter, 'once')
  assert.ok(inertBefore <= inertAfter)
})

test('[P3-flag-shadow] shadow beside the owner guard on: the same answers, the same rows and the same calls to the provider as off; what the gate WOULD do is counted, with the age of the payment', async () => {
  set('on', undefined)
  const off = await scenario()
  await k.fresh(); set('on', 'shadow')
  const proposeBefore = counted('checkout_repeat_guard_shadow_total', { stage: 'order', decision: 'would_propose', age: 'lt5m' })
  const askedBefore = counted('checkout_repeat_guard_asked_total')
  const shadow = await scenario()
  assert.deepEqual({ statuses: shadow.statuses, codes: shadow.codes }, OLD_WAY, 'shadow answers as off')
  assert.deepEqual(shadow.ops, off.ops, 'shadow asks the provider what off asks')
  assert.deepEqual(shadow.rows, off.rows, 'shadow leaves the rows off leaves - nothing of a confirmation among them')
  assert.ok(counted('checkout_repeat_guard_shadow_total', { stage: 'order', decision: 'would_propose', age: 'lt5m' }) > proposeBefore, 'the confirmation it would ask is counted')
  assert.equal(counted('checkout_repeat_guard_asked_total'), askedBefore, 'and nothing was asked')
})

test('[P3-flag-shadow-measure] shadow counts a payment of one to 24 hours ago apart (the measure of a wider window) - and asks nothing of it, like the gate itself', async () => {
  set('on', 'shadow')
  const who = accountWho(k)
  await paidPurchase(k, who)
  await k.travel(2 * HOUR)
  const outsideBefore = counted('checkout_repeat_guard_shadow_total', { stage: 'order', decision: 'outside_window', age: '60m_24h' })
  const again = await send(k, who, await bodyFor(k, who))
  assert.equal(again.status, 200)
  assert.ok(counted('checkout_repeat_guard_shadow_total', { stage: 'order', decision: 'outside_window', age: '60m_24h' }) > outsideBefore)
  set('on', 'on')
  const later = await send(k, who, await bodyFor(k, who))
  assert.equal(later.status, 200, 'two hours later the gate itself asks nothing either')
})

test('[P3-flag-owner-shadow] the owner guard in shadow: the repeat guard, asked on or shadow, is at most counted - P2 answers as off, the fields are refused', async () => {
  for (const repeat of ['on', 'shadow']) {
    await k.fresh(); set('shadow', repeat)
    const before = counted('checkout_repeat_guard_shadow_total', { stage: 'order' })
    const run = await scenario()
    assert.deepEqual({ statuses: run.statuses, codes: run.codes }, OLD_WAY, `owner shadow, repeat ${repeat}`)
    assert.ok(counted('checkout_repeat_guard_shadow_total', { stage: 'order' }) > before, `counted (repeat ${repeat})`)
  }
})
