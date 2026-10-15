import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { viewerGuards } from '@/lib/viewer'
import { isSameOriginRequest } from '@/lib/csrf'
import { buildCardQuote, CheckoutQuoteError } from '@/lib/checkout-quote'
import { enforceCheckoutRateLimit, jsonError, jsonNoStore, readJsonBody } from '@/lib/checkout-api'
import { createManualQuoteOrder, manualQuoteRequestSchema, ManualQuoteError } from '@/lib/manual-quote'
import { resolveInternalBaseUrl } from '@/lib/public-url'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'

export const dynamic = 'force-dynamic'

// "Ask for a manual quote": the cart cannot be paid online because no machine can make some line automatically. The SERVER decides that again here
// (it prices the cart exactly as the quote and the payment do): a cart that CAN be paid online is refused (409), so this is never a way around the
// automatic checkout, and the reasons stored come from the server, never from the browser. Creates an `awaiting_review` request with no price and no
// payment (lib/manual-quote.ts); nothing is ever sent to Stripe.
async function handlePost(req: NextRequest) {
  try {
    if (!isSameOriginRequest(req)) return jsonError(403, 'INVALID_ORIGIN', 'Invalid request origin.')
    const viewer = await viewerGuards.getViewer()
    const limited = await enforceCheckoutRateLimit(req, 'manual', viewer?.id ?? null)
    if (limited) return limited

    const raw = await readJsonBody(req)
    if ('response' in raw) return raw.response
    const parsed = manualQuoteRequestSchema.safeParse(raw.data)
    if (!parsed.success) return jsonError(400, 'INVALID_REQUEST', 'Invalid request.')
    const request = parsed.data

    let reviews: NonNullable<CheckoutQuoteError['details']>['reviews']
    try {
      await buildCardQuote({ items: request.items, shippingMethod: request.shipping.method, rush: request.rush, publicBaseUrl: resolveInternalBaseUrl(req) })
    } catch (err) {
      if (err instanceof CheckoutQuoteError && err.code === 'MANUAL_REVIEW_REQUIRED' && err.details?.reviews?.length) reviews = err.details.reviews
      else throw err
    }
    if (!reviews) return jsonError(409, 'REVIEW_NOT_REQUIRED', 'This cart can be paid online: no manual quote is needed.')

    const principal = viewer
      ? await prisma.user.findUnique({ where: { id: viewer.id }, select: { id: true, email: true, name: true } })
      : null
    const result = await createManualQuoteOrder({ principal, request, reviews })
    return jsonNoStore({ ok: true, orderNumber: result.orderNumber, created: result.created }, { status: result.created ? 201 : 200 })
  } catch (err: any) {
    if (err instanceof ManualQuoteError) return jsonError(err.status, err.code, err.message)
    if (err instanceof CheckoutQuoteError) return jsonError(err.status, err.code || 'QUOTE_REJECTED', err.message, err.details ? { details: err.details } : {})
    await captureError(err, { category: 'checkout_manual_request', route: '/api/checkout/manual-request' })
    return jsonError(500, 'MANUAL_REQUEST_FAILED', 'The request could not be sent. Please try again.', { retry: true })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout/manual-request' })
