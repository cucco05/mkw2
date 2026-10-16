// The browser side of the card checkout: how the cart becomes a request, how the answers are understood, and the key that makes
// "pay" safe to repeat. Plain functions, no React, so every rule here is tested without a browser (tests/checkout-client.test.ts).
//
// Nothing here decides a price: the request carries WHAT is wanted (model, quantity, options); the server answers what it costs
// (/api/checkout/quote) and charges exactly that (/api/checkout/session). The page only shows the server's whole cents.
import { DIMENSION_AXES, MAX_CART_COLORS, normalizeColors, normalizeMaterialName, resolveAxisScale } from '@/lib/cartPricing'
import type { CartItem } from '@/components/cart/CartProvider'
import type { QuoteResponse } from '@/lib/checkout-api'
import { SET_KEY_PATTERN } from '@/lib/cart-groups'
import { canonicalCartItemsWith, canonicalJson, smallHash } from '@/lib/cart-canonical-core'

export { SET_KEY_PATTERN }

export type DeliveryMethod = 'pickup' | 'ship'
export type ServerQuote = QuoteResponse

export const MAX_CART_LINES = 50
export const MAX_LINE_QTY = 50
const TOLERANCE_CLASSES = ['draft', 'standard', 'cosmetic', 'fit_critical'] as const
// Same shape zod's cuid() accepts on the server; anything else is left out instead of making the whole cart invalid.
const CUID_LIKE = /^c[^\s-]{8,}$/i

export type QuoteRequestItem = {
  modelId: string
  partId?: string
  productTemplateId?: string
  qty: number
  scale: number
  scaleX: number
  scaleY: number
  scaleZ: number
  lockDimensions: boolean
  material: string
  colors: string[]
  toleranceClass?: (typeof TOLERANCE_CLASSES)[number]
  finish?: string
  infillPct?: number
  customText?: string
  // the lines that share a key claim to be ONE complete copy of a model made of several parts; the server checks the claim (lib/sale-units.ts)
  setKey?: string
}
export type QuoteRequest = { items: QuoteRequestItem[]; shipping: { method: DeliveryMethod }; rush: boolean }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// The cart line as the server's schema wants it: no nulls where the schema refuses them, no price of any kind (a
// `priceMultiplier` kept in an old cart is deliberately NOT sent: the server works the multiplier out itself).
export function toQuoteItem(item: CartItem): QuoteRequestItem {
  const locked = item.options.lockDimensions !== false
  const overrides = locked ? null : item.options.dimensionOverrides
  const axis = { x: 1, y: 1, z: 1 }
  for (const name of DIMENSION_AXES) axis[name] = clamp(resolveAxisScale(item.options.scale, overrides, name), 0.1, 5)
  const line: QuoteRequestItem = {
    modelId: item.modelId,
    qty: Math.round(clamp(Number(item.options.qty) || 1, 1, MAX_LINE_QTY)),
    scale: clamp(Math.cbrt(axis.x * axis.y * axis.z), 0.1, 5),
    scaleX: axis.x,
    scaleY: axis.y,
    scaleZ: axis.z,
    lockDimensions: locked,
    material: normalizeMaterialName(item.options.material || 'PLA').slice(0, 40),
    colors: normalizeColors(item.options.colors).slice(0, MAX_CART_COLORS).map((color) => color.slice(0, 64)),
  }
  if (item.partId) line.partId = item.partId
  if (item.setKey && SET_KEY_PATTERN.test(item.setKey)) line.setKey = item.setKey
  if (item.options.productTemplateId && CUID_LIKE.test(item.options.productTemplateId)) line.productTemplateId = item.options.productTemplateId
  if (item.options.toleranceClass && (TOLERANCE_CLASSES as readonly string[]).includes(item.options.toleranceClass)) line.toleranceClass = item.options.toleranceClass
  if (item.options.finish) line.finish = String(item.options.finish).slice(0, 40)
  if (typeof item.options.infillPct === 'number' && Number.isFinite(item.options.infillPct)) line.infillPct = Math.round(clamp(item.options.infillPct, 0, 100))
  if (item.options.customText) line.customText = String(item.options.customText).slice(0, 140)
  return line
}

export function buildQuoteRequest(items: CartItem[], choice: { shippingMethod: DeliveryMethod; rush: boolean }): QuoteRequest {
  return { items: items.slice(0, MAX_CART_LINES).map(toQuoteItem), shipping: { method: choice.shippingMethod }, rush: choice.rush }
}

// Same request = same text, whatever the order the keys were written in. Used to remember quotes and to decide when "pay" is the
// same payment as before.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
export const quoteSignature = (request: QuoteRequest) => stableStringify(request)
// What the cart holds, whatever the delivery or rush: the memory of "this cart was sent to the payment page" (lib/order-status-client.ts) compares it
// with the cart in front of the customer, on the cart, the checkout and the return pages alike.
// The random keys that group the lines of a complete model are NOT part of it: a group is named by its content (and the lines are sorted), so taking a model
// apart and putting it together again, or a cart rebuilt in another order, is still "this cart" (the server compares the same way: lib/cart-canonical.ts).
export const cartItemsSignature = (items: CartItem[]) => canonicalJson(canonicalCartItemsWith(items.slice(0, MAX_CART_LINES).map(toQuoteItem), smallHash))

// ---- the key that makes "pay" safe to repeat -----------------------------------------------------------------------------------
// Pressing pay twice, reloading, or coming back from the payment page with the same cart and the same total must give the SAME
// order and the same payment page; a different cart or total is a different payment and gets a new key.
export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const KEY_STORAGE = 'mw:checkout-key:v1'
type KeyStorage = Pick<Storage, 'getItem' | 'setItem'>
let memoryKey: { signature: string; totalCents: number; key: string } | null = null

export function newCheckoutKey(): string {
  const bytes = new Uint8Array(24)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  const encoded = (typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'binary').toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `k${encoded}`.slice(0, 40)
}

export function resolveCheckoutKey(storage: KeyStorage | null, signature: string, totalCents: number, makeKey: () => string = newCheckoutKey): string {
  let stored: { signature?: unknown; totalCents?: unknown; key?: unknown } | null = memoryKey
  try {
    const raw = storage?.getItem(KEY_STORAGE)
    if (raw) stored = JSON.parse(raw)
  } catch { /* storage blocked or damaged: the in-memory copy still protects a double click on this page */ }
  if (stored && stored.signature === signature && stored.totalCents === totalCents && typeof stored.key === 'string' && CHECKOUT_KEY_PATTERN.test(stored.key)) {
    return stored.key
  }
  const fresh = { signature, totalCents, key: makeKey() }
  memoryKey = fresh
  try { storage?.setItem(KEY_STORAGE, JSON.stringify(fresh)) } catch { /* see above */ }
  return fresh.key
}
// A key that the server turned down (CHECKOUT_KEY_CONFLICT): forget it so the next attempt starts clean.
export function forgetCheckoutKey(storage: KeyStorage | null) {
  memoryKey = null
  try { storage?.setItem(KEY_STORAGE, '') } catch { /* nothing to forget */ }
}

// ---- understanding the answers --------------------------------------------------------------------------------------------------
export type FailureKind =
  | 'network'              // no answer at all: nothing was charged, trying again is safe
  | 'busy'                 // too many requests: wait a little
  | 'items'                // some cart lines can not be sold any more
  | 'option'               // a colour / option of a line is not available any more
  | 'minimum'              // below the shop's minimum order
  | 'payment_minimum'      // below the smallest card payment the payment provider accepts
  | 'review'               // no machine can make some line automatically: a person has to look at it (manual quote)
  | 'price_changed'        // the total is not the one that was shown
  | 'not_payable'          // this order can not get a new payment page (already paid / being paid / closed)
  | 'payment_in_progress'  // a payment for exactly this cart is being confirmed (or waits for a person): do not pay again
  | 'too_many_attempts'    // too many payment pages for the same order
  | 'conflict'             // the repeat-key was used for another cart
  | 'disabled'             // online card payment is not available right now
  | 'shipping_unavailable' // shipping is not offered right now
  | 'temporary'            // the payment service did not answer well: the same request can be repeated
  | 'invalid'              // the request itself was refused
  | 'unknown'

// Why a line goes to manual review (the server decides: lib/printability.ts). Sizes are whole millimetres.
export type ReviewReasonInfo = { code: string; sizeMm?: { x: number; y: number; z: number }; usableMm?: { x: number; y: number; z: number }; value?: string }
export type ReviewLine = { itemIndex: number; reasons: ReviewReasonInfo[] }

export type CheckoutFailure = {
  kind: FailureKind
  code: string
  status: number
  retryAfterSeconds?: number
  itemIndexes?: number[]
  minimumCents?: number
  itemsTotalCents?: number
  totalCents?: number
  currentTotalCents?: number
  orderId?: string
  reviews?: ReviewLine[]
  // whether repeating the SAME request (same key) is the right thing to do
  retry: boolean
}

const KIND_BY_CODE: Record<string, FailureKind> = {
  INVALID_REQUEST: 'invalid',
  INVALID_ORIGIN: 'invalid',
  UNSUPPORTED_MEDIA_TYPE: 'invalid',
  PAYLOAD_TOO_LARGE: 'invalid',
  TOTAL_INVALID: 'invalid',
  RATE_LIMITED: 'busy',
  ITEM_UNAVAILABLE: 'items',
  ITEM_NOT_PRICEABLE: 'items',
  OPTION_UNAVAILABLE: 'option',
  COLOR_REQUIRED: 'option',
  COLOR_INVALID: 'option',
  COLOR_NOT_ALLOWED: 'option',
  COLOR_UNAVAILABLE: 'option',
  MINIMUM_ORDER: 'minimum',
  BELOW_PAYMENT_MINIMUM: 'payment_minimum',
  MANUAL_REVIEW_REQUIRED: 'review',
  PRICE_CHANGED: 'price_changed',
  ORDER_NOT_PAYABLE: 'not_payable',
  PAYMENT_IN_PROGRESS: 'payment_in_progress',
  TOO_MANY_ATTEMPTS: 'too_many_attempts',
  CHECKOUT_KEY_CONFLICT: 'conflict',
  CHECKOUT_DISABLED: 'disabled',
  PAYMENTS_NOT_CONFIGURED: 'disabled',
  TAX_NOT_CONFIGURED: 'disabled',
  CURRENCY_NOT_CONFIGURED: 'disabled',
  CURRENCY_INVALID: 'disabled',
  CURRENCY_MISMATCH: 'disabled',
  MINIMUM_ORDER_NOT_CONFIGURED: 'disabled',
  CHECKOUT_UNAVAILABLE: 'disabled',
  SHIPPING_NOT_CONFIGURED: 'shipping_unavailable',
  PAYMENT_PROVIDER_UNAVAILABLE: 'temporary',
  PAYMENT_PROVIDER_ERROR: 'temporary',
  TEMPORARY_ERROR: 'temporary',
  CHECKOUT_FAILED: 'temporary',
  QUOTE_FAILED: 'temporary',
}

const integers = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((entry): entry is number => Number.isInteger(entry) && entry >= 0 && entry < 1000)
  return list.length ? list : undefined
}
const mmSize = (value: unknown): { x: number; y: number; z: number } | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const x = Number(v.x); const y = Number(v.y); const z = Number(v.z)
  return [x, y, z].every((n) => Number.isFinite(n) && n >= 0 && n < 100000) ? { x, y, z } : undefined
}
function parseReviews(value: unknown): ReviewLine[] | undefined {
  if (!Array.isArray(value)) return undefined
  const lines: ReviewLine[] = []
  for (const entry of value.slice(0, 50)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (!Number.isInteger(record.itemIndex) || (record.itemIndex as number) < 0 || (record.itemIndex as number) >= 1000 || !Array.isArray(record.reasons)) continue
    const reasons: ReviewReasonInfo[] = []
    for (const reason of record.reasons.slice(0, 8)) {
      if (!reason || typeof reason !== 'object' || typeof (reason as any).code !== 'string') continue
      const r = reason as Record<string, unknown>
      reasons.push({
        code: String(r.code).slice(0, 40),
        ...(mmSize(r.sizeMm) ? { sizeMm: mmSize(r.sizeMm) } : {}),
        ...(mmSize(r.usableMm) ? { usableMm: mmSize(r.usableMm) } : {}),
        ...(typeof r.value === 'string' ? { value: r.value.slice(0, 40) } : {}),
      })
    }
    if (reasons.length) lines.push({ itemIndex: record.itemIndex as number, reasons })
  }
  return lines.length ? lines : undefined
}
const wholeNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined)

export function classifyFailure(status: number, body: unknown, retryAfterHeader?: string | null): CheckoutFailure {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  const code = typeof data.code === 'string' ? data.code : ''
  const kind = KIND_BY_CODE[code] ?? (status >= 500 ? 'temporary' : 'unknown')
  const details = data.details && typeof data.details === 'object' ? data.details as Record<string, unknown> : {}
  const headerSeconds = retryAfterHeader && /^\d{1,5}$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader) : undefined
  const failure: CheckoutFailure = {
    kind,
    code,
    status,
    retry: kind === 'temporary' || kind === 'network' ? data.retry !== false : false,
  }
  const retryAfter = wholeNumber(data.retryAfterSeconds) ?? headerSeconds
  if (retryAfter !== undefined) failure.retryAfterSeconds = clamp(retryAfter, 1, 3600)
  const indexes = integers(details.itemIndexes) ?? (Number.isInteger(details.itemIndex) ? integers([details.itemIndex]) : undefined)
  if (indexes) failure.itemIndexes = indexes
  const minimumCents = wholeNumber(details.minimumCents)
  if (minimumCents !== undefined) failure.minimumCents = minimumCents
  const itemsTotalCents = wholeNumber(details.itemsTotalCents)
  if (itemsTotalCents !== undefined) failure.itemsTotalCents = itemsTotalCents
  const totalCents = wholeNumber(details.totalCents)
  if (totalCents !== undefined) failure.totalCents = totalCents
  const reviews = parseReviews(details.reviews)
  if (reviews) failure.reviews = reviews
  const current = wholeNumber(data.currentTotalCents)
  if (current !== undefined) failure.currentTotalCents = current
  if (typeof data.orderId === 'string' && data.orderId.length <= 64) failure.orderId = data.orderId
  return failure
}

export const NETWORK_FAILURE: CheckoutFailure = { kind: 'network', code: 'NETWORK', status: 0, retry: true }

// Enough of a quote to be sure the page can show it: whole cents everywhere. Anything else is treated as a failed answer.
export function isUsableQuote(value: unknown): value is ServerQuote {
  if (!value || typeof value !== 'object') return false
  const quote = value as Record<string, any>
  const cents = (n: unknown) => Number.isInteger(n) && (n as number) >= 0
  return typeof quote.currency === 'string'
    && Array.isArray(quote.items) && quote.items.length > 0
    && quote.items.every((line: any) => line && cents(line.unitPriceCents) && cents(line.lineTotalCents) && Number.isInteger(line.qty))
    && cents(quote.itemsTotalCents) && cents(quote.totalCents)
    && !!quote.shipping && cents(quote.shipping.cents)
    && !!quote.tax && cents(quote.tax.cents)
    && !!quote.shippingOffer && typeof quote.shippingOffer.shipAvailable === 'boolean'
    && typeof quote.canCheckout === 'boolean'
}

export type QuoteResult = { ok: true; quote: ServerQuote } | { ok: false; failure: CheckoutFailure }
export type SessionResult = { ok: true; url: string; orderId: string; orderNumber: number; totalCents: number } | { ok: false; failure: CheckoutFailure }

async function readJson(res: Response): Promise<unknown> {
  try { return await res.json() } catch { return null }
}

export async function requestQuote(request: QuoteRequest, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<QuoteResult> {
  let res: Response
  try {
    res = await fetcher('/api/checkout/quote', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    return { ok: false, failure: NETWORK_FAILURE }
  }
  const body = await readJson(res)
  if (res.ok) {
    return isUsableQuote(body) ? { ok: true, quote: body } : { ok: false, failure: classifyFailure(502, null) }
  }
  return { ok: false, failure: classifyFailure(res.status, body, res.headers.get('Retry-After')) }
}

// The payment page may only be one of Stripe's: whatever the server sends, the browser is not sent anywhere else.
export function isStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password
  } catch {
    return false
  }
}

export async function requestSession(
  input: { request: QuoteRequest; expectedTotalCents: number; checkoutKey: string },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SessionResult> {
  let res: Response
  try {
    res = await fetcher('/api/checkout/session', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutKey: input.checkoutKey, expectedTotalCents: input.expectedTotalCents, ...input.request }),
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    return { ok: false, failure: NETWORK_FAILURE }
  }
  const body = await readJson(res) as Record<string, any> | null
  if (res.ok) {
    if (body && isStripeCheckoutUrl(body.url) && typeof body.orderId === 'string' && Number.isInteger(body.orderNumber) && Number.isInteger(body.totalCents)) {
      return { ok: true, url: body.url, orderId: body.orderId, orderNumber: body.orderNumber, totalCents: body.totalCents }
    }
    return { ok: false, failure: { ...classifyFailure(502, null), code: 'BAD_SESSION_ANSWER' } }
  }
  return { ok: false, failure: classifyFailure(res.status, body, res.headers.get('Retry-After')) }
}

// ---- asking for a manual quote ------------------------------------------------------------------------------------------------------
export type ManualRequestResult =
  | { ok: true; orderNumber: number }
  | { ok: false; failure: CheckoutFailure }

export async function requestManualQuote(
  input: { request: QuoteRequest; email: string; name: string; note: string },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ManualRequestResult> {
  const email = input.email.trim()
  const name = input.name.trim()
  const note = input.note.trim()
  let res: Response
  try {
    res = await fetcher('/api/checkout/manual-request', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input.request,
        ...(email || name ? { contact: { ...(email ? { email } : {}), ...(name ? { name } : {}) } } : {}),
        ...(note ? { note } : {}),
      }),
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    return { ok: false, failure: NETWORK_FAILURE }
  }
  const body = await readJson(res) as Record<string, any> | null
  if (res.ok && body && Number.isInteger(body.orderNumber)) return { ok: true, orderNumber: body.orderNumber }
  return { ok: false, failure: classifyFailure(res.status, body, res.headers.get('Retry-After')) }
}

// Lines of the quote the failure points at, to be shown in the summary.
export function affectedLines(failure: CheckoutFailure | null, lineCount: number): Set<number> {
  const set = new Set<number>()
  for (const index of failure?.itemIndexes ?? []) if (index < lineCount) set.add(index)
  return set
}
