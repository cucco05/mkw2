// The page Stripe sends the customer back to (/checkout/success), on a desktop and on phone-sized screens (projects "chromium", "mobile" and
// "mobile-small" of playwright.config.ts). The answers of /api/checkout/status are replaced by fixed ones (page.route) and the page's clock is
// controlled (page.clock), so this tests the PAGE: what it shows for each state, that it never says "paid" on its own, how often it asks and when it
// stops, when it empties the cart, layout and touch targets. What the server answers, and to whom, is tested by tests/security/*.sec.ts; the whole
// journey against a real server with a fake Stripe by tests/real-run/checkout-return.ts. Needs the app running (E2E_BASE_URL or `npm run dev`).
import { expect, test, type Page, type Route } from '@playwright/test'
import { cartItemsSignature } from '../../lib/checkout-client'

const MIN_TOUCH = 44
const ORDER = 'clorder0000000000000001'
const CART_KEY = 'mwv2:cart'
const PENDING_KEY = 'mw:pending-orders:v2' // localStorage, shared by every tab: the orders this browser sent to the payment page, each with the cart that went

const answer = (state: string, over: Record<string, unknown> = {}) => ({
  orderNumber: 12, state, totalCents: 1234, currency: 'EUR', final: ['paid', 'attention', 'canceled'].includes(state), pollAfterMs: state === 'confirming' ? 2500 : null, ...over,
})
export const cartLine = { cartItemId: 'ci-1', modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title: 'Vaso', priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 }, colorSlotCount: 1, allowedColors: null, options: { qty: 1, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null } }

const CART_SIGNATURE = cartItemsSignature([cartLine as never])

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; abort?: boolean }
// `marker`: the order this browser sent to the payment page (null: none); `signature`: the cart that was sent (default: the cart in the browser)
type Opts = { replies: Reply[]; last?: Reply; marker?: string | null; signature?: string; cart?: boolean; address?: string; clock?: boolean }

async function openSuccess(page: Page, opts: Opts) {
  const asked: string[] = []
  const others: string[] = []
  await page.route('**/api/checkout/status**', async (route: Route) => {
    const index = asked.length
    asked.push(route.request().url())
    const reply = opts.replies[index] ?? opts.last ?? opts.replies[opts.replies.length - 1]
    if (reply.abort) return route.abort('failed')
    return route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', headers: reply.headers, body: JSON.stringify(reply.body ?? null) })
  })
  // nothing else of the checkout may be asked, and nothing may leave for another site
  const origin = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').origin
  page.on('request', (request) => {
    if (/^(data|blob):/.test(request.url())) return
    const url = new URL(request.url())
    if (url.origin !== origin) others.push(request.url())
    if (/\/api\/checkout\//.test(url.pathname) && !/\/api\/checkout\/status$/.test(url.pathname)) others.push(request.url())
  })
  await page.goto('/robots.txt')
  await page.evaluate(([cart, marker, line, cartKey, pendingKey, signature]) => {
    localStorage.clear(); sessionStorage.clear()
    if (cart) localStorage.setItem(cartKey as string, JSON.stringify([line]))
    if (marker) localStorage.setItem(pendingKey as string, JSON.stringify([{ orderId: marker, cartSignature: signature, at: Date.now() }]))
  }, [opts.cart !== false, opts.marker === undefined ? ORDER : opts.marker, cartLine, CART_KEY, PENDING_KEY, opts.signature ?? CART_SIGNATURE] as const)
  // the page's clock stands still until the test moves it: nothing happens by chance while the test is looking at the page
  if (opts.clock) { await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 60_000)) }
  await page.goto(opts.address ?? `/checkout/success?order=${ORDER}`)
  return { asked, others }
}

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, dl, section'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
async function expectTouchTargets(page: Page, label: string) {
  const controls = page.locator('[data-testid^="status-"] a, [data-testid^="status-"] button')
  const count = await controls.count()
  for (let i = 0; i < count; i++) {
    const box = await controls.nth(i).boundingBox()
    if (!box) continue
    expect(box.height, `${label}: control ${i} (${(await controls.nth(i).textContent())?.trim().slice(0, 30)}) height`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
  }
}
const storedCart = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]').length, CART_KEY)
// the orders remembered as sent to the payment page
const remembered = (page: Page) => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '[]') as Array<{ orderId: string }>).map((entry) => entry.orderId), PENDING_KEY)

// moves the page's clock forward in small steps until the page has asked `count` times (the next question is only scheduled after the answer arrives)
async function advanceUntilAsked(page: Page, asked: string[], count: number, stepMs = 1000, limit = 60) {
  for (let i = 0; i < limit && asked.length < count; i++) {
    await page.clock.runFor(stepMs)
    await page.waitForTimeout(15)
  }
}

test.describe('return page /checkout/success, every screen size', () => {
  test('paid: the page asks once ("I am back"), shows the number and total, empties the cart of THIS order, stops asking', async ({ page }) => {
    const { asked, others } = await openSuccess(page, { replies: [{ body: answer('paid') }] })
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pagamento ricevuto' })).toBeVisible()
    await expect(page.getByTestId('status-order-number')).toHaveText('MW-00012')
    await expect(page.getByTestId('status-total')).toContainText(/12[.,]34/)
    await expect(page.getByTestId('status-total')).toContainText('€')
    await expect(page.getByText(/Conserva il numero d'ordine/).first()).toBeVisible()
    expect(asked[0]).toContain(`/api/checkout/status?order=${ORDER}&return=1`)
    await expect.poll(() => storedCart(page), { message: 'the server verified the payment: the cart is emptied' }).toBe(0)
    await expect.poll(() => remembered(page)).toEqual([])
    await page.waitForTimeout(3500)
    expect(asked.length, 'a final answer is not asked about again').toBe(1)
    expect(others, 'nothing else of the checkout, nothing to other sites').toEqual([])
    await expectFitsScreen(page, 'paid')
    await expectTouchTargets(page, 'paid')
  })

  test('an address opened by hand (no memory of sending this order to the payment page): the cart is left alone', async ({ page }) => {
    await openSuccess(page, { replies: [{ body: answer('paid') }], marker: null })
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await page.waitForTimeout(400)
    expect(await storedCart(page)).toBe(1)
    // and the memory of ANOTHER order does not empty it either
    await openSuccess(page, { replies: [{ body: answer('paid') }], marker: 'clorder0000000000000002' })
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await page.waitForTimeout(400)
    expect(await storedCart(page)).toBe(1)
    expect(await remembered(page)).toEqual(['clorder0000000000000002'])
  })

  test('paid, but the cart is no longer the one that was sent to the payment page (changed since): the NEW cart is kept, the old order is forgotten', async ({ page }) => {
    await openSuccess(page, { replies: [{ body: answer('paid') }], signature: '[{"modelId":"another cart"}]' })
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await expect.poll(() => remembered(page)).toEqual([])
    expect(await storedCart(page), 'a cart the customer composed after paying is not touched').toBe(1)
  })

  test('being confirmed: it says so (not "paid"), asks again after growing pauses, shows the result when it arrives and then stops', async ({ page }) => {
    const { asked } = await openSuccess(page, { replies: [{ body: answer('confirming') }, { body: answer('confirming') }, { body: answer('paid') }], clock: true })
    await expect(page.getByTestId('status-confirming')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Stiamo confermando il pagamento' })).toBeVisible()
    await expect(page.getByText('Pagamento ricevuto')).toHaveCount(0)
    // being confirmed is NOT a confirmed payment: the cart stays, the memory of the order stays, and the page says why
    await page.waitForTimeout(300)
    expect(await storedCart(page), 'the cart stays while the payment is only being confirmed').toBe(1)
    expect(await remembered(page)).toEqual([ORDER])
    await expect(page.getByTestId('status-cart-kept')).toContainText('resta salvato')
    await expectFitsScreen(page, 'confirming')
    await advanceUntilAsked(page, asked, 3)
    await expect(page.getByTestId('status-paid')).toBeVisible()
    expect(asked.length).toBe(3)
    await expect.poll(() => storedCart(page), { message: 'and when the server says paid, the cart is emptied' }).toBe(0)
    await expect.poll(() => remembered(page)).toEqual([])
    await page.clock.runFor(120_000)
    await page.waitForTimeout(100)
    expect(asked.length, 'after the final answer nothing more is asked').toBe(3)
  })

  test('the screen reader is told when the state changes: one polite live region holds the title and the message', async ({ page }) => {
    const { asked } = await openSuccess(page, { replies: [{ body: answer('confirming') }, { body: answer('paid') }], clock: true })
    const live = page.locator('[data-testid^="status-"] [role=status][aria-live=polite][aria-atomic=true]')
    await expect(live).toHaveCount(1)
    await expect(live).toContainText('Stiamo confermando il pagamento')
    await advanceUntilAsked(page, asked, 2)
    await expect(live).toContainText('Pagamento ricevuto')
  })

  test('a confirmation that never comes: the page stops by itself after a fixed number of questions, says it can be closed, and only a person asks again', async ({ page }) => {
    const { asked } = await openSuccess(page, { replies: [{ body: answer('confirming') }], clock: true })
    await expect(page.getByTestId('status-confirming')).toBeVisible()
    await advanceUntilAsked(page, asked, 13, 1000, 200)
    await expect(page.getByTestId('status-gave-up')).toBeVisible()
    const total = asked.length
    expect(total, 'one question on arrival and a small, fixed number of repeats').toBe(13)
    await page.clock.runFor(600_000)
    await page.waitForTimeout(100)
    expect(asked.length, 'it does not keep asking in a forgotten tab').toBe(total)
    await expectFitsScreen(page, 'gave up')
    const again = page.getByRole('button', { name: 'Controlla di nuovo' })
    await expect(again).toBeVisible()
    const box = await again.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    await again.click()
    await expect.poll(() => asked.length).toBe(total + 1)
  })

  test('a hidden tab is not asked about; coming back asks once, at once', async ({ page }) => {
    const { asked } = await openSuccess(page, { replies: [{ body: answer('confirming') }], clock: true })
    await expect(page.getByTestId('status-confirming')).toBeVisible()
    expect(asked.length).toBeGreaterThanOrEqual(1)
    const setVisibility = (state: 'hidden' | 'visible') => page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
    await setVisibility('hidden')
    const whenHidden = asked.length
    await page.clock.runFor(90_000)
    await page.waitForTimeout(100)
    expect(asked.length, 'nothing is asked while the tab is hidden').toBe(whenHidden)
    await setVisibility('visible')
    await expect.poll(() => asked.length).toBe(whenHidden + 1)
  })

  test('"too many requests": the page waits as long as the server asked, then asks again', async ({ page }) => {
    const { asked } = await openSuccess(page, { replies: [{ status: 429, body: { code: 'RATE_LIMITED', retryAfterSeconds: 20 }, headers: { 'Retry-After': '20' } }, { body: answer('paid') }], clock: true })
    await expect(page.getByTestId('status-error')).toBeVisible()
    await page.clock.runFor(10_000)
    await page.waitForTimeout(100)
    expect(asked.length, 'not before the pause the server asked for').toBe(1)
    await advanceUntilAsked(page, asked, 2, 5000, 10)
    await expect(page.getByTestId('status-paid')).toBeVisible()
  })

  test('not reachable: it does not say the payment failed, retries by itself and has a button', async ({ page }) => {
    const { asked } = await openSuccess(page, { replies: [{ abort: true }, { abort: true }, { body: answer('paid') }], clock: true })
    const box = page.getByTestId('status-error')
    await expect(box).toBeVisible()
    await expect(box).toContainText('Questo non significa che il pagamento non sia andato a buon fine')
    await expect(box.locator('[role=alert]')).toHaveCount(1)
    await expect(page.getByText(/fallit/i)).toHaveCount(0)
    await expect(page.getByText('Pagamento ricevuto')).toHaveCount(0)
    await expectFitsScreen(page, 'error')
    const retry = page.getByRole('button', { name: 'Riprova' })
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    await retry.click()
    await expect.poll(() => asked.length).toBeGreaterThanOrEqual(2)
    await advanceUntilAsked(page, asked, 3, 1000, 30)
    await expect(page.getByTestId('status-paid')).toBeVisible()
  })

  test('a server error page or a strange answer is an error, never a state', async ({ page }) => {
    await openSuccess(page, { replies: [{ status: 200, body: { state: 'paid' } }], last: { status: 502, body: null } })
    await expect(page.getByTestId('status-error')).toBeVisible()
    await expect(page.getByTestId('status-paid')).toHaveCount(0)
  })

  test('an order that is not this browser\'s (or does not exist, or the address is damaged) is shown in the same neutral words, with no number and no amount', async ({ page }) => {
    for (const address of [`/checkout/success?order=${ORDER}`, '/checkout/success?order=../../etc/passwd', '/checkout/success', '/checkout/success?order=']) {
      const { asked } = await openSuccess(page, { replies: [{ status: 404, body: { code: 'NOT_FOUND', error: 'Order not found.' } }], address })
      const box = page.getByTestId('status-unknown')
      await expect(box).toBeVisible()
      await expect(box).toContainText('Non possiamo mostrare questo ordine da qui')
      await expect(box).toContainText('verificheremo la tua identità')
      await expect(box).not.toContainText(/MW-\d|€|Pagamento ricevuto/)
      if (address.endsWith(ORDER)) expect(asked.length).toBe(1)
      else expect(asked.length, 'an impossible address is not even asked about').toBe(0)
      expect(await storedCart(page), 'the cart is untouched').toBe(1)
    }
    await expectFitsScreen(page, 'unknown')
    await expectTouchTargets(page, 'unknown')
  })

  test('not paid / closed / under review: each has its own words and the right way forward', async ({ page }) => {
    await openSuccess(page, { replies: [{ body: answer('pending') }], marker: ORDER })
    await expect(page.getByTestId('status-pending')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Riprendi il pagamento' })).toHaveAttribute('href', '/checkout')
    await expect(page.getByRole('link', { name: 'Torna al carrello' })).toHaveAttribute('href', '/cart')
    expect(await storedCart(page), 'not paid: the cart stays').toBe(1)
    await expectFitsScreen(page, 'pending')
    await expectTouchTargets(page, 'pending')

    await openSuccess(page, { replies: [{ body: answer('canceled') }], marker: ORDER })
    await expect(page.getByTestId('status-canceled')).toBeVisible()
    await expect(page.getByText('senza alcun addebito')).toBeVisible()
    expect(await storedCart(page), 'expired payment page: the cart stays').toBe(1)
    await expect.poll(() => remembered(page)).toEqual([])

    await openSuccess(page, { replies: [{ body: answer('attention') }], marker: ORDER })
    await expect(page.getByTestId('status-attention')).toBeVisible()
    await expect(page.getByText('Non devi fare nulla')).toBeVisible()
    await page.waitForTimeout(300)
    expect(await storedCart(page), 'received but under check: not a verified payment, the cart stays').toBe(1)
    expect(await remembered(page)).toEqual([ORDER])
    await expect(page.getByTestId('status-cart-kept')).toBeVisible()
    await expectFitsScreen(page, 'attention')
  })

  test('the page shows only what it needs: no payment identifiers, e-mail, names or addresses, however the answer is stuffed', async ({ page }) => {
    await openSuccess(page, { replies: [{ body: { ...answer('paid'), stripeSessionId: 'cs_test_SECRET', paymentIntent: 'pi_SECRET', email: 'cliente@example.test', shippingAddress: 'Via Roma 1', customerName: 'Mario Rossi' } }] })
    await expect(page.getByTestId('status-paid')).toBeVisible()
    const html = await page.content()
    expect(html).not.toMatch(/cs_test_SECRET|pi_SECRET|cliente@example\.test|Via Roma|Mario Rossi/)
  })

  test('the page keeps the order id out of search engines and other sites', async ({ page }) => {
    await openSuccess(page, { replies: [{ body: answer('paid') }] })
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/)
    await expect(page.locator('meta[name=referrer]')).toHaveAttribute('content', 'no-referrer')
  })
})
