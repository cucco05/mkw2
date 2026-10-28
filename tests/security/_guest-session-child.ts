// Helper process for guest-session-multiprocess.sec.ts: a REAL separate Node process (its own memory, its own database connections) that runs the real
// "pay" route against the shared test database, waits at a barrier, fires its requests at the very same moment as the other process, and writes a
// timestamped log that the test reads.
//
// Stripe is a stand-in that is SHARED between the processes through files, the way the real one is shared through the network: a session is made once per
// idempotency key and every later call with the same key gets the same one back; calls with the same key and other parameters are refused.
// Configuration comes from the environment (CHILD_*), set by the test:
//   CHILD_LABEL, CHILD_LOG, CHILD_GO_FILE (the barrier), CHILD_STRIPE_DIR, CHILD_REQUESTS (JSON: [{ route, body, cookie, ip }]),
//   CHILD_HOLD_MS (hold every request INSIDE the lock for that long and log when it enters and leaves it: the proof that two processes never are inside together),
//   CHILD_NO_PK_LOCK=1 (take the lock of the PURCHASE KEY away in this process - the test seam of lib/checkout-orders.ts - so that only the primary key of the table is left to decide).
import './_harness'
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { NextRequest } from 'next/server'

const label = process.env.CHILD_LABEL as string
const logFile = process.env.CHILD_LOG as string
const goFile = process.env.CHILD_GO_FILE as string
const stripeDir = process.env.CHILD_STRIPE_DIR as string
const holdMs = Number(process.env.CHILD_HOLD_MS || 0)
const noPurchaseKeyLock = process.env.CHILD_NO_PK_LOCK === '1'
const requests = JSON.parse(process.env.CHILD_REQUESTS || '[]') as Array<{ route: 'session' | 'quote'; body: unknown; cookie?: string; ip: string }>
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const wall = () => Math.round(performance.timeOrigin + performance.now())
const stamp = (what: string) => appendFileSync(logFile, `${wall()} ${label} ${what}\n`)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// create a file only if it does not exist yet, atomically and complete (a reader never sees half of it)
function createOnce(file: string, content: string): boolean {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, content)
  try { linkSync(temp, file); return true } catch (err: any) { if (err?.code === 'EEXIST') return false; throw err } finally { try { unlinkSync(temp) } catch { /* gone */ } }
}

function stripeError(type: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`fake ${type}`), { type, ...extra })
}

async function main() {
  mkdirSync(stripeDir, { recursive: true })
  const { installFakeStripe, db } = await import('./_harness')
  await installFakeStripe({
    'checkout.sessions.create': async (params: any, options: any = {}) => {
      const key: string = options.idempotencyKey
      if (!key) throw stripeError('StripeInvalidRequestError', { code: 'missing_idempotency_key' })
      const serialized = JSON.stringify(params)
      const keyFile = path.join(stripeDir, `key-${sha(key)}.json`)
      const id = `cs_test_PROC_${sha(key).slice(0, 24)}`
      const amount = (params.line_items || []).reduce((sum: number, line: any) => sum + line.price_data.unit_amount * line.quantity, 0)
      const session = {
        id, object: 'checkout.session', mode: params.mode, status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.test/c/pay/${id}`,
        amount_total: amount, currency: params.line_items?.[0]?.price_data?.currency, client_reference_id: params.client_reference_id, metadata: params.metadata,
        payment_method_types: params.payment_method_types, expires_at: params.expires_at, payment_intent: null,
      }
      const isNew = createOnce(keyFile, JSON.stringify({ params: serialized, session }))
      if (isNew) {
        createOnce(path.join(stripeDir, `id-${id}.json`), JSON.stringify(session))
        stamp(`stripe.create new key=${key} order=${params.client_reference_id} session=${id}`)
        return session
      }
      const stored = JSON.parse(readFileSync(keyFile, 'utf8')) as { params: string; session: typeof session }
      if (stored.params !== serialized) throw stripeError('StripeIdempotencyError', { code: 'idempotency_error' })
      stamp(`stripe.create again key=${key} order=${params.client_reference_id} session=${stored.session.id}`)
      return stored.session
    },
    'checkout.sessions.retrieve': async (id: string) => {
      const file = path.join(stripeDir, `id-${id}.json`)
      if (!existsSync(file)) throw stripeError('StripeInvalidRequestError', { code: 'resource_missing' })
      stamp(`stripe.retrieve ${id}`)
      return JSON.parse(readFileSync(file, 'utf8'))
    },
    'checkout.sessions.expire': async (id: string) => { stamp(`stripe.expire ${id}`); return { id, status: 'expired' } },
  })
  const { viewerGuards } = await import('../../lib/viewer')
  viewerGuards.getViewer = async () => null
  if (noPurchaseKeyLock) (await import('../../lib/checkout-orders')).checkoutOrderHooks.withoutPurchaseKeyLock = true
  if (holdMs > 0) {
    const { checkoutOrderHooks } = await import('../../lib/checkout-orders')
    checkoutOrderHooks.afterLock = async () => {
      stamp('lock-enter')
      await sleep(holdMs)
      stamp('lock-leave')
    }
  }
  const routes = {
    session: (await import('../../app/api/checkout/session/route')).POST as any,
    quote: (await import('../../app/api/checkout/quote/route')).POST as any,
  }
  await (await db()).$queryRaw`SELECT 1` // the connection is open before the barrier: the race is about the work, not about connecting

  stamp('ready')
  while (!existsSync(goFile)) await sleep(2)

  await Promise.all(requests.map(async (request, index) => {
    const res = (await routes[request.route](new NextRequest(`http://localhost/api/checkout/${request.route}`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': request.ip, ...(request.cookie ? { cookie: request.cookie } : {}) },
      body: JSON.stringify(request.body),
    }), {})) as Response
    const json: any = await res.json().catch(() => null)
    const setSid = res.headers.getSetCookie().some((c) => c.startsWith('mw_sid='))
    stamp(`result ${index} status=${res.status} order=${json?.orderId ?? '-'} url=${json?.url ?? '-'} code=${json?.code ?? '-'} sid=${setSid ? 'set' : 'none'}`)
  }))
  process.exit(0)
}

main().catch((err) => {
  stamp(`crashed ${(err as Error)?.stack || err}`)
  process.exit(2)
})
