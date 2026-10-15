// S3 – a payment that succeeds at Stripe must always end up as an order, even if the browser never comes back.
// (Still open: it needs the order to exist BEFORE payment, which comes with the Stripe Checkout migration in S2/S3.)
// S4 (webhook reliability) has its own regression suite: s4-webhook-reliability.sec.ts.
import { db, installFakeStripe, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

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

test('S3: a succeeded payment with no local order must not be silently lost', { todo: 'S3 open until orders exist before payment (S2/S3)' }, async (t) => {
  await resetDb()
  const stripe = await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => ({
      id, object: 'payment_intent', status: 'succeeded', amount: 5000, currency: 'usd', metadata: { checkoutId: 'chk_FAKE' },
      customer: null, latest_charge: { id: 'ch_FAKE', receipt_url: null, amount_refunded: 0 },
    }),
  })
  const res = await deliver(stripe, 'evt_orphan_1', 'pi_orphan_FAKE')
  const prisma = await db()
  const orders = await prisma.printOrder.count({ where: { stripePaymentIntentId: 'pi_orphan_FAKE' } })
  const jobs = await prisma.jobForm.count({ where: { paymentIntentId: 'pi_orphan_FAKE' } })
  t.diagnostic(`webhook HTTP ${res.status}; orders for the paid intent: ${orders}; job records: ${jobs}`)
  assert.ok(orders + jobs > 0, 'payment succeeded at Stripe but the shop has no order or record of it')
})
