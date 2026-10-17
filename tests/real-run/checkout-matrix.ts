// REAL-SERVER CHECK (not part of `npm test`): what the cart page shows, what the server quotes, what the order stores and what the Stripe SDK was
// asked to charge, for the carts of tests/security/_checkout-scenarios.ts, on a desktop and on a phone-sized browser, through the real pages:
//   /cart (the cart's own estimate)  ->  "Checkout" link  ->  /checkout (the server's quote)  ->  "Paga con carta"  ->  redirect to Stripe's page.
// It starts `next start` itself (production mode, one server per tax/shipping setting, the REAL Stripe SDK in front of the fake
// tests/real-run/fake-stripe-http-preload.js, no network) and uses the throw-away test database. Fake data only.
//
//   npm run build          (build with NEXT_PUBLIC_CURRENCY=EUR CURRENCY=EUR: the client bundle reads the currency AT BUILD TIME)
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium \
//     RUN_OUT=/tmp/matrix-browser.json node --import tsx tests/real-run/checkout-matrix.ts
// The printer cases (P01..P13) are run too: carts the A1 mini can make are paid as above; carts it cannot, or that fall under a minimum, must be REFUSED in
// the cart and in the checkout before any order or Stripe call, and the ones that need a person can send a manual quote request.
// Optional: ONLY=01,05 (scenarios), PORT=3099, SHOTS=/dir (screenshots), STRICT_CART=1 (also fail when the cart's estimate differs from the quote).
// Exit code 1 when quote, order and Stripe do not agree.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { db, resetDb } from '../security/_harness'
import { startTlsProxy, type TlsProxy } from './_tls-proxy'
import { configureTestMachine } from '../security/_harness'
import { PRINTER_SCENARIOS, SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels, type PrinterScenario, type Scenario } from '../security/_checkout-scenarios'

const req = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium, devices } = req('playwright-core')
const jwt = req('jsonwebtoken')

const PORT = Number(process.env.PORT || 3099)
// the server itself (the readiness probe); the browser uses PUBLIC, the https address of the TLS proxy in front of it
// (step 4.6, S5 closure) The server runs in production mode, where a guest's session cookie is `__Host-mw_sid` and a browser keeps such a cookie only over a real https
// connection: the browser reaches `next start` through a TLS proxy of tests/real-run/_tls-proxy.ts (self-signed, `X-Forwarded-Proto: https`), like production does.
const BASE = `http://127.0.0.1:${PORT}`
let PUBLIC = BASE
let proxy: TlsProxy | null = null
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-matrix-'))
const STATE = path.join(WORK, 'state.json')
const LOG = path.join(WORK, 'stripe.log')
const FORMS = path.join(WORK, 'forms.log')
const PRELOAD = path.join(process.cwd(), 'tests/real-run/fake-stripe-http-preload.js')
const only = (process.env.ONLY || '').split(',').map((entry) => entry.trim()).filter(Boolean)
const VIEWPORTS: Array<[string, Record<string, unknown>]> = [
  ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
  ['phone 393x851', devices['Pixel 5']],
]

type Row = Record<string, any>
const rows: Row[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// "10,78 €" (it-IT) or "$10.78" (en-US): whole cents and the symbol, so that a currency mismatch is visible too.
function parseMoney(text: string | null | undefined): { cents: number | null; symbol: string } {
  const value = (text || '').replace(/ /g, ' ').trim()
  const symbol = /€/.test(value) ? '€' : /\$/.test(value) ? '$' : ''
  const digits = /[\d][\d.,]*/.exec(value)?.[0]
  if (!digits) return { cents: null, symbol }
  const normalized = symbol === '€' ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '')
  return { cents: Math.round(Number(normalized) * 100), symbol }
}

let server: ChildProcess | null = null
async function startServer(env: Record<string, string>) {
  fs.writeFileSync(LOG, '')
  fs.writeFileSync(FORMS, '')
  try { fs.rmSync(STATE) } catch { /* none yet */ }
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), BASE_URL: 'https://shop.example.test', HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: 'whsec_FAKE_matrix', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR',
      CHECKOUT_QUOTE_RATE_MAX: '100000', CHECKOUT_SESSION_RATE_MAX: '100000', CHECKOUT_MANUAL_RATE_MAX: '100000', CHECKOUT_GLOBAL_RATE_MAX: '100000',
      FAKE_STRIPE_STATE: STATE, FAKE_STRIPE_LOG: LOG, FAKE_STRIPE_FORMS: FORMS, NODE_OPTIONS: `--require ${PRELOAD}`, ...env,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${BASE}/robots.txt`)).ok } catch { /* not up yet */ }
    if (!up) await sleep(500)
  }
  if (!up) throw new Error('the server did not start')
  proxy = await startTlsProxy(PORT)
  PUBLIC = proxy.origin
}
async function stopServer() {
  if (proxy) { await proxy.stop(); proxy = null }
  if (!server) return
  server.kill('SIGTERM')
  await sleep(800)
  server = null
}

const groupKey = (s: Scenario) => `${s.tax.mode ?? 'none'}|${s.tax.rate ?? ''}|${s.shippingCents ?? '700'}`
const stripeFromForm = () => {
  const last = fs.readFileSync(FORMS, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1)
  if (!last) return null
  const form: Record<string, string> = last.form
  const lines: Array<{ qty: number; unit: number; currency: string; name: string }> = []
  for (let i = 0; form[`line_items[${i}][quantity]`] !== undefined; i++) {
    lines.push({ qty: Number(form[`line_items[${i}][quantity]`]), unit: Number(form[`line_items[${i}][price_data][unit_amount]`]), currency: form[`line_items[${i}][price_data][currency]`], name: form[`line_items[${i}][price_data][product_data][name]`] })
  }
  return { form, lines, total: lines.reduce((sum, line) => sum + line.qty * line.unit, 0) }
}

async function runScenario(browser: any, label: string, device: Record<string, unknown>, scenario: Scenario, data: any, tokens: Record<string, string>) {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  fs.writeFileSync(FORMS, '')
  const context = await browser.newContext({ ...device, baseURL: PUBLIC, ignoreHTTPSErrors: true })
  if (scenario.who === 'discount') await context.addCookies([{ name: 'mwv2_token', value: tokens.discount, url: PUBLIC }])
  await context.route('https://checkout.stripe.com/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  const page = await context.newPage()
  const problems: string[] = []
  page.on('pageerror', (e: Error) => problems.push(`pageerror: ${String(e).slice(0, 100)}`))
  page.on('console', (m: any) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 100)}`) })
  const quotes: any[] = []
  page.on('response', async (r: any) => { if (r.url().endsWith('/api/checkout/quote') && r.status() === 200) quotes.push(await r.json().catch(() => null)) })
  const row: Row = { id: scenario.id, label: scenario.label, viewport: label }
  try {
    // the cart as the cart stores it
    await page.goto('/robots.txt')
    const cart = scenario.items.map((spec, i) => persistedCartItem(spec, data, i))
    await page.evaluate(([items, rush]: [unknown, boolean]) => { localStorage.setItem('mwv2:cart', JSON.stringify(items)); localStorage.setItem('mwv2:cart:rush', rush ? '1' : '0') }, [cart, Boolean(scenario.rush)])

    // 1. the cart page and its own estimate
    await page.goto('/cart')
    // since step 4.2-ter (A1) the cart shows the SERVER's quote: wait for the figure it got (data-testid="cart-subtotal"), not for local arithmetic
    await page.getByTestId('cart-subtotal').waitFor({ timeout: 20000 })
    const shownCart = await page.evaluate(() => {
      const subtotal = document.querySelector('[data-testid="cart-subtotal"]')
      const box = subtotal?.parentElement
      const amount = subtotal?.textContent ?? null
      const struck = box?.querySelector('.line-through')?.textContent ?? null
      return { amount, struck, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    const cartMoney = parseMoney(shownCart.amount)
    row.cartSubtotalCents = cartMoney.cents
    row.cartSymbol = cartMoney.symbol
    row.cartOverflowPx = shownCart.overflow
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${scenario.id}-${label.split(' ')[0]}-cart.png`) })

    // step 4.6: parts of one model that together would make a complete model, bought one by one (a cart saved before groups existed), make the customer CHOOSE
    // before the checkout is offered. This customer keeps them as single parts, at the subtotal shown - then the link to the checkout appears.
    const mustChoose = page.getByTestId('confirm-single-parts')
    if ((await mustChoose.count()) > 0) await mustChoose.first().click()
    // 2. through the real link to the checkout and its quote
    await page.locator('a.btn[href="/checkout"]').click()
    await page.getByTestId('checkout-total').waitFor({ timeout: 20000 })
    if (scenario.shipping === 'ship') {
      await page.locator('label[for=delivery-ship]').click()
      await sleep(800)
    }
    await page.getByTestId('checkout-total').waitFor()
    await sleep(500)
    const uiTotal = parseMoney(await page.getByTestId('checkout-total').textContent())
    const quote = quotes.at(-1)
    row.quoteItemsCents = quote?.itemsTotalCents ?? null
    row.quoteShippingCents = quote?.shipping?.cents ?? null
    row.quoteTaxCents = quote?.tax?.cents ?? null
    row.quoteTotalCents = quote?.totalCents ?? null
    row.uiTotalCents = uiTotal.cents
    row.uiSymbol = uiTotal.symbol
    row.checkoutOverflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${scenario.id}-${label.split(' ')[0]}-checkout.png`) })

    // 3. pay: the redirect to Stripe, the order and what the SDK sent
    await page.getByTestId('pay-button').click()
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 })
    const order = await prisma.printOrder.findFirst({ orderBy: { createdAt: 'desc' }, include: { paymentAttempts: true } })
    const stripe = stripeFromForm()
    row.orderTotalCents = order?.totalCents ?? null
    row.orderCurrency = order?.currency ?? null
    row.stripeTotalCents = stripe?.total ?? null
    row.stripeCurrency = stripe ? Array.from(new Set(stripe.lines.map((l) => l.currency))).join(',') : null
    row.stripeLines = stripe ? stripe.lines.map((l) => `${l.qty} x ${l.unit}`) : null
    row.stripeOrderRef = stripe?.form['client_reference_id'] === order?.id && order?.paymentAttempts[0]?.stripeSessionId?.startsWith('cs_')
    row.redirectedTo = new URL(page.url()).hostname
    row.agree = row.quoteTotalCents === row.orderTotalCents && row.orderTotalCents === row.stripeTotalCents && row.uiTotalCents === row.quoteTotalCents
    row.cartDiffCents = row.cartSubtotalCents != null && row.quoteItemsCents != null ? row.cartSubtotalCents - row.quoteItemsCents : null
  } catch (err: any) {
    row.error = String(err?.message || err).split('\n')[0].slice(0, 160)
    row.agree = false
  }
  row.problems = problems.slice(0, 3)
  rows.push(row)
  await context.close()
}

// A printer case that must NOT be paid: the cart and the checkout both refuse it, nothing reaches Stripe, no order exists; a "review" case can then send a
// request for a manual quote, which is stored without a price and without a payment.
async function runBlockedScenario(browser: any, label: string, device: Record<string, unknown>, scenario: PrinterScenario, data: any) {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  fs.writeFileSync(FORMS, '')
  const context = await browser.newContext({ ...device, baseURL: PUBLIC, ignoreHTTPSErrors: true })
  await context.route('https://checkout.stripe.com/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  const page = await context.newPage()
  const problems: string[] = []
  page.on('pageerror', (e: Error) => problems.push(`pageerror: ${String(e).slice(0, 100)}`))
  const answers: any[] = []
  page.on('response', async (r: any) => { if (r.url().endsWith('/api/checkout/quote')) answers.push({ status: r.status(), body: await r.json().catch(() => null) }) })
  const row: Row = { id: scenario.id, label: scenario.label, viewport: label, expected: scenario.outcome.kind }
  try {
    await page.goto('/robots.txt')
    const cart = scenario.items.map((spec, i) => persistedCartItem(spec, data, i))
    await page.evaluate(([items]: [unknown]) => { localStorage.setItem('mwv2:cart', JSON.stringify(items)); localStorage.setItem('mwv2:cart:rush', '0') }, [cart])

    // 1. the cart: no price, an explanation, Checkout off
    await page.goto('/cart')
    await page.getByTestId('cart-quote-error').waitFor({ timeout: 20000 })
    row.cartShowsPrice = (await page.getByTestId('cart-subtotal').count()) > 0
    row.cartCheckoutDisabled = await page.getByRole('button', { name: 'Checkout', exact: true }).isDisabled().catch(() => false)
    row.cartMessage = ((await page.getByTestId('cart-quote-error').locator('p').first().textContent()) || '').trim().slice(0, 140)
    row.cartOverflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (scenario.outcome.kind === 'review') row.cartFormShown = await page.getByTestId('manual-quote').isVisible()
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${scenario.id}-${label.split(' ')[0]}-cart.png`) })

    // 2. the checkout: the same refusal, pay off
    await page.goto('/checkout')
    await page.getByTestId('checkout-error').waitFor({ timeout: 20000 })
    row.checkoutPayDisabled = await page.getByTestId('pay-button').isDisabled()
    row.checkoutMessage = ((await page.getByTestId('checkout-error').locator('p').first().textContent()) || '').trim().slice(0, 140)
    row.checkoutOverflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const refusal = answers.at(-1)
    row.quoteStatus = refusal?.status
    row.quoteCode = refusal?.body?.code
    row.reasons = (refusal?.body?.details?.reviews ?? []).map((line: any) => `${line.itemIndex + 1}:${line.reasons.map((reason: any) => reason.code).join('+')}`)
    row.minimumCents = refusal?.body?.details?.minimumCents ?? null
    row.itemsTotalCents = refusal?.body?.details?.itemsTotalCents ?? null
    row.totalCents = refusal?.body?.details?.totalCents ?? null
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${scenario.id}-${label.split(' ')[0]}-checkout.png`) })

    // 3. a person is asked for (review cases only)
    if (scenario.outcome.kind === 'review') {
      await page.getByTestId('manual-quote-email').fill(`${scenario.id.toLowerCase()}@example.test`)
      await page.getByTestId('manual-quote-send').click()
      await page.getByTestId('manual-quote-sent').waitFor({ timeout: 20000 })
      const request = await prisma.printOrder.findFirst({ orderBy: { createdAt: 'desc' }, include: { items: true } })
      row.requestStatus = request?.status
      row.requestPayment = request?.paymentStatus
      row.requestTotalCents = request?.totalCents
      row.requestLines = request?.items.length
    }
    const forms = fs.readFileSync(FORMS, 'utf8').split('\n').filter(Boolean).length
    row.stripeCalls = forms
    row.orders = await prisma.printOrder.count({ where: { paymentMethod: { not: 'quote' } } })
    const expected = scenario.outcome
    row.agree = row.cartShowsPrice === false && row.cartCheckoutDisabled === true && row.checkoutPayDisabled === true && forms === 0 && row.orders === 0
      && (expected.kind === 'refused'
        ? row.quoteCode === expected.code
        : expected.kind === 'review'
          ? row.quoteCode === 'MANUAL_REVIEW_REQUIRED' && JSON.stringify(row.reasons) === JSON.stringify(expected.lines.map((line, i) => `${line + 1}:${expected.codes[i]}`)) && row.requestStatus === 'awaiting_review' && row.requestPayment === 'quote' && row.requestTotalCents === 0 && row.requestLines === scenario.items.length && row.cartFormShown === true
          : false)
  } catch (err: any) {
    row.error = String(err?.message || err).split('\n')[0].slice(0, 160)
    row.agree = false
  }
  row.problems = problems.slice(0, 3)
  rows.push(row)
  await context.close()
}

;(async () => {
  await resetDb()
  await seedScenarioConfig()
  const data = await seedScenarioModels('matrix')
  const prisma = await db()
  const tokens = { discount: jwt.sign({ sub: data.discountUser.id }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '1d' }) }
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
  const groups = new Map<string, Array<Scenario | PrinterScenario>>()
  for (const scenario of [...SCENARIOS, ...PRINTER_SCENARIOS]) {
    if (only.length && !only.includes(scenario.id)) continue
    groups.set(groupKey(scenario), [...(groups.get(groupKey(scenario)) ?? []), scenario])
  }
  try {
    for (const [key, scenarios] of groups) {
      const [mode, rate, shipping] = key.split('|')
      await prisma.rateLimit.deleteMany()
      await startServer({ TAX_MODE: mode, ...(rate ? { TAX_RATE_PERCENT: rate } : {}), SHIPPING_FLAT_RATE_CENTS: shipping })
      for (const scenario of scenarios) {
        const printerCase = 'outcome' in scenario ? scenario as PrinterScenario : null
        // the machine and the shop's minimum order are data in the database: the running server reads them on every request
        await configureTestMachine(printerCase?.machineMaterials ? { allowedMaterials: printerCase.machineMaterials } : {})
        await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: printerCase?.minimumOrder ?? 0, minimumPriceUsd: printerCase?.minimumPiece ?? 5 } as any })
        for (const [label, device] of VIEWPORTS) {
          if (printerCase && printerCase.outcome.kind !== 'pay') await runBlockedScenario(browser, label, device, printerCase, data)
          else await runScenario(browser, label, device, scenario, data, tokens)
        }
        const last = rows.slice(-2).map((r) => (r.expected === 'review' || r.expected === 'refused')
          ? `${r.viewport.split(' ')[0]}: ${r.quoteCode} ${r.reasons?.join(',') || ''} orders ${r.orders} stripe ${r.stripeCalls} ${r.agree ? 'OK' : 'DIFF'}${r.error ? ' ' + r.error : ''}`
          : `${r.viewport.split(' ')[0]}: cart ${r.cartSubtotalCents} quote ${r.quoteTotalCents} order ${r.orderTotalCents} stripe ${r.stripeTotalCents} ${r.agree ? 'OK' : 'DIFF'}${r.error ? ' ' + r.error : ''}`)
        console.log(`${scenario.id} ${last.join(' | ')}`)
      }
      await stopServer()
    }
  } finally {
    await stopServer()
    await browser.close()
  }
  if (process.env.RUN_OUT) fs.writeFileSync(process.env.RUN_OUT, JSON.stringify({ data, rows }, null, 1))
  const bad = rows.filter((r) => !r.agree)
  // the cart's own estimate against the server's items total (the cart shows no shipping or tax): informative until the cart uses the server's quote
  const cartDifferent = rows.filter((r) => r.expected === undefined && (r.cartDiffCents == null || Math.abs(r.cartDiffCents) > 1))
  console.log(`\n${rows.length} runs, ${bad.length} where quote, order and Stripe do not agree`)
  console.log(`${cartDifferent.length} runs where the cart's estimate differs from the server's items total by more than one cent${process.env.STRICT_CART === '1' ? ' (STRICT_CART=1: counted as a failure)' : ''}`)
  process.exit(bad.length || (process.env.STRICT_CART === '1' && cartDifferent.length) ? 1 : 0)
})().catch(async (err) => { console.error(err); await stopServer(); process.exit(2) })
