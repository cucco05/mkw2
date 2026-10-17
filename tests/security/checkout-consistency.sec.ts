// Step 4.2-bis – the same amount, to the cent, from the cart to the quote, the order and Stripe.
//
// For every cart of tests/security/_checkout-scenarios.ts the cart is turned into a request EXACTLY as the page does it
// (lib/checkout-client.ts), quoted, "paid" (a session is created with the total that was shown) and then three numbers are compared:
//   quote total  ==  order total  ==  what the Stripe SDK was asked to charge (sum of the lines it received),
// together with every part of it (items, shipping, tax), the currency, and the way a Stripe session is tied to its order.
// Also: what the cart chose is what the order stores (fields), a cart edited after the quote can not use the old price, a product that
// stops being available is refused. Whatever differs from what a customer should expect is a `todo` test (known, awaiting a decision).
// Fake Stripe (tests/security/_fake-checkout.ts), throw-away database, fake data. Nothing is paid: the return from Stripe is step 4.3.
// MATRIX_OUT=/path/file.json writes the numbers of every scenario (used for docs/VERIFICA-CARRELLO-PREVENTIVO-STRIPE.md).
import { db, resetDb } from './_harness'
import { guestHeaders } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import { SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels, type Scenario, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { buildOrderCreateData } from '../../lib/orders'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let data: ScenarioData
const matrix: Array<Record<string, unknown>> = []

const ENV_KEYS = ['CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'SHIPPING_FLAT_RATE_CENTS', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX'] as const
const saved: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = key in values ? values[key] : undefined
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
}
const baseEnv = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }

let ipSeq = 0
const nextIp = () => `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `cons-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
async function post(route: 'quote' | 'session', body: unknown, viewer: Viewer | null = null) {
  viewerGuards.getViewer = async () => viewer
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function fresh(env: Parameters<typeof setEnv>[0] = {}) {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, lastParams: null, allParams: [], rejectCreate: false })
  setEnv({ ...baseEnv, ...env })
}

test.before(async () => {
  await resetDb()
  await seedScenarioConfig()
  data = await seedScenarioModels()
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
  if (process.env.MATRIX_OUT) writeFileSync(process.env.MATRIX_OUT, JSON.stringify({ data, scenarios: SCENARIOS, matrix }, null, 1))
})

const viewerOf = (s: Scenario): Viewer | null => (s.who === 'discount' ? { id: data.discountUser.id, role: 'customer' } : null)
const cartOf = (s: Scenario) => s.items.map((spec, i) => persistedCartItem(spec, data, i))
const requestOf = (s: Scenario) => buildQuoteRequest(cartOf(s) as any, { shippingMethod: s.shipping, rush: Boolean(s.rush) })
const sumLines = (lines: any[]) => lines.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0)
const keyOfItem = (i: { modelId: string | null; partId?: string | null; quantity?: number; qty?: number; material: string }) => `${i.modelId}|${i.partId ?? ''}|${i.quantity ?? i.qty}|${i.material}`

// ====================================================================================================================================
// 1. quote == order == Stripe, to the cent, for every cart
// ====================================================================================================================================
for (const scenario of SCENARIOS) {
  test(`${scenario.id} · ${scenario.label}: quote = order = Stripe`, async () => {
    await fresh({ TAX_MODE: scenario.tax.mode, TAX_RATE_PERCENT: scenario.tax.rate, ...(scenario.shippingCents !== undefined ? { SHIPPING_FLAT_RATE_CENTS: scenario.shippingCents } : {}) })
    const prisma = await db()
    const request = requestOf(scenario)
    const viewer = viewerOf(scenario)

    // -- the quote
    const q = await post('quote', request, viewer)
    assert.equal(q.status, 200, q.text)
    const quote = q.json
    assert.equal(quote.currency, 'EUR')
    assert.equal(quote.shipping.method, scenario.shipping)
    const quoteLines = quote.items.reduce((sum: number, l: any) => sum + l.lineTotalCents, 0)
    assert.equal(quoteLines, quote.itemsTotalCents, 'the lines add up to the items total')
    for (const line of quote.items) assert.equal(line.unitPriceCents * line.qty, line.lineTotalCents, `line "${line.title}": unit x quantity is the line total (no cent lost)`)
    assert.equal(quote.shipping.cents, scenario.shipping === 'ship' ? Number(scenario.shippingCents ?? '700') : 0)
    // an independent calculation of the tax (not the code under test)
    const taxable = quote.itemsTotalCents + quote.shipping.cents
    const rate = Number(scenario.tax.rate ?? '0')
    const expectedTax = scenario.tax.mode === 'exclusive' ? Math.round((taxable * rate) / 100) : scenario.tax.mode === 'inclusive' ? Math.round((taxable * rate) / (100 + rate)) : 0
    assert.equal(quote.tax.cents, expectedTax, 'tax')
    assert.equal(quote.tax.addedToTotal, scenario.tax.mode === 'exclusive')
    assert.equal(quote.totalCents, taxable + (scenario.tax.mode === 'exclusive' ? expectedTax : 0), 'total = items + shipping (+ tax when it is added)')
    // customer discount: the percentage the account has, per line, unless the model excludes discounts
    const wantsDiscount = scenario.who === 'discount'
    for (const [i, line] of quote.items.entries()) {
      const excluded = scenario.items[i].model === 'D'
      const expectedPercent = wantsDiscount && !excluded ? 15 : 0
      assert.equal(line.discountPercent, expectedPercent, `discount of line ${i + 1}`)
      const adjustedUnit = line.undiscountedLineTotalCents / line.qty
      assert.ok(Math.abs(line.unitPriceCents - adjustedUnit * (1 - expectedPercent / 100)) <= 1.01, `line ${i + 1}: unit price after discount is ${expectedPercent}% below the undiscounted one (within a cent)`)
    }

    // -- the order, made with the total that was shown
    const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: quote.totalCents, ...request }, viewer)
    assert.equal(s.status, 200, s.text)
    const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: s.json.orderId }, include: { items: true, paymentAttempts: true } })
    assert.equal(order.totalCents, quote.totalCents, 'order total = quote total')
    assert.equal(s.json.totalCents, quote.totalCents, 'the answer of the session endpoint = quote total')
    assert.equal(order.currency, 'EUR')
    assert.equal(order.shippingCents, quote.shipping.cents)
    assert.equal(order.taxCents, quote.tax.cents)
    assert.equal(order.items.reduce((sum, item) => sum + item.totalCents, 0), quote.itemsTotalCents, 'stored lines add up to the quoted items total')
    const stored = [...order.items].map((item) => `${keyOfItem(item)}|${item.unitPriceCents}|${item.totalCents}`).sort()
    const quoted = request.items.map((entry, i) => `${data.ids[scenario.items[i].model]}|${entry.partId ?? ''}|${entry.qty}|${entry.material}|${quote.items[i].unitPriceCents}|${quote.items[i].lineTotalCents}`).sort()
    assert.deepEqual(stored, quoted, 'every stored line has the quantity, material, unit price and total that were quoted')

    // -- what the Stripe SDK was asked
    assert.equal(fake.state.createCalls, 1)
    const params = fake.state.lastParams
    const stripeTotal = sumLines(params.line_items)
    assert.equal(stripeTotal, quote.totalCents, 'Stripe total = quote total')
    assert.equal(stripeTotal, order.totalCents, 'Stripe total = order total')
    assert.ok(params.line_items.every((l: any) => l.price_data.currency === 'eur' && Number.isInteger(l.price_data.unit_amount) && l.price_data.unit_amount > 0 && Number.isInteger(l.quantity) && l.quantity >= 1), 'EUR, whole cents, whole quantities')
    const shippingLine = params.line_items.find((l: any) => l.price_data.product_data.name === 'Spedizione in Italia')
    assert.equal(shippingLine ? shippingLine.price_data.unit_amount * shippingLine.quantity : 0, quote.shipping.cents, 'shipping line = quoted shipping')
    const taxLine = params.line_items.find((l: any) => l.price_data.product_data.name === 'IVA')
    assert.equal(taxLine ? taxLine.price_data.unit_amount : 0, scenario.tax.mode === 'exclusive' ? quote.tax.cents : 0, 'a tax line only when the tax is added on top, never twice')
    const itemLines = params.line_items.filter((l: any) => l !== shippingLine && l !== taxLine)
    assert.equal(sumLines(itemLines), quote.itemsTotalCents, 'item lines sent to Stripe = quoted items total')
    assert.equal(itemLines.length, order.items.length, 'one Stripe line per order line')
    assert.equal(params.shipping_address_collection === undefined, scenario.shipping === 'pickup', 'an address is asked for only when shipping')
    assert.equal(params.mode, 'payment')
    assert.deepEqual(params.payment_method_types, ['card'])

    // -- the session belongs to this order, and only to it
    const attempt = order.paymentAttempts[0]
    const session = [...fake.sessions.values()].at(-1)!
    assert.equal(order.paymentAttempts.length, 1)
    assert.equal(attempt.stripeSessionId, session.id)
    assert.equal(attempt.amountCents, order.totalCents)
    assert.equal(attempt.currency, 'EUR')
    assert.equal(session.amount_total, order.totalCents)
    assert.equal(session.currency, 'eur')
    assert.equal(session.client_reference_id, order.id)
    assert.equal(session.metadata.orderId, order.id)
    assert.equal(session.metadata.attemptId, attempt.id)
    assert.equal(params.payment_intent_data.metadata.orderId, order.id)
    assert.equal(params.payment_intent_data.metadata.attemptId, attempt.id)
    assert.equal(s.json.url, session.url)
    assert.equal(order.stripePaymentIntentId, null, 'nothing is paid yet')
    assert.equal(order.status, 'awaiting_payment')

    matrix.push({
      id: scenario.id, label: scenario.label,
      quoteItemsCents: quote.itemsTotalCents, quoteShippingCents: quote.shipping.cents, quoteTaxCents: quote.tax.cents, quoteTaxAdded: quote.tax.addedToTotal, quoteTotalCents: quote.totalCents,
      orderTotalCents: order.totalCents, stripeTotalCents: stripeTotal,
      stripeLines: params.line_items.map((l: any) => `${l.quantity} x ${l.price_data.unit_amount}`),
      quoteUnits: quote.items.map((l: any) => `${l.qty} x ${l.unitPriceCents}`),
    })
  })
}

// ====================================================================================================================================
// 2. what the cart chose is what the order stores (every field)
// ====================================================================================================================================
test('fields: model, part, product, material, colours, finish, infill, scale, quantity and tolerance travel from the cart to the quote, the order and the production report', async () => {
  await fresh({ TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '22' })
  const prisma = await db()
  const scenario: Scenario = {
    id: 'F1', label: 'every field', shipping: 'ship', tax: {}, rush: true,
    items: [
      { model: 'V', qty: 3, material: 'petg', colors: ['#ffffff', '#ff0000'], finish: 'gloss', infillPct: 40, scale: 1.25, toleranceClass: 'cosmetic' },
      { model: 'P', part: 2, qty: 2, material: 'ABS', colors: ['#00ff00'], finish: 'matte' },
      { model: 'T', qty: 2, variantColor: '#ffd700' },
    ],
  }
  const cart = cartOf(scenario)
  const request = requestOf(scenario)
  const q = await post('quote', request)
  assert.equal(q.status, 200, q.text)
  const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...request })
  assert.equal(s.status, 200, s.text)
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: s.json.orderId }, include: { items: true } })
  const lines = (order.metadata as any).checkout.lines as any[]
  const byQty = (qty: number, partId?: string | null, modelId?: string) => order.items.find((i) => i.quantity === qty && (partId === undefined || (i.partId ?? null) === partId) && (!modelId || i.modelId === modelId))!

  // 1: custom part
  const a = byQty(3, null)
  assert.equal(a.modelId, data.ids.V)
  assert.equal(a.material, 'PETG', 'material, upper case')
  assert.deepEqual(a.colors, ['#ffffff', '#ff0000'])
  assert.equal(a.finish, 'gloss')
  assert.equal(a.infillPct, 40)
  assert.equal((a.configuration as any).toleranceClass, 'cosmetic')
  assert.equal(q.json.items[0].material, 'PETG')
  assert.deepEqual(q.json.items[0].colors, ['#ffffff', '#ff0000'])
  assert.equal(q.json.items[0].finish, 'gloss')
  assert.equal(q.json.items[0].qty, 3)
  // scale: only the scale is sent; the size in millimetres is worked out by the server
  const storedScale = (a.configuration as any).scale
  assert.ok(Math.abs(storedScale - 1.25) < 1e-9, `the scale stored (${storedScale}) is exactly the chosen 1.25`)
  const lineA = lines.find((l) => l.modelId === data.ids.V)
  assert.equal(lineA.qty, 3)
  assert.ok(lineA.targetDimensions && lineA.targetDimensions.x > 100, 'the production report gets the size in millimetres')
  assert.equal(order.items.find((i) => i.quantity === 3)!.customNotes, null)
  // 2: a part of a multipart model
  const b = byQty(2, data.partIds[1], data.ids.P)
  assert.equal(b.partId, data.partIds[1])
  assert.equal(b.partName, 'Coperchio')
  assert.equal(b.material, 'ABS')
  assert.equal(b.finish, 'matte')
  // 3: a ready-made product, sold as the product is configured
  const c = order.items.find((i) => (i.configuration as any)?.productTemplateId === data.productId)!
  assert.equal(c.modelId, data.ids.T)
  assert.equal(c.material, 'PETG')
  assert.equal(c.finish, 'matte')
  assert.deepEqual(c.colors, ['#ffd700'])
  assert.equal(c.quantity, 2)
  assert.equal((c.configuration as any).priceMultiplier, 3, 'the multiplier is the product 1.5 x the gold variant 2.0, from the database')
  // rush and shipping
  assert.equal((order.metadata as any).rush, true)
  assert.equal(order.shippingMethod, 'ship')
  assert.equal(cart.length, 3)
})

// whole cents from decimal prices: 1.15 is 115 cents, 4.35 is 435 (binary floating point says 114.99999999999999 and 434.99999999999994)
test('rounding: stored cents are the ROUNDED decimal price, for the prices where floating point is off by a hair', () => {
  const prices = [1.15, 4.35, 8.2, 10.78, 16.57, 0.57, 2.3, 33.3]
  const data = buildOrderCreateData({
    amountCents: 100, currency: 'EUR', paymentMethod: 'card', paymentStatus: 'pending', shipping: { method: 'pickup' },
    lineItems: prices.map((unitPrice, i) => ({ modelId: `m${i}`, title: `x${i}`, qty: 3, scale: 1, unitPrice, lineTotal: Number((unitPrice * 3).toFixed(2)), material: 'PLA' }) as any),
  })
  const items = (data.items as any).create as Array<{ unitPriceCents: number; totalCents: number }>
  assert.deepEqual(items.map((i) => i.unitPriceCents), prices.map((p) => Math.round(Number((p * 100).toFixed(4)))))
  assert.deepEqual(items.map((i) => i.totalCents), prices.map((p) => Math.round(Number((p * 3 * 100).toFixed(4)))))
})

// ====================================================================================================================================
// 3. a cart edited after the quote can not use the old price
// ====================================================================================================================================
test('edited cart: the total of an earlier quote is refused for any other cart, to the cent, and nothing is created', async () => {
  await fresh()
  const prisma = await db()
  const A: Scenario = { id: 'E1', label: 'A', items: [{ model: 'V', qty: 2 }], shipping: 'pickup', tax: {} }
  const quoteA = (await post('quote', requestOf(A))).json
  const before = { orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), creates: fake.state.createCalls }
  const refuse = async (cartRequest: any, expected: number, why: string) => {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: expected, ...cartRequest })
    assert.equal(r.status, 409, `${why}: ${r.text}`)
    assert.equal(r.json.code, 'PRICE_CHANGED', why)
    return r.json
  }
  // quantity, material, colour count, scale, delivery and urgency changed after the quote, old total kept
  const variants: Array<[string, Scenario]> = [
    ['one more piece', { ...A, items: [{ model: 'V', qty: 3 }] }],
    ['another material', { ...A, items: [{ model: 'V', qty: 2, material: 'PETG' }] }],
    ['a second colour', { ...A, items: [{ model: 'V', qty: 2, colors: ['#ffffff', '#000000'] }] }],
    ['a larger scale', { ...A, items: [{ model: 'V', qty: 2, scale: 1.1 }] }],
    ['shipping instead of pickup', { ...A, shipping: 'ship' }],
    ['urgent', { ...A, rush: true }],
    ['a second line', { ...A, items: [{ model: 'V', qty: 2 }, { model: 'L' }] }],
  ]
  for (const [why, edited] of variants) {
    const json = await refuse(requestOf(edited), quoteA.totalCents, why)
    const truth = (await post('quote', requestOf(edited))).json.totalCents
    assert.equal(json.currentTotalCents, truth, `${why}: the refusal carries the NEW total (${truth}), which the customer has to confirm`)
    assert.notEqual(truth, quoteA.totalCents, `${why}: it really is a different price`)
  }
  // one cent either way
  await refuse(requestOf(A), quoteA.totalCents + 1, 'one cent more')
  await refuse(requestOf(A), quoteA.totalCents - 1, 'one cent less')
  assert.deepEqual({ orders: await prisma.printOrder.count(), attempts: await prisma.paymentAttempt.count(), creates: fake.state.createCalls }, before, 'no order, no attempt, no Stripe call')
  // the right total with the right cart works, and the same key can not be used for another cart afterwards
  const key = newKey()
  const ok = await post('session', { checkoutKey: key, expectedTotalCents: quoteA.totalCents, ...requestOf(A) })
  assert.equal(ok.status, 200, ok.text)
  const reuse = await post('session', { checkoutKey: key, expectedTotalCents: quoteA.totalCents, ...requestOf({ ...A, items: [{ model: 'V', qty: 2, colors: ['#000000'] }] }) })
  assert.equal(reuse.status, 409)
  assert.equal(reuse.json.code, 'CHECKOUT_KEY_CONFLICT', 'same total, different colour, same key: it is not the same payment')
  assert.equal(await prisma.printOrder.count(), before.orders + 1)
})

test('availability: a model withdrawn between the quote and the payment is refused, with no order and no Stripe call', async () => {
  await fresh()
  const prisma = await db()
  const A: Scenario = { id: 'E2', label: 'A', items: [{ model: 'V' }, { model: 'L' }], shipping: 'pickup', tax: {} }
  const q = await post('quote', requestOf(A))
  assert.equal(q.status, 200, q.text)
  await prisma.model.update({ where: { id: data.ids.L }, data: { visibility: 'private' } })
  try {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...requestOf(A) })
    assert.equal(r.status, 404, r.text)
    assert.equal(r.json.code, 'ITEM_UNAVAILABLE')
    assert.deepEqual(r.json.details, { itemIndexes: [1] }, 'it names the line')
    assert.equal(await prisma.printOrder.count(), 0)
    assert.equal(fake.state.createCalls, 0)
    assert.equal((await post('quote', requestOf(A))).status, 404)
  } finally {
    await prisma.model.update({ where: { id: data.ids.L }, data: { visibility: 'public' } })
  }
})

// ====================================================================================================================================
// 4. KNOWN DIFFERENCES (todo): written as the behaviour a customer should expect; they fail today and are waiting for a decision
// ====================================================================================================================================
test('an unknown material is not sold at the price of PLA', async () => {
  await fresh()
  const request = requestOf({ id: 'T1', label: 'x', items: [{ model: 'V' }], shipping: 'pickup', tax: {} })
  for (const material of ['PEEK', 'TITANIUM']) {
    const r = await post('quote', { ...request, items: [{ ...request.items[0], material }] })
    // step 4.2-ter (A4): refused for online payment, sent to manual review (details: tests/security/manual-review.sec.ts)
    assert.equal(r.status, 422, `${material} was quoted ${r.json?.totalCents} like PLA and stored as asked`)
    assert.equal(r.json.code, 'MANUAL_REVIEW_REQUIRED')
  }
})

test('an unknown finish is not sold at the price of "standard"', async () => {
  await fresh()
  const request = requestOf({ id: 'T2', label: 'x', items: [{ model: 'V' }], shipping: 'pickup', tax: {} })
  const r = await post('quote', { ...request, items: [{ ...request.items[0], finish: 'gold-plated' }] })
  assert.equal(r.status, 422, `"gold-plated" was quoted ${r.json?.totalCents} like "standard" and stored as asked`)
  assert.equal(r.json.code, 'MANUAL_REVIEW_REQUIRED')
})

test('a part larger than the printer can build is not accepted as an ordinary card order (Bambu Lab A1 mini, 180 x 180 x 180 mm)', async () => {
  await fresh()
  // the vase is 83 x 61 x 48 mm: at the largest scale the configurator allows (5) it is 417 x 306 x 240 mm
  const request = requestOf({ id: 'T5', label: 'x', items: [{ model: 'V', scale: 5 }], shipping: 'pickup', tax: {} })
  const r = await post('quote', request)
  // step 4.2-ter (A8): sent to manual review (limits, orientation, supports, margins: tests/security/printer-limits.sec.ts)
  assert.equal(r.status, 422, `quoted at ${r.json?.totalCents} cents and open for payment: nothing stops a part that does not fit the machine`)
  assert.equal(r.json.code, 'MANUAL_REVIEW_REQUIRED')
})

test('a total below the smallest amount Stripe can charge is refused before an order is made', async () => {
  await fresh()
  // Since step 4.4 a shop WITH a minimum price per piece never sells a resized piece for less than that minimum (tests/security/minimum-after-scale.sec.ts), so the
  // tiny total needs a shop without one; the scenario configuration (5.00) is put back afterwards.
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: 0 } as any })
  try {
    const request = requestOf({ id: 'T3', label: 'x', items: [{ model: 'V', scale: 0.1 }], shipping: 'pickup', tax: {} })
    const r = await post('quote', request)
    // step 4.2-ter (A5): details and the order/Stripe checks are in tests/security/minimum-amounts.sec.ts
    assert.equal(r.status, 400, `the quote says ${r.json?.totalCents} cents (Stripe's smallest charge in euro is 50)`)
    assert.equal(r.json.code, 'BELOW_PAYMENT_MINIMUM')
  } finally {
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: 5 } as any })
  }
})
