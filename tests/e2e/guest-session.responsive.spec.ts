// A guest's session at the checkout, on a desktop and on phone-sized screens (projects "chromium", "mobile" and "mobile-small" of playwright.config.ts) - step 4.6, S5.
// The server's answers are replaced by fixed ones (page.route), so this tests the PAGE: what it does when the server answers 428 ("no session yet, here is one, ask
// again"), when the browser keeps no cookies, and when the browser says so before anything is pressed. What the server does with a session is tested by
// tests/security/guest-session*.sec.ts and by the real-server run (tests/real-run/guest-session.ts, a real browser against `next start`).
// Emulated screens are NOT a real iPhone or Android phone: cookies on those are a checklist item (docs/CHECKLIST-PRELANCIO.md).
import { expect, test, type Page, type Route } from '@playwright/test'

const MIN_TOUCH = 44 // px
const CART_KEY = 'mwv2:cart'

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
const answer428 = (route: Route) => json(route, 428, { error: 'Your browser needs a session before it can pay.', code: 'SESSION_REQUIRED', retry: true })
const answerOk = (route: Route) => json(route, 200, { orderId: 'clorder0000000000000001', orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_fake', totalCents: 4900 })

async function openCheckout(page: Page, session: (route: Route, index: number) => Promise<void> | void, bodies: string[], opts: { cookiesOff?: boolean } = {}) {
  if (opts.cookiesOff) await page.addInitScript(() => { Object.defineProperty(navigator, 'cookieEnabled', { get: () => false }) })
  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  await page.route('**/api/checkout/quote', (route) => json(route, 200, quote()))
  await page.route('**/api/checkout/session', async (route) => {
    bodies.push(route.request().postData() || '')
    await session(route, bodies.length - 1)
  })
  await page.goto('/robots.txt')
  await page.evaluate(([key, line]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key as string, JSON.stringify([line])) }, [CART_KEY, cartLine()] as const)
  await page.goto('/checkout')
  await expect(page.getByTestId('checkout-total')).toHaveText(/49,00/)
}
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

test.describe('guest session at the checkout, every screen size', () => {
  test('the server asks for a session (428): the page sends the SAME request once more and the customer reaches the payment page', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, (route, index) => (index === 0 ? answer428(route) : answerOk(route)), bodies)
    await expectTouchTarget(page.getByTestId('pay-button'), 'pay button')
    await press(page, page.getByTestId('pay-button'))
    await expect(page.getByRole('heading', { name: 'Stripe (fake)' })).toBeVisible()
    expect(bodies, 'one request, and one repeat').toHaveLength(2)
    expect(bodies[1], 'the repeat is the very same request: same key, same cart, same total').toBe(bodies[0])
    expect(JSON.parse(bodies[0]).checkoutKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(JSON.parse(bodies[0]).expectedTotalCents).toBe(4900)
  })

  test('a browser that keeps no cookies: after the one repeat the page says so, nothing loops, the cart is untouched and the customer can try again', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, answer428, bodies)
    const before = await cartNow(page)
    await press(page, page.getByTestId('pay-button'))
    const error = page.getByTestId('checkout-error')
    await expect(error).toBeVisible()
    await expect(error).toContainText('cookie')
    await expect(error).toContainText('carrello è rimasto')
    await expect(error).toContainText('non è stato addebitato nulla')
    await page.waitForTimeout(1500) // long enough for any further automatic attempt to show up
    expect(bodies, 'exactly two requests, never a third').toHaveLength(2)
    expect(await cartNow(page), 'the cart is exactly as it was').toBe(before)
    // nothing is locked: after enabling cookies the customer presses again
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expectFitsScreen(page, 'cookies refused')
    await expectTouchTarget(page.getByTestId('pay-button'), 'pay button')
    await expectTouchTarget(page.getByRole('link', { name: 'Torna al carrello' }), 'back-to-cart link')
    // and it IS a new, deliberate attempt: two more requests (one repeat), not an endless series
    await press(page, page.getByTestId('pay-button'))
    await expect.poll(() => bodies.length).toBe(4)
    await page.waitForTimeout(800)
    expect(bodies).toHaveLength(4)
    expect(JSON.parse(bodies[3]).checkoutKey, 'the same key: it is the same purchase attempt').toBe(JSON.parse(bodies[0]).checkoutKey)
  })

  test('a browser that says it keeps no cookies is told BEFORE the button: nothing to press, the cart untouched', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, answerOk, bodies, { cookiesOff: true })
    const notice = page.getByTestId('cookies-off')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('cookie')
    await expect(notice).toContainText('carrello non viene toccato')
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    await expect(page.getByTestId('checkout-total'), 'the quote is still shown').toHaveText(/49,00/)
    await expectFitsScreen(page, 'cookies off')
    await expectTouchTarget(page.getByTestId('pay-button'), 'pay button')
    await page.getByTestId('pay-button').click({ force: true, trial: false }).catch(() => undefined)
    await page.waitForTimeout(400)
    expect(bodies, 'a disabled button sends nothing').toHaveLength(0)
    expect(await cartNow(page)).not.toBeNull()
  })

  test('a double tap on "pay" while the repeat is on its way is still ONE payment attempt', async ({ page }) => {
    const bodies: string[] = []
    await openCheckout(page, async (route, index) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return index === 0 ? answer428(route) : answerOk(route)
    }, bodies)
    const pay = page.getByTestId('pay-button')
    await pay.dispatchEvent('click')
    await pay.dispatchEvent('click').catch(() => undefined)
    await pay.dispatchEvent('click').catch(() => undefined)
    await expect(page.getByRole('heading', { name: 'Stripe (fake)' })).toBeVisible()
    expect(bodies, 'one request and its one repeat - the extra taps did nothing').toHaveLength(2)
  })
})
