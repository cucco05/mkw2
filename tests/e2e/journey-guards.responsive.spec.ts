// Step 4.5 – the whole guest journey in a browser, on a desktop and on the two phone sizes (projects "chromium", "mobile" 393x851 and "mobile-small" 360x640 of
// playwright.config.ts), with the three checks the earlier browser specs did not make over the WHOLE journey:
//   * no error in the browser's console (console.error, uncaught exceptions) on any page of the journey;
//   * no request to another site (fonts, scripts, images, analytics...), apart from the Stripe payment page the test itself stands in for;
//   * screenshots of every step, saved for people to look at (test-results/step-4.5/<project>/NN-step.png, also attached to the report).
// and, at every step, no page wider than the screen and (on a phone) thumb-sized primary controls.
//
// The journey: home -> Discover -> the model page -> add from the list -> cart (a colour is needed) -> checkout -> "pay" (goes to a stand-in for the Stripe
// page) -> the payment page left (/checkout?canceled=1) -> back on /checkout/success: confirming, then paid -> the order whose payment page expired.
// The pricing is the server's, for real (the quote of the app under test); the session and status answers are fixed ones - the server side of the payment is
// tests/security/*.sec.ts and tests/real-run/*.ts - and Stripe is a STAND-IN: this is NOT a payment with Stripe in test mode and NOT a real phone (docs/CHECKLIST-PRELANCIO.md).
// Needs the app running and the e2e seed (tests/e2e/seed-customer-orders.ts, E2E_FIXTURE); otherwise skipped.
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const FIXTURE = (process.env.E2E_FIXTURE || '').trim()
const data = FIXTURE && fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { shopModel?: { id: string; title: string } } : null
const shop = data?.shopModel ?? null
const MIN_TOUCH = 44
const ORDER = 'clorder0000000000000001'
const STRIPE_STAND_IN = /^https:\/\/checkout\.stripe\.com\//
const SHOTS = path.join(process.cwd(), 'test-results', 'step-4.5')

type Guards = { assertClean: () => void; external: string[]; consoleErrors: string[] }
// Records everything that should never happen. Nothing is filtered silently: what is allowed is listed here, with the reason.
function watch(page: Page, baseURL: string): Guards {
  const origin = new URL(baseURL).origin
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const external: string[] = []
  const serverErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} (${message.location().url})`) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = request.url()
    if (/^(data|blob|about):/.test(url)) return
    if (new URL(url).origin === origin) return
    if (STRIPE_STAND_IN.test(url)) return // the stand-in for the Stripe payment page: the one place the journey is meant to leave the site
    external.push(url)
  })
  page.on('response', (response) => { if (new URL(response.url()).origin === origin && response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`) })
  return {
    external,
    consoleErrors,
    assertClean() {
      expect(external, 'requests to another site').toEqual([])
      expect(pageErrors, 'uncaught errors in the page').toEqual([])
      expect(serverErrors, 'answers of the site with a 5xx status').toEqual([])
      expect(consoleErrors, 'errors in the browser console').toEqual([])
    },
  }
}

let step = 0
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file = path.join(SHOTS, testInfo.project.name, `${String(++step).padStart(2, '0')}-${name}.png`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await page.screenshot({ path: file, fullPage: true })
  await testInfo.attach(`${String(step).padStart(2, '0')}-${name}`, { path: file, contentType: 'image/png' })
}

async function fits(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, section'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
async function thumbSized(locator: ReturnType<Page['locator']>, label: string, isMobile: boolean) {
  if (!isMobile) return
  const box = await locator.boundingBox()
  expect(box, `${label} is on the screen`).not.toBeNull()
  expect(box!.height, `${label}: height`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
}

test('guest journey: browse -> model -> cart -> checkout -> payment page -> back (confirming, paid) -> left page -> expired; clean console, no outside requests, screenshots', async ({ page, baseURL, isMobile }, testInfo) => {
  test.skip(!shop, 'E2E_FIXTURE with a shop model is not set (see tests/e2e/seed-customer-orders.ts)')
  const model = shop!
  step = 0
  const guards = watch(page, baseURL!)

  // the card is off on a local http server in production mode: the one field that says "payment is available" is set on the way through, the rest is the server's
  await page.route('**/api/checkout/quote', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, canCheckout: true, unavailableReason: null } })
  })
  const sessions: string[] = []
  await page.route('**/api/checkout/session', async (route) => {
    sessions.push(route.request().postData() || '')
    const body = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orderId: ORDER, orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_standin', totalCents: body.expectedTotalCents ?? 0 }) })
  })
  await page.route(STRIPE_STAND_IN, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Stripe (stand-in)</title><h1>Stripe (stand-in)</h1>' }))
  let state: string = 'confirming'
  await page.route('**/api/checkout/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ orderNumber: 12, state, totalCents: 2500, currency: 'EUR', final: ['paid', 'attention', 'canceled'].includes(state), pollAfterMs: state === 'confirming' ? 2500 : null }),
  }))

  // 1. home
  await page.goto('/')
  await expect(page.getByRole('link', { name: /Browse Library/i })).toBeVisible()
  await fits(page, 'home'); await shot(page, testInfo, 'home')

  // 2. Discover (it keeps its list for 90 seconds: right after the seed it can still show an earlier run's list, the next visit shows the new one)
  await page.goto('/discover')
  await expect(page.getByRole('heading', { name: /Discover Models/i })).toBeVisible()
  const link = page.locator(`a[href="/models/${model.id}"]`).first()
  if (!(await link.isVisible())) { await page.waitForTimeout(2000); await page.reload() }
  await expect(link).toBeVisible()
  await fits(page, 'discover'); await shot(page, testInfo, 'discover')

  // 3. the model page
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/models/${model.id}`))
  const save = page.getByRole('button', { name: /Save to cart/i })
  await expect(save).toBeVisible()
  await fits(page, 'model page'); await shot(page, testInfo, 'model')

  // 4. add from the list, then the cart (a colour is needed before the checkout is offered)
  await page.goto('/discover')
  await page.locator(`a[href="/models/${model.id}"]`).first().getByRole('button', { name: /^Add$/ }).click()
  await expect(page.getByText('1 in cart').first()).toBeVisible()
  await page.goto('/cart')
  await expect(page.getByRole('heading', { name: /Your Cart/i })).toBeVisible()
  await expect(page.getByText(/Choose at least one filament color/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
  await fits(page, 'cart without a colour'); await shot(page, testInfo, 'cart-needs-colour')
  await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('mwv2:cart') || '[]')
    for (const item of items) item.options.colors = ['#ffffff']
    localStorage.setItem('mwv2:cart', JSON.stringify(items))
  })
  await page.reload()
  const checkout = page.getByRole('link', { name: 'Checkout' })
  await expect(checkout).toBeVisible()
  await expect(page.getByTestId('cart-subtotal')).toBeVisible()
  await fits(page, 'cart'); await thumbSized(checkout, 'cart "Checkout"', isMobile); await shot(page, testInfo, 'cart')

  // 5. the checkout page, and "pay": the stand-in for the Stripe page opens
  await checkout.click()
  await expect(page).toHaveURL(/\/checkout/)
  const pay = page.getByTestId('pay-button')
  await expect(page.getByRole('heading', { name: /Riepilogo e pagamento/i })).toBeVisible()
  await expect(page.getByTestId('checkout-total')).toBeVisible()
  await expect(pay).toBeEnabled()
  await fits(page, 'checkout'); await thumbSized(pay, 'the pay button', isMobile); await shot(page, testInfo, 'checkout')
  await pay.click()
  await page.waitForURL(STRIPE_STAND_IN)
  expect(sessions.length, 'one payment page was asked for').toBe(1)
  expect(JSON.parse(sessions[0]).items.length, 'with the cart').toBe(1)
  await shot(page, testInfo, 'payment-page-stand-in')

  // 6. the payment page was left (Stripe sends the customer back to the checkout, nothing paid): the cart is still there and paying is possible
  state = 'pending'
  await page.goto('/checkout?canceled=1')
  await expect(page.getByRole('heading', { name: /Riepilogo e pagamento/i })).toBeVisible()
  await expect(page.getByTestId('pay-button')).toBeEnabled()
  await fits(page, 'checkout after leaving the payment page'); await shot(page, testInfo, 'checkout-left-the-payment-page')

  // 7. back on the return page after paying: confirming, then paid (the answers are the stand-in's; the page decides what it shows from them)
  state = 'confirming'
  await page.goto(`/checkout/success?order=${ORDER}`)
  await expect(page.getByTestId('status-confirming')).toBeVisible()
  await fits(page, 'return: confirming'); await shot(page, testInfo, 'return-confirming')
  state = 'paid'
  await expect(page.getByTestId('status-paid')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('status-order-number')).toBeVisible()
  await fits(page, 'return: paid'); await shot(page, testInfo, 'return-paid')
  const controls = page.locator('[data-testid^="status-"] a, [data-testid^="status-"] button')
  for (let i = 0; i < await controls.count(); i++) await thumbSized(controls.nth(i), `return page control ${i}`, isMobile)

  // 8. an order whose payment page expired
  state = 'canceled'
  await page.goto(`/checkout/success?order=${ORDER}`)
  await expect(page.getByTestId('status-canceled')).toBeVisible()
  await fits(page, 'return: expired'); await shot(page, testInfo, 'return-expired')

  guards.assertClean()
})
