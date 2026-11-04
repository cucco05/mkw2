// R1-2 / S-11 – the REAL HostedCheckout, mounted by the REAL React 19 in a real browser, when something nobody expected goes wrong while "pay" is pressed.
//
// The rules (A-I of the mandate), as the customer meets them:
//   * the button is never left busy for ever: whatever happens it ends given back, or held (not busy, off, with the reason), or on its way out of the page;
//   * "nothing was sent" is said only when the request had never been started; after an error that may have followed a request the sentence knows nothing, says where to look first, and the
//     button is HELD - it is not given back, and the customer is offered the order and a reload (the key of the purchase stays in the browser: a later press is the same purchase);
//   * nothing is sent by itself, the key is never forgotten or made again because of an error, an order the server named is not lost because the browser could not write it down, and a page that
//     is gone neither shows nor redirects;
//   * the results hold on the development build of React (Strict Mode: components and effects run twice) and on the production build, and with the updates of React queued behind a stopped scheduler.
// What this file is, and is not: the page is a HARNESS (tests/e2e/_checkout-harness.tsx) - the real component and the real libraries, but no server, no CSS, no router (`next/link` is an anchor), and
// the browser's way to LEAVE the page is recorded instead of taken. The answers of /api/checkout/* are stubbed, like in the other specs of R1-2. So it says nothing about layout or touch targets
// (the pages are checked for those, on the real site, by the specs that need the server), and it does not replace them. Two scenarios (marked "lost answer") use a build in which ONLY sendPurchase
// can be told to lose its answer, because in the real module no error can come out of the turn once the request has started - see tests/e2e/_single-flight-fault-shim.ts.
// The real sendPurchase, with a model of the lock service, is tried without a browser in tests/checkout-single-flight-faults.test.ts.
import { expect, test, type Page } from '@playwright/test'
import { FROZEN_SCHEDULER_SCRIPT } from './_cart-harness-build'
import { buildCheckoutHarness, type HarnessVariant } from './_checkout-harness-build'
import { KEY_KEY, ORDER, PENDING_KEY, cartLine, collectProblems, install, locksGateScript, rawMemory, slotEntry, spyScript, type Server } from './_checkout-pages'

const ORIGIN = 'http://localhost:4173'
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_test_fake'
type Mode = 'development' | 'production'

declare global {
  interface Window {
    // armed by a spec just before the moment it means to break: the next AbortController cannot be made / the storage refuses to write the key and the memory of the orders
    __bomb: { abortController: boolean; storage: boolean; fired: number }
  }
}

const faultsScript = () => `
(() => {
  const bomb = (window.__bomb = { abortController: false, storage: false, fired: 0 })
  const Real = window.AbortController
  window.AbortController = class extends Real {
    constructor() { if (bomb.abortController) { bomb.abortController = false; bomb.fired++; throw new Error('AbortController is not available here') } super() }
  }
  const refused = (key) => bomb.storage && (key === '${KEY_KEY}' || key === '${PENDING_KEY}')
  const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')
  const nativeSet = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) { if (refused(key)) { bomb.fired++; throw quota() } return nativeSet.call(this, key, value) }
  const nativeRemove = Storage.prototype.removeItem
  Storage.prototype.removeItem = function (key) { if (refused(key)) { bomb.fired++; throw quota() } return nativeRemove.call(this, key) }
})()
`

const problems = new WeakMap<Page, string[]>()

async function arm(page: Page, mode: Mode, options: { variant?: HarnessVariant; gate?: boolean; freeze?: boolean } = {}): Promise<Server> {
  const context = page.context()
  const code = await buildCheckoutHarness(mode, options.variant ?? 'real')
  if (options.freeze) await context.addInitScript(FROZEN_SCHEDULER_SCRIPT)
  await context.addInitScript(spyScript())
  await context.addInitScript(faultsScript())
  if (options.gate) await context.addInitScript(locksGateScript())
  // the harness page answers everything under its origin; the routes of the stubbed API, registered after it, win for their own addresses
  await context.route(`${ORIGIN}/**`, (route) => {
    if (new URL(route.request().url()).pathname === '/h.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: code })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>checkout harness</title><div id="root"></div><script src="/h.js"></script>' })
  })
  const server = await install(context)
  server.state = 'pending'   // an order that was sent to the payment page is not paid yet: the notice of the page does not switch "pay" off
  problems.set(page, collectProblems(page, { warnings: true }))
  return server
}

async function mount(page: Page, mode: Mode, options: { cart?: boolean } = {}) {
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(([strict, cart]) => window.__checkout.mount({ strict: Boolean(strict), cart: cart ?? undefined }), [mode === 'development', options.cart === false ? null : [cartLine()]] as const)
  await expect(pay(page)).toBeEnabled()
}

const pay = (page: Page) => page.getByTestId('pay-button')
const failure = (page: Page) => page.getByTestId('checkout-error')
const orderLink = (page: Page) => page.getByRole('link', { name: 'Controlla lo stato dell\'ordine' })
const redirects = (page: Page) => page.evaluate(() => window.__redirect.urls)
const settle = (page: Page, ms = 500) => page.evaluate((wait) => new Promise<void>((resolve) => setTimeout(resolve, wait)), ms)
const okAnswer = { status: 200, contentType: 'application/json', body: JSON.stringify({ orderId: ORDER, orderNumber: 12, url: STRIPE_URL, totalCents: 2500 }) }
// What the ERROR adds to the page: the notice of the failure, and the label of the button. (The fixed note for guests says it "does not charge twice" - a statement of policy that is on the list of
// tests/checkout-copy-claims.test.ts, class E0 - and is not what an error says.)
async function expectNoChargeClaims(page: Page) {
  const notice = await page.getByTestId('checkout-error').allInnerTexts()
  const label = await pay(page).innerText()
  expect([...notice, label].join('\n'), 'no sentence an error shows denies a charge').not.toMatch(/addebit|charged|no charge|nothing was/i)
}

test.afterEach(({ page }) => {
  expect(problems.get(page) ?? [], 'no exception that nobody caught, no error and no warning in the console').toEqual([])
})

for (const mode of ['development', 'production'] as const) {
  test.describe(`S-11, the real HostedCheckout on React ${mode}${mode === 'development' ? ' (Strict Mode)' : ''}`, () => {
    // ---- an error BEFORE the request goes out ----------------------------------------------------------------------------------------------
    test('an error inside the turn, before the request (the lock was granted): busy while it waits, then given back with "nothing was sent"; the lock is free; the key stays; the next press sends ONE request, with the same key', async ({ page }) => {
      const server = await arm(page, mode, { gate: true })
      await mount(page, mode)
      const button = pay(page)
      await button.click()
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await expect(button).toBeDisabled()
      // the page can not make an AbortController from now on (once): the turn is granted, the key is made, and then the page fails - before anything is sent
      await page.evaluate(() => { window.__bomb.abortController = true; window.__gate.open() })
      await expect(failure(page)).toContainText('non è stato inviato nulla')
      await expect(button).toHaveAttribute('aria-busy', 'false')
      await expect(button).toBeEnabled()
      await expect.poll(() => page.evaluate(() => ({ granted: window.__gate.granted, released: window.__gate.released }))).toEqual({ granted: 1, released: 1 })
      expect(await page.evaluate(() => window.__bomb.fired)).toBe(1)
      expect(server.sessions, 'D: no request, and none by itself').toHaveLength(0)
      const slot = await slotEntry(page)
      expect(slot?.key, 'E: the key that was made is kept').toMatch(/^k[A-Za-z0-9_-]{32}$/)
      expect(slot?.orderId).toBeUndefined()
      await settle(page, 800)
      expect(server.sessions).toHaveLength(0)
      await expectNoChargeClaims(page)
      // the customer presses again: one request, the same key, and the browser leaves for the payment page
      await button.click()
      await expect.poll(() => server.sessions.length).toBe(1)
      expect(JSON.parse(server.sessions[0]).checkoutKey).toBe(slot!.key)
      await expect.poll(() => redirects(page)).toEqual([STRIPE_URL])
    })

    test('the same, with the updates of React queued behind a stopped scheduler: the screen does not move until React runs again, and then it is consistent', async ({ page }) => {
      const server = await arm(page, mode, { gate: true, freeze: true })
      await mount(page, mode)
      const button = pay(page)
      await button.click()
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await page.evaluate(() => window.__sched.freeze())
      await page.evaluate(() => { window.__bomb.abortController = true; window.__gate.open() })
      await page.waitForFunction(() => window.__bomb.fired === 1)
      await settle(page, 250)
      // the outcome has been handled, its updates are queued and not rendered: the old screen is still there
      expect(await page.evaluate(() => window.__sched.held.length)).toBeGreaterThan(0)
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await page.evaluate(() => window.__sched.release())
      await expect(failure(page)).toContainText('non è stato inviato nulla')
      await expect(button).toHaveAttribute('aria-busy', 'false')
      await expect(button).toBeEnabled()
      expect(server.sessions).toHaveLength(0)
    })

    // ---- an error AFTER the server has answered: the order is not lost -----------------------------------------------------------------------
    test('the browser can not write down the order the server named: the page still goes to the payment page (one request), the key is as it was, and nothing was recorded', async ({ page }) => {
      const server = await arm(page, mode)
      server.session = async (route) => { await page.evaluate(() => { window.__bomb.storage = true }); await route.fulfill(okAnswer) }
      await mount(page, mode)
      await pay(page).click()
      await expect.poll(() => redirects(page)).toEqual([STRIPE_URL])
      expect(server.sessions).toHaveLength(1)
      expect(await page.evaluate(() => window.__bomb.fired), 'the storage did refuse').toBeGreaterThan(0)
      const slot = await slotEntry(page)
      expect(slot?.key, 'E: the key written before the answer is still there').toMatch(/^k/)
      expect(slot?.orderId, 'the stamp was refused').toBeUndefined()
      expect(await rawMemory(page), 'nothing in the memory of the orders').toBeNull()
      await expect(pay(page), 'the page stays locked while the browser leaves').toHaveAttribute('aria-busy', 'true')
      await settle(page, 600)
      expect(server.sessions, 'D: still ONE request').toHaveLength(1)
    })

    test('the same, when the cart changed while the request was on its way: no redirect, and the order the server named is on the screen with the way to it - it is not lost', async ({ page }) => {
      const server = await arm(page, mode)
      server.session = async (route) => {
        await page.evaluate(() => { window.__bomb.storage = true; window.__checkout.addItem(1) })
        await settle(page, 250)   // React takes the new cart in
        await route.fulfill(okAnswer)
      }
      await mount(page, mode)
      await pay(page).click()
      await expect(failure(page)).toContainText('Non siamo riusciti ad aprire da qui la pagina di pagamento')
      await expect(orderLink(page)).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
      expect(await redirects(page), 'a payment page is not opened for a cart that is not the one clicked').toEqual([])
      expect(server.sessions).toHaveLength(1)
      expect(await rawMemory(page)).toBeNull()
      await expect(pay(page)).toHaveAttribute('aria-busy', 'false')
      await expect(pay(page)).toBeEnabled()
      await expectNoChargeClaims(page)
    })

    // ---- the browser does not leave --------------------------------------------------------------------------------------------------------
    test('the browser refuses to leave for the payment page (the call throws): the page says so AT ONCE, with the way to the order, and the button is given back', async ({ page }) => {
      const server = await arm(page, mode)
      await mount(page, mode)
      await page.evaluate(() => { window.__redirect.mode = 'throw' })
      await pay(page).click()
      // (the grace period of a browser that does not leave is 15 seconds: this answer comes long before it)
      await expect(failure(page)).toContainText('Non siamo riusciti ad aprire da qui la pagina di pagamento')
      await expect(orderLink(page)).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
      await expect(pay(page)).toHaveAttribute('aria-busy', 'false')
      await expect(pay(page)).toBeEnabled()
      expect(await redirects(page)).toEqual([])
      expect(server.sessions).toHaveLength(1)
      expect((await slotEntry(page))?.orderId, 'the order is written down on the key').toBe(ORDER)
      expect(await rawMemory(page)).toContain(ORDER)
      await settle(page, 600)
      expect(server.sessions, 'D: nothing was sent again').toHaveLength(1)
      await expectNoChargeClaims(page)
    })

    // ---- the page is gone ------------------------------------------------------------------------------------------------------------------
    test('the page is left while the request is on its way: the order is written down all the same, and the page - gone - shows nothing and goes nowhere', async ({ page }) => {
      const server = await arm(page, mode)
      let letGo!: () => void
      const held = new Promise<void>((resolve) => { letGo = resolve })
      server.session = async (route) => { await held; await route.fulfill(okAnswer) }
      await mount(page, mode)
      await pay(page).click()
      await expect.poll(() => server.sessions.length).toBe(1)
      await page.evaluate(() => window.__checkout.unmount())
      letGo()
      await settle(page, 600)
      expect(await redirects(page), 'H: no late redirect').toEqual([])
      expect(await page.evaluate(() => document.getElementById('root')!.innerHTML), 'and nothing on the screen').toBe('')
      expect(await rawMemory(page), 'F: the order was written down whatever the page did').toContain(ORDER)
      expect((await slotEntry(page))?.orderId).toBe(ORDER)
      expect(server.sessions).toHaveLength(1)
    })

    // ---- an error after a request MAY have gone out: lost answer ------------------------------------------------------------------------------
    test('lost answer: an unexpected error after the request - the button is HELD (not busy, not given back), the sentence knows nothing and says where to look, the order and a reload are offered, nothing is sent by itself', async ({ page }) => {
      const server = await arm(page, mode, { variant: 'lost-answer' })
      await mount(page, mode)
      const button = pay(page)
      await page.evaluate(() => { window.__sendPurchaseFault = 'uncertain' })
      await button.click()
      await expect(failure(page)).toContainText('errore imprevisto')
      await expect(failure(page)).toContainText('non possiamo sapere se la richiesta sia partita')
      await expect(failure(page)).toContainText('«Paga» è disattivato')
      await expect(failure(page)).toContainText('Per verificare un pagamento scrivi a aiuto@example.test')
      await expect(button).toBeDisabled()
      await expect(button).toHaveAttribute('aria-busy', 'false')
      await expect(button).toContainText('Controlla l\'ordine prima di pagare di nuovo')
      await expect(page.getByTestId('delivery-pickup'), 'nothing that changes the purchase can be changed').toBeDisabled()
      await expect(page.getByTestId('checkout-reload')).toBeVisible()
      await expect(page.getByTestId('checkout-held-order')).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
      await expectNoChargeClaims(page)
      expect(server.sessions, 'the real request went out once').toHaveLength(1)
      expect(await redirects(page)).toEqual([])
      const sentKey = JSON.parse(server.sessions[0]).checkoutKey
      expect((await slotEntry(page))?.key, 'E: the key is the one that was sent').toBe(sentKey)
      // coming back to the page from the browser's memory (back button) does not give the button back: the order has not been looked at, and the "returned from the payment page" notice is not for this
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
      await settle(page, 300)
      await expect(button).toBeDisabled()
      await expect(page.getByTestId('checkout-returned')).toHaveCount(0)
      // a click on a button that is off does nothing, and nothing happens by itself
      await button.click({ force: true })
      await settle(page, 800)
      expect(server.sessions, 'D: still ONE request').toHaveLength(1)
      expect(await redirects(page)).toEqual([])
      // a reload starts the page from the beginning: the notice looks at the order (not paid: it does not switch "pay" off) and "pay" is there again - and it is the SAME purchase
      await page.getByTestId('checkout-reload').click()
      await page.waitForLoadState()
      await mount(page, mode, { cart: false })
      await pay(page).click()
      await expect.poll(() => server.sessions.length).toBe(2)
      expect(JSON.parse(server.sessions[1]).checkoutKey, 'the key of the first press').toBe(sentKey)
    })

    test('lost answer, with the updates of React queued behind a stopped scheduler: the old screen is still busy and nothing can start a second purchase; when React runs again the held screen is whole', async ({ page }) => {
      const server = await arm(page, mode, { variant: 'lost-answer', freeze: true })
      let letGo!: () => void
      const held = new Promise<void>((resolve) => { letGo = resolve })
      server.session = async (route) => { await held; await route.fulfill(okAnswer) }
      await mount(page, mode)
      const button = pay(page)
      await page.evaluate(() => { window.__sendPurchaseFault = 'uncertain' })
      await button.click()
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await expect.poll(() => server.sessions.length).toBe(1)
      await page.evaluate(() => window.__sched.freeze())
      letGo()
      // the request is answered, the page lost the answer to an error and has handled it: its updates are queued and not rendered, so the screen is the old one
      await expect.poll(() => page.evaluate(() => window.__sched.held.length)).toBeGreaterThan(0)
      await settle(page, 250)
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await button.click({ force: true })
      await settle(page, 300)
      expect(server.sessions, 'D: a press on the old screen starts nothing').toHaveLength(1)
      await page.evaluate(() => window.__sched.release())
      await expect(failure(page)).toContainText('errore imprevisto')
      await expect(button).toBeDisabled()
      await expect(button).toHaveAttribute('aria-busy', 'false')
      await expect(button).toContainText('Controlla l\'ordine prima di pagare di nuovo')
      await expect(page.getByTestId('delivery-pickup')).toBeDisabled()
      await expect(page.getByTestId('checkout-reload')).toBeVisible()
      await expect(page.getByTestId('checkout-held-order')).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
      await expectNoChargeClaims(page)
      await settle(page, 500)
      expect(server.sessions, 'D: still ONE request').toHaveLength(1)
      expect(await redirects(page)).toEqual([])
    })

    test('lost answer: even a rejection out of sendPurchase itself (which the real one never does) is caught by the page - held, never busy for ever, no uncaught rejection', async ({ page }) => {
      const server = await arm(page, mode, { variant: 'lost-answer' })
      await mount(page, mode)
      await page.evaluate(() => { window.__sendPurchaseFault = 'reject' })
      await pay(page).click()
      await expect(failure(page)).toContainText('errore imprevisto')
      await expect(pay(page)).toBeDisabled()
      await expect(pay(page)).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('checkout-reload')).toBeVisible()
      await settle(page, 600)
      expect(server.sessions).toHaveLength(0)
      expect(await redirects(page)).toEqual([])
      await expectNoChargeClaims(page)
    })
  })
}
