// R1-3 / KLOSS hardening B - the versions of the cart fingerprint in the real checkout (lib/cart-fingerprint.ts), isolated PostgreSQL, the stand-in for Stripe, the real routes:
//   * a new order says which version computed its fingerprints (metadata.checkout.cartFingerprintVersion = 2), the fingerprints are the current ones of the registry, and writing the version
//     raised no financial revision;
//   * an order stored with the fingerprints of version 1 (step 4.5) is still found - with the owner guard on too - and continued: one order;
//   * the read-only check that a version may leave the registry (scripts/cart-fingerprint-retirement.sql) counts exactly the orders that still need it: an unpaid order of before hardening B (its
//     version unknown) for every version, an order of version 2 for version 2 only, an order paid and done long ago for none.
import './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { bootKit, type Kit } from './_dr13-kit'
import { accountWho, orderCount, restoreMargin } from './_kloss-kit'
import { bodyFor, send } from './_repeat-kit'
import { withCheckoutFlags } from './_checkout-flags'
import { checkoutItemSchema } from '../../lib/checkout-quote'
import { cartFingerprintV1, checkoutFingerprintV1, fingerprintSetOf } from '../../lib/cart-fingerprint'

let k: Kit
test.before(async () => { k = await bootKit() })
test.beforeEach(async () => { await k.fresh(); await restoreMargin(k) })
test.after(async () => { await restoreMargin(k); await k.fresh(); await k.sim.close() })

const checkoutOf = async (orderId: string) => {
  const order = await k.prisma.printOrder.findUniqueOrThrow({ where: { id: orderId } })
  return { order, checkout: (order.metadata as any)?.checkout as Record<string, unknown> }
}
const inputOf = (body: Awaited<ReturnType<typeof bodyFor>>) => ({
  principalId: k.customer.id, items: (body.items as unknown[]).map((item) => checkoutItemSchema.parse(item)), shippingMethod: (body.shipping as { method: 'pickup' | 'ship' }).method, rush: Boolean(body.rush),
})

for (const owner of ['off', 'on'] as const) {
  test(`[B-version-written] (owner guard ${owner}) a new order says which version computed its fingerprints - version 2, the current one of the registry - and writing it raised no financial revision`, async () => {
    await withCheckoutFlags({ owner, repeat: 'off' }, async () => {
      const who = accountWho(k)
      const body = await bodyFor(k, who)
      const made = await send(k, who, body)
      assert.equal(made.status, 200, made.text)
      const { order, checkout } = await checkoutOf(made.json.orderId)
      const prints = fingerprintSetOf({ ...inputOf(body), expectedTotalCents: body.expectedTotalCents })
      assert.deepEqual({ version: checkout.cartFingerprintVersion, block: checkout.version, fingerprint: checkout.fingerprint, cart: checkout.cartFingerprint }, { version: 2, block: 1, fingerprint: prints.current.checkout, cart: prints.current.cart })
      assert.equal(order.financialRevision, 0, 'no financial revision for the version written with the order')
    })
  })

  test(`[B-v1-found] (owner guard ${owner}) an unpaid order stored with the fingerprints of version 1 (step 4.5) is still found and continued - one order`, async () => {
    await withCheckoutFlags({ owner, repeat: 'off' }, async () => {
      const who = accountWho(k)
      const body = await bodyFor(k, who)
      const first = await send(k, who, body)
      assert.equal(first.status, 200, first.text)
      // the order as step 4.5 would have stored it: fingerprints of version 1, no version written
      const { order, checkout } = await checkoutOf(first.json.orderId)
      const input = inputOf(body)
      const { cartFingerprintVersion: _dropped, ...rest } = checkout
      await k.prisma.printOrder.update({ where: { id: order.id }, data: { checkoutKey: null, metadata: { ...(order.metadata as object), checkout: { ...rest, fingerprint: checkoutFingerprintV1({ ...input, expectedTotalCents: body.expectedTotalCents }), cartFingerprint: cartFingerprintV1(input) } } as never } })
      const again = await send(k, who, { ...body, checkoutKey: k.newKey('again') })
      assert.deepEqual({ status: again.status, sameOrder: again.json?.orderId === order.id, orders: await orderCount(k) }, { status: 200, sameOrder: true, orders: 1 }, again.text)
    })
  })
}

test('[B-v1-in-flight] a payment in doubt on an order stored with the fingerprints of version 1 still stops a second payment of the same cart (findPurchaseInFlight reads every version)', async () => {
  const who = accountWho(k)
  const body = await bodyFor(k, who)
  const first = await send(k, who, body)
  assert.equal(first.status, 200, first.text)
  const { order, checkout } = await checkoutOf(first.json.orderId)
  const input = inputOf(body)
  const { cartFingerprintVersion: _dropped, ...rest } = checkout
  // the order as step 4.5 stored it, its payment being confirmed
  await k.prisma.printOrder.update({ where: { id: order.id }, data: { checkoutKey: null, paymentStatus: 'processing', metadata: { ...(order.metadata as object), checkout: { ...rest, fingerprint: checkoutFingerprintV1({ ...input, expectedTotalCents: body.expectedTotalCents }), cartFingerprint: cartFingerprintV1(input) } } as never } })
  const again = await send(k, who, { ...body, checkoutKey: k.newKey('in-flight') })
  assert.deepEqual({ status: again.status, code: again.json?.code, orderId: again.json?.orderId, orders: await orderCount(k) }, { status: 409, code: 'PAYMENT_IN_PROGRESS', orderId: order.id, orders: 1 }, again.text)
})

// the queries of the read-only check, as the file writes them (a comment line is no query; BEGIN / SET / COMMIT are the transaction, run here as a read-only transaction of Prisma)
function retirementQueries(retire: string): string[] {
  const sql = readFileSync(path.join(process.cwd(), 'scripts', 'cart-fingerprint-retirement.sql'), 'utf8')
  return sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((query) => query.trim()).filter(Boolean)
    .filter((query) => !/^(BEGIN|COMMIT|SET TRANSACTION READ ONLY)$/i.test(query.replace(/;$/, '')))
    .map((query) => query.split(":'retire'").join(`'${retire.replace(/'/g, "''")}'`))
}
async function stillNeeded(retire: string): Promise<{ count: number; ids: string[] }> {
  return k.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    const [, q2, q3] = retirementQueries(retire)
    const count = Number(((await tx.$queryRawUnsafe(q2)) as Array<{ still_needed: bigint }>)[0].still_needed)
    const ids = ((await tx.$queryRawUnsafe(q3)) as Array<{ id: string }>).map((row) => row.id).sort()
    return { count, ids }
  })
}

test('[B-retirement] the read-only check of a version: an unpaid order of before hardening B counts for every version, an order of version 2 for version 2 only, an order paid and done long ago for none', async () => {
  assert.equal(retirementQueries('1').length, 3, 'three queries')
  const who = accountWho(k)
  const body = await bodyFor(k, who)
  // (1) an unpaid order of version 2, as the checkout writes it now
  const current = await send(k, who, body)
  assert.equal(current.status, 200, current.text)
  // (2) an unpaid order of before hardening B: the same block, no version written (made from the first one, as that code wrote it)
  const { order, checkout } = await checkoutOf(current.json.orderId)
  const { cartFingerprintVersion: _dropped, ...rest } = checkout
  const beforeId = (await k.prisma.printOrder.create({ data: { status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', subtotalCents: order.subtotalCents, totalCents: order.totalCents, currency: order.currency, userId: order.userId, metadata: { ...(order.metadata as object), checkout: rest } as never } })).id
  // (3) an order of before hardening B paid and done long ago, its page the carrier of its payment: nothing still needs a version for it
  const paid = await k.prisma.printOrder.create({ data: { status: 'completed', paymentStatus: 'paid', paymentMethod: 'card', subtotalCents: 1000, totalCents: 1000, currency: 'EUR', userId: k.customer.id, stripePaymentIntentId: 'pi_retire_FAKE_1', paidAt: new Date(Date.now() - 30 * 24 * 3_600_000), createdAt: new Date(Date.now() - 30 * 24 * 3_600_000), metadata: { checkout: { version: 1, fingerprint: 'f'.repeat(64), cartFingerprint: 'c'.repeat(64) } } } })
  await k.prisma.paymentAttempt.create({ data: { orderId: paid.id, amountCents: 1000, currency: 'eur', status: 'paid', stripeSessionId: 'cs_retire_FAKE_1', stripePaymentIntentId: 'pi_retire_FAKE_1', expiresAt: new Date(), completedAt: paid.paidAt } })
  const v1 = await stillNeeded('1')
  const v2 = await stillNeeded('2')
  assert.deepEqual(v1, { count: 1, ids: [beforeId] }, 'version 1 is still needed by the unpaid order of before hardening B only')
  assert.deepEqual(v2, { count: 2, ids: [current.json.orderId, beforeId].sort() }, 'version 2 by both unpaid orders')
  assert.equal([...v1.ids, ...v2.ids].includes(paid.id), false, 'the order paid and done long ago needs none')
})
