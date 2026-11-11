// R1-3 / KLOSS hardening B - the rollout of a new version of the cart fingerprint across REAL processes (their own memory, their own database connections; the shared stand-in for Stripe), each an
// instance of one phase of the rollout (tests/security/_fingerprint-rollout.ts: a version 9 of the test's own, never registered in production), the real route POST /api/checkout/session.
//   * instances of ADJACENT phases (phase 1 beside phase 2, phase 2 beside the end) at the same instant, the same account and cart, two keys: ONE order - they meet at the lock named by the version
//     they share, and each finds what the other wrote;
//   * the instance that does NOT know version 9 and the one that writes it take the SAME lock (held from outside, each waits for it) - and yet, deterministically, the old one does not recognise the
//     order the new one made and makes a SECOND order: a shared lock is not enough, every instance must know a version before any writes it (phase 1);
//   * an instance of phase 1 finds the order an instance of phase 2 wrote (version 9 is in its lookup) and continues it.
// With the owner guard off (the checkout of today) and on. Isolated PostgreSQL, the stand-in for Stripe; nothing is called outside.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootKit, type Kit } from './_dr13-kit'
import { killChildren, runChild, type ChildResult } from './_dr13-procs'
import { accountWho, holdLock, orderCount, restoreMargin, stillPendingAfter } from './_kloss-kit'
import { bodyFor, type Body } from './_repeat-kit'
import { rolloutRegistry, TEST_VERSION, type RolloutPhase } from './_fingerprint-rollout'
import { checkoutItemSchema } from '../../lib/checkout-quote'
import { fingerprintSetOf } from '../../lib/cart-fingerprint'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k) })
test.afterEach(() => killChildren())
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

const GUARD_MODES = [{ CHECKOUT_OWNER_GUARD: 'off', CHECKOUT_REPEAT_GUARD: 'off' }, { CHECKOUT_OWNER_GUARD: 'on', CHECKOUT_REPEAT_GUARD: 'off' }]
const send = (label: string, phase: RolloutPhase, body: Body, startAt: number, flags: Record<string, string>): Promise<ChildResult> =>
  runChild(k, label, 'none', startAt, { ...flags, CHILD_MODE: 'route', CHILD_FINGERPRINT_PHASE: phase, CHILD_VIEWER_ID: k.customer.id, CHILD_BODY: JSON.stringify({ ...body, checkoutKey: k.newKey(label) }) })
const shape = (results: ChildResult[]) => JSON.stringify(results.map((result) => ({ label: result.label, status: result.status, code: result.code, orderId: result.kind, exit: result.exit })))
// the fingerprints the route computes for this body in an instance of `phase` (the same parse as the route's)
const printsOf = (body: Body, phase: RolloutPhase) => fingerprintSetOf({
  principalId: k.customer.id, items: (body.items as unknown[]).map((item) => checkoutItemSchema.parse(item)), shippingMethod: (body.shipping as { method: 'pickup' | 'ship' }).method, rush: Boolean(body.rush), expectedTotalCents: body.expectedTotalCents,
}, rolloutRegistry(phase))
const versionOf = async (orderId: string) => ((await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })).metadata as any)?.checkout?.cartFingerprintVersion

for (const flags of GUARD_MODES) {
  const guard = `owner guard ${flags.CHECKOUT_OWNER_GUARD}`
  test(`[B-rollout-adjacent] (${guard}) instances of adjacent phases at the same instant, one account, one cart, two keys: ONE order, both answered with it - phase 1 beside phase 2, phase 2 beside the end`, async () => {
    for (const [a, b] of [['phase1', 'phase2'], ['phase2', 'after']] as Array<[RolloutPhase, RolloutPhase]>) {
      for (let run = 0; run < 2; run++) {
        await k.fresh()
        const body = await bodyFor(k, accountWho(k))
        const startAt = Date.now() + 3000
        const results = await Promise.all([send(`${a}-${run}`, a, body, startAt, flags), send(`${b}-${run}`, b, body, startAt, flags)])
        assert.deepEqual(results.map((result) => result.status), [200, 200], `${a} beside ${b}, run ${run}: ${shape(results)}`)
        assert.equal(new Set(results.map((result) => result.kind)).size, 1, `${a} beside ${b}, run ${run}: one order - ${shape(results)}`)
        assert.equal(await orderCount(k), 1)
        assert.deepEqual(await k.sim.violations(), [])
      }
    }
  })

  test(`[B-rollout-lock-not-enough] (${guard}) the instance that does not know version ${TEST_VERSION} and the one that writes it take the SAME lock - and yet the old one makes a SECOND order beside the new one's: every instance must know a version before any writes it`, async () => {
    const body = await bodyFor(k, accountWho(k))
    const old = printsOf(body, 'before')
    const writer = printsOf(body, 'phase2')
    // the lock they share: the per-request lock of the account named by version 2 (the old one's current, the writer's transitional)
    const shared = old.lock.map((entry) => entry.checkout).filter((value) => writer.lock.some((entry) => entry.checkout === value))
    assert.deepEqual(shared, [old.current.checkout], 'premise: one lock name in common')
    const lockName = `checkout:${k.customer.id}:${shared[0]}`
    for (const [label, phase] of [['old-waits', 'before'], ['writer-waits', 'phase2']] as Array<[string, RolloutPhase]>) {
      await k.fresh()
      const held = await holdLock(k.prisma as never, lockName)
      const pending = send(label, phase, body, Date.now() + 500, flags)
      try {
        assert.equal(await stillPendingAfter(pending, 4000), true, `${label}: the instance waits for the lock named by version 2`)
      } finally {
        await held.release()
      }
      assert.equal((await pending).status, 200)
    }
    // deterministically: the writer makes its order (stored with version 9), then the old instance - holding the same lock in its turn - does not recognise it
    await k.fresh()
    const first = await send('writer', 'phase2', body, Date.now() + 500, flags)
    assert.equal(first.status, 200, shape([first]))
    assert.equal(await versionOf(first.kind as string), TEST_VERSION)
    const second = await send('old', 'before', body, Date.now() + 500, flags)
    assert.equal(second.status, 200, shape([second]))
    assert.notEqual(second.kind, first.kind, 'a second order: the old instance can not find an order of a version it does not know')
    assert.equal(await orderCount(k), 2)
    assert.equal(await versionOf(second.kind as string), 2)
  })

  if (flags.CHECKOUT_OWNER_GUARD === 'on') {
    test(`[B-rollout-page-lock] (${guard}) the page door (S3) of an instance of phase 2 takes the owner lock named by the transitional version too: the same request sent again waits for it`, async () => {
      const body = await bodyFor(k, accountWho(k))
      const key = k.newKey('page-lock')
      const sendKey = (label: string) => runChild(k, label, 'none', Date.now() + 500, { ...flags, CHILD_MODE: 'route', CHILD_FINGERPRINT_PHASE: 'phase2', CHILD_VIEWER_ID: k.customer.id, CHILD_BODY: JSON.stringify({ ...body, checkoutKey: key }) })
      const first = await sendKey('first')
      assert.equal(first.status, 200, shape([first]))
      // (found by its key: S3 only - the page of the order it already has)
      const transitionalCart = printsOf(body, 'phase2').lock.find((entry) => entry.v === 2)?.cart as string
      const held = await holdLock(k.prisma as never, `checkout:owner:u:${k.customer.id}:${transitionalCart}`)
      const again = sendKey('again')
      try {
        assert.equal(await stillPendingAfter(again, 4000), true, 'the page door waits for the owner lock of the transitional version')
      } finally {
        await held.release()
      }
      const result = await again
      assert.deepEqual({ status: result.status, sameOrder: result.kind === first.kind, orders: await orderCount(k) }, { status: 200, sameOrder: true, orders: 1 }, shape([first, result]))
    })
  }

  test(`[B-rollout-phase1-finds] (${guard}) an instance of phase 1 (version ${TEST_VERSION} known, not written) finds the order an instance of phase 2 wrote with it, and continues it`, async () => {
    const body = await bodyFor(k, accountWho(k))
    const written = await send('writer', 'phase2', body, Date.now() + 500, flags)
    assert.equal(written.status, 200, shape([written]))
    const found = await send('phase1', 'phase1', body, Date.now() + 500, flags)
    assert.deepEqual({ status: found.status, sameOrder: found.kind === written.kind, orders: await orderCount(k) }, { status: 200, sameOrder: true, orders: 1 }, shape([written, found]))
  })
}
