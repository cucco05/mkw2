// What the code that was PUBLISHED did (branch claude/stampa3d-fase1, commit 457df9149da560d8b68fb07b3c9d89aa619a034c, lib/checkout-sessions.ts), kept verbatim so that a test can make the rows that code
// left in a database - not rows invented for the code that replaces it.
//
// Verbatim means: the bodies below are the published lines, character for character; only the imports are adapted (relative paths) and the three functions are exported. How to check, from a
// checkout that has the history:
//   git show 457df9149da560d8b68fb07b3c9d89aa619a034c:lib/checkout-sessions.ts | sed -n 195,198p | sha256sum   ->  7af600785f1f0515cb02788a9e772c1b398dbb24713d32e01f54509f6c14273b  (closeAttempt, with its comment)
//   git show 457df9149da560d8b68fb07b3c9d89aa619a034c:lib/checkout-sessions.ts | sed -n 200,209p | sha256sum   ->  6f55a931625f49d507e2c59771e84e9f7f0cdd876dc6091cb92c159b45c19789  (markPageCompleteAtProvider, with its comment)
//   git show 457df9149da560d8b68fb07b3c9d89aa619a034c:lib/checkout-sessions.ts | sed -n 258,285p | sha256sum   ->  47fb21d3696d49017c51fe8bec51b7b7aad84c58b5a88f0d496bc8c9b5e9188c  (reopenAttempt, with its comment)
// `sessionProblem`, which the published function calls, is the one of lib/checkout-sessions.ts today: the two are identical (checked by diff).
//
// WHAT reopenAttempt DID that matters here: when the provider shows a page OPEN that no longer matches the order (`sessionProblem`), it closed the ROW - `failed`, failureReason
// `session_mismatch:<problem>`, the Stripe session id still on it - and it NEVER asked Stripe to close the page. The page stayed open and payable. (The other published writer of that reason,
// createSessionForAttempt, at least tried an `expire`, swallowed any failure, and closed a row that had no session id yet.)
// Not a test file (its name does not match the test patterns).
import type Stripe from 'stripe'
import type { PaymentAttempt } from '@prisma/client'
import { prisma } from '../../lib/db'
import { withFinancialRevision } from '../../lib/financial-revision'
import { getStripe } from '../../lib/stripe'
import { CheckoutSessionError, sessionProblem, type OpenSessionResult, type OrderForSession } from '../../lib/checkout-sessions'

const STRIPE_CALL_TIMEOUT_MS = 15_000

// Closes a payment PAGE that never had money: a reservation or an open page becomes failed / expired (no financial move: the order's financial revision does not change).
export async function closeAttempt(attemptId: string, from: string[], status: 'failed' | 'expired', reason: string) {
  await prisma.paymentAttempt.updateMany({ where: { id: attemptId, status: { in: from } }, data: { status, failureReason: reason.slice(0, 200) } })
}

// The customer finished paying on Stripe's side while our attempt still said "open": from now on it says "processing" until the verified payment handling decides.
// That IS a financial move (step 4.6, S6, P2b, E12: an attempt enters "processing"), so the order's financial revision goes up in the same transaction, under the row lock
// every other writer of the order's money situation takes: an authorization given before this moment can not come back to life when the payment later ends.
export async function markPageCompleteAtProvider(orderId: string, attemptId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrintOrder" WHERE "id" = ${orderId} FOR UPDATE`
    const moved = await tx.paymentAttempt.updateMany({ where: { id: attemptId, status: 'open' }, data: { status: 'processing', failureReason: 'session_complete_at_provider' } })
    if (moved.count > 0) await tx.printOrder.update({ where: { id: orderId }, data: withFinancialRevision({}, {}, { attempt: true }) })
  }, { maxWait: 10_000, timeout: 15_000 })
}

// An attempt we already hold: ask Stripe whether it is still usable.
export async function reopenAttempt(order: OrderForSession, attempt: PaymentAttempt): Promise<OpenSessionResult | null> {
  if (!attempt.stripeSessionId) {
    await closeAttempt(attempt.id, ['open'], 'failed', 'open_without_session')
    return null
  }
  let session: Stripe.Checkout.Session
  try {
    session = await getStripe().checkout.sessions.retrieve(attempt.stripeSessionId, undefined, { timeout: STRIPE_CALL_TIMEOUT_MS })
  } catch {
    throw new CheckoutSessionError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider is not reachable right now. Please try again.', true)
  }
  if (session.status === 'open' && session.url && !sessionProblem(session, order)) {
    return { kind: 'open', attemptId: attempt.id, url: session.url, expiresAt: attempt.expiresAt }
  }
  if (session.status === 'complete') {
    // The customer already finished paying on Stripe's side. Whether it counts is decided only by the verified payment
    // handling (S2/S3 step 3); until then no second session may be opened.
    await markPageCompleteAtProvider(order.id, attempt.id)
    return { kind: 'blocked', reason: 'processing' }
  }
  const mismatch = session.status === 'open' ? sessionProblem(session, order) : null
  await closeAttempt(
    attempt.id, ['open'],
    session.status === 'expired' ? 'expired' : 'failed',
    mismatch ? `session_mismatch:${mismatch}` : `provider_status:${session.status}`,
  )
  return null
}
