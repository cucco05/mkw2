// Helper process for payment-sync-multiprocess.sec.ts: a REAL separate Node process (its own database connections, its own memory)
// that runs the payment synchronisation against the shared test database with a fake Stripe, and writes a timestamped log that the
// test reads. Configuration comes from the environment (CHILD_*), set by the test.
// CHILD_CLOCK_SKEW_MS: this process believes its own clock is that many milliseconds off (like a server with a wrong clock).
const skew = Number(process.env.CHILD_CLOCK_SKEW_MS || 0)
if (skew !== 0) {
  const realNow = Date.now
  Date.now = () => realNow() + skew
}
import './_harness'
import { appendFileSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const label = process.env.CHILD_LABEL as string
const logFile = process.env.CHILD_LOG as string
const sessionFile = process.env.CHILD_SESSION_FILE as string
const mode = process.env.CHILD_MODE || 'normal' // normal | hang (read never returns) | pause (stalls between reading and applying)
const readMs = Number(process.env.CHILD_READ_MS || 0)
const pauseMs = Number(process.env.CHILD_PAUSE_MS || 5000)
const eventIds = JSON.parse(process.env.CHILD_EVENTS || '[]') as string[]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// real wall-clock time (not affected by the pretend skew above), so the test can compare processes
const wall = () => Math.round(performance.timeOrigin + performance.now())
const stamp = (what: string) => appendFileSync(logFile, `${wall()} ${label} ${what}\n`)

async function main() {
  const { installFakeStripe } = await import('./_harness')
  await installFakeStripe({
    'checkout.sessions.retrieve': async () => {
      stamp('read_start')
      if (mode === 'hang') await new Promise(() => {})
      if (readMs > 0) await sleep(readMs)
      const { session } = JSON.parse(readFileSync(sessionFile, 'utf8'))
      stamp('read_end')
      return session
    },
  })
  // the outside services after a payment are replaced by counters, so the test can see how many times each ran, across processes
  const { effectHooks } = await import('../../lib/order-effects')
  effectHooks.receipt = (async () => { stamp('effect:receipt') }) as any
  effectHooks.consumeInventory = (async () => ({ ok: true, movements: 0 })) as any
  effectHooks.printLabConfigured = (async () => false) as any
  effectHooks.notifyDiscord = (async () => { stamp('effect:notify'); return true }) as any
  effectHooks.notifyPush = (async () => true) as any

  const { syncPayment, syncHooks } = await import('../../lib/payment-sync')
  if (mode === 'pause') {
    syncHooks.afterRead = async () => {
      stamp('paused')
      await sleep(pauseMs)
    }
  }
  const { session, orderId, attemptId } = JSON.parse(readFileSync(sessionFile, 'utf8'))
  const results = await Promise.allSettled(eventIds.map((id) => syncPayment(
    { kind: 'checkout_session', id: session.id, hint: { orderId, attemptId } },
    {
      eventType: 'checkout.session.completed',
      event: { id, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: session.id, object: 'checkout.session', metadata: { orderId, attemptId } } } } as any,
    },
  )))
  results.forEach((result, index) => {
    stamp(`result ${eventIds[index]} ${result.status === 'fulfilled' ? (result.value.duplicate ? 'duplicate' : 'ok') : `error:${(result.reason as Error)?.name || 'Error'}`}`)
  })
  process.exit(0)
}

main().catch((err) => {
  stamp(`crashed ${(err as Error)?.stack || err}`)
  process.exit(2)
})
