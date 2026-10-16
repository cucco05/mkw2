// Step 4.6 - every economic threshold, in EUROS and to the CENT.
//
// The shop sells in euro. The configuration fields are called `...Usd` for historical reasons (minimumPriceUsd, minimumOrderSubtotalUsd, salePriceUsd): the number
// stored is an amount in the shop's currency and nothing is ever converted (docs/PROGETTO.md, "Cambio di valuta"). What these tests pin down:
//   * the minimum PER UNIT (minimumPriceUsd): 4.99 is lifted to 5.00, 5.00 stays, 5.01 stays;
//   * the minimum ORDER (minimumOrderSubtotalUsd): an order that reaches it exactly is accepted even when the sum of the euros has floating-point noise
//     (8.70 + 1.10 is 9.799999999999999 in floating point), one cent less is refused, one cent more is accepted;
//   * the payment provider's minimum (0.50 EUR) on the TOTAL charged: 0.49 is refused, 0.50 is accepted;
//   * the currency that travels to Stripe is `eur`, and the amounts are the quoted cents.
// Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb, seedShopModel } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'

let fake: Awaited<ReturnType<typeof installFakeCheckout>>
let ipSeq = 0
const nextIp = () => `10.13.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `thr-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV), 'STRIPE_MINIMUM_CHARGE_CENTS', 'TAX_MODE']) saved[key] = process.env[key]

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

const models = new Map<string, string>()
// a model whose price the shop has set by hand (a sale price): the engine uses it as the base price, so the line costs exactly that (at scale 1)
async function modelAt(euros: number): Promise<string> {
  const key = euros.toFixed(2)
  const known = models.get(key)
  if (known) return known
  const prisma = await db()
  const { model } = await seedShopModel({ volumeMm3: 50000 })
  await prisma.model.update({ where: { id: model.id }, data: { salePriceUsd: euros, title: `THR ${key}` } })
  models.set(key, model.id)
  return model.id
}
const body = async (prices: number[]) => ({
  items: await Promise.all(prices.map(async (euros) => ({ modelId: await modelAt(euros), qty: 1, colors: ['#ffffff'], material: 'PLA' }))),
  shipping: { method: 'pickup' as const },
})
async function configure(values: { unit?: number; order?: number | null }) {
  const prisma = await db()
  await prisma.siteConfig.upsert({
    where: { id: 'main' },
    update: { minimumPriceUsd: values.unit ?? 0, minimumOrderSubtotalUsd: values.order === undefined ? 0 : values.order },
    create: { id: 'main', minimumPriceUsd: values.unit ?? 0, minimumOrderSubtotalUsd: values.order === undefined ? 0 : values.order } as any,
  })
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  delete process.env.STRIPE_MINIMUM_CHARGE_CENTS
  delete process.env.TAX_MODE
  await configureTestMachine({ buildXmm: 2000, buildYmm: 2000, buildZmm: 2000 })
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('the minimum per unit, in euros: 4.99 is lifted to 5.00, 5.00 and 5.01 are charged as they are', async () => {
  await configure({ unit: 5 })
  for (const [euros, cents] of [[4.99, 500], [5.0, 500], [5.01, 501], [0.01, 500], [12.34, 1234]] as const) {
    const q = await post('quote', await body([euros]))
    assert.equal(q.status, 200, q.text)
    assert.equal(q.json.items[0].unitPriceCents, cents, `${euros}`)
    assert.equal(q.json.currency, 'EUR')
  }
})

test('the minimum order, in euros and to the cent: an order that reaches it is accepted even when the decimals are noisy; one cent less is refused', async () => {
  const cases: Array<{ prices: number[]; minimum: number; accepted: boolean; note: string }> = [
    { prices: [8.7, 1.1], minimum: 9.8, accepted: true, note: '8.70 + 1.10 is 9.799999999999999 in floating point' },
    { prices: [8.7, 1.09], minimum: 9.8, accepted: false, note: 'one cent short' },
    { prices: [8.7, 1.11], minimum: 9.8, accepted: true, note: 'one cent over' },
    { prices: [0.7, 0.1], minimum: 0.8, accepted: true, note: '0.70 + 0.10 is 0.7999999999999999' },
    { prices: [0.7, 0.09], minimum: 0.8, accepted: false, note: 'one cent short of 0.80' },
    { prices: [0.1, 0.2], minimum: 0.3, accepted: true, note: '0.10 + 0.20 is 0.30000000000000004' },
    { prices: [19.99, 19.99, 19.99], minimum: 59.97, accepted: true, note: 'three lines' },
    { prices: [50], minimum: 50, accepted: true, note: 'a single line exactly at the minimum' },
    { prices: [49.99], minimum: 50, accepted: false, note: 'a single line one cent under' },
  ]
  // (the card minimum of the payment provider is a different threshold, tested below: here it is switched off so that the cases under 0.50 are about the shop's minimum)
  process.env.STRIPE_MINIMUM_CHARGE_CENTS = '0'
  try {
  for (const { prices, minimum, accepted, note } of cases) {
    await configure({ unit: 0, order: minimum })
    const q = await post('quote', await body(prices))
    if (accepted) {
      assert.equal(q.status, 200, `${note}: ${q.text}`)
      assert.equal(q.json.canCheckout, true, note)
    } else {
      assert.equal(q.status, 400, `${note}: ${q.text}`)
      assert.equal(q.json.code, 'MINIMUM_ORDER', note)
      assert.equal(q.json.details.minimumCents, Math.round(minimum * 100), note)
      assert.equal(q.json.details.currency, 'EUR')
    }
  }
  } finally {
    delete process.env.STRIPE_MINIMUM_CHARGE_CENTS
  }
})

test('the payment provider\'s minimum is measured on the TOTAL charged, in cents: 0.49 is refused, 0.50 accepted', async () => {
  await configure({ unit: 0, order: 0 })
  const under = await post('quote', await body([0.49]))
  assert.equal(under.status, 400, under.text)
  assert.equal(under.json.code, 'BELOW_PAYMENT_MINIMUM')
  assert.equal(under.json.details.minimumCents, 50)
  assert.equal(under.json.details.totalCents, 49)
  const exact = await post('quote', await body([0.5]))
  assert.equal(exact.status, 200, exact.text)
  assert.equal(exact.json.totalCents, 50)
})

test('the amounts that reach Stripe are the quoted cents in euro, and the order keeps them', async () => {
  await configure({ unit: 5, order: 0 })
  const request = await body([8.7, 1.1]) // 8.70 stays, 1.10 is lifted to 5.00
  const q = await post('quote', request)
  assert.equal(q.status, 200, q.text)
  assert.deepEqual(q.json.items.map((item: any) => item.unitPriceCents), [870, 500])
  assert.equal(q.json.itemsTotalCents, 1370)
  assert.ok(!q.text.includes('$') && !q.text.includes('USD'), 'no dollars in a euro shop')
  const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...request })
  assert.equal(s.status, 200, s.text)
  const params = fake.state.lastParams
  assert.ok(params.line_items.every((line: any) => line.price_data.currency === 'eur'))
  assert.deepEqual(params.line_items.map((line: any) => line.price_data.unit_amount * line.quantity), [870, 500])
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: s.json.orderId } })
  assert.equal(order.currency, 'EUR')
  assert.equal(order.totalCents, q.json.totalCents)
})
