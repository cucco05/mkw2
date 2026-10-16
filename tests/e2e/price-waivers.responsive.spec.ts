// The "Minimum price waivers" admin page on a desktop and on phone-sized screens (step 4.6, S3). It needs a signed-in ADMINISTRATOR, so it only runs when
// E2E_ADMIN_TOKEN holds a valid session token for one (a throw-away test database: see docs/CHECKOUT-S2-S3.md, "Prove nel browser"); otherwise skipped.
// The requests that change something are answered by the test (page.route): this checks the PAGE (layout, thumb-sized targets, that the button waits for a
// valid form, what is sent), not the server - the server's rules are tested by tests/security/price-waivers.sec.ts.
import { expect, test, type Page } from '@playwright/test'

const TOKEN = (process.env.E2E_ADMIN_TOKEN || '').trim()
const MIN_TOUCH = 44
const REASON = 'Demo shelf item, sold on purpose below the minimum'

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, label, input, textarea, select'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}

test.describe('admin: minimum price waivers, every screen size', () => {
  test.skip(!TOKEN, 'E2E_ADMIN_TOKEN is not set')

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'mwv2_token', value: TOKEN, url: baseURL! }])
  })

  test('the page fits, every control is thumb-sized, the button waits for a valid form, and a grant then a revocation send what was typed', async ({ page }) => {
    const sent: Array<{ url: string; body: any }> = []
    let waivers: any[] = []
    const overview = () => ({ commonMinimumCents: 500, waivers, fixedPricesWithoutWaiver: [], productsToCheck: [] })
    await page.route('**/api/admin/price-waivers**', async (route) => {
      const request = route.request()
      if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overview()) })
      const body = JSON.parse(request.postData() || '{}')
      sent.push({ url: request.url(), body })
      if (request.url().endsWith('/api/admin/price-waivers')) {
        waivers = [{ id: 'w_1', targetType: body.target.type, targetId: body.target.id, targetTitle: 'Demo lamp', minimumPriceCents: body.minimumPriceCents, reason: body.reason, createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, revokeReason: null, active: true }]
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, waiver: { id: 'w_1', minimumPriceCents: body.minimumPriceCents } }) })
      }
      waivers = waivers.map((w) => ({ ...w, active: false, revokedAt: new Date().toISOString(), revokeReason: body.reason }))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    await page.goto('/admin/price-waivers')
    await expect(page.getByRole('heading', { name: 'Minimum price waivers' })).toBeVisible()
    await expect(page.getByTestId('common-minimum')).toBeVisible()
    await expectFitsScreen(page, 'waivers page')

    for (const box of await page.locator('main input, main textarea, main select, main button').all()) {
      if (!(await box.isVisible())) continue
      const size = await box.boundingBox()
      expect(size, 'control is on screen').not.toBeNull()
      expect(size!.height, `height of ${await box.evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 70))}`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    }

    const grant = page.getByRole('button', { name: 'Grant waiver' })
    await expect(grant).toBeDisabled()
    await page.getByLabel(/^Id of the model/).fill('clmodelmodelmodel000001')
    await page.getByLabel(/^Least price of ONE unit/).fill('2.50')
    await expect(grant, 'no reason yet').toBeDisabled()
    await page.getByLabel(/^Reason/).fill('too short')
    await expect(grant, 'a reason that is too short').toBeDisabled()
    await page.getByLabel(/^Least price of ONE unit/).fill('5.00')
    await page.getByLabel(/^Reason/).fill(REASON)
    await expect(grant, 'the figure is not under the minimum').toBeDisabled()
    await page.getByLabel(/^Least price of ONE unit/).fill('2.50')
    await expect(page.getByTestId('waiver-preview')).toContainText('2.50')
    await expect(grant).toBeEnabled()
    await grant.click()
    await expect(page.getByRole('status').filter({ hasText: 'Waiver recorded' })).toBeVisible()
    expect(sent[0].body).toEqual({ target: { type: 'model', id: 'clmodelmodelmodel000001' }, minimumPriceCents: 250, reason: REASON })
    await expect(page.getByTestId('waiver-row')).toHaveCount(1)
    await expect(page.getByTestId('waiver-row')).toContainText('Active')
    await expectFitsScreen(page, 'after granting')

    // revoking asks for a reason first
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    const confirm = page.getByRole('button', { name: 'Confirm revocation' })
    await expect(confirm).toBeDisabled()
    await page.getByPlaceholder(/Why is it revoked/).fill('No longer on the demo shelf')
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(page.getByTestId('waiver-row')).toContainText('Revoked')
    expect(sent[1].url).toContain('/api/admin/price-waivers/w_1')
    expect(sent[1].body).toEqual({ reason: 'No longer on the demo shelf' })
    await expectFitsScreen(page, 'after revoking')
  })
})
