// REAL-SERVER CHECK (not part of `npm test`), step 4.2-ter A3: the currency the pages were BUILT for against the one the server runs with.
// It starts `next start` (production mode, the REAL Stripe SDK in front of tests/real-run/fake-stripe-http-preload.js, no network, the throw-away
// test database) with several run-time currencies, asks for a quote and for a payment session, and prints what happened.
//
//   BUILT=EUR  (what the build was made with; npm run build with NEXT_PUBLIC_CURRENCY=EUR, or with nothing for the "Docker bug")
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest BUILT=EUR node --import tsx tests/real-run/currency-guard.ts
//
// Expected: run-time currency == BUILT -> quote canCheckout=true and a session is created; any other -> canCheckout=false with the reason
// CURRENCY_MISMATCH, no session (503), and NO order in the database. Exit code 1 when that is not what happened.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, resetDb } from '../security/_harness'
import { SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels } from '../security/_checkout-scenarios'
import { buildQuoteRequest } from '../../lib/checkout-client'

const BUILT = (process.env.BUILT || 'EUR').toUpperCase()
const PORT = Number(process.env.PORT || 3098)
const BASE = `http://127.0.0.1:${PORT}`
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-currency-'))
const PRELOAD = path.join(process.cwd(), 'tests/real-run/fake-stripe-http-preload.js')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let server: ChildProcess | null = null
async function start(env: Record<string, string>) {
  fs.writeFileSync(path.join(WORK, 'state.json'), '')
  fs.writeFileSync(path.join(WORK, 'forms.log'), '')
  fs.writeFileSync(path.join(WORK, 'stripe.log'), '')
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), BASE_URL: 'https://shop.example.test', HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: 'whsec_FAKE_currency', TAX_MODE: 'none',
      CHECKOUT_QUOTE_RATE_MAX: '100000', CHECKOUT_SESSION_RATE_MAX: '100000', CHECKOUT_GLOBAL_RATE_MAX: '100000',
      FAKE_STRIPE_STATE: path.join(WORK, 'state.json'), FAKE_STRIPE_LOG: path.join(WORK, 'stripe.log'), FAKE_STRIPE_FORMS: path.join(WORK, 'forms.log'),
      NODE_OPTIONS: `--require ${PRELOAD}`, ...env,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/robots.txt`)).ok) return } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('the server did not start')
}
async function stop() { if (server) { server.kill('SIGTERM'); await sleep(800); server = null } }

async function post(pathname: string, body: unknown) {
  const res = await fetch(`${BASE}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

;(async () => {
  await resetDb()
  await seedScenarioConfig()
  const data = await seedScenarioModels('cg')
  const prisma = await db()
  const scenario = SCENARIOS[0]
  const request = buildQuoteRequest(scenario.items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
  const runs: Array<{ label: string; env: Record<string, string>; sameAsBuild: boolean }> = [
    { label: `run-time ${BUILT} (same as the build)`, env: { CURRENCY: BUILT, NEXT_PUBLIC_CURRENCY: BUILT }, sameAsBuild: true },
    { label: `run-time CURRENCY=${BUILT === 'EUR' ? 'USD' : 'EUR'} (the build is for ${BUILT})`, env: { CURRENCY: BUILT === 'EUR' ? 'USD' : 'EUR', NEXT_PUBLIC_CURRENCY: BUILT === 'EUR' ? 'USD' : 'EUR' }, sameAsBuild: false },
    { label: 'run-time CURRENCY not set at all (production)', env: { CURRENCY: '', NEXT_PUBLIC_CURRENCY: '' }, sameAsBuild: false },
    { label: 'run-time CURRENCY=EURO (typo)', env: { CURRENCY: 'EURO', NEXT_PUBLIC_CURRENCY: 'EURO' }, sameAsBuild: false },
  ]
  let failed = 0
  for (const run of runs) {
    await prisma.rateLimit.deleteMany()
    await prisma.paymentAttempt.deleteMany()
    await prisma.printOrder.deleteMany()
    await start(run.env)
    const quote = await post('/api/checkout/quote', request)
    const session = await post('/api/checkout/session', { ...request, checkoutKey: `currency-guard-${Math.random().toString(36).slice(2)}-key`, expectedTotalCents: quote.json?.totalCents ?? 1 })
    const orders = await prisma.printOrder.count()
    const forms = fs.readFileSync(path.join(WORK, 'forms.log'), 'utf8').split('\n').filter(Boolean).length
    const ok = run.sameAsBuild
      ? quote.status === 200 && quote.json?.canCheckout === true && session.status === 200 && orders === 1 && forms === 1
      : quote.status === 200 && quote.json?.canCheckout === false && /^CURRENCY_/.test(String(quote.json?.unavailableReason)) && session.status === 503 && /^CURRENCY_/.test(String(session.json?.code)) && orders === 0 && forms === 0
    if (!ok) failed++
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${run.label}: quote ${quote.status} currency=${quote.json?.currency} canCheckout=${quote.json?.canCheckout} reason=${quote.json?.unavailableReason ?? '-'} | session ${session.status} ${session.json?.code ?? ''} | orders=${orders} stripeCalls=${forms}`)
    await stop()
  }
  console.log(`\n${runs.length} runs, ${failed} not as expected`)
  process.exit(failed ? 1 : 0)
})().catch(async (err) => { console.error(err); await stop(); process.exit(2) })
