// S2 – the checkout confirmation must compare what Stripe actually collected with the server-side total.
// Scenario: an attacker pays for a tiny PaymentIntent, then confirms an expensive cart with that intent id.
// First these tests PROVED the hole (they were marked "todo" and failed). Since S2/S3 step 3 the old card path refuses a payment
// that is not for this cart's exact total and currency (lib/payment-verification.ts, the same check the webhook applies), so they
// are ordinary regression tests now. Stripe is replaced by a fake: no network, no real payment.
import { cartBody, db, installFakeStripe, postJson, resetDb, seedShopModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { viewerGuards, type Viewer } from '../../lib/viewer'

const intents: Record<string, any> = {}
const PI = (id: string, over: Record<string, unknown> = {}) => ({
  id, object: 'payment_intent', status: 'succeeded', amount: 100, amount_received: 100, currency: 'usd', // 1.00 - what the attacker really paid
  metadata: { checkoutId: 'a-different-checkout' }, customer: null, latest_charge: null, client_secret: 'secret_FAKE', ...over,
})

let modelId = ''
let cartTotal = 0 // cents: what the server charges for the cart used below
const owner = { id: '', role: 'customer' } as { id: string; role: 'customer' }
const someoneElse = { id: '', role: 'customer' } as { id: string; role: 'customer' }

async function commit(body: Record<string, unknown>, viewer: Viewer = null) {
  const { POST } = await import('../../app/api/checkout/route')
  viewerGuards.getViewer = async () => viewer
  const res = await postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { commit: true, ...body }))
  return { res, json: await res.clone().json().catch(() => ({})) as any }
}
const orders = async () => (await db()).printOrder.findMany({ orderBy: { createdAt: 'asc' } })

test.before(async () => {
  await resetDb()
  const prisma = await db()
  const [a, b] = await Promise.all(['s2a', 's2b'].map((name) => prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role: 'customer' } })))
  owner.id = a.id
  someoneElse.id = b.id
  modelId = (await seedShopModel()).model.id
  await installFakeStripe({ 'paymentIntents.retrieve': async (id: string) => intents[id] })
  const { POST } = await import('../../app/api/checkout/route')
  viewerGuards.getViewer = async () => null
  cartTotal = ((await (await postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, { paymentMethod: 'card' }))).json()) as any).amount
  assert.ok(cartTotal > 100, 'the test cart must cost more than the 1.00 of the cheap intent')
})

test.beforeEach(async () => {
  await (await db()).printOrder.deleteMany()
})

test('control: an unpaid intent is rejected at confirmation', async () => {
  intents.pi_unpaid = PI('pi_unpaid', { status: 'requires_payment_method', amount_received: 0 })
  const { res } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_unpaid' })
  assert.equal(res.status, 400)
  assert.equal((await orders()).length, 0)
})

test('S2: a 1.00 payment must NOT unlock an order worth more', async () => {
  intents.pi_cheap = PI('pi_cheap')
  const { res, json } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_cheap' })
  assert.equal(res.status, 400)
  assert.equal(json.code, 'PAYMENT_MISMATCH')
  assert.equal((await orders()).length, 0, 'no order may exist for an under-payment')
})

test('S2b: a payment made for another checkout, or for any other amount, cannot be reused for this cart', async () => {
  for (const amount of [10_000_000, cartTotal - 1, cartTotal + 1, 0]) {
    intents.pi_other = PI('pi_other', { amount, amount_received: amount })
    const { res } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_other' })
    assert.equal(res.status, 400, `amount ${amount}`)
  }
  assert.equal((await orders()).length, 0)
})

test('the amount must be received, not just requested: a partial or missing capture is refused', async () => {
  for (const received of [0, cartTotal - 1, cartTotal + 1]) {
    intents.pi_part = PI('pi_part', { amount: cartTotal, amount_received: received })
    const { res } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_part' })
    assert.equal(res.status, 400, `received ${received}`)
  }
  assert.equal((await orders()).length, 0)
})

test('a payment in another currency is refused even for the right number of cents', async () => {
  intents.pi_eur = PI('pi_eur', { amount: cartTotal, amount_received: cartTotal, currency: 'eur' })
  const { res } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_eur' })
  assert.equal(res.status, 400)
  assert.equal((await orders()).length, 0)
})

test('a payment still being processed for the wrong amount is refused too (it could never become a valid payment)', async () => {
  intents.pi_proc = PI('pi_proc', { status: 'processing', amount: 100, amount_received: 0 })
  const { res } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_proc' })
  assert.equal(res.status, 400)
  assert.equal((await orders()).length, 0)
})

test('control: the exact amount in the right currency is accepted and marked paid', async () => {
  intents.pi_ok = PI('pi_ok', { amount: cartTotal, amount_received: cartTotal })
  const { res } = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_ok' })
  assert.equal(res.status, 200)
  const [order] = await orders()
  assert.equal(order.totalCents, cartTotal)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'queued')
  assert.equal(order.stripePaymentIntentId, 'pi_ok')
})

test('one payment pays for ONE order: the same customer asking again gets the same order, anyone else is refused', async () => {
  intents.pi_once = PI('pi_once', { amount: cartTotal, amount_received: cartTotal })
  const first = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_once' }, owner)
  assert.equal(first.res.status, 200)
  // a double click / a retry of the same confirmation: no second order, no error
  const again = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_once' }, owner)
  assert.equal(again.res.status, 200)
  assert.equal(again.json.committed, true)
  assert.equal((await orders()).length, 1)
  // somebody else (or a guest) presenting the same payment id
  for (const viewer of [someoneElse as Viewer, null]) {
    const stolen = await commit({ paymentMethod: 'card', paymentIntentId: 'pi_once' }, viewer)
    assert.equal(stolen.res.status, 409)
    assert.equal(stolen.json.code, 'PAYMENT_ALREADY_USED')
  }
  assert.equal((await orders()).length, 1)
})
