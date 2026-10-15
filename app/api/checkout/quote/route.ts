import { NextRequest } from 'next/server'
import { z } from 'zod'
import { viewerGuards } from '@/lib/viewer'
import { buildCardQuote, CheckoutQuoteError, checkoutItemSchema } from '@/lib/checkout-quote'
import { getCheckoutBlocker } from '@/lib/checkout-guards'
import { enforceCheckoutRateLimit, jsonError, jsonNoStore, readJsonBody, toQuoteResponse } from '@/lib/checkout-api'
import { resolveInternalBaseUrl } from '@/lib/public-url'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'

export const dynamic = 'force-dynamic'

// What the customer will be asked to pay, computed by the server from the cart. Creates nothing: no order, no Stripe object.
// Only the cart and the delivery choice are read from the request; any price, total or status sent by the browser is refused.
const bodySchema = z.object({
  items: z.array(checkoutItemSchema).min(1).max(50),
  shipping: z.object({ method: z.enum(['pickup', 'ship']) }).strict().default({ method: 'pickup' }),
  rush: z.boolean().optional().default(false),
}).strict()

async function handlePost(req: NextRequest) {
  try {
    const viewer = await viewerGuards.getViewer()
    const limited = await enforceCheckoutRateLimit(req, 'quote', viewer?.id ?? null)
    if (limited) return limited

    const raw = await readJsonBody(req)
    if ('response' in raw) return raw.response
    const parsed = bodySchema.safeParse(raw.data)
    if (!parsed.success) return jsonError(400, 'INVALID_REQUEST', 'Invalid cart payload')
    const { items, shipping, rush } = parsed.data

    const quote = await buildCardQuote({ items, shippingMethod: shipping.method, rush, publicBaseUrl: resolveInternalBaseUrl(req) })
    const blocker = getCheckoutBlocker({ shippingMethod: shipping.method, minimumOrderSubtotal: quote.ctx.cfg?.minimumOrderSubtotalUsd ?? null })
    return jsonNoStore(toQuoteResponse(quote, blocker))
  } catch (err: any) {
    if (err instanceof CheckoutQuoteError) return jsonError(err.status, err.code || 'QUOTE_REJECTED', err.message, err.details ? { details: err.details } : {})
    await captureError(err, { category: 'checkout_quote', route: '/api/checkout/quote' })
    return jsonError(500, 'QUOTE_FAILED', 'The quote could not be calculated.')
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout/quote' })
