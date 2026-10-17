// Step 4.4 – the shop's minimum price of a piece also holds AFTER the customer resizes it (scenario 06 of the 4.2-ter matrix: a vase at scale 0.5 cost
// 1.35 € while the minimum per piece is 5.00 €).
// Step 4.5 – the minimum is for ONE SOLD UNIT, whatever the way its price was found, and it is not circumvented by splitting or grouping the cart.
//
// What is asserted, with the arithmetic done here and not read back from the code under test:
//   * at the original size nothing changes; a resize that leaves the piece at or above the minimum is priced as before;
//   * a resize that would take the piece under the minimum gives exactly the minimum (per piece, so x quantity), whatever the way of resizing
//     (one scale, one scale per axis) and whatever the way the base price is found (worked out from the volume, a flat rate, a sale price);
//   * 4.5: a price the shop set by hand UNDER the minimum, and a shop product with a locked scale, are floored too: a fixed price or a locked scale is not
//     an exemption, and there is no authorised exemption to apply;
//   * 4.5/4.6: the parts of a model made of several parts - a COMPLETE copy (the lines that carry one `setKey`, checked by the server) is ONE unit, a part
//     bought on its own is a unit of its own, the same part in two lines (other colours, other sizes) is still a unit per copy, a whole-model line is one
//     unit per copy. (Step 4.6 replaced the provisional 4.5 rule that guessed the sets from the quantities: nothing is grouped unless the customer asked.)
//   * quantity discounts, the customer's discounts, colours and rush come on top of the floored piece exactly as they do at the original size;
//   * what is shown is what is stored and what Stripe is asked to charge (quote = order = Stripe);
//   * left as it was, and said so: a shop with no minimum.
// Fake Stripe (tests/security/_fake-checkout.ts), throw-away database, fake data.
import { db, resetDb } from './_harness'
import { guestHeaders } from './_guest'
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
let tri: { id: string; partIds: [string, string, string] } = { id: '', partIds: ['', '', ''] } // a model of three SMALL parts: each part is under the minimum, the three together are over it

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
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders() }, body: JSON.stringify(body),
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
  const triModel = await mk('tri', { volumeMm3: 360000, sizeXmm: 40, sizeYmm: 40, sizeZmm: 40 })
  const triPart = (index: number, name: string) => prisma.modelPart.create({
    data: { modelId: triModel.id, index, name, filePath: `models/${owner}/min-tri-p${index}.stl`, volumeMm3: 120000, sizeXmm: 40, sizeYmm: 40, sizeZmm: 40 } as any,
  })
  tri = { id: triModel.id, partIds: [(await triPart(0, 'Piccolo uno')).id, (await triPart(1, 'Piccolo due')).id, (await triPart(2, 'Piccolo tre')).id] }
  const { updateModelPricingForModel } = await import('../../lib/model-pricing')
  await updateModelPricingForModel(multiModel.id)
  await updateModelPricingForModel(triModel.id)
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

test('4.5: a price the shop set by hand UNDER the minimum is floored too, at the original size and resized (a fixed price is not an exemption)', async () => {
  const spec = (scale?: number): ItemSpec => ({ model: 'sale3' as any, scale })
  assert.equal(await unitCents([spec()]), cents(MIN), 'the hand-set 3.00 is sold at the minimum')
  assert.equal(await unitCents([spec(0.7)]), cents(MIN), '3.00 x 0.343 = 1.03: the floor')
  assert.equal(await unitCents([spec(1.1)]), cents(MIN), '3.00 x 1.331 = 3.99: still under, the floor')
  assert.equal(await unitCents([spec(1.2)]), 518, 'grown over the minimum by volume (3.00 x 1.728 = 5.18): priced by volume')
})

// ---- 4.5: the loose parts of a model made of several parts -----------------------------------------------------------------------------------------
type Tri = typeof tri
async function partLine(model: Tri | typeof multi, index: number, opts: { qty?: number; scale?: number; colors?: string[]; key?: string; setKey?: string } = {}) {
  const prisma = await db()
  const stored = await prisma.modelPart.findUniqueOrThrow({ where: { id: model.partIds[index] } })
  const base = persistedCartItem({ model: 'P', part: 1, qty: opts.qty ?? 1, scale: opts.scale ?? 1, colors: opts.colors }, data, index)
  return { ...base, cartItemId: opts.key ?? `part-${index}-${Math.random().toString(36).slice(2, 8)}`, modelId: model.id, partId: stored.id, partName: stored.name, partIndex: index, title: 'min multi-part', priceUsd: stored.priceUsd, setKey: opts.setKey ?? null }
}
async function wholeLine(model: { id: string }, opts: { qty?: number; scale?: number } = {}) {
  const base = persistedCartItem({ model: 'V', qty: opts.qty ?? 1, scale: opts.scale ?? 1 }, data, 0)
  return { ...base, modelId: model.id, partId: null, partName: null, partIndex: null, title: 'min multi-part', priceUsd: null }
}
const quoteLines = async (lines: any[], viewer: Viewer | null = null) => {
  const res = await post('quote', buildQuoteRequest(lines as any, { shippingMethod: 'pickup', rush: false }), viewer)
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json
}
// the lines add up to this, to the cent per unit (every unit is rounded to the cent after the floor, so a few cents of rounding are allowed per piece)
const near = (got: number, expected: number, pieces: number, what: string) => assert.ok(Math.abs(got - expected) <= pieces, `${what}: ${got} vs ${expected} (${pieces} piece(s) of rounding allowed)`)

const triSet = (key: string, opts: { qty?: number; scale?: number } = {}) => Promise.all([0, 1, 2].map((index) => partLine(tri, index, { ...opts, setKey: key })))

test('4.6 a complete model added the way the pages add it (one line per part, one key) pays the minimum ONCE, not once per part', async () => {
  const prisma = await db()
  const quote = await quoteLines(await triSet('tri-set-0001'))
  const units = quote.items.map((item: any) => item.unitPriceCents as number)
  assert.ok(units.every((unit: number) => unit < cents(MIN)), `each part is under the minimum on its own (${units.join(', ')}): the minimum is NOT applied to every component`)
  const stored = await prisma.modelPart.findMany({ where: { modelId: tri.id } })
  const sum = stored.reduce((total, part) => total + cents(part.priceUsd as number), 0)
  assert.ok(sum > cents(MIN), 'the model as a whole is over the minimum')
  assert.equal(quote.itemsTotalCents, sum, 'a complete model costs the price of the model, to the cent (the sum of its stored parts): nothing is raised')
  assert.deepEqual(quote.unitNotices, [], 'a valid complete model raises no notice')
  assert.ok(quote.items.every((item: any) => item.unit.kind === 'set' && item.unit.setOrdinal === 1 && item.unit.copies === 1))
})

test('4.6 a complete model resized under the minimum costs the minimum once (the three parts together), shared by what each part costs', async () => {
  const quote = await quoteLines(await triSet('tri-set-0002', { scale: 0.5 }))
  assert.equal(quote.itemsTotalCents, cents(MIN), 'one complete model = one minimum, exactly')
  const units = quote.items.map((item: any) => item.unitPriceCents as number)
  assert.equal(units.reduce((a: number, b: number) => a + b, 0), cents(MIN))
  assert.ok(Math.max(...units) - Math.min(...units) <= 1, `equal parts share it equally (${units.join(', ')})`)
})

test('4.6 the same lines WITHOUT a key are three parts bought one by one: three minimums, and the server only suggests the complete model', async () => {
  const quote = await quoteLines([await partLine(tri, 0, { scale: 0.5 }), await partLine(tri, 1, { scale: 0.5 }), await partLine(tri, 2, { scale: 0.5 })])
  assert.equal(quote.itemsTotalCents, 3 * cents(MIN), 'three single parts = three units, each at the minimum')
  assert.deepEqual(quote.unitNotices, [{ code: 'COULD_BE_COMPLETE_MODEL', itemIndexes: [0, 1, 2], copies: 1 }])
  assert.ok(quote.items.every((item: any) => item.unit.kind === 'part'))
})

test('4.5 a part bought on its own is a unit of its own: it costs the minimum, and x quantity', async () => {
  const one = await quoteLines([await partLine(tri, 0)])
  assert.equal(one.items[0].unitPriceCents, cents(MIN), 'a third of the model costs less than the minimum by volume, and is sold at the minimum')
  const three = await quoteLines([await partLine(tri, 0, { qty: 3 })])
  assert.equal(three.items[0].unitPriceCents, cents(MIN))
  assert.equal(three.itemsTotalCents, 3 * cents(MIN))
})

test('4.5 two of the three parts are two units (no complete set): 2 minimums, not 1', async () => {
  const quote = await quoteLines([await partLine(tri, 0), await partLine(tri, 1)])
  assert.equal(quote.itemsTotalCents, 2 * cents(MIN), 'two parts bought separately')
  assert.deepEqual(quote.unitNotices, [], 'two of three parts could not make a complete model: nothing is suggested')
})

test('4.5 splitting a part into several lines (other colours, other sizes) does not get under the minimum: same total as one line', async () => {
  const oneLine = await quoteLines([await partLine(tri, 0, { qty: 3 })])
  const threeLines = await quoteLines([
    await partLine(tri, 0, { qty: 1 }),
    await partLine(tri, 0, { qty: 1, colors: ['#000000'] }),
    await partLine(tri, 0, { qty: 1, colors: ['#ff0000'] }),
  ])
  near(threeLines.itemsTotalCents, oneLine.itemsTotalCents, 3, 'three lines of one part = one line of three')
  assert.ok(threeLines.itemsTotalCents >= 3 * cents(MIN) - 3)
  // a part split into pieces of different scale: still never under (units x minimum) in total
  const mixed = await quoteLines([await partLine(tri, 0, { scale: 0.3 }), await partLine(tri, 0, { scale: 0.6 }), await partLine(tri, 0, { scale: 0.9 })])
  assert.ok(mixed.itemsTotalCents >= 3 * cents(MIN) - 3, `${mixed.itemsTotalCents}`)
})

test('4.6 spare copies of a part next to complete sets: a set is one unit per copy, every spare copy is a unit of its own', async () => {
  // 2 complete copies (one group, quantity 2) + 2 spare copies of part 0 (loose) = 4 units, each at the minimum at this size
  const lines = [...await triSet('tri-set-0003', { qty: 2, scale: 0.5 }), await partLine(tri, 0, { qty: 2, scale: 0.5 })]
  const quote = await quoteLines(lines)
  assert.equal(quote.itemsTotalCents, 4 * cents(MIN), '2 sets + 2 spare copies')
  assert.deepEqual(quote.unitNotices, [], 'the loose part alone is not a complete model')
})

test('4.5 a whole-model line is one unit per copy (it is floored by itself, like any other model)', async () => {
  const quote = await quoteLines([await wholeLine(tri, { scale: 0.5, qty: 2 })])
  assert.equal(quote.items[0].unitPriceCents, cents(MIN))
  assert.equal(quote.itemsTotalCents, 2 * cents(MIN))
})

test('4.5 the quantity discount comes AFTER the minimum for parts too (12 copies of a part: the minimum, then 5% off)', async () => {
  const quote = await quoteLines([await partLine(tri, 0, { qty: 12 })])
  assert.equal(quote.items[0].unitPriceCents, cents(MIN * 0.95))
  assert.equal(quote.items[0].lineTotalCents, 12 * cents(MIN * 0.95))
})

test('4.5 the parts of a model whose parts are EACH over the minimum are floored when they are resized under it, as any other piece', async () => {
  const unit = async (qty: number, scale: number) => (await quoteLines([await partLine(multi, 0, { qty, scale })])).items[0].unitPriceCents as number
  const whole = await unit(2, 1)
  assert.ok(whole > cents(MIN) * 1.5, `the part's own price (${whole}) is well over the minimum`)
  assert.ok(Math.abs((await unit(2, 0.8)) - whole * 0.512) <= 1, 'over the minimum after the resize: by volume, as before')
  assert.equal(await unit(2, 0.5), cents(MIN), 'one eighth of the price is under the minimum: the floor, per piece')
})

test('4.5 the discount of a registered customer comes after the minimum on a part too', async () => {
  const viewer: Viewer = { id: data.discountUser.id, role: 'customer' }
  const quote = await quoteLines([await partLine(tri, 0)], viewer)
  const percent = quote.discountPercent as number
  assert.ok(percent > 0)
  assert.equal(quote.items[0].unitPriceCents, Math.round(cents(MIN) * (1 - percent / 100)))
  assert.equal(quote.items[0].undiscountedLineTotalCents, cents(MIN))
})

test('4.5 a shop product whose scale the shop fixed is floored too (a locked scale is not an exemption)', async () => {
  const prisma = await db()
  const product = await prisma.productTemplate.findUniqueOrThrow({ where: { id: lockedHalfProductId } })
  const item = {
    ...persistedCartItem({ model: 'T', variantColor: '#ffffff' }, data, 0),
    modelId: product.baseModelId, title: 'Prodotto scala 0,5', partId: null,
    options: { qty: 1, scale: 0.5, material: 'PLA', colors: ['#ffffff'], finish: 'standard', lockedConfig: true, productTemplateId: lockedHalfProductId, priceMultiplier: 1, lockDimensions: true, dimensionOverrides: null, infillPct: null, customText: null, toleranceClass: null },
  }
  const quote = await quoteLines([item])
  const full = await unitCents([{ model: 'V' }]) // same volume as the product's base model: the original-size price
  assert.ok(full / 8 < cents(MIN), 'by volume the product would cost less than the minimum')
  assert.equal(quote.items[0].unitPriceCents, cents(MIN))
})

test('a shop with NO minimum configured prices a resized piece by volume, as always', async () => {
  const prisma = await db()
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: null } as any })
  try {
    const one = await unitCents([{ model: 'V' }])
    const half = await unitCents([{ model: 'V', scale: 0.5 }])
    assert.ok(Math.abs(half - one * 0.125) <= 1, `${half} vs ${one * 0.125}`)
    assert.ok(half < cents(MIN))
    // nor a hand-set price, a product with a fixed scale, or a loose part
    assert.equal(await unitCents([{ model: 'sale3' as any }]), cents(3))
    assert.ok((await quoteLines([await partLine(tri, 0)])).items[0].unitPriceCents < cents(MIN))
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
