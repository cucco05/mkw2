// Step 4.2-ter (A5): two different minimums. The SHOP's minimum order (an administrator's choice) is measured on the products, after discounts, before
// shipping and tax. The PAYMENT PROVIDER's minimum (Stripe's smallest charge) is measured on the total that would be charged, and is refused before an
// order exists. Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb, stripeCalls } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'

let data: ScenarioData
let ipSeq = 0
const nextIp = () => `10.41.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `ma-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = {
  CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', TAX_MODE: 'none', TAX_RATE_PERCENT: undefined as string | undefined,
  STRIPE_MINIMUM_CHARGE_CENTS: undefined as string | undefined, CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000',
}
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
const setEnv = (values: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }

async function post(route: 'quote' | 'session', body: unknown) {
  viewerGuards.getViewer = async () => null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
const requestOf = (items: ItemSpec[], shipping: 'pickup' | 'ship' = 'pickup') => buildQuoteRequest(items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: shipping, rush: false })
// The minimum PRICE OF A PIECE (SiteConfig.minimumPriceUsd, step 4.4: it also holds after a resize). The tests below that need a tiny total - to show what the
// payment provider's minimum does - need a shop without one; every test starts again from the scenario configuration (5.00).
const setPieceMinimum = async (value: number) => { const prisma = await db(); await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: value } as any }) }
const setMinimum = async (value: number | null) => { const prisma = await db(); await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: value } as any }) }

test.before(async () => {
  await resetDb()
  setEnv({ ...ENV, STRIPE_MINIMUM_CHARGE_CENTS: undefined, TAX_RATE_PERCENT: undefined })
  await seedScenarioConfig()
  data = await seedScenarioModels('ma')
  await configureTestMachine()
  await installFakeCheckout()
})
test.beforeEach(async () => { await setMinimum(null); await setPieceMinimum(5); setEnv({ TAX_MODE: 'none', TAX_RATE_PERCENT: undefined, STRIPE_MINIMUM_CHARGE_CENTS: undefined }) })
test.after(async () => {
  await setMinimum(null)
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete (process.env as any)[key]; else (process.env as any)[key] = value }
})

// ---- the payment provider's minimum --------------------------------------------------------------------------------------------------
test('a total below the smallest card payment is refused before an order is made', async () => {
  const prisma = await db()
  await setPieceMinimum(0)
  const tiny = requestOf([{ model: 'V', scale: 0.1 }])
  const quote = await post('quote', tiny)
  assert.equal(quote.status, 400, quote.text)
  assert.equal(quote.json.code, 'BELOW_PAYMENT_MINIMUM')
  assert.equal(quote.json.details.minimumCents, 50)
  assert.ok(quote.json.details.totalCents < 50)
  assert.equal(quote.json.details.currency, 'EUR')
  const before = { orders: await prisma.printOrder.count(), calls: stripeCalls.length }
  const session = await post('session', { ...tiny, checkoutKey: newKey(), expectedTotalCents: 1 })
  assert.equal(session.status, 400, session.text)
  assert.equal(session.json.code, 'BELOW_PAYMENT_MINIMUM')
  assert.equal(await prisma.printOrder.count(), before.orders, 'no order was created')
  assert.equal(stripeCalls.length, before.calls, 'Stripe was not called')
})

test('the boundary is exact: a total equal to the provider\'s minimum is accepted, one cent less is not', async () => {
  const request = requestOf([{ model: 'V' }])
  const total = (await post('quote', request)).json.totalCents as number
  assert.ok(total > 100)
  setEnv({ STRIPE_MINIMUM_CHARGE_CENTS: String(total) })
  assert.equal((await post('quote', request)).status, 200, 'equal to the minimum')
  setEnv({ STRIPE_MINIMUM_CHARGE_CENTS: String(total + 1) })
  const refused = await post('quote', request)
  assert.equal(refused.status, 400)
  assert.equal(refused.json.code, 'BELOW_PAYMENT_MINIMUM')
  assert.equal(refused.json.details.totalCents, total)
})

test('the provider\'s minimum counts what is really charged: shipping and added tax are part of the total', async () => {
  const request = requestOf([{ model: 'V' }])
  const base = (await post('quote', request)).json
  setEnv({ STRIPE_MINIMUM_CHARGE_CENTS: String(base.totalCents + 1) })
  assert.equal((await post('quote', request)).status, 400, 'pickup: just below')
  const shipped = await post('quote', requestOf([{ model: 'V' }], 'ship'))
  assert.equal(shipped.status, 200, 'with shipping (7.00) the total reaches it')
  setEnv({ STRIPE_MINIMUM_CHARGE_CENTS: String(base.totalCents + 100), TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' })
  const taxed = await post('quote', request)
  assert.equal(taxed.status, taxed.json.totalCents >= base.totalCents + 100 ? 200 : 400, 'tax added on top counts as well')
})

// ---- the shop's commercial minimum ---------------------------------------------------------------------------------------------------
test('the shop\'s minimum is measured on the products, not on shipping or tax', async () => {
  const request = requestOf([{ model: 'V' }])
  const unit = (await post('quote', request)).json.itemsTotalCents as number
  await setMinimum(unit / 100 + 1)
  const refused = await post('quote', request)
  assert.equal(refused.status, 400, refused.text)
  assert.equal(refused.json.code, 'MINIMUM_ORDER')
  assert.equal(refused.json.details.minimumCents, unit + 100)
  assert.equal(refused.json.details.itemsTotalCents, unit)
  // shipping would lift the TOTAL above the minimum - it must not satisfy a minimum on the products
  const shipped = await post('quote', requestOf([{ model: 'V' }], 'ship'))
  assert.equal(shipped.status, 400)
  assert.equal(shipped.json.code, 'MINIMUM_ORDER')
  // nor may tax added on top
  setEnv({ TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' })
  const taxed = await post('quote', request)
  assert.equal(taxed.status, 400)
  assert.equal(taxed.json.code, 'MINIMUM_ORDER')
  // exactly at the minimum is enough
  await setMinimum(unit / 100)
  setEnv({ TAX_MODE: 'none', TAX_RATE_PERCENT: undefined })
  assert.equal((await post('quote', request)).status, 200)
})

test('0 means "no minimum" on purpose, and an unset minimum asks for nothing outside production', async () => {
  const request = requestOf([{ model: 'V' }])
  await setMinimum(0)
  assert.equal((await post('quote', request)).status, 200)
  await setMinimum(null)
  assert.equal((await post('quote', request)).status, 200)
})

test('the two minimums are reported separately, each with its own figures', async () => {
  await setPieceMinimum(0)
  const tiny = requestOf([{ model: 'V', scale: 0.1 }])
  await setMinimum(5)
  const shop = await post('quote', tiny)
  assert.equal(shop.json.code, 'MINIMUM_ORDER', 'the shop\'s rule is the first the customer meets')
  assert.equal(shop.json.details.minimumCents, 500)
  await setMinimum(0)
  const provider = await post('quote', tiny)
  assert.equal(provider.json.code, 'BELOW_PAYMENT_MINIMUM')
  assert.equal(provider.json.details.minimumCents, 50)
})

test('a shop WITH a minimum price per piece: the same tiny resize costs the minimum, so it is not under the provider\'s minimum and is not refused by it (step 4.4)', async () => {
  const tiny = requestOf([{ model: 'V', scale: 0.1 }])
  const quote = await post('quote', tiny)
  assert.equal(quote.status, 200, quote.text)
  assert.equal(quote.json.itemsTotalCents, 500, 'one piece at the shop\'s minimum price per piece')
  await setPieceMinimum(0)
  const without = await post('quote', tiny)
  assert.equal(without.status, 400, 'and without that minimum the same cart is the tiny one, refused by the provider\'s minimum')
  assert.equal(without.json.code, 'BELOW_PAYMENT_MINIMUM')
})
