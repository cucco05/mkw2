// The "Printer machines" admin page on a desktop and on phone-sized screens. It needs a signed-in administrator, so it only runs when
// E2E_ADMIN_TOKEN holds a valid session token for one (a throw-away test database: see docs/CHECKOUT-S2-S3.md, "Prove nel browser"); otherwise skipped.
// The save requests are answered by the test (page.route): this checks the PAGE (layout, targets, what is sent), not the server.
import { expect, test, type Page } from '@playwright/test'

const TOKEN = (process.env.E2E_ADMIN_TOKEN || '').trim()
const MIN_TOUCH = 44

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, label, input, textarea'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}

test.describe('admin: printer machines, every screen size', () => {
  test.skip(!TOKEN, 'E2E_ADMIN_TOKEN is not set')

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'mwv2_token', value: TOKEN, url: baseURL! }])
  })

  test('the machine is listed, nothing sticks out, fields and ticks are thumb-sized, saving sends the data and tells the result', async ({ page }) => {
    const sent: any[] = []
    await page.route('**/api/admin/printer-machines/*', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      sent.push({ method: route.request().method(), body })
      if (body.buildXmm === 0) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid machine', issues: [{ path: 'buildXmm', message: 'Too small' }] }) })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ machine: { id: 'machine_x', ...body, notes: body.notes ?? null } }) })
    })
    await page.goto('/admin/printer-machines')
    const card = page.getByTestId('machine-card').first()
    await expect(card).toBeVisible()
    await expect(card.getByLabel('Name')).toHaveValue('Bambu Lab A1 mini')
    await expectFitsScreen(page, 'machines page')

    for (const box of await card.locator('input:not([type=checkbox]), textarea, button').all()) {
      const size = await box.boundingBox()
      expect(size, 'control is on screen').not.toBeNull()
      expect(size!.height, `control height of ${await box.evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 60))}`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    }
    for (const row of await card.locator('label:has(input[type=checkbox])').all()) {
      const size = await row.boundingBox()
      expect(size!.height, 'tick row height').toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
    }

    // a refused save shows the server's reason
    await card.getByLabel('X', { exact: true }).fill('0')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card.getByRole('alert')).toContainText('buildXmm')
    // a good one tells so, and sends the whole machine
    await card.getByLabel('X', { exact: true }).fill('180')
    await card.getByText('ABS', { exact: true }).click()
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card.getByRole('status')).toContainText('Saved')
    const last = sent.at(-1)
    expect(last.method).toBe('PATCH')
    expect(last.body.allowedMaterials).toContain('ABS')
    expect(last.body.buildXmm).toBe(180)
    await expectFitsScreen(page, 'after saving')
  })
})
