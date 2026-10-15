// Step 4.2-ter (A8): the Bambu Lab A1 mini (180 x 180 x 180 mm, 0.4 mm nozzle) is a limit enforced on the SERVER, whatever the page showed: a model that
// does not clearly fit (scale, units, orientation, supports, margins) is never accepted for online payment, never resized and never split without the
// customer's consent - it goes to manual review. The machine's figures are DATA (PrinterMachine), so another machine changes the outcome with no code.
// No slicing: only the stored size of the model or of the part, times the validated scale. Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb, stripeCalls } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { isProductionEligible } from '../../lib/order-payment-policy'

let data: ScenarioData
let ipSeq = 0
const nextIp = () => `10.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `pl-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', STRIPE_MINIMUM_CHARGE_CENTS: '0', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_MANUAL_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]

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
const requestOf = (items: ItemSpec[], extra: Record<string, unknown> = {}) => {
  const request: any = buildQuoteRequest(items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
  request.items = request.items.map((entry: any) => ({ ...entry, ...extra }))
  return request
}
const quoteOf = (items: ItemSpec[], extra: Record<string, unknown> = {}) => post('quote', requestOf(items, extra))
const reasons = (r: { json: any }) => (r.json?.details?.reviews ?? []).flatMap((line: any) => line.reasons.map((x: any) => `${line.itemIndex}:${x.code}`))
const setModel = async (id: string, values: Record<string, unknown>) => { const prisma = await db(); await prisma.model.update({ where: { id }, data: values as any }) }

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  await seedScenarioConfig()
  data = await seedScenarioModels('pl')
  await installFakeCheckout()
})
test.beforeEach(async () => { await configureTestMachine() })
test.after(async () => {
  await configureTestMachine() // leave the machines as the other tests expect them
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ---- the volume ----------------------------------------------------------------------------------------------------------------------
// Vase 83.47 x 61.13 x 47.92 mm; its support need is not known (supportRatio unset), so the usable volume is 168 x 168 x 178 mm.
test('a model that fits at scale 1 is sold; the same model at the largest scale the cart allows (5: 417 x 306 x 240 mm) is not', async () => {
  const ok = await quoteOf([{ model: 'V' }])
  assert.equal(ok.status, 200, ok.text)
  const big = await quoteOf([{ model: 'V', scale: 5 }])
  assert.equal(big.status, 422, big.text)
  assert.equal(big.json.code, 'MANUAL_REVIEW_REQUIRED')
  assert.deepEqual(reasons(big), ['0:TOO_LARGE'])
  const reason = big.json.details.reviews[0].reasons[0]
  assert.deepEqual(reason.sizeMm, { x: 417, y: 306, z: 240 })
  assert.deepEqual(reason.usableMm, { x: 168, y: 168, z: 178 })
  assert.equal(big.json.totalCents, undefined, 'no price is offered for a model that does not fit')
})

test('the limit is exact, with the margins taken off: a scale that just fits is sold, one step more is not', async () => {
  // longest side 83.47 mm goes along Z (178): 178 / 83.47 = 2.1325
  assert.equal((await quoteOf([{ model: 'V', scale: 2.13 }])).status, 200)
  const over = await quoteOf([{ model: 'V', scale: 2.14 }])
  assert.equal(over.status, 422)
  assert.deepEqual(reasons(over), ['0:TOO_LARGE'])
})

test('orientation counts: a side longer than the plate but shorter than the height still fits, turned up', async () => {
  // x scaled to 2.06 -> 171.95 mm: more than the 168 of the plate, less than the 178 of Z; the other sides are small
  assert.equal((await quoteOf([{ model: 'V', dimensionOverrides: { x: 2.06, y: 1, z: 1 } }])).status, 200)
  const over = await quoteOf([{ model: 'V', dimensionOverrides: { x: 2.15, y: 1, z: 1 } }])
  assert.equal(over.status, 422, '179.5 mm fits no axis')
  assert.deepEqual(reasons(over), ['0:TOO_LARGE'])
})

test('per-axis scales are applied axis by axis', async () => {
  // Lampada 51.37 x 49.82 x 119.64: z x1.4 = 167.5 fits; z x1.5 = 179.5 does not
  assert.equal((await quoteOf([{ model: 'L', dimensionOverrides: { x: 1, y: 1, z: 1.4 } }])).status, 200)
  assert.equal((await quoteOf([{ model: 'L', dimensionOverrides: { x: 1, y: 1, z: 1.5 } }])).status, 422)
})

test('a PART is checked at its own size (40 x 40 x 60 mm), not at the size of the whole model', async () => {
  assert.equal((await quoteOf([{ model: 'P', part: 1, scale: 2.9 }])).status, 200, '116 x 116 x 174')
  const over = await quoteOf([{ model: 'P', part: 1, scale: 3 }])
  assert.equal(over.status, 422, '120 x 120 x 180 does not fit')
  assert.deepEqual(reasons(over), ['0:TOO_LARGE'])
})

test('a whole multi-part model is checked part by part: one part that does not fit is enough', async () => {
  const prisma = await db()
  const whole = await quoteOf([{ model: 'P' }], { partId: undefined })
  assert.equal(whole.status, 200, whole.text)
  const part = await prisma.modelPart.findFirstOrThrow({ where: { modelId: data.ids.P } })
  await prisma.modelPart.update({ where: { id: part.id }, data: { sizeXmm: 300 } })
  try {
    const refused = await quoteOf([{ model: 'P' }], { partId: undefined })
    assert.equal(refused.status, 422, refused.text)
    assert.deepEqual(reasons(refused), ['0:TOO_LARGE'])
  } finally {
    await prisma.modelPart.update({ where: { id: part.id }, data: { sizeXmm: 40 } })
  }
})

test('a ready-made product is checked at its locked scale too', async () => {
  const prisma = await db()
  const line: ItemSpec = { model: 'T', qty: 1, variantColor: '#ffffff' }
  assert.equal((await quoteOf([line], { productTemplateId: data.productId })).status, 200)
  await prisma.productTemplate.update({ where: { id: data.productId }, data: { lockedScale: 4 } })
  try {
    const r = await quoteOf([line], { productTemplateId: data.productId })
    assert.equal(r.status, 422, r.text)
    assert.deepEqual(reasons(r), ['0:TOO_LARGE'])
  } finally {
    await prisma.productTemplate.update({ where: { id: data.productId }, data: { lockedScale: 1 } })
  }
})

// ---- what the browser says does not count ------------------------------------------------------------------------------------------------
test('a size sent by the browser neither lets a big model in nor keeps a small one out', async () => {
  const forgedSmall = await quoteOf([{ model: 'V', scale: 5 }], { targetDimensions: { x: 10, y: 10, z: 10 } })
  assert.equal(forgedSmall.status, 422, 'scale 5 is too big whatever size the page claims')
  const forgedBig = await quoteOf([{ model: 'V' }], { targetDimensions: { x: 4000, y: 4000, z: 4000 } })
  assert.equal(forgedBig.status, 200, 'the size in millimetres sent by a page is not read at all')
})

// ---- sizes that cannot be trusted ------------------------------------------------------------------------------------------------------
test('a size that is missing, not in millimetres or implausible is not sold online', async () => {
  const id = data.ids.L
  try {
    await setModel(id, { sizeXmm: null })
    await (await db()).modelPart.updateMany({ where: { modelId: id }, data: { sizeXmm: null } })
    let r = await quoteOf([{ model: 'L' }])
    assert.equal(r.status, 422, r.text)
    assert.deepEqual(reasons(r), ['0:SIZE_UNKNOWN'])
    await setModel(id, { sizeXmm: 51.37 })
    await (await db()).modelPart.updateMany({ where: { modelId: id }, data: { sizeXmm: 51.37 } })

    await setModel(id, { unit: 'in' })
    r = await quoteOf([{ model: 'L' }])
    assert.deepEqual(reasons(r), ['0:UNIT_NOT_MM'])
    await setModel(id, { unit: 'mm' })

    await setModel(id, { sizeXmm: 0.05, sizeYmm: 0.05, sizeZmm: 0.12 })
    await (await db()).modelPart.updateMany({ where: { modelId: id }, data: { sizeXmm: 0.05, sizeYmm: 0.05, sizeZmm: 0.12 } })
    r = await quoteOf([{ model: 'L' }])
    assert.deepEqual(reasons(r), ['0:SIZE_IMPLAUSIBLE'])
  } finally {
    await setModel(id, { unit: 'mm', sizeXmm: 51.37, sizeYmm: 49.82, sizeZmm: 119.64 })
    await (await db()).modelPart.updateMany({ where: { modelId: id }, data: { sizeXmm: 51.37, sizeYmm: 49.82, sizeZmm: 119.64 } })
  }
  assert.equal((await quoteOf([{ model: 'L' }])).status, 200, 'restored')
})

test('too thin to print reliably (below the nozzle) goes to a person', async () => {
  const r = await quoteOf([{ model: 'V', dimensionOverrides: { x: 1, y: 1, z: 0.1 } }])
  assert.equal(r.status, 200, 'z = 4.79 mm: fine')
  const prisma = await db()
  await prisma.model.update({ where: { id: data.ids.F }, data: { sizeZmm: 3 } })
  await prisma.modelPart.updateMany({ where: { modelId: data.ids.F }, data: { sizeZmm: 3 } })
  try {
    const thin = await quoteOf([{ model: 'F', dimensionOverrides: { x: 1, y: 1, z: 0.1 } }], { colors: ['#ffffff'] })
    assert.equal(thin.status, 422, thin.text)
    assert.deepEqual(reasons(thin), ['0:TOO_THIN'])
  } finally {
    await prisma.model.update({ where: { id: data.ids.F }, data: { sizeZmm: 119.64 } })
    await prisma.modelPart.updateMany({ where: { modelId: data.ids.F }, data: { sizeZmm: 119.64 } })
  }
})

// ---- supports and margins, from the machine's data ------------------------------------------------------------------------------------------
test('supports take plate room: a model that needs none can use the 174 mm, one that may need them only 168', async () => {
  // Vase x scaled so that two sides are 171 mm: only possible when supports are known not to be needed
  const lamp = data.ids.L
  const wide = { model: 'L' as const, dimensionOverrides: { x: 3.3, y: 3.4, z: 1 } } // 169.5 x 169.4 x 119.6
  await setModel(lamp, { supportRatio: null })
  assert.equal((await quoteOf([wide])).status, 422, 'support need unknown: 168 x 168 only')
  await setModel(lamp, { supportRatio: 0 })
  assert.equal((await quoteOf([wide])).status, 200, 'no supports: 174 x 174')
  await setModel(lamp, { supportRatio: 0.4 })
  assert.equal((await quoteOf([wide])).status, 422, 'supports needed')
  await setModel(lamp, { supportRatio: null })
})

test('a machine can send heavily supported models to a person (maxSupportRatio)', async () => {
  await setModel(data.ids.V, { supportRatio: 0.7 })
  try {
    assert.equal((await quoteOf([{ model: 'V' }])).status, 200, 'no limit set')
    await configureTestMachine({ maxSupportRatio: 0.5 })
    const r = await quoteOf([{ model: 'V' }])
    assert.equal(r.status, 422)
    assert.deepEqual(reasons(r), ['0:SUPPORT_HEAVY'])
  } finally {
    await setModel(data.ids.V, { supportRatio: null })
  }
})

test('the machine\'s margins are data: wider margins shrink what fits', async () => {
  const edge = { model: 'V' as const, dimensionOverrides: { x: 2.1, y: 1, z: 1 } } // 175.3 mm along the longest side: needs Z (178)
  assert.equal((await quoteOf([edge])).status, 200)
  await configureTestMachine({ marginZmm: 6 }) // Z usable 174
  assert.equal((await quoteOf([edge])).status, 422)
})

// ---- another machine, no code -------------------------------------------------------------------------------------------------------------------
test('adding a bigger machine changes the outcome with data only; switching it off puts the limit back', async () => {
  const request: ItemSpec[] = [{ model: 'V', scale: 3 }] // 250 x 183 x 144
  assert.equal((await quoteOf(request)).status, 422, 'the A1 mini cannot')
  await configureTestMachine({}, [{ key: 'big-machine', label: 'Big machine', buildXmm: 350, buildYmm: 350, buildZmm: 350 }])
  assert.equal((await quoteOf(request)).status, 200, 'a machine that can is enough')
  assert.equal((await quoteOf([{ model: 'V', scale: 5 }])).status, 422, '417 mm does not fit 350 either')
  await configureTestMachine({}, [{ key: 'big-machine', label: 'Big machine', buildXmm: 350, buildYmm: 350, buildZmm: 350, isActive: false }])
  assert.equal((await quoteOf(request)).status, 422, 'switched off: only active machines count')
})

// ---- the payment, the request, and consent ---------------------------------------------------------------------------------------------------------
test('the payment is refused for a model that does not fit: no order, no payment page, nothing sent to Stripe', async () => {
  const prisma = await db()
  const before = { orders: await prisma.printOrder.count(), calls: stripeCalls.length }
  const r = await post('session', { ...requestOf([{ model: 'V', scale: 5 }]), checkoutKey: newKey(), expectedTotalCents: 5000 })
  assert.equal(r.status, 422, r.text)
  assert.equal(r.json.code, 'MANUAL_REVIEW_REQUIRED')
  assert.equal(await prisma.printOrder.count(), before.orders)
  assert.equal(stripeCalls.length, before.calls)
})

test('the customer can ask for a manual evaluation; nothing is resized, split or priced on the way', async () => {
  const prisma = await db()
  const request = { ...requestOf([{ model: 'V', scale: 5 }]), contact: { email: 'big@example.test' }, note: 'I need it this big' }
  const r = await post('manual-request', request)
  assert.equal(r.status, 201, r.text)
  const order = await prisma.printOrder.findFirstOrThrow({ where: { orderNumber: r.json.orderNumber }, include: { items: true } })
  assert.equal(order.status, 'awaiting_review')
  assert.equal(order.paymentStatus, 'quote')
  assert.equal(order.totalCents, 0)
  assert.equal(isProductionEligible(order), false)
  assert.equal((order.items[0].configuration as any).scale, 5, 'the scale asked for is kept exactly: no automatic resizing')
  assert.equal(order.items.length, 1, 'no automatic split into several parts')
  assert.equal((order.metadata as any).manualQuote.reasons[0].reasons[0].code, 'TOO_LARGE')
})
