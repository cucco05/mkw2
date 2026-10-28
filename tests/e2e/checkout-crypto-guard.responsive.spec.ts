// A browser that can not make a secure checkout key, at the checkout - on a desktop and on phone-sized screens (projects "chromium", "mobile" and "mobile-small" of
// playwright.config.ts) - R1-1a.
//
// The checkout key (lib/checkout-client.ts) may only come from Web Crypto. When it can not be made - no Web Crypto, one that throws, one that gives degenerate bytes - the
// page must send NOTHING, say so in plain Italian, leave the cart exactly as it was, and give the button back (a refusal must not lock the page). The server's answers are
// replaced by fixed ones (page.route): this tests the PAGE. Whether a request that DOES go out is safe is the server's business, tested by tests/security/*.sec.ts.
// Web Crypto is broken AFTER the page has loaded, right before the press, so the app's own start-up is not what is being tested.
// "Nothing was sent" is read inside the page (the fetch calls it made), not from the network layer, so the check does not depend on how fast the test runner hears about a
// request. No pause is used to wait for something that must not happen: the refusal comes in the same call that would have sent the request.
// Emulated screens are NOT a real iPhone, Safari or an old Android browser: the real-device checks are items of docs/CHECKLIST-PRELANCIO.md and stay open.
import { expect, test, type Page, type Route } from '@playwright/test'

const MIN_TOUCH = 44 // px
const CART_KEY = 'mwv2:cart'
const KEY_ENTRY = 'mw:checkout-key:v1'
const STRONG_KEY = /^k[A-Za-z0-9_-]{32}$/

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
const answerOk = (route: Route) => json(route, 200, { orderId: 'clorder0000000000000001', orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_fake', totalCents: 4900 })

async function openCheckout(page: Page, bodies: string[]) {
  // every call the page makes to the payment endpoint is also recorded INSIDE the page, synchronously, by wrapping fetch before any script runs
  await page.addInitScript(() => {
    const posts: string[] = []
    ;(window as unknown as { __sessionPosts: string[] }).__sessionPosts = posts
    const original = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/\/api\/checkout\/session(\?|$)/.test(url)) posts.push(String(init?.body ?? ''))
      return original(input, init)
    }
  })
  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  await page.route('**/api/checkout/quote', (route) => json(route, 200, quote()))
  await page.route('**/api/checkout/session', async (route) => {
    bodies.push(route.request().postData() || '')
    await answerOk(route)
  })
  await page.goto('/robots.txt')
  await page.evaluate(([key, line]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key as string, JSON.stringify([line])) }, [CART_KEY, cartLine()] as const)
  await page.goto('/checkout')
  await expect(page.getByTestId('checkout-total')).toHaveText(/49,00/)
}

type Breakage = 'missing' | 'throws' | 'degenerate'
// What the browser would be: no Web Crypto at all, a Web Crypto whose getRandomValues throws, or one that returns the same byte every time.
const breakWebCrypto = (page: Page, how: Breakage) => page.evaluate((mode) => {
  const w = window as unknown as { __realCrypto?: Crypto }
  w.__realCrypto = window.crypto
  const stub = mode === 'missing' ? undefined : {
    subtle: window.crypto.subtle,
    randomUUID: window.crypto.randomUUID.bind(window.crypto),
    getRandomValues: mode === 'throws'
      ? () => { throw new DOMException('no entropy available', 'OperationError') }
      : (array: Uint8Array) => { array.fill(7); return array },
  }
  Object.defineProperty(window, 'crypto', { value: stub, configurable: true, writable: true })
}, how)
const restoreWebCrypto = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __realCrypto?: Crypto }
  if (w.__realCrypto) Object.defineProperty(window, 'crypto', { value: w.__realCrypto, configurable: true, writable: true })
})

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

// the same checks for every way the key can fail
async function expectRefusedWithoutAKey(page: Page, bodies: string[], label: string) {
  const before = await cartNow(page)
  await press(page, page.getByTestId('pay-button'))
  const error = page.getByTestId('checkout-error')
  await expect(error).toBeVisible()
  await expect(error).toContainText('browser')
  await expect(error).toContainText('nessuna richiesta di pagamento')
  await expect(error).toContainText('carrello è rimasto')
  await expect(error).toContainText('Aggiorna il browser')
  await expect(error).toContainText('pagamenti avviati in precedenza')
  await expect(error, 'no claim about charges').not.toContainText('addebit')
  await expect(error, 'no invitation to repeat a payment').not.toContainText('Riprova')
  expect(await sessionPosts(page), `${label}: the page sent nothing to the payment endpoint`).toEqual([])
  expect(bodies, `${label}: and the network layer saw nothing`).toEqual([])
  expect(await cartNow(page), `${label}: the cart is exactly as it was`).toBe(before)
  expect(await storedKeyEntry(page), `${label}: no key was stored`).toBeNull()
  // nothing is locked: the button is back, usable, thumb-sized
  const pay = page.getByTestId('pay-button')
  await expect(pay).toBeEnabled()
  await expect(pay).toHaveAttribute('aria-busy', 'false')
  await expectFitsScreen(page, label)
  await expectTouchTarget(pay, 'pay button')
  await expectTouchTarget(page.getByRole('link', { name: 'Torna al carrello' }), 'back-to-cart link')
}

test.describe('checkout key from Web Crypto only, every screen size', () => {
  test('no Web Crypto at all: nothing is sent, the page says so, the cart is untouched and the button comes back', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies)
    await breakWebCrypto(page, 'missing')
    await expectRefusedWithoutAKey(page, bodies, 'no Web Crypto')
  })

  test('a Web Crypto that throws: the same refusal - no exception, no stuck button', async ({ page }) => {
    const bodies: string[] = []
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openCheckout(page, bodies)
    await breakWebCrypto(page, 'throws')
    await expectRefusedWithoutAKey(page, bodies, 'Web Crypto that throws')
    expect(errors, 'no uncaught exception reached the page').toEqual([])
  })

  test('a degenerate generator (the same byte every time): no key is accepted as strong, the same refusal', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies)
    await breakWebCrypto(page, 'degenerate')
    await expectRefusedWithoutAKey(page, bodies, 'degenerate generator')
  })

  test('after a refusal nothing stays locked: with Web Crypto back, the same button pays - with a strong key - and a second refusal after that is still a refusal', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies)
    await breakWebCrypto(page, 'throws')
    await expectRefusedWithoutAKey(page, bodies, 'first refusal')
    await restoreWebCrypto(page)
    await press(page, page.getByTestId('pay-button'))
    await expect(page.getByRole('heading', { name: 'Stripe (fake)' })).toBeVisible()
    expect(bodies, 'one request: the one made after Web Crypto came back').toHaveLength(1)
    const sent = JSON.parse(bodies[0])
    expect(sent.checkoutKey, 'a strong key').toMatch(STRONG_KEY)
    expect(new Set(String(sent.checkoutKey).slice(1)).size, 'at least 16 different characters').toBeGreaterThanOrEqual(16)
    expect(sent.expectedTotalCents).toBe(4900)
  })

  test('control: with a working Web Crypto the payment goes out exactly once, with a strong key', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, bodies)
    await expectTouchTarget(page.getByTestId('pay-button'), 'pay button')
    await press(page, page.getByTestId('pay-button'))
    await expect(page.getByRole('heading', { name: 'Stripe (fake)' })).toBeVisible()
    expect(bodies).toHaveLength(1)
    const key = JSON.parse(bodies[0]).checkoutKey as string
    expect(key).toMatch(STRONG_KEY)
    expect(new Set(key.slice(1)).size, 'at least 16 different characters').toBeGreaterThanOrEqual(16)
  })
})
