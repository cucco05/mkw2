// REAL-SERVER CONTROL (not part of `npm test`), step 4.6 S5 closure (R7): development over PLAIN http is unchanged - and the planting check of the https run can fail.
//
// The guest cookie is `__Host-mw_sid` in production (tests/real-run/guest-session.ts, behind a TLS proxy) and `mw_sid` everywhere else. This script runs the SAME visitor
// against `next dev` (NODE_ENV=development, plain http://127.0.0.1, no proxy, TRUSTED_PROXY_HOPS=1 as the harder case: nothing may be refused outside production), in a
// real Chromium (EMULATION: not a real phone), the REAL Stripe SDK in front of tests/real-run/fake-stripe-http-preload.js (no network), the throw-away database, fake data:
//   * the quote hands out `mw_sid` (HttpOnly, SameSite=Lax, Path=/, NOT Secure, ~30 days) and no `__Host-` cookie; "pay" reaches the payment page; the order stores the hash;
//   * the browser that lost its cookie is handed one by the 428 and the page repeats once (one order);
//   * the control: a valid `mw_sid` PLANTED before the quote IS the session over plain http (the order carries the planter's hash) - which is exactly what the https run proves
//     can no longer happen in production, where that name is not read;
//   * on the wire, outside production, a proxy that says "http" does not stop the guest (`mw_sid`, not Secure) and one that says "https" gets `__Host-mw_sid`, Secure.
//
// `next dev` rewrites `.next`: run this LAST and build again afterwards (`CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR npm run build`).
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/guest-session-dev.ts
// Exit code 1 when something is not as expected.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { db, resetDb } from '../security/_harness'
import { SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels } from '../security/_checkout-scenarios'
import { GUEST_SESSION_COOKIE, GUEST_SESSION_COOKIE_HOST, mintGuestSession, verifyGuestSession } from '../../lib/guest-session'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { wire, type Wire } from './_wire'
import { strongTestKey } from '../security/_keys'

const req = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium, devices } = req('playwright-core')

const PORT = Number(process.env.PORT || 3094)
const BASE = `http://127.0.0.1:${PORT}`
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-guestsession-dev-'))
const STATE = path.join(WORK, 'state.json')
const LOG = path.join(WORK, 'stripe.log')
const FORMS = path.join(WORK, 'forms.log')
const PRELOAD = path.join(process.cwd(), 'tests/real-run/fake-stripe-http-preload.js')
const VIEWPORTS: Array<[string, Record<string, unknown>]> = [
  ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['phone 393x851', devices['Pixel 5']],
]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ` ${JSON.stringify(extra).slice(0, 400)}` : ''}`) }
}

let server: ChildProcess | null = null
async function startServer() {
  fs.writeFileSync(LOG, ''); fs.writeFileSync(FORMS, ''); try { fs.rmSync(STATE) } catch { /* none yet */ }
  server = spawn('node_modules/.bin/next', ['dev', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), BASE_URL: BASE, HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1', TAX_MODE: 'none',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: 'whsec_FAKE_guestsession_dev', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700',
      CHECKOUT_QUOTE_RATE_MAX: '100000', CHECKOUT_SESSION_RATE_MAX: '100000', CHECKOUT_GLOBAL_RATE_MAX: '100000', CHECKOUT_STATUS_RATE_MAX: '100000', CHECKOUT_STATUS_GLOBAL_RATE_MAX: '100000',
      FAKE_STRIPE_STATE: STATE, FAKE_STRIPE_LOG: LOG, FAKE_STRIPE_FORMS: FORMS, NODE_OPTIONS: `--require ${PRELOAD}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${BASE}/robots.txt`)).ok } catch { /* not up yet */ } if (!up) await sleep(1000) }
  if (!up) throw new Error('the dev server did not start')
}
async function stopServer() { if (server) { server.kill('SIGTERM'); await sleep(1500); server = null } }
const stripeSessionsCreated = () => fs.readFileSync(FORMS, 'utf8').split('\n').filter(Boolean).length

const cartKey = 'mwv2:cart'
async function newContext(browser: any, device: Record<string, unknown>) {
  const context = await browser.newContext({ ...device, baseURL: BASE })
  await context.route('https://checkout.stripe.com/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  return context
}
const sessionPosts = (page: any) => {
  const bodies: string[] = []
  page.on('request', (r: any) => { if (new URL(r.url()).pathname === '/api/checkout/session' && r.method() === 'POST') bodies.push(r.postData() || '') })
  return bodies
}
async function openCheckout(page: any, data: any) {
  await page.goto('/robots.txt')
  const cart = SCENARIOS[0].items.map((spec, i) => persistedCartItem(spec, data, i))
  await page.evaluate(([items, key]: [unknown, string]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(items)) }, [cart, cartKey])
  await page.goto('/checkout', { timeout: 120000 })
  await page.getByTestId('checkout-total').waitFor({ timeout: 90000 })
  await page.getByTestId('pay-button').waitFor({ timeout: 90000 })
}
const plainCookie = async (context: any) => (await context.cookies()).find((c: any) => c.name === GUEST_SESSION_COOKIE) ?? null
const hostCookie = async (context: any) => (await context.cookies()).find((c: any) => c.name === GUEST_SESSION_COOKIE_HOST) ?? null

async function main() {
  await resetDb()
  await seedScenarioConfig()
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 0 } as any })
  const data = await seedScenarioModels('guestsessiondev')
  await startServer()
  const counts = async () => ({ orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), stripe: stripeSessionsCreated() })

  // ---- warm-up: the first request of each route compiles it (slow in development); nothing is made ---------------------------------------------------
  const body = buildQuoteRequest(SCENARIOS[0].items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
  const post = (route: string, payload: unknown, headers: Record<string, string | undefined> = {}) => wire(BASE, route, payload, { origin: BASE, 'x-forwarded-for': '203.0.113.5', ...headers })
  console.log('warm-up (development compiles every route on first use) ...')
  await post('quote', body)
  await post('session', { checkoutKey: strongTestKey('warm-up-key'), expectedTotalCents: 1, ...body })
  await fetch(`${BASE}/checkout`)
  await fetch(`${BASE}/api/checkout/status?order=warmup`, { headers: { 'x-forwarded-for': '203.0.113.6' } })
  await prisma.rateLimit.deleteMany()

  // ---- on the wire ---------------------------------------------------------------------------------------------------------------------------------
  console.log('\n=== the answers on the wire (development, plain http)')
  {
    const named = (res: Wire, name: string) => res.setCookies.filter((c) => c.startsWith(`${name}=`))
    const quote = await post('quote', body)
    const cookie = named(quote, GUEST_SESSION_COOKIE)[0] ?? ''
    check('quote over plain http: ONE mw_sid cookie, no __Host-mw_sid', quote.status === 200 && named(quote, GUEST_SESSION_COOKIE).length === 1 && named(quote, GUEST_SESSION_COOKIE_HOST).length === 0, [quote.status, quote.setCookies])
    check('the cookie is HttpOnly, SameSite=Lax, Path=/, 30 days, no Domain - and NOT Secure (the server sees plain http)', /HttpOnly/i.test(cookie) && /SameSite=lax/i.test(cookie) && /Path=\//.test(cookie) && /Max-Age=2592000/.test(cookie) && !/Domain=/i.test(cookie) && !/;\s*Secure/i.test(cookie), cookie)
    const total = quote.json.totalCents as number
    const before = await counts()
    const noSession = await post('session', { checkoutKey: strongTestKey('dev-key-nosession'), expectedTotalCents: total, ...body })
    check('pay without a session: 428 SESSION_REQUIRED and a mw_sid handed out; nothing made', noSession.status === 428 && noSession.json.code === 'SESSION_REQUIRED' && named(noSession, GUEST_SESSION_COOKIE).length === 1 && JSON.stringify(await counts()) === JSON.stringify(before), [noSession.status, noSession.json])
    const paid = await post('session', { checkoutKey: strongTestKey('dev-key-cccc'), expectedTotalCents: total, ...body }, { cookie: cookie.split(';')[0] })
    check('pay with the cookie it was handed: 200 and an order tied to that session', paid.status === 200 && (await prisma.printOrder.count()) === before.orders + 1, paid.status)
    const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    check('the order stores the HASH of the session', order.guestSessionHash === verifyGuestSession(cookie.split(';')[0].slice(GUEST_SESSION_COOKIE.length + 1))?.hash)
    check('the weaker name is the one that is read: a __Host-mw_sid sent over plain http is not a session (428)', (await post('session', { checkoutKey: strongTestKey('dev-key-hostname'), expectedTotalCents: total, ...body }, { cookie: `${GUEST_SESSION_COOKIE_HOST}=${cookie.split(';')[0].slice(GUEST_SESSION_COOKIE.length + 1)}` })).status === 428)
    // a proxy in front, outside production: the protocol it saw decides - and nothing is refused
    const saysHttp = await post('quote', body, { 'x-forwarded-proto': 'http' })
    check('a proxy that says "http": the guest is NOT refused - mw_sid, not Secure', saysHttp.status === 200 && named(saysHttp, GUEST_SESSION_COOKIE).length === 1 && !/;\s*Secure/i.test(named(saysHttp, GUEST_SESSION_COOKIE)[0]), saysHttp.setCookies)
    const saysHttpPay = await post('session', { checkoutKey: strongTestKey('dev-key-http'), expectedTotalCents: total, ...body }, { 'x-forwarded-proto': 'http', cookie: cookie.split(';')[0] })
    check('and pays: not a 503', saysHttpPay.status === 200, saysHttpPay.status)
    const saysHttps = await post('quote', body, { 'x-forwarded-proto': 'https' })
    check('a proxy that says "https": __Host-mw_sid, Secure (a local TLS front keeps working)', saysHttps.status === 200 && named(saysHttps, GUEST_SESSION_COOKIE_HOST).length === 1 && /;\s*Secure/i.test(named(saysHttps, GUEST_SESSION_COOKIE_HOST)[0]) && named(saysHttps, GUEST_SESSION_COOKIE).length === 0, saysHttps.setCookies)
  }

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
  try {
    for (const [label, device] of VIEWPORTS) {
      console.log(`\n=== ${label} (development, plain http)`)
      await prisma.rateLimit.deleteMany()

      console.log('[1] an ordinary visit: mw_sid in the browser, "pay" needs no second request, the order stores its hash')
      {
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const posts = sessionPosts(page)
        const ordersBefore = await prisma.printOrder.count()
        await openCheckout(page, data)
        const sid = await plainCookie(context)
        check('Chromium kept a mw_sid cookie: HttpOnly, SameSite=Lax, Path=/, NOT Secure, about 30 days - and no __Host-mw_sid', !!sid && sid.httpOnly && sid.sameSite === 'Lax' && sid.path === '/' && sid.secure === false && Math.abs(sid.expires - (Date.now() / 1000 + 2592000)) < 300 && (await hostCookie(context)) === null, sid)
        check('the page\'s own scripts can not read it', !(await page.evaluate(() => document.cookie)).includes('mw_sid'))
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90000 })
        const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
        check('exactly one order, one request to /api/checkout/session, tied to this browser\'s session', (await prisma.printOrder.count()) === ordersBefore + 1 && posts.length === 1 && order.guestSessionHash === verifyGuestSession(sid?.value)?.hash, [posts.length])
        await context.close()
      }

      console.log('[2] the browser lost its cookies after the quote: the 428 hands out a mw_sid and the page repeats the request ONCE - one order')
      {
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const posts = sessionPosts(page)
        const ordersBefore = await prisma.printOrder.count()
        await openCheckout(page, data)
        const first = await plainCookie(context)
        await context.clearCookies()
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90000 })
        const second = await plainCookie(context)
        const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
        check('two requests (the first answered 428, the repeat is the same request), a NEW mw_sid, one order tied to it', posts.length === 2 && posts[0] === posts[1] && !!first && !!second && first.value !== second.value && (await prisma.printOrder.count()) === ordersBefore + 1 && order.guestSessionHash === verifyGuestSession(second.value)?.hash, posts.length)
        await context.close()
      }

      console.log('[3] CONTROL: a valid mw_sid planted before the quote IS the session over plain http (the weakness the production name closes)')
      {
        const attacker = mintGuestSession()
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const ordersBefore = await prisma.printOrder.count()
        await context.addCookies([{ name: GUEST_SESSION_COOKIE, value: attacker.value, url: BASE }])
        await openCheckout(page, data)
        check('the quote handed out nothing new: the planted cookie was taken for the session', (await plainCookie(context))?.value === attacker.value)
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90000 })
        const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
        check('and the order carries the PLANTER\'s hash - so the same attempt in the https run (which finds none) is a real test', (await prisma.printOrder.count()) === ordersBefore + 1 && order.guestSessionHash === attacker.session.hash)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await stopServer()
  }
  console.log(`\n${pass} checks passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (err) => { console.error(err); await stopServer(); process.exit(2) })
