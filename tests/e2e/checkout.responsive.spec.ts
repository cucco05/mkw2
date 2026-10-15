// The checkout page on a desktop and on phone-sized screens (projects "chromium", "mobile" and "mobile-small" of playwright.config.ts).
// The server's answers are replaced by fixed ones (page.route), so this tests the PAGE: layout, touch targets, keyboard, double click,
// error states. What the server does with a cart is tested by tests/security/*.sec.ts; the real flow with a fake Stripe by the
// real-server run described in docs/CHECKOUT-S2-S3.md. Needs the app running (E2E_BASE_URL or `npm run dev`), nothing else.
import { expect, test, type Page, type Route } from '@playwright/test'

const MIN_TOUCH = 44 // px, the smallest target a thumb can hit reliably (WCAG 2.5.5 / Apple HIG)
const LONG_TITLE = 'Supporto-per-cuffie-con-nome-lunghissimo-senza-spazi-che-potrebbe-rompere-il-layout-su-uno-schermo-stretto-0123456789'

const quote = (over: Record<string, unknown> = {}) => ({
  currency: 'EUR',
  items: [
    { title: LONG_TITLE, partName: 'Parte-uno-con-un-nome-molto-lungo-senza-spazi-per-verificare-che-vada-a-capo', qty: 2, material: 'PLA', colors: ['#ffffff', '#ff0000'], finish: 'matte', unitPriceCents: 2450, lineTotalCents: 4900, undiscountedLineTotalCents: 5200, discountPercent: 5, leadTimeHours: 6.5 },
    { title: 'Lampada', partName: null, qty: 1, material: 'PETG', colors: ['Nero'], finish: null, unitPriceCents: 9000, lineTotalCents: 9000, undiscountedLineTotalCents: 9000, discountPercent: 0, leadTimeHours: null },
  ],
  itemsTotalCents: 13900, discountPercent: 5,
  shipping: { method: 'pickup', cents: 0, label: null },
  shippingOffer: { shipAvailable: true, shipCents: 700, shipLabel: 'Spedizione in Italia', shipCountries: ['IT'] },
  tax: { mode: 'inclusive', ratePercent: 22, cents: 2506, addedToTotal: false },
  totalCents: 13900, canCheckout: true, unavailableReason: null,
  ...over,
})
const shipQuote = () => quote({ shipping: { method: 'ship', cents: 700, label: 'Spedizione in Italia' }, totalCents: 14600, tax: { mode: 'inclusive', ratePercent: 22, cents: 2633, addedToTotal: false } })

const cartLine = (title: string) => ({
  cartItemId: `ci-${title.length}`, modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty: 2, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})

async function openCheckout(page: Page, opts: { cart?: boolean; quoteHandler?: (route: Route) => Promise<void> | void; sessions?: string[] } = {}) {
  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  await page.route('**/api/checkout/quote', opts.quoteHandler ?? ((route) => {
    const method = JSON.parse(route.request().postData() || '{}')?.shipping?.method
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(method === 'ship' ? shipQuote() : quote()) })
  }))
  await page.route('**/api/checkout/session', async (route) => {
    opts.sessions?.push(route.request().postData() || '')
    await new Promise((resolve) => setTimeout(resolve, 400)) // slow enough for a second tap to arrive
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orderId: 'clorder0000000000000001', orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_fake', totalCents: 13900 }) })
  })
  await page.goto('/robots.txt')
  await page.evaluate(([cart, title]) => {
    localStorage.clear(); sessionStorage.clear()
    if (cart) localStorage.setItem('mwv2:cart', JSON.stringify([title]))
  }, [opts.cart !== false, cartLine(LONG_TITLE)] as const)
  await page.goto('/checkout')
}

// No sideways scrolling: the page is never wider than the screen, and nothing inside sticks out of it.
async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, label, li, dl, fieldset'))) {
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
const press = async (page: Page, locator: ReturnType<Page['locator']>) => { if (page.context().browser() && (await page.evaluate(() => 'ontouchstart' in window))) await locator.tap(); else await locator.click() }

test.describe('checkout page, every screen size', () => {
  test('empty cart: a message and two ways out, nothing sticking out', async ({ page }) => {
    await openCheckout(page, { cart: false })
    await expect(page.getByRole('heading', { name: 'Il carrello è vuoto' })).toBeVisible()
    await expectFitsScreen(page, 'empty cart')
    await expectTouchTarget(page.getByRole('link', { name: 'Vai al negozio' }), 'link to the shop')
  })

  test('a visitor who is not signed in finds the Cart link in the navigation (menu on a phone, sidebar on a desktop)', async ({ page, isMobile }) => {
    await page.goto('/login')
    if (isMobile) {
      const burger = page.locator('button[aria-label="Toggle navigation menu"]')
      await expect(burger).toBeVisible()
      await page.waitForTimeout(800) // the menu only opens once the page has been hydrated
      await burger.click()
      await expect(page.locator('#app-mobile-nav-menu a[href="/cart"]')).toBeVisible()
      await expectTouchTarget(page.locator('#app-mobile-nav-menu a[href="/cart"]'), 'menu link to the cart')
    } else {
      await expect(page.locator('nav[aria-label="Main navigation"] a[href="/cart"]')).toBeVisible()
    }
  })

  test('quote shown: fits the screen, long names wrap, targets are thumb-sized, the total is the server\'s', async ({ page }) => {
    await openCheckout(page)
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
    await expectFitsScreen(page, 'quote')
    await expectTouchTarget(page.getByTestId('pay-button'), 'pay button')
    for (const id of ['delivery-pickup', 'delivery-ship']) await expectTouchTarget(page.locator(`label[for=${id}]`), id)
    const viewport = page.viewportSize()!
    const pay = (await page.getByTestId('pay-button').boundingBox())!
    expect(pay.x).toBeGreaterThanOrEqual(0)
    expect(pay.x + pay.width).toBeLessThanOrEqual(viewport.width)
    await expect(page.getByTestId('pay-button')).toContainText('139,00')
    await expectTouchTarget(page.getByRole('link', { name: 'Torna al carrello' }), 'back-to-cart link')
  })

  test('delivery choice: one tap, the new total, still fits', async ({ page }) => {
    await openCheckout(page)
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
    await press(page, page.locator('label[for=delivery-ship]'))
    await expect(page.getByTestId('checkout-total')).toHaveText(/146,00/)
    await expectFitsScreen(page, 'with shipping')
    await press(page, page.locator('label[for=delivery-pickup]'))
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
  })

  test('keyboard: the radio buttons and the pay button can be reached and used without a mouse', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'keyboard navigation is a desktop (and external keyboard) concern')
    const sessions: string[] = []
    await openCheckout(page, { sessions })
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
    await page.getByTestId('delivery-pickup').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('delivery-ship')).toBeChecked()
    await expect(page.getByTestId('checkout-total')).toHaveText(/146,00/)
    await page.getByTestId('pay-button').focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(/checkout\.stripe\.com/)
    expect(sessions).toHaveLength(1)
    expect(JSON.parse(sessions[0]).shipping).toEqual({ method: 'ship' })
  })

  test('pay: three taps in the same instant send one request and the browser goes to Stripe\'s page', async ({ page }) => {
    const sessions: string[] = []
    await openCheckout(page, { sessions })
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
    await page.evaluate(() => { const b = document.querySelector<HTMLButtonElement>('[data-testid=pay-button]')!; b.click(); b.click(); b.click() })
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    await page.waitForURL(/checkout\.stripe\.com/)
    expect(sessions).toHaveLength(1)
    const sent = JSON.parse(sessions[0])
    expect(sent.expectedTotalCents).toBe(13900)
    expect(sent.checkoutKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(JSON.stringify(sent)).not.toMatch(/priceMultiplier/)
  })

  test('errors: a refused line, "too many requests" and a lost quote each fit the screen and offer a next step', async ({ page }) => {
    await openCheckout(page, {
      quoteHandler: (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'ITEM_UNAVAILABLE', details: { itemIndexes: [0] } }) }),
    })
    const error = page.getByTestId('checkout-error')
    await expect(error).toContainText('non sono più disponibili')
    await expectFitsScreen(page, 'refused line')
    await expectTouchTarget(page.getByRole('button', { name: 'Rimuovi gli articoli non disponibili' }), 'remove button')
    await expectTouchTarget(page.getByRole('link', { name: 'Modifica nel carrello' }), 'cart link')
    await expect(page.getByTestId('pay-button')).toBeDisabled()

    await page.unroute('**/api/checkout/quote')
    await page.route('**/api/checkout/quote', (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }))
    await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('mwv2:cart')!); c[0].options.qty = 9; localStorage.setItem('mwv2:cart', JSON.stringify(c)) })
    await page.reload()
    await expect(page.getByTestId('checkout-error')).toContainText('non risponde')
    await expectFitsScreen(page, 'server error')
    await expectTouchTarget(page.getByRole('button', { name: 'Riprova' }), 'retry button')
  })

  test('failures never touch the saved cart: lost connection, payment service down, a price that moved, a quote that cannot be had', async ({ page }) => {
    await openCheckout(page)
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
    const savedCart = () => page.evaluate(() => localStorage.getItem('mwv2:cart'))
    const before = await savedCart() // as the cart itself stores it once it has read it
    expect(before).toContain('Supporto-per-cuffie')
    const pay = page.getByTestId('pay-button')
    const failWith = async (handler: (route: Route) => Promise<void> | void, expectedText: RegExp, payStaysOpen = true) => {
      await page.unroute('**/api/checkout/session')
      await page.route('**/api/checkout/session', handler)
      await pay.click()
      await expect(page.getByTestId('checkout-error')).toContainText(expectedText)
      // an article that can not be sold keeps the button off until it is removed; every other failure gives it back
      if (payStaysOpen) await expect(pay).toBeEnabled()
      else await expect(pay).toBeDisabled()
      expect(await savedCart(), `after "${expectedText}" the cart is as it was`).toBe(before)
    }
    await failWith((route) => route.abort('failed'), /collegarci/)
    await failWith((route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'TEMPORARY_ERROR', retry: true }) }), /servizio di pagamento/)
    await failWith((route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'PRICE_CHANGED', currentTotalCents: 15000, currency: 'EUR' }) }), /prezzo è cambiato/)
    await failWith((route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'ITEM_UNAVAILABLE', details: { itemIndexes: [0] } }) }), /non sono più disponibili/, false)
    // and a quote that cannot be had at all
    await page.unroute('**/api/checkout/quote')
    await page.route('**/api/checkout/quote', (route) => route.abort('failed'))
    await page.reload()
    await expect(page.getByTestId('checkout-error')).toContainText('collegarci')
    expect(await savedCart()).toBe(before)
  })

  test('back from Stripe\'s "cancel" link: the notice is shown and fits', async ({ page }) => {
    await openCheckout(page)
    await page.goto('/checkout?canceled=1')
    await expect(page.getByText('Hai interrotto il pagamento')).toBeVisible()
    await expect(page.getByTestId('checkout-total')).toHaveText(/139,00/)
    await expectFitsScreen(page, 'cancelled notice')
  })
})
