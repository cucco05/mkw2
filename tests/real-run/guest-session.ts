// REAL-SERVER CHECK (not part of `npm test`), step 4.6 S5: the guest's browser session at the checkout, in a real browser, against `next start` in production mode, the
// REAL Stripe SDK in front of tests/real-run/fake-stripe-http-preload.js (no network), the throw-away test database, fake data. Desktop, phone and small phone (Chromium
// EMULATION: not a real iPhone or Android - those are checklist items).
//
//   npm run build          (NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR)
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/guest-session.ts
//
// (step 4.6, S5 closure, R7) The server runs in PRODUCTION mode, where a guest's cookie is `__Host-mw_sid` and a browser keeps such a cookie only over a real https
// connection. So the browser reaches `next start` through a TLS proxy (tests/real-run/_tls-proxy.ts: self-signed certificate, `X-Forwarded-Proto: https` SET by the
// proxy, `ignoreHTTPSErrors`), like production does. The calls made straight at the server, without a browser, say what the proxy would say.
//
// What must hold with real cookies, real navigation and the real routes:
//   * the quote hands the browser a session cookie `__Host-mw_sid` (HttpOnly, SameSite=Lax, Secure, Path=/, no Domain, 30 days) that the page's own scripts can not read
//     or replace; the order made afterwards stores its hash and nothing else;
//   * a `mw_sid` planted in the browser BEFORE the quote (what a sibling site or a plain-http network could do) is never adopted: the order carries the hash of the
//     session the server handed out;
//   * in production nothing a request writes lowers the cookie to the weaker name (forged `X-Forwarded-Proto` / `Forwarded`, `COOKIE_SECURE=false`), and a connection the
//     proxy says is plain http - or a browser that reaches the server without the proxy - sees the price but does not check out (503, nothing made, no cookie);
//   * a browser that lost the cookie between the quote and "pay" is handed one by the 428 and the page repeats the request once: one order;
//   * a browser that refuses cookies (emulated: the answers reach it without Set-Cookie) gets the message after exactly two requests: no order, no call to Stripe, the cart
//     intact - and once cookies work, the same cart pays;
//   * two tabs of one browser (even with different keys) make ONE order and share the payment page; two browsers with the SAME key and cart make ONE order (R1-1b): the
//     other is refused, with a support code and nothing of the first (nor a word about the state of the purchase);
//   * the session alone opens no order status, and the answers are never cached.
// Exit code 1 when something is not as expected.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { db, resetDb } from '../security/_harness'
import { strongTestKey } from '../security/_keys'
import { SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels } from '../security/_checkout-scenarios'
import { GUEST_SESSION_COOKIE, GUEST_SESSION_COOKIE_HOST, mintGuestSession, verifyGuestSession } from '../../lib/guest-session'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { startTlsProxy, type TlsProxy } from './_tls-proxy'
import { wire, type Wire } from './_wire'

const req = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium, devices } = req('playwright-core')

const PORT = Number(process.env.PORT || 3095)
// the server itself (the calls made without a browser, the readiness probe); the browser uses PUBLIC, the https address of the TLS proxy in front of it
const BASE = `http://127.0.0.1:${PORT}`
let PUBLIC = BASE
let proxy: TlsProxy | null = null
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
let sameKeyRound = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ` ${JSON.stringify(extra).slice(0, 400)}` : ''}`) }
}

let server: ChildProcess | null = null
async function startServer() {
  fs.writeFileSync(LOG, ''); fs.writeFileSync(FORMS, ''); try { fs.rmSync(STATE) } catch { /* none yet */ }
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), BASE_URL: 'https://shop.example.test', HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1', TAX_MODE: 'none',
      // the default of docker-compose.yml: production must not take the weaker guest cookie from it (lib/guest-cookie-transport.ts)
      COOKIE_SECURE: 'false',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: 'whsec_FAKE_guestsession', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700',
      CHECKOUT_QUOTE_RATE_MAX: '100000', CHECKOUT_SESSION_RATE_MAX: '100000', CHECKOUT_GLOBAL_RATE_MAX: '100000', CHECKOUT_STATUS_RATE_MAX: '100000', CHECKOUT_STATUS_GLOBAL_RATE_MAX: '100000',
      FAKE_STRIPE_STATE: STATE, FAKE_STRIPE_LOG: LOG, FAKE_STRIPE_FORMS: FORMS, NODE_OPTIONS: `--require ${PRELOAD}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let up = false
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/robots.txt`)).ok } catch { /* not up yet */ } if (!up) await sleep(500) }
  if (!up) throw new Error('the server did not start')
  proxy = await startTlsProxy(PORT)
  PUBLIC = proxy.origin
}
async function stopServer() { if (proxy) { await proxy.stop(); proxy = null } if (server) { server.kill('SIGTERM'); await sleep(800); server = null } }
const stripeSessionsCreated = () => fs.readFileSync(FORMS, 'utf8').split('\n').filter(Boolean).length

const cartKey = 'mwv2:cart'
const checkoutKeyKey = 'mw:checkout-key:v1'
const storedCart = (page: any) => page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '[]').length, cartKey)
const overflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

async function newContext(browser: any, device: Record<string, unknown>, init?: string, base: string = PUBLIC) {
  const context = await browser.newContext({ ...device, baseURL: base, ignoreHTTPSErrors: true })
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
// the session cookie in the browser's jar: the one production names `__Host-mw_sid`; the weaker name `mw_sid` is looked for separately (it must never appear)
const sidCookie = async (context: any) => (await context.cookies()).find((c: any) => c.name === GUEST_SESSION_COOKIE_HOST) ?? null
const weakSidCookie = async (context: any) => (await context.cookies()).find((c: any) => c.name === GUEST_SESSION_COOKIE) ?? null

async function main() {
  await resetDb()
  await seedScenarioConfig()
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 0 } as any })
  const data = await seedScenarioModels('guestsession')
  await startServer()

  // ---- the raw answers of the real routes (no browser) ----------------------------------------------------------------------------------------------
  console.log('\n=== the answers on the wire')
  const counts = async () => ({ orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), stripe: stripeSessionsCreated() })
  {
    const body = buildQuoteRequest(SCENARIOS[0].items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
    // What the proxy of production adds to every request it forwards is `X-Forwarded-Proto: https`; a call made straight at the server says it too. The checks of
    // the fail-safe write another word, or none, on purpose (`undefined` = the header is not sent at all).
    // Behind the proxy the browser's `Origin` is the https one; a request that says "plain http" has the plain one (the origin check comes before everything else)
    const SAYS_HTTPS = `https://127.0.0.1:${PORT}`
    const post = (route: string, payload: unknown, headers: Record<string, string | undefined> = {}) =>
      wire(BASE, route, payload, { origin: SAYS_HTTPS, 'x-forwarded-for': '203.0.113.5', 'x-forwarded-proto': 'https', ...headers })
    const hostCookies = (res: Wire) => res.setCookies.filter((c) => c.startsWith(`${GUEST_SESSION_COOKIE_HOST}=`))
    const sessionCookies = (res: Wire) => res.setCookies.filter((c) => /^(__Host-)?mw_sid=/.test(c))
    const pair = (setCookie: string) => setCookie.split(';')[0]
    const valueOf = (setCookie: string) => pair(setCookie).slice(GUEST_SESSION_COOKIE_HOST.length + 1)
    const payBody = (key: string, total: number) => ({ checkoutKey: key, expectedTotalCents: total, ...body })

    const quote = await post('quote', body)
    const cookie = hostCookies(quote)[0] ?? ''
    const cacheControl = String(quote.headers['cache-control'] || '')
    check('quote: 200 with ONE session cookie, named __Host-mw_sid (never the weaker mw_sid) - although the server runs with COOKIE_SECURE=false', quote.status === 200 && hostCookies(quote).length === 1 && sessionCookies(quote).length === 1, [quote.status, cookie])
    check('the cookie is HttpOnly, SameSite=Lax, Secure, Path=/, 30 days and has no Domain (everything the __Host- prefix demands)', /HttpOnly/i.test(cookie) && /SameSite=lax/i.test(cookie) && /;\s*Secure/i.test(cookie) && /Path=\//.test(cookie) && /Max-Age=2592000/.test(cookie) && !/Domain=/i.test(cookie), cookie)
    check('the answer is never cached (no-store, private, Vary: Cookie, Pragma)', /no-store/.test(cacheControl) && /private/.test(cacheControl) && /cookie/i.test(String(quote.headers.vary || '')) && quote.headers.pragma === 'no-cache')
    const total = quote.json.totalCents as number
    const before = await counts()
    const noSession = await post('session', payBody(strongTestKey('raw-key-aaaaaaaaaaaaaaaaaaaa'), total))
    check('pay without a session: 428 SESSION_REQUIRED, a __Host- cookie handed out, nothing else in the answer', noSession.status === 428 && noSession.json.code === 'SESSION_REQUIRED' && hostCookies(noSession).length === 1 && sessionCookies(noSession).length === 1 && Object.keys(noSession.json).sort().join() === 'code,error,retry', [noSession.status, noSession.json])
    const forged = await post('session', payBody(strongTestKey('raw-key-bbbbbbbbbbbbbbbbbbbb'), total), { cookie: `${GUEST_SESSION_COOKIE_HOST}=${valueOf(cookie).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}` })
    check('pay with a forged __Host- cookie: 428 as well', forged.status === 428, forged.status)
    // a perfectly valid, signed session - under the WEAK name: what a site that is not ours (a sibling subdomain, a plain-http network) could have planted
    const attacker = mintGuestSession()
    const planted = await post('session', payBody(strongTestKey('raw-key-planted'), total), { cookie: `${GUEST_SESSION_COOKIE}=${attacker.value}` })
    check('pay with a VALID session under the weaker name mw_sid (planted): 428 and a __Host- cookie handed out - it is not taken for a session', planted.status === 428 && planted.json.code === 'SESSION_REQUIRED' && hostCookies(planted).length === 1, [planted.status, planted.json])
    const after = await counts()
    check('and none of these made an order, an attempt, or a payment page at Stripe', JSON.stringify(before) === JSON.stringify(after), [before, after])
    const valid = await post('session', payBody(strongTestKey('raw-key-cccccccccccccccccccc'), total), { cookie: pair(cookie) })
    check('pay with the cookie it was handed: 200 and an order tied to that session', valid.status === 200 && (await prisma.printOrder.count()) === before.orders + 1, valid.status)
    const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    const session = verifyGuestSession(valueOf(cookie))
    check('the order stores the HASH of the session (never the session itself)', !!session && order.guestSessionHash === session.hash && !JSON.stringify(order).includes(session.sid))
    // both names at once: the __Host- one is the session, the weaker one is ignored whatever it holds
    const second = hostCookies(await post('quote', body))[0] ?? ''
    const both = await post('session', payBody(strongTestKey('raw-key-dddddddddddddddddddd'), total), { cookie: `${GUEST_SESSION_COOKIE}=${attacker.value}; ${pair(second)}` })
    const secondOrder = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    check('with BOTH names present the __Host- session is the one used, and the planted session\'s hash is on no order', both.status === 200 && secondOrder.guestSessionHash === verifyGuestSession(valueOf(second))?.hash && (await prisma.printOrder.count({ where: { guestSessionHash: attacker.session.hash } })) === 0, both.status)
    const status = await fetch(`${BASE}/api/checkout/status?order=${order.id}`, { headers: { cookie: pair(cookie), 'x-forwarded-for': '203.0.113.6' } })
    check('the session alone opens no order status (404)', status.status === 404, status.status)

    // ---- production: nothing a request writes lowers the cookie, and a connection that is plain http does not check out -------------------------------
    console.log('  -- headers a client can write do not lower the cookie to the weaker name')
    const notLowered: Array<[string, Record<string, string | undefined>]> = [
      ['a forged "http" in front of the proxy\'s own https ("http, https")', { 'x-forwarded-proto': 'http, https' }],
      ['a word nobody understands in X-Forwarded-Proto', { 'x-forwarded-proto': 'nonsense' }],
      ['Forwarded: proto=https', { forwarded: 'for=203.0.113.5;proto=https' }],
    ]
    for (const [label, headers] of notLowered) {
      const answer = await post('quote', body, headers)
      const issued = hostCookies(answer)[0] ?? ''
      check(`${label}: still ONE __Host-mw_sid cookie, Secure, and no mw_sid`, answer.status === 200 && hostCookies(answer).length === 1 && sessionCookies(answer).length === 1 && /;\s*Secure/i.test(issued) && !/Domain=/i.test(issued), [answer.status, answer.setCookies])
    }

    console.log('  -- the proxy says the customer came over PLAIN http (or contradicts itself): the guest does not check out')
    const refused: Array<[string, Record<string, string | undefined>]> = [
      ['X-Forwarded-Proto: http', { 'x-forwarded-proto': 'http', origin: BASE }],
      ['"https, http": a forged https in front, the proxy\'s own word last', { 'x-forwarded-proto': 'https, http' }],
      ['Forwarded: proto=http against X-Forwarded-Proto: https (a conflict)', { forwarded: 'for=203.0.113.5;proto=http' }],
      ['no X-Forwarded-Proto at all (a call straight at the server: Next fills in "http")', { 'x-forwarded-proto': undefined, origin: BASE }],
    ]
    let index = 0
    for (const [label, headers] of refused) {
      index++
      const answer = await post('quote', body, headers)
      check(`${label}: the quote still shows the price (200) but hands out NO cookie`, answer.status === 200 && typeof answer.json.totalCents === 'number' && answer.setCookies.length === 0, [answer.status, answer.setCookies])
      const c0 = await counts()
      const pay = await post('session', payBody(strongTestKey(`raw-key-refused-${index}`), total), { ...headers, cookie: pair(cookie) })
      check(`${label}: pay is 503 CHECKOUT_UNAVAILABLE even with a valid __Host- session, with no cookie and nothing made`, pay.status === 503 && pay.json.code === 'CHECKOUT_UNAVAILABLE' && pay.setCookies.length === 0 && JSON.stringify(await counts()) === JSON.stringify(c0), [pay.status, pay.json, pay.setCookies])
    }

    console.log('  -- through the real TLS proxy (the way production is reached) what a client writes in these two headers is overwritten')
    const viaProxy = await wire(PUBLIC, 'quote', body, { origin: PUBLIC, 'x-forwarded-for': '203.0.113.8', 'x-forwarded-proto': 'http', forwarded: 'for=203.0.113.8;proto=http' })
    const proxied = hostCookies(viaProxy)[0] ?? ''
    check('a client\'s own "X-Forwarded-Proto: http" and "Forwarded: proto=http" never reach the server: 200, ONE __Host-mw_sid cookie, Secure', viaProxy.status === 200 && hostCookies(viaProxy).length === 1 && sessionCookies(viaProxy).length === 1 && /;\s*Secure/i.test(proxied), [viaProxy.status, viaProxy.setCookies])
    const proxiedPay = await wire(PUBLIC, 'session', payBody(strongTestKey('raw-key-proxy'), total), { origin: PUBLIC, 'x-forwarded-for': '203.0.113.8', 'x-forwarded-proto': 'http', cookie: pair(proxied) })
    check('and the payment page opens through it with that session: 200, an order tied to it', proxiedPay.status === 200 && (await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).guestSessionHash === verifyGuestSession(valueOf(proxied))?.hash, proxiedPay.status)
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
        check('Chromium kept a __Host-mw_sid cookie: Secure, HttpOnly, SameSite=Lax, Path=/, host-only, about 30 days - and there is no mw_sid next to it', !!sid && sid.secure === true && sid.httpOnly && sid.sameSite === 'Lax' && sid.path === '/' && !String(sid.domain).startsWith('.') && Math.abs(sid.expires - (Date.now() / 1000 + 2592000)) < 300 && (await weakSidCookie(context)) === null, sid)
        check('the page\'s own scripts can not read it', !(await page.evaluate(() => document.cookie)).includes('mw_sid'))
        // a script of the page tries to put a session of its own in its place (the cookie is HttpOnly: the browser leaves it alone)
        await page.evaluate((name: string) => { document.cookie = `${name}=v1.AAAAAAAAAAAAAAAAAAAAAA.1700000000.${'A'.repeat(43)}; Secure; Path=/` }, GUEST_SESSION_COOKIE_HOST)
        check('and can not replace it either', (await sidCookie(context))?.value === sid?.value, [sid?.value, (await sidCookie(context))?.value])
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
      console.log('[5] two DIFFERENT browsers with the very same checkout key and the same cart (R1-1b): ONE order, ONE payment page - the other browser is refused, with a support code and nothing of the first')
      {
        // both generate the same key: the 24 random bytes of the key are made the SAME in both browsers - a fixed sequence with plenty of different characters (R1-1a: a
        // constant such as fill(7) is refused by the client as a degenerate key, lib/checkout-key-format.ts, and then nothing is sent at all)
        // (a different sequence for every screen size: a key stays bound to the order it made, so the next round must not meet the key of the last)
        sameKeyRound += 1
        const sameKey = `const original = crypto.getRandomValues.bind(crypto); crypto.getRandomValues = (array) => { if (array instanceof Uint8Array && array.length === 24) { for (let i = 0; i < 24; i++) array[i] = (i * 37 + 11 + ${sameKeyRound * 53}) & 255; return array } return original(array) }`
        const alice = await newContext(browser, device, sameKey)
        const bob = await newContext(browser, device, sameKey)
        const pageA = await alice.newPage()
        const pageB = await bob.newPage()
        const ordersBefore = await prisma.printOrder.count()
        const stripeBefore = stripeSessionsCreated()
        await openCheckout(pageA, data)
        await openCheckout(pageB, data)
        await Promise.all([pageA.getByTestId('pay-button').click(), pageB.getByTestId('pay-button').click()])
        // exactly one of the two is sent to the payment page; the other stays where it is and is told why
        const outcome = async (page: any) => {
          const stripe = page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 }).then(() => 'stripe' as const)
          const refused = page.getByTestId('checkout-error').waitFor({ timeout: 20000 }).then(() => 'refused' as const)
          const first = await Promise.race([stripe, refused])
          stripe.catch(() => undefined); refused.catch(() => undefined)
          return first
        }
        const [outcomeA, outcomeB] = await Promise.all([outcome(pageA), outcome(pageB)])
        check('the two browsers really sent the same key, and one of them is sent to the payment page while the other is refused', [outcomeA, outcomeB].sort().join() === 'refused,stripe', [outcomeA, outcomeB])
        const [winnerContext, refusedContext, refusedPage] = outcomeA === 'stripe' ? [alice, bob, pageB] : [bob, alice, pageA]
        const sidWinner = verifyGuestSession((await sidCookie(winnerContext))?.value)
        const text = await refusedPage.getByTestId('checkout-error').innerText()
        check('the refused browser is told in plain words, with a support code, that nothing new was started - and nothing about the other, nor about what became of the purchase (S-01)', /risulta già collegata a un acquisto/.test(text) && /[0-9A-F]{5}-[0-9A-F]{5}/.test(text) && /non ha avviato nessun nuovo pagamento/.test(text) && !/cl[a-z0-9]{20,}|MW-\d|stripe/i.test(text) && !/pagat|andato a buon fine|in conferma|in verifica|conclus|annullat|scadut|fallit|non serve pagare di nuovo/i.test(text), text)
        check('ONE order and ONE payment page at Stripe, tied to the session of the browser that was served', (await prisma.printOrder.count()) === ordersBefore + 1 && stripeSessionsCreated() === stripeBefore + 1 && !!sidWinner && (await prisma.printOrder.count({ where: { guestSessionHash: sidWinner.hash } })) === 1)
        check('the refused browser has no order and no access cookie, keeps its cart, and its pay button is back', (await refusedContext.cookies()).every((c: any) => c.name !== 'mw_checkout') && (await storedCart(refusedPage)) === 1 && (await refusedPage.getByTestId('pay-button').isEnabled()))
        check('and the page still fits the screen', (await overflow(refusedPage)) <= 0)
        await alice.close(); await bob.close()
      }

      // 7. a session planted before the quote
      console.log('[7] a mw_sid PLANTED in the browser before the quote (a sibling site, a plain-http network) is never adopted: the order carries the hash of the session the server handed out')
      {
        const attacker = mintGuestSession()
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const posts = sessionPosts(page)
        const ordersBefore = await prisma.printOrder.count()
        // a perfectly valid, signed value under the WEAK name, in the jar before the first request to the checkout
        await context.addCookies([{ name: GUEST_SESSION_COOKIE, value: attacker.value, url: PUBLIC }])
        await openCheckout(page, data)
        const sid = await sidCookie(context)
        const planted = await weakSidCookie(context)
        check('the server handed out a __Host- session of its own next to the planted cookie, and left the planted one alone (ignored, not deleted)', !!sid && !!planted && planted.value === attacker.value && verifyGuestSession(sid.value)?.hash !== attacker.session.hash, [sid?.value, planted?.value])
        await page.getByTestId('pay-button').click()
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
        const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
        check('one order, one request to /api/checkout/session (the planted cookie started no 428 round), tied to the __Host- session', (await prisma.printOrder.count()) === ordersBefore + 1 && posts.length === 1 && order.guestSessionHash === verifyGuestSession(sid?.value)?.hash, [posts.length])
        check('no order carries the planted session\'s hash', (await prisma.printOrder.count({ where: { guestSessionHash: attacker.session.hash } })) === 0)
        await context.close()
      }

      // 8. the browser comes without the proxy
      console.log('[8] the browser reaches the production server over PLAIN http (no TLS proxy): the price shows, "pay" is refused with a clear message, nothing is made, no cookie is kept')
      {
        const context = await newContext(browser, device, undefined, BASE)
        const page = await context.newPage()
        const posts = sessionPosts(page)
        const before = await counts()
        await openCheckout(page, data)
        check('the quote still works - the total is on the page - and no session cookie was handed out', (await page.getByTestId('checkout-total').innerText()).trim().length > 0 && (await sidCookie(context)) === null && (await weakSidCookie(context)) === null)
        await page.getByTestId('pay-button').click()
        const error = page.getByTestId('checkout-error')
        await error.waitFor({ timeout: 20000 })
        const text = await error.innerText()
        check('the page says online payment is not available now, without any detail', /non è disponibile/i.test(text) && !/https?|proxy|header|cookie/i.test(text), text)
        await sleep(800)
        check('one request to /api/checkout/session, refused; no order, no attempt, no payment page at Stripe; still no cookie', posts.length === 1 && JSON.stringify(await counts()) === JSON.stringify(before) && (await context.cookies()).length === 0, [posts.length, await context.cookies()])
        check('the cart is untouched and the page fits the screen', (await storedCart(page)) === 1 && (await overflow(page)) <= 0)
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
