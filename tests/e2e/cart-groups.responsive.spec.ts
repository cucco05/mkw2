// Step 4.6 - the cart with COMPLETE MODELS (a model made of several parts is one unit: one group, one quantity, one size), on a desktop and on phone-sized screens
// (projects "chromium", "mobile" and "mobile-small" of playwright.config.ts).
//
// The server's answers are replaced by fixed ones (page.route): this tests the PAGE - that a group is shown and edited as one thing, that the request tells the
// server which lines are one complete copy, that parts bought one by one are only SUGGESTED as a complete model (the customer chooses, nothing is grouped on
// their behalf), that the checkout stays off until they choose, and that nothing sticks out of a small screen. What the server computes (the price of a set,
// the refusal of a claim that does not hold) is tested by tests/security/sale-units.sec.ts. Needs the app running.
import { expect, test, type Page, type Route } from '@playwright/test'

const MIN_TOUCH = 44
const MODEL = 'clmodelmodelmodel000001'
const PARTS = ['clpartpartpart00000001', 'clpartpartpart00000002', 'clpartpartpart00000003']
const SET_KEY = 'e2eSetKey0001'

type QuoteLine = { modelId?: string; partId?: string; qty?: number; setKey?: string }
type Body = { items?: QuoteLine[]; shipping?: { method?: string }; rush?: boolean }

// A server that knows what a complete model is: lines that share a key (and cover the three parts, one quantity) cost 20.00 per copy, shared 7.00 / 7.00 / 6.00;
// the same parts bought one by one cost 10.00 each; and loose parts that would make a complete model are only suggested.
const quoteFor = (body: Body) => {
  const lines = body.items || []
  const keys = new Set(lines.map((line) => line.setKey).filter(Boolean))
  const isSet = keys.size === 1 && lines.length === PARTS.length && lines.every((line) => line.setKey)
  const shares = [700, 700, 600]
  const items = lines.map((line, index) => {
    const qty = line.qty || 1
    const unit = isSet ? shares[index] : 1000
    return {
      title: 'Robot a tre parti', partName: `Parte ${index + 1}`, qty, material: 'PLA', colors: ['#ffffff'], finish: null, unitPriceCents: unit, lineTotalCents: unit * qty,
      undiscountedLineTotalCents: unit * qty, discountPercent: 0, leadTimeHours: null,
      unit: { kind: isSet ? 'set' : 'part', setOrdinal: isSet ? 1 : null, copies: qty },
    }
  })
  const itemsTotalCents = items.reduce((sum, line) => sum + line.lineTotalCents, 0)
  const looseAll = !isSet && lines.length === PARTS.length && lines.every((line) => !line.setKey) && new Set(lines.map((line) => line.partId)).size === PARTS.length
  return {
    currency: 'EUR', items, itemsTotalCents, discountPercent: 0,
    unitNotices: looseAll ? [{ code: 'COULD_BE_COMPLETE_MODEL', itemIndexes: lines.map((_, index) => index), copies: Math.min(...lines.map((line) => line.qty || 1)) }] : [],
    shipping: { method: 'pickup', cents: 0, label: null },
    shippingOffer: { shipAvailable: false, shipCents: 0, shipLabel: null, shipCountries: [] },
    tax: { mode: 'none', ratePercent: 0, cents: 0, addedToTotal: false },
    totalCents: itemsTotalCents, canCheckout: true, unavailableReason: null,
  }
}

const line = (index: number, setKey: string | null, qty = 1) => ({
  cartItemId: `ci-group-${index}`, modelId: MODEL, partId: PARTS[index], partName: `Parte ${index + 1}`, partIndex: index, setKey, title: 'Robot a tre parti', priceUsd: 10, thumbnail: null,
  size: { x: 40, y: 40, z: 60 }, colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: 'standard', lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})

async function openCart(page: Page, cart: unknown[], asked: Body[] = []) {
  await page.route('**/api/checkout/quote', async (route: Route) => {
    const body = JSON.parse(route.request().postData() || '{}') as Body
    asked.push(body)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quoteFor(body)) })
  })
  await page.goto('/robots.txt')
  await page.evaluate((stored) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('mwv2:cart', JSON.stringify(stored)) }, cart)
  await page.goto('/cart')
}

async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, label, li, dl'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
async function expectTouchTarget(locator: ReturnType<Page['locator']>, label: string) {
  const box = await locator.boundingBox()
  expect(box, `${label} is on screen`).not.toBeNull()
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TOUCH)
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TOUCH)
}
const press = async (page: Page, locator: ReturnType<Page['locator']>) => { if (await page.evaluate(() => 'ontouchstart' in window)) await locator.tap(); else await locator.click() }
const checkoutControl = (page: Page) => page.getByRole('link', { name: 'Checkout' }).or(page.getByRole('button', { name: 'Checkout', exact: true })).first()
const storedCart = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('mwv2:cart') || '[]') as any[])

test.describe('cart with a complete model, every screen size', () => {
  test('a complete model is ONE block with one quantity: the lines of its parts have no quantity or remove button of their own', async ({ page }) => {
    await openCart(page, [0, 1, 2].map((i) => line(i, SET_KEY)))
    await expect(page.getByTestId('cart-group')).toHaveCount(1)
    await expect(page.getByTestId('cart-group')).toContainText('Complete model (3 parts)')
    await expect(page.getByTestId('cart-group-qty')).toHaveText('1')
    await expect(page.getByTestId('cart-group-total')).toContainText(/20[.,]00/)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/20[.,]00/)
    await expect(page.getByTestId('cart-line-in-group')).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Increase quantity', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
    await expect(checkoutControl(page)).toBeEnabled()
    await expectFitsScreen(page, 'cart with a complete model')
    for (const [name, locator] of [
      ['more', page.getByRole('button', { name: 'Increase quantity of the complete model' })],
      ['less', page.getByRole('button', { name: 'Decrease quantity of the complete model' })],
      ['split', page.getByTestId('cart-group-split')],
      ['remove', page.getByTestId('cart-group-remove')],
    ] as const) {
      const box = await locator.boundingBox()
      expect(box, `${name} is on screen`).not.toBeNull()
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(MIN_TOUCH)
    }
    await expectTouchTarget(page.getByRole('button', { name: 'Increase quantity of the complete model' }), 'plus of the model')
  })

  test('the quantity of the model is the quantity of every part, and the server is asked with the three lines under one key', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, [0, 1, 2].map((i) => line(i, SET_KEY)), asked)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/20[.,]00/)
    await press(page, page.getByRole('button', { name: 'Increase quantity of the complete model' }))
    await expect(page.getByTestId('cart-group-qty')).toHaveText('2')
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/40[.,]00/)
    const last = asked[asked.length - 1]
    expect(last.items?.map((item) => item.qty), 'every part follows').toEqual([2, 2, 2])
    expect(new Set(last.items?.map((item) => item.setKey)).size, 'one key').toBe(1)
    expect(last.items?.[0].setKey).toBe(SET_KEY)
    const stored = await storedCart(page)
    expect(stored.map((item) => item.options.qty)).toEqual([2, 2, 2])
    await press(page, page.getByRole('button', { name: 'Decrease quantity of the complete model' }))
    await press(page, page.getByRole('button', { name: 'Decrease quantity of the complete model' }))
    await expect(page.getByText('Cart is empty.')).toBeVisible()
    expect(await storedCart(page)).toEqual([])
  })

  test('the size of one part is the size of the model: the other parts follow, so the model still fits together', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, [0, 1, 2].map((i) => line(i, SET_KEY)), asked)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/20[.,]00/)
    const firstScale = page.locator('input[type="number"][max="5"]').first()
    await firstScale.fill('1.50')
    await expect.poll(async () => (await storedCart(page)).map((item) => item.options.scale)).toEqual([1.5, 1.5, 1.5])
    const stored = await storedCart(page)
    expect(new Set(stored.map((item) => item.setKey)).size, 'still one group').toBe(1)
    await expect.poll(() => asked[asked.length - 1]?.items?.map((item: any) => item.scale ?? 1)).toEqual([1.5, 1.5, 1.5])
  })

  test('"Split into single parts" keeps the lines but ends the claim of a complete model; the server then only SUGGESTS it and Checkout waits for the customer', async ({ page }) => {
    const asked: Body[] = []
    await openCart(page, [0, 1, 2].map((i) => line(i, SET_KEY)), asked)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/20[.,]00/)
    await press(page, page.getByTestId('cart-group-split'))
    await expect(page.getByTestId('cart-group')).toHaveCount(0)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/30[.,]00/)
    expect(asked[asked.length - 1].items?.every((item) => !item.setKey), 'no key any more').toBe(true)
    // the customer must choose: Checkout is off, the notice says why and offers both ways out
    const notice = page.getByTestId('complete-model-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('one by one')
    await expect(checkoutControl(page)).toBeDisabled()
    await expectFitsScreen(page, 'cart with the suggestion')
    await expectTouchTarget(page.getByTestId('group-as-set'), 'group as a complete model')
    await expectTouchTarget(page.getByTestId('confirm-single-parts'), 'keep single parts')
    // grouping again: one group, the cheaper price of the complete model, Checkout on
    await press(page, page.getByTestId('group-as-set'))
    await expect(page.getByTestId('cart-group')).toHaveCount(1)
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/20[.,]00/)
    await expect(page.getByTestId('complete-model-notice')).toHaveCount(0)
    await expect(checkoutControl(page)).toBeEnabled()
    expect(asked[asked.length - 1].items?.every((item) => item.setKey), 'every part under one key').toBe(true)
  })

  test('a cart saved before groups existed (three loose parts): the new price is shown, Checkout is off until the customer chooses, and the choice sticks to THIS cart and THIS price', async ({ page }) => {
    await openCart(page, [0, 1, 2].map((i) => line(i, null)))
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/30[.,]00/)
    await expect(page.getByTestId('complete-model-notice')).toContainText('30')
    await expect(checkoutControl(page)).toBeDisabled()
    // keeping the single parts at this price turns Checkout on
    await press(page, page.getByTestId('confirm-single-parts'))
    await expect(checkoutControl(page)).toBeEnabled()
    // the choice survives a reload: same cart, same price
    await page.reload()
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/30[.,]00/)
    await expect(checkoutControl(page)).toBeEnabled()
    // a different cart (one more piece) asks again
    await press(page, page.getByRole('button', { name: 'Increase quantity' }).first())
    await expect(page.getByTestId('cart-subtotal')).toHaveText(/40[.,]00/)
    await expect(checkoutControl(page)).toBeDisabled()
    await expect(page.getByTestId('confirm-single-parts')).toBeVisible()
  })

  test('removing the whole model removes every one of its lines', async ({ page }) => {
    await openCart(page, [0, 1, 2].map((i) => line(i, SET_KEY)))
    await press(page, page.getByTestId('cart-group-remove'))
    await expect(page.getByText('Cart is empty.')).toBeVisible()
    expect(await storedCart(page)).toEqual([])
  })
})
