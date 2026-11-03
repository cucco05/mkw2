// The payment request of a customer who may have several tabs open (R1-2): one request at a time, the key kept INSIDE that turn, the lock service never trusted to be there or to
// work, an answer that is registered for the cart that was CLICKED, and what happens to the cart, the key and the memory of the order once the server says a payment is verified.
// Plain functions, no React, so every rule is tried without a browser (tests/checkout-single-flight.test.ts, tests/checkout-paid-settlement.test.ts).
//
// What this does NOT do, on purpose: it decides no price, it sends no request except the one payment request, it repeats nothing by itself, it rotates no key (a key is made by
// resolveCheckoutKey at a click, nowhere else), and it promises nothing the browser can not keep - a turn is a courtesy between the tabs of ONE browser, not a transaction
// (docs/SESSIONE-OSPITE.md): the server's protections (lib/purchase-intent.ts, lib/checkout-orders.ts) stay the last defence and are not weakened by anything here.
import type { CartItem } from '@/components/cart/CartProvider'
import type { ClearIfResult } from '@/lib/cart-clear-if'
import {
  cartItemsSignature, forgetCheckoutKey, outcomeUnknownFailure, purchaseNotStartedFailure, readCheckoutKeySlot, requestSession, resolveCheckoutKey, stampCheckoutKeyOrder,
  type CheckoutFailure, type CheckoutKeyMemory, type QuoteRequest, type SessionResult,
} from '@/lib/checkout-client'
import type { PublicCheckoutState } from '@/lib/checkout-status'
import { forgetPendingOrder, isUncertainPayment, pendingOrderFor, rememberPendingOrder } from '@/lib/order-status-client'

// ---- the turn ---------------------------------------------------------------------------------------------------------------------------------------
// ONE name for the whole origin: it carries no key, no order, no cart and no person.
export const PURCHASE_LOCK_NAME = 'mw:checkout:purchase:v1'
// Provisional (R1-6 measures them on real devices): how long a tab waits for the turn before it gives up, and how long a request that has no answer is kept open.
export const LOCK_WAIT_MS = 30_000
export const LOCK_WAIT_BOUNDS = { min: 1_000, max: 120_000 } as const
export const REQUEST_TIMEOUT_MS = 45_000
export const REQUEST_TIMEOUT_BOUNDS = { min: 5_000, max: 120_000 } as const

const boundedMs = (value: unknown, fallback: number, bounds: { min: number; max: number }): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}
export const lockWaitMs = (value: unknown) => boundedMs(value, LOCK_WAIT_MS, LOCK_WAIT_BOUNDS)
export const requestTimeoutMs = (value: unknown) => boundedMs(value, REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_BOUNDS)

export type LockManagerLike = {
  request(name: string, options: { mode?: 'exclusive'; signal?: AbortSignal }, callback: () => Promise<unknown> | unknown): Promise<unknown>
}
export type LocksAccess = { kind: 'absent' } | { kind: 'present'; manager: LockManagerLike } | { kind: 'broken' }

const defaultNavigator = (): unknown => (typeof navigator === 'undefined' ? undefined : navigator)

// The ONE place that touches `navigator.locks`, and only when somebody presses "pay" or a payment is verified - never while the module loads, never while a component renders.
//   absent: the platform does not offer the lock service at all (an old browser, a page that is not a secure context): the one case in which a section may run without it;
//   broken: it is offered and can not be used (the getter throws, there is no `request`): anything but "absent" - the caller must not guess its way round it.
// `in` does not call the getter, so "is it there" is asked without touching it; whatever is thrown on the way is "present but broken", never "absent".
export function accessLocks(nav: unknown = defaultNavigator()): LocksAccess {
  if (nav === undefined || nav === null) return { kind: 'absent' }
  try {
    if (!('locks' in (nav as object))) return { kind: 'absent' }
    const manager = (nav as { locks?: unknown }).locks
    const usable = manager !== null && typeof manager === 'object' && typeof (manager as { request?: unknown }).request === 'function'
    return usable ? { kind: 'present', manager: manager as LockManagerLike } : { kind: 'broken' }
  } catch {
    return { kind: 'broken' }
  }
}

export type CoordinatedResult<T> =
  | { status: 'done'; value: T; coordination: 'locked' | 'unavailable' }                      // `unavailable`: there is no lock service at all (see accessLocks)
  | { status: 'not_run'; reason: 'wait_expired' | 'abandoned' | 'lock_error' }                // the section did NOT run, not even in part

/**
 * Runs `section` when it is this tab's turn, and in no other way: with the lock service it runs once inside the lock; with NO lock service it runs once; with a lock service that does
 * not work it does not run at all - whatever the error is called, because a name is no proof of anything. A wait that runs out, a page that is left, a grant that comes after either:
 * the section does not run (a late grant gives the lock straight back). The section is never run twice and never run again after it failed.
 */
export async function runCoordinated<T>(section: () => Promise<T> | T, options: { navigator?: unknown; waitMs?: number; signal?: AbortSignal } = {}): Promise<CoordinatedResult<T>> {
  const access = accessLocks(options.navigator)
  if (access.kind === 'absent') return { status: 'done', value: await section(), coordination: 'unavailable' }
  if (access.kind === 'broken') return { status: 'not_run', reason: 'lock_error' }
  if (options.signal?.aborted) return { status: 'not_run', reason: 'abandoned' }
  const { manager } = access
  return new Promise<CoordinatedResult<T>>((resolve, reject) => {
    let phase: 'waiting' | 'running' | 'over' = 'waiting'
    const waiting = new AbortController()
    const onLeft = () => giveUp('abandoned')
    const timer = setTimeout(() => giveUp('wait_expired'), lockWaitMs(options.waitMs))
    const stopWaiting = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onLeft) }
    function giveUp(reason: 'wait_expired' | 'abandoned' | 'lock_error') {
      if (phase !== 'waiting') return
      phase = 'over'
      stopWaiting()
      waiting.abort()
      resolve({ status: 'not_run', reason })
    }
    options.signal?.addEventListener('abort', onLeft, { once: true })
    let asked: Promise<unknown>
    try {
      asked = Promise.resolve(manager.request(PURCHASE_LOCK_NAME, { mode: 'exclusive', signal: waiting.signal }, async () => {
        // the wait is over (ran out, left): a grant that arrives now runs nothing and the lock goes straight back
        if (phase !== 'waiting') return
        phase = 'running'
        stopWaiting()
        try { resolve({ status: 'done', value: await section(), coordination: 'locked' }) } catch (error) { reject(error) } finally { phase = 'over' }
      }))
    } catch {
      giveUp('lock_error')
      return
    }
    // The request ending without having started the section (it was refused, it was cancelled, or a service that does not keep to its contract just closed it) is a lock error - unless
    // the wait was already given up for another reason, in which case this is the cancel coming back. After the section has started, nothing the service says changes what ran.
    asked.then(() => giveUp('lock_error'), () => giveUp('lock_error'))
  })
}

// ---- "pay" -------------------------------------------------------------------------------------------------------------------------------------------
// What the click fixed: the quote it was made for and the cart that was in front of the customer. The cart's signature is taken at the click and NEVER read again from the live cart.
export type PurchaseClick = { signature: string; totalCents: number; cartSignature: string }
export type PurchaseOutcome =
  | { kind: 'not_run'; reason: 'wait_expired' | 'abandoned' | 'lock_error' }       // no turn: nothing was sent, nothing was written
  | { kind: 'gone' }                                                                 // the page was left before the request: nothing was sent, nothing was written
  | { kind: 'stale' }                                                                // the cart or the total is not the one that was clicked: nothing was sent, nothing was written
  | { kind: 'answer'; result: SessionResult; coordination: 'locked' | 'unavailable' }

// The browser's storage as this module uses it: the key (a slot), the memory of the orders (a list that can end up empty and then goes). `window.localStorage` is one.
export type PurchaseStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type SendInput = {
  store: PurchaseStore | null
  click: PurchaseClick
  request: QuoteRequest
  isCurrent: () => boolean
  lifetime: AbortSignal
  fetcher?: typeof fetch
  navigator?: unknown
  waitMs?: number
  requestTimeoutMs?: number
  memory?: CheckoutKeyMemory
  makeKey?: () => string
}

/**
 * The payment request, in its turn: wait for the turn; then (still the same page? still the cart that was clicked?) read or make the key, send ONE request, and keep the answer for the
 * cart that was clicked - the order in the memory of the orders and its id on the key - whatever happened to the page or the cart while the request was on its way. Nothing here
 * redirects, shows or starts anything: the page does that from the plan (planAfterPurchase), if it is still there.
 * A request that goes unanswered is cut after the limit and is `outcome_unknown`: the key stays, nothing is written, nothing is repeated.
 */
export async function sendPurchase(input: SendInput): Promise<PurchaseOutcome> {
  const turn = await runCoordinated(() => purchaseInTurn(input), { navigator: input.navigator, waitMs: input.waitMs, signal: input.lifetime })
  if (turn.status === 'not_run') return { kind: 'not_run', reason: turn.reason }
  return turn.value.kind === 'answer' ? { kind: 'answer', result: turn.value.result, coordination: turn.coordination } : turn.value
}

async function purchaseInTurn(input: SendInput): Promise<{ kind: 'gone' } | { kind: 'stale' } | { kind: 'answer'; result: SessionResult }> {
  if (input.lifetime.aborted) return { kind: 'gone' }
  if (!input.isCurrent()) return { kind: 'stale' }
  const { store, click } = input
  const checkoutKey = resolveCheckoutKey(store, click.signature, click.totalCents, input.makeKey, input.memory)
  const result = await askForSession(input, checkoutKey)
  keepAnswer(input, checkoutKey, result)
  return { kind: 'answer', result }
}

// The request has a limit of its own, and ONLY that limit cancels it: the page being left does not (a request that went out must be able to finish, so that its order is remembered).
// An abort is therefore the limit; anything else thrown after the request went out is as unknown as no answer.
async function askForSession(input: SendInput, checkoutKey: string): Promise<SessionResult> {
  const cut = new AbortController()
  const timer = setTimeout(() => cut.abort(), requestTimeoutMs(input.requestTimeoutMs))
  try {
    return await requestSession({ request: input.request, expectedTotalCents: input.click.totalCents, checkoutKey }, cut.signal, input.fetcher)
  } catch {
    return { ok: false, failure: outcomeUnknownFailure() }
  } finally {
    clearTimeout(timer)
  }
}

// Storage only (React is the page's business). Only an answer the server gave writes anything: no answer, a refusal that names no order, a timeout - nothing, and the key stays.
function keepAnswer(input: SendInput, checkoutKey: string, result: SessionResult) {
  const { store, click } = input
  const made = { key: checkoutKey, signature: click.signature, totalCents: click.totalCents }
  if (result.ok) {
    rememberPendingOrder(store, result.orderId, click.cartSignature)
    stampCheckoutKeyOrder(store, made, result.orderId)
    return
  }
  const { failure } = result
  // the key was used for another cart: forget THAT key - and only if the slot still holds it
  if (failure.kind === 'conflict') { forgetCheckoutKey(store, { key: checkoutKey }, input.memory); return }
  // the server knows an order of this customer for exactly this cart that is paid, being paid or waiting for a person (it names it only to somebody it can show to own it): follow it
  if ((failure.kind === 'payment_in_progress' || failure.kind === 'not_payable') && failure.orderId) {
    rememberPendingOrder(store, failure.orderId, click.cartSignature)
    stampCheckoutKeyOrder(store, made, failure.orderId)
  }
}

export type PostPurchaseAction =
  | { do: 'redirect'; url: string }
  | { do: 'show_failure'; failure: CheckoutFailure }
  | { do: 'refresh_quote' }
  | { do: 'release_button' }

// The kinds after which the page asks for a new quote (the price moved, the cart is no longer sellable, the key was refused).
const ASKS_FOR_NEW_QUOTE: readonly string[] = ['price_changed', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'invalid', 'shipping_unavailable', 'conflict']

/**
 * What the page does once the request is over - and only if the page is still there. A success sends the customer to the payment page only if the cart in front of them is still the one
 * that was clicked; otherwise the order is already in the memory (keepAnswer) and the button is given back.
 */
export function planAfterPurchase(outcome: PurchaseOutcome, context: { mounted: boolean; isCurrentNow: boolean }): PostPurchaseAction[] {
  if (!context.mounted) return []
  switch (outcome.kind) {
    case 'gone': return []
    case 'stale': return [{ do: 'release_button' }]
    case 'not_run':
      return outcome.reason === 'abandoned' ? [] : [{ do: 'show_failure', failure: purchaseNotStartedFailure(outcome.reason === 'wait_expired' ? 'PURCHASE_LOCK_WAIT_EXPIRED' : 'PURCHASE_LOCK_ERROR') }, { do: 'release_button' }]
    case 'answer': {
      const { result } = outcome
      if (result.ok) return context.isCurrentNow ? [{ do: 'redirect', url: result.url }] : [{ do: 'release_button' }]
      return [{ do: 'show_failure', failure: result.failure }, ...(ASKS_FOR_NEW_QUOTE.includes(result.failure.kind) ? [{ do: 'refresh_quote' } as const] : []), { do: 'release_button' }]
    }
  }
}

// ---- a verified payment ------------------------------------------------------------------------------------------------------------------------------
// The server says the payment of `orderId` is verified. The page has shown that already (what the server says is shown at once, whatever happens next); this decides what to do with the
// CART, the KEY and the MEMORY OF THE ORDER, and it does the least that is safe:
//   * the key and the cart are touched only if the key in the slot is PROVED to be this payment's - the slot carries this order's id (stampCheckoutKeyOrder wrote it when the server named the
//     order). Equal-looking carts prove nothing: a second purchase of the same things has the same cart;
//   * in this order: the cart is emptied (and the saved cart read back), THEN the key is forgotten, THEN the memory of the order is removed. An interruption between two steps leaves an empty
//     cart with a key kept, or an empty cart with a forgotten key and a memory that is of no use - never a full cart with no key, which is a second order for the same things;
//   * a slot that proves nothing (see below) is NOT taken to mean that the payment was replaced by another purchase: nothing is touched and the memory of the order STAYS - it is the only
//     way back to the order. "No provenance" is its own answer, not "not mine";
//   * the memory of the order is removed only when the answer is final, as the LAST step, inside the same turn as the others;
//   * all of it inside the turn of this browser's tabs, so that it never overlaps a "pay" or another tab's settlement.
export type SettlementReason = 'page_left' | 'wait_expired' | 'abandoned' | 'lock_error' | 'cart_unsettled' | 'unconfirmed' | 'key_not_forgotten'
export type PaidSettlement =
  | { kind: 'applied' }                                   // the cart was emptied (and read back empty), the key forgotten, the memory removed
  | { kind: 'not_owned' }                                 // the slot is positively ANOTHER purchase's: its key and the cart were not touched; the memory of this order was removed
  | { kind: 'cart_changed' }                              // the cart is no longer the paid one: nothing was emptied; the key stays; the memory of this order was removed
  | { kind: 'already_settled' }                           // the memory of the order is gone (another tab finished the job, or it expired): there is nothing left to do
  | { kind: 'provenance_unknown' }                        // the slot proves nothing about this order: nothing was touched, the memory STAYS
  | { kind: 'deferred'; reason: SettlementReason }        // not done, nothing destructive was: the memory STAYS and the next page that sees the order finishes the job
export const isFinalSettlement = (settlement: PaidSettlement) => settlement.kind !== 'deferred' && settlement.kind !== 'provenance_unknown'

// A payment that is being confirmed, that waits for a person, or that is verified: "pay" is not offered again for the same cart. (A verified one stops blocking when its job is
// final - the memory of the order goes, and with it the page's reason to look.)
export const blocksNewPayment = (state: PublicCheckoutState | null) => state !== null && (isUncertainPayment(state) || state === 'paid')

type ClearIf = (matches: (items: readonly CartItem[]) => boolean, options?: { waitMs?: number }) => Promise<ClearIfResult>
export type SettleInput = {
  store: PurchaseStore | null
  orderId: string
  // the cart the page sent to the payment page, as the memory of the order holds it
  recordCartSignature: string
  // `alive()`: the component that asked is still on the page; `signal`: aborted when it goes
  lifetime: { alive: () => boolean; signal: AbortSignal }
  clearIf: ClearIf
  navigator?: unknown
  waitMs?: number
  clearWaitMs?: number
  memory?: CheckoutKeyMemory
}

async function settleInTurn(input: SettleInput): Promise<PaidSettlement> {
  const { store, orderId, recordCartSignature, lifetime } = input
  if (!lifetime.alive()) return { kind: 'deferred', reason: 'page_left' }
  const slot = readCheckoutKeySlot(store)
  if (slot.kind === 'unreadable') return { kind: 'provenance_unknown' }
  // nothing left to settle: another tab did it, or the memory expired
  if (!pendingOrderFor(store, orderId)) return { kind: 'already_settled' }
  const named = slot.kind === 'entry' ? slot.entry.orderId : undefined
  if (named === undefined) return { kind: 'provenance_unknown' }
  if (named !== orderId) { forgetPendingOrder(store, orderId); return { kind: 'not_owned' } }
  let answer: ClearIfResult
  try {
    answer = await input.clearIf((items) => items.length === 0 || cartItemsSignature(items as CartItem[]) === recordCartSignature, { waitMs: input.clearWaitMs })
  } catch {
    return { kind: 'deferred', reason: 'unconfirmed' }
  }
  if (answer.kind === 'kept') {
    if (answer.reason === 'other_tab') return { kind: 'deferred', reason: 'cart_unsettled' }
    forgetPendingOrder(store, orderId)
    return { kind: 'cart_changed' }
  }
  if (answer.kind !== 'cleared') return { kind: 'deferred', reason: 'unconfirmed' }
  // the cart is empty and saved empty: now, and only if the slot still is this payment's, the key
  if (!forgetCheckoutKey(store, { orderId }, input.memory)) return { kind: 'deferred', reason: 'key_not_forgotten' }
  forgetPendingOrder(store, orderId)
  return { kind: 'applied' }
}

/**
 * Settles a verified payment (see above). Never throws: whatever goes wrong is `deferred`, and a deferred job changes nothing a later one could not finish.
 * The first thing it does is let the caller's turn end, so that it never runs inside a render or an effect of React.
 */
export async function settlePaidPurchase(input: SettleInput): Promise<PaidSettlement> {
  try {
    await Promise.resolve()
    const turn = await runCoordinated(() => settleInTurn(input), { navigator: input.navigator, waitMs: input.waitMs, signal: input.lifetime.signal })
    if (turn.status === 'not_run') return { kind: 'deferred', reason: turn.reason }
    return turn.value
  } catch {
    return { kind: 'deferred', reason: 'unconfirmed' }
  }
}
