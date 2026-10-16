// The critical journey of a buyer: browse -> look at a model -> add it to the cart -> cart -> checkout page.
//
// Step 4.4 rewrote this test. It used to expect an "Add" button on the MODEL page and stopped there (at line 17) on every commit since it was written: the "Add"
// button has only ever been in the list of the Discover page (components/discover/DiscoverModelList.tsx); the model page offers "Save to cart" in its
// configurator (components/InstantQuoteConfigurator.tsx), which stays off until a colour is chosen. The test was out of step with the pages (obsolete), not
// the pages with the test; it is checked here against the commit before step 4.3 as well (see docs/VERIFICA-4.4.md).
//
// Needs the app running and a shop model that can be bought: the e2e seed (tests/e2e/seed-customer-orders.ts, E2E_FIXTURE) creates one. Otherwise skipped.
// The pricing is the server's, for real (the quote of the app under test). What a local test server can not do is take a card payment - in production the
// checkout is off unless BASE_URL is an https address, and that address can not be both reachable by the server itself and https here - so the one field that
// says "payment is available" (`canCheckout`) is set to true on the way through; everything else in the answer is untouched. The payment itself is covered by
// tests/real-run/checkout-return.ts and tests/real-run/checkout-matrix.ts, which run a real server behind a fake Stripe.
// The colour: a test shop has no filament palette (it comes from the stock service, docs/CHECKLIST-PRELANCIO.md 1.31), so the colour is written into the cart the
// way the other cart specs do it, after the test has checked that the cart really refuses to check out without one.
import { expect, test } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = (process.env.E2E_FIXTURE || '').trim()
const data = FIXTURE && fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { shopModel?: { id: string; title: string } } : null
const shop = data?.shopModel ?? null

test('critical buyer journey: browse -> model page -> add from Discover -> cart (colour needed) -> checkout page', async ({ page }) => {
  test.skip(!shop, 'E2E_FIXTURE with a shop model is not set (see tests/e2e/seed-customer-orders.ts)')
  const model = shop!
  await page.route('**/api/checkout/quote', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, canCheckout: true, unavailableReason: null } })
  })

  await page.goto('/')
  await expect(page.getByRole('link', { name: /Browse Library/i })).toBeVisible()

  await page.goto('/discover')
  await expect(page.getByRole('heading', { name: /Discover Models/i })).toBeVisible()
  const link = page.locator(`a[href="/models/${model.id}"]`).first()
  // Discover keeps its list for 90 seconds and serves the old one while it makes the new one (lib/cache-policy.ts): right after the seed the first visit can still
  // show the models of an earlier run, the next one shows the new list.
  if (!(await link.isVisible())) { await page.waitForTimeout(2000); await page.reload() }
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/models/${model.id}`))
  // the model page configures and saves to the cart; it is off until a colour is chosen
  await expect(page.getByRole('button', { name: /Save to cart/i })).toBeVisible()

  // the Discover list adds with one tap
  await page.goto('/discover')
  // (the whole card is the link to the model page, and the "Add" button sits inside it)
  await page.locator(`a[href="/models/${model.id}"]`).first().getByRole('button', { name: /^Add$/ }).click()
  await expect(page.getByText('1 in cart').first(), 'the list says it was added').toBeVisible()

  await page.goto('/cart')
  await expect(page.getByRole('heading', { name: /Your Cart/i })).toBeVisible()
  await expect(page.getByText(model.title).first()).toBeVisible()
  // no colour, no checkout: the cart says so and the button is off
  await expect(page.getByText(/Choose at least one filament color/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Checkout', exact: true })).toBeDisabled()

  await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('mwv2:cart') || '[]')
    for (const item of items) item.options.colors = ['#ffffff']
    localStorage.setItem('mwv2:cart', JSON.stringify(items))
  })
  await page.reload()
  const checkout = page.getByRole('link', { name: 'Checkout' })
  await expect(checkout).toBeVisible()
  await expect(page.getByTestId('cart-subtotal')).toBeVisible()
  await checkout.click()

  await expect(page).toHaveURL(/\/checkout/)
  await expect(page.getByRole('heading', { name: /Riepilogo e pagamento/i })).toBeVisible()
  await expect(page.getByTestId('pay-button')).toBeVisible()
  await expect(page.getByTestId('checkout-total')).toBeVisible()
})
