// What the payment pages (step 4.3) do with the order status endpoint (GET /api/checkout/status, step 4.1). Plain functions, no React:
//   * reading the answer: every field is checked, nothing is trusted just because it arrived (a bad answer is an error, never a state);
//   * how often to ask again, and when to stop;
//   * what the browser remembers about the order it just sent to the payment page (so that the cart is emptied for THAT order only).
// The browser never declares a payment: the page asks, the server answers from its database and from Stripe, and this module only turns that
// answer into something to show.
import { isSupportedCurrency } from '@/lib/currency'
import { ORDER_ID_PATTERN, type PublicCheckoutState, type PublicOrderStatus } from '@/lib/checkout-status'

export const PUBLIC_STATES: readonly PublicCheckoutState[] = ['pending', 'confirming', 'paid', 'attention', 'canceled']

export type OrderStatusResult =
  | { kind: 'status'; status: PublicOrderStatus }
  | { kind: 'not_found' }                                 // no such order, or not this browser's: the server says the same for both
  | { kind: 'busy'; retryAfterSeconds: number }           // too many requests
  | { kind: 'error' }                                     // no answer, a server error, or an answer that is not what the endpoint sends

const isWhole = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max

// The five fields of the endpoint, checked one by one.
export function parsePublicStatus(body: unknown): PublicOrderStatus | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const state = record.state
  if (typeof state !== 'string' || !(PUBLIC_STATES as readonly string[]).includes(state)) return null
  if (!isWhole(record.orderNumber, 2_000_000_000) || record.orderNumber < 1) return null
  if (!isWhole(record.totalCents, 100_000_000_000)) return null
  if (typeof record.currency !== 'string' || !isSupportedCurrency(record.currency)) return null
  if (typeof record.final !== 'boolean') return null
  const poll = record.pollAfterMs
  if (poll !== null && !(typeof poll === 'number' && Number.isFinite(poll) && poll >= 0 && poll <= 600_000)) return null
  return {
    orderNumber: record.orderNumber,
    state: state as PublicCheckoutState,
    totalCents: record.totalCents,
    currency: record.currency.toUpperCase(),
    final: record.final,
    pollAfterMs: poll as number | null,
  }
}

export function classifyStatusAnswer(httpStatus: number, body: unknown, retryAfterHeader?: string | null): OrderStatusResult {
  if (httpStatus === 404) return { kind: 'not_found' }
  if (httpStatus === 429) {
    const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const fromBody = typeof data.retryAfterSeconds === 'number' ? data.retryAfterSeconds : NaN
    const fromHeader = retryAfterHeader && /^\d{1,5}$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader) : NaN
    const seconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(fromHeader) ? fromHeader : 10
    return { kind: 'busy', retryAfterSeconds: Math.min(120, Math.max(2, Math.round(seconds))) }
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    const status = parsePublicStatus(body)
    return status ? { kind: 'status', status } : { kind: 'error' }
  }
  return { kind: 'error' }
}

export async function fetchOrderStatus(
  orderId: string,
  options: { returned: boolean },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OrderStatusResult> {
  // Not an order id at all: the same answer as for an order that is not ours, without bothering the server.
  if (!ORDER_ID_PATTERN.test(orderId)) return { kind: 'not_found' }
  let res: Response
  try {
    res = await fetcher(`/api/checkout/status?order=${encodeURIComponent(orderId)}${options.returned ? '&return=1' : ''}`, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', signal,
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    return { kind: 'error' }
  }
  let body: unknown = null
  try { body = await res.json() } catch { /* not JSON: classified below */ }
  return classifyStatusAnswer(res.status, body, res.headers.get('Retry-After'))
}

// ---- how often to ask ------------------------------------------------------------------------------------------------------------------
// While a payment is being confirmed the page asks again after a growing pause (the server's own hint is the shortest allowed), and gives up on
// its own after about two minutes: from then on only a person pressing "check again" asks. A page left open in a forgotten tab does not keep asking.
export const POLL_DELAYS_MS: readonly number[] = [2500, 3500, 5000, 7000, 10_000, 10_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000]
export const MAX_POLLS = POLL_DELAYS_MS.length

// The pause before ask number `asked` (0 = the first repeat), or null when it is time to stop.
export function nextPollDelayMs(asked: number, serverHintMs: number | null): number | null {
  if (!Number.isInteger(asked) || asked < 0 || asked >= MAX_POLLS) return null
  return Math.max(POLL_DELAYS_MS[asked], serverHintMs ?? 0)
}

export const shouldKeepAsking = (status: PublicOrderStatus | null) => Boolean(status && !status.final && status.state !== 'pending')

// ---- the cart ---------------------------------------------------------------------------------------------------------------------------
// The cart is the customer's way back. It is emptied only when the SERVER has verified the payment (`paid`) and the cart is still the one that was paid:
//   * while the payment is being confirmed, or has arrived and waits for a person, the cart stays - it is what lets the customer come back to the same
//     purchase (and the server refuses a second payment for it, lib/checkout-orders.ts findPurchaseInFlight);
//   * a payment page that expired or was left leaves the cart as well;
//   * an order opened from an old address, or in another browser, never touches the cart (no memory of having sent it to the payment page);
//   * a cart that the customer changed after paying is a new cart: it is kept, only the memory of the old order is dropped.
// The memory is in `localStorage`, the same place as the cart, so that EVERY tab of the browser sees it (a second tab, the back button, a page opened
// later); it holds an order id and a fingerprint of the cart that went to the payment page - nothing else, nothing about the person or the payment.
const PENDING_KEY = 'mw:pending-orders:v2'
export const PENDING_ORDERS_EVENT = 'mw:pending-orders-changed'
export const PENDING_ORDER_TTL_MS = 72 * 60 * 60 * 1000 // as long as a guest can still look at the order
export const PENDING_ORDERS_MAX = 5
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type PendingOrder = { orderId: string; cartSignature: string; at: number }

function announceChange() {
  try { if (typeof window !== 'undefined') window.dispatchEvent(new Event(PENDING_ORDERS_EVENT)) } catch { /* nobody to tell */ }
}

// Everything that is still worth keeping, newest first. Damaged or expired entries are dropped, never trusted.
export function readPendingOrders(storage: PendingStorage | null, now: number = Date.now()): PendingOrder[] {
  let raw: unknown
  try { raw = JSON.parse(storage?.getItem(PENDING_KEY) || 'null') } catch { return [] }
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const entries: PendingOrder[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const { orderId, cartSignature, at } = value as Record<string, unknown>
    if (typeof orderId !== 'string' || !ORDER_ID_PATTERN.test(orderId) || seen.has(orderId)) continue
    if (typeof cartSignature !== 'string' || cartSignature.length === 0 || cartSignature.length > 20_000) continue
    if (typeof at !== 'number' || !Number.isFinite(at) || at > now + 60_000 || now - at > PENDING_ORDER_TTL_MS) continue
    seen.add(orderId)
    entries.push({ orderId, cartSignature, at })
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, PENDING_ORDERS_MAX)
}

function writePendingOrders(storage: PendingStorage | null, entries: PendingOrder[]) {
  try {
    if (entries.length === 0) storage?.removeItem(PENDING_KEY)
    else storage?.setItem(PENDING_KEY, JSON.stringify(entries.slice(0, PENDING_ORDERS_MAX)))
  } catch { /* storage blocked: the cart is simply never emptied by this memory, and the server still refuses a second payment */ }
  announceChange()
}

// Called just before the browser leaves for the payment page: THIS order, paid for THIS cart.
export function rememberPendingOrder(storage: PendingStorage | null, orderId: string, cartSignature: string, now: number = Date.now()) {
  if (!ORDER_ID_PATTERN.test(orderId) || !cartSignature) return
  const others = readPendingOrders(storage, now).filter((entry) => entry.orderId !== orderId)
  writePendingOrders(storage, [{ orderId, cartSignature, at: now }, ...others])
}
export function pendingOrderFor(storage: PendingStorage | null, orderId: string, now: number = Date.now()): PendingOrder | null {
  return readPendingOrders(storage, now).find((entry) => entry.orderId === orderId) ?? null
}
// The newest order that was sent to the payment page for exactly this cart.
export function pendingOrderForCart(storage: PendingStorage | null, cartSignature: string | null, now: number = Date.now()): PendingOrder | null {
  if (!cartSignature) return null
  return readPendingOrders(storage, now).find((entry) => entry.cartSignature === cartSignature) ?? null
}
export function forgetPendingOrder(storage: PendingStorage | null, orderId: string, now: number = Date.now()) {
  const entries = readPendingOrders(storage, now)
  if (!entries.some((entry) => entry.orderId === orderId)) return
  writePendingOrders(storage, entries.filter((entry) => entry.orderId !== orderId))
}

// Only a payment the server has verified ends the purchase.
export const emptiesCart = (state: PublicCheckoutState) => state === 'paid'
// A payment that is being confirmed, or that waits for a person: the cart stays and a second payment for it is not offered.
export const isUncertainPayment = (state: PublicCheckoutState) => state === 'confirming' || state === 'attention'

// What the pages do with the cart and the memory once the server has answered for an order this browser sent to the payment page.
//   emptyCart:   the verified payment was for THIS cart -> empty it
//   forgetEntry: nothing more to wait for (paid, whether or not the cart is still the same; or the payment page expired)
export function decideCartAfterStatus(
  state: PublicCheckoutState,
  entry: PendingOrder | null,
  currentCartSignature: string | null,
): { emptyCart: boolean; forgetEntry: boolean } {
  if (!entry) return { emptyCart: false, forgetEntry: false }
  if (state === 'paid') return { emptyCart: emptiesCart(state) && currentCartSignature === entry.cartSignature, forgetEntry: true }
  if (state === 'canceled') return { emptyCart: false, forgetEntry: true }
  return { emptyCart: false, forgetEntry: false } // pending, confirming, attention: the cart stays, the memory stays
}
