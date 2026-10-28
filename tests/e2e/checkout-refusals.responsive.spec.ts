// The refusals of the guard against a second order for the same purchase key, at the checkout - on a desktop and on phone-sized screens (projects "chromium", "mobile" and
// "mobile-small" of playwright.config.ts) - R1-1b.
//
// The server answers 409 when a payment request carries a checkout key that is already tied to an order the browser cannot show to be its own (lib/purchase-intent.ts:
// "started", "paid", or a payment "in doubt"). The page must say it in plain Italian, with the support code the answer carries; say that THIS request started nothing and that
// the cart is as it was; make no claim about charges (an earlier payment may exist); keep the cart and the key exactly as they were (a refusal is no reason to start another
// purchase: pressing again sends the SAME key); and give the button back, thumb-sized, without scrolling sideways. The server's answers are replaced by fixed ones
// (page.route): this tests the PAGE. Whether the server refuses what it must is the business of tests/security/purchase-key.sec.ts.
// Emulated screens are NOT a real iPhone, Safari or an old Android browser: the real-device checks are items of docs/CHECKLIST-PRELANCIO.md and stay open.
import { expect, test, type Page, type Route } from '@playwright/test'

const MIN_TOUCH = 44 // px
const CART_KEY = 'mwv2:cart'
const KEY_ENTRY = 'mw:checkout-key:v1'
const STRONG_KEY = /^k[A-Za-z0-9_-]{32}$/
const SUPPORT_CODE = '3F9A2-C71B0'

const quote = () => ({
  currency: 'EUR',
  items: [{ title: 'Supporto cuffie', partName: null, qty: 2, material: 'PLA', colors: ['#ffffff'], finish: null, unitPriceCents: 2450, lineTotalCents: 4900, undiscountedLineTotalCents: 4900, discountPercent: 0, leadTimeHours: 6.5 }],
  itemsTotalCents: 4900, discountPercent: 0,
  shipping: { method: 'pickup', cents: 0, label: null },
  shippingOffer: { shipAvailable: true, shipCents: 700, shipLabel: 'Spedizione in Italia', shipCountries: ['IT'] },
  tax: { mode: 'inclusive', ratePercent: 22, cents: 884, addedToTotal: false },
  totalCents: 4900, canCheckout: true, unavailableReason: null,
})
const cartLine = () => ({
  cartItemId: 'ci-1', modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title: 'Supporto cuffie', priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty: 2, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

type Refusal = { code: string; message: string }
const STARTED: Refusal = { code: 'PURCHASE_ALREADY_STARTED', message: 'This purchase was already started. Nothing new was started.' }
const PAID: Refusal = { code: 'PURCHASE_ALREADY_PAID', message: 'This purchase already has a payment. Nothing new was started.' }
const IN_DOUBT: Refusal = { code: 'PAYMENT_IN_PROGRESS', message: 'A payment for this cart is already being confirmed. Check its status before paying again.' }

// The page, with the quote and the payment endpoint replaced. Every call to the payment endpoint is kept (the body as sent) in `bodies`, and also recorded INSIDE the page by wrapping
// fetch before any script runs, so that "nothing was sent" does not depend on how fast the test runner hears about a request.
async function openCheckout(page: Page, bodies: string[], refusal: Refusal | null, options: { withoutWebCrypto?: boolean } = {}) {
  await page.addInitScript((without) => {
    const posts: string[] = []
    ;(window as unknown as { __sessionPosts: string[] }).__sessionPosts = posts
    const original = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/\/api\/checkout\/session(\?|$)/.test(url)) posts.push(String(init?.body ?? ''))
      return original(input, init)
    }
    // a browser with no Web Crypto at all, from the very start of the page
    if (without) Object.defineProperty(window, 'crypto', { value: undefined, configurable: true, writable: true })
  }, Boolean(options.withoutWebCrypto))
  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  await page.route('**/api/checkout/quote', (route) => json(route, 200, quote()))
  await page.route('**/api/checkout/session', async (route) => {
    bodies.push(route.request().postData() || '')
    if (!refusal) return json(route, 200, { orderId: 'clorder0000000000000001', orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_fake', totalCents: 4900 })
    // exactly the four things the server puts in a refusal, and nothing about whose order it is
    return json(route, 409, { error: refusal.message, code: refusal.code, supportCode: SUPPORT_CODE, retry: false })
  })
  await page.goto('/robots.txt')
  await page.evaluate(([key, line]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key as string, JSON.stringify([line])) }, [CART_KEY, cartLine()] as const)
  await page.goto('/checkout')
  await expect(page.getByTestId('checkout-total')).toHaveText(/49,00/)
}

const sessionPosts = (page: Page) => page.evaluate(() => (window as unknown as { __sessionPosts: string[] }).__sessionPosts.slice())
const storedKeyEntry = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY_ENTRY)
const cartNow = (page: Page) => page.evaluate((key) => localStorage.getItem(key), CART_KEY)
const press = async (page: Page, locator: ReturnType<Page['locator']>) => { if (await page.evaluate(() => 'ontouchstart' in window)) await locator.tap(); else await locator.click() }

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, label, li, dl, fieldset, [role=alert]'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
async function expectTouchTarget(locator: ReturnType<Page['locator']>, label: string) {
  const box = await locator.boundingBox()
  expect(box, `${label} is on screen`).not.toBeNull()
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TOUCH)
}

// the same checks for every refusal
// (`saysNothingWasStarted`: the two sentences of the guard say what THIS request did; the sentence of a payment in doubt is the one that has always been there, and does not)
async function expectRefusedInPlainWords(page: Page, bodies: string[], label: string, saysNothingWasStarted = true) {
  const cartBefore = await cartNow(page)
  await press(page, page.getByTestId('pay-button'))
  const error = page.getByTestId('checkout-error')
  await expect(error).toBeVisible()
  await expect(error).toContainText(SUPPORT_CODE)
  await expect(error).toContainText('carrello')
  await expect(error).toContainText(/non serve pagare di nuovo/i)
  if (saysNothingWasStarted) await expect(error, 'what THIS request did').toContainText('non ha avviato nessun nuovo pagamento')
  await expect(error, 'no claim about charges: an earlier payment may exist').not.toContainText('addebit')
  await expect(error, 'nothing of the order or of the server').not.toContainText('clorder')
  await expect(error).not.toContainText('PURCHASE_')
  await expect(error).not.toContainText('Stripe')
  expect(await sessionPosts(page), `${label}: exactly one request left the page`).toHaveLength(1)
  expect(bodies, `${label}: and the network layer saw the same`).toHaveLength(1)
  const sent = JSON.parse(bodies[0])
  expect(sent.checkoutKey, `${label}: with a strong key`).toMatch(STRONG_KEY)
  expect(new Set(String(sent.checkoutKey).slice(1)).size, 'at least 16 different characters').toBeGreaterThanOrEqual(16)
  // the cart is exactly as it was and the key is kept - exactly the one that was sent
  expect(await cartNow(page), `${label}: the cart is exactly as it was`).toBe(cartBefore)
  const kept = JSON.parse((await storedKeyEntry(page)) as string)
  expect(kept.key, `${label}: the key is kept, not forgotten and not changed`).toBe(sent.checkoutKey)
  // nothing is locked: the button is back, usable, thumb-sized, and the page still fits the screen
  const pay = page.getByTestId('pay-button')
  await expect(pay).toBeEnabled()
  await expect(pay).toHaveAttribute('aria-busy', 'false')
  await expectFitsScreen(page, label)
  await expectTouchTarget(pay, 'pay button')
  await expectTouchTarget(page.getByRole('link', { name: 'Torna al carrello' }), 'back-to-cart link')
  return sent.checkoutKey as string
}

test.describe('the refusals of the purchase-key guard, every screen size', () => {
  test('already started: the sentence, the support code, the cart and the key as they were, the button back', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies, STARTED)
    await expectRefusedInPlainWords(page, bodies, 'already started')
    await expect(page.getByTestId('checkout-error')).toContainText('già un acquisto avviato')
  })

  test('already paid: the sentence, the support code, the cart and the key as they were, the button back', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies, PAID)
    await expectRefusedInPlainWords(page, bodies, 'already paid')
    await expect(page.getByTestId('checkout-error')).toContainText('pagamento andato a buon fine')
  })

  test('a payment in doubt, said by the guard (no order named): the old sentence and the support code', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies, IN_DOUBT)
    await expectRefusedInPlainWords(page, bodies, 'payment in doubt', false)
    await expect(page.getByTestId('checkout-error')).toContainText('già un pagamento in conferma o in verifica')
    await expect(page.getByRole('link', { name: "Controlla lo stato dell'ordine" }), 'there is no order to send the customer to').toHaveCount(0)
  })

  test('pressing again after a refusal sends the SAME key every time - a refusal is no reason to start another purchase - and the page stays usable', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies, STARTED)
    const first = await expectRefusedInPlainWords(page, bodies, 'first press')
    for (let again = 2; again <= 3; again++) {
      await press(page, page.getByTestId('pay-button'))
      await expect.poll(async () => (await sessionPosts(page)).length).toBe(again)
      await expect(page.getByTestId('checkout-error')).toContainText(SUPPORT_CODE)
      await expect(page.getByTestId('pay-button')).toBeEnabled()
    }
    expect(bodies.map((body) => JSON.parse(body).checkoutKey), 'three presses, one key').toEqual([first, first, first])
    expect(new Set(bodies.map((body) => JSON.parse(body).expectedTotalCents))).toEqual(new Set([4900]))
    await expectFitsScreen(page, 'after three refusals')
  })

  test('a browser with no Web Crypto from the very start: nothing is sent, the page says so, the cart is untouched and the button is back (the guard is not reached, and the sentence is not the one of a refusal)', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies, STARTED, { withoutWebCrypto: true })
    const before = await cartNow(page)
    await press(page, page.getByTestId('pay-button'))
    const error = page.getByTestId('checkout-error')
    await expect(error).toBeVisible()
    await expect(error).toContainText('nessuna richiesta di pagamento')
    await expect(error).toContainText('carrello è rimasto')
    await expect(error).not.toContainText(SUPPORT_CODE)
    expect(await sessionPosts(page)).toEqual([])
    expect(bodies).toEqual([])
    expect(await cartNow(page)).toBe(before)
    expect(await storedKeyEntry(page)).toBeNull()
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expectFitsScreen(page, 'no Web Crypto')
  })

  test('control: with no refusal the payment goes out once, with a strong key, and the page leaves for the payment page', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies, null)
    await press(page, page.getByTestId('pay-button'))
    await expect(page.getByRole('heading', { name: 'Stripe (fake)' })).toBeVisible()
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]).checkoutKey).toMatch(STRONG_KEY)
  })
})
