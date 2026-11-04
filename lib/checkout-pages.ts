// Closing, AT THE PROVIDER and with proof, the payment pages of an order that can not be paid any more (DR-13).
//
// When one page of an order is paid (or being paid, or the order is cancelled, or put under review), every OTHER live page of the same order is a way to pay it twice. This closes them:
//   * each page is closed with `expire`, and the row is closed only if the provider PROVED it (the answer was `expired`, or the session reads back `expired`); a session that reads back
//     `complete` is money, not a closed page - it is handed to the verified payment handling (`onComplete`), which records it (a second payment becomes a "duplicate", never a lost one);
//     anything else is "unknown": the row is left exactly as it is;
//   * it never touches an order that can still be paid (that is the business of lib/checkout-sessions.ts, which decides under the lock of the order): the decision is the same pure planner,
//     taken again from the order as it is when the pages are looked at, and again after every page that turned out to be paid;
//   * it is IDEMPOTENT (a page that is already closed is refused by `expire` and read back as expired: the same result) and it does not matter how many times, or how many processes at once,
//     run it; it never recurses (a nested call for the same order in the same process returns at once: the payment handling it may call asks for the same closing after its own commit);
//   * it never raises: whatever fails is logged and counted, and the row stays what it was. THE ROW IS THE RECORD: a live page of an order that can not be paid is a row (`open`, with a
//     Stripe identifier) that scripts/checkout-pages-check.sql lists and that this function takes up again at the next sign of life of the order - the next payment event, the
//     confirmation page of the customer. Nothing is kept in memory that a restart would lose.
// It writes only the status of those rows (creating / open -> expired); it never moves money and never calls the payment effects (receipt, notifications, production): those run once, in
// lib/payment-sync.ts, for the payment that was verified.
import { AsyncLocalStorage } from 'node:async_hooks'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { logEvent } from '@/lib/observability-logger'
import { incrementMetric } from '@/lib/observability-metrics'
import { classifyCloseOutcome, planNextStep, REASON_CLOSED_BY_US, REASON_PROVIDER_EXPIRED } from '@/lib/checkout-session-plan'

const STRIPE_CLOSE_TIMEOUT_MS = 15_000
const MAX_PASSES = 6

// Close a page at the provider and say what is PROVED: `closed` (it answered "expired", or the session reads back expired), `complete` (the customer paid: money, not a closed page),
// `unknown` (the call failed or was refused and the session could not be read, or it reads back open): nothing is concluded.
export async function closeAtProvider(sessionId: string): Promise<{ state: 'closed' | 'complete' | 'unknown'; by: 'us' | 'provider' }> {
  const stripe = getStripe()
  try {
    const closed = await stripe.checkout.sessions.expire(sessionId, {}, { timeout: STRIPE_CLOSE_TIMEOUT_MS })
    const state = classifyCloseOutcome(closed?.status)
    if (state === 'closed' || state === 'complete') return { state, by: 'us' }
  } catch { /* refused (the session is not open) or failed: ask what it is */ }
  try {
    const seen = await stripe.checkout.sessions.retrieve(sessionId, undefined, { timeout: STRIPE_CLOSE_TIMEOUT_MS })
    return { state: classifyCloseOutcome(seen?.status), by: 'provider' }
  } catch {
    return { state: 'unknown', by: 'provider' }
  }
}

export type PageOwner = { orderId: string; attemptId: string; sessionId: string }
export type ClosedPages = { closed: number; complete: number; unconfirmed: number; reservationsWithoutIdentifier: number; skipped: 'payable' | 'reentrant' | 'no_order' | 'carrier_unknown' | null }

// A page that turned out to be paid goes to the verified payment handling, which decides what it is (the order's own payment, or a duplicate that waits for a person). Imported when it is
// needed: lib/payment-sync.ts asks for the closing of pages after its own commit, so the two files must not load each other.
async function recordPaidPage(page: PageOwner): Promise<void> {
  const { syncPayment } = await import('@/lib/payment-sync')
  await syncPayment(
    { kind: 'checkout_session', id: page.sessionId, hint: { orderId: page.orderId, attemptId: page.attemptId } },
    { eventType: 'checkout.page.found_complete', maxWaitMs: 4000 },
  )
}

const inFlight = new Set<string>()

export async function closePagesOfOrder(orderId: string, options: { onComplete?: (page: PageOwner) => Promise<unknown> } = {}): Promise<ClosedPages> {
  const result: ClosedPages = { closed: 0, complete: 0, unconfirmed: 0, reservationsWithoutIdentifier: 0, skipped: null }
  if (inFlight.has(orderId)) return { ...result, skipped: 'reentrant' }
  const onComplete = options.onComplete ?? recordPaidPage
  inFlight.add(orderId)
  try {
    // The order is read again before each pass: a page that turned out to be paid changes what the order is, and the pages that are left are looked at in the light of that.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const order = await prisma.printOrder.findUnique({ where: { id: orderId }, select: { status: true, paymentStatus: true, paymentReviewReason: true, paidAt: true, stripePaymentIntentId: true } })
      if (!order) return { ...result, skipped: 'no_order' }
      const attempts = await prisma.paymentAttempt.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const plan = planNextStep({ order, attempts, now: Date.now() })
      if (plan.kind !== 'blocked') return { ...result, skipped: pass === 0 ? 'payable' : null }
      result.reservationsWithoutIdentifier = attempts.filter((a) => a.status === 'creating' && !a.stripeSessionId).length
      // Money that is moving, or a payment that waits for a person, is carried by ONE page: the attempt that is processing / paid / mismatch. When the order says so but no attempt does, the page
      // the money is moving on could be any live one, and closing it could cancel a payment in flight: nothing is closed (a person looks; scripts/checkout-pages-check.sql lists it).
      if ((plan.reason === 'processing' || plan.reason === 'review') && !attempts.some((a) => a.status === 'processing' || a.status === 'paid' || a.status === 'mismatch')) {
        incrementMetric('checkout_sibling_closed_total', 1, { outcome: 'carrier_unknown' })
        logEvent({ event: 'checkout.pages', level: 'warn', outcome: 'carrier_unknown', orderId, reason: plan.reason })
        return { ...result, skipped: 'carrier_unknown' }
      }
      // (a page that carries the very payment the order is tied to is never one of the "other" pages)
      const pages = attempts.filter((a) => (a.status === 'open' || a.status === 'creating') && a.stripeSessionId
        && !(a.stripePaymentIntentId && a.stripePaymentIntentId === order.stripePaymentIntentId))
      if (pages.length === 0) return result
      let decideAgain = false
      for (const page of pages) {
        const sessionId = page.stripeSessionId as string
        try {
          const proof = await closeAtProvider(sessionId)
          if (proof.state === 'closed') {
            // (the page may have been closed by somebody else in the meantime - a webhook, another process: then the update changes nothing, and that is as it should be)
            await prisma.paymentAttempt.updateMany({
              where: { id: page.id, stripeSessionId: sessionId, status: { in: ['creating', 'open'] } },
              data: { status: 'expired', failureReason: proof.by === 'us' ? `${REASON_CLOSED_BY_US}order_${plan.reason}` : REASON_PROVIDER_EXPIRED },
            })
            result.closed += 1
            incrementMetric('checkout_sibling_closed_total', 1, { outcome: 'closed' })
          } else if (proof.state === 'complete') {
            result.complete += 1
            incrementMetric('checkout_sibling_closed_total', 1, { outcome: 'complete' })
            await onComplete({ orderId, attemptId: page.id, sessionId })
            // what the order is may have changed (this page was money): decide again before another page is closed
            decideAgain = true
            break
          } else {
            result.unconfirmed += 1
            incrementMetric('checkout_sibling_closed_total', 1, { outcome: 'unconfirmed' })
            logEvent({ event: 'checkout.pages', level: 'warn', outcome: 'close_unconfirmed', orderId, attemptId: page.id, sessionId })
          }
        } catch (error) {
          result.unconfirmed += 1
          incrementMetric('checkout_sibling_closed_total', 1, { outcome: 'error' })
          logEvent({ event: 'checkout.pages', level: 'error', outcome: 'close_failed', orderId, attemptId: page.id, sessionId, message: String((error as Error)?.message ?? error).slice(0, 200) })
        }
      }
      if (!decideAgain) return result
    }
    return result
  } catch (error) {
    logEvent({ event: 'checkout.pages', level: 'error', outcome: 'failed', orderId, message: String((error as Error)?.message ?? error).slice(0, 200) })
    return result
  } finally {
    inFlight.delete(orderId)
  }
}

// ---- the same, started and not waited for ---------------------------------------------------------------------------------------------------------------------------------------------------
// A payment, a status read, a page found paid: none of them waits for the closing of the other pages. The jobs are remembered only so that a test (or an orderly shutdown) can wait for them;
// what a job could not finish is NOT remembered here - it is in the rows.
const background = new Set<Promise<unknown>>()
const insideJob = new AsyncLocalStorage<true>()

function startJob(work: () => Promise<unknown>): void {
  const job: Promise<unknown> = insideJob.run(true, work)
    .catch((error) => { logEvent({ event: 'checkout.pages', level: 'error', outcome: 'job_failed', message: String((error as Error)?.message ?? error).slice(0, 200) }) })
    .finally(() => { background.delete(job) })
  background.add(job)
}

export function closePagesSoon(orderId: string): void {
  startJob(() => closePagesOfOrder(orderId))
}

// A page that the provider shows as paid but that the database does not know as paid yet: verified and recorded by the payment sync, in the background (the answer to the customer does not wait for
// it, and nothing here marks anything paid: only what the sync verifies is recorded).
export function recordPaidPageSoon(page: PageOwner): void {
  startJob(() => recordPaidPage(page))
}

// Resolves when no job started by this process is running. Called from inside a job it returns at once (a job can not wait for itself).
export async function pageJobsSettled(): Promise<void> {
  if (insideJob.getStore()) return
  while (background.size > 0) await Promise.allSettled([...background])
}

// Is there a live page, with an identifier, on an order that can not be paid any more? (What the confirmation page of the customer checks before taking the closing up again.)
export function hasLivePageOfUnpayableOrder(
  order: { status: string; paymentStatus: string; paymentReviewReason: string | null },
  attempts: ReadonlyArray<{ status: string; stripeSessionId: string | null; failureReason?: string | null; createdAt?: Date | null; expiresAt?: Date | null; id?: string; amountReceivedCents?: number | null }>,
): boolean {
  if (!attempts.some((a) => (a.status === 'open' || a.status === 'creating') && a.stripeSessionId)) return false
  const plan = planNextStep({
    order: { status: order.status, paymentStatus: order.paymentStatus, paymentReviewReason: order.paymentReviewReason },
    attempts: attempts.map((a, index) => ({ id: a.id ?? String(index), status: a.status, stripeSessionId: a.stripeSessionId, failureReason: a.failureReason ?? null, amountReceivedCents: a.amountReceivedCents ?? null, createdAt: a.createdAt ?? null, expiresAt: a.expiresAt ?? null })),
    now: Date.now(),
  })
  return plan.kind === 'blocked'
}
