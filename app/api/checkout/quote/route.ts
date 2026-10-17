import { NextRequest } from 'next/server'
import { z } from 'zod'
import { viewerGuards } from '@/lib/viewer'
import { buildCardQuote, CheckoutQuoteError, checkoutItemSchema } from '@/lib/checkout-quote'
import { getCheckoutBlocker } from '@/lib/checkout-guards'
import { enforceCheckoutRateLimit, jsonError, jsonNoStore, readJsonBody, toQuoteResponse } from '@/lib/checkout-api'
import { planGuestSession, readGuestSessionCookie, setGuestSessionCookie, type SealedGuestSession } from '@/lib/guest-session'
import { resolveGuestCookieTransport } from '@/lib/guest-cookie-transport'
import { resolveInternalBaseUrl } from '@/lib/public-url'
import { withRequestObservability } from '@/lib/request-observability'
import { captureError } from '@/lib/error-tracking'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'

export const dynamic = 'force-dynamic'

// What the customer will be asked to pay, computed by the server from the cart. Creates nothing: no order, no Stripe object.
// Only the cart and the delivery choice are read from the request; any price, total or status sent by the browser is refused.
//
// The one thing it does hand out is the browser's session (step 4.6, S5): a guest that has none valid gets a signed cookie here, before the payment page exists,
// so that "pay" - which is only offered after a quote - already finds it (lib/guest-session.ts). It is the only thing in the answer that depends on the browser,
// and the answer is never cached. Over a connection that production should not be seeing (the proxy of ours says plain http) it hands out NOTHING - not the weaker
// cookie either - and the price is still shown (lib/guest-cookie-transport.ts).
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
    let secureCookie = false
    if (!principalId) {
      try {
        // how the cookie is named and flagged is decided from the configuration BEFORE it is read (lib/guest-cookie-transport.ts)
        const transport = await resolveGuestCookieTransport(req.headers)
        if (transport.mode === 'refuse') {
          incrementMetric('checkout_insecure_transport_total')
          logEvent({ event: 'checkout.quote', level: 'warn', outcome: 'insecure_transport', message: 'a guest asked for a quote over a connection the trusted proxy says is plain http: no session cookie is handed out' })
        } else {
          secureCookie = transport.mode === 'secure'
          plan = planGuestSession(readGuestSessionCookie(req.cookies, secureCookie))
        }
      } catch (err) {
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
    if (send) setGuestSessionCookie(response, send, secureCookie)
    return response
  } catch (err: any) {
    if (err instanceof CheckoutQuoteError) return jsonError(err.status, err.code || 'QUOTE_REJECTED', err.message, err.details ? { details: err.details } : {})
    await captureError(err, { category: 'checkout_quote', route: '/api/checkout/quote' })
    return jsonError(500, 'QUOTE_FAILED', 'The quote could not be calculated.')
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout/quote' })
