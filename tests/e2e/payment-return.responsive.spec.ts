// Step 4.4 – the cart after the payment page: what the cart and the checkout do when a payment for THIS cart was already sent to Stripe, on a desktop and on
// phone-sized screens (projects "chromium", "mobile" and "mobile-small" of playwright.config.ts), with several tabs and the browser's back button.
//
// Rules under test (the answers of /api/checkout/* are replaced by fixed ones - context.route - so this tests the PAGES; what the server answers, and to
// whom, is tests/security/cart-after-payment.sec.ts; the journey against a real server with a fake Stripe is tests/real-run/checkout-return.ts):
//   * the cart is emptied only when the SERVER says the payment is verified (`paid`), and only if it is still the cart that was sent to the payment page;
//   * while the payment is being confirmed, or has arrived and waits for a person, the cart STAYS, both pages say so and "pay" is not offered again;
//   * a payment page that was left (`pending`), an order this browser may not see (404: guest cookie absent or expired) or a cart changed since: no notice,
//     the cart is untouched and paying is possible (the server decides, and refuses what must be refused);
//   * the memory lives in localStorage like the cart: another tab sees it, and a tab that is open on the cart follows the others (no old cart written back);
//   * the back button brings the page back with the right state; "pay" writes the memory with the cart that went to the payment page.
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { cartItemsSignature } from '../../lib/checkout-client'

const MIN_TOUCH = 44
const ORDER = 'clorder0000000000000001'
const CART_KEY = 'mwv2:cart'
const PENDING_KEY = 'mw:pending-orders:v2'
const KEY_KEY = 'mw:checkout-key:v1'
const TITLE = 'Vaso del test'

const cartLine = {
  cartItemId: 'ci-return-1', modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title: TITLE, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty: 2, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
}
const SIGNATURE = cartItemsSignature([cartLine as never])

const quote = () => ({
  currency: 'EUR',
  items: [{ title: TITLE, partName: null, qty: 2, material: 'PLA', colors: ['#ffffff'], finish: null, unitPriceCents: 1250, lineTotalCents: 2500, undiscountedLineTotalCents: 2500, discountPercent: 0, leadTimeHours: null }],
  itemsTotalCents: 2500, discountPercent: 0, shipping: { method: 'pickup', cents: 0, label: null },
  shippingOffer: { shipAvailable: false, shipCents: 0, shipLabel: null, shipCountries: [] }, tax: { mode: 'none', ratePercent: 0, cents: 0, addedToTotal: false },
  totalCents: 2500, canCheckout: true, unavailableReason: null,
})
const answer = (state: string) => ({ orderNumber: 12, state, totalCents: 2500, currency: 'EUR', final: ['paid', 'attention', 'canceled'].includes(state), pollAfterMs: state === 'confirming' ? 2500 : null })

// What the server "says" about the order: change it between steps, every tab asks the same one.
type Server = { state: string | 404 | 'down'; asked: string[]; sessions: string[]; session: (route: Route) => Promise<void> | void }
async function install(context: BrowserContext): Promise<Server> {
  const server: Server = {
    state: 'confirming', asked: [], sessions: [],
    session: (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orderId: ORDER, orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_fake', totalCents: 2500 }) }),
  }
  await context.route('**/api/checkout/status**', (route) => {
    server.asked.push(route.request().url())
    if (server.state === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', error: 'Order not found.' }) })
    if (server.state === 'down') return route.abort('failed')
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(server.state)) })
  })
  await context.route('**/api/checkout/quote', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quote()) }))
  await context.route('**/api/checkout/session', async (route) => { server.sessions.push(route.request().postData() || ''); await server.session(route) })
  await context.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  return server
}

// A browser that has a cart and (unless `entry` is null) remembers having sent it to the payment page.
async function seed(page: Page, opts: { cart?: boolean; entry?: { orderId: string; cartSignature: string } | null } = {}) {
  await page.goto('/robots.txt')
  await page.evaluate(([cart, entry, line, cartKey, pendingKey]) => {
    localStorage.clear(); sessionStorage.clear()
    if (cart) localStorage.setItem(cartKey as string, JSON.stringify([line]))
    if (entry) localStorage.setItem(pendingKey as string, JSON.stringify([{ ...(entry as object), at: Date.now() }]))
  }, [opts.cart !== false, opts.entry === undefined ? { orderId: ORDER, cartSignature: SIGNATURE } : opts.entry, cartLine, CART_KEY, PENDING_KEY] as const)
}

const storedCart = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]').length, CART_KEY)
const remembered = (page: Page) => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '[]') as Array<{ orderId: string; cartSignature: string }>), PENDING_KEY)
const rememberedIds = async (page: Page) => (await remembered(page)).map((entry) => entry.orderId)

async function expectFitsScreen(page: Page, label: string) {
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
async function expectTouchTargets(page: Page, selector: string, label: string) {
  const controls = page.locator(selector)
  const count = await controls.count()
  expect(count, `${label}: there are controls to measure`).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    const box = await controls.nth(i).boundingBox()
    if (!box) continue
    expect(box.height, `${label}: control ${i} height`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
  }
}
const cartCheckout = (page: Page) => page.getByRole('link', { name: 'Checkout' }).or(page.getByRole('button', { name: 'Checkout', exact: true })).first()

test.describe('the cart after the payment page: cart, checkout, tabs and the back button', () => {
  // ---- checkout (Italian) ----------------------------------------------------------------------------------------------------------------
  test('checkout, payment being confirmed: the cart stays, a notice says so with the way to the order, "pay" is off, nothing says "not completed"', async ({ page, context }) => {
    const server = await install(context)
    await seed(page)
    await page.goto('/checkout?canceled=1')
    const notice = page.getByTestId('pending-payment-confirming')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Hai un pagamento in conferma per questo carrello')
    await expect(notice).toContainText('MW-00012')
    await expect(notice.getByRole('link', { name: "Controlla lo stato dell'ordine" })).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    await expect(page.getByText('Il pagamento non è stato completato')).toHaveCount(0)
    expect(await storedCart(page), 'being confirmed is not a verified payment: the cart stays').toBe(1)
    expect(await rememberedIds(page)).toEqual([ORDER])
    expect(server.asked[0], 'asked without the "I am back" hint: an unpaid order is plainly unpaid').not.toContain('return=1')
    await expectFitsScreen(page, 'checkout confirming')
    await expectTouchTargets(page, '[data-testid="pending-payment-confirming"] a, [data-testid="pending-payment-confirming"] button', 'notice')
  })

  test('checkout, payment received and waiting for a person: said plainly, the cart stays, "pay" is off', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'attention'
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-attention')).toContainText('Il pagamento di questo carrello è stato ricevuto')
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    expect(await storedCart(page)).toBe(1)
    expect(await rememberedIds(page)).toEqual([ORDER])
  })

  test('checkout, the server says the payment is verified: the cart is emptied, the memory is gone, the confirmation stays on the page', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    await page.goto('/checkout?canceled=1')
    await expect(page.getByTestId('pending-payment-paid')).toBeVisible()
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Pagamento confermato')
    await expect(page.getByRole('heading', { name: 'Il carrello è vuoto' })).toBeVisible()
    await expect.poll(() => storedCart(page)).toBe(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
    await expect(page.getByText('Il pagamento non è stato completato')).toHaveCount(0)
    await expect(page.getByTestId('pending-payment-paid').getByRole('link', { name: "Controlla lo stato dell'ordine" })).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
    await expectFitsScreen(page, 'checkout paid')
  })

  test('checkout, the customer left the payment page without paying: no notice, the cart stays, "pay" works, the usual "not completed" notice', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'pending'
    await seed(page)
    await page.goto('/checkout?canceled=1')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expect(page.getByText('Il pagamento non è stato completato')).toBeVisible()
    await expect(page.locator('[data-testid^="pending-payment-"]')).toHaveCount(0)
    expect(await storedCart(page)).toBe(1)
    expect(await rememberedIds(page), 'still remembered: the payment could yet be completed from another tab').toEqual([ORDER])
  })

  test('checkout, the payment page expired (order closed): no notice, the cart stays, the memory is dropped, "pay" works', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'canceled'
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await storedCart(page)).toBe(1)
  })

  test('checkout, guest cookie absent or expired (the server says "not found"): no notice, nothing guessed, the memory is dropped, the cart stays', async ({ page, context }) => {
    const server = await install(context)
    server.state = 404
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expect(page.locator('[data-testid^="pending-payment-"]')).toHaveCount(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await storedCart(page)).toBe(1)
  })

  test('checkout, the payment is completed on another screen while this tab is out of view: coming back to the tab asks once and shows the result (it does not stay "pay")', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'pending'
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    const setVisibility = (state: 'hidden' | 'visible') => page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
    await setVisibility('hidden')
    server.state = 'paid'
    const before = server.asked.length
    await page.waitForTimeout(300)
    expect(server.asked.length, 'nothing is asked while the tab is out of view').toBe(before)
    await setVisibility('visible')
    await expect(page.getByTestId('pending-payment-paid')).toBeVisible()
    expect(server.asked.length, 'one question on coming back').toBe(before + 1)
    await expect.poll(() => storedCart(page)).toBe(0)
  })

  test('checkout, the status service is down: no notice and no guess; the cart and the memory stay', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'down'
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await page.waitForTimeout(500)
    expect(await storedCart(page)).toBe(1)
    expect(await rememberedIds(page)).toEqual([ORDER])
  })

  test('checkout, the cart changed since it was sent to the payment page: it is another purchase - no notice, the cart is kept, "pay" works', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'confirming'
    await seed(page, { entry: { orderId: ORDER, cartSignature: '[{"modelId":"another cart"}]' } })
    await page.goto('/checkout')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expect(page.locator('[data-testid^="pending-payment-"]')).toHaveCount(0)
    expect(server.asked.length, 'and the other order is not even asked about').toBe(0)
  })

  test('checkout, "pay": the order goes to the memory with the cart that went to the payment page, the repeat-key is shared by the tabs (localStorage)', async ({ page, context }) => {
    const server = await install(context)
    await seed(page, { entry: null })
    await page.goto('/checkout')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(1)
    await page.waitForURL(/checkout\.stripe\.com/)
    // the browser is now on the payment page: what it remembers is read from another tab of the same site
    const probe = await context.newPage()
    await probe.goto('/robots.txt')
    expect((await remembered(probe)).map((entry) => entry.cartSignature)).toEqual([SIGNATURE])
    expect(await rememberedIds(probe)).toEqual([ORDER])
    expect(await probe.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').key?.length > 10, KEY_KEY), 'the key is in localStorage, seen by every tab').toBe(true)
    expect(await probe.evaluate((k) => sessionStorage.getItem(k), KEY_KEY), 'and not in one tab\'s own memory').toBeNull()
    expect(await storedCart(probe), 'sent to the payment page is not paid: the cart stays').toBe(1)
  })

  test('checkout, the server refuses a second payment for the same cart (PAYMENT_IN_PROGRESS): a sentence and the way to the order, then the page follows its state', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'pending'
    server.session = (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'PAYMENT_IN_PROGRESS', error: 'A payment for this cart is already being confirmed.', orderId: ORDER, orderNumber: 12 }) })
    await seed(page, { entry: null })
    await page.goto('/checkout')
    await page.getByTestId('pay-button').click()
    const error = page.getByTestId('checkout-error')
    await expect(error).toContainText('c\'è già un pagamento in conferma o in verifica')
    await expect(error.getByRole('link', { name: "Controlla lo stato dell'ordine" })).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
    await expect.poll(() => rememberedIds(page), { message: 'the order the server named is remembered, so the page can follow it' }).toEqual([ORDER])
    expect(page.url(), 'and the customer is not sent to the payment page').toContain('/checkout')
    server.state = 'confirming'
    await page.reload()
    await expect(page.getByTestId('pending-payment-confirming')).toBeVisible()
    await expect(page.getByTestId('pay-button')).toBeDisabled()
  })

  // ---- cart (English) --------------------------------------------------------------------------------------------------------------------
  test('cart, payment being confirmed: the cart stays, the notice (in English, like the page) leads to the order, Checkout is off', async ({ page, context }) => {
    await install(context)
    await seed(page)
    await page.goto('/cart')
    const notice = page.getByTestId('pending-payment-confirming')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('A payment for this cart is being confirmed')
    await expect(notice.getByRole('link', { name: 'Check the order status' })).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    await expect(page.getByTestId('cart-subtotal')).toBeVisible()
    expect(await storedCart(page)).toBe(1)
    await expectFitsScreen(page, 'cart confirming')
    await expectTouchTargets(page, '[data-testid="pending-payment-confirming"] a, [data-testid="pending-payment-confirming"] button', 'cart notice')
  })

  test('cart, the server says the payment is verified: the cart is emptied and the confirmation stays on the page', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    await page.goto('/cart')
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Payment confirmed')
    await expect(page.getByText('Cart is empty.')).toBeVisible()
    await expect.poll(() => storedCart(page)).toBe(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
  })

  test('cart, not paid / expired / not found / changed cart: no notice, Checkout works, the cart is untouched', async ({ page, context }) => {
    const server = await install(context)
    for (const state of ['pending', 'canceled', 404] as const) {
      server.state = state
      await seed(page)
      await page.goto('/cart')
      await expect(cartCheckout(page)).toBeVisible()
      await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible()
      await expect(page.locator('[data-testid^="pending-payment-"]')).toHaveCount(0)
      expect(await storedCart(page), String(state)).toBe(1)
    }
  })

  // ---- several tabs ----------------------------------------------------------------------------------------------------------------------
  test('two tabs: the payment is verified while both are open on the cart - the tab that notices empties the cart and the other FOLLOWS (it does not write the old cart back)', async ({ page, context }) => {
    const server = await install(context)
    await seed(page)
    await page.goto('/cart')
    const other = await context.newPage()
    await other.goto('/cart')
    for (const tab of [page, other]) await expect(tab.getByTestId('pending-payment-confirming')).toBeVisible()
    // the payment is verified; the first tab asks again
    server.state = 'paid'
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByTestId('pending-payment-paid')).toBeVisible()
    await expect.poll(() => storedCart(page)).toBe(0)
    // the second tab was not touched: it follows
    await expect(other.getByText('Cart is empty.')).toBeVisible()
    await expect(other.locator('[data-testid="pending-payment-confirming"]')).toHaveCount(0)
    await expect.poll(() => rememberedIds(other)).toEqual([])
    // and a later change in that tab does not bring the old cart back
    await other.reload()
    expect(await storedCart(other), 'the paid cart did not come back').toBe(0)
  })

  test('two tabs: one tab sends the order to the payment page, the other (checkout, same cart) learns of it at once and turns "pay" off once the server says it is being confirmed', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'pending'
    await seed(page, { entry: null })
    await page.goto('/checkout')
    const other = await context.newPage()
    await other.goto('/checkout')
    await expect(other.getByTestId('pay-button')).toBeEnabled()
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(1)
    // the other tab hears of the new memory (a `storage` event) and asks about the order: still not paid -> nothing to show
    await expect.poll(() => rememberedIds(other)).toEqual([ORDER])
    server.state = 'confirming'
    await other.reload()
    await expect(other.getByTestId('pending-payment-confirming')).toBeVisible()
    await expect(other.getByTestId('pay-button')).toBeDisabled()
  })

  test('two tabs: a change of the cart in one tab shows up in the other (and an emptied cart stays empty)', async ({ page, context }) => {
    await install(context)
    await seed(page, { entry: null })
    await page.goto('/cart')
    const other = await context.newPage()
    await other.goto('/cart')
    await expect(page.getByText(TITLE).first()).toBeVisible()
    await expect(other.getByText(TITLE).first()).toBeVisible()
    await page.evaluate((key) => localStorage.setItem(key, '[]'), CART_KEY)
    await expect(other.getByText('Cart is empty.')).toBeVisible()
    await other.reload()
    expect(await storedCart(other)).toBe(0)
  })

  // ---- the back button -------------------------------------------------------------------------------------------------------------------
  test('back button: from the order status page back to the checkout, the page shows the real state again (confirming: "pay" off, the cart is there)', async ({ page, context }) => {
    await install(context)
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-confirming')).toBeVisible()
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-confirming')).toBeVisible()
    await expect(page.getByTestId('status-cart-kept')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.getByTestId('pending-payment-confirming')).toBeVisible()
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    expect(await storedCart(page)).toBe(1)
  })

  test('back button: back from the payment page after PAYING (the order is confirmed meanwhile): no "not completed", the cart is emptied', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'pending'
    await seed(page, { entry: null })
    await page.goto('/checkout')
    await page.getByTestId('pay-button').click()
    await page.waitForURL(/checkout\.stripe\.com/)
    // the customer paid at Stripe; the confirmation arrived; the browser's back button returns to the checkout
    server.state = 'paid'
    await page.goBack()
    await expect(page).toHaveURL(/\/checkout/)
    await expect(page.getByTestId('pending-payment-paid')).toBeVisible()
    await expect(page.getByText('Il pagamento non è stato completato')).toHaveCount(0)
    await expect.poll(() => storedCart(page)).toBe(0)
  })
})
