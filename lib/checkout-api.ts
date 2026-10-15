// Small helpers shared by the hosted-checkout endpoints (quote, session).
import { NextResponse, type NextRequest } from 'next/server'
import { consumeFixedWindow, getCheckoutRateLimitConfig, getRequestIp } from '@/lib/rate-limit'
import { getTaxConfig } from '@/lib/tax'
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

// Per address, per signed-in user, and for the whole shop (so a forged X-Forwarded-For cannot lift the limit).
export async function enforceCheckoutRateLimit(req: NextRequest, kind: 'quote' | 'session', userId: string | null) {
  const cfg = getCheckoutRateLimitConfig(kind)
  const checks = [
    consumeFixedWindow(`checkout:${kind}:ip:${getRequestIp(req)}`, cfg),
    consumeFixedWindow(`checkout:${kind}:all`, getCheckoutRateLimitConfig('global')),
  ]
  if (userId) checks.push(consumeFixedWindow(`checkout:${kind}:user:${userId}`, cfg))
  const results = await Promise.all(checks)
  const blocked = results.find((r) => !r.allowed)
  if (!blocked) return null
  const retryAfter = String(blocked.retryAfterSeconds ?? 60)
  return jsonError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', { retryAfterSeconds: Number(retryAfter) }, { 'Retry-After': retryAfter })
}

// What the page needs to show the costs. Whole cents and a currency code: the page formats them, nothing is computed there.
// Deliberately NOT included: file paths, internal ids of parts, pricing internals, other people's data.
export function toQuoteResponse(quote: CardQuote, blocker: CheckoutBlocker | null) {
  const { lineItems, totals, discountSummary } = quote
  const tax = getTaxConfig()
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
    })),
    itemsTotalCents: totals.itemsTotalCents,
    discountPercent: discountSummary.totalPercent,
    shipping: {
      method: quote.shippingPayload.method,
      cents: totals.shippingAmountCents,
      label: totals.shippingRate?.label ?? null,
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
