// S2/S3 step 4.2 – the cart and the checkout are open to visitors who are not signed in, and nothing private opens with them.
//
// What must hold for a guest:
//   * the shop's published models can be quoted and paid for;
//   * a customer's own model (even stored as "public"), a model that does not exist and a part of another model give the SAME refusal
//     (ITEM_UNAVAILABLE, 404) and name only the cart lines concerned - the model APIs the cart page uses say 404 as well;
//   * the signed-in owner still can order the own model;
//   * the answers carry codes and details the page acts on (which line, what minimum), and say which delivery choices exist.
// Fake data, throw-away database.
import { db, resetDb, seedShopModel } from './_harness'
import { guestHeaders } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'

let shopModelId = ''
let customerModelId = ''
let customer: { id: string }
let otherCustomer: { id: string }
let ipSeq = 0
const nextIp = () => `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `guest-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV)]) saved[key] = process.env[key]

type Item = Record<string, unknown>
const line = (modelId: string, over: Item = {}): Item => ({ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA', ...over })
const cart = (items: Item[], over: Item = {}) => ({ items, shipping: { method: 'pickup' }, rush: false, ...over })

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
const modelApi = async (id: string, viewer: Viewer | null) => {
  viewerGuards.getViewer = async () => viewer
  const { GET } = await import('../../app/api/models/[id]/route')
  const res = (await (GET as any)(new NextRequest(`http://localhost/api/models/${id}`), { params: Promise.resolve({ id }) })) as Response
  return res.status
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  shopModelId = (await seedShopModel()).model.id
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}@sectest.invalid`, passwordHash: 'x', name: n, role: 'customer' } })
  customer = await mk('guestsec-owner')
  otherCustomer = await mk('guestsec-other')
  customerModelId = (await prisma.model.create({
    data: {
      title: 'FAKE private customer part', filePath: `models/${customer.id}/mine.stl`, fileType: 'stl', userId: customer.id, visibility: 'public',
      volumeMm3: 100000, priceUsd: 50, effectivePriceUsd: 50, sizeXmm: 40, sizeYmm: 40, sizeZmm: 40,
    },
  })).id
  await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('a guest can quote and start paying for a published shop model', async () => {
  const q = await post('quote', cart([line(shopModelId)]))
  assert.equal(q.status, 200, q.text)
  assert.equal(q.json.canCheckout, true)
  const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...cart([line(shopModelId)]) })
  assert.equal(s.status, 200, s.text)
})

test('a guest can not quote or buy a customer\'s model, even one stored as public: same refusal as for a missing model', async () => {
  const unknown = await post('quote', cart([line(shopModelId), line('clmissingmissingmissing0000')]))
  for (const id of [customerModelId]) {
    const q = await post('quote', cart([line(shopModelId), line(id)]))
    assert.equal(q.status, 404, q.text)
    assert.equal(q.json.code, 'ITEM_UNAVAILABLE')
    assert.deepEqual(q.json.details, { itemIndexes: [1] })
    assert.deepEqual(Object.keys(q.json).sort(), Object.keys(unknown.json).sort(), 'the refusal has the same shape as for a missing model')
    assert.equal(q.json.error, unknown.json.error)
    const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: 100, ...cart([line(id)]) })
    assert.equal(s.status, 404, s.text)
    assert.equal(s.json.code, 'ITEM_UNAVAILABLE')
  }
  assert.equal(unknown.status, 404)
  assert.deepEqual(unknown.json.details, { itemIndexes: [1] })
})

test('another customer is refused as well; the owner can order the own model', async () => {
  const other = await post('quote', cart([line(customerModelId)]), { id: otherCustomer.id, role: 'customer' })
  assert.equal(other.status, 404, other.text)
  const owner = await post('quote', cart([line(customerModelId)]), { id: customer.id, role: 'customer' })
  assert.equal(owner.status, 200, owner.text)
})

test('the model API the cart page calls hides a customer\'s model from guests and other customers, and shows the shop\'s', async () => {
  assert.equal(await modelApi(customerModelId, null), 404)
  assert.equal(await modelApi(customerModelId, { id: otherCustomer.id, role: 'customer' }), 404)
  assert.equal(await modelApi('clmissingmissingmissing0000', null), 404)
  assert.equal(await modelApi(customerModelId, { id: customer.id, role: 'customer' }), 200)
  assert.equal(await modelApi(shopModelId, null), 200)
})

test('a part of another model is refused with the same code and names the line', async () => {
  const prisma = await db()
  const part = await prisma.modelPart.create({ data: { modelId: (await seedShopModel()).model.id, index: 0, name: 'FAKE other part', filePath: 'models/x/part.stl', volumeMm3: 1000, priceUsd: 10 } as any })
  const q = await post('quote', cart([line(shopModelId), line(shopModelId, { partId: part.id })]))
  assert.equal(q.status, 400, q.text)
  assert.equal(q.json.code, 'ITEM_UNAVAILABLE')
  assert.deepEqual(q.json.details, { itemIndex: 1 })
})

test('errors name the cart line concerned and carry the figure that matters', async () => {
  const noColour = await post('quote', cart([line(shopModelId), line(shopModelId, { colors: [] })]))
  assert.equal(noColour.status, 400)
  assert.equal(noColour.json.code, 'COLOR_REQUIRED')
  assert.deepEqual(noColour.json.details, { itemIndex: 1 })

  const prisma = await db()
  // what the same cart costs when no minimum applies: the figure the minimum-order error must repeat (the cart shows it next to the minimum)
  const priced = await post('quote', cart([line(customerModelId)]), { id: customer.id, role: 'customer' })
  assert.equal(priced.status, 200, priced.text)
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: 100000 } as any })
  try {
    const small = await post('quote', cart([line(customerModelId)]), { id: customer.id, role: 'customer' })
    assert.equal(small.status, 400, small.text)
    assert.equal(small.json.code, 'MINIMUM_ORDER')
    assert.equal(small.json.details.minimumCents, 10000000)
    assert.equal(small.json.details.itemsTotalCents, priced.json.itemsTotalCents)
    assert.equal(small.json.details.currency, 'EUR')
  } finally {
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumOrderSubtotalUsd: null } as any })
  }

  const bad = await post('quote', { items: [] })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.code, 'INVALID_REQUEST')
})

test('the quote says which delivery choices exist, whichever is selected', async () => {
  for (const method of ['pickup', 'ship']) {
    const q = await post('quote', cart([line(shopModelId)], { shipping: { method } }))
    assert.equal(q.status, 200, q.text)
    assert.deepEqual(q.json.shippingOffer, { shipAvailable: true, shipCents: 700, shipLabel: 'Spedizione in Italia', shipCountries: ['IT'] })
    assert.equal(q.json.shipping.cents, method === 'ship' ? 700 : 0)
  }
  delete process.env.SHIPPING_FLAT_RATE_CENTS
  try {
    const pickup = await post('quote', cart([line(shopModelId)]))
    assert.equal(pickup.status, 200, pickup.text)
    assert.equal(pickup.json.shippingOffer.shipAvailable, false)
    assert.equal(pickup.json.shippingOffer.shipCents, null)
    const ship = await post('quote', cart([line(shopModelId)], { shipping: { method: 'ship' } }))
    assert.equal(ship.status, 503, ship.text)
    assert.equal(ship.json.code, 'SHIPPING_NOT_CONFIGURED')
  } finally {
    process.env.SHIPPING_FLAT_RATE_CENTS = '700'
  }
})
