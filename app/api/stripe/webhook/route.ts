import { NextRequest, NextResponse } from 'next/server'
import { getStripe } from '@/lib/stripe'
import { handleStripeWebhookEvent } from '@/lib/stripe-webhook'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'
import { incrementMetric } from '@/lib/observability-metrics'

export const dynamic = 'force-dynamic'

// Answers Stripe with:
//   200  the event was processed, was ALREADY processed, or is not relevant to us  -> Stripe stops retrying
//   400  bad or missing signature                                                  -> nothing is trusted or stored
//   500  processing failed                                                          -> nothing was saved, Stripe retries later
async function handlePost(req: NextRequest) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim()
  if (!secret) return NextResponse.json({ error: 'Stripe webhook secret is not configured' }, { status: 500 })

  const signature = req.headers.get('stripe-signature')
  if (!signature) return NextResponse.json({ error: 'Missing Stripe signature' }, { status: 400 })

  // The signature is verified on the RAW body; only a verified event is ever used.
  const body = await req.text()
  let event
  try {
    event = getStripe().webhooks.constructEvent(body, signature, secret)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Invalid Stripe signature' }, { status: 400 })
  }

  try {
    const result = await handleStripeWebhookEvent(event)
    return NextResponse.json({ received: true, ...result })
  } catch (err) {
    // Recoverable by design: the transaction was rolled back, so the retry will process the event from scratch.
    incrementMetric('stripe_webhook_failures_total', 1, { type: event.type })
    await captureError(err, { category: 'stripe_webhook', route: '/api/stripe/webhook', eventId: event.id, eventType: event.type })
    // Do not leak internal details to the caller.
    return NextResponse.json({ received: false, error: 'processing_failed', retry: true }, { status: 500 })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/stripe/webhook' })
