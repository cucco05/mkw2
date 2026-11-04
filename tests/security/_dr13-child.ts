// Helper process for dr13-multiprocess.sec.ts: a REAL separate Node process (its own database connections and memory) that asks for the payment page of ONE order at a given wall-clock moment,
// using the real lib/checkout-sessions.ts against the shared test database and the SHARED stand-in for Stripe (tests/security/_stripe-sim.ts, whose state lives in the database).
// Everything it needs comes in the environment (CHILD_*, SIM_*): the clock offset first, so that this process and its parent agree on what "now" is.
//   CHILD_MODE=open  (default)  ask for the page: openCheckoutSession
//   CHILD_MODE=sync             run the payment synchronisation for CHILD_SESSION (what a webhook does)
//   CHILD_MODE=hold             an administrator (CHILD_ADMIN) releases the payment of the order as "no charge" (lib/payment-hold.ts); CHILD_NO_JOBS=1 drops the background closing of the other pages
//   CHILD_CRASH=<where>         (mode open) the process dies - exit code 137, no RESULT line, like a power cut - at a precise point of the request:
//                                 send                 right after a decision was taken and committed, before the provider is called (a reservation was just written, or a successor to a page that was just closed)
//                                 before_registration  inside the transaction that registers what the provider answered, before it commits (the transaction is lost)
//                                 registered           after the answer was registered and the page is open, before the page is handed out
//                               (the points around the provider's own calls are the stand-in's faults: SIM_FAULTS createCrashAfter / createCrashBefore / expireCrashAfter)
// The process prints ONE line, `RESULT {json}`; a fault that kills it on purpose (SIM_FAULTS createCrashAfter / createCrashBefore / expireCrashAfter) leaves no line and exit code 137.
import { coherentCreatedAt } from './_clock'
import { db } from './_harness'
import { StripeSim } from './_stripe-sim'
import { pageJobsSettled } from '../../lib/checkout-pages'

const label = process.env.CHILD_LABEL as string
const orderId = process.env.CHILD_ORDER as string
const startAt = Number(process.env.CHILD_START_AT || 0)
const mode = process.env.CHILD_MODE || 'open'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  coherentCreatedAt((await db()) as never)
  const sim = new StripeSim()
  await sim.install() // also reads SIM_FAULTS / SIM_OPTIONS
  const { effectHooks } = await import('../../lib/order-effects')
  effectHooks.printLabConfigured = (() => false) as never
  effectHooks.notifyDiscord = (async () => true) as never
  effectHooks.notifyPush = (async () => true) as never
  effectHooks.consumeInventory = (async () => ({ ok: true, movements: 0 })) as never
  effectHooks.receipt = (async () => undefined) as never
  while (Date.now() < startAt) await sleep(2)
  const startedLateByMs = Date.now() - startAt
  if (mode === 'sync') {
    const { syncPayment } = await import('../../lib/payment-sync')
    const sessionId = process.env.CHILD_SESSION as string
    const result = await syncPayment({ kind: 'checkout_session', id: sessionId, hint: { orderId, attemptId: process.env.CHILD_ATTEMPT } }, { eventType: 'checkout.session.completed', effects: 'background', maxWaitMs: 6000 })
    await pageJobsSettled() // what a payment starts after its commit (the closing of the other pages) belongs to this process: it ends before the process does
    console.log('RESULT ' + JSON.stringify({ label, mode, updatedOrders: result.updatedOrders, paidOrderIds: result.paidOrderIds, startedLateByMs }))
    await sim.close()
    return
  }
  if (mode === 'hold') {
    const { resolvePaymentHold, PaymentHoldError } = await import('../../lib/payment-hold')
    if (process.env.CHILD_NO_JOBS) { const { checkoutPagesHooks } = await import('../../lib/checkout-pages'); checkoutPagesHooks.runJob = async () => undefined }
    try {
      const r = await resolvePaymentHold({
        orderId, adminId: process.env.CHILD_ADMIN as string, outcome: 'no_charge', reason: 'Checked with the customer and with Stripe: nothing was charged.',
        audit: { requestMethod: 'POST', requestPath: '/child/payment-hold', requestIp: null, userAgent: 'sectest-child' },
      })
      console.log('RESULT ' + JSON.stringify({ label, mode, kind: 'decided', status: 200, code: null, reason: r.stripeCheck, startedLateByMs }))
    } catch (error: any) {
      console.log('RESULT ' + JSON.stringify({ label, mode, kind: 'error', status: error instanceof PaymentHoldError ? error.status : null, code: error instanceof PaymentHoldError ? error.code : null, reason: String(error?.message ?? error).slice(0, 160), startedLateByMs }))
    }
    await pageJobsSettled()
    await sim.close()
    return
  }
  const { openCheckoutSession, CheckoutSessionError, checkoutSessionHooks } = await import('../../lib/checkout-sessions')
  const crash = process.env.CHILD_CRASH
  if (crash) {
    let locks = 0
    const die = () => process.exit(137)
    if (crash === 'send') checkoutSessionHooks.afterPlan = async (step) => { if (step === 'send') die() }
    else if (crash === 'before_registration') checkoutSessionHooks.afterLock = async () => { if (++locks === 2) die() } // (the first transaction writes the reservation; the second registers the answer)
    else if (crash === 'registered') checkoutSessionHooks.afterPlan = async (step) => { if (step === 'result') die() }
    else throw new Error(`unknown CHILD_CRASH ${crash}`)
  }
  try {
    const { sanitizeBaseUrl } = await import('../../lib/public-url')
    // (the return address the ROUTE uses - it is part of the request that is stored with a reservation and judged again before the reservation is sent again)
    const r = await openCheckoutSession({ orderId, returnBaseUrl: sanitizeBaseUrl(process.env.BASE_URL) as string })
    console.log('RESULT ' + JSON.stringify({ label, mode, kind: r.kind, reason: 'reason' in r ? r.reason : null, url: r.kind === 'open' ? r.url : null, attemptId: r.kind === 'open' ? r.attemptId : null, startedLateByMs }))
  } catch (error: any) {
    console.log('RESULT ' + JSON.stringify({ label, mode, kind: 'error', status: error instanceof CheckoutSessionError ? error.status : null, code: error instanceof CheckoutSessionError ? error.code : null, message: String(error?.message || error).slice(0, 200), startedLateByMs }))
  }
  await pageJobsSettled()
  await sim.close()
}
main().then(() => process.exit(0)).catch((error) => { console.error(String(error?.stack || error)); process.exit(1) })
