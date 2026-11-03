// R1-2 (S-08) – a payment the server says is verified: the page SHOWS it at once, and settles the cart, the key and the memory of the order as a separate job that can wait, fail, be left
// behind by the page, or be done by another tab. On a desktop and on phone-sized screens (projects "chromium", "mobile", "mobile-small").
//
// What is tried: the confirmation never waits for the job; while the job is not final "pay" stays off and the memory of the order stays (it is the only way back to the order); a job that could
// not be done is finished by the next visit, with no new payment and no polling; two tabs that hear "paid" together do the job once; a page that is left does nothing on a page that is gone.
import { expect, test, type Page } from '@playwright/test'
import { LOCK_NAME, ORDER, SIGNATURE, collectProblems, expectFitsScreen, install, locksGateScript, rememberedIds, seed, slotEntry, spyScript, storedCart } from './_checkout-pages'

test.describe('S-08: the confirmation, the settlement and the way back to the order', () => {
  test('the confirmation and "pay off" are on the page WHILE the settlement waits for its turn - and nothing is touched until it has it', async ({ page, context }) => {
    const problems = collectProblems(page, { warnings: true })
    await context.addInitScript(spyScript())
    await context.addInitScript(locksGateScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Pagamento confermato')
    await expect(page.getByTestId('pending-payment-paid')).toContainText('MW-00012')
    await expect(page.getByTestId('pending-payment-note'), 'no word about the cart yet: the job has not happened').toHaveCount(0)
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    await expect.poll(() => page.evaluate(() => window.__gate.requests), { message: 'the settlement asked for its turn' }).toBe(1)
    await page.waitForTimeout(400)
    expect(await storedCart(page)).toBe(1)
    expect(await rememberedIds(page)).toEqual([ORDER])
    expect((await slotEntry(page))?.orderId).toBe(ORDER)
    expect(await page.evaluate(() => window.__spy.writes.filter((w) => !w.startsWith('mwv2:cart')))).toEqual([])
    // the turn comes: the job is done, the note is told, "pay" has nothing to be off for
    await page.evaluate(() => window.__gate.open())
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'emptied')
    await expect.poll(() => storedCart(page)).toBe(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await page.evaluate((k) => localStorage.getItem(k), 'mw:checkout-key:v1')).toBe('')
    expect(problems, 'nothing in the console').toEqual([])
    await expectFitsScreen(page, 'checkout, settled')
  })

  test('another tab keeps the turn for too long: the wait ends at 30 seconds, the confirmation says the job is not finished, NOTHING is changed, and the next visit finishes it with no payment of its own', async ({ page, context }) => {
    const problems = collectProblems(page, { warnings: true })
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    const holder = await context.newPage()
    await holder.goto('/robots.txt')
    await holder.evaluate((name) => new Promise<void>((resolve) => { void navigator.locks.request(name, () => new Promise<void>((release) => { (window as unknown as { __release: () => void }).__release = release; resolve() })) }), LOCK_NAME)
    await page.clock.install()
    await page.goto('/checkout')
    await page.clock.runFor(100)
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Pagamento confermato')
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    await page.clock.runFor(29_000)
    await expect(page.getByTestId('pending-payment-note'), 'still waiting at 29 seconds').toHaveCount(0)
    await page.clock.runFor(2_000)
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'pending')
    await expect(page.getByTestId('pending-payment-note')).toContainText('non serve pagare di nuovo')
    await expect(page.getByTestId('pay-button'), 'a payment that is verified and not settled keeps "pay" off').toBeDisabled()
    expect(await storedCart(page)).toBe(1)
    expect(await rememberedIds(page), 'the way back to the order is still there').toEqual([ORDER])
    expect((await slotEntry(page))?.orderId).toBe(ORDER)
    expect(server.sessions, 'no payment request').toEqual([])
    // the other tab lets go, and the customer comes back to the cart: the job is finished, once, with one question to the status service
    await holder.evaluate(() => (window as unknown as { __release: () => void }).__release())
    const asked = server.asked.length
    await page.goto('/cart')
    await page.clock.runFor(200)
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'emptied')
    await expect.poll(() => storedCart(page)).toBe(0)
    expect(server.asked.length - asked, 'one question for the visit').toBe(1)
    expect(server.sessions).toEqual([])
    expect(problems).toEqual([])
  })

  test('a settlement that could not be finished does not poll, retry or ask for the turn again by itself - ten minutes later, nothing has been asked', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    await context.addInitScript(locksGateScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    await page.clock.install()
    await page.goto('/checkout')
    await page.clock.runFor(100)
    await expect(page.getByTestId('pending-payment-paid')).toBeVisible()
    await page.clock.runFor(31_000)
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'pending')
    const asked = server.asked.length
    const requests = await page.evaluate(() => window.__gate.requests)
    await page.clock.runFor(10 * 60_000)
    expect(server.asked.length, 'the status service is not asked again').toBe(asked)
    expect(await page.evaluate(() => window.__gate.requests), 'and the turn is not asked for again').toBe(requests)
    expect(server.sessions).toEqual([])
  })

  test('two tabs hear "paid" together: the job is done once - one tab empties the cart, forgets the key, removes the memory; the other follows the emptied cart and writes nothing', async ({ page, context }) => {
    const problems = collectProblems(page, { warnings: true })
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    const other = await context.newPage()
    other.on('pageerror', (error) => problems.push(`pageerror (other tab): ${error.message}`))
    await Promise.all([page.goto('/cart'), other.goto('/cart')])
    // The confirmation is shown by every tab that hears "paid" while the memory of the order is still there. A tab whose answer arrives after the other tab's job took that memory away has nothing
    // left to ask about: it follows the emptied cart (it never had the order's confirmation to show) - so at least one tab shows it, and every tab ends with an empty cart on screen.
    await expect.poll(async () => (await page.getByTestId('pending-payment-paid').count()) + (await other.getByTestId('pending-payment-paid').count()), { message: 'the confirmation is on screen in at least one tab' }).toBeGreaterThanOrEqual(1)
    for (const tab of [page, other]) {
      const box = tab.getByTestId('pending-payment-paid')
      if (await box.count()) await expect(box).toContainText('Payment confirmed')
      await expect(tab.getByText('Cart is empty.')).toBeVisible()
    }
    await expect.poll(() => storedCart(page)).toBe(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
    const writes = async (tab: Page) => (await tab.evaluate(() => window.__spy.writes)).filter((w) => w.startsWith('mw:checkout-key:v1='))
    const slotWrites = [...(await writes(page)), ...(await writes(other))]
    expect(slotWrites, 'the key was forgotten once, by one tab').toEqual(['mw:checkout-key:v1='])
    const notes = await Promise.all([page, other].map((tab) => tab.getByTestId('pending-payment-note').count()))
    expect(notes.reduce((a, b) => a + b, 0), 'and only that tab says so').toBeLessThanOrEqual(1)
    expect(server.sessions).toEqual([])
    expect(problems).toEqual([])
  })

  test('the page is left (a link inside the site) while the settlement waits: the wait is cancelled, nothing is written, nothing breaks, the memory of the order stays - and the next page does the job', async ({ page, context }) => {
    const problems = collectProblems(page, { warnings: true })
    await context.addInitScript(spyScript())
    await context.addInitScript(locksGateScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-paid')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__gate.requests)).toBe(1)
    await page.getByRole('link', { name: 'Torna al carrello' }).first().click()
    await expect(page).toHaveURL(/\/cart$/)
    await expect.poll(() => page.evaluate(() => window.__gate.aborted), { message: 'the request for the turn of the page that was left was cancelled' }).toBe(1)
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Payment confirmed')
    expect(await storedCart(page), 'nothing was written by the page that was left').toBe(1)
    expect(await rememberedIds(page)).toEqual([ORDER])
    await page.evaluate(() => window.__gate.open())
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'emptied')
    await expect.poll(() => storedCart(page)).toBe(0)
    expect(problems, 'no state update on a page that is gone, no error').toEqual([])
    expect(SIGNATURE.length).toBeGreaterThan(0)
  })

  test('an address opened by hand, the memory of no order of this browser: the order is shown as paid and nothing else happens - no turn is asked for, the cart is left alone', async ({ page, context }) => {
    await context.addInitScript(locksGateScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { entry: null })
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await page.waitForTimeout(400)
    expect(await storedCart(page)).toBe(1)
    expect(await page.evaluate(() => window.__gate.requests), 'no memory of the order: no job').toBe(0)
    await expect(page.getByTestId('status-cart-note')).toHaveCount(0)
  })
})
