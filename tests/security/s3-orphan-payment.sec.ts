// S3 – a payment that succeeds at Stripe must never be lost, even if the browser never comes back.
//
// Two parts of the answer:
//  1. The ORDER now exists before the customer pays (hosted checkout, S2/S3 step 2), so the webhook always has something to
//     confirm: that case is tested end to end in s2s3-step3.sec.ts ("payment confirmed without the browser coming back").
//  2. A payment that no order claims (a payment made with the old flow whose browser never came back, or something made by hand in
//     the Stripe dashboard) is no longer silently dropped: the event is stored with no order and listed for a person
//     (findUnmatchedPaymentEvents, shown by the reconciliation script), and it stops being listed as soon as an order claims it.
// Fake Stripe, throw-away database.
import { db, installFakeStripe, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { findUnmatchedPaymentEvents } from '../../lib/payment-sync'
import { recordCustomerOrder } from '../../lib/orders'

async function deliver(stripe: any, eventId: string, intentId: string, secret = process.env.STRIPE_WEBHOOK_SECRET as string) {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'payment_intent.succeeded',
    data: { object: { id: intentId, object: 'payment_intent', status: 'succeeded' } },
  })
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret })
  const req = new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    body: payload,
  })
  return (POST as any)(req, {}) as Promise<Response>
}

test.before(async () => {
  await resetDb()
})

test('control: a webhook with a bad signature is rejected', async () => {
  const stripe = await installFakeStripe()
  const res = await deliver(stripe, 'evt_bad_sig', 'pi_x', 'whsec_WRONG')
  assert.equal(res.status, 400)
})

test('S3: a succeeded payment that no order claims is recorded and listed, not silently lost', async () => {
  await resetDb()
  const stripe = await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => ({
      id, object: 'payment_intent', status: 'succeeded', amount: 5000, amount_received: 5000, currency: 'usd', metadata: { checkoutId: 'chk_FAKE' },
      customer: null, latest_charge: { id: 'ch_FAKE', receipt_url: null, amount_refunded: 0 },
    }),
  })
  const res = await deliver(stripe, 'evt_orphan_1', 'pi_orphan_FAKE')
  assert.equal(res.status, 200, 'Stripe is told it was received (nothing to retry)')
  const prisma = await db()
  assert.equal(await prisma.printOrder.count(), 0)

  const stored = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: 'evt_orphan_1' } })
  assert.equal(stored.orderId, null)
  assert.equal(stored.paymentIntentId, 'pi_orphan_FAKE')
  const listed = await findUnmatchedPaymentEvents()
  assert.deepEqual(listed.map((event) => event.paymentIntentId), ['pi_orphan_FAKE'])
})

test('S3: once an order claims the payment (old flow: the order is created afterwards) it is no longer listed, and is reconciled', async () => {
  const prisma = await db()
  assert.equal((await findUnmatchedPaymentEvents()).length, 1)
  const order = await recordCustomerOrder({
    paymentIntentId: 'pi_orphan_FAKE', amountCents: 5000, currency: 'USD', lineItems: [{
      modelId: 'm1', title: 'Part', qty: 1, scale: 1, unitPrice: 50, lineTotal: 50, material: 'PLA',
    } as any],
    shipping: { method: 'pickup' }, paymentMethod: 'card', paymentStatus: 'processing', userId: null,
  })
  const after = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
  // the creation re-read the payment from Stripe: it is a verified, exact payment, so the order is paid and released
  assert.equal(after.paymentStatus, 'paid')
  assert.equal(after.status, 'queued')
  assert.equal((await findUnmatchedPaymentEvents()).length, 0)
})
