// REAL-SERVER CHECK (not part of `npm test`), steps 4.3 and 4.4: the way back from the payment page, in a real browser, against `next start` in production mode, the REAL
// Stripe SDK in front of tests/real-run/fake-stripe-http-preload.js (no network), the throw-away test database, fake data. Desktop and phone-sized Chromium.
//
//   npm run build          (NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR)
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium node --import tsx tests/real-run/checkout-return.ts
//
// For each case: the customer fills the cart, opens /checkout, presses "Paga" (the redirect to Stripe is answered by the test), then "pays" in the fake Stripe
// (or not) and comes back to /checkout/success. What must hold: the page shows what the SERVER says (paid only when Stripe says so, also with the webhook late
// or never sent), the cart is emptied only for the order this browser sent to the payment page, polling is small and stops, nobody else can read the order,
// and the customer area describes the orders correctly. Exit code 1 when something is not as expected.
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { db, resetDb } from '../security/_harness'
import { SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels } from '../security/_checkout-scenarios'

const req = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium, devices } = req('playwright-core')
const jwt = req('jsonwebtoken')
const Stripe = req('stripe')

const PORT = Number(process.env.PORT || 3096)
const BASE = `http://127.0.0.1:${PORT}`
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-return-'))
const STATE = path.join(WORK, 'state.json')
const LOG = path.join(WORK, 'stripe.log')
const FORMS = path.join(WORK, 'forms.log')
const PRELOAD = path.join(process.cwd(), 'tests/real-run/fake-stripe-http-preload.js')
const WEBHOOK_SECRET = 'whsec_FAKE_return'
const VIEWPORTS: Array<[string, Record<string, unknown>]> = [['desktop 1280x800', { viewport: { width: 1280, height: 800 } }], ['phone 393x851', devices['Pixel 5']]]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ` ${JSON.stringify(extra).slice(0, 300)}` : ''}`) }
}

let server: ChildProcess | null = null
async function startServer() {
  fs.writeFileSync(LOG, ''); fs.writeFileSync(FORMS, ''); try { fs.rmSync(STATE) } catch { /* none yet */ }
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), BASE_URL: 'https://shop.example.test', HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1', TAX_MODE: 'none',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700',
      CHECKOUT_QUOTE_RATE_MAX: '100000', CHECKOUT_SESSION_RATE_MAX: '100000', CHECKOUT_GLOBAL_RATE_MAX: '100000', CHECKOUT_STATUS_RATE_MAX: '100000', CHECKOUT_STATUS_GLOBAL_RATE_MAX: '100000',
      FAKE_STRIPE_STATE: STATE, FAKE_STRIPE_LOG: LOG, FAKE_STRIPE_FORMS: FORMS, NODE_OPTIONS: `--require ${PRELOAD}`,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/robots.txt`)).ok) return } catch { /* not up yet */ } await sleep(500) }
  throw new Error('the server did not start')
}
async function stopServer() { if (server) { server.kill('SIGTERM'); await sleep(800); server = null } }

// ---- the fake Stripe, from outside --------------------------------------------------------------------------------------------------------
const loadState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'))
const saveState = (state: unknown) => fs.writeFileSync(STATE, JSON.stringify(state))
let piSeq = 0
function pay(sessionId: string) {
  const s = loadState(); const sess = s.sessions[sessionId]; const id = `pi_test_RETURN_${++piSeq}_${Date.now()}`; const amount = sess.amount_total
  s.intents[id] = { id, object: 'payment_intent', status: 'succeeded', amount, amount_received: amount, currency: sess.currency, metadata: { ...sess._piMetadata }, customer: null,
    latest_charge: { id: `ch_test_${id}`, object: 'charge', receipt_url: `https://pay.stripe.test/r/${id}`, amount_refunded: 0, refunded: false, disputed: false, status: 'succeeded' } }
  sess.payment_intent = id; sess.status = 'complete'; sess.payment_status = 'paid'
  sess.customer_details = { email: 'cliente@example.test', name: 'Cliente Prova' }
  sess.collected_information = { shipping_details: { name: 'Cliente Prova', address: { line1: 'Via Roma 1', city: 'Torino', postal_code: '10100', country: 'IT' } } }
  saveState(s)
}
function expire(sessionId: string) { const s = loadState(); s.sessions[sessionId].status = 'expired'; saveState(s) }
function faults(list: unknown[]) { const s = loadState(); s.faults = list; saveState(s) }
const sdk = new Stripe('sk_test_FAKE_driver')
async function webhook(type: string, object: unknown) {
  const payload = JSON.stringify({ id: `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', livemode: false, type, data: { object } })
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  return (await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload })).status
}

// ---- the browser ----------------------------------------------------------------------------------------------------------------------------
async function newContext(browser: any, device: Record<string, unknown>, token?: string) {
  const context = await browser.newContext({ ...device, baseURL: BASE })
  await context.route('https://checkout.stripe.com/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  if (token) await context.addCookies([{ name: 'mwv2_token', value: token, url: BASE }])
  return context
}
const cartKey = 'mwv2:cart'
const storedCart = (page: any) => page.evaluate((key: string) => JSON.parse(localStorage.getItem(key) || '[]').length, cartKey)

// fills the cart, opens the checkout and presses "Paga": the order exists and the browser has "gone to Stripe"
// `cart`: which of the matrix carts (a signed-in customer pressing "Paga" twice for the SAME cart gets the same order, by design: S3)
async function sendToPaymentPage(page: any, data: any, cartIndex = 0) {
  await page.goto('/robots.txt')
  const cart = SCENARIOS[cartIndex].items.map((spec, i) => persistedCartItem(spec, data, i))
  await page.evaluate(([items, key]: [unknown, string]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(items)) }, [cart, cartKey])
  const prisma = await db()
  const before = await prisma.printOrder.count()
  await page.goto('/checkout')
  await page.getByTestId('checkout-total').waitFor({ timeout: 20000 })
  await page.getByTestId('pay-button').click()
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
  const order = await prisma.printOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' }, include: { paymentAttempts: true } })
  const after = await prisma.printOrder.count()
  if (after !== before + 1) throw new Error(`pressing "Paga" did not create exactly one order (before ${before}, after ${after}, newest ${order.id} ${order.status})`)
  return { orderId: order.id, sessionId: order.paymentAttempts[0].stripeSessionId as string, totalCents: order.totalCents, orderNumber: order.orderNumber }
}

async function main() {
  await resetDb()
  await seedScenarioConfig()
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 0 } as any })
  const data = await seedScenarioModels('return')
  const customer = await prisma.user.create({ data: { email: 'return-customer@sectest.invalid', passwordHash: 'x', name: 'Cliente', role: 'customer' } })
  const customerToken = jwt.sign({ sub: customer.id }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '1d' })
  await startServer()
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
  try {
    for (const [label, device] of VIEWPORTS) {
      console.log(`\n=== ${label}`)
      const guestFlow = async (name: string, afterPayment: (ctx: any) => Promise<void>) => {
        await prisma.rateLimit.deleteMany()
        const context = await newContext(browser, device)
        const page = await context.newPage()
        const asked: string[] = []
        page.on('request', (r: any) => { if (new URL(r.url()).pathname === '/api/checkout/status') asked.push(r.url()) })
        const order = await sendToPaymentPage(page, data)
        await afterPayment({ order })
        return { context, page, order, asked, name }
      }

      // 1. paid, webhook never sent: the page asks the server, the server asks Stripe
      console.log('[1] paid at Stripe, the webhook is late: the return page shows "paid"; a late webhook changes nothing')
      {
        const g = await guestFlow('late webhook', async ({ order }) => { pay(order.sessionId) })
        await g.page.goto(`/checkout/success?order=${g.order.orderId}`)
        await g.page.getByTestId('status-paid').waitFor({ timeout: 20000 })
        check('shows "paid", the order number and the total', (await g.page.getByTestId('status-order-number').textContent())?.includes(String(g.order.orderNumber).padStart(5, '0')) === true
          && (await g.page.getByTestId('status-total').textContent())!.replace(/\D/g, '').includes(String(g.order.totalCents)))
        let o = await prisma.printOrder.findUniqueOrThrow({ where: { id: g.order.orderId } })
        check('the order is paid and released once, with no webhook', o.paymentStatus === 'paid' && o.status === 'queued' && !!o.paidAt)
        await g.page.waitForFunction((key: string) => JSON.parse(localStorage.getItem(key) || '[]').length === 0, cartKey, { timeout: 10000 }).catch(() => undefined)
        check('the cart was emptied (the server verified the payment of THIS cart) and the memory of the order is gone', (await storedCart(g.page)) === 0 && (await g.page.evaluate(() => localStorage.getItem('mw:pending-orders:v2'))) === null)
        const html = await g.page.content()
        check('the page holds no payment identifier, e-mail or address', !/cs_test_|pi_test_|cliente@example|Via Roma|Cliente Prova/.test(html))
        const paidAt = o.paidAt!.getTime()
        const status = await webhook('checkout.session.completed', { id: g.order.sessionId, object: 'checkout.session', metadata: loadState().sessions[g.order.sessionId]._piMetadata })
        o = await prisma.printOrder.findUniqueOrThrow({ where: { id: g.order.orderId } })
        check('the late webhook is accepted and changes nothing', status === 200 && o.paidAt!.getTime() === paidAt && o.status === 'queued')
        const askedBefore = g.asked.length
        await sleep(6000)
        check('a final answer is asked about once (no polling afterwards)', askedBefore === 1 && g.asked.length === 1, g.asked.length)
        check('the question carried "I am back" and nothing else', g.asked[0].endsWith(`?order=${g.order.orderId}&return=1`), g.asked[0])
        // reload: still paid, cart still empty
        await g.page.reload()
        await g.page.getByTestId('status-paid').waitFor({ timeout: 20000 })
        check('a reload shows "paid" again and does not touch the cart', (await storedCart(g.page)) === 0)
        // another browser: the same address shows nothing
        const stranger = await newContext(browser, device)
        const strangerPage = await stranger.newPage()
        await strangerPage.goto(`/checkout/success?order=${g.order.orderId}`)
        await strangerPage.getByTestId('status-unknown').waitFor({ timeout: 20000 })
        const text = (await strangerPage.locator('body').innerText())
        check('another browser gets the neutral message: no number, no amount, no "paid"', !/MW-\d|€|Pagamento ricevuto/.test(text) && /Non possiamo mostrare questo ordine da qui/.test(text))
        check('and has no overflow', (await strangerPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0)
        await stranger.close()
        await g.context.close()
      }

      // 2. Stripe cannot be reached when the customer comes back
      console.log('[2] Stripe unreachable at the return: "confirming", never an error, never "paid"; the page asks again and shows "paid" when it can')
      {
        const g = await guestFlow('stripe down', async ({ order }) => { pay(order.sessionId); faults([{ match: '/v1/checkout/sessions/cs_', method: 'GET', status: 503, remaining: 1000 }]) })
        await g.page.goto(`/checkout/success?order=${g.order.orderId}`)
        await g.page.getByTestId('status-confirming').waitFor({ timeout: 20000 })
        let o = await prisma.printOrder.findUniqueOrThrow({ where: { id: g.order.orderId } })
        check('"confirming" is shown, the database still says not paid', o.paymentStatus !== 'paid' && o.status === 'awaiting_payment')
        check('the page does not say "paid" or show an error', (await g.page.getByText('Pagamento ricevuto').count()) === 0 && (await g.page.getByTestId('status-error').count()) === 0)
        check('the cart STAYS while the payment is only being confirmed, and the page says so', (await storedCart(g.page)) === 1 && (await g.page.getByTestId('status-cart-kept').count()) === 1)
        faults([]); await prisma.rateLimit.deleteMany({ where: { key: { startsWith: 'checkout:status-sync' } } })
        await g.page.getByTestId('status-paid').waitFor({ timeout: 40000 })
        o = await prisma.printOrder.findUniqueOrThrow({ where: { id: g.order.orderId } })
        check('Stripe back: the page moves to "paid" by itself and the order is paid once', o.paymentStatus === 'paid' && o.status === 'queued')
        await g.page.waitForFunction((key: string) => JSON.parse(localStorage.getItem(key) || '[]').length === 0, cartKey, { timeout: 10000 }).catch(() => undefined)
        check('and only now, with the payment verified, the cart is emptied', (await storedCart(g.page)) === 0)
        const total = g.asked.length
        check('it needed only a handful of questions', total >= 2 && total <= 8, total)
        await sleep(8000)
        check('and stopped asking once it was paid', g.asked.length === total, [total, g.asked.length])
        await g.context.close()
      }

      // 3. the payment page expired
      console.log('[3] the payment page expired: "closed", nothing charged, the cart stays')
      {
        const g = await guestFlow('expired', async ({ order }) => { expire(order.sessionId) })
        await g.page.goto(`/checkout/success?order=${g.order.orderId}`)
        await g.page.getByTestId('status-canceled').waitFor({ timeout: 20000 })
        const o = await prisma.printOrder.findUniqueOrThrow({ where: { id: g.order.orderId } })
        check('the order is closed without a payment', o.status === 'cancelled' && o.paymentStatus !== 'paid' && !o.paidAt)
        check('the cart is untouched', (await storedCart(g.page)) === 1)
        check('"back to the cart" is offered', (await g.page.getByRole('link', { name: 'Torna al carrello' }).count()) === 1)
        await g.context.close()
      }

      // 4. an address opened by hand, with a new cart in the browser
      console.log('[4] an old order\'s address opened while a new cart is waiting: the cart is not touched')
      {
        const g = await guestFlow('old order', async ({ order }) => { pay(order.sessionId) })
        await g.page.goto(`/checkout/success?order=${g.order.orderId}`)
        await g.page.getByTestId('status-paid').waitFor({ timeout: 20000 })
        const cart = [persistedCartItem(SCENARIOS[0].items[0], data, 0)]
        await g.page.evaluate(([items, key]: [unknown, string]) => localStorage.setItem(key, JSON.stringify(items)), [cart, cartKey])
        await g.page.goto(`/checkout/success?order=${g.order.orderId}`)
        await g.page.getByTestId('status-paid').waitFor({ timeout: 20000 })
        await sleep(500)
        check('the new cart is still there', (await storedCart(g.page)) === 1)
        await g.context.close()
      }

      // 6. paid, but the customer never saw the return page (the tab was closed on Stripe's page): the cart is still there until the server says so
      console.log('[6] paid, the return page was never seen (tab closed): the next visit to the cart finds the payment and empties the cart')
      {
        const g = await guestFlow('closed tab', async ({ order }) => { pay(order.sessionId) })
        const tab = await g.context.newPage()
        await tab.goto('/cart')
        await tab.getByTestId('pending-payment-paid').waitFor({ timeout: 30000 })
        const o = await prisma.printOrder.findUniqueOrThrow({ where: { id: g.order.orderId } })
        check('the cart page asked the server (which asked Stripe): the order is paid and released once', o.paymentStatus === 'paid' && o.status === 'queued')
        check('the cart is emptied and the memory of the order forgotten', (await storedCart(tab)) === 0 && (await tab.evaluate(() => localStorage.getItem('mw:pending-orders:v2'))) === null)
        check('the confirmation stays on the page, with the way to the order', (await tab.getByRole('link', { name: 'Check the order status' }).count()) === 1)
        await g.context.close()
      }

      // 7. the same cart again while the first payment is being confirmed: the SERVER refuses, whatever the tab and the key
      console.log('[7] the same cart paid again while the first payment is being confirmed (the memory lost): the server refuses and names the order')
      {
        const g = await guestFlow('in flight', async ({ order }) => { await prisma.printOrder.update({ where: { id: order.orderId }, data: { paymentStatus: 'processing' } }) })
        const orders = await prisma.printOrder.count()
        const tab = await g.context.newPage()
        await tab.goto('/checkout')
        await tab.getByTestId('pending-payment-confirming').waitFor({ timeout: 30000 })
        check('the checkout knows from the server: a notice, and "pay" is off', await tab.getByTestId('pay-button').isDisabled())
        // the browser forgets (storage cleared): the notice is gone and "pay" looks possible - the server still says no
        await tab.evaluate(() => { localStorage.removeItem('mw:pending-orders:v2'); localStorage.removeItem('mw:checkout-key:v1') })
        await tab.reload()
        await tab.getByTestId('pay-button').waitFor({ timeout: 20000 })
        await sleep(600)
        check('with the memory gone the page offers to pay', !(await tab.getByTestId('pay-button').isDisabled()))
        await tab.getByTestId('pay-button').click()
        await tab.getByTestId('checkout-error').waitFor({ timeout: 20000 })
        check('the server refuses with a sentence and a link to the order', /c.è già un pagamento in conferma/.test(await tab.getByTestId('checkout-error').innerText())
          && (await tab.getByTestId('checkout-error').getByRole('link', { name: "Controlla lo stato dell'ordine" }).getAttribute('href')) === `/checkout/success?order=${g.order.orderId}`)
        check('no second order, no second payment page', (await prisma.printOrder.count()) === orders && !/checkout\.stripe\.com/.test(tab.url()))
        await tab.getByTestId('pending-payment-confirming').waitFor({ timeout: 30000 })
        check('and the page remembers the order again: the notice is back and "pay" is off', await tab.getByTestId('pay-button').isDisabled())
        await g.context.close()
      }

      // 8. guest cookie absent (cleared, or another browser): nothing can be shown or guessed
      console.log('[8] guest cookie lost: the order can not be seen from here - no notice, nothing guessed, the cart stays (a new payment would make a new order: the limit)')
      {
        const g = await guestFlow('cookie lost', async ({ order }) => { await prisma.printOrder.update({ where: { id: order.orderId }, data: { paymentStatus: 'processing' } }) })
        await g.context.clearCookies()
        const orders = await prisma.printOrder.count()
        const tab = await g.context.newPage()
        await tab.goto('/checkout')
        await tab.getByTestId('pay-button').waitFor({ timeout: 20000 })
        await sleep(1500)
        check('no notice about an order the browser may not see, and "pay" is offered', (await tab.locator('[data-testid^="pending-payment-"]').count()) === 0 && !(await tab.getByTestId('pay-button').isDisabled()))
        check('the memory of the order is dropped (it can never be checked from here); the cart is untouched', (await tab.evaluate(() => localStorage.getItem('mw:pending-orders:v2'))) === null && (await storedCart(tab)) === 1)
        const strangerView = await newContext(browser, device)
        const sp = await strangerView.newPage()
        await sp.goto(`/checkout/success?order=${g.order.orderId}`)
        await sp.getByTestId('status-unknown').waitFor({ timeout: 20000 })
        check('and the order\'s own page says the same neutral thing', !/MW-\d|€/.test(await sp.locator('body').innerText()))
        await strangerView.close()
        check('(nothing was created by looking)', (await prisma.printOrder.count()) === orders)
        await g.context.close()
      }

      // 9. the back button
      console.log('[9] the back button from the payment page: the cart is there; after paying and going back, the page shows the payment, not "not completed"')
      {
        const g = await guestFlow('back', async () => undefined)
        await g.page.goBack()
        await g.page.waitForURL(/\/checkout/, { timeout: 20000 })
        await g.page.getByTestId('pay-button').waitFor({ timeout: 20000 })
        await g.page.waitForFunction(() => { const b = document.querySelector('[data-testid=pay-button]') as HTMLButtonElement | null; return !!b && !b.disabled }, undefined, { timeout: 20000 }).catch(() => undefined)
        check('back without paying: the cart is there and "pay" works', (await storedCart(g.page)) === 1 && !(await g.page.getByTestId('pay-button').isDisabled()))
        await g.page.getByTestId('pay-button').click() // the same key: the same order, the same payment page
        await g.page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
        check('pressing "pay" again leads to the SAME order (no second order)', (await prisma.printOrder.count({ where: { id: g.order.orderId } })) === 1
          && (await prisma.printOrder.count({ where: { createdAt: { gt: new Date(Date.now() - 60_000) }, userId: null } })) >= 1)
        pay(g.order.sessionId)
        // the pace limit of the status endpoint (Stripe is asked at most every 4 s per order) would only slow the test down: let the next question ask again
        await prisma.rateLimit.deleteMany({ where: { key: { startsWith: 'checkout:status-sync' } } })
        await prisma.printOrder.update({ where: { id: g.order.orderId }, data: { paymentSyncedAt: null } })
        await g.page.goBack()
        await g.page.waitForURL(/\/checkout/, { timeout: 20000 })
        await g.page.getByTestId('pending-payment-paid').waitFor({ timeout: 30000 })
        check('back after paying: "payment confirmed", no "not completed", the cart is emptied', (await g.page.getByText('Il pagamento non è stato completato').count()) === 0 && (await storedCart(g.page)) === 0)
        await g.context.close()
      }

      // 5. a signed-in customer: the return page, then the customer area
      console.log('[10] a registered customer: the return page links to the orders; the list and the page describe the orders by their payment')
      {
        await prisma.rateLimit.deleteMany()
        await prisma.printOrder.deleteMany({ where: { userId: customer.id } }) // the earlier screen size's orders: the same cart twice would give the same order
        const context = await newContext(browser, device, customerToken)
        const page = await context.newPage()
        const paid = await sendToPaymentPage(page, data)
        pay(paid.sessionId)
        await page.goto(`/checkout/success?order=${paid.orderId}`)
        await page.getByTestId('status-paid').waitFor({ timeout: 20000 })
        check('"my orders" is offered, and the guest note is not', (await page.getByRole('link', { name: 'I miei ordini' }).count()) === 1 && (await page.getByText(/Conserva il numero d'ordine\. Da questo browser/).count()) === 0)
        const unpaid = await sendToPaymentPage(page, data, 1) // pressed "Paga", never paid
        const expiredOne = await sendToPaymentPage(page, data, 6)
        expire(expiredOne.sessionId)
        await page.goto(`/checkout/success?order=${expiredOne.orderId}`) // the page asks, the server closes it
        await page.getByTestId('status-canceled').waitFor({ timeout: 20000 })
        await page.goto('/customer/orders')
        const list = page.getByTestId('orders-list')
        await list.waitFor({ timeout: 20000 })
        const kindOf = async (n: number) => list.locator('[data-testid=order-card]', { hasText: `MW-${String(n).padStart(5, '0')}` }).getAttribute('data-kind')
        check('the paid order is in the list as a normal order', (await kindOf(paid.orderNumber)) === 'production')
        check('the unpaid order says "Awaiting payment", not "Queued"', (await kindOf(unpaid.orderNumber)) === 'awaiting_payment' && !/queued/i.test(await list.locator('[data-testid=order-card]', { hasText: `MW-${String(unpaid.orderNumber).padStart(5, '0')}` }).innerText()))
        check('the order whose payment page expired is not in the list but in the history', (await list.locator('[data-testid=order-card]', { hasText: `MW-${String(expiredOne.orderNumber).padStart(5, '0')}` }).count()) === 0
          && (await page.getByTestId('orders-history').locator('[data-testid=order-card]', { hasText: `MW-${String(expiredOne.orderNumber).padStart(5, '0')}` }).count()) === 1)
        check('the list does not scroll sideways', (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0)
        await page.goto(`/customer/orders/${unpaid.orderId}`)
        await page.getByTestId('order-payment-notice').waitFor({ timeout: 20000 })
        check('the unpaid order\'s page has no receipt and no production block', (await page.getByRole('link', { name: /Download receipt/i }).count()) === 0 && (await page.getByRole('heading', { name: 'Production' }).count()) === 0)
        await page.goto(`/customer/orders/${paid.orderId}`)
        await page.getByRole('heading', { name: 'Production' }).waitFor({ timeout: 20000 })
        check('the paid order\'s page has its receipt', (await page.getByRole('link', { name: /Download receipt/i }).count()) === 1)
        await context.close()
      }
    }
  } finally {
    await stopServer()
    await browser.close()
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(async (err) => { console.error(err); await stopServer(); process.exit(2) })
