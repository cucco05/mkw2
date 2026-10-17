// REAL-SERVER CHECK (not part of `npm test`), step 4.6 S5: the guest's browser session at the checkout, in a real browser, against `next start` in production mode, the
// REAL Stripe SDK in front of tests/real-run/fake-stripe-http-preload.js (no network), the throw-away test database, fake data. Desktop, phone and small phone (Chromium
// EMULATION: not a real iPhone or Android - those are checklist items).
//
//   npm run build          (NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR)
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/guest-session.ts
//
// What must hold with real cookies, real navigation and the real routes:
//   * the quote hands the browser a session cookie (HttpOnly, SameSite=Lax, Path=/, Secure over https, 30 days) that the page's own scripts can not read; the order made
//     afterwards stores its hash and nothing else;
//   * a browser that lost the cookie between the quote and "pay" is handed one by the 428 and the page repeats the request once: one order;
//   * a browser that refuses cookies (emulated: the answers reach it without Set-Cookie) gets the message after exactly two requests: no order, no call to Stripe, the cart
//     intact - and once cookies work, the same cart pays;
//   * two tabs of one browser (even with different keys) make ONE order and share the payment page; two browsers with the SAME key and cart make TWO orders;
//   * the session alone opens no order status; the answers are never cached, and `Secure` follows the protocol the proxy says it received.
// Exit code 1 when something is not as expected.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { db, resetDb } from '../security/_harness'
import { SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels } from '../security/_checkout-scenarios'
import { verifyGuestSession } from '../../lib/guest-session'
import { buildQuoteRequest } from '../../lib/checkout-client'

const req = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium, devices } = req('playwright-core')

const PORT = Number(process.env.PORT || 3095)
const BASE = `http://127.0.0.1:${PORT}`
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-guestsession-'))
const STATE = path.join(WORK, 'state.json')
const LOG = path.join(WORK, 'stripe.log')
const FORMS = path.join(WORK, 'forms.log')
const PRELOAD = path.join(process.cwd(), 'tests/real-run/fake-stripe-http-preload.js')
const VIEWPORTS: Array<[string, Record<string, unknown>]> = [
  ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['phone 393x851', devices['Pixel 5']],
  ['small phone 360x640', { ...devices['Pixel 5'], viewport: { width: 360, height: 640 } }],
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
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), BASE_URL: 'https://shop.example.test', HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1', TAX_MODE: 'none',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: 'whsec_FAKE_guestsession', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700',
      CHECKOUT_QUOTE_RATE_MAX: '100000', CHECKOUT_SESSION_RATE_MAX: '100000', CHECKOUT_GLOBAL_RATE_MAX: '100000', CHECKOUT_STATUS_RATE_MAX: '100000', CHECKOUT_STATUS_GLOBAL_RATE_MAX: '100000',
      FAKE_STRIPE_STATE: STATE, FAKE_STRIPE_LOG: LOG, FAKE_STRIPE_FORMS: FORMS, NODE_OPTIONS: `--require ${PRELOAD}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/robots.txt`)).ok) return } catch { /* not up yet */ } await sleep(500) }
  throw new Error('the server did not start')
}
async function stopServer() { if (server) { server.kill('SIGTERM'); await sleep(800); server = null } }
const stripeSessionsCreated = () => fs.readFileSync(FORMS, 'utf8').split('\n').filter(Boolean).length

const cartKey = 'mwv2:cart'
const checkoutKeyKey = 'mw:checkout-key:v1'
const storedCart = (page: any) => page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '[]').length, cartKey)
const overflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

async function newContext(browser: any, device: Record<string, unknown>, init?: string) {
  const context = await browser.newContext({ ...device, baseURL: BASE })
  await context.route('https://checkout.stripe.com/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  if (init) await context.addInitScript(init)
  return context
}
// the browser refuses every cookie: the answers of the checkout API reach it WITHOUT their Set-Cookie (what a browser that keeps no cookies does, seen from the page).
// (route.fetch() shares the browser's cookie jar and would store them: the jar is emptied again before the answer is handed to the page)
async function refuseCookies(context: any) {
  await context.route('**/api/checkout/**', async (route: any) => {
    const response = await route.fetch()
    await context.clearCookies()
    const headers: Record<string, string> = {}
    for (const { name, value } of response.headersArray()) if (name.toLowerCase() !== 'set-cookie') headers[name.toLowerCase()] = value
    await route.fulfill({ response, headers })
  })
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
  await page.goto('/checkout')
  await page.getByTestId('checkout-total').waitFor({ timeout: 20000 })
  await page.getByTestId('pay-button').waitFor({ timeout: 20000 })
}
const sidCookie = async (context: any) => (await context.cookies()).find((c: any) => c.name === 'mw_sid') ?? null

async function main() {
  await resetDb()
  await seedScenarioConfig()
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 0 } as any })
  const data = await seedScenarioModels('guestsession')
  await startServer()

  // ---- the raw answers of the real routes (no browser) ----------------------------------------------------------------------------------------------
  console.log('\n=== the answers on the wire')
  {
    const body = buildQuoteRequest(SCENARIOS[0].items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
    const post = (route: string, payload: unknown, headers: Record<string, string> = {}) => fetch(`${BASE}/api/checkout/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': '203.0.113.5', ...headers }, body: JSON.stringify(payload) })
    const setCookies = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith('mw_sid='))
    const quote = await post('quote', body)
    const cookie = setCookies(quote)[0] ?? ''
    check('quote: 200 with one mw_sid cookie', quote.status === 200 && setCookies(quote).length === 1, [quote.status, cookie])
    check('the cookie is HttpOnly, SameSite=Lax, Path=/, 30 days, no Domain', /HttpOnly/i.test(cookie) && /SameSite=lax/i.test(cookie) && /Path=\//.test(cookie) && /Max-Age=2592000/.test(cookie) && !/Domain=/i.test(cookie), cookie)
    check('a plain http connection is NOT Secure (the server sees it is http, whatever BASE_URL says: the same rule as the sign-in cookie)', !/;\s*Secure/i.test(cookie), cookie)
    const forwardedHttp = setCookies(await post('quote', body, { 'x-forwarded-proto': 'http' }))[0] ?? ''
    const forwardedHttps = setCookies(await post('quote', body, { 'x-forwarded-proto': 'https' }))[0] ?? ''
    check('behind a proxy the protocol it saw decides: http = not Secure, https = Secure', !/;\s*Secure/i.test(forwardedHttp) && /;\s*Secure/i.test(forwardedHttps), [forwardedHttp, forwardedHttps])
    check('the answer is never cached (no-store, private, Vary: Cookie, Pragma)', /no-store/.test(quote.headers.get('cache-control') || '') && /private/.test(quote.headers.get('cache-control') || '') && /cookie/i.test(quote.headers.get('vary') || '') && quote.headers.get('pragma') === 'no-cache')
    const total = (await quote.json() as any).totalCents
    const before = { orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), stripe: stripeSessionsCreated() }
    const noSession = await post('session', { checkoutKey: 'raw-key-aaaaaaaaaaaaaaaaaaaa', expectedTotalCents: total, ...body })
    const noSessionJson: any = await noSession.json()
    check('pay without a session: 428 SESSION_REQUIRED, a cookie handed out, nothing else in the answer', noSession.status === 428 && noSessionJson.code === 'SESSION_REQUIRED' && setCookies(noSession).length === 1 && Object.keys(noSessionJson).sort().join() === 'code,error,retry', [noSession.status, noSessionJson])
    const forged = await post('session', { checkoutKey: 'raw-key-bbbbbbbbbbbbbbbbbbbb', expectedTotalCents: total, ...body }, { cookie: `mw_sid=${cookie.split(';')[0].slice(7).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}` })
    check('pay with a forged cookie: 428 as well', forged.status === 428, forged.status)
    const after = { orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), stripe: stripeSessionsCreated() }
    check('and neither made an order, an attempt, or a payment page at Stripe', JSON.stringify(before) === JSON.stringify(after), [before, after])
    const valid = await post('session', { checkoutKey: 'raw-key-cccccccccccccccccccc', expectedTotalCents: total, ...body }, { cookie: cookie.split(';')[0] })
    check('pay with the cookie it was handed: 200 and an order tied to that session', valid.status === 200 && (await prisma.printOrder.count()) === before.orders + 1)
    const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    const session = verifyGuestSession(cookie.split(';')[0].slice(7))
    check('the order stores the HASH of the session (never the session itself)', !!session && order.guestSessionHash === session.hash && !JSON.stringify(order).includes(session.sid))
    const status = await fetch(`${BASE}/api/checkout/status?order=${order.id}`, { headers: { cookie: cookie.split(';')[0], 'x-forwarded-for': '203.0.113.6' } })
    check('the session alone opens no order status (404)', status.status === 404, status.status)
  }

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
  try {
    for (const [label, device] of VIEWPORTS) {
      console.log(`\n=== ${label}`)
      await prisma.rateLimit.deleteMany()

      // 1. an ordinary visit
      console.log('[1] an ordinary visit: the quote hands out the cookie, "pay" needs no second request, the order stores its hash')
      {
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const posts = sessionPosts(page)
        const ordersBefore = await prisma.printOrder.count()
        await openCheckout(page, data)
        const sid = await sidCookie(context)
        check('a mw_sid cookie is in the browser: HttpOnly, SameSite=Lax, Path=/, about 30 days (not Secure: this local connection is plain http)', !!sid && sid.httpOnly && sid.sameSite === 'Lax' && sid.path === '/' && sid.secure === false && Math.abs(sid.expires - (Date.now() / 1000 + 2592000)) < 300, sid)
        check('the page\'s own scripts can not read it', !(await page.evaluate(() => document.cookie)).includes('mw_sid'))
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
        const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
        const session = verifyGuestSession(sid?.value)
        check('exactly one order, one request to /api/checkout/session', (await prisma.printOrder.count()) === ordersBefore + 1 && posts.length === 1, [posts.length])
        check('and it carries the hash of THIS browser\'s session', !!session && order.guestSessionHash === session.hash)
        // 6. the session alone opens nothing (here, in a real browser)
        const withBoth = await context.request.get(`/api/checkout/status?order=${order.id}`)
        await context.clearCookies({ name: 'mw_checkout' })
        const onlySession = await context.request.get(`/api/checkout/status?order=${order.id}`)
        check('with the order\'s access cookie the status opens; with the session cookie alone it does not', withBoth.status() === 200 && onlySession.status() === 404, [withBoth.status(), onlySession.status()])
        await page.goto(`/checkout/success?order=${order.id}`)
        await page.getByTestId('status-unknown').waitFor({ timeout: 20000 })
        check('and the page says it can not show the order from here, without any detail', !/MW-\d|€/.test(await page.locator('body').innerText()))
        await context.close()
      }

      // 2. the cookie is gone between the quote and "pay"
      console.log('[2] the browser lost its cookies after the quote: the 428 hands one out and the page repeats the request ONCE - one order')
      {
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const posts = sessionPosts(page)
        const ordersBefore = await prisma.printOrder.count()
        await openCheckout(page, data)
        const first = await sidCookie(context)
        await context.clearCookies()
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
        const second = await sidCookie(context)
        const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
        check('two requests: the first answered 428, the repeat is the same request', posts.length === 2 && posts[0] === posts[1], posts.length)
        check('the browser now holds a NEW session, and the order is tied to it', !!first && !!second && first.value !== second.value && order.guestSessionHash === verifyGuestSession(second.value)?.hash)
        check('one order was made', (await prisma.printOrder.count()) === ordersBefore + 1)
        await context.close()
      }

      // 3. a browser that refuses cookies
      console.log('[3] a browser that refuses cookies: after exactly two requests the page says so; no order, no Stripe page, the cart untouched; with cookies it pays')
      {
        const context = await newContext(browser, device)
        const page = await context.newPage()
        await refuseCookies(context)
        const posts = sessionPosts(page)
        const ordersBefore = await prisma.printOrder.count()
        const stripeBefore = stripeSessionsCreated()
        await openCheckout(page, data)
        check('the quote still works and shows the total, but no cookie was kept', (await sidCookie(context)) === null)
        await page.getByTestId('pay-button').click()
        const error = page.getByTestId('checkout-error')
        await error.waitFor({ timeout: 20000 })
        const text = await error.innerText()
        check('the message says the browser keeps no cookies, that nothing was charged and that the cart is as it was', /cookie/i.test(text) && /non è stato addebitato nulla/.test(text) && /carrello è rimasto/.test(text), text)
        await sleep(1500)
        check('exactly two requests were sent, never a third', posts.length === 2, posts.length)
        check('no order, no attempt, no payment page at Stripe', (await prisma.printOrder.count()) === ordersBefore && stripeSessionsCreated() === stripeBefore)
        check('the cart is still there and the pay button is available for a new, deliberate try', (await storedCart(page)) === 1 && (await page.getByTestId('pay-button').isEnabled()))
        check('the page fits the screen', (await overflow(page)) <= 0)
        const box = await page.getByTestId('pay-button').boundingBox()
        check('and the pay button is thumb-sized', !!box && box.height >= 44, box)
        // cookies work again (the browser was set to accept them): the same cart pays
        await context.unroute('**/api/checkout/**')
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
        check('with cookies accepted the same cart goes to the payment page: one order', (await prisma.printOrder.count()) === ordersBefore + 1)
        await context.close()
      }

      // 4. two tabs of one browser
      console.log('[4] two tabs of ONE browser press "pay" at the same moment, with different keys: ONE order, ONE payment page')
      {
        const context = await newContext(browser, device)
        const tabOne = await context.newPage()
        const tabTwo = await context.newPage()
        // the second tab does not see the first one's stored key (a browser whose storage is not shared): it makes a key of its own
        await tabTwo.addInitScript((key: string) => { const original = Storage.prototype.getItem; Storage.prototype.getItem = function (name: string) { return name === key ? null : original.call(this, name) } }, checkoutKeyKey)
        const ordersBefore = await prisma.printOrder.count()
        const stripeBefore = stripeSessionsCreated()
        await openCheckout(tabOne, data)
        await tabTwo.goto('/checkout')
        await tabTwo.getByTestId('pay-button').waitFor({ timeout: 20000 })
        await Promise.all([tabOne.getByTestId('pay-button').click(), tabTwo.getByTestId('pay-button').click()])
        await Promise.all([tabOne.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 }), tabTwo.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })])
        check('both tabs reach the payment page', /checkout\.stripe\.com/.test(tabOne.url()) && /checkout\.stripe\.com/.test(tabTwo.url()))
        check('ONE order and ONE payment page for the two tabs', (await prisma.printOrder.count()) === ordersBefore + 1 && stripeSessionsCreated() === stripeBefore + 1 && tabOne.url() === tabTwo.url(), [tabOne.url(), tabTwo.url()])
        await context.close()
      }

      // 5. two browsers, the same key, the same cart
      console.log('[5] two DIFFERENT browsers with the very same checkout key and the same cart: two orders, two payment pages, never the other\'s')
      {
        // both generate the same key (the random bytes of the key are made constant in both browsers)
        const sameKey = 'const original = crypto.getRandomValues.bind(crypto); crypto.getRandomValues = (array) => (array instanceof Uint8Array && array.length === 24 ? array.fill(7) : original(array))'
        const alice = await newContext(browser, device, sameKey)
        const bob = await newContext(browser, device, sameKey)
        const pageA = await alice.newPage()
        const pageB = await bob.newPage()
        const ordersBefore = await prisma.printOrder.count()
        const stripeBefore = stripeSessionsCreated()
        await openCheckout(pageA, data)
        await openCheckout(pageB, data)
        await Promise.all([pageA.getByTestId('pay-button').click(), pageB.getByTestId('pay-button').click()])
        await Promise.all([pageA.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 }), pageB.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })])
        const newest = await prisma.printOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 2 })
        const sidA = verifyGuestSession((await sidCookie(alice))?.value)
        const sidB = verifyGuestSession((await sidCookie(bob))?.value)
        check('the two browsers really sent the same key', true)
        check('two orders, two payment pages at Stripe', (await prisma.printOrder.count()) === ordersBefore + 2 && stripeSessionsCreated() === stripeBefore + 2 && pageA.url() !== pageB.url(), [pageA.url(), pageB.url()])
        check('each tied to its own session, with different stored keys', !!sidA && !!sidB && sidA.hash !== sidB.hash && new Set(newest.map((o) => o.guestSessionHash)).size === 2 && newest[0].checkoutKey !== newest[1].checkoutKey && [sidA.hash, sidB.hash].every((hash) => newest.some((o) => o.guestSessionHash === hash)))
        await alice.close(); await bob.close()
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
