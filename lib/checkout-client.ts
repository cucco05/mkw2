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
import { CHECKOUT_KEY_RANDOM_BYTES, checkoutKeyFromBytes, isStrongCheckoutKey } from '@/lib/checkout-key-format'

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
//
// (R1-1a) The key comes from Web Crypto and from nowhere else: 24 bytes from crypto.getRandomValues, with no pseudo-random fallback of any kind. Only a STRONG key - the
// shape of lib/checkout-key-format.ts: "k" + 32 base64url characters, at least 16 of them different - is ever kept, reused or sent. When none can be made (no Web Crypto, one
// that throws, one that gives degenerate bytes) there is NO key - "", never one that merely looks valid - and requestSession then sends nothing and says so. None of this
// throws: an exception inside the pay button would leave it locked. The shape is a filter, not a proof of randomness: this is the client's half of the contract - the server holds
// a guest to the same shape (R1-1b, lib/purchase-intent.ts) and keeps one order per key - and R1 stays open.
export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const KEY_STORAGE = 'mw:checkout-key:v1'
export type KeyStorage = Pick<Storage, 'getItem' | 'setItem'>

// (R1-2) The shape of an order id, the same as lib/checkout-status.ts ORDER_ID_PATTERN (tests/checkout-single-flight.test.ts holds the two together). Written here again because that
// module reaches node:crypto and this one runs in the browser.
export const CHECKOUT_ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

// (R1-2) What the page remembers of the key it made, apart from the storage - it is what still protects a double click when the storage refuses to keep anything. It is a value of its own
// (one per page, and a test can make as many as it likes to stand for several tabs) instead of a variable of the module.
export type CheckoutKeyMemory = { current: { signature: string; totalCents: number; key: string } | null }
export function createCheckoutKeyMemory(): CheckoutKeyMemory { return { current: null } }
const pageMemory = createCheckoutKeyMemory()

// (R1-2) The ONE entry of the browser's storage that holds the key: {signature, totalCents, key} and, once the server has named the order of the last request made with this key,
// signature and total, `orderId`. `orderId` is local bookkeeping and nothing else: it is never sent, it is not a credential, the server has never heard of it. It lets a verified
// payment prove that the key in the slot is THAT payment's key before anything is forgotten (settlePaidPurchase); an entry without it - written before R1-2, or one the server never
// named an order for - proves nothing about any order.
export type CheckoutKeyEntry = { signature: string; totalCents: number; key: string; orderId?: string }
// What the slot holds, told apart on purpose: an empty slot is not a damaged one, and neither is an unreadable storage.
export type CheckoutKeySlot =
  | { kind: 'unreadable' }                         // no storage, or reading it throws
  | { kind: 'absent' }                             // nothing was ever kept (or the browser's data was cleared)
  | { kind: 'forgotten' }                          // the placeholder: the key was forgotten on purpose
  | { kind: 'damaged' }                            // something is there and is not an entry of this format
  | { kind: 'entry'; entry: CheckoutKeyEntry }

function parseKeySlot(raw: string | null): CheckoutKeySlot {
  if (raw === null) return { kind: 'absent' }
  if (raw === '') return { kind: 'forgotten' }
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'damaged' }
    const { signature, totalCents, key, orderId } = value
    if (typeof signature !== 'string' || !signature || typeof totalCents !== 'number' || !Number.isInteger(totalCents) || totalCents < 0 || !isStrongCheckoutKey(key)) return { kind: 'damaged' }
    // an `orderId` that is not an order id is no provenance at all
    const named = typeof orderId === 'string' && CHECKOUT_ORDER_ID_PATTERN.test(orderId) ? { orderId } : {}
    return { kind: 'entry', entry: { signature, totalCents, key, ...named } }
  } catch {
    return { kind: 'damaged' }
  }
}
export function readCheckoutKeySlot(storage: KeyStorage | null): CheckoutKeySlot {
  if (!storage) return { kind: 'unreadable' }
  try { return parseKeySlot(storage.getItem(KEY_STORAGE)) } catch { return { kind: 'unreadable' } }
}
export function readCheckoutKeyEntry(storage: KeyStorage | null): CheckoutKeyEntry | null {
  const slot = readCheckoutKeySlot(storage)
  return slot.kind === 'entry' ? slot.entry : null
}

// How many times Web Crypto is asked for the bytes of a key before giving up. Genuine random bytes fail the shape filter about 1.5 times in 10 million, so a second draw is
// already out of the ordinary; a generator that never passes (every byte the same) is not asked for ever.
const KEY_DRAWS = 4

export function newCheckoutKey(): string {
  try {
    const webCrypto = typeof crypto === 'undefined' ? null : crypto
    if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') return ''
    for (let draw = 0; draw < KEY_DRAWS; draw++) {
      const bytes = new Uint8Array(CHECKOUT_KEY_RANDOM_BYTES)
      webCrypto.getRandomValues(bytes)
      const key = checkoutKeyFromBytes(bytes)
      if (isStrongCheckoutKey(key)) return key
    }
  } catch { /* a Web Crypto that throws is as good as none: no key */ }
  return ''
}

export function resolveCheckoutKey(storage: KeyStorage | null, signature: string, totalCents: number, makeKey: () => string = newCheckoutKey, memory: CheckoutKeyMemory = pageMemory): string {
  let stored: { signature?: unknown; totalCents?: unknown; key?: unknown } | null = memory.current
  try {
    const raw = storage?.getItem(KEY_STORAGE)
    // (R1-2) The placeholder wins over the memory of this page: a key that was forgotten - here or in another tab - must not come back from the copy this page still holds (before, it did)
    if (raw === '') stored = null
    else if (raw) stored = JSON.parse(raw)
  } catch { /* storage blocked or damaged: the in-memory copy still protects a double click on this page */ }
  // only a strong key is reused: a stored value that merely fits the broad pattern of the server (an old key, a short or repetitive one) is no guarantee of anything
  if (stored && stored.signature === signature && stored.totalCents === totalCents && isStrongCheckoutKey(stored.key)) return stored.key
  let key = ''
  try { key = makeKey() } catch { key = '' }
  // no strong key: nothing is kept - not in memory, not in the storage - and the empty answer makes requestSession refuse before any request
  if (!isStrongCheckoutKey(key)) return ''
  memory.current = { signature, totalCents, key }
  try { storage?.setItem(KEY_STORAGE, JSON.stringify(memory.current)) } catch { /* see above */ }
  return key
}

// (R1-2) The server named the order of the request made with this key: write it into the entry, so that a verified payment of THAT order can prove the key is its own. Only into the
// very entry (key, signature and total) the request was made with, and never over another order: a slot that moved on to another purchase while the answer was on its way is left alone.
// Never throws; false when nothing was written.
export function stampCheckoutKeyOrder(storage: KeyStorage | null, made: { key: string; signature: string; totalCents: number }, orderId: string): boolean {
  if (!CHECKOUT_ORDER_ID_PATTERN.test(orderId)) return false
  const slot = readCheckoutKeySlot(storage)
  if (slot.kind !== 'entry') return false
  const { entry } = slot
  if (entry.key !== made.key || entry.signature !== made.signature || entry.totalCents !== made.totalCents) return false
  if (entry.orderId === orderId) return true
  if (entry.orderId) return false
  try { storage?.setItem(KEY_STORAGE, JSON.stringify({ ...entry, orderId })); return true } catch { return false }
}

// Forget the key: the next attempt starts clean. With `expect` only if the slot still holds what the caller means to forget - a key that was refused (`{ key }`), or the key of a payment
// that has been verified (`{ orderId }`): the slot is read again NOW, and a purchase that has taken it over since is never touched. Without `expect` it is unconditional (the tests, and
// nothing else, call it so). Returns whether the placeholder was written.
export function forgetCheckoutKey(storage: KeyStorage | null, expect?: { key: string } | { orderId: string }, memory: CheckoutKeyMemory = pageMemory): boolean {
  if (expect) {
    const slot = readCheckoutKeySlot(storage)
    if ('orderId' in expect) {
      if (slot.kind !== 'entry' || slot.entry.orderId !== expect.orderId) return false
    } else if (slot.kind === 'entry') {
      if (slot.entry.key !== expect.key) return false
    } else if (!(slot.kind === 'unreadable' && memory.current?.key === expect.key)) {
      return false
    }
  }
  memory.current = null
  try { storage?.setItem(KEY_STORAGE, ''); return true } catch { return false }
}

// ---- understanding the answers --------------------------------------------------------------------------------------------------
export type FailureKind =
  | 'network'              // no answer at all - for a QUOTE: nothing was charged, trying again is safe. (The payment request never gets this kind: its failures to answer are `outcome_unknown`.)
  | 'busy'                 // too many requests: wait a little
  | 'items'                // some cart lines can not be sold any more
  | 'option'               // a colour / option of a line is not available any more
  | 'minimum'              // below the shop's minimum order
  | 'payment_minimum'      // below the smallest card payment the payment provider accepts
  | 'review'               // no machine can make some line automatically: a person has to look at it (manual quote)
  | 'price_changed'        // the total is not the one that was shown
  | 'not_payable'          // this order can not get a new payment page (already paid / being paid / closed)
  | 'payment_in_progress'  // a payment for exactly this cart is being confirmed (or waits for a person): do not pay again
  | 'session_required'     // the server made nothing and handed this browser a session (cookie): the same request is sent ONCE more (requestSession does that)
  | 'cookies_blocked'      // ...and asked again it still found no session: this browser keeps no cookies, so a guest can not pay from it (the cart is untouched)
  | 'too_many_attempts'    // too many payment pages for the same order
  | 'conflict'             // the repeat-key was used for another cart
  | 'disabled'             // online card payment is not available right now
  | 'shipping_unavailable' // shipping is not offered right now
  | 'temporary'            // the payment service did not answer well: the same request can be repeated
  | 'invalid'              // the request itself was refused
  | 'crypto_unavailable'   // (R1-1a) this browser could not make the secure checkout key: NOTHING was sent, the cart is untouched; only this page can produce it
  | 'purchase_key_in_use'  // (R1-1b) this key is already tied to an order that this browser can not show to be its own: nothing new was started, the key and the cart stay (the way out is the support code). ONE kind for every order and every state of it (S-01): the page is told nothing about the purchase
  | 'outcome_unknown'      // (R1-2) the payment request WENT OUT and the page does not know what became of it (no answer, a timeout, a broken answer, a failure at the payment service): never "nothing was charged"; the key stays, nothing is repeated by itself. (S-11) Also: an unexpected error of the page found after a request MAY have gone out (code PURCHASE_PAGE_ERROR) - the page does not even know that it went out
  | 'purchase_not_started' // (R1-2) the payment request did NOT go out from this page (another tab of the browser still uses the payment, or the browser's lock service failed): the cart, the key and the storage are untouched. (S-11) Also: an unexpected error of the page found BEFORE the request was ever started (code PURCHASE_UNEXPECTED_ERROR)
  | 'payment_page_unconfirmed' // (DR-13) the server ANSWERED, and what it says is that it can not show the state of the payment page of the order (RESERVATION_UNRESOLVED, PAYMENT_PAGE_CLOSE_UNCONFIRMED): a page may or may not exist, a payment may or may not be on its way. Never "nothing was charged"; the page repeats nothing, keeps the key and the cart, and names no order
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
  // (R1-1b) the code the customer can quote to the shop when a purchase is refused for its key (the first ten digits of the key's fingerprint, XXXXX-XXXXX). Kept only in that exact shape
  // and only with the answer that carries it; it is not a credential - it is a way for the shop to find the key's binding.
  supportCode?: string
  // whether repeating the SAME request (same key) is the right thing to do
  retry: boolean
}

// The shape of the support code the server writes (lib/purchase-intent.ts, SUPPORT_CODE_PATTERN: tests/checkout-client.test.ts holds the two together). Written here again because that
// module uses node:crypto and this one runs in the browser.
export const CHECKOUT_SUPPORT_CODE_PATTERN = /^[0-9A-F]{5}-[0-9A-F]{5}$/

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
  // (R1-1b) the answer of the server's guard against a second order for the same checkout key (one code, whatever the order is and whatever state it is in) and the refusal of a
  // key it will not take: "invalid" like any request it refuses - the page can only make strong keys (R1-1a), so only a request made by hand reaches it.
  PURCHASE_KEY_IN_USE: 'purchase_key_in_use',
  CHECKOUT_KEY_INVALID: 'invalid',
  SESSION_REQUIRED: 'session_required',
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
  // (DR-13) not "the payment service did not answer": the server answered that the state of the order's payment page is not confirmed - see FailureKind
  RESERVATION_UNRESOLVED: 'payment_page_unconfirmed',
  PAYMENT_PAGE_CLOSE_UNCONFIRMED: 'payment_page_unconfirmed',
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
  // (DR-13) an answer that says the payment page is not confirmed names no order, and the page takes none from it: nothing about an order is shown on the strength of this answer
  if (kind !== 'payment_page_unconfirmed' && typeof data.orderId === 'string' && data.orderId.length <= 64) failure.orderId = data.orderId
  // (R1-1b) only the answer of the guard carries the support code, and only a code of the exact shape is believed
  if (kind === 'purchase_key_in_use' && typeof data.supportCode === 'string' && CHECKOUT_SUPPORT_CODE_PATTERN.test(data.supportCode)) failure.supportCode = data.supportCode
  return failure
}

export const NETWORK_FAILURE: CheckoutFailure = { kind: 'network', code: 'NETWORK', status: 0, retry: true }
// (R1-2) A payment request that went out and has no usable answer. Nothing is known: not that it was refused, not that it was not made. `retry: false` - the page repeats nothing by itself
// (the same key makes a repeat by the customer safe, but whether to repeat is for the customer to decide once the order has been looked at). A fresh object each time.
export const outcomeUnknownFailure = (status = 0, code = 'OUTCOME_UNKNOWN'): CheckoutFailure => ({ kind: 'outcome_unknown', code, status, retry: false })
// (R1-2) The payment request did not go out from this page: another tab still uses the payment (the wait for the lock ran out), the lock service failed, or the page was left.
export const purchaseNotStartedFailure = (code = 'PURCHASE_NOT_STARTED'): CheckoutFailure => ({ kind: 'purchase_not_started', code, status: 0, retry: false })
// (S-11) An error nobody expected in the page's own code, told apart by what the page KNOWS about the payment request when it happens - never by a guess:
//   PURCHASE_UNEXPECTED_ERROR  found before the request was ever started (the one place that sends it had not been reached): nothing was sent, and the sentence of `purchase_not_started` is true;
//   PURCHASE_PAGE_ERROR        found after the request may have gone out, or when nobody can tell: it is `outcome_unknown` with its own sentence (the page does not even know the request went out),
//                              and the button is HELD - not given back - until the order has been looked at;
//   REDIRECT_STALLED           the browser did not (or may not) leave for the payment page of an order that EXISTS: the way to the order is offered with the sentence.
export const PURCHASE_UNEXPECTED_ERROR = 'PURCHASE_UNEXPECTED_ERROR'
export const PURCHASE_PAGE_ERROR = 'PURCHASE_PAGE_ERROR'
export const REDIRECT_STALLED = 'REDIRECT_STALLED'
export const pageErrorFailure = (): CheckoutFailure => outcomeUnknownFailure(0, PURCHASE_PAGE_ERROR)
export const paymentPageNotOpenedFailure = (orderId?: string): CheckoutFailure => ({ kind: 'unknown', code: REDIRECT_STALLED, status: 0, retry: true, ...(orderId ? { orderId } : {}) })
// (R1-1a) the page could not make a strong key: no request was made. `retry: false` - pressing again changes nothing until the browser can use Web Crypto. A fresh object each
// time, like every failure that reaches a component.
const keyUnavailableFailure = (): CheckoutFailure => ({ kind: 'crypto_unavailable', code: 'CHECKOUT_KEY_UNAVAILABLE', status: 0, retry: false })

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

// (R1-2) What an answer to the PAYMENT request means. A refusal the server gave before it made anything keeps its kind. A failure of the payment service, an answer in a code this page does not
// know, an answer that is not one: the request may well have made an order and a payment page before it failed, so none of them can say "nothing was charged" - they are `outcome_unknown`.
// The quote and the manual request keep `classifyFailure`: they can not charge anyone.
export function classifySessionFailure(status: number, body: unknown, retryAfterHeader?: string | null): CheckoutFailure {
  const failure = classifyFailure(status, body, retryAfterHeader)
  if (failure.kind === 'network' || failure.kind === 'temporary' || failure.kind === 'unknown') return { ...failure, kind: 'outcome_unknown', retry: false }
  return failure
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

// One call to the payment endpoint, as it is: no repeating.
async function postSession(
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
    // (R1-2) the request went out and nothing usable came back: the server may have made the order and the page since, so this is not "no connection, nothing charged"
    return { ok: false, failure: outcomeUnknownFailure() }
  }
  const body = await readJson(res) as Record<string, any> | null
  if (res.ok) {
    if (body && isStripeCheckoutUrl(body.url) && typeof body.orderId === 'string' && Number.isInteger(body.orderNumber) && Number.isInteger(body.totalCents)) {
      return { ok: true, url: body.url, orderId: body.orderId, orderNumber: body.orderNumber, totalCents: body.totalCents }
    }
    return { ok: false, failure: outcomeUnknownFailure(res.status, 'BAD_SESSION_ANSWER') }
  }
  return { ok: false, failure: classifySessionFailure(res.status, body, res.headers.get('Retry-After')) }
}

// How long to wait before the one repeat of a request that was answered 428. When two tabs of a browser with no cookie yet both ask at the very same moment, each
// is handed a DIFFERENT new session and the browser keeps the last one it receives; a short pause lets both answers arrive before either tab repeats, so that
// both repeat with the SAME session. It narrows the window of the one case the server can not close (R1, docs/SESSIONE-OSPITE.md); it proves nothing and the
// page does not rely on it.
export const HANDSHAKE_PAUSE_MS = 300
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
  })
}

// "Pay". A guest pays with the session cookie of its browser (lib/guest-session.ts, step 4.6 S5), which the quote hands out: if a request still arrives without
// one, the server makes NOTHING - no order, no payment page - gives the browser a session with its answer (428) and asks for the same request again.
// Here that happens ONCE, with the same key and the same body (nothing was made, so it is the same attempt). A second 428 means the cookie did not stay: the
// browser keeps no cookies, and the answer says so (`cookies_blocked`) instead of trying again - there is no loop, however the server answers.
export async function requestSession(
  input: { request: QuoteRequest; expectedTotalCents: number; checkoutKey: string },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  options: { pauseMs?: number } = {},
): Promise<SessionResult> {
  // (R1-1a) No strong key, no request: the check comes BEFORE any fetch, so there is no 428 round and nothing can reach the server or Stripe. It returns a failure (it does not
  // throw) so that the pay button gives itself back. The same rule holds for a guest and for a signed-in customer: the key is the browser's, whoever pays.
  if (!isStrongCheckoutKey(input.checkoutKey)) return { ok: false, failure: keyUnavailableFailure() }
  const first = await postSession(input, signal, fetcher)
  if (first.ok || first.failure.kind !== 'session_required') return first
  await pause(options.pauseMs ?? HANDSHAKE_PAUSE_MS, signal)
  const second = await postSession(input, signal, fetcher)
  if (!second.ok && second.failure.kind === 'session_required') return { ok: false, failure: { ...second.failure, kind: 'cookies_blocked', retry: false } }
  return second
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
