// Stripe Checkout sessions for an order that already exists (lib/checkout-orders.ts).
//
// ONE payable page per order (DR-13; the decisions themselves are in lib/checkout-session-plan.ts, pure and tested over every combination of attempts). What this file adds is the
// order in which things happen, so that the decision is still true when it is acted on:
//  1. RESERVE, then call the provider, then settle. A PaymentAttempt row ("creating") is written first, in a short transaction that locks the order, together with the hash of the exact
//     request that will be sent. NO database transaction is ever open while the provider is called.
//  2. The call carries the attempt id as idempotency key and its parameters depend only on the stored order and attempt. A reservation is never closed by the clock: it is RESOLVED
//     by sending its own request again - only while that is provably safe (replayMode), only if the request is byte for byte the one that was stored (requestHash: parameters,
//     return address, API version, test/live), and the answer of a replay is only the first answer as it was, so the session is read again before anything is decided.
//  3. A page is replaced only after the provider has PROVED the old one closed ("expire" answered `expired`, or the session reads back `expired`). When that cannot be proved nothing is
//     opened and nothing is closed: the customer is told to try again, the rows stay as they are.
//  4. What the provider returns is written down FIRST (the session id is recorded on its attempt before anything is decided about it), then the decision is made again, under the lock
//     of the order, on the facts as they are NOW: a page is handed out only if, at that moment, it is registered, open, the only live one, with time left, and the order can still be paid.
//     Every update is conditional and its count is read. What happens after the commit (a payment, the HTTP answer) is not promised away: the page that was handed out is the only one,
//     so the worst that can follow is the customer paying it.
//  5. "complete" means the customer paid: the attempt becomes "processing" (it is not "expired" and not "failed"), whatever it was - reservation or open page. Nothing here ever marks
//     an order paid: that is decided only from verified Stripe data (lib/payment-sync.ts).
// A session the provider created whose answer never reached the database is accepted as a fact of life (it exists, nobody was given its address): what is not accepted is handing
// it out later unregistered, or opening a second one next to it.
import { createHash, randomBytes } from 'node:crypto'
import type Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import type { PaymentAttempt, PrintOrder, PrintOrderItem } from '@prisma/client'
import { prisma } from '@/lib/db'
import { withFinancialRevision } from '@/lib/financial-revision'
import { getStripe, STRIPE_API_VERSION } from '@/lib/stripe'
import { SHIPPING_COUNTRIES, SHIPPING_LABEL } from '@/lib/shipping'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import { closeAtProvider, closePagesSoon, recordPaidPageSoon, type PageOwner } from '@/lib/checkout-pages'
import {
  JOIN_WINDOW_MS, LOCAL_REFUSAL_NAME, MAX_ATTEMPTS_PER_ORDER, REASON_CLOSED_BY_US, REASON_PROVIDER_EXPIRED, REASON_PROVIDER_REJECTED, REUSE_MARGIN_MS, SESSION_TTL_MS,
  classifyCreateError, classifySessionStatus, planNextStep, replayMode,
  type BlockReason, type Plan, type UnresolvedWhy,
} from '@/lib/checkout-session-plan'

// (the numbers live in the pure module; these are the names this file has always exported)
export { JOIN_WINDOW_MS, MAX_ATTEMPTS_PER_ORDER, REUSE_MARGIN_MS, SESSION_TTL_MS }
const STRIPE_CALL_TIMEOUT_MS = 15_000
// A request that has to close one page and open another makes two calls to the provider; it gives up between steps, never in the middle of one.
const REQUEST_BUDGET_MS = 40_000
const MAX_ROUNDS = 6

export class CheckoutSessionError extends Error {
  readonly status: number
  readonly code: string
  readonly retry: boolean
  constructor(status: number, code: string, message: string, retry: boolean) {
    super(message)
    this.name = 'CheckoutSessionError'
    this.status = status
    this.code = code
    this.retry = retry
  }
}

// The request was refused HERE, before any call: it is shown by the code itself that nothing reached the provider.
export class LocalRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = LOCAL_REFUSAL_NAME
  }
}

export type OrderForSession = PrintOrder & { items: PrintOrderItem[] }

export type OpenSessionResult =
  | { kind: 'open'; attemptId: string; url: string; expiresAt: Date }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'too_many_attempts' }

// Test seams, null in production (the same kind as checkoutOrderHooks / syncHooks / effectHooks). A test uses them to put a payment, a webhook or a crash exactly BETWEEN two steps.
//   afterLock  inside the transaction that decides, right after the order was locked
//   afterLoad  inside that transaction, right after the attempts of the order were read: where a writer that does NOT take the lock of the order (nothing in the application is meant to be one) would change a row
//   afterPlan  after a decision was taken and its transaction committed, before the provider is called
//   withoutFollowUp  a test that looks at what a request leaves behind, by itself, switches off what is started after the commit (the verification of a page found paid, the closing of the other pages)
export const checkoutSessionHooks: { afterLock: null | (() => Promise<void>); afterLoad: null | (() => Promise<void>); afterPlan: null | ((step: string) => Promise<void>); withoutFollowUp: boolean } = { afterLock: null, afterLoad: null, afterPlan: null, withoutFollowUp: false }

// ---- What Stripe is asked to charge ---------------------------------------------------------------------------------------
function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// One line per cart item, then shipping, then tax that is added on top. The lines must add up to the order total EXACTLY;
// if they do not, no session is created (a wrong amount must never reach the payment page).
export function buildSessionLineItems(order: OrderForSession): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const currency = order.currency.toLowerCase()
  const lines: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  let sum = 0
  const push = (name: string, description: string | null, unitAmount: number, quantity: number) => {
    lines.push({
      quantity,
      price_data: {
        currency,
        unit_amount: unitAmount,
        product_data: { name: clip(name, 120), ...(description ? { description: clip(description, 300) } : {}) },
      },
    })
    sum += unitAmount * quantity
  }
  for (const item of order.items) {
    const name = item.partName ? `${item.modelTitle} – ${item.partName}` : item.modelTitle
    const colors = Array.isArray(item.colors) ? item.colors.filter((c): c is string => typeof c === 'string') : []
    const description = [
      `Materiale ${item.material}`,
      colors.length ? `Colori ${colors.join(', ')}` : null,
      item.finish ? `Finitura ${item.finish}` : null,
    ].filter(Boolean).join(' · ')
    // quantity x unit price when it is exact, otherwise the line total as a single unit: never a rounding difference
    const exact = item.quantity > 0 && item.unitPriceCents * item.quantity === item.totalCents
    push(name, description, exact ? item.unitPriceCents : item.totalCents, exact ? item.quantity : 1)
  }
  if (order.shippingCents > 0) push(SHIPPING_LABEL, null, order.shippingCents, 1)
  const remainder = order.totalCents - sum
  if (remainder < 0 || (remainder !== 0 && remainder !== order.taxCents)) {
    throw new LocalRefusalError('Order lines do not add up to the order total; no payment session created.')
  }
  if (remainder > 0) push('IVA', null, remainder, 1)
  if (sum !== order.totalCents) throw new LocalRefusalError('Order lines do not add up to the order total; no payment session created.')
  return lines
}

export function buildCheckoutSessionParams(input: {
  order: OrderForSession
  attempt: Pick<PaymentAttempt, 'id' | 'expiresAt'>
  returnBaseUrl: string
}): Stripe.Checkout.SessionCreateParams {
  const { order, attempt, returnBaseUrl } = input
  const metadata = { orderId: order.id, attemptId: attempt.id, orderNumber: String(order.orderNumber) }
  return {
    mode: 'payment',
    // First version: cards and the wallets that run on cards (Apple Pay, Google Pay). No asynchronous methods.
    payment_method_types: ['card'],
    line_items: buildSessionLineItems(order),
    client_reference_id: order.id,
    // Known only for registered customers; a guest types the email on the Stripe page.
    customer_email: order.userId && order.customerEmail ? order.customerEmail : undefined,
    success_url: `${returnBaseUrl}/checkout/success?order=${encodeURIComponent(order.id)}`,
    cancel_url: `${returnBaseUrl}/checkout?canceled=1`,
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
    shipping_address_collection: order.shippingMethod === 'ship'
      ? { allowed_countries: [...SHIPPING_COUNTRIES] as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] }
      : undefined,
    metadata,
    payment_intent_data: {
      metadata,
      description: `Ordine MW-${String(order.orderNumber).padStart(5, '0')}`,
    },
  }
}

// What Stripe answered must be exactly what was asked, otherwise the session is thrown away.
export function sessionProblem(session: Stripe.Checkout.Session, order: OrderForSession): string | null {
  if (session.mode !== 'payment') return 'mode'
  if (session.status !== 'open') return 'status'
  if (!session.url) return 'no_url'
  if (session.amount_total !== order.totalCents) return 'amount'
  if ((session.currency || '').toLowerCase() !== order.currency.toLowerCase()) return 'currency'
  if (session.client_reference_id !== order.id) return 'client_reference_id'
  if (session.metadata?.orderId !== order.id) return 'metadata'
  return null
}

// ---- The exact request, and the proof that a replay is the same request ---------------------------------------------------------------
// `requestHash` is written WITH the reservation, in the same INSERT. It is the hash of everything that makes a request this request: the parameters (the return address included), the
// idempotency key, the API version the client speaks and whether the key is a test or a live one. A replay is sent only if the request as it would be built NOW has the same hash: after a
// change of configuration, a deploy that touched the parameters, an edit of the order or an upgrade of the client the provider would refuse it (idempotency error) or - worse - accept it as a
// different request; so it is not sent, and the reservation waits for a person.
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v as Record<string, unknown>).sort()) if ((v as Record<string, unknown>)[key] !== undefined) out[key] = sort((v as Record<string, unknown>)[key])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}
function stripeKeyMode(): 'test' | 'live' | 'unknown' {
  const key = process.env.STRIPE_SECRET_KEY || ''
  if (/^(sk|rk)_test_/.test(key)) return 'test'
  if (/^(sk|rk)_live_/.test(key)) return 'live'
  return 'unknown'
}
export const idempotencyKeyOf = (attemptId: string) => `makerworks:checkout-session:${attemptId}`
export function requestHashOf(params: Stripe.Checkout.SessionCreateParams, idempotencyKey: string): string {
  return createHash('sha256').update(canonicalJson({ v: 1, apiVersion: STRIPE_API_VERSION, mode: stripeKeyMode(), idempotencyKey, params })).digest('hex')
}
// (the same shape as a cuid: 25 characters, lower case, starting with "c" - the id of an attempt is known BEFORE the row exists, because the request that is hashed names it)
const newAttemptId = () => `c${randomBytes(12).toString('hex')}`

// ---- facts that move between the steps -------------------------------------------------------------------------------------------------------------
type Evidence =
  | { kind: 'closed'; attemptId: string; sessionId: string; reason: string; status?: 'expired' | 'failed' } // the provider PROVED the page closed (a page that did not match FAILED; any other ran out of time)
  | { kind: 'complete'; attemptId: string; sessionId: string }                               // the provider shows that the customer paid
  | { kind: 'session'; attemptId: string; session: Stripe.Checkout.Session }                 // a session was obtained (created, brought back by a replay, or read again): what it is NOW
  | { kind: 'identified'; attemptId: string; sessionId: string }                             // the provider NAMED the session (a replay returned it) but it could not be read: only its identifier is written down
  | { kind: 'reservation_failed'; attemptId: string; reason: string }                        // the request is shown to have created nothing
type Retire = { attempt: PaymentAttempt; why: string }
type Step =
  | { kind: 'result'; result: OpenSessionResult; cleanup: Retire[] }
  | { kind: 'unresolved'; why: UnresolvedWhy | string; cleanup: Retire[] }
  | { kind: 'retry' }
  | { kind: 'reuse'; attempt: PaymentAttempt }
  | { kind: 'retire'; pages: Retire[] }
  | { kind: 'send'; order: OrderForSession; attempt: PaymentAttempt; fresh: boolean }

const unresolvedError = (why: string) => {
  incrementMetric('checkout_reservation_unresolved_total', 1, { why })
  return new CheckoutSessionError(503, 'RESERVATION_UNRESOLVED', 'A payment page for this order is still being checked. Please wait a few minutes and try again; do not start another payment.', true)
}
const providerUnavailable = () => new CheckoutSessionError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is not reachable right now. Please try again.', true)
const closeUnconfirmed = () => {
  incrementMetric('checkout_page_close_unconfirmed_total')
  return new CheckoutSessionError(503, 'PAYMENT_PAGE_CLOSE_UNCONFIRMED', 'The payment page of this order is being renewed. Please try again in a moment.', true)
}

function uniqueViolation(error: unknown): { onSessionId: boolean } | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null
  const target = error.meta?.target
  return { onSessionId: (Array.isArray(target) ? target.join(',') : String(target ?? '')).includes('stripeSessionId') }
}

// ---- The transaction that settles what is known and decides what to do next -----------------------------------------------------------
// ONE short transaction, database only, the order locked: the evidence of the previous step is written down (in the order of the attempts' ids), the decision is taken again on the facts
// as they are now, and - only if it says "create" - the reservation is written, with the hash of its request, in the same commit.
async function settleAndPlan(input: { orderId: string; returnBaseUrl: string }, evidences: Evidence[], options: { create: boolean } = { create: true }, completed: PageOwner[] = []): Promise<Step> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${input.orderId} FOR UPDATE`
      await checkoutSessionHooks.afterLock?.()
      const order = await tx.printOrder.findUniqueOrThrow({ where: { id: input.orderId }, include: { items: { orderBy: { createdAt: 'asc' } } } })
      const load = () => tx.paymentAttempt.findMany({ where: { orderId: input.orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      let attempts = await load()
      await checkoutSessionHooks.afterLoad?.()
      // a page the provider shows as paid whose payment the database does not hold yet: after the commit it is verified and recorded by the payment sync (a payment already recorded needs nothing)
      const noteComplete = (outcome: 'processing' | 'unchanged' | 'closed_row', attempt: PaymentAttempt, sessionId: string) => {
        if (outcome === 'processing' || outcome === 'closed_row' || (outcome === 'unchanged' && attempt.status === 'processing')) completed.push({ orderId: order.id, attemptId: attempt.id, sessionId })
      }
      const mustClose: Retire[] = []        // pages that exist at the provider, are registered here, and must NOT be handed out
      let candidate: string | null = null   // the page this transaction would hand out
      let sawCompleteOnClosedRow = false

      for (const evidence of [...evidences].sort((a, b) => (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0))) {
        const attempt = attempts.find((a) => a.id === evidence.attemptId)
        if (!attempt) continue
        if (evidence.kind === 'closed') {
          // only a page that is STILL open under this session id is closed; any other state means somebody else (a webhook, another request) already dealt with it
          await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: 'open', stripeSessionId: evidence.sessionId }, data: { status: evidence.status ?? 'expired', failureReason: evidence.reason.slice(0, 200) } })
        } else if (evidence.kind === 'complete') {
          const outcome = await markCompleteInTx(tx, order, attempt, evidence.sessionId)
          if (outcome === 'closed_row') sawCompleteOnClosedRow = true
          noteComplete(outcome, attempt, evidence.sessionId)
        } else if (evidence.kind === 'reservation_failed') {
          await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: 'creating', stripeSessionId: null }, data: { status: 'failed', failureReason: evidence.reason.slice(0, 200) } })
        } else if (evidence.kind === 'identified') {
          // the identifier and nothing else: whatever the row is (a reservation, an open page, a page somebody closed in the meantime) it must not lose the name of its session
          if (attempt.stripeSessionId === null) await tx.paymentAttempt.updateMany({ where: { id: attempt.id, stripeSessionId: null }, data: { stripeSessionId: evidence.sessionId } })
          else if (attempt.stripeSessionId !== evidence.sessionId) {
            logEvent({ event: 'checkout.session', level: 'error', outcome: 'session_differs_from_registered', orderId: order.id, attemptId: attempt.id, sessionId: evidence.sessionId })
            throw unresolvedError('session_differs_from_registered')
          }
        } else {
          const session = evidence.session
          // 1. RECORD FIRST: from here on the session is known to the database
          if (attempt.stripeSessionId === null) await tx.paymentAttempt.updateMany({ where: { id: attempt.id, stripeSessionId: null }, data: { stripeSessionId: session.id } })
          else if (attempt.stripeSessionId !== session.id) {
            logEvent({ event: 'checkout.session', level: 'error', outcome: 'session_differs_from_registered', orderId: order.id, attemptId: attempt.id, sessionId: session.id })
            throw unresolvedError('session_differs_from_registered')
          }
          const state = classifySessionStatus(session.status)
          if (state === 'complete') {
            const outcome = await markCompleteInTx(tx, order, attempt, session.id)
            if (outcome === 'closed_row') sawCompleteOnClosedRow = true
            noteComplete(outcome, attempt, session.id)
          } else if (state === 'closed') {
            await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['creating', 'open'] } }, data: { status: 'expired', failureReason: REASON_PROVIDER_EXPIRED } })
          } else if (state === 'unknown') {
            logEvent({ event: 'checkout.session', level: 'error', outcome: 'session_state_unreadable', orderId: order.id, attemptId: attempt.id, sessionId: session.id })
            throw unresolvedError('session_state_unreadable')
          } else {
            const problem = sessionProblem(session, order) ?? (session.metadata?.attemptId !== attempt.id ? 'attempt_reference' : null)
            if (problem) {
              incrementMetric('checkout_session_mismatch_total', 1, { problem })
              logEvent({ event: 'checkout.session', level: 'error', outcome: 'session_mismatch', orderId: order.id, attemptId: attempt.id, sessionId: session.id, problem })
              // never handed out; it stays a live, registered page until the provider has proved it closed
              await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['creating', 'open'] } }, data: { status: 'open', expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : attempt.expiresAt } })
              mustClose.push({ attempt: { ...attempt, stripeSessionId: session.id }, why: `mismatch:${problem}` })
            } else {
              const moved = await tx.paymentAttempt.updateMany({
                where: { id: attempt.id, status: { in: ['creating', 'open'] } },
                data: { status: 'open', expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : attempt.expiresAt },
              })
              if (moved.count > 0) candidate = attempt.id
            }
          }
        }
        attempts = await load()
      }

      const now = Date.now()
      const plan: Plan = planNextStep({ order, attempts, now })
      const candidateAttempt = candidate ? attempts.find((a) => a.id === candidate) : undefined
      // pages registered in this transaction that will not be handed out: they must be closed at the provider, whatever else happens
      const leftover = (): Retire[] => {
        const out = [...mustClose]
        if (candidateAttempt && !(plan.kind === 'reuse' && plan.attemptId === candidateAttempt.id) && !mustClose.some((r) => r.attempt.id === candidateAttempt.id)) out.push({ attempt: candidateAttempt, why: 'discarded' })
        return out
      }

      if (sawCompleteOnClosedRow) {
        // the provider shows a payment on a page the database had closed: nothing is changed or reopened, the identifier is recorded, and nothing is opened by THIS request
        incrementMetric('checkout_complete_on_closed_attempt_total')
        return { kind: 'result', result: { kind: 'blocked', reason: 'processing' }, cleanup: [] } satisfies Step
      }
      if (plan.kind === 'blocked') return { kind: 'result', result: { kind: 'blocked', reason: plan.reason }, cleanup: leftover() }
      if (plan.kind === 'too_many_attempts') return { kind: 'result', result: { kind: 'too_many_attempts' }, cleanup: leftover() }
      if (plan.kind === 'unresolved') return { kind: 'unresolved', why: plan.why, cleanup: leftover() }
      if (plan.kind === 'reuse' && candidateAttempt && plan.attemptId === candidateAttempt.id && mustClose.length === 0) {
        // PUBLISH: the page is registered, open, the only live one, with time left, for an order that can still be paid - all of it read under the lock, a moment ago
        const url = (evidences.find((e) => e.kind === 'session' && e.attemptId === candidateAttempt.id) as Extract<Evidence, { kind: 'session' }>).session.url as string
        return { kind: 'result', result: { kind: 'open', attemptId: candidateAttempt.id, url, expiresAt: candidateAttempt.expiresAt }, cleanup: [] }
      }
      const closing = leftover()
      if (closing.length > 0) return { kind: 'retire', pages: closing }
      if (plan.kind === 'retire') {
        const live = attempts.filter((a) => a.status === 'open').length
        return { kind: 'retire', pages: plan.attemptIds.map((id) => ({ attempt: attempts.find((a) => a.id === id) as PaymentAttempt, why: live > 1 ? 'twin' : 'replaced' })) }
      }
      if (plan.kind === 'reuse') return { kind: 'reuse', attempt: attempts.find((a) => a.id === plan.attemptId) as PaymentAttempt }
      if (plan.kind === 'replay') return { kind: 'send', order, attempt: attempts.find((a) => a.id === plan.attemptId) as PaymentAttempt, fresh: false }

      // plan.kind === 'create': nothing is alive, nothing is in doubt, nothing is being paid. The request is built BEFORE anything is written: a refusal made here leaves no trace.
      // (A step that only records what it was told - closing the pages that were left over after a refusal - never opens anything: it answers "not payable" and writes nothing.)
      if (!options.create) return { kind: 'result', result: { kind: 'blocked', reason: 'not_payable' }, cleanup: [] }
      const id = newAttemptId()
      const createdAt = new Date(now)
      const expiresAt = new Date(now + SESSION_TTL_MS)
      const params = buildCheckoutSessionParams({ order, attempt: { id, expiresAt }, returnBaseUrl: input.returnBaseUrl })
      const created = await tx.paymentAttempt.create({
        data: { id, orderId: order.id, amountCents: order.totalCents, currency: order.currency, status: 'creating', createdAt, expiresAt, requestHash: requestHashOf(params, idempotencyKeyOf(id)) },
      })
      return { kind: 'send', order, attempt: created, fresh: true }
    }, { maxWait: 10_000, timeout: 15_000 })
  } catch (error) {
    const violation = uniqueViolation(error)
    if (violation) {
      if (violation.onSessionId) {
        // a session id that another attempt already holds: never overwritten, never shared
        logEvent({ event: 'checkout.session', level: 'error', outcome: 'session_id_taken', orderId: input.orderId })
        throw unresolvedError('session_id_taken')
      }
      // somebody else got there first (the unique index that allows one live page per order): decide again from what is there now
      incrementMetric('checkout_session_race_total')
      return { kind: 'retry' }
    }
    throw error
  }
}

// A page the customer finished paying: the attempt becomes "processing" - whatever it was, a reservation or an open page - and the revision of the order goes up (entering "processing" is a
// financial move, E12), in the same transaction, under the lock every writer of the order's money situation takes. An attempt that is already further along is left alone. A page the
// database had CLOSED is not reopened and not moved: only its identifier is recorded (it must not be lost), and the caller is told. Nothing here marks an order paid.
async function markCompleteInTx(tx: Prisma.TransactionClient, order: PrintOrder, attempt: PaymentAttempt, sessionId: string): Promise<'processing' | 'unchanged' | 'closed_row'> {
  if (attempt.stripeSessionId === null) await tx.paymentAttempt.updateMany({ where: { id: attempt.id, stripeSessionId: null }, data: { stripeSessionId: sessionId } })
  else if (attempt.stripeSessionId !== sessionId) throw unresolvedError('session_differs_from_registered')
  if (attempt.status === 'creating' || attempt.status === 'open') {
    const moved = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['creating', 'open'] } }, data: { status: 'processing', failureReason: 'session_complete_at_provider' } })
    if (moved.count > 0) {
      await tx.printOrder.update({ where: { id: order.id }, data: withFinancialRevision({}, {}, { attempt: true }) })
      return 'processing'
    }
    // The row was not what it was read as: somebody who does not take the lock of the order wrote it in between (nothing in the application is meant to). Nothing was moved, so nothing is counted
    // as moved - the revision does not go up - and the row is judged by what it is NOW: a payment already on its way stays as it is; anything else is a page the database had closed that the
    // provider shows PAID (nothing is reopened or moved, and nothing is opened by this request).
    incrementMetric('checkout_attempt_changed_under_us_total')
    const now = await tx.paymentAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } })
    return now && (now.status === 'processing' || now.status === 'paid' || now.status === 'mismatch') ? 'unchanged' : 'closed_row'
  }
  return attempt.status === 'expired' || attempt.status === 'failed' ? 'closed_row' : 'unchanged'
}

// ---- Steps that call the provider (no database transaction is open here) --------------------------------------------------------------
async function readSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  try {
    return await getStripe().checkout.sessions.retrieve(sessionId, undefined, { timeout: STRIPE_CALL_TIMEOUT_MS })
  } catch {
    throw providerUnavailable()
  }
}

async function retirePages(pages: Retire[]): Promise<Evidence[]> {
  const out: Evidence[] = []
  for (const { attempt, why } of pages) {
    const sessionId = attempt.stripeSessionId
    if (!sessionId) {
      // (the planner never asks for this: a page with no identifier is "unresolved". Should it ever happen nothing is sent - there is nothing to name - and nothing is concluded.)
      logEvent({ event: 'checkout.session', level: 'error', outcome: 'retire_without_identifier', orderId: attempt.orderId, attemptId: attempt.id })
      throw unresolvedError('retire_without_identifier')
    }
    const proof = await closeAtProvider(sessionId)
    if (proof.state === 'closed') {
      incrementMetric('checkout_page_retired_total', 1, { reason: why.split(':')[0] })
      if (why.startsWith('mismatch:')) out.push({ kind: 'closed', attemptId: attempt.id, sessionId, reason: `session_mismatch:${why.slice('mismatch:'.length)}`, status: 'failed' })
      else out.push({ kind: 'closed', attemptId: attempt.id, sessionId, reason: proof.by === 'us' ? `${REASON_CLOSED_BY_US}${why}` : REASON_PROVIDER_EXPIRED })
    } else if (proof.state === 'complete') {
      out.push({ kind: 'complete', attemptId: attempt.id, sessionId })
    } else {
      logEvent({ event: 'checkout.session', level: 'warn', outcome: 'close_unconfirmed', attemptId: attempt.id, sessionId, message: why })
      throw closeUnconfirmed()
    }
  }
  return out
}

// Send the reservation's request. A reservation made in THIS request is sent as it is; one found from an earlier request is sent again only where that is provably safe.
async function sendReservation(args: { order: OrderForSession; attempt: PaymentAttempt; fresh: boolean; returnBaseUrl: string; replayed: Set<string> }): Promise<Evidence[]> {
  const { order, attempt, fresh } = args
  // the identifier is known (a payment, a webhook or an earlier request recorded it): ask about the session, do not send anything
  if (attempt.stripeSessionId) return [{ kind: 'session', attemptId: attempt.id, session: await readSession(attempt.stripeSessionId) }]
  const key = idempotencyKeyOf(attempt.id)
  let params: Stripe.Checkout.SessionCreateParams
  try {
    params = buildCheckoutSessionParams({ order, attempt, returnBaseUrl: args.returnBaseUrl })
  } catch (error) {
    // a request that cannot be built any more says nothing about whether the first one was sent
    logEvent({ event: 'checkout.session', level: 'error', outcome: 'request_cannot_be_rebuilt', orderId: order.id, attemptId: attempt.id, message: String((error as Error)?.message ?? error).slice(0, 200) })
    throw unresolvedError('request_cannot_be_rebuilt')
  }
  const mode = fresh ? 'FRESH_OK' : replayMode(attempt, Date.now())
  if (!fresh) {
    if (mode === 'NO_REPLAY') {
      logEvent({ event: 'checkout.session', level: 'warn', outcome: 'replay_not_sent', orderId: order.id, attemptId: attempt.id, message: 'too old to be sent again' })
      throw unresolvedError('no_replay')
    }
    if (!attempt.requestHash || attempt.requestHash !== requestHashOf(params, key)) {
      incrementMetric('checkout_reservation_param_drift_total')
      logEvent({ event: 'checkout.session', level: 'error', outcome: 'replay_not_sent', orderId: order.id, attemptId: attempt.id, message: attempt.requestHash ? 'the request as it would be built now is not the one that was stored' : 'no stored request' })
      throw unresolvedError('param_drift')
    }
    // bounded: one replay of a reservation per request
    if (args.replayed.has(attempt.id)) throw unresolvedError('replayed_once')
    args.replayed.add(attempt.id)
    incrementMetric('checkout_reservation_replayed_total', 1, { mode })
  }
  let session: Stripe.Checkout.Session
  try {
    session = await getStripe().checkout.sessions.create(params, { idempotencyKey: key, timeout: STRIPE_CALL_TIMEOUT_MS })
  } catch (error: any) {
    const verdict = classifyCreateError(error)
    logEvent({ event: 'checkout.session', level: 'warn', outcome: 'create_failed', orderId: order.id, attemptId: attempt.id, errorType: error?.type || error?.name, errorCode: error?.code, message: verdict.class })
    if (verdict.class === 'proven_not_created') return [{ kind: 'reservation_failed', attemptId: attempt.id, reason: `${REASON_PROVIDER_REJECTED}${error?.type || error?.name || 'error'}:${error?.code || ''}` }]
    // ambiguous: the reservation stays exactly as it is. The words depend on whether the same call is worth repeating soon.
    if (mode === 'FRESH_OK' && verdict.transient) throw providerUnavailable()
    throw unresolvedError('ambiguous_answer')
  }
  // the answer to a replay is the FIRST answer as it was (open, even if the session was paid or has expired since): what the session is now is read from the session itself
  if (!fresh) {
    try {
      session = await readSession(session.id)
    } catch (error) {
      // the provider has NAMED the session: it is known now, whatever it turns out to be. Its identifier is written on the reservation (and nothing else) before the customer is told to
      // try again; the next request then asks about THAT session and sends nothing.
      await rememberIdentified({ orderId: order.id, returnBaseUrl: args.returnBaseUrl }, attempt.id, session.id)
      throw error
    }
  }
  return [{ kind: 'session', attemptId: attempt.id, session }]
}

async function rememberIdentified(input: { orderId: string; returnBaseUrl: string }, attemptId: string, sessionId: string) {
  try {
    await settle(input, [{ kind: 'identified', attemptId, sessionId }], { create: false })
  } catch (error) {
    incrementMetric('checkout_session_identifier_not_recorded_total')
    logEvent({ event: 'checkout.session', level: 'error', outcome: 'identified_not_recorded', orderId: input.orderId, attemptId, sessionId, message: error instanceof CheckoutSessionError ? error.code : String((error as Error)?.message ?? error).slice(0, 200) })
  }
}

// ---- The whole request -----------------------------------------------------------------------------------------------------------------------------------
// settleAndPlan, with one rule added: when the provider HAS answered and the database could not take the answer, the transaction rolled back (the reservation is as it was), the page the
// provider made is not handed out, and the customer is told to try again - the next request sends the same request again and gets the same session. (Without an answer to record, a failure
// of the database is what it always was: an unexpected error.)
async function settle(input: { orderId: string; returnBaseUrl: string }, evidence: Evidence[], options?: { create: boolean }): Promise<Step> {
  let step: Step
  const completed: PageOwner[] = []
  try {
    step = await settleAndPlan(input, evidence, options, completed)
  } catch (error) {
    if (error instanceof CheckoutSessionError || evidence.length === 0) throw error
    incrementMetric('checkout_session_save_failures_total')
    logEvent({ event: 'checkout.session', level: 'error', outcome: 'save_failed', orderId: input.orderId, message: String((error as Error)?.message ?? error).slice(0, 200) })
    throw new CheckoutSessionError(503, 'TEMPORARY_ERROR', 'Something went wrong while saving the payment. Please try again.', true)
  }
  if (step.kind !== 'retry') followUp(input.orderId, completed) // (a lost race rolled the transaction back: nothing was recorded, nothing follows)
  return step
}

// What follows a COMMITTED settlement, started and not waited for (the customer's answer does not depend on it, and a failure of it loses nothing: see lib/checkout-pages.ts):
// a page the provider shows as PAID is verified and recorded by the payment sync - the only code that marks anything paid - and, the order now being paid or being confirmed, its other pages are
// closed so that it can not be paid twice.
function followUp(orderId: string, completed: ReadonlyArray<PageOwner>) {
  if (checkoutSessionHooks.withoutFollowUp || completed.length === 0) return
  for (const page of completed) recordPaidPageSoon(page)
  closePagesSoon(orderId)
}

export async function openCheckoutSession(input: { orderId: string; returnBaseUrl: string }): Promise<OpenSessionResult> {
  const deadline = Date.now() + REQUEST_BUDGET_MS
  const replayed = new Set<string>()
  let evidence: Evidence[] = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() > deadline) break
    const step = await settle(input, evidence)
    if (step.kind !== 'retry') evidence = [] // (a lost race rolled the transaction back, evidence included: it is kept for the next round)
    if (step.kind === 'retry') continue
    await checkoutSessionHooks.afterPlan?.(step.kind)
    switch (step.kind) {
      case 'result':
        await closeLeftovers(input, step.cleanup)
        return step.result
      case 'unresolved':
        await closeLeftovers(input, step.cleanup)
        throw unresolvedError(step.why)
      case 'reuse':
        evidence = [{ kind: 'session', attemptId: step.attempt.id, session: await readSession(step.attempt.stripeSessionId as string) }]
        break
      case 'retire': {
        const proved = await retirePages(step.pages)
        if (step.pages.some((page) => page.why.startsWith('mismatch:'))) {
          // what the provider returned did not match the order: it is closed (proved above) and written down, and THIS request ends - another page would be built from the same facts
          await settle(input, proved, { create: false })
          throw new CheckoutSessionError(500, 'PAYMENT_PROVIDER_ERROR', 'The payment could not be started.', false)
        }
        evidence = proved
        break
      }
      case 'send':
        evidence = await sendReservation({ order: step.order, attempt: step.attempt, fresh: step.fresh, returnBaseUrl: input.returnBaseUrl, replayed })
        break
    }
  }
  throw new CheckoutSessionError(503, 'TEMPORARY_ERROR', 'The payment could not be prepared. Please try again.', true)
}

// Pages that were created or found while the order turned out not to be payable are closed at the provider before the refusal is answered. If that cannot be proved they stay what they are -
// registered, live rows of an order that cannot be paid - where the next request, the closing of siblings after a payment and the operator's report find them. They are never handed out.
async function closeLeftovers(input: { orderId: string; returnBaseUrl: string }, pages: Retire[]) {
  if (pages.length === 0) return
  try {
    const evidence = await retirePages(pages)
    if (evidence.length > 0) await settle(input, evidence, { create: false })
  } catch (error) {
    incrementMetric('checkout_session_discarded_total', 1, { outcome: 'left_open' })
    logEvent({ event: 'checkout.session', level: 'warn', outcome: 'discard_not_confirmed', orderId: input.orderId, message: error instanceof CheckoutSessionError ? error.code : 'error' })
  }
}
