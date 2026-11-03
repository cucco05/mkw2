// R1-2 (S-07, S-10) – the REAL CartProvider, mounted by the REAL React 19 in a real browser, asked "empty the cart if it still is the paid one" (clearIf) in every way S-10 names.
//
// The rule under test, in one sentence: whatever clearIf answers other than "cleared", NOTHING it queued may empty the cart later - and "cleared" is said only when the new state was
// committed AND the cart saved in this browser reads back empty. The unit tests (tests/cart-clear-if.test.ts) try the engine against a model of React; this file tries it against React:
//   * the scheduler of React is STOPPED and started again (a frozen, backgrounded or starved tab looks like that to React: updates queue, nothing renders, no effect runs);
//   * the same cases run on the development build of React (updaters run twice in Strict Mode) and on the production build;
//   * "premise" tests show, on this very React, the facts the design stands on: a plain setState(updater) on a quiet component is run at once and its answer can not be withdrawn (P1);
//     a tick queued first sends the updater down the ordinary path, where it can still be told to keep everything (P2); and the updates React 19.0.0 renders together - an update made
//     with flushSync is rendered WITH the ones queued before it, in queue order (P3), so the cart's question has no queue to jump whichever way it is dispatched. (Revision 4 of the plan
//     feared the opposite; this test is what showed it wrong. flushSync was still not used: it can not run inside a render or a commit, and it would leave the give-up to luck.)
// The page is a harness (tests/e2e/_cart-harness.tsx), not the site: nothing here needs the server, the database or a payment. It has no screen of its own to fit or to touch, so the
// responsive checks of the other specs do not apply; it runs on the three projects all the same, because the browsers differ in how they schedule.
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { buildCartHarness, FROZEN_SCHEDULER_SCRIPT } from './_cart-harness-build'

const ORIGIN = 'http://localhost:4173'

const line = (n: number, qty = 1) => ({
  cartItemId: `ci-s10-${n}`, modelId: `clmodelmodelmodel0000${n}`, partId: null, partName: null, title: `Model ${n}`, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})
const PAID = [line(1, 2), line(2, 1)]   // the cart that was paid for
const OTHER = [line(3, 1)]              // something else
type Mode = 'development' | 'production'

const seen = new WeakMap<BrowserContext, Set<Mode>>()
const problems = new WeakMap<Page, string[]>()

async function open(page: Page, mode: Mode, options: { strict?: boolean; seed?: unknown; naive?: boolean; keepPage?: boolean } = {}) {
  const context = page.context()
  const code = await buildCartHarness(mode)
  const done = seen.get(context) ?? new Set<Mode>()
  if (!done.has(mode)) {
    done.add(mode); seen.set(context, done)
    await context.addInitScript(FROZEN_SCHEDULER_SCRIPT)
    await context.route(`${ORIGIN}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/h.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: code })
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>cart harness</title><div id="root"></div><script src="/h.js"></script>' })
    })
  }
  const list: string[] = []
  problems.set(page, list)
  page.on('pageerror', (error) => list.push(`pageerror: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') list.push(`${message.type()}: ${message.text()}`) })
  await page.goto(`${ORIGIN}/`)
  await mountHarness(page, options)
}
async function mountHarness(page: Page, options: { strict?: boolean; seed?: unknown; naive?: boolean }) {
  await page.evaluate((o) => window.__h.mount({ strict: Boolean(o.strict), seed: o.seed, naive: o.naive }), options)
  await page.waitForFunction(() => window.__h.ready())
}

const freeze = (page: Page) => page.evaluate(() => window.__sched.freeze())
const release = (page: Page) => page.evaluate(() => window.__sched.release())
const settle = (page: Page, ms = 120) => page.evaluate((wait) => new Promise<void>((resolve) => setTimeout(resolve, wait)), ms)
const setPaid = (page: Page) => page.evaluate(() => window.__h.setPaid(window.__h.items()))
const ask = (page: Page, name: string, waitMs?: number) => page.evaluate(([n, w]) => window.__h.clearIf(n as string, w ? { waitMs: w as number } : undefined), [name, waitMs ?? 0] as const)
async function answer(page: Page, id: number) {
  await page.waitForFunction((i) => window.__h.results[i] !== undefined, id)
  return page.evaluate((i) => window.__h.results[i], id)
}
const state = (page: Page) => page.evaluate(() => ({
  ids: window.__h.items().map((item) => item.cartItemId),
  persisted: window.__h.persisted(),
  writes: [...window.__h.writes],
  calls: { ...window.__h.calls },
  held: window.__sched.held.length,
}))
const persistedIds = (text: string | null) => (JSON.parse(text ?? '[]') as Array<{ cartItemId: string }>).map((item) => item.cartItemId)
const ids = (cart: Array<{ cartItemId: string }>) => cart.map((item) => item.cartItemId)

test.afterEach(({ page }) => {
  expect(problems.get(page) ?? [], 'no error, no warning in the console, no exception in the page').toEqual([])
})

for (const mode of ['development', 'production'] as const) {
  test.describe(`S-10, the real CartProvider on React ${mode}`, () => {
    // ---- the way it should go -----------------------------------------------------------------------------------------------------------
    test('cleared: the paid cart is emptied, the new state is committed and saved - and the engine writes nothing of its own', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      const before = await state(page)
      expect(before.ids).toEqual(ids(PAID))
      const id = await ask(page, 'paid')
      expect(await answer(page, id)).toEqual({ kind: 'cleared' })
      const after = await state(page)
      expect(after.ids).toEqual([])
      expect(after.persisted).toBe('[]')
      expect(after.writes.slice(before.writes.length), 'one write after the question: the provider\'s own effect, with the empty cart').toEqual(['[]'])
      expect(after.calls.paid, 'the question was asked').toBeGreaterThanOrEqual(1)
    })

    test('Strict Mode: the updater and the effects run twice in development - the answer and the result are the same', async ({ page }) => {
      await open(page, mode, { seed: PAID, strict: true })
      await setPaid(page)
      const before = await state(page)
      const id = await ask(page, 'paid')
      expect(await answer(page, id)).toEqual({ kind: 'cleared' })
      const after = await state(page)
      expect(after.ids).toEqual([])
      expect(after.persisted).toBe('[]')
      expect(after.writes.slice(before.writes.length)).toEqual(['[]'])
      if (mode === 'development') expect(after.calls.paid, 'React ran the updater twice').toBeGreaterThanOrEqual(2)
    })

    test('the question may be asked again and again: once the cart is empty it is "cleared" at once, with nothing more written', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      expect(await answer(page, await ask(page, 'paid'))).toEqual({ kind: 'cleared' })
      const before = await state(page)
      expect(await answer(page, await ask(page, 'paid'))).toEqual({ kind: 'cleared' })
      expect((await state(page)).writes).toEqual(before.writes)
    })

    // ---- what the cart holds when the question is asked -------------------------------------------------------------------------------
    test('already-queued updates: a line added just before is part of what is asked about - the cart is not the paid one any more and is kept', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      await page.evaluate(() => window.__h.add(7))          // queued, not rendered
      const id = await ask(page, 'paid')
      await settle(page)                                    // the engine took its fresh task and queued its update behind the line
      await release(page)
      expect(await answer(page, id)).toEqual({ kind: 'kept', reason: 'changed' })
      const after = await state(page)
      expect(after.ids).toHaveLength(3)
      expect(after.ids).toContain(PAID[0].cartItemId)
      expect(persistedIds(after.persisted)).toEqual(after.ids)
    })

    test('a line added right AFTER the question, in the same render: the paid lines go, the new one stays, and the answer is not "cleared"', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      const id = await ask(page, 'paid')
      await settle(page)
      await page.evaluate(() => window.__h.add(7))
      await release(page)
      const result = await answer(page, id) as { kind: string }
      expect(result.kind, 'the cart holds a line, so nobody may act as if it were empty').not.toBe('cleared')
      const after = await state(page)
      expect(after.ids, 'only the new line is left').toHaveLength(1)
      expect(after.ids).not.toContain(PAID[0].cartItemId)
      expect(persistedIds(after.persisted)).toEqual(after.ids)
    })

    test('the question is evaluated on the queue, in order: an update from another tab that is queued but not rendered counts - nothing is brought back after "kept"', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      await page.evaluate((text) => window.__h.fireStorage(text), JSON.stringify([...PAID, ...OTHER]))   // the other tab's cart, queued
      const id = await ask(page, 'paid')
      await settle(page)
      await release(page)
      expect(await answer(page, id)).toEqual({ kind: 'kept', reason: 'changed' })
      await settle(page)
      const after = await state(page)
      expect(after.ids, 'the other tab\'s cart stays, for good').toEqual(ids([...PAID, ...OTHER]))
      expect(persistedIds(after.persisted)).toEqual(after.ids)
    })

    test('asked from a click handler, with an update from another tab still queued: the same - the question does not jump the queue', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      await page.evaluate((text) => window.__h.fireStorage(text), JSON.stringify([...PAID, ...OTHER]))
      await page.getByTestId('ask').click()                 // the handler calls clearIf inside the click
      await settle(page)
      await release(page)
      expect(await answer(page, 1)).toEqual({ kind: 'kept', reason: 'changed' })
      await settle(page)
      expect((await state(page)).ids).toEqual(ids([...PAID, ...OTHER]))
    })

    test('asked from a click handler: the question is put in a task of its own - the click is over, and no user event is current when the predicate is asked', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await page.getByTestId('ask').click()                 // the handler calls clearIf inside the click
      expect(await answer(page, 1)).toEqual({ kind: 'cleared' })
      const events = await page.evaluate(() => window.__h.callEvents)
      expect(events.length, 'the predicate was asked').toBeGreaterThan(0)
      // React renders in a task of its own, posted through a MessageChannel: the event that is current then is a "message" of its scheduler - never the click (that would mean the question
      // was asked inside the click, or in a microtask that follows it, and the update would take the priority of the click)
      expect(events.filter((type) => type !== null && type !== 'message'), 'never inside the click, nor in a microtask that follows it').toEqual([])
    })

    test('two questions at once get the same truth', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      const [a, b] = await page.evaluate(() => [window.__h.clearIf('paid'), window.__h.clearIf('paid')])
      expect(await answer(page, a)).toEqual({ kind: 'cleared' })
      expect(await answer(page, b)).toEqual({ kind: 'cleared' })
      expect((await state(page)).persisted).toBe('[]')
    })

    test('a predicate that throws: nothing is cleared, nothing is claimed, the page does not break', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      const id = await ask(page, 'throws')
      expect(await answer(page, id)).toEqual({ kind: 'unconfirmed', reason: 'not_flushed' })
      const after = await state(page)
      expect(after.ids).toEqual(ids(PAID))
      expect(persistedIds(after.persisted)).toEqual(ids(PAID))
    })

    // ---- the rule of S-10: giving up, and what is still queued --------------------------------------------------------------------------
    test('flush unable to complete: the answer is "not flushed" - and when React wakes up the queued update does NOTHING (the updater is not even asked)', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      const before = await state(page)
      await freeze(page)
      const id = await ask(page, 'paid', 250)
      expect(await answer(page, id)).toEqual({ kind: 'unconfirmed', reason: 'not_flushed' })
      expect((await state(page)).calls.paid ?? 0, 'React has not run the updater: nothing was decided').toBe(0)
      expect((await state(page)).held, 'React is waiting to render').toBeGreaterThan(0)
      await release(page)
      await settle(page, 200)
      const after = await state(page)
      expect(after.ids, 'the cart is intact').toEqual(ids(PAID))
      expect(after.persisted).toBe(before.persisted)
      expect(after.writes, 'nothing was written').toEqual(before.writes)
      expect(after.calls.paid ?? 0, 'the late run of the queued update did not even ask the question').toBe(0)
    })

    test('"not flushed" and then the customer starts something else on the SAME items, or adds a line: whenever React wakes up, nothing is emptied', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      const id = await ask(page, 'paid', 250)
      expect(await answer(page, id)).toEqual({ kind: 'unconfirmed', reason: 'not_flushed' })
      await page.evaluate(() => window.__h.add(9))          // a new line, after the give-up
      await release(page)
      await settle(page, 200)
      const after = await state(page)
      expect(after.ids).toHaveLength(3)
      expect(after.ids.slice(0, 2)).toEqual(ids(PAID))
      expect(persistedIds(after.persisted)).toEqual(after.ids)
      expect(after.calls.paid ?? 0).toBe(0)
    })

    test('control: the old clear() is NOT withdrawable - queued while the scheduler waits, it empties the cart when it wakes up (this is what S-10 forbids)', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await freeze(page)
      await page.evaluate(() => window.__h.clearNow())
      await settle(page)
      expect((await state(page)).ids, 'nothing has happened yet').toEqual(ids(PAID))
      await release(page)
      await settle(page, 200)
      const after = await state(page)
      expect(after.ids).toEqual([])
      expect(after.persisted).toBe('[]')
    })

    test('the tab goes away while the question is open: it is answered at once, not after the wait, and nothing breaks when React wakes up', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      const id = await ask(page, 'paid', 20_000)
      await settle(page)
      const started = Date.now()
      await page.evaluate(() => window.__h.unmount())
      expect(await answer(page, id)).toEqual({ kind: 'unconfirmed', reason: 'not_flushed' })
      expect(Date.now() - started, 'not after the 20 s wait').toBeLessThan(5_000)
      await release(page)
      await settle(page)
      expect(await page.evaluate(() => window.__h.persisted()), 'the saved cart is untouched').not.toBe('[]')
      expect(persistedIds(await page.evaluate(() => window.__h.persisted()))).toEqual(ids(PAID))
      // and a new provider, on the same page, takes the cart and answers like the first one
      await mountHarness(page, { strict: false })
      await setPaid(page)
      expect(await answer(page, await ask(page, 'paid'))).toEqual({ kind: 'cleared' })
    })

    test('the page is reloaded while the question is open: the saved cart is what it was, and the next page finds it', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)
      await ask(page, 'paid', 20_000)
      await settle(page)
      await page.reload()
      await mountHarness(page, { strict: false })
      expect((await state(page)).ids).toEqual(ids(PAID))
      expect(persistedIds((await state(page)).persisted)).toEqual(ids(PAID))
    })

    // ---- the proof: what is saved ---------------------------------------------------------------------------------------------------
    test('persistence that throws: the cart is empty in memory but the browser kept the old one - "not persisted", and a reload brings the cart back (nothing lost)', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await page.evaluate(() => { window.__h.failWrites = true })
      const id = await ask(page, 'paid')
      expect(await answer(page, id)).toEqual({ kind: 'unconfirmed', reason: 'not_persisted' })
      const during = await state(page)
      expect(during.ids, 'in memory it was emptied').toEqual([])
      expect(persistedIds(during.persisted), 'in the browser it was not').toEqual(ids(PAID))
      await page.evaluate(() => { window.__h.failWrites = false })
      await page.reload()
      await mountHarness(page, { strict: false })
      expect((await state(page)).ids, 'the next page shows the cart').toEqual(ids(PAID))
    })

    test('unreadable storage: nothing is queued and the answer is "not persisted"', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await page.evaluate(() => { window.__h.failReads = true })
      const id = await ask(page, 'paid')
      expect(await answer(page, id)).toEqual({ kind: 'unconfirmed', reason: 'not_persisted' })
      await page.evaluate(() => { window.__h.failReads = false })
      const after = await state(page)
      expect(after.calls.paid ?? 0, 'nothing was asked, nothing was queued').toBe(0)
      expect(after.ids).toEqual(ids(PAID))
    })

    test('another tab saved a cart this tab has not taken yet (a real second tab): "kept, other tab" - nothing is queued', async ({ page, context }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      await freeze(page)                                    // this tab does not render the news from the other one
      const other = await context.newPage()
      other.on('pageerror', (error) => problems.get(page)?.push(`pageerror (other tab): ${error.message}`))
      await other.goto(`${ORIGIN}/`)
      await mountHarness(other, { strict: false })
      await other.evaluate(() => window.__h.add(5))         // the other tab saves PAID + one line
      await expect.poll(() => page.evaluate(() => window.__h.persisted()), { message: 'the browser holds the other tab\'s cart' }).toContain('Added 5')
      const id = await ask(page, 'paid')
      expect(await answer(page, id)).toEqual({ kind: 'kept', reason: 'other_tab' })
      expect((await state(page)).calls.paid ?? 0, 'nothing was queued').toBe(0)
      await release(page)
      await settle(page, 200)
      expect((await state(page)).ids.length, 'and this tab follows the other one, as it always did').toBe(3)
      await other.close()
    })

    // ---- React itself: the render is not sliced -----------------------------------------------------------------------------------------
    test('the render of the update and its commit are one task: nothing - not the timer of the wait - runs between the question and the commit', async ({ page }) => {
      await open(page, mode, { seed: PAID })
      await setPaid(page)
      const id = await ask(page, 'slow', 20)                // the question takes 40 ms; the wait is 20 ms
      const result = await answer(page, id) as { kind: string; reason?: string }
      expect(['cleared', 'unconfirmed']).toContain(result.kind)
      const timing = await page.evaluate(() => {
        const h = window.__h
        const start = h.callTimes[0]?.at ?? null
        const commit = h.commits.find((c) => c.count === 0)?.at ?? null
        return { start, commit, between: start !== null && commit !== null ? h.timerFiredAt.filter((t) => t > start && t < commit).length : -1 }
      })
      expect(timing.commit, 'the update was committed').not.toBeNull()
      expect(timing.between, 'no timer ran inside the render').toBe(0)
      // whatever the timer said, it did not leave a half-done state: the cart is empty and, once the effects have run, saved empty
      await expect.poll(async () => (await state(page)).persisted).toBe('[]')
      expect((await state(page)).ids).toEqual([])
      if (result.kind === 'unconfirmed') expect(result.reason).toBe('not_flushed')
    })
  })

  // ---- the facts the design stands on, on this very React -------------------------------------------------------------------------------
  test.describe(`S-10, premises on React ${mode}`, () => {
    test('P1: a plain setState(updater) on a quiet component is run AT ONCE and its answer is kept - cancelling afterwards changes nothing', async ({ page }) => {
      await open(page, mode, { seed: PAID, naive: true })
      await settle(page)
      await freeze(page)
      await page.evaluate(() => window.__h.naive!.plain())
      expect(await page.evaluate(() => window.__h.naive!.calls()), 'the updater already ran, before any render').toBe(1)
      await page.evaluate(() => window.__h.cancelNaive())
      await release(page)
      await settle(page)
      expect(await page.evaluate(() => window.__h.naiveText()), 'the cancelled update emptied the list all the same').toBe('')
    })

    test('P2: with a tick queued first the updater is NOT run at once - it is run at render, so it can still be told to keep everything', async ({ page }) => {
      await open(page, mode, { seed: PAID, naive: true })
      await settle(page)
      await freeze(page)
      await page.evaluate(() => window.__h.naive!.withTick())
      expect(await page.evaluate(() => window.__h.naive!.calls()), 'nothing ran yet').toBe(0)
      await page.evaluate(() => window.__h.cancelNaive())
      await release(page)
      await settle(page)
      expect(await page.evaluate(() => window.__h.naiveText()), 'the cancelled update left the list alone').toBe('1,2,3')
      expect(await page.evaluate(() => window.__h.naive!.calls()), 'and it was asked, once it ran at render').toBeGreaterThanOrEqual(1)
    })

    test('P3: an update made with flushSync is rendered WITH the ones queued before it, in queue order - it does not jump them (React 19 renders the sync, continuous and default lanes together)', async ({ page }) => {
      await open(page, mode, { seed: PAID, naive: true })
      await settle(page)
      await freeze(page)
      await page.evaluate(() => window.__h.naive!.adopt([1, 2, 3, 4]))      // queued before, not rendered
      await page.evaluate(() => window.__h.naive!.guardedSync())
      expect(await page.evaluate(() => window.__h.naiveText()), 'the list that was queued first is what the later update saw: four items, so it kept them').toBe('1,2,3,4')
      await release(page)
      await settle(page)
      expect(await page.evaluate(() => window.__h.naiveText()), 'and nothing comes back or goes later').toBe('1,2,3,4')
    })
  })
}
