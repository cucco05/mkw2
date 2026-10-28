// S2/S3 step 4.2 – the price multiplier belongs to the server.
//
// Before: the cart line carried `priceMultiplier` (0.1 to 5) and the server multiplied the price by it, so a single edited request
// paid a tenth. A ready-made product was recognised by an id the browser chose, without checking that it existed, was on sale or
// belonged to that model, and its material/finish/scale were whatever the cart said although the price does not depend on them.
// Now: the multiplier comes from the tolerance table or from the product row in the database; products are pinned to their
// locked configuration; and an unusable product / variant is refused with a code the page can act on.
// Fake Stripe, throw-away database, fake data.
import { db, resetDb, seedShopModel } from './_harness'
import { strongTestKey } from './_keys'
import { guestHeaders } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'

let modelId = ''
let otherModelId = ''
let ipSeq = 0
const nextIp = () => `10.5.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => strongTestKey(`mult-${++keySeq}`)
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]

type Item = Record<string, unknown>
const line = (over: Item = {}): Item => ({ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA', ...over })
const cart = (items: Item[], over: Item = {}) => ({ items, shipping: { method: 'pickup' }, rush: false, ...over })

async function post(route: 'quote' | 'session', body: unknown) {
  viewerGuards.getViewer = async () => null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
const quote = (items: Item[], over: Item = {}) => post('quote', cart(items, over))
const unitCents = async (item: Item) => {
  const q = await quote([item])
  assert.equal(q.status, 200, q.text)
  return q.json.items[0].unitPriceCents as number
}

async function makeTemplate(over: Record<string, unknown> = {}) {
  const prisma = await db()
  return prisma.productTemplate.create({
    data: {
      title: 'FAKE product', baseModelId: modelId, isActive: true, lockedMaterial: 'PETG', lockedFinish: 'matte', lockedScale: 1, lockedPriceMultiplier: 1,
      colorOptions: [{ label: 'White', value: '#ffffff', colorCount: 1, priceMultiplier: 1 }],
      ...over,
    } as any,
  })
}

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel()).model.id
  otherModelId = (await seedShopModel()).model.id
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ====================================================================================================================================
// the browser's multiplier is not a price
// ====================================================================================================================================
test('a priceMultiplier sent by the browser changes nothing (0.1, 5, 1 give the same price)', async () => {
  const reference = await unitCents(line())
  assert.ok(reference > 0)
  for (const sent of [0.1, 0.5, 1, 2, 5]) assert.equal(await unitCents(line({ priceMultiplier: sent })), reference, `sent ${sent}`)
  // a multiplier together with a tolerance class: the class decides
  const fit = await unitCents(line({ toleranceClass: 'fit_critical', priceMultiplier: 0.1 }))
  assert.equal(fit, await unitCents(line({ toleranceClass: 'fit_critical' })))
})

test('tolerance classes use the server table (0.94 / 1 / 1.08 / 1.16)', async () => {
  const standard = await unitCents(line({ toleranceClass: 'standard' }))
  assert.equal(await unitCents(line()), standard, 'no class = standard')
  for (const [cls, factor] of [['draft', 0.94], ['cosmetic', 1.08], ['fit_critical', 1.16]] as const) {
    const cents = await unitCents(line({ toleranceClass: cls }))
    assert.ok(Math.abs(cents - Math.round(standard * factor)) <= 2, `${cls}: ${cents} vs ${standard * factor}`)
  }
})

test('the charge follows the server: an order made with priceMultiplier 0.1 is charged the real price', async () => {
  const fake = await installFakeCheckout()
  void fake
  const honest = await quote([line()])
  assert.equal(honest.status, 200, honest.text)
  const sentLow = await post('session', { checkoutKey: newKey(), expectedTotalCents: honest.json.totalCents, ...cart([line({ priceMultiplier: 0.1 })]) })
  assert.equal(sentLow.status, 200, sentLow.text)
  assert.equal(sentLow.json.totalCents, honest.json.totalCents, 'charged the real total')
  // and a total that only the manipulated price could produce is refused
  const lowTotal = Math.round(honest.json.totalCents * 0.1)
  const refused = await post('session', { checkoutKey: newKey(), expectedTotalCents: lowTotal, ...cart([line({ priceMultiplier: 0.1 })]) })
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.code, 'PRICE_CHANGED')
  assert.equal(refused.json.currentTotalCents, honest.json.totalCents)
})

// ====================================================================================================================================
// ready-made products
// ====================================================================================================================================
test('a product is priced with ITS multiplier and the picked variant\'s, and the browser\'s word changes nothing', async () => {
  const plain = await makeTemplate({ title: 'FAKE plain product' })
  const premium = await makeTemplate({
    title: 'FAKE premium product', lockedPriceMultiplier: 1.5,
    colorOptions: [{ label: 'White', value: '#ffffff', colorCount: 1, priceMultiplier: 1.2 }, { label: 'Black', value: '#000000', colorCount: 1, priceMultiplier: 1 }],
  })
  const base = await unitCents(line({ productTemplateId: plain.id }))
  const white = await unitCents(line({ productTemplateId: premium.id }))
  const black = await unitCents(line({ productTemplateId: premium.id, colors: ['#000000'] }))
  assert.ok(Math.abs(white - Math.round(base * 1.8)) <= 2, `white ${white} vs ${base * 1.8}`)
  assert.ok(Math.abs(black - Math.round(base * 1.5)) <= 2, `black ${black} vs ${base * 1.5}`)
  // the colour is matched whatever its case and spacing
  assert.equal(await unitCents(line({ productTemplateId: premium.id, colors: [' #FFFFFF '] })), white)
  // the browser's own multiplier, and a tolerance class the product page does not offer, are ignored
  assert.equal(await unitCents(line({ productTemplateId: premium.id, priceMultiplier: 0.1 })), white)
  assert.equal(await unitCents(line({ productTemplateId: premium.id, priceMultiplier: 5, toleranceClass: 'draft' })), white)
})

test('a product is sold as configured: material, finish, scale, infill and size come from the product, not from the cart', async () => {
  const product = await makeTemplate({ title: 'FAKE locked product', lockedMaterial: 'PETG', lockedFinish: 'matte', lockedScale: 1 })
  const asConfigured = await quote([line({ productTemplateId: product.id })])
  assert.equal(asConfigured.status, 200, asConfigured.text)
  assert.equal(asConfigured.json.items[0].material, 'PETG')
  assert.equal(asConfigured.json.items[0].finish, 'matte')
  const tampered = await quote([line({
    productTemplateId: product.id, material: 'PC', finish: 'polished', scale: 4, scaleX: 3, infillPct: 100, lockDimensions: false, targetDimensions: { x: 10 },
  })])
  assert.equal(tampered.status, 200, tampered.text)
  assert.equal(tampered.json.items[0].material, 'PETG')
  assert.equal(tampered.json.items[0].finish, 'matte')
  assert.equal(tampered.json.items[0].unitPriceCents, asConfigured.json.items[0].unitPriceCents)
  assert.equal(tampered.json.totalCents, asConfigured.json.totalCents)
})

test('a product that does not exist, is switched off, or belongs to another model is refused (ITEM_UNAVAILABLE)', async () => {
  const off = await makeTemplate({ title: 'FAKE off', isActive: false })
  const elsewhere = await makeTemplate({ title: 'FAKE other model', baseModelId: otherModelId })
  const detached = await makeTemplate({ title: 'FAKE no model', baseModelId: null })
  const made = [off.id, elsewhere.id, detached.id, 'clzzzzzzzzzzzzzzzzzzzzzzz']
  const ordersBefore = await (await db()).printOrder.count()
  for (const id of made) {
    const q = await quote([line(), line({ productTemplateId: id })])
    assert.equal(q.status, 404, `${id}: ${q.text}`)
    assert.equal(q.json.code, 'ITEM_UNAVAILABLE')
    const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: 100, ...cart([line({ productTemplateId: id })]) })
    assert.equal(s.status, 404, s.text)
  }
  assert.equal(await (await db()).printOrder.count(), ordersBefore, 'no order was made')
})

test('a colour the product does not offer is refused instead of being priced without its premium (OPTION_UNAVAILABLE)', async () => {
  const product = await makeTemplate({
    title: 'FAKE variants', colorOptions: [{ label: 'Gold', value: '#ffd700', colorCount: 1, priceMultiplier: 2 }],
  })
  const q = await quote([line({ productTemplateId: product.id, colors: ['#123456'] })])
  assert.equal(q.status, 409, q.text)
  assert.equal(q.json.code, 'OPTION_UNAVAILABLE')
  assert.equal((await quote([line({ productTemplateId: product.id, colors: ['#ffd700'] })])).status, 200)
})

test('a product with no colour list is not blocked and has no variant premium', async () => {
  const product = await makeTemplate({ title: 'FAKE no variants', colorOptions: [], lockedPriceMultiplier: 1 })
  const plain = await makeTemplate({ title: 'FAKE with variants', colorOptions: [{ label: 'White', value: '#ffffff', priceMultiplier: 1 }] })
  assert.equal(await unitCents(line({ productTemplateId: product.id })), await unitCents(line({ productTemplateId: plain.id })))
})

test('a damaged multiplier stored in the database can not zero a price or blow it up', async () => {
  const absurd = await makeTemplate({
    title: 'FAKE absurd', lockedPriceMultiplier: 1,
    colorOptions: [{ label: 'x', value: '#ffffff', priceMultiplier: -3 }, { label: 'y', value: '#000000', priceMultiplier: 9999 }, { label: 'z', value: '#ff0000', priceMultiplier: 'abc' }],
  })
  const plain = await makeTemplate({ title: 'FAKE reference' })
  const reference = await unitCents(line({ productTemplateId: plain.id }))
  assert.equal(await unitCents(line({ productTemplateId: absurd.id, colors: ['#ffffff'] })), reference, 'negative = no premium')
  assert.equal(await unitCents(line({ productTemplateId: absurd.id, colors: ['#ff0000'] })), reference, 'not a number = no premium')
  const capped = await unitCents(line({ productTemplateId: absurd.id, colors: ['#000000'] }))
  assert.ok(Math.abs(capped - reference * 5) <= 3, `capped at 5x: ${capped}`)
})

// ====================================================================================================================================
// errors the page can act on
// ====================================================================================================================================
test('quote errors carry a code: unknown model, no colour', async () => {
  const unknown = await quote([line(), line({ modelId: 'clqqqqqqqqqqqqqqqqqqqqqqq' })])
  assert.equal(unknown.status, 404, unknown.text)
  assert.equal(unknown.json.code, 'ITEM_UNAVAILABLE')
  const noColour = await quote([line({ colors: [] })])
  assert.equal(noColour.status, 400, noColour.text)
  assert.equal(noColour.json.code, 'COLOR_REQUIRED')
})

test('what is stored for a product line is the locked configuration (infill, scale, dimensions, tolerance), not the cart\'s', async () => {
  const product = await makeTemplate({ title: 'FAKE stored config', lockedMaterial: 'PETG', lockedFinish: 'matte', lockedScale: 1 })
  const { buildCardQuote } = await import('../../lib/checkout-quote')
  viewerGuards.getViewer = async () => null
  const built = await buildCardQuote({
    items: [line({ productTemplateId: product.id, material: 'PC', finish: 'polished', scale: 4, infillPct: 100, toleranceClass: 'fit_critical', targetDimensions: { x: 10 } }) as any],
    shippingMethod: 'pickup', rush: false, publicBaseUrl: null,
  })
  const stored = built.lineItems[0]
  assert.equal(stored.material, 'PETG')
  assert.equal(stored.finish, 'matte')
  assert.equal(stored.scale, 1)
  assert.equal(stored.infillPct, undefined)
  assert.equal(stored.toleranceClass, 'standard')
  // the size in millimetres is the server's own (the base model's size at the product's locked scale), not the 10 mm the cart claimed
  assert.deepEqual(stored.targetDimensions, { x: 80, y: 80, z: 60 })
  assert.equal(stored.productTemplateId, product.id)
})
