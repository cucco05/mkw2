import { NextRequest } from 'next/server'
import { z } from 'zod'
import { viewerGuards } from '@/lib/viewer'
import { shouldUseSecureCookies } from '@/lib/auth'
import { buildCardQuote, CheckoutQuoteError, checkoutItemSchema } from '@/lib/checkout-quote'
import { getCheckoutBlocker } from '@/lib/checkout-guards'
import { enforceCheckoutRateLimit, jsonError, jsonNoStore, readJsonBody, toQuoteResponse } from '@/lib/checkout-api'
import { GUEST_SESSION_COOKIE, planGuestSession, setGuestSessionCookie, type SealedGuestSession } from '@/lib/guest-session'
import { resolveInternalBaseUrl } from '@/lib/public-url'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'
import { logEvent } from '@/lib/observability-logger'

export const dynamic = 'force-dynamic'

// What the customer will be asked to pay, computed by the server from the cart. Creates nothing: no order, no Stripe object.
// Only the cart and the delivery choice are read from the request; any price, total or status sent by the browser is refused.
//
// The one thing it does hand out is the browser's session (step 4.6, S5): a guest that has none valid gets a signed cookie here, before the payment page exists,
// so that "pay" - which is only offered after a quote - already finds it (lib/guest-session.ts). It is the only thing in the answer that depends on the browser,
// and the answer is never cached.
const bodySchema = z.object({
  items: z.array(checkoutItemSchema).min(1).max(50),
  shipping: z.object({ method: z.enum(['pickup', 'ship']) }).strict().default({ method: 'pickup' }),
  rush: z.boolean().optional().default(false),
}).strict()

async function handlePost(req: NextRequest) {
  try {
    const viewer = await viewerGuards.getViewer()
    const principalId = viewer?.id ?? null
    // What a guest's request needs: its session, and the cookie to send back when it had none valid (or it is old enough to be renewed). A problem with the
    // server's secret must not stop a customer from seeing a price: the quote is then answered without a cookie (and "pay" will say what is wrong).
    let plan: ReturnType<typeof planGuestSession> | null = null
    if (!principalId) {
      try { plan = planGuestSession(req.cookies.get(GUEST_SESSION_COOKIE)?.value) } catch (err) {
        logEvent({ event: 'checkout.quote', level: 'error', outcome: 'guest_session_unavailable', message: err instanceof Error ? err.message : 'error' })
      }
    }
    const limited = await enforceCheckoutRateLimit(req, 'quote', principalId, plan && !plan.fresh ? plan.session.hash : null)
    if (limited) return limited

    const raw = await readJsonBody(req)
    if ('response' in raw) return raw.response
    const parsed = bodySchema.safeParse(raw.data)
    if (!parsed.success) return jsonError(400, 'INVALID_REQUEST', 'Invalid cart payload')
    const { items, shipping, rush } = parsed.data

    const quote = await buildCardQuote({ items, shippingMethod: shipping.method, rush, publicBaseUrl: resolveInternalBaseUrl(req) })
    const blocker = getCheckoutBlocker({ shippingMethod: shipping.method, minimumOrderSubtotal: quote.ctx.cfg?.minimumOrderSubtotalUsd ?? null })
    const response = jsonNoStore(toQuoteResponse(quote, blocker))
    const send: SealedGuestSession | null = plan?.send ?? null
    if (send) setGuestSessionCookie(response, send, await shouldUseSecureCookies())
    return response
  } catch (err: any) {
    if (err instanceof CheckoutQuoteError) return jsonError(err.status, err.code || 'QUOTE_REJECTED', err.message, err.details ? { details: err.details } : {})
    await captureError(err, { category: 'checkout_quote', route: '/api/checkout/quote' })
    return jsonError(500, 'QUOTE_FAILED', 'The quote could not be calculated.')
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout/quote' })
