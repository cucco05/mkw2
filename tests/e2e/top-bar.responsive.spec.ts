// The fixed top bar and the width of the pages, for a signed-in customer and for a visitor, on a desktop and on the two phone sizes (projects "chromium",
// "mobile" 393x851 and "mobile-small" 360x640 of playwright.config.ts). Step 4.4.
//
// What this protects (all found on a phone at 360 px):
//   * a page wider than the screen widens the layout of the phone, and the FIXED bar, which follows that width, ends up partly off the screen. (This was first
//     taken for a defect of the bar itself; the bar was fine - /settings/profile and /upload were 44 and 25 px too wide because of a file picker);
//   * for a signed-in visitor the search field started under the hamburger button;
//   * every control of the bar was 36 px: on a phone a thumb needs 44.
// Needs a session, so it runs only against a throw-away test database seeded with tests/e2e/seed-customer-orders.ts (E2E_FIXTURE); otherwise skipped.
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = (process.env.E2E_FIXTURE || '').trim()
const data = FIXTURE && fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { customerToken: string; orders: Record<string, { id: string }> } : null
const MIN_TOUCH = 44
const BAR = ['.app-hamburger-shortcut', '.app-home-shortcut', '.app-user-search-input', '.app-user-shortcut-row button', '.app-user-shortcut-row a', '.app-user-shortcut-row [aria-label="Open notifications"]']

async function measure(page: Page) {
  return page.evaluate((selectors) => {
    const width = document.documentElement.clientWidth
    const seen = new Set<Element>()
    const controls: Array<{ name: string; left: number; right: number; top: number; bottom: number; height: number }> = []
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (seen.has(el)) continue
        seen.add(el)
        const b = el.getBoundingClientRect()
        if (b.width <= 0 || b.height <= 0) continue
        controls.push({ name: (el.getAttribute('aria-label') || el.textContent || el.className).toString().trim().slice(0, 28), left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height })
      }
    }
    const title = document.querySelector('main h1')?.getBoundingClientRect()
    return { width, scrollWidth: document.documentElement.scrollWidth, controls, titleTop: title ? title.top : null }
  }, BAR)
}

async function check(page: Page, path: string, isMobile: boolean, label: string) {
  await page.goto(path)
  await page.waitForTimeout(900) // the bar is drawn once the page has been hydrated
  const m = await measure(page)
  expect(m.scrollWidth, `${label} ${path}: the page is ${m.scrollWidth - m.width}px wider than the screen`).toBeLessThanOrEqual(m.width)
  expect(m.controls.length, `${label} ${path}: the bar has controls`).toBeGreaterThan(1)
  for (const c of m.controls) {
    expect(c.left, `${label} ${path}: "${c.name}" starts off the screen`).toBeGreaterThanOrEqual(-0.5)
    expect(c.right, `${label} ${path}: "${c.name}" ends off the screen (${Math.round(c.right)} > ${m.width})`).toBeLessThanOrEqual(m.width + 0.5)
    if (isMobile) expect(c.height, `${label} ${path}: "${c.name}" is ${Math.round(c.height)} px high`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
  }
  // nothing of the bar sits on top of anything else of the bar
  for (let i = 0; i < m.controls.length; i++) {
    for (let j = i + 1; j < m.controls.length; j++) {
      const a = m.controls[i]; const b = m.controls[j]
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      expect(overlapX > 1 && overlapY > 1, `${label} ${path}: "${a.name}" and "${b.name}" overlap`).toBe(false)
    }
  }
  // and the page starts below the bar
  if (m.titleTop !== null && isMobile) {
    const barBottom = Math.max(...m.controls.map((c) => c.bottom))
    expect(m.titleTop, `${label} ${path}: the title (${Math.round(m.titleTop)}) starts under the bar (${Math.round(barBottom)})`).toBeGreaterThanOrEqual(barBottom - 0.5)
  }
}

test.describe('top bar and page width, every screen size', () => {
  test.skip(!data, 'E2E_FIXTURE is not set (see tests/e2e/seed-customer-orders.ts)')

  test('signed in: the bar fits, does not overlap, has thumb-sized controls, and no page is wider than the screen', async ({ page, context, baseURL, isMobile }) => {
    await context.addCookies([{ name: 'mwv2_token', value: data!.customerToken, url: baseURL! }])
    const order = Object.values(data!.orders)[0].id
    for (const path of ['/cart', '/checkout', '/customer/orders', `/customer/orders/${order}`, `/checkout/success?order=${order}`, '/discover', '/me', '/settings/profile', '/upload']) {
      await check(page, path, Boolean(isMobile), 'signed in')
    }
  })

  test('not signed in: the same, with the shorter bar', async ({ page, isMobile }) => {
    for (const path of ['/', '/discover', '/cart', '/checkout', '/login', '/register']) {
      await page.goto(path)
      await page.waitForTimeout(700)
      const m = await measure(page)
      expect(m.scrollWidth, `visitor ${path}: ${m.scrollWidth - m.width}px wider than the screen`).toBeLessThanOrEqual(m.width)
      for (const c of m.controls) {
        expect(c.right, `visitor ${path}: "${c.name}" ends off the screen`).toBeLessThanOrEqual(m.width + 0.5)
        if (isMobile) expect(c.height, `visitor ${path}: "${c.name}" is ${Math.round(c.height)} px high`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
      }
    }
  })

  test('on a phone the search field is usable: it is not under the hamburger button and is wide enough to type in', async ({ page, context, baseURL, isMobile }) => {
    test.skip(!isMobile, 'a phone layout question')
    await context.addCookies([{ name: 'mwv2_token', value: data!.customerToken, url: baseURL! }])
    await page.goto('/cart')
    await page.waitForTimeout(900)
    const search = page.locator('.app-user-search-input')
    const box = (await search.boundingBox())!
    const burger = (await page.locator('.app-hamburger-shortcut').boundingBox())!
    expect(box.width, 'wide enough to type a few words').toBeGreaterThanOrEqual(150)
    const overlaps = Math.min(box.x + box.width, burger.x + burger.width) - Math.max(box.x, burger.x) > 1 && Math.min(box.y + box.height, burger.y + burger.height) - Math.max(box.y, burger.y) > 1
    expect(overlaps, 'the search field does not start under the hamburger').toBe(false)
    await search.tap()
    await search.fill('vaso')
    await expect(search).toHaveValue('vaso')
  })
})
