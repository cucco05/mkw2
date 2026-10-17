// Step 4.2-ter (A4): a material or finish the shop does not know, or no machine offers, is NEVER priced "as if" it were plain PLA / standard: the
// cart cannot be paid online, nothing is created, and the customer can ask for a manual quote instead. The server decides every time (quote and
// payment go through the same builder); the browser's word counts for nothing. Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb, stripeCalls } from './_harness'
import { guestHeaders } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { isProductionEligible } from '../../lib/order-payment-policy'
import { isReprintAwaitingQuote } from '../../lib/reprint'

let data: ScenarioData
let ipSeq = 0
const nextIp = () => `10.21.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `mr-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000', CHECKOUT_MANUAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]

type Viewer = { id: string; role: string } | null
async function post(route: 'quote' | 'session' | 'manual-request', body: unknown, viewer: Viewer = null) {
  viewerGuards.getViewer = async () => viewer as any
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route')
    : route === 'session' ? await import('../../app/api/checkout/session/route')
      : await import('../../app/api/checkout/manual-request/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders() }, body: JSON.stringify(body),
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
const reasonsOf = (r: { json: any }) => (r.json?.details?.reviews ?? []).map((line: any) => ({ at: line.itemIndex, codes: line.reasons.map((x: any) => x.code) }))

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  await seedScenarioConfig()
  data = await seedScenarioModels('mr')
  await installFakeCheckout()
})
test.beforeEach(async () => { await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'TPU'] }) })
test.after(async () => {
  await configureTestMachine() // leave the machines as the other tests expect them
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ---- the quote -----------------------------------------------------------------------------------------------------------------------
test('an unknown material is refused for online payment - never priced as PLA', async () => {
  const ok = await post('quote', requestOf([{ model: 'V' }]))
  assert.equal(ok.status, 200, ok.text)
  const pla = ok.json.totalCents
  for (const material of ['PEEK', 'TITANIUM', 'PETG-CF', 'PLA Matte', 'unobtainium']) {
    const r = await post('quote', requestOf([{ model: 'V' }], { material }))
    assert.equal(r.status, 422, `${material}: ${r.text}`)
    assert.equal(r.json.code, 'MANUAL_REVIEW_REQUIRED', material)
    assert.deepEqual(reasonsOf(r), [{ at: 0, codes: ['MATERIAL_UNKNOWN'] }], material)
    assert.deepEqual(r.json.details.itemIndexes, [0])
    assert.equal(r.json.totalCents, undefined, 'no price is given for it')
  }
  // a known name still works, in any case, and costs what it always cost
  const lower = await post('quote', requestOf([{ model: 'V' }], { material: 'pla' }))
  assert.equal(lower.status, 200)
  assert.equal(lower.json.totalCents, pla)
})

test('an unknown finish is refused for online payment - never priced as standard', async () => {
  const standard = (await post('quote', requestOf([{ model: 'V' }]))).json.totalCents
  for (const finish of ['gold-plated', 'smooth', 'chrome']) {
    const r = await post('quote', requestOf([{ model: 'V' }], { finish }))
    assert.equal(r.status, 422, `${finish}: ${r.text}`)
    assert.deepEqual(reasonsOf(r), [{ at: 0, codes: ['FINISH_UNKNOWN'] }], finish)
  }
  const known = await post('quote', requestOf([{ model: 'V' }], { finish: 'standard' }))
  assert.equal(known.status, 200)
  assert.equal(known.json.totalCents, standard, 'an explicit "standard" is the same as none')
})

test('a known material the machines do not offer (ABS on the A1 mini) goes to manual review; enabling it in the data is enough, no code', async () => {
  const refused = await post('quote', requestOf([{ model: 'V' }], { material: 'ABS' }))
  assert.equal(refused.status, 422, refused.text)
  assert.deepEqual(reasonsOf(refused), [{ at: 0, codes: ['MATERIAL_NOT_AVAILABLE'] }])
  await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'TPU', 'ABS'] })
  const accepted = await post('quote', requestOf([{ model: 'V' }], { material: 'ABS' }))
  assert.equal(accepted.status, 200, accepted.text)
  // and a SECOND machine that offers it is enough as well
  await configureTestMachine({}, [{ key: 'second', label: 'Second machine', allowedMaterials: ['PLA', 'PETG', 'TPU', 'ASA'] }])
  await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'TPU'] }, [{ key: 'second', label: 'Second machine', allowedMaterials: ['PLA', 'ASA'] }])
  assert.equal((await post('quote', requestOf([{ model: 'V' }], { material: 'ASA' }))).status, 200)
})

test('a finish the machines do not offer goes to manual review', async () => {
  await configureTestMachine({ allowedMaterials: ['PLA', 'PETG', 'TPU'], allowedFinishes: ['standard', 'matte'] })
  const r = await post('quote', requestOf([{ model: 'V' }], { finish: 'polished' }))
  assert.equal(r.status, 422)
  assert.deepEqual(reasonsOf(r), [{ at: 0, codes: ['FINISH_NOT_AVAILABLE'] }])
  assert.equal((await post('quote', requestOf([{ model: 'V' }], { finish: 'matte' }))).status, 200)
})

test('with no active machine nothing can be paid online, and the reason says so', async () => {
  await configureTestMachine({ isActive: false })
  const r = await post('quote', requestOf([{ model: 'V' }]))
  assert.equal(r.status, 422, r.text)
  assert.deepEqual(reasonsOf(r), [{ at: 0, codes: ['NO_ACTIVE_MACHINE'] }])
})

test('every line that needs a person is reported, not just the first; the ones that do not are left out', async () => {
  const request = requestOf([{ model: 'V' }, { model: 'L' }, { model: 'F' }])
  request.items[0].material = 'PEEK'
  request.items[2].finish = 'gold-plated'
  const r = await post('quote', request)
  assert.equal(r.status, 422)
  assert.deepEqual(r.json.details.itemIndexes, [0, 2])
  assert.deepEqual(reasonsOf(r), [{ at: 0, codes: ['MATERIAL_UNKNOWN'] }, { at: 2, codes: ['FINISH_UNKNOWN'] }])
})

test('a ready-made product whose locked material is no longer offered cannot be bought online either', async () => {
  const prisma = await db()
  const quote = await post('quote', requestOf([{ model: 'T', qty: 1, variantColor: '#ffffff' }], { productTemplateId: data.productId }))
  assert.equal(quote.status, 200, quote.text)
  await prisma.productTemplate.update({ where: { id: data.productId }, data: { lockedMaterial: 'PEEK' } })
  try {
    const r = await post('quote', requestOf([{ model: 'T', qty: 1, variantColor: '#ffffff' }], { productTemplateId: data.productId }))
    assert.equal(r.status, 422, r.text)
    assert.deepEqual(reasonsOf(r), [{ at: 0, codes: ['MATERIAL_UNKNOWN'] }])
  } finally {
    await prisma.productTemplate.update({ where: { id: data.productId }, data: { lockedMaterial: 'PETG' } })
  }
})

// ---- the payment ---------------------------------------------------------------------------------------------------------------------
test('the payment is refused the same way: no order, no payment page, nothing sent to Stripe', async () => {
  const prisma = await db()
  const before = { orders: await prisma.printOrder.count(), calls: stripeCalls.length }
  const request = { ...requestOf([{ model: 'V' }], { material: 'PEEK' }), checkoutKey: newKey(), expectedTotalCents: 1234 }
  const r = await post('session', request)
  assert.equal(r.status, 422, r.text)
  assert.equal(r.json.code, 'MANUAL_REVIEW_REQUIRED')
  assert.equal(await prisma.printOrder.count(), before.orders)
  assert.equal(stripeCalls.length, before.calls)
})

// ---- asking for a manual quote ---------------------------------------------------------------------------------------------------------
test('a guest can ask for a manual quote: a request with no price, no payment and no way into production', async () => {
  const prisma = await db()
  const request = { ...requestOf([{ model: 'V', qty: 2 }, { model: 'L' }], {}), contact: { email: 'Guest.Person@Example.Test', name: 'Guest Person' }, note: 'Need it by Friday' }
  request.items[0].material = 'PEEK'
  const r = await post('manual-request', request)
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json.ok, true)
  const order = await prisma.printOrder.findFirstOrThrow({ where: { orderNumber: r.json.orderNumber }, include: { items: true } })
  assert.equal(order.status, 'awaiting_review')
  assert.equal(order.paymentMethod, 'quote')
  assert.equal(order.paymentStatus, 'quote')
  assert.equal(order.totalCents, 0)
  assert.equal(order.subtotalCents, 0)
  assert.equal(order.userId, null)
  assert.equal(order.customerEmail, 'guest.person@example.test')
  assert.equal(order.customerName, 'Guest Person')
  assert.equal(order.paidAt, null)
  assert.equal(order.stripePaymentIntentId, null)
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: order.id } }), 0)
  assert.equal(isProductionEligible(order), false, 'a quote request never goes to production by itself')
  assert.equal(isReprintAwaitingQuote(order), true, 'the pages show "price to be quoted", never a free order')
  assert.equal(order.items.length, 2)
  assert.equal(order.items.every((item) => item.unitPriceCents === 0 && item.totalCents === 0), true)
  assert.equal(order.items.find((item) => item.quantity === 2)?.material, 'PEEK', 'what was asked for is kept for the person who reads it')
  const meta = order.metadata as any
  assert.equal(meta.manualQuote.priceStatus, 'to_be_quoted')
  assert.deepEqual(meta.manualQuote.reasons, [{ itemIndex: 0, reasons: [{ code: 'MATERIAL_UNKNOWN', value: 'PEEK' }] }], 'the reasons are the server\'s')
  assert.equal(meta.manualQuote.note, 'Need it by Friday')
})

test('asking twice for the same cart gives the same request, not two', async () => {
  const request = { ...requestOf([{ model: 'V' }], { material: 'TITANIUM' }), contact: { email: 'twice@example.test' } }
  const a = await post('manual-request', request)
  const b = await post('manual-request', request)
  assert.equal(a.status, 201)
  assert.equal(b.status, 200)
  assert.equal(b.json.orderNumber, a.json.orderNumber)
  assert.equal(b.json.created, false)
})

test('a cart that CAN be paid online is not a manual request: the automatic checkout cannot be bypassed this way', async () => {
  const prisma = await db()
  const before = await prisma.printOrder.count()
  const r = await post('manual-request', { ...requestOf([{ model: 'V' }]), contact: { email: 'x@example.test' } })
  assert.equal(r.status, 409, r.text)
  assert.equal(r.json.code, 'REVIEW_NOT_REQUIRED')
  assert.equal(await prisma.printOrder.count(), before)
})

test('a guest must give an email; a signed-in customer may rely on the account\'s', async () => {
  const request = requestOf([{ model: 'V' }], { material: 'PEEK' })
  const guest = await post('manual-request', request)
  assert.equal(guest.status, 400, guest.text)
  assert.equal(guest.json.code, 'EMAIL_REQUIRED')
  const prisma = await db()
  const customer = await prisma.user.findUniqueOrThrow({ where: { id: data.discountUser.id } })
  const signedIn = await post('manual-request', request, { id: customer.id, role: 'customer' })
  assert.equal(signedIn.status, 201, signedIn.text)
  const order = await prisma.printOrder.findFirstOrThrow({ where: { orderNumber: signedIn.json.orderNumber } })
  assert.equal(order.userId, customer.id)
  assert.equal(order.customerEmail, customer.email)
})

test('what the browser says about the reasons, the price or the status is not accepted', async () => {
  const base = { ...requestOf([{ model: 'V' }], { material: 'PEEK' }), contact: { email: 'forge@example.test' } }
  for (const extra of [{ reasons: [] }, { totalCents: 1 }, { status: 'queued' }, { paymentStatus: 'paid' }, { reviews: [] }]) {
    const r = await post('manual-request', { ...base, ...extra })
    assert.equal(r.status, 400, JSON.stringify(extra))
  }
  const bad = await post('manual-request', { ...base, contact: { email: 'not-an-email' } })
  assert.equal(bad.status, 400)
})

test('the request cannot be used to reach a model the viewer may not see', async () => {
  const request = { ...requestOf([{ model: 'V' }], { material: 'PEEK' }), contact: { email: 'x@example.test' } }
  request.items[0].modelId = 'cl0000000000000000000000x'
  const r = await post('manual-request', request)
  assert.equal(r.status, 404, r.text)
  assert.equal(r.json.code, 'ITEM_UNAVAILABLE')
})
