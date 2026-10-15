// Small helpers shared by the hosted-checkout endpoints (quote, session).
import { NextResponse, type NextRequest } from 'next/server'
import { consumeFixedWindow, getCheckoutRateLimitConfig, getRequestIp } from '@/lib/rate-limit'
import { UNKNOWN_IP } from '@/lib/client-ip'
import { getTaxConfig } from '@/lib/tax'
import { getShippingConfig, SHIPPING_LABEL } from '@/lib/shipping'
import { toCents } from '@/lib/currency'
import type { CardQuote } from '@/lib/checkout-quote'
import type { CheckoutBlocker } from '@/lib/checkout-guards'

const MAX_BODY_BYTES = 100_000

// Money and personal data: never cached anywhere.
export function jsonNoStore(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { 'Cache-Control': 'no-store', ...(init.headers || {}) },
  })
}

export function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return jsonNoStore({ error: message, code, ...extra }, { status, headers })
}

export async function readJsonBody(req: NextRequest): Promise<{ data: unknown } | { response: NextResponse }> {
  const type = (req.headers.get('content-type') || '').toLowerCase()
  if (!type.startsWith('application/json')) {
    return { response: jsonError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request as application/json.') }
  }
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) return { response: jsonError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.') }
  try {
    return { data: JSON.parse(text) }
  } catch {
    return { response: jsonError(400, 'INVALID_REQUEST', 'The request is not valid JSON.') }
  }
}

// Per address, per signed-in user, and for the whole shop. Only an address a proxy of ours wrote is believed (lib/client-ip.ts), and
// when it cannot be told ("unknown") the per-address counter is left out instead of becoming one counter shared by everybody:
// the whole-shop, per-user and (for the status page) per-order counters do not depend on the address and always apply.
export async function enforceCheckoutRateLimit(req: NextRequest, kind: 'quote' | 'session', userId: string | null) {
  const cfg = getCheckoutRateLimitConfig(kind)
  const ip = getRequestIp(req)
  const checks = [consumeFixedWindow(`checkout:${kind}:all`, getCheckoutRateLimitConfig('global'))]
  if (ip !== UNKNOWN_IP) checks.push(consumeFixedWindow(`checkout:${kind}:ip:${ip}`, cfg))
  if (userId) checks.push(consumeFixedWindow(`checkout:${kind}:user:${userId}`, cfg))
  const results = await Promise.all(checks)
  const blocked = results.find((r) => !r.allowed)
  if (!blocked) return null
  const retryAfter = String(blocked.retryAfterSeconds ?? 60)
  return jsonError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', { retryAfterSeconds: Number(retryAfter) }, { 'Retry-After': retryAfter })
}

// The order status endpoint: per address, per order and for the whole shop. Counted BEFORE anything is looked up.
export async function enforceStatusRateLimit(req: NextRequest, orderId: string) {
  const cfg = getCheckoutRateLimitConfig('status')
  const ip = getRequestIp(req)
  const checks = [
    consumeFixedWindow(`checkout:status:order:${orderId}`, cfg),
    consumeFixedWindow('checkout:status:all', getCheckoutRateLimitConfig('status_global')),
  ]
  if (ip !== UNKNOWN_IP) checks.push(consumeFixedWindow(`checkout:status:ip:${ip}`, cfg))
  const results = await Promise.all(checks)
  const blocked = results.find((r) => !r.allowed)
  return blocked ? { retryAfterSeconds: Number(blocked.retryAfterSeconds ?? 60) } : null
}

// Asking Stripe again from the status endpoint is allowed once every STATUS_REFRESH_MIN_INTERVAL_MS per order, and at most
// STATUS_REFRESH_GLOBAL_MAX times a minute for the whole shop (Stripe has its own limits and this must never be a way to use them up).
export const STATUS_REFRESH_MIN_INTERVAL_MS = 4000
const STATUS_REFRESH_GLOBAL_MAX = 300
export async function allowStripeRefresh(orderId: string): Promise<boolean> {
  const [perOrder, whole] = await Promise.all([
    consumeFixedWindow(`checkout:status-sync:order:${orderId}`, { windowMs: STATUS_REFRESH_MIN_INTERVAL_MS, max: 1 }),
    consumeFixedWindow('checkout:status-sync:all', { windowMs: 60_000, max: STATUS_REFRESH_GLOBAL_MAX }),
  ])
  return perOrder.allowed && whole.allowed
}

// What the page needs to show the costs. Whole cents and a currency code: the page formats them, nothing is computed there.
// Deliberately NOT included: file paths, internal ids of parts, pricing internals, other people's data.
export function toQuoteResponse(quote: CardQuote, blocker: CheckoutBlocker | null) {
  const { lineItems, totals, discountSummary } = quote
  const tax = getTaxConfig()
  const shippingConfig = getShippingConfig()
  return {
    currency: totals.currencyCode,
    items: lineItems.map((item) => ({
      title: item.title,
      partName: item.partName ?? null,
      qty: item.qty,
      material: item.material,
      colors: item.colors ?? [],
      finish: item.finish ?? null,
      unitPriceCents: toCents(item.unitPrice),
      lineTotalCents: toCents(item.lineTotal),
      undiscountedLineTotalCents: toCents(item.undiscountedLineTotal ?? item.lineTotal),
      discountPercent: item.discountPercent ?? 0,
      // the server's own estimate of how long the part takes (hours), or null when it has none
      leadTimeHours: typeof item.leadTimeHours === 'number' && Number.isFinite(item.leadTimeHours) ? item.leadTimeHours : null,
    })),
    itemsTotalCents: totals.itemsTotalCents,
    discountPercent: discountSummary.totalPercent,
    shipping: {
      method: quote.shippingPayload.method,
      cents: totals.shippingAmountCents,
      label: totals.shippingRate?.label ?? null,
    },
    // What delivery choices exist and what shipping costs, whichever one is selected in this quote (so the page can show both
    // without asking twice). Whole cents; the figure that is charged is `shipping.cents` of the selected choice.
    shippingOffer: {
      shipAvailable: shippingConfig.configured,
      shipCents: shippingConfig.configured ? shippingConfig.cents : null,
      shipLabel: SHIPPING_LABEL,
      shipCountries: ['IT'],
    },
    tax: {
      mode: tax.mode,
      ratePercent: tax.ratePercent,
      cents: totals.taxCents,
      // "inclusive": already inside the prices above. "exclusive": added to the total below.
      addedToTotal: tax.mode === 'exclusive',
    },
    totalCents: totals.amount,
    canCheckout: blocker === null,
    unavailableReason: blocker ? blocker.code : null,
  }
}

// The answer of /api/checkout/quote as the page receives it (type only: nothing of this module reaches the browser bundle).
export type QuoteResponse = ReturnType<typeof toQuoteResponse>
