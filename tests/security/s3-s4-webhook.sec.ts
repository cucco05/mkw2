// S3 – a payment that succeeds at Stripe must always end up as an order, even if the browser never comes back.
// S4 – a webhook whose first processing fails must be re-processed when Stripe retries it.
// Webhook signatures are generated locally with a FAKE secret; Stripe is replaced by a fake client.
import { db, installFakeStripe, postJson, resetDb } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

function succeededIntent(id: string, amount = 5000) {
  return {
    id,
    object: 'payment_intent',
    status: 'succeeded',
    amount,
    currency: 'usd',
    metadata: { checkoutId: 'chk_FAKE' },
    customer: null,
    latest_charge: { id: 'ch_FAKE', receipt_url: null, amount_refunded: 0 },
  }
}

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
  try {
    return await (POST as any)(req, {} as any)
  } catch (err: any) {
    return new Response(JSON.stringify({ error: String(err?.message || err), thrown: true }), { status: 500 })
  }
}

test.before(async () => {
  await resetDb()
})

test('control: a webhook with a bad signature is rejected', async () => {
  const stripe = await installFakeStripe()
  const res = await deliver(stripe, 'evt_bad_sig', 'pi_x', 'whsec_WRONG')
  assert.equal(res.status, 400)
})

test('S3: a succeeded payment with no local order must not be silently lost', { todo: 'S3 confirmed if this fails' }, async (t) => {
  await resetDb()
  const stripe = await installFakeStripe({ 'paymentIntents.retrieve': async (id: string) => succeededIntent(id) })
  const res = await deliver(stripe, 'evt_orphan_1', 'pi_orphan_FAKE')
  const prisma = await db()
  const orders = await prisma.printOrder.count({ where: { stripePaymentIntentId: 'pi_orphan_FAKE' } })
  const jobs = await prisma.jobForm.count({ where: { paymentIntentId: 'pi_orphan_FAKE' } })
  t.diagnostic(`webhook HTTP ${res.status}; orders for the paid intent: ${orders}; job records: ${jobs}`)
  assert.ok(orders + jobs > 0, 'payment succeeded at Stripe but the shop has no order or record of it')
})

test('S4: a webhook that failed once must be processed when Stripe retries it', { todo: 'S4 confirmed if this fails' }, async (t) => {
  await resetDb()
  const prisma = await db()
  await prisma.printOrder.create({
    data: {
      status: 'awaiting_payment',
      paymentStatus: 'pending',
      stripePaymentIntentId: 'pi_retry_FAKE',
      subtotalCents: 5000,
      totalCents: 5000,
    },
  })

  let healthy = false
  const stripe = await installFakeStripe({
    'paymentIntents.retrieve': async (id: string) => {
      if (!healthy) throw new Error('simulated temporary Stripe API outage')
      return succeededIntent(id)
    },
  })

  const first = await deliver(stripe, 'evt_retry_1', 'pi_retry_FAKE')
  healthy = true
  const second = await deliver(stripe, 'evt_retry_1', 'pi_retry_FAKE') // Stripe re-sends the SAME event id
  const secondBody = await second.json().catch(() => ({}))
  const order = await prisma.printOrder.findFirst({ where: { stripePaymentIntentId: 'pi_retry_FAKE' } })
  t.diagnostic(
    `first delivery HTTP ${first.status}; retry HTTP ${second.status} body=${JSON.stringify(secondBody)}; `
    + `final order paymentStatus=${order?.paymentStatus}`,
  )
  assert.equal(order?.paymentStatus, 'paid', 'order stayed unpaid although Stripe collected the money')
})
