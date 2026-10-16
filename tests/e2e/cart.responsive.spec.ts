// The cart page on a desktop and on phone-sized screens (projects "chromium", "mobile" and "mobile-small" of playwright.config.ts).
// Since step 4.2-ter (A1) the cart shows the SERVER's prices: the same quote the checkout shows and charges. The server's answers are replaced
// by fixed ones (page.route), so this tests the PAGE: that every figure comes from the quote, that the price follows the cart, that Checkout is
// off whenever there is no valid quote, and that nothing sticks out of a small screen. What the server computes is tested by
// tests/security/*.sec.ts; the real flow (real server, fake Stripe) by tests/real-run/checkout-matrix.ts. Needs the app running.
import { expect, test, type Page, type Route } from '@playwright/test'

const MIN_TOUCH = 44 // px, the smallest target a thumb can hit reliably (WCAG 2.5.5 / Apple HIG)
const LONG_TITLE = 'Supporto-per-cuffie-con-nome-lunghissimo-senza-spazi-che-potrebbe-rompere-il-layout-su-uno-schermo-stretto-0123456789'

type Body = { items?: Array<{ qty?: number }>; shipping?: { method?: string }; rush?: boolean }

// A quote that follows the cart it is asked about: 12.50 EUR per piece, so the figure on screen proves it came from THIS answer.
const quoteFor = (body: Body, over: Record<string, unknown> = {}) => {
  const items = (body.items || []).map((item) => {
    const qty = item.qty || 1
    const unit = body.rush ? 1875 : 1250
    return { title: LONG_TITLE, partName: null, qty, material: 'PLA', colors: ['#ffffff'], finish: null, unitPriceCents: unit, lineTotalCents: unit * qty, undiscountedLineTotalCents: unit * qty, discountPercent: 0, leadTimeHours: null }
  })
  const itemsTotalCents = items.reduce((sum, line) => sum + line.lineTotalCents, 0)
  return {
    currency: 'EUR', items, itemsTotalCents, discountPercent: 0,
    shipping: { method: 'pickup', cents: 0, label: null },
    shippingOffer: { shipAvailable: false, shipCents: 0, shipLabel: null, shipCountries: [] },
    tax: { mode: 'none', ratePercent: 0, cents: 0, addedToTotal: false },
    totalCents: itemsTotalCents, canCheckout: true, unavailableReason: null,
    ...over,
  }
}

const cartLine = (qty: number) => ({
  cartItemId: 'ci-cart-test-1', modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title: LONG_TITLE, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})

type Opts = { qty?: number; quoteHandler?: (route: Route, body: Body) => Promise<void> | void; asked?: Body[] }

async function openCart(page: Page, opts: Opts = {}) {
  await page.route('**/api/checkout/quote', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as Body
    opts.asked?.push(body)
    if (opts.quoteHandler) return opts.quoteHandler(route, body)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body)) })
  })
  await page.goto('/robots.txt')
  await page.evaluate(([qty, line]) => {
    localStorage.clear(); sessionStorage.clear()
    localStorage.setItem('mwv2:cart', JSON.stringify([line]))
  }, [opts.qty ?? 2, cartLine(opts.qty ?? 2)] as const)
  await page.goto('/cart')
}

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, label, li, dl'))) {
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
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TOUCH)
}
const press = async (page: Page, locator: ReturnType<Page['locator']>) => { if (await page.evaluate(() => 'ontouchstart' in window)) await locator.tap(); else await locator.click() }
const checkoutControl = (page: Page) => page.getByRole('link', { name: 'Checkout' }).or(page.getByRole('button', { name: 'Checkout', exact: true })).first()

test.describe('cart page, prices from the server, every screen size', () => {
  test('the subtotal and the line total are the server\'s figures, in the currency the server says', async ({ page }) => {
    await openCart(page, { qty: 2 })
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/25[.,]00/)
    await expect(page.getByTestId('cart-line-total')).toContainText(/25[.,]00/)
    await expect(page.getByTestId('cart-subtotal')).toContainText('€')
    await expect(checkoutControl(page)).toBeEnabled()
    await expectFitsScreen(page, 'cart with a quote')
  })

  test('changing the quantity asks the server again and the figure follows (one engine, no local arithmetic)', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, { qty: 2, asked })
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/25[.,]00/)
    await press(page, page.getByRole('button', { name: 'Increase quantity' }))
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/37[.,]50/)
    expect(asked.some((b) => b.items?.[0]?.qty === 3), 'the server was asked about quantity 3').toBe(true)
    await press(page, page.getByRole('button', { name: 'Decrease quantity' }))
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/25[.,]00/)
  })

  // ---- step 4.4: the answers of the server arrive in any order, in any number; the cart shows the one that belongs to the cart on screen ----------------------
  test('an OLD answer that arrives late never replaces a newer one (the response race)', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, {
      qty: 2, asked,
      quoteHandler: async (route, body) => {
        const qty = body.items?.[0]?.qty ?? 0
        // the first question (quantity 2) is answered slowly; the one for quantity 3 at once
        if (qty === 2 && asked.filter((b) => b.items?.[0]?.qty === 2).length === 1) await new Promise((resolve) => setTimeout(resolve, 1800))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body)) })
      },
    })
    // the page has asked about quantity 2 (the slow answer is on its way - the cart waits 350 ms before asking, so wait for the question itself): the customer taps "+"
    await expect.poll(() => asked.length, { message: 'the first question has gone out' }).toBeGreaterThanOrEqual(1)
    await expect(page.getByRole('button', { name: 'Increase quantity' })).toBeVisible()
    await press(page, page.getByRole('button', { name: 'Increase quantity' }))
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/37[.,]50/)
    // the slow answer for quantity 2 arrives now: it must not put 25,00 back
    await page.waitForTimeout(2500)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/37[.,]50/)
    await expect(page.getByTestId('cart-line-total')).toContainText(/37[.,]50/)
    await expect(checkoutControl(page)).toBeEnabled()
  })

  test('quick successive changes: the server is asked about the cart the customer ended up with, not about every tap', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, { qty: 2, asked })
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/25[.,]00/)
    const before = asked.length
    for (let i = 0; i < 4; i++) await press(page, page.getByRole('button', { name: 'Increase quantity' }))
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/75[.,]00/) // 6 pieces
    const questions = asked.slice(before)
    expect(questions.length, `four taps are not four questions (${questions.map((b) => b.items?.[0]?.qty).join(',')})`).toBeLessThanOrEqual(3)
    expect(questions[questions.length - 1].items?.[0]?.qty, 'the last question is about the final cart').toBe(6)
  })

  test('"too many requests": the cart waits as long as the server asked, asks once more, and then shows the figure; Checkout is off meanwhile', async ({ page }) => {
    let calls = 0
    await openCart(page, {
      qty: 2,
      quoteHandler: async (route, body) => {
        calls++
        if (calls === 1) return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '2' }, body: JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED', retryAfterSeconds: 2 }) })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body)) })
      },
    })
    await expect(page.getByTestId('cart-quote-error')).toBeVisible()
    await expect(page.getByTestId('cart-subtotal')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/25[.,]00/, { timeout: 10_000 })
    await expect(checkoutControl(page)).toBeEnabled()
    expect(calls, 'one question, the pause the server asked for, one more').toBe(2)
  })

  test('rush production changes the figure only through the server', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, { qty: 2, asked })
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/25[.,]00/)
    await press(page, page.getByLabel('Rush production'))
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/37[.,]50/)
    expect(asked.some((b) => b.rush === true)).toBe(true)
  })

  test('while the server has not answered there is no figure and Checkout is off; when it answers, Checkout turns on', async ({ page }) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    await openCart(page, {
      quoteHandler: async (route, body) => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body)) }) },
    })
    await expect(page.getByTestId('cart-subtotal-state')).toBeVisible()
    await expect(page.getByTestId('cart-subtotal')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    release()
    await expect(page.getByTestId('cart-subtotal')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible()
  })

  test('an item the server cannot price: the line is marked, there is no figure, Checkout is off', async ({ page }) => {
    await openCart(page, {
      quoteHandler: (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'This item cannot be priced right now.', code: 'ITEM_NOT_PRICEABLE', details: { itemIndex: 0 } }) }),
    })
    await expect(page.getByTestId('cart-quote-error')).toBeVisible()
    await expect(page.getByTestId('cart-line-total')).toContainText(/not available|unavailable/i)
    await expect(page.getByTestId('cart-subtotal')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    await expectFitsScreen(page, 'cart with a line the server refused')
  })

  test('the server is temporarily unavailable: a clear message, no figure, Checkout off, a retry button that works', async ({ page }) => {
    let fail = true
    await openCart(page, {
      quoteHandler: async (route, body) => {
        if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporarily unavailable', code: 'TEMPORARY_ERROR' }) })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body)) })
      },
    })
    const notice = page.getByTestId('cart-quote-error')
    await expect(notice).toBeVisible()
    await expect(page.getByTestId('cart-subtotal')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    await expectFitsScreen(page, 'cart with a failed quote')
    fail = false
    const retry = notice.getByRole('button')
    await expectTouchTarget(retry, 'retry button')
    await press(page, retry)
    await expect(page.getByTestId('cart-subtotal')).toBeVisible()
    await expect(notice).toHaveCount(0)
  })

  test('a line the shop cannot make automatically: reasons per line, no figure, Checkout off, and a manual-quote form that works on every screen', async ({ page }) => {
    const sent: any[] = []
    await page.route('**/api/checkout/manual-request', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      sent.push(body)
      if (!body.contact?.email) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'EMAIL_REQUIRED', error: 'An email address is needed' }) })
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, orderNumber: 7, created: true }) })
    })
    await openCart(page, {
      quoteHandler: (route) => route.fulfill({
        status: 422, contentType: 'application/json',
        body: JSON.stringify({
          error: 'This cart needs a manual review before it can be paid online.', code: 'MANUAL_REVIEW_REQUIRED',
          details: { itemIndexes: [0], reviews: [{ itemIndex: 0, reasons: [{ code: 'TOO_LARGE', sizeMm: { x: 250, y: 120, z: 90 }, usableMm: { x: 168, y: 168, z: 178 } }, { code: 'MATERIAL_NOT_AVAILABLE', value: 'ABS' }] }] },
        }),
      }),
    })
    const form = page.getByTestId('manual-quote')
    await expect(form).toBeVisible()
    await expect(page.getByTestId('manual-quote-reasons')).toContainText('250 × 120 × 90 mm')
    await expect(page.getByTestId('manual-quote-reasons')).toContainText('ABS')
    await expect(page.getByTestId('cart-subtotal')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    await expectFitsScreen(page, 'cart with the manual-quote form')
    await expectTouchTarget(page.getByTestId('manual-quote-email'), 'email field')
    await expectTouchTarget(page.getByTestId('manual-quote-send'), 'send button')
    // a guest who forgets the email is told so, and nothing is lost
    await press(page, page.getByTestId('manual-quote-send'))
    await expect(page.getByTestId('manual-quote-error')).toContainText(/email/i)
    await page.getByTestId('manual-quote-email').fill('guest@example.test')
    await press(page, page.getByTestId('manual-quote-send'))
    await expect(page.getByTestId('manual-quote-sent')).toContainText('MW-00007')
    await expectFitsScreen(page, 'cart after the request was sent')
    // what was sent: the cart and the contact, never a price
    const last = sent.at(-1)
    expect(last.contact).toEqual({ email: 'guest@example.test' })
    expect(last.items[0].qty).toBe(2)
    expect(JSON.stringify(last)).not.toMatch(/totalCents|unitPrice|paymentStatus/)
  })

  test('below the minimum order the server says so, the message carries the amounts and Checkout is off', async ({ page }) => {
    await openCart(page, {
      quoteHandler: (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Minimum order not reached', code: 'MINIMUM_ORDER', details: { minimumCents: 3000, itemsTotalCents: 2500, currency: 'EUR' } }) }),
    })
    const notice = page.getByTestId('cart-quote-error')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(/30[.,]00/)
    await expect(notice).toContainText(/25[.,]00/)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
  })

  test('canCheckout=false from the server (online payment off): no figure treated as payable, Checkout off', async ({ page }) => {
    await openCart(page, {
      quoteHandler: (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body, { canCheckout: false, unavailableReason: 'CHECKOUT_DISABLED' })) }),
    })
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
  })

  test('layout: nothing sticks out of the screen and every control is a comfortable target', async ({ page }) => {
    await openCart(page, { qty: 2 })
    await expect(page.getByTestId('cart-subtotal')).toBeVisible()
    await expectFitsScreen(page, 'cart')
    await expectTouchTarget(page.getByRole('button', { name: 'Increase quantity' }), 'quantity +')
    await expectTouchTarget(page.getByRole('button', { name: 'Decrease quantity' }), 'quantity -')
    await expectTouchTarget(page.getByRole('button', { name: 'Remove' }), 'Remove')
    await expectTouchTarget(page.getByRole('button', { name: 'Clear cart' }), 'Clear cart')
    await expectTouchTarget(page.locator('label', { hasText: 'Rush production' }), 'Rush production row')
    await expectTouchTarget(checkoutControl(page), 'Checkout')
  })
})
