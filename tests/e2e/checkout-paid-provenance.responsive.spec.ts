// R1-2 (S-04, S-09) – a payment the SERVER says is verified, and what the pages do with the cart, the key and the memory of the order when the key in the slot is - or is not - proved to be
// that payment's. On a desktop and on phone-sized screens (projects "chromium", "mobile", "mobile-small"), on the checkout (Italian), the cart (English) and the return page.
//
// The rule being tried, from the mandate: a verified payment is SHOWN whatever the slot holds; but the cart is emptied and the key forgotten only when the slot carries THIS order. A slot that
// belongs to another purchase is left exactly as it is. A slot that proves nothing (absent, forgotten, damaged, unreadable, written before R1-2) is NOT taken to mean that the payment was
// replaced by another: nothing is touched, the memory of the order STAYS, "pay" stays off, no payment request is ever started by the recovery path, and nobody is invited to pay again.
// (The answers of /api/checkout/* are fixed; what the server answers, and to whom, is tests/security/. The real provider under every kind of React scheduling: cart-clear-if.responsive.spec.ts.)
import { expect, test, type Page } from '@playwright/test'
import {
  KEY_KEY, ORDER, OTHER_KEY, OTHER_ORDER, OTHER_SIGNATURE, SIGNATURE, STRONG_KEY, cartLine, expectFitsScreen, expectTouchTargets, install, remembered, rememberedIds, seed, slotEntry, spyScript,
  storedCart, type SlotKind,
} from './_checkout-pages'

const UNPROVEN: Array<[string, SlotKind]> = [
  ['no key in the slot', 'none'],
  ['the placeholder of a key that was forgotten', 'forgotten'],
  ['a slot that is damaged', 'damaged'],
  ['a key written before R1-2 (a key, no order)', 'legacy'],
]

async function expectUntouched(page: Page, label: string) {
  expect(await storedCart(page), `${label}: the cart is not emptied`).toBe(1)
  expect(await rememberedIds(page), `${label}: the memory of the order STAYS - it is the only way back to it`).toEqual([ORDER])
  const spy = await page.evaluate(() => window.__spy)
  expect(spy.posts, `${label}: no payment request was started by the page`).toEqual([])
  expect(spy.writes.filter((w) => w.startsWith(`${KEY_KEY}`)), `${label}: the key slot was not written`).toEqual([])
  expect(spy.writes.filter((w) => w.startsWith('mw:pending-orders:v2')), `${label}: the memory of the orders was not written`).toEqual([])
}

test.describe('S-09: a verified payment without proof that the key is its own', () => {
  for (const [label, slot] of UNPROVEN) {
    test(`checkout, ${label}: the payment is shown, the cart and the key and the memory are NOT touched, "pay" stays off, nothing is sent, nobody is asked to pay again`, async ({ page, context }) => {
      await context.addInitScript(spyScript())
      const server = await install(context)
      server.state = 'paid'
      await seed(page, { slot })
      const before = await page.evaluate((k) => localStorage.getItem(k), KEY_KEY)
      await page.goto('/checkout')
      const paid = page.getByTestId('pending-payment-paid')
      await expect(paid).toContainText('Pagamento confermato')
      await expect(paid).toContainText('MW-00012')
      await expect(paid.getByRole('link', { name: "Controlla lo stato dell'ordine" })).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
      await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'unlinked')
      await expect(page.getByTestId('pending-payment-note')).toContainText('non serve pagare di nuovo')
      await expect(page.getByTestId('pending-payment-note')).toContainText('non lo abbiamo svuotato')
      await expect(page.getByTestId('pay-button'), 'a verified payment that is not settled keeps "pay" off').toBeDisabled()
      await page.waitForTimeout(500)
      await expectUntouched(page, label)
      expect(await page.evaluate((k) => localStorage.getItem(k), KEY_KEY), 'byte for byte').toBe(before)
      // an attempt to press the button all the same does nothing
      await page.getByTestId('pay-button').click({ force: true }).catch(() => undefined)
      await page.waitForTimeout(200)
      expect((await page.evaluate(() => window.__spy.posts)), 'no payment request, however hard the button is pressed').toEqual([])
      expect(server.sessions).toEqual([])
      await expect(page.getByTestId('pending-payment-paid'), 'nobody is invited to press "Paga", to try again or to start over').not.toContainText(/\bPaga\b|riprova|ricomincia|ripaga/i)
      await expectFitsScreen(page, `checkout, ${label}`)
      await expectTouchTargets(page, '[data-testid="pending-payment-paid"] a', `checkout, ${label}`)
    })
  }

  test('cart (English), no proof: the same - the payment is confirmed, the cart stays as it is, Checkout is off, the note says the cart could not be tied to the payment', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'legacy' })
    await page.goto('/cart')
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Payment confirmed')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'unlinked')
    await expect(page.getByTestId('pending-payment-note')).toContainText('you do not need to pay again')
    await expect(page.getByTestId('pending-payment-note')).toContainText('we have not emptied or changed it')
    await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()
    await page.waitForTimeout(400)
    await expectUntouched(page, 'cart')
    await expectFitsScreen(page, 'cart, no proof')
  })

  test('the return page, no proof: the order is shown as paid whatever the slot holds; the cart is left as it is; the note says so', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'legacy' })
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pagamento ricevuto' })).toBeVisible()
    await expect(page.getByTestId('status-cart-note')).toHaveAttribute('data-note', 'unlinked')
    await page.waitForTimeout(400)
    await expectUntouched(page, 'return page')
    await expectFitsScreen(page, 'return page, no proof')
  })

  test('an unreadable key slot (the browser refuses to read it): the same as no proof - nothing is touched', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    await context.addInitScript(`(() => { const get = Storage.prototype.getItem; Storage.prototype.getItem = function (key) { if (key === '${KEY_KEY}') throw new DOMException('denied', 'SecurityError'); return get.call(this, key) } })()`)
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'owned' })
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'unlinked')
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    await page.waitForTimeout(400)
    await expectUntouched(page, 'unreadable slot')
  })

  test('reload after the payment was recognised, again and again: the same answer each time and not one write - the recovery path never makes a payment of its own', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'legacy' })
    for (let round = 0; round < 3; round++) {
      await page.goto('/checkout')
      await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'unlinked')
      await page.waitForTimeout(250)
      await expectUntouched(page, `round ${round + 1}`)
    }
    expect(server.sessions, 'not one request to the payment endpoint, in three visits').toEqual([])
    expect(server.asked.length, 'one question to the status service per visit').toBe(3)
  })

  test('the cart is rebuilt as it was, the key is the old one with no order, and the customer presses nothing: still no payment, still the same note', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'legacy' })
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'unlinked')
    // the customer empties the cart by hand and builds the same cart again (which is the same signature): the memory of the order is found again, and says the same.
    // (The cart is written from a page that has no cart on it, so that nothing of the checkout page can save the old list over it.)
    await page.goto('/robots.txt')
    await page.evaluate(([cartKey]) => localStorage.setItem(cartKey as string, '[]'), ['mwv2:cart'] as const)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note'), 'with the cart empty there is nothing to say about it').toHaveCount(0)
    await page.goto('/robots.txt')
    await page.evaluate(([cartKey, line]) => localStorage.setItem(cartKey as string, JSON.stringify([line])), ['mwv2:cart', cartLine()] as const)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'unlinked')
    await expect(page.getByTestId('pay-button')).toBeDisabled()
    expect(server.sessions).toEqual([])
  })
})

test.describe('S-04: a verified payment with a key that IS proved to be its own, or is proved to be another purchase\'s', () => {
  test('checkout, the slot carries this order: the cart is emptied FIRST, then the key forgotten, then the memory removed - and the writes show that order', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'owned' })
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'emptied')
    await expect(page.getByTestId('pending-payment-note')).toHaveText('Il carrello è stato svuotato.')
    await expect(page.getByRole('heading', { name: 'Il carrello è vuoto' })).toBeVisible()
    await expect.poll(() => storedCart(page)).toBe(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY_KEY), 'the key is forgotten (the placeholder)').toBe('')
    const writes = (await page.evaluate(() => window.__spy.writes)).map((w) => (w.startsWith('mwv2:cart=') ? 'cart' : w.startsWith(`${KEY_KEY}=`) ? 'key' : w.startsWith('mw:pending-orders:v2') ? 'memory' : w))
    const cartAt = writes.lastIndexOf('cart')
    const keyAt = writes.indexOf('key')
    const memoryAt = writes.findIndex((w, index) => index > keyAt && w === 'memory')
    expect(keyAt, 'the key was written').toBeGreaterThan(-1)
    expect(cartAt, 'the cart was written (emptied) BEFORE the key was forgotten').toBeLessThan(keyAt)
    expect(memoryAt, 'the memory of the order was removed AFTER the key was forgotten').toBeGreaterThan(keyAt)
    expect((await page.evaluate(() => window.__spy.writes)).find((w) => w.startsWith('mwv2:cart=[]')), 'and what was written for the cart is the empty cart').toBeTruthy()
    expect(server.sessions).toEqual([])
    await expect(page.getByTestId('pay-button')).toHaveCount(0)
  })

  test('the key in the slot is ANOTHER purchase\'s (B started with the same things): its key and its cart are not touched, the memory of A goes, the note says the cart may hold a new purchase', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'other' })
    const before = await page.evaluate((k) => localStorage.getItem(k), KEY_KEY)
    await page.goto('/checkout')
    await expect(page.getByTestId('pending-payment-note')).toHaveAttribute('data-note', 'kept')
    await expect(page.getByTestId('pending-payment-note')).toContainText('potrebbe contenere un nuovo acquisto')
    await expect(page.getByTestId('pending-payment-paid')).toContainText('Pagamento confermato')
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await storedCart(page), 'the cart of the other purchase is not emptied').toBe(1)
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY_KEY), 'the other purchase\'s key is byte for byte what it was').toBe(before)
    expect((await slotEntry(page))?.key).toBe(OTHER_KEY)
    expect((await slotEntry(page))?.orderId).toBe(OTHER_ORDER)
    expect((await page.evaluate(() => window.__spy.writes)).filter((w) => w.startsWith(KEY_KEY)), 'the slot was not written').toEqual([])
    expect(server.sessions).toEqual([])
    // the customer is free to go on with the purchase that is in the cart: "pay" is on again
    await expect(page.getByTestId('pay-button')).toBeEnabled()
  })

  test('the memory of ANOTHER order (B) is not touched when A is settled, whatever the slot holds', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'other' })
    await page.evaluate(([pendingKey, orderB, signature, orderA, signatureA]) => {
      localStorage.setItem(pendingKey as string, JSON.stringify([{ orderId: orderA, cartSignature: signatureA, at: Date.now() }, { orderId: orderB, cartSignature: signature, at: Date.now() - 1000 }]))
    }, ['mw:pending-orders:v2', OTHER_ORDER, OTHER_SIGNATURE, ORDER, SIGNATURE] as const)
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await expect.poll(() => rememberedIds(page)).toEqual([OTHER_ORDER])
    expect((await remembered(page))[0].cartSignature).toBe(OTHER_SIGNATURE)
  })

  test('the return page, the slot carries this order: the cart is emptied and the note says so', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'owned' })
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-cart-note')).toHaveAttribute('data-note', 'emptied')
    await expect.poll(() => storedCart(page)).toBe(0)
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY_KEY)).toBe('')
    await expectFitsScreen(page, 'return page, owned')
  })

  test('the return page: the slot carries this order but the cart is no longer the one that was paid (the customer has changed it): nothing is emptied, the key stays, the memory goes, there is no note', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'paid'
    await seed(page, { slot: 'owned', entry: { orderId: ORDER, cartSignature: OTHER_SIGNATURE } })
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await expect.poll(() => rememberedIds(page)).toEqual([])
    expect(await storedCart(page), 'a cart composed after paying is not touched').toBe(1)
    expect((await slotEntry(page))?.orderId, 'the key stays where it is, with its order').toBe(ORDER)
    await expect(page.getByTestId('status-cart-note')).toHaveCount(0)
    expect(server.sessions).toEqual([])
  })

  test('not paid (confirming, under check): nothing of the above - the cart, the key and the memory stay, "pay" is off, no settlement at all', async ({ page, context }) => {
    await context.addInitScript(spyScript())
    const server = await install(context)
    for (const state of ['confirming', 'attention']) {
      server.state = state
      await seed(page, { slot: 'owned' })
      await page.goto('/checkout')
      await expect(page.getByTestId(`pending-payment-${state}`)).toBeVisible()
      await expect(page.getByTestId('pay-button')).toBeDisabled()
      await expect(page.getByTestId('pending-payment-paid')).toHaveCount(0)
      await page.waitForTimeout(250)
      expect(await storedCart(page)).toBe(1)
      expect(await rememberedIds(page)).toEqual([ORDER])
      expect((await slotEntry(page))?.orderId, state).toBe(ORDER)
    }
  })
})
