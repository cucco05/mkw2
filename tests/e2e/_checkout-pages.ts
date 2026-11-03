// Shared by the R1-2 specs of the cart / checkout / return pages (tests/e2e/checkout-*.responsive.spec.ts): the answers of /api/checkout/* are replaced by fixed ones, so these tests are about the
// PAGES - what they ask, what they write in the browser, what they show - and not about what the server answers (that is tests/security/ and tests/real-run/).
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import { cartItemsSignature } from '../../lib/checkout-client'

export const MIN_TOUCH = 44
export const ORDER = 'clorder0000000000000001'
export const OTHER_ORDER = 'clorder0000000000000099'
export const CART_KEY = 'mwv2:cart'
export const PENDING_KEY = 'mw:pending-orders:v2'
export const KEY_KEY = 'mw:checkout-key:v1'
export const LOCK_NAME = 'mw:checkout:purchase:v1'
export const STRONG_KEY = 'kAbCdEfGhIjKlMnOpQrStUvWxYz012345'
export const OTHER_KEY = 'kZyXwVuTsRqPoNmLkJiHgFeDcBa987654'
export const SLOT_SIGNATURE = 'seeded-quote-signature'
export const TITLE = 'Vaso del test'

export const cartLine = (id = 'ci-return-1', qty = 2) => ({
  cartItemId: id, modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title: TITLE, priceUsd: 10, thumbnail: null, size: { x: 80, y: 80, z: 60 },
  colorSlotCount: 1, allowedColors: null,
  options: { qty, scale: 1, material: 'PLA', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, lockedConfig: false, productTemplateId: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null },
})
export const SIGNATURE = cartItemsSignature([cartLine() as never])
export const OTHER_SIGNATURE = cartItemsSignature([cartLine('ci-other', 1) as never])

export const quote = () => ({
  currency: 'EUR',
  items: [{ title: TITLE, partName: null, qty: 2, material: 'PLA', colors: ['#ffffff'], finish: null, unitPriceCents: 1250, lineTotalCents: 2500, undiscountedLineTotalCents: 2500, discountPercent: 0, leadTimeHours: null }],
  itemsTotalCents: 2500, discountPercent: 0, shipping: { method: 'pickup', cents: 0, label: null },
  shippingOffer: { shipAvailable: false, shipCents: 0, shipLabel: null, shipCountries: [] }, tax: { mode: 'none', ratePercent: 0, cents: 0, addedToTotal: false },
  totalCents: 2500, canCheckout: true, unavailableReason: null,
})
export const statusAnswer = (state: string) => ({ orderNumber: 12, state, totalCents: 2500, currency: 'EUR', final: ['paid', 'attention', 'canceled'].includes(state), pollAfterMs: state === 'confirming' ? 2500 : null })

// What the server "says" about the order: change it between steps, every tab asks the same one. `sessions` are the bodies of the payment requests that reached the server.
export type Server = { state: string | 404 | 'down'; asked: string[]; sessions: string[]; session: (route: Route) => Promise<void> | void }
export async function install(context: BrowserContext): Promise<Server> {
  const server: Server = {
    state: 'confirming', asked: [], sessions: [],
    session: (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orderId: ORDER, orderNumber: 12, url: 'https://checkout.stripe.com/c/pay/cs_test_fake', totalCents: 2500 }) }),
  }
  await context.route('**/api/checkout/status**', (route) => {
    server.asked.push(route.request().url())
    if (server.state === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', error: 'Order not found.' }) })
    if (server.state === 'down') return route.abort('failed')
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusAnswer(server.state)) })
  })
  await context.route('**/api/checkout/quote', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quote()) }))
  await context.route('**/api/checkout/session', async (route) => { server.sessions.push(route.request().postData() || ''); await server.session(route) })
  await context.route('https://checkout.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe (fake)</h1>' }))
  return server
}

// A browser with a cart and, unless `entry` is null, the memory of having sent it to the payment page - with the key of that payment in the slot, carrying its order (unless `slot` says
// otherwise). 'none': nothing in the slot; 'legacy': a key written before R1-2 (no order); 'other': the key of ANOTHER purchase; 'forgotten': the placeholder; 'damaged': not an entry.
export type SlotKind = 'owned' | 'none' | 'legacy' | 'other' | 'forgotten' | 'damaged'
export async function seed(page: Page, opts: { cart?: boolean; entry?: { orderId: string; cartSignature: string } | null; slot?: SlotKind; address?: string } = {}) {
  await page.goto(opts.address ?? '/robots.txt')
  await page.evaluate(([cart, entry, line, cartKey, pendingKey, slot, slotKey, slotSignature, strongKey, otherKey, otherOrder]) => {
    localStorage.clear(); sessionStorage.clear()
    if (cart) localStorage.setItem(cartKey as string, JSON.stringify([line]))
    if (entry) localStorage.setItem(pendingKey as string, JSON.stringify([{ ...(entry as object), at: Date.now() }]))
    const named = entry ? (entry as { orderId: string }).orderId : null
    const base = { signature: slotSignature, totalCents: 2500, key: strongKey }
    if (slot === 'owned' && named) localStorage.setItem(slotKey as string, JSON.stringify({ ...base, orderId: named }))
    if (slot === 'legacy') localStorage.setItem(slotKey as string, JSON.stringify(base))
    if (slot === 'other') localStorage.setItem(slotKey as string, JSON.stringify({ signature: 'another-purchase', totalCents: 999, key: otherKey, orderId: otherOrder }))
    if (slot === 'forgotten') localStorage.setItem(slotKey as string, '')
    if (slot === 'damaged') localStorage.setItem(slotKey as string, '{not json')
  }, [opts.cart !== false, opts.entry === undefined ? { orderId: ORDER, cartSignature: SIGNATURE } : opts.entry, cartLine(), CART_KEY, PENDING_KEY, opts.slot ?? 'owned', KEY_KEY, SLOT_SIGNATURE, STRONG_KEY, OTHER_KEY, OTHER_ORDER] as const)
}

// What the page said in the console that it should not have. One known piece of noise is left out: the models of these fixtures do not exist in the database, and the cart page's own look-up of
// a line's model (GET /api/models/<id>) gets a 404, which the browser reports as a console error. It has nothing to do with the code under test; any OTHER failed request still counts.
const FIXTURE_MODEL_LOOKUP = /Failed to load resource: the server responded with a status of 404 \(Not Found\) \[[^\]]*\/api\/models\/clmodelmodelmodel/
export function collectProblems(page: Page, options: { warnings?: boolean } = {}) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error' && !(options.warnings && message.type() === 'warning')) return
    const text = `${message.type()}: ${message.text()} [${message.location().url}]`
    if (!FIXTURE_MODEL_LOOKUP.test(text)) problems.push(text)
  })
  return problems
}

export const storedCart = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]').length, CART_KEY)
export const rawSlot = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY_KEY)
export const rawMemory = (page: Page) => page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)
export const remembered = (page: Page) => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '[]') as Array<{ orderId: string; cartSignature: string }>), PENDING_KEY)
export const rememberedIds = async (page: Page) => (await remembered(page)).map((entry) => entry.orderId)
export const slotEntry = async (page: Page) => { try { return JSON.parse((await rawSlot(page)) || 'null') as { key: string; orderId?: string; signature: string; totalCents: number } | null } catch { return null } }

export async function expectFitsScreen(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, section'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
export async function expectTouchTargets(page: Page, selector: string, label: string) {
  const controls = page.locator(selector)
  const count = await controls.count()
  expect(count, `${label}: there are controls to measure`).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    const box = await controls.nth(i).boundingBox()
    if (!box) continue
    expect(box.height, `${label}: control ${i} height`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
  }
}
export const cartCheckout = (page: Page) => page.getByRole('link', { name: 'Checkout' }).or(page.getByRole('button', { name: 'Checkout', exact: true })).first()

// ---- the lock service, as a page can be given it ---------------------------------------------------------------------------------------------------------------
// Installed with context.addInitScript, BEFORE the page's scripts. `gate`: the purchase lock is not granted until `window.__gate.open()` (a request that is asked for while it is closed waits in
// the page's own queue, and a cancel through its signal is honoured); `broken-*`: the service is offered and does not work; `absent`: the browser does not offer it at all.
export const locksGateScript = () => `
(() => {
  const real = navigator.locks
  const gate = (window.__gate = { closed: true, waiting: [], requests: 0, granted: 0, released: 0, aborted: 0 })
  gate.open = () => { gate.closed = false; for (const go of gate.waiting.splice(0)) go() }
  gate.close = () => { gate.closed = true }
  const manager = {
    request(name, options, callback) {
      gate.requests++
      const run = () => real.request(name, options, async (lock) => { gate.granted++; try { return await callback(lock) } finally { gate.released++ } })
      if (name !== '${LOCK_NAME}' || !gate.closed) return run()
      return new Promise((resolve, reject) => {
        const go = () => run().then(resolve, reject)
        gate.waiting.push(go)
        options && options.signal && options.signal.addEventListener('abort', () => { const at = gate.waiting.indexOf(go); if (at >= 0) { gate.waiting.splice(at, 1); gate.aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) } }, { once: true })
      })
    },
    query: () => real.query(),
  }
  Object.defineProperty(Navigator.prototype, 'locks', { get() { return manager }, configurable: true })
})()
`
export type LocksBreakage = 'getter-throws' | 'request-throws' | 'request-rejects' | 'no-callback' | 'absent'
export const locksBrokenScript = (how: LocksBreakage, errorName = 'SecurityError') => `
(() => {
  const error = () => Object.assign(new Error('the lock service failed'), { name: '${errorName}' })
  const how = '${how}'
  if (how === 'absent') { delete Navigator.prototype.locks; return }
  const manager = {
    request() {
      if (how === 'request-throws') throw error()
      if (how === 'request-rejects') return Promise.reject(error())
      return Promise.resolve()
    },
  }
  Object.defineProperty(Navigator.prototype, 'locks', { get() { if (how === 'getter-throws') throw error(); return manager }, configurable: true })
})()
`
// Counts every request to the payment endpoint that leaves the page, and every write to the key slot and to the memory of the orders, in the order they happen.
export const spyScript = () => `
(() => {
  const log = (window.__spy = { posts: [], writes: [] })
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input, init) => { const url = typeof input === 'string' ? input : input.url; if (/\\/api\\/checkout\\/session/.test(url)) log.posts.push(init && init.body ? String(init.body) : ''); return nativeFetch(input, init) }
  const nativeSet = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) { if (key === '${KEY_KEY}' || key === '${PENDING_KEY}' || key === '${CART_KEY}') log.writes.push(key + '=' + value); return nativeSet.call(this, key, value) }
  const nativeRemove = Storage.prototype.removeItem
  Storage.prototype.removeItem = function (key) { if (key === '${KEY_KEY}' || key === '${PENDING_KEY}' || key === '${CART_KEY}') log.writes.push(key + ' removed'); return nativeRemove.call(this, key) }
})()
`
declare global {
  interface Window {
    __gate: { closed: boolean; waiting: unknown[]; requests: number; granted: number; released: number; aborted: number; open: () => void; close: () => void }
    __spy: { posts: string[]; writes: string[] }
  }
}
