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
// The cart is emptied only when the customer has really been through the payment page for THIS order: not when somebody opens the address of an
// old order, and not for a payment page that expired. Without the memory of "I sent this order to the payment page" the cart is left alone.
const PENDING_KEY = 'mw:pending-order:v1'
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function rememberPendingOrder(storage: PendingStorage | null, orderId: string) {
  if (!ORDER_ID_PATTERN.test(orderId)) return
  try { storage?.setItem(PENDING_KEY, orderId) } catch { /* storage blocked: the cart is simply not emptied on return */ }
}
export function pendingOrderIs(storage: PendingStorage | null, orderId: string): boolean {
  try { return storage?.getItem(PENDING_KEY) === orderId } catch { return false }
}
export function forgetPendingOrder(storage: PendingStorage | null) {
  try { storage?.removeItem(PENDING_KEY) } catch { /* nothing to forget */ }
}

// Which answers mean "the customer's payment went through the payment page": the cart has done its job. `canceled` and `pending` leave the cart as it is.
export const emptiesCart = (state: PublicCheckoutState) => state === 'confirming' || state === 'paid' || state === 'attention'
