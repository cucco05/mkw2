// CART-SYNC (known, NOT fixed in R1-2) – what the REAL CartProvider does with a cart that another tab saved. Four behaviours of the cart between tabs, pinned as they are at the commit this
// change started from (the provider's save effect, `storage` listener and initial load are byte for byte what they were: tests/cart-provider-additive.test.ts), so that nobody reads them as
// guarantees and nobody changes them without noticing.
//
// The one fact behind all four: the cart is saved as a WHOLE LIST, and a tab that is told "the saved cart changed" adopts the new list without comparing it to its own, then saves what it
// adopted. Two tabs that change the cart at the same moment, or a late event carrying an older list, therefore end with one of the two versions - not with both.
//   1. storage events delivered out of order: the tab follows the LAST one it is given and saves it back;
//   2. a stale tab rewriting the cart: an older list, delivered after a newer one, replaces it - in BOTH tabs;
//   3. loss of edits across two tabs: both tabs change the cart before either has taken the other's change; one of the two changes is lost;
//   4. resurrection of a cart after payment: a paid cart that was emptied (clearIf, "cleared") comes back when an older save reaches the tab.
// What R1-2 does about it: nothing in the provider. clearIf narrows its own window (a saved cart that is not the one this tab wrote is never emptied: tests/e2e/cart-clear-if...,
// tests/cart-interleavings.test.ts) and the checkout key is forgotten only after the saved cart reads back empty. Whether - and how - to make the cart safe between tabs (merge by line instead
// of replacing the list, no re-saving of an adopted value, a real transaction) is a decision for after R1-6 (docs/CHECKLIST-PRELANCIO.md, CART-SYNC).
//
// The pages are the cart harness (tests/e2e/_cart-harness.tsx), two of them in one browser context, which share the same storage and are told about each other's saves by the browser itself;
// the "late" events are made by hand (`fireStorage`), because a real browser does not let a test hold an event back. No server, no database, no payment; no screen to fit or touch.
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { buildCartHarness, FROZEN_SCHEDULER_SCRIPT } from './_cart-harness-build'

const ORIGIN = 'http://localhost:4173'
type Mode = 'development' | 'production'

const line = (n: number, qty = 1) => ({
  cartItemId: `ci-sync-${n}`, modelId: `clmodelmodelmodel0000${n}`, partId: null, partName: null, title: `Model ${n}`, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})
const PAID = [line(1, 2), line(2, 1)]
const OTHER = [line(3, 1)]

const routed = new WeakSet<BrowserContext>()
const problems = new WeakMap<Page, string[]>()
const titles = (page: Page) => page.evaluate(() => window.__h.items().map((item) => item.title).sort())
const titlesOf = (items: Array<{ title: string }>) => items.map((item) => item.title).sort()
const persistedTitles = (page: Page) => page.evaluate(() => (JSON.parse(window.__h.persisted() ?? '[]') as Array<{ title: string }>).map((item) => item.title).sort())
const settle = (page: Page, ms = 150) => page.evaluate((wait) => new Promise<void>((resolve) => setTimeout(resolve, wait)), ms)
const freeze = (page: Page) => page.evaluate(() => window.__sched.freeze())
const release = (page: Page) => page.evaluate(() => window.__sched.release())
const fire = (page: Page, text: string | null) => page.evaluate((t) => window.__h.fireStorage(t), text)

async function openTab(context: BrowserContext, mode: Mode, existing?: Page, seed?: unknown) {
  if (!routed.has(context)) {
    routed.add(context)
    const code = await buildCartHarness(mode)
    await context.addInitScript(FROZEN_SCHEDULER_SCRIPT)
    await context.route(`${ORIGIN}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/h.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: code })
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>cart harness</title><div id="root"></div><script src="/h.js"></script>' })
    })
  }
  const page = existing ?? await context.newPage()
  const list: string[] = []
  problems.set(page, list)
  page.on('pageerror', (error) => list.push(`pageerror: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') list.push(`${message.type()}: ${message.text()}`) })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate((s) => window.__h.mount({ strict: false, seed: s }), seed)
  await page.waitForFunction(() => window.__h.ready())
  return page
}

test.afterEach(({ context }) => {
  for (const page of context.pages()) expect(problems.get(page) ?? [], 'no error, no warning in the console, no exception in the page').toEqual([])
})

for (const mode of ['development', 'production'] as const) {
  test.describe(`CART-SYNC on the real CartProvider, React ${mode} (known behaviour, NOT changed by R1-2)`, () => {
    test('1. storage events out of order: the tab follows the LAST event it is given and saves it back - whichever order they come in', async ({ page, context }) => {
      await openTab(context, mode, page, PAID)
      await fire(page, '[]')
      await settle(page)
      expect(await titles(page)).toEqual([])
      expect(await page.evaluate(() => window.__h.persisted())).toBe('[]')
      await fire(page, JSON.stringify(OTHER))
      await settle(page)
      expect(await titles(page), 'the older event was followed by a newer one: the newer one is the cart').toEqual(titlesOf(OTHER))
      expect(await persistedTitles(page), 'and it was saved back by the tab that adopted it').toEqual(titlesOf(OTHER))
      // the other way round: the same two events, delivered in the opposite order, end with the opposite cart - the tab cannot tell which of them is "newer"
      await fire(page, '[]')
      await settle(page)
      expect(await titles(page)).toEqual([])
      expect(await page.evaluate(() => window.__h.persisted())).toBe('[]')
    })

    test('2. a stale tab rewriting the cart: an older list delivered after a newer one replaces it in BOTH tabs', async ({ page, context }) => {
      const one = await openTab(context, mode, page, PAID)
      const two = await openTab(context, mode)
      await two.evaluate(() => window.__h.add(7))
      await one.waitForFunction(() => window.__h.items().length === 3)                   // the first tab followed, through the browser's own event
      expect(await titles(one)).toEqual(await titles(two))
      // an older list reaches the first tab late (a tab that was not listening, a delayed delivery): it is adopted, saved, and the second tab follows IT
      await fire(one, JSON.stringify(PAID))
      await one.waitForFunction(() => window.__h.items().length === 2)
      await two.waitForFunction(() => window.__h.items().length === 2)
      expect(await titles(one)).toEqual(titlesOf(PAID))
      expect(await titles(two), 'the line added a moment ago is gone from both tabs').toEqual(titlesOf(PAID))
      expect(await persistedTitles(one)).toEqual(titlesOf(PAID))
    })

    test('3. loss of edits across two tabs: both change the cart before either has taken the other\'s change - one of the two changes is lost', async ({ page, context }) => {
      const one = await openTab(context, mode, page, PAID)
      const two = await openTab(context, mode)
      await freeze(one); await freeze(two)                                                // neither tab renders: each only queues what it is told
      await one.evaluate(() => window.__h.add(8))
      await two.evaluate(() => window.__h.add(9))
      const seen = await two.evaluate(() => window.__h.storageSeen)
      await release(one)                                                                  // the first tab renders and saves its cart ...
      await two.waitForFunction((n) => window.__h.storageSeen > n, seen)                  // ... and the second one is told, while it is still holding its own change
      await release(two)                                                                  // its own change is queued FIRST, the adoption of the other tab's cart after it
      await settle(two); await settle(one)
      expect(await titles(one), 'the cart of the tab that saved first').toEqual([...titlesOf(PAID), 'Added 8'].sort())
      expect(await titles(two), 'the second tab ends with the same cart: its own line (Added 9) is lost').toEqual(await titles(one))
      expect(await persistedTitles(two)).toEqual(await titles(one))
    })

    test('4. resurrection of a cart after payment: a paid cart that was emptied comes back when an older save reaches the tab', async ({ page, context }) => {
      const one = await openTab(context, mode, page, PAID)
      const two = await openTab(context, mode)
      await one.evaluate(() => window.__h.setPaid(window.__h.items()))
      const id = await one.evaluate(() => window.__h.clearIf('paid'))
      await one.waitForFunction((i) => window.__h.results[i] !== undefined, id)
      expect(await one.evaluate((i) => window.__h.results[i], id)).toEqual({ kind: 'cleared' })
      await two.waitForFunction(() => window.__h.items().length === 0)                   // the other tab followed the emptying
      expect(await persistedTitles(one)).toEqual([])
      // a save made before the payment was confirmed reaches the tab now (a tab restored from the cache, a delayed delivery)
      await fire(one, JSON.stringify(PAID))
      await one.waitForFunction(() => window.__h.items().length === 2)
      await two.waitForFunction(() => window.__h.items().length === 2)
      expect(await titles(one), 'the cart that was paid for is back').toEqual(titlesOf(PAID))
      expect(await persistedTitles(two)).toEqual(titlesOf(PAID))
      // The provider has no way to tell this from a legitimate change. What stands between this and a second payment is NOT the cart: it is the key of the paid purchase, which the
      // server refuses to use twice (lib/purchase-intent.ts), and which is forgotten only after the saved cart read back empty - and the message that says "do not pay again".
    })
  })
}
