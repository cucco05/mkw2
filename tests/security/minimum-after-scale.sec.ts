// Step 4.4 – the shop's minimum price of a piece also holds AFTER the customer resizes it (scenario 06 of the 4.2-ter matrix: a vase at scale 0.5 cost
// 1.35 € while the minimum per piece is 5.00 €).
//
// What is asserted, with the arithmetic done here and not read back from the code under test:
//   * at the original size nothing changes; a resize that leaves the piece at or above the minimum is priced as before;
//   * a resize that would take the piece under the minimum gives exactly the minimum (per piece, so x quantity), whatever the way of resizing
//     (one scale, one scale per axis) and whatever the way the base price is found (worked out from the volume, a flat rate, a sale price);
//   * quantity discounts, the customer's discounts, colours and rush come on top of the floored piece exactly as they do at the original size;
//   * what is shown is what is stored and what Stripe is asked to charge (quote = order = Stripe);
//   * left as they were, and said so: the parts of a model made of several parts (what the minimum means for ONE part is not decided), a shop product
//     (its scale is the shop's), a price the shop set by hand under the minimum, and a shop with no minimum.
// Fake Stripe (tests/security/_fake-checkout.ts), throw-away database, fake data.
import { db, resetDb } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { getColorMultiplier } from '../../lib/cartPricing'
import { TOLERANCE_PRICE_MULTIPLIER } from '../../lib/price-multiplier'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let data: ScenarioData
let sale3Id = ''     // a model with a hand-set price of 3.00, under the minimum
let sale20Id = ''    // a model with a hand-set price of 20.00, over it
let lockedHalfProductId = ''
let multi: { id: string; partIds: [string, string] } = { id: '', partIds: ['', ''] } // a model of two BIG parts: each part's own price is over the minimum

const MIN = 5 // SiteConfig.minimumPriceUsd of the scenario configuration

const ENV_KEYS = ['CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'SHIPPING_FLAT_RATE_CENTS', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX', 'MINIMUM_PRICE_USD', 'MINIMUM_PRICE_EUR'] as const
const saved: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]
for (const [key, value] of Object.entries({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' })) process.env[key] = value
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT; delete process.env.SHIPPING_FLAT_RATE_CENTS
delete process.env.MINIMUM_PRICE_USD; delete process.env.MINIMUM_PRICE_EUR

let ipSeq = 0
const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `min-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
async function post(route: 'quote' | 'session', body: unknown, viewer: Viewer | null = null) {
  viewerGuards.getViewer = async () => viewer
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}
const cartOf = (specs: ItemSpec[]) => specs.map((spec, i) => persistedCartItem(spec, data, i))
const requestOf = (specs: ItemSpec[]) => buildQuoteRequest(cartOf(specs) as any, { shippingMethod: 'pickup', rush: false })
const quoteOf = async (specs: ItemSpec[], viewer: Viewer | null = null) => {
  const res = await post('quote', requestOf(specs), viewer)
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json
}
// the price of ONE piece, in cents, before quantity and customer discounts (`undiscountedLineTotalCents` already has the quantity discount)
const unitCents = async (specs: ItemSpec[], viewer: Viewer | null = null) => (await quoteOf(specs, viewer)).items[0].unitPriceCents as number
const cents = (value: number) => Math.round(value * 100)

test.before(async () => {
  await resetDb()
  await seedScenarioConfig()
  data = await seedScenarioModels('min')
  fake = await installFakeCheckout()
  const prisma = await db()
  const owner = (await prisma.model.findUniqueOrThrow({ where: { id: data.ids.V } })).userId
  const mk = (title: string, over: Record<string, unknown>) => prisma.model.create({
    data: {
      title: `min ${title}`, filePath: `models/${owner}/min-${title}.stl`, fileType: 'stl', userId: owner, visibility: 'public', material: 'PLA',
      volumeMm3: 150000, priceUsd: 1, effectivePriceUsd: 1, sizeXmm: 51.37, sizeYmm: 49.82, sizeZmm: 119.64, colorSlotCount: 4, ...over,
    } as any,
  })
  sale3Id = (await mk('sale3', { salePriceUsd: 3 })).id
  sale20Id = (await mk('sale20', { salePriceUsd: 20 })).id
  const base = await mk('half-base', { volumeMm3: 150000 })
  lockedHalfProductId = (await prisma.productTemplate.create({
    data: { title: 'min Prodotto scala 0,5', baseModelId: base.id, isActive: true, lockedMaterial: 'PLA', lockedFinish: 'standard', lockedScale: 0.5, lockedPriceMultiplier: 1, colorOptions: [{ label: 'Bianco', value: '#ffffff', colorCount: 1, priceMultiplier: 1 }] } as any,
  })).id
  const multiModel = await mk('multi', { volumeMm3: 1600000, sizeXmm: 40, sizeYmm: 40, sizeZmm: 60 })
  const part = (index: number, name: string) => prisma.modelPart.create({
    data: { modelId: multiModel.id, index, name, filePath: `models/${owner}/min-multi-p${index}.stl`, volumeMm3: 800000, sizeXmm: 40, sizeYmm: 40, sizeZmm: 60 } as any,
  })
  multi = { id: multiModel.id, partIds: [(await part(0, 'Grande uno')).id, (await part(1, 'Grande due')).id] }
  const { updateModelPricingForModel } = await import('../../lib/model-pricing')
  await updateModelPricingForModel(multiModel.id)
  data.ids = { ...data.ids, sale3: sale3Id, sale20: sale20Id } as any
  for (const [key, id, price] of [['sale3', sale3Id, 3], ['sale20', sale20Id, 20]] as const) {
    ;(data.detail as any)[key] = { title: `min ${key}`, priceUsd: price, sizeXmm: 51.37, sizeYmm: 49.82, sizeZmm: 119.64, flatRatePricing: false }
    void id
  }
})
test.after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
  await seedScenarioConfig()
})

// ---- the vase: a price worked out from the volume --------------------------------------------------------------------------------------------
test('at the original size the price is what it was (the floor does not move anything)', async () => {
  const one = await unitCents([{ model: 'V' }])
  assert.ok(one >= cents(MIN), `the vase at scale 1 is over the minimum (${one})`)
  const grown = await unitCents([{ model: 'V', scale: 1.5 }])
  assert.ok(Math.abs(grown - one * 1.5 ** 3) <= 1, 'growing follows the volume, as before')
})

test('a resize that stays at or over the minimum is priced by volume, as before', async () => {
  const one = await unitCents([{ model: 'V' }])
  for (const scale of [0.95, 0.9, 0.85, 0.8]) {
    const expected = one * scale ** 3
    if (expected < cents(MIN)) continue
    const got = await unitCents([{ model: 'V', scale }])
    assert.ok(Math.abs(got - expected) <= 1, `scale ${scale}: ${got} vs ${expected}`)
  }
})

test('scenario 06: the vase at scale 0.5 costs the minimum per piece, not an eighth of the price', async () => {
  const one = await unitCents([{ model: 'V' }])
  assert.ok(one / 8 < cents(MIN), 'the case is a real one: an eighth of the price is under the minimum')
  assert.equal(await unitCents([{ model: 'V', scale: 0.5 }]), cents(MIN))
})

test('no scale in [0.1, 5] takes a piece under the minimum, and a bigger piece never costs less than a smaller one', async () => {
  let previous = 0
  for (let scale = 0.1; scale <= 5.0001; scale += 0.1) {
    const s = Number(scale.toFixed(2))
    const res = await post('quote', requestOf([{ model: 'V', scale: s }]))
    if (res.status !== 200) { assert.equal(res.json.code, 'MANUAL_REVIEW_REQUIRED', `scale ${s}: only the printer limit may refuse (${JSON.stringify(res.json).slice(0, 120)})`); continue }
    const unit = res.json.items[0].unitPriceCents as number
    assert.ok(unit >= cents(MIN), `scale ${s}: ${unit} is under the minimum`)
    assert.ok(unit >= previous, `scale ${s}: ${unit} is lower than the price of a smaller piece (${previous})`)
    previous = unit
  }
})

test('one scale per axis: a flat piece (z x 0.2) is floored too, and so is an axis that grows while the others shrink to less than the minimum', async () => {
  assert.equal(await unitCents([{ model: 'V', dimensionOverrides: { x: 1, y: 1, z: 0.2 } }]), cents(MIN))
  const one = await unitCents([{ model: 'V' }])
  const mixed = await unitCents([{ model: 'V', dimensionOverrides: { x: 2, y: 1, z: 0.5 } }]) // volume x1: the price of the original size
  assert.equal(mixed, one)
  assert.equal(await unitCents([{ model: 'V', dimensionOverrides: { x: 0.5, y: 0.5, z: 0.5 } }]), cents(MIN))
})

test('quantity: the floor is per piece, the line is the piece x quantity (no quantity discount under 10 pieces)', async () => {
  const quote = await quoteOf([{ model: 'V', scale: 0.5, qty: 3 }])
  assert.equal(quote.items[0].unitPriceCents, cents(MIN))
  assert.equal(quote.items[0].lineTotalCents, 3 * cents(MIN))
  assert.equal(quote.itemsTotalCents, 3 * cents(MIN))
})

test('quantity discount: it comes on top of the floored piece, exactly as it does on a piece at its original size', async () => {
  const quote = await quoteOf([{ model: 'V', scale: 0.5, qty: 12 }])
  // the shop's tiers: 10+ pieces = 5%
  assert.equal(quote.items[0].unitPriceCents, cents(MIN * 0.95))
  assert.equal(quote.items[0].lineTotalCents, 12 * cents(MIN * 0.95))
  const big = await quoteOf([{ model: 'V', scale: 0.5, qty: 30 }])
  assert.equal(big.items[0].unitPriceCents, cents(MIN * 0.9)) // 25+ = 10%
})

test('the customer\'s own discount comes on top as well, and the same discount applies to a piece at its original size', async () => {
  const viewer: Viewer = { id: data.discountUser.id, role: 'customer' }
  const resized = await quoteOf([{ model: 'V', scale: 0.5 }], viewer)
  const original = await quoteOf([{ model: 'V' }], viewer)
  const percent = resized.discountPercent as number
  assert.ok(percent > 0, 'the customer has a discount')
  assert.equal(original.discountPercent, percent)
  assert.equal(resized.items[0].unitPriceCents, Math.round(cents(MIN) * (1 - percent / 100)))
  assert.equal(resized.items[0].undiscountedLineTotalCents, cents(MIN))
})

test('colours come on top of the floor like everything else', async () => {
  const two = ['#ffffff', '#000000']
  const multiplier = getColorMultiplier(two as any)
  assert.ok(multiplier > 1, 'two colours cost more')
  const got = await unitCents([{ model: 'V', scale: 0.5, colors: two }])
  assert.equal(got, Math.round(cents(MIN) * multiplier))
})

test('a stricter tolerance (a price multiplier) comes on top of the floor', async () => {
  const plain = await unitCents([{ model: 'V', scale: 0.5 }])
  const cosmetic = await unitCents([{ model: 'V', scale: 0.5, toleranceClass: 'cosmetic' }])
  assert.equal(plain, cents(MIN))
  assert.ok(TOLERANCE_PRICE_MULTIPLIER.cosmetic > 1)
  assert.equal(cosmetic, Math.round(cents(MIN) * TOLERANCE_PRICE_MULTIPLIER.cosmetic), 'the floor, then the same multiplier as at the original size')
})

// ---- other ways a base price is found ----------------------------------------------------------------------------------------------------------
test('a flat-rate model (one price whatever the colours) is floored after a resize too', async () => {
  const one = await unitCents([{ model: 'F' }])
  assert.ok(one >= cents(MIN))
  assert.equal(await unitCents([{ model: 'F', scale: 0.4 }]), Math.max(cents(MIN), Math.round(one * 0.4 ** 3)))
})

test('a sale price set by the shop that is AT OR OVER the minimum is floored after a resize', async () => {
  const spec = (scale?: number): ItemSpec => ({ model: 'sale20' as any, scale })
  assert.equal(await unitCents([spec()]), cents(20))
  assert.equal(await unitCents([spec(0.5)]), cents(MIN), '20 / 8 = 2.50: the floor')
  assert.equal(await unitCents([spec(0.8)]), cents(20 * 0.8 ** 3), '20 x 0.512 = 10.24: over the minimum')
})

test('a price the shop set by hand UNDER the minimum is left alone, resized or not (nothing is raised that was not raised before)', async () => {
  const spec = (scale?: number): ItemSpec => ({ model: 'sale3' as any, scale })
  assert.equal(await unitCents([spec()]), cents(3))
  // (a total under 0.50 EUR is refused by the card minimum whatever the price, so the resize is 0.7: 3.00 x 0.343 = 1.029)
  assert.equal(await unitCents([spec(0.7)]), 103, 'under the minimum and shrunk: priced by volume, as it was')
  assert.equal(await unitCents([spec(1.2)]), 518, 'grown: by volume (3.00 x 1.728 = 5.18)')
})

// ---- what is left as it was, on purpose --------------------------------------------------------------------------------------------------------
test('the parts of a model made of several parts keep their price by volume (the meaning of the minimum for ONE part is a decision still to be taken)', async () => {
  const one = await unitCents([{ model: 'P', part: 1, qty: 8 }])
  const half = await unitCents([{ model: 'P', part: 1, scale: 0.5, qty: 8 }])
  assert.ok(Math.abs(half - one * 0.125) <= 1, `part at 0.5: ${half} vs ${one * 0.125}`)
  assert.ok(half < cents(MIN), 'and it is under the per-piece minimum: this is the open point, not a result to rely on')
})

test('the parts of a multi-part model whose parts are EACH priced over the minimum keep their price by volume too (nothing is raised to the minimum, nothing decided)', async () => {
  const prisma = await db()
  const stored = await prisma.modelPart.findUniqueOrThrow({ where: { id: multi.partIds[0] } })
  const line = (qty: number, scale: number) => ({
    ...persistedCartItem({ model: 'P', part: 1, qty, scale }, data, 0),
    modelId: multi.id, partId: multi.partIds[0], partName: stored.name, partIndex: 0, title: 'min multi', priceUsd: stored.priceUsd,
  })
  const unit = async (qty: number, scale: number) => {
    const res = await post('quote', buildQuoteRequest([line(qty, scale)] as any, { shippingMethod: 'pickup', rush: false }))
    assert.equal(res.status, 200, JSON.stringify(res.json))
    return res.json.items[0].unitPriceCents as number
  }
  const whole = await unit(2, 1)
  assert.ok(whole > cents(MIN) * 1.5, `the part's own price (${whole}) is well over the minimum, so a floor WOULD change the result if it applied`)
  const half = await unit(2, 0.5)
  assert.ok(Math.abs(half - whole * 0.125) <= 1, `${half} vs ${whole * 0.125}`)
  assert.ok(half < cents(MIN), 'under the per-piece minimum: the open point, not a result to rely on')
})

test('a shop product whose scale the shop fixed is left as it was (the customer did not resize it)', async () => {
  const base = await unitCents([{ model: 'T', qty: 1, variantColor: '#ffffff' }])
  const prisma = await db()
  const product = await prisma.productTemplate.findUniqueOrThrow({ where: { id: lockedHalfProductId } })
  const item = {
    ...persistedCartItem({ model: 'T', variantColor: '#ffffff' }, data, 0),
    modelId: product.baseModelId, title: 'Prodotto scala 0,5', partId: null,
    options: { qty: 1, scale: 0.5, material: 'PLA', colors: ['#ffffff'], finish: 'standard', lockedConfig: true, productTemplateId: lockedHalfProductId, priceMultiplier: 1, lockDimensions: true, dimensionOverrides: null, infillPct: null, customText: null, toleranceClass: null },
  }
  const res = await post('quote', buildQuoteRequest([item] as any, { shippingMethod: 'pickup', rush: false }))
  assert.equal(res.status, 200, JSON.stringify(res.json))
  const unit = res.json.items[0].unitPriceCents as number
  const full = await unitCents([{ model: 'V' }]) // same volume as the product's base model: the original-size price
  assert.ok(base > 0 && full > 0)
  assert.ok(unit < cents(MIN), `the product keeps its price by volume (${unit}), under the minimum: the shop's own configuration`)
})

test('a shop with NO minimum configured prices a resized piece by volume, as always', async () => {
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: null } as any })
  try {
    const one = await unitCents([{ model: 'V' }])
    const half = await unitCents([{ model: 'V', scale: 0.5 }])
    assert.ok(Math.abs(half - one * 0.125) <= 1, `${half} vs ${one * 0.125}`)
    assert.ok(half < cents(MIN))
  } finally {
    await seedScenarioConfig()
  }
})

// ---- the chain: quote = order = Stripe ---------------------------------------------------------------------------------------------------------
test('the floored piece travels unchanged: quote = order = what Stripe is asked to charge (2 pieces at scale 0.5 = 2 x the minimum)', async () => {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany(); await prisma.printOrder.deleteMany()
  fake.sessions.clear(); fake.byKey.clear()
  const request = requestOf([{ model: 'V', scale: 0.5, qty: 2 }])
  const quote = await post('quote', request)
  assert.equal(quote.status, 200)
  const total = quote.json.totalCents as number
  assert.equal(total, 2 * cents(MIN))
  const session = await post('session', { ...request, checkoutKey: newKey(), expectedTotalCents: total })
  assert.equal(session.status, 200, JSON.stringify(session.json))
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: session.json.orderId }, include: { items: true } })
  assert.equal(order.totalCents, total)
  assert.equal(order.items[0].unitPriceCents, cents(MIN))
  assert.equal(order.items[0].quantity, 2)
  const lines = (fake.state.lastParams as any).line_items as Array<{ quantity: number; price_data: { unit_amount: number } }>
  assert.equal(lines.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0), total)
  assert.equal((fake.state.lastParams as any).line_items[0].price_data.unit_amount, cents(MIN))
})
