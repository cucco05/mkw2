// R1-2 (S-06) – what the pages tell a customer who comes BACK from the payment page, or lands on an order that was closed, on a desktop and on phone-sized screens (projects "chromium",
// "mobile", "mobile-small"). The answers of /api/checkout/* are fixed.
//
// The rule: say only what the page can show. The address Stripe's "back" link leads to proves nothing, and a payment page that was left open can still be paid - so the notice of a return says
// the customer came back and that the outcome may need checking, points to the order when the browser remembers one and to the shop, and denies nothing and invites to nothing. A closed
// order is closed in the shop's records, said as that. The sentences themselves, in both languages, are checked in tests/checkout-copy-claims.test.ts.
import { expect, test } from '@playwright/test'
import { ORDER, expectFitsScreen, expectTouchTargets, install, rememberedIds, seed, storedCart } from './_checkout-pages'

const FORBIDDEN = /addebit|quando vuoi|ricominci|senza alcun/i

test.describe('S-06: the return from the payment page, and the order that was closed', () => {
  test('back from Stripe\'s "back" link, this browser remembers an order for this cart: the notice of a return, the way to the order, the shop - and no claim about a charge', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'pending'
    await seed(page)
    await page.goto('/checkout?canceled=1')
    const notice = page.getByTestId('checkout-returned')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Sei tornato dalla pagina di pagamento')
    await expect(notice).toContainText('controlla lo stato dell\'ordine prima di pagare di nuovo')
    await expect(notice).toContainText('Il carrello è rimasto com')
    await expect(notice).toContainText('verificheremo la tua identità')
    expect(await notice.innerText()).not.toMatch(FORBIDDEN)
    await expect(notice.getByRole('link', { name: "Controlla lo stato dell'ordine" })).toHaveAttribute('href', `/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('pay-button'), 'the customer is not told to pay, and is not stopped either: the server decides').toBeEnabled()
    expect(await storedCart(page)).toBe(1)
    await expectFitsScreen(page, 'return notice')
    await expectTouchTargets(page, '[data-testid="checkout-returned"] a', 'return notice')
  })

  test('back from Stripe, this browser remembers NO order (another browser, data cleared): the same notice, no link to an order, still the shop', async ({ page, context }) => {
    await install(context)
    await seed(page, { entry: null })
    await page.goto('/checkout?canceled=1')
    const notice = page.getByTestId('checkout-returned')
    await expect(notice).toContainText('Sei tornato dalla pagina di pagamento')
    await expect(notice).toContainText('verificheremo la tua identità')
    await expect(page.getByTestId('checkout-returned-order')).toHaveCount(0)
    expect(await notice.innerText()).not.toMatch(FORBIDDEN)
    expect(await rememberedIds(page)).toEqual([])
  })

  test('the notice of a return is not shown while a payment is being confirmed, or once it is known to have gone through', async ({ page, context }) => {
    const server = await install(context)
    for (const state of ['confirming', 'attention', 'paid']) {
      server.state = state
      await seed(page)
      await page.goto('/checkout?canceled=1')
      await expect(page.locator(state === 'paid' ? '[data-testid="pending-payment-paid"]' : `[data-testid="pending-payment-${state}"]`)).toBeVisible()
      await expect(page.getByTestId('checkout-returned'), state).toHaveCount(0)
      await expect(page.getByText('Sei tornato dalla pagina di pagamento'), state).toHaveCount(0)
    }
  })

  test('the return page, an order that was closed: "Ordine chiuso", what the shop\'s records show, "do not repeat it", the shop - no claim about a charge, no invitation to start again', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'canceled'
    await seed(page)
    await page.goto(`/checkout/success?order=${ORDER}`)
    await expect(page.getByTestId('status-canceled')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ordine chiuso' })).toBeVisible()
    const text = await page.getByTestId('status-canceled').innerText()
    expect(text).toContain('nei nostri registri non risulta pagato')
    expect(text).toContain('non ripeterlo')
    expect(text).toContain('Il carrello è rimasto com')
    expect(text).toContain('verificheremo la tua identità')
    expect(text).not.toMatch(FORBIDDEN)
    expect(await storedCart(page), 'the cart stays').toBe(1)
    await expect.poll(() => rememberedIds(page), { message: 'an order that is closed is not remembered' }).toEqual([])
    await expectFitsScreen(page, 'closed order')
    await expectTouchTargets(page, '[data-testid="status-canceled"] a', 'closed order')
  })

  test('the cart page (English) says the same things as the checkout: the four notes after a verified payment are told apart', async ({ page, context }) => {
    const server = await install(context)
    server.state = 'paid'
    const cases: Array<[Parameters<typeof seed>[1], string, RegExp]> = [
      [{ slot: 'owned' }, 'emptied', /^Your cart has been emptied\.$/],
      [{ slot: 'other' }, 'kept', /may hold a new purchase: check it before paying again/],
      [{ slot: 'legacy' }, 'unlinked', /cannot tie this cart to that payment with certainty/],
    ]
    for (const [options, note, pattern] of cases) {
      await seed(page, options)
      await page.goto('/cart')
      await expect(page.getByTestId('pending-payment-paid')).toContainText('Payment confirmed')
      await expect(page.getByTestId('pending-payment-note'), note).toHaveAttribute('data-note', note)
      await expect(page.getByTestId('pending-payment-note'), note).toHaveText(pattern)
      await expect(page.getByTestId('pending-payment-paid')).not.toContainText('has been emptied and')
    }
  })
})
