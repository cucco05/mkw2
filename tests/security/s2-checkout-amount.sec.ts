// S2 – the checkout confirmation must compare what Stripe actually collected with the server-side total.
// Scenario: an attacker pays for a tiny PaymentIntent, then confirms an expensive cart with that intent id.
// Stripe is replaced by a fake: no network, no real payment.
import { cartBody, db, installFakeStripe, postJson, resetDb, seedCustomerAndModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'

const CHEAP_INTENT = {
  id: 'pi_cheap_FAKE',
  object: 'payment_intent',
  status: 'succeeded',
  amount: 100, // 1.00 – what the attacker really paid
  currency: 'usd',
  metadata: { checkoutId: 'a-different-checkout' },
  customer: null,
  latest_charge: null,
  client_secret: 'secret_FAKE',
}

async function commit(modelId: string, body: Record<string, unknown>) {
  const { POST } = await import('../../app/api/checkout/route')
  return postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { commit: true, ...body }))
}

test.before(async () => {
  await resetDb()
})

test('control: an unpaid intent is rejected at confirmation', async () => {
  const { model } = await seedCustomerAndModel()
  await installFakeStripe({
    'paymentIntents.retrieve': async () => ({ ...CHEAP_INTENT, status: 'requires_payment_method' }),
  })
  const res = await commit(model.id, { paymentMethod: 'card', paymentIntentId: CHEAP_INTENT.id })
  assert.equal(res.status, 400)
})

test('S2: a 1.00 payment must NOT unlock an order worth more', { todo: 'S2 confirmed if this fails' }, async (t) => {
  await resetDb()
  const { model } = await seedCustomerAndModel()
  await installFakeStripe({ 'paymentIntents.retrieve': async () => CHEAP_INTENT })

  const res = await commit(model.id, { paymentMethod: 'card', paymentIntentId: CHEAP_INTENT.id })
  const prisma = await db()
  const orders = await prisma.printOrder.findMany({ where: { stripePaymentIntentId: CHEAP_INTENT.id } })
  const o = orders[0]
  t.diagnostic(
    `HTTP ${res.status}; Stripe collected=${CHEAP_INTENT.amount} cents; `
    + (o ? `order created: totalCents=${o.totalCents} paymentStatus=${o.paymentStatus} status=${o.status}` : 'no order created'),
  )
  // Secure behaviour: refuse the confirmation and create no paid order for an under-payment.
  assert.ok(res.status >= 400, `confirmation accepted (HTTP ${res.status})`)
  assert.equal(orders.filter((x) => x.paymentStatus === 'paid' && x.totalCents > CHEAP_INTENT.amount).length, 0)
})

test('S2b: the same payment intent must not be reusable by a different cart/user', { todo: 'S2 confirmed if this fails' }, async (t) => {
  await resetDb()
  const { model } = await seedCustomerAndModel()
  // The intent was created for checkout "a-different-checkout"; the confirming request has no such checkout id.
  await installFakeStripe({ 'paymentIntents.retrieve': async () => ({ ...CHEAP_INTENT, amount: 10_000_000 }) })
  const res = await commit(model.id, { paymentMethod: 'card', paymentIntentId: CHEAP_INTENT.id })
  const prisma = await db()
  const n = await prisma.printOrder.count({ where: { stripePaymentIntentId: CHEAP_INTENT.id } })
  t.diagnostic(`HTTP ${res.status}; orders bound to a foreign intent: ${n}`)
  assert.equal(n, 0, 'an intent belonging to another checkout was accepted (no metadata/ownership check)')
})
