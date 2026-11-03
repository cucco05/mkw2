// R1-2 (S-01, S-03, S-05) – the "pay" button of a customer who has several tabs open, on a desktop and on phone-sized screens (projects "chromium", "mobile", "mobile-small").
//
// What is tried, on the real checkout page with the answers of /api/checkout/* fixed (what the server answers is tests/security/ and tests/real-run/):
//   * one request at a time per browser: the second tab waits for the first (the real Web Locks of the browser) and then uses the SAME key;
//   * the key is read or made only when it is the tab's turn - a tab that waits touches nothing;
//   * a wait that runs out, a lock service that does not work (whatever the error is called), a page that is left: NOTHING is sent and NOTHING is written, and the sentence says so;
//   * a browser with no lock service at all pays as it always did;
//   * a request that goes unanswered is cut at the limit and told as what it is - not known - never as "nothing was charged"; nothing is repeated by itself;
//   * the answer of a request is kept for the cart that was CLICKED: if the cart changed, or the page was left, the customer is not sent to the payment page.
import { expect, test, type Page } from '@playwright/test'
import { KEY_KEY, LOCK_NAME, ORDER, PENDING_KEY, SIGNATURE, collectProblems, expectFitsScreen, install, locksBrokenScript, locksGateScript, rememberedIds, seed, slotEntry, spyScript, type LocksBreakage } from './_checkout-pages'

const keyOf = (body: string) => (JSON.parse(body) as { checkoutKey: string }).checkoutKey
const openCheckout = async (page: Page) => {
  await seed(page, { entry: null })
  await page.goto('/checkout')
  await expect(page.getByTestId('pay-button')).toBeEnabled()
}
const slot = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY_KEY)

test.describe('S-01 / S-03: one request at a time, in its turn', () => {
  test('the turn: while the lock is not granted nothing is sent and nothing is written; when it is, ONE request goes out with a strong key, and the order is kept on that very key', async ({ page, context }) => {
    const problems = collectProblems(page)
    await context.addInitScript(spyScript())
    await context.addInitScript(locksGateScript())
    const server = await install(context)
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    await expect(page.getByTestId('pay-button')).toHaveAttribute('aria-busy', 'true')
    await expect.poll(() => page.evaluate(() => window.__gate.requests)).toBe(1)
    await page.waitForTimeout(400)
    expect(server.sessions, 'no request while the turn is not granted').toEqual([])
    expect(await slot(page), 'and no key is made').toBeNull()
    await page.evaluate(() => window.__gate.open())
    await page.waitForURL(/checkout\.stripe\.com/)
    expect(server.sessions).toHaveLength(1)
    expect(keyOf(server.sessions[0])).toMatch(/^k[A-Za-z0-9_-]{32}$/)
    const probe = await context.newPage()
    await probe.goto('/robots.txt')
    const entry = await slotEntry(probe)
    expect(entry?.key).toBe(keyOf(server.sessions[0]))
    expect(entry?.orderId, 'the order the server named is written on the key that asked for it').toBe(ORDER)
    expect(await rememberedIds(probe)).toEqual([ORDER])
    expect(problems).toEqual([])
  })

  test('two tabs: the second waits for the first and then uses the SAME key - never two requests at once, never two keys', async ({ page, context }) => {
    const problems = collectProblems(page)
    const server = await install(context)
    let letFirstAnswer!: () => void
    const firstMayAnswer = new Promise<void>((resolve) => { letFirstAnswer = resolve })
    const answer = server.session
    server.session = async (route) => { if (server.sessions.length === 1) await firstMayAnswer; return answer(route) }
    await openCheckout(page)
    const other = await context.newPage()
    other.on('pageerror', (error) => problems.push(`pageerror (other tab): ${error.message}`))
    await other.goto('/checkout')
    await expect(other.getByTestId('pay-button')).toBeEnabled()
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(1)
    await other.getByTestId('pay-button').click()
    await other.waitForTimeout(600)
    expect(server.sessions, 'the second tab\'s request does not go out while the first one is on its way').toHaveLength(1)
    letFirstAnswer()
    await page.waitForURL(/checkout\.stripe\.com/)
    await expect.poll(() => server.sessions.length).toBe(2)
    expect(keyOf(server.sessions[1]), 'the same key').toBe(keyOf(server.sessions[0]))
    await other.waitForURL(/checkout\.stripe\.com/)
    expect(problems).toEqual([])
  })

  test('N17: the key and the order id kept in the slot are NOT credentials - the key leaves only in the body of the payment request, the order id only as the question "?order=" of the status requests; neither is in a header, a cookie or any other body', async ({ page, context }) => {
    const problems = collectProblems(page)
    const server = await install(context)
    type Sent = { method: string; url: string; headers: Record<string, string>; body: string }
    const seen: Array<Promise<Sent>> = []
    page.on('request', (request) => {
      if (!new URL(request.url()).pathname.startsWith('/api/')) return
      seen.push((async () => ({ method: request.method(), url: request.url(), headers: await request.allHeaders(), body: request.postData() ?? '' }))())
    })
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    await page.waitForURL(/checkout\.stripe\.com/)
    const key = keyOf(server.sessions[0])
    // the payment is verified: the cart, the checkout and the status questions run with the key and the order id in the slot
    server.state = 'paid'
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'emptied')
    await page.goto('/cart')
    await page.waitForTimeout(300)
    const all = await Promise.all(seen)
    // what is looked at: the address, the headers (the cookie among them, the referer left out: it is a page address) and the body
    const whole = (sent: Sent) => JSON.stringify({ url: sent.url, headers: { ...sent.headers, referer: '' }, body: sent.body })
    const withKey = all.filter((sent) => whole(sent).includes(key))
    expect(withKey.length, 'the key was sent once, with the payment request').toBeGreaterThan(0)
    for (const sent of withKey) {
      expect(sent.method + ' ' + new URL(sent.url).pathname, 'the key is in the payment request and in nothing else').toBe('POST /api/checkout/session')
      expect(sent.body).toContain(key)
      expect(JSON.stringify({ url: sent.url, headers: { ...sent.headers, referer: '' } }), 'and in its body, not in its address or its headers').not.toContain(key)
    }
    const withOrder = all.filter((sent) => whole(sent).includes(ORDER))
    expect(withOrder.length, 'the status of the order was asked').toBeGreaterThan(0)
    for (const sent of withOrder) {
      const address = new URL(sent.url)
      expect(sent.method + ' ' + address.pathname, 'the order id is in the status question and in nothing else').toBe('GET /api/checkout/status')
      expect(address.searchParams.get('order')).toBe(ORDER)
      expect(JSON.stringify({ ...sent.headers, referer: '' }), 'not in a header, not in the cookie').not.toContain(ORDER)
      expect(sent.body).toBe('')
    }
    expect(problems).toEqual([])
  })

  test('the lock is given back before the customer leaves for the payment page: another tab sees no purchase lock held', async ({ page, context }) => {
    await install(context)
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    await page.waitForURL(/checkout\.stripe\.com/)
    const probe = await context.newPage()
    await probe.goto('/robots.txt')
    const held = await probe.evaluate(async (name) => ((await navigator.locks.query()).held ?? []).filter((lock) => lock.name === name).length, LOCK_NAME)
    expect(held).toBe(0)
  })

  test('the wait for the turn runs out at 30 seconds: nothing is sent, no key is made, the sentence says nothing was sent, the button is given back - and a later press goes out', async ({ page, context }) => {
    const server = await install(context)
    await seed(page, { entry: null })
    const holder = await context.newPage()
    await holder.goto('/robots.txt')
    await holder.evaluate((name) => new Promise<void>((resolve) => { void navigator.locks.request(name, () => new Promise<void>((release) => { (window as unknown as { __release: () => void }).__release = release; resolve() })) }), LOCK_NAME)
    await page.clock.install()
    await page.goto('/checkout')
    await page.clock.runFor(200)
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await page.getByTestId('pay-button').click()
    await page.clock.runFor(29_000)
    await expect(page.getByTestId('checkout-error')).toHaveCount(0)
    await page.clock.runFor(2_000)
    const error = page.getByTestId('checkout-error')
    await expect(error).toContainText('non è stato inviato nulla')
    await expect(error).toContainText('il carrello è rimasto com')
    await expect(error).not.toContainText('addebit')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await expect(page.getByTestId('pay-button')).toHaveAttribute('aria-busy', 'false')
    expect(server.sessions, 'nothing was sent').toEqual([])
    expect(await slot(page), 'no key was made').toBeNull()
    expect(await rememberedIds(page)).toEqual([])
    await expectFitsScreen(page, 'checkout, wait ran out')                  // (before the next press: that one leaves for the payment page)
    // the other tab lets go; the customer presses again, on purpose
    await holder.evaluate(() => (window as unknown as { __release: () => void }).__release())
    await page.getByTestId('pay-button').click()
    await page.clock.runFor(500)
    await expect.poll(() => server.sessions.length).toBe(1)
  })
})

const BREAKAGES: Array<[LocksBreakage, string]> = [
  ['getter-throws', 'SecurityError'],
  ['request-throws', 'NotSupportedError'],
  ['request-rejects', 'TypeError'],
  ['request-rejects', 'InvalidStateError'],
  ['no-callback', 'SomethingNew'],
]

test.describe('S-05: the lock service is there and does not work, or is not there at all', () => {
  for (const [how, name] of BREAKAGES) {
    test(`broken (${how}, ${name}): nothing is sent, nothing is written, the sentence says nothing was sent, the button is given back - and with the service working again a press goes out`, async ({ page, context }) => {
      const server = await install(context)
      await context.addInitScript(locksBrokenScript(how, name))
      await openCheckout(page)
      await page.getByTestId('pay-button').click()
      const error = page.getByTestId('checkout-error')
      await expect(error).toContainText('non è stato inviato nulla')
      await expect(error).not.toContainText('addebit')
      await expect(page.getByTestId('pay-button')).toBeEnabled()
      expect(server.sessions, 'no request, whatever the error is called').toEqual([])
      expect(await slot(page), 'no key made').toBeNull()
      expect(await rememberedIds(page)).toEqual([])
      expect(await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).toBeNull()
    })
  }

  test('absent (the browser offers no lock service): the payment goes out as it always did, without a message', async ({ page, context }) => {
    const problems = collectProblems(page)
    const server = await install(context)
    await context.addInitScript(locksBrokenScript('absent'))
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    await page.waitForURL(/checkout\.stripe\.com/)
    expect(server.sessions).toHaveLength(1)
    expect(problems).toEqual([])
  })
})

test.describe('S-02 / S-03: a request that has no answer, and an answer that arrives late', () => {
  test('no answer for 45 seconds: the request is cut, told as NOT KNOWN (never "nothing was charged"), the key stays with no order, nothing is repeated, the button is given back', async ({ page, context }) => {
    const server = await install(context)
    server.session = () => new Promise<void>(() => undefined)
    await seed(page, { entry: null })
    await page.clock.install()
    await page.goto('/checkout')
    await page.clock.runFor(200)
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(1)
    await page.clock.runFor(44_000)
    await expect(page.getByTestId('checkout-error')).toHaveCount(0)
    await page.clock.runFor(2_000)
    const error = page.getByTestId('checkout-error')
    await expect(error).toContainText('Non riusciamo a verificare come sia andata')
    await expect(error).toContainText('evita di modificare il carrello')
    await expect(error).not.toContainText('addebit')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    const entry = await slotEntry(page)
    expect(entry?.key).toBe(keyOf(server.sessions[0]))
    expect(entry?.orderId, 'no order is known').toBeUndefined()
    expect(await rememberedIds(page)).toEqual([])
    await page.clock.runFor(10 * 60_000)
    expect(server.sessions, 'nothing was repeated by itself').toHaveLength(1)
  })

  test('a failure at the payment service is not "nothing was charged" either - and a press on purpose goes out with the SAME key', async ({ page, context }) => {
    const server = await install(context)
    server.session = (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{"code":"PAYMENT_PROVIDER_ERROR"}' })
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    const error = page.getByTestId('checkout-error')
    await expect(error).toContainText('Non riusciamo a verificare come sia andata')
    await expect(error).not.toContainText('addebit')
    await expect(page.getByTestId('pay-button')).toBeEnabled()
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(2)
    expect(keyOf(server.sessions[1])).toBe(keyOf(server.sessions[0]))
  })

  test('the cart changes in another tab while the request is on its way: the order is kept for the cart that was CLICKED, the customer is NOT sent to the payment page, the button comes back', async ({ page, context }) => {
    const problems = collectProblems(page)
    const server = await install(context)
    let letAnswer!: () => void
    const mayAnswer = new Promise<void>((resolve) => { letAnswer = resolve })
    const answer = server.session
    server.session = async (route) => { await mayAnswer; return answer(route) }
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(1)
    const other = await context.newPage()
    await other.goto('/robots.txt')
    await other.evaluate(() => { const items = JSON.parse(localStorage.getItem('mwv2:cart') || '[]'); items[0].options.qty = 5; localStorage.setItem('mwv2:cart', JSON.stringify(items)) })
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mwv2:cart') || '[]')[0]?.options.qty)).toBe(5)
    letAnswer()
    await expect(page.getByTestId('pay-button')).toBeEnabled({ timeout: 15_000 })
    expect(page.url(), 'not sent to the payment page').toContain('/checkout')
    expect(page.url()).not.toContain('stripe')
    const memory = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]') as Array<{ orderId: string; cartSignature: string }>, PENDING_KEY)
    expect(memory.map((entry) => [entry.orderId, entry.cartSignature]), 'the order is remembered for the cart that was clicked, and for no other').toEqual([[ORDER, SIGNATURE]])
    expect(problems).toEqual([])
  })

  test('the page is left (a link inside the site) while the request is on its way: the answer is kept, nothing is shown, nobody is sent anywhere, nothing breaks', async ({ page, context }) => {
    const problems = collectProblems(page)
    const server = await install(context)
    let letAnswer!: () => void
    const mayAnswer = new Promise<void>((resolve) => { letAnswer = resolve })
    const answer = server.session
    server.session = async (route) => { await mayAnswer; return answer(route) }
    await openCheckout(page)
    await page.getByTestId('pay-button').click()
    await expect.poll(() => server.sessions.length).toBe(1)
    await page.getByRole('link', { name: 'Torna al carrello' }).first().click()
    await expect(page).toHaveURL(/\/cart$/)
    letAnswer()
    await expect.poll(() => rememberedIds(page), { message: 'the order the request made is remembered all the same' }).toEqual([ORDER])
    await page.waitForTimeout(800)
    expect(page.url(), 'and the customer stays where they went').toMatch(/\/cart$/)
    expect((await slotEntry(page))?.orderId).toBe(ORDER)
    expect(problems, 'no update of a page that is gone').toEqual([])
  })
})
