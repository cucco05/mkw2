// Step 4.2-ter - the printer cases of the compatibility matrix (cart, quote, order, Stripe), next to the 18 carts of checkout-consistency.sec.ts.
// For each case of PRINTER_SCENARIOS: carts the printer can make are paid online with quote = order = Stripe to the cent; carts it cannot (or that fall
// under a minimum) are refused BEFORE any order or Stripe call, with the reasons the customer is told, and a manual request can be made for the ones
// that need a person. PRINTER_MATRIX_OUT=/path/file.json writes every case with the actual amounts (used in docs/VERIFICA-CARRELLO-PREVENTIVO-STRIPE.md).
import { configureTestMachine, db, resetDb } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { PRINTER_SCENARIOS, persistedCartItem, seedScenarioConfig, seedScenarioModels, type PrinterScenario, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let data: ScenarioData
const matrix: Array<Record<string, unknown>> = []
const ENV_KEYS = ['CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'SHIPPING_FLAT_RATE_CENTS', 'STRIPE_MINIMUM_CHARGE_CENTS', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_MANUAL_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX'] as const
const saved: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]
const setEnv = (values: Record<string, string | undefined>) => { for (const key of ENV_KEYS) { const value = values[key]; if (value === undefined) delete (process.env as any)[key]; else (process.env as any)[key] = value } }
const baseEnv = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_MANUAL_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }

let ipSeq = 0
const nextIp = () => `10.61.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `ps-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
async function post(route: 'quote' | 'session' | 'manual-request', body: unknown) {
  viewerGuards.getViewer = async () => null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route')
    : route === 'session' ? await import('../../app/api/checkout/session/route')
      : await import('../../app/api/checkout/manual-request/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
const sumLines = (lines: any[]) => lines.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0)

test.before(async () => {
  await resetDb()
  await seedScenarioConfig()
  data = await seedScenarioModels('ps')
  fake = await installFakeCheckout()
})
test.after(async () => {
  await configureTestMachine()
  await (await db()).siteConfig.updateMany({ data: { minimumOrderSubtotalUsd: null } as any })
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete (process.env as any)[key]; else (process.env as any)[key] = saved[key] }
  if (process.env.PRINTER_MATRIX_OUT) writeFileSync(process.env.PRINTER_MATRIX_OUT, JSON.stringify({ scenarios: PRINTER_SCENARIOS, matrix }, null, 1))
})

async function prepare(scenario: PrinterScenario) {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  fake.sessions.clear(); fake.byKey.clear()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, lastParams: null, allParams: [], rejectCreate: false })
  setEnv({ ...baseEnv, TAX_MODE: scenario.tax.mode, TAX_RATE_PERCENT: scenario.tax.rate })
  await configureTestMachine(scenario.machineMaterials ? { allowedMaterials: scenario.machineMaterials } : {})
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: scenario.minimumOrder ?? 0 } as any })
  const cart = scenario.items.map((spec, i) => persistedCartItem(spec, data, i))
  return { prisma, request: buildQuoteRequest(cart as any, { shippingMethod: scenario.shipping, rush: Boolean(scenario.rush) }) }
}

for (const scenario of PRINTER_SCENARIOS) {
  test(`${scenario.id} · ${scenario.label}`, async () => {
    const { prisma, request } = await prepare(scenario)
    const q = await post('quote', request)
    const row: Record<string, unknown> = { id: scenario.id, label: scenario.label, expected: scenario.outcome.kind }
    matrix.push(row) // filled in below, by reference

    if (scenario.outcome.kind === 'pay') {
      assert.equal(q.status, 200, q.text)
      const s = await post('session', { ...request, checkoutKey: newKey(), expectedTotalCents: q.json.totalCents })
      assert.equal(s.status, 200, s.text)
      const order = await prisma.printOrder.findFirstOrThrow({ where: { id: s.json.orderId }, include: { items: true } })
      assert.equal(fake.state.createCalls, 1)
      const stripeTotal = sumLines(fake.state.lastParams.line_items)
      assert.equal(order.totalCents, q.json.totalCents, 'order total = quote total')
      assert.equal(stripeTotal, q.json.totalCents, 'Stripe total = quote total')
      assert.equal(s.json.totalCents, q.json.totalCents)
      Object.assign(row, { outcome: 'paid online', quoteItemsCents: q.json.itemsTotalCents, quoteShippingCents: q.json.shipping.cents, quoteTaxCents: q.json.tax.cents, quoteTotalCents: q.json.totalCents, orderTotalCents: order.totalCents, stripeTotalCents: stripeTotal, orders: 1, stripeCalls: 1 })
      return
    }

    if (scenario.outcome.kind === 'refused') {
      assert.equal(q.status, 400, q.text)
      assert.equal(q.json.code, scenario.outcome.code)
      const s = await post('session', { ...request, checkoutKey: newKey(), expectedTotalCents: 1000 })
      assert.equal(s.status, 400, s.text)
      assert.equal(s.json.code, scenario.outcome.code)
      assert.equal(await prisma.printOrder.count(), 0, 'no order')
      assert.equal(fake.state.createCalls, 0, 'Stripe was not called')
      Object.assign(row, { outcome: `refused: ${q.json.code}`, minimumCents: q.json.details?.minimumCents, itemsTotalCents: q.json.details?.itemsTotalCents, totalCents: q.json.details?.totalCents, orders: 0, stripeCalls: 0 })
      return
    }

    // sent to manual review
    assert.equal(q.status, 422, q.text)
    assert.equal(q.json.code, 'MANUAL_REVIEW_REQUIRED')
    assert.equal(q.json.totalCents, undefined, 'no price is offered')
    assert.deepEqual(q.json.details.itemIndexes, scenario.outcome.lines)
    assert.deepEqual(q.json.details.reviews.flatMap((line: any) => line.reasons.map((reason: any) => reason.code)), scenario.outcome.codes)
    const s = await post('session', { ...request, checkoutKey: newKey(), expectedTotalCents: 1000 })
    assert.equal(s.status, 422, s.text)
    assert.equal(s.json.code, 'MANUAL_REVIEW_REQUIRED')
    assert.equal(await prisma.printOrder.count(), 0, 'no order')
    assert.equal(fake.state.createCalls, 0, 'Stripe was not called')
    // the customer can ask for a manual evaluation: a request with no price and no payment, the cart exactly as asked
    const m = await post('manual-request', { ...request, contact: { email: `${scenario.id.toLowerCase()}@example.test` } })
    assert.equal(m.status, 201, m.text)
    const requestOrder = await prisma.printOrder.findFirstOrThrow({ where: { orderNumber: m.json.orderNumber }, include: { items: true } })
    assert.deepEqual([requestOrder.status, requestOrder.paymentStatus, requestOrder.totalCents], ['awaiting_review', 'quote', 0])
    assert.equal(requestOrder.items.length, scenario.items.length, 'the cart is kept as asked: nothing split, merged or resized')
    assert.equal(fake.state.createCalls, 0)
    Object.assign(row, { outcome: 'manual review', reasons: q.json.details.reviews, orders: 0, stripeCalls: 0, requestOrderStatus: requestOrder.status, requestTotalCents: requestOrder.totalCents })
  })
}
