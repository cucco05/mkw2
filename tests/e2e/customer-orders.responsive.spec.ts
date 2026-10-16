// The customer area (existing English pages) as step 4.3 changes it, on a desktop and on phone-sized screens: an unpaid order is not "Queued", an order
// left unpaid until the payment page expired goes to the history, money is never hidden there, another customer's order never shows.
// Needs a session, so it runs only against a throw-away test database seeded with tests/e2e/seed-customer-orders.ts; E2E_FIXTURE is the path of the file
// that script wrote. Otherwise skipped. The fit check looks at the page's own content (<main>) and at the width of the whole page; the fixed header of
// signed-in users is a global piece measured separately (docs/PROGETTO.md, responsive audit: at 360 px its right end is 13 px off the screen).
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = (process.env.E2E_FIXTURE || '').trim()
const data = FIXTURE && fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { customerToken: string; orders: Record<string, { id: string; orderNumber: number }> } : null
const MIN_TOUCH = 44

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
const mw = (n: number) => `MW-${String(n).padStart(5, '0')}`

test.describe('customer area: orders, every screen size', () => {
  test.skip(!data, 'E2E_FIXTURE is not set (see tests/e2e/seed-customer-orders.ts)')

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'mwv2_token', value: data!.customerToken, url: baseURL! }])
  })

  test('the list: unpaid orders say so, quote requests have no price, late money is visible, abandoned orders are in the history, others\' orders are absent', async ({ page }) => {
    await page.goto('/customer/orders')
    const o = data!.orders
    const card = (key: string) => page.locator(`[data-testid=order-card]`, { hasText: mw(o[key].orderNumber) })
    const list = page.getByTestId('orders-list')
    await expect(list).toBeVisible()
    for (const [key, kind] of [['awaitingPayment', 'awaiting_payment'], ['confirming', 'confirming'], ['paidQueued', 'production'], ['paidReview', 'under_review'], ['quote', 'quote_requested'], ['lateMoney', 'under_review']] as const) {
      await expect(list.locator('[data-testid=order-card]', { hasText: mw(o[key].orderNumber) }), key).toHaveAttribute('data-kind', kind)
    }
    await expect(list.getByText('Awaiting payment').first()).toBeVisible()
    await expect(card('awaitingPayment')).not.toContainText(/queued/i)
    await expect(card('confirming')).not.toContainText(/queued/i)
    await expect(card('quote')).toContainText('Price to be quoted')
    await expect(card('paidQueued')).toContainText('Queued')
    // the money that arrived after a cancellation is in the main list, not in the history
    await expect(list.locator('[data-testid=order-card]', { hasText: mw(o.lateMoney.orderNumber) })).toHaveCount(1)
    // abandoned: only in the history
    await expect(list.locator('[data-testid=order-card]', { hasText: mw(o.abandoned.orderNumber) })).toHaveCount(0)
    const history = page.getByTestId('orders-history')
    await expect(history).toBeVisible()
    await expect(history).toContainText('(1)')
    expect(await history.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
    const summary = history.locator('summary')
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    await summary.click()
    await expect(history.locator('[data-testid=order-card]', { hasText: mw(o.abandoned.orderNumber) })).toHaveAttribute('data-kind', 'closed_unpaid')
    await expect(history).toContainText('Payment not completed')
    // another customer's order
    await expect(page.getByText('ORDINE-DI-UN-ALTRO')).toHaveCount(0)
    await expect(page.getByText(mw(o.someoneElse.orderNumber))).toHaveCount(0)
    await expectFitsScreen(page, 'orders list')
  })

  test('an unpaid order: its page says it is not paid, has no production to follow and no receipt, and leads back to the cart', async ({ page }) => {
    const o = data!.orders
    await page.goto(`/customer/orders/${o.awaitingPayment.id}`)
    const notice = page.getByTestId('order-payment-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('data-kind', 'awaiting_payment')
    await expect(page.getByTestId('order-badge')).toHaveText('Awaiting payment')
    await expect(page.getByRole('heading', { name: 'Production' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Download receipt/i })).toHaveCount(0)
    await expect(page.getByText('A receipt is available once the payment has been confirmed.')).toBeVisible()
    const cart = notice.getByRole('link', { name: 'Go to your cart' })
    await expect(cart).toHaveAttribute('href', '/cart')
    expect((await cart.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    await expectFitsScreen(page, 'unpaid order')
  })

  test('a paid order keeps its usual page: production, receipt, no payment notice; one under review says so without saying why', async ({ page }) => {
    const o = data!.orders
    await page.goto(`/customer/orders/${o.paidQueued.id}`)
    await expect(page.getByTestId('order-payment-notice')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Production' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Download receipt/i })).toBeVisible()
    await expectFitsScreen(page, 'paid order')

    await page.goto(`/customer/orders/${o.paidReview.id}`)
    const notice = page.getByTestId('order-payment-notice')
    await expect(notice).toHaveAttribute('data-kind', 'under_review')
    await expect(page.getByTestId('order-badge')).toHaveText('Under review')
    await expect(page.locator('body')).not.toContainText(/shipping_country|paymentReviewReason/)
  })

  test('another customer\'s order is not found', async ({ page }) => {
    const response = await page.goto(`/customer/orders/${data!.orders.someoneElse.id}`)
    expect(response!.status()).toBe(404)
    await expect(page.getByText('ORDINE-DI-UN-ALTRO')).toHaveCount(0)
  })
})
