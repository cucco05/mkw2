// Step 4.2-ter A2 – parts of a multipart model are priced at THEIR OWN size, and no geometry sent by the browser can lower a price.
//
// The bug: the page sent a size in millimetres (the size of the PART times the scale) and the server turned it into a scale by dividing by
// the size of the WHOLE model, so a part smaller than its model was priced at about half. Now the server reads only the scale (bounded
// 0.1 to 5), and works out the size in millimetres itself, from the stored size of the part (or of the model when the whole model is sold).
// Fake Stripe, throw-away database, fake data.
import { db, resetDb } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'
import { scaledSize, sizeOf } from '../../lib/geometry'

let data: ScenarioData
let ipSeq = 0
const nextIp = () => `10.11.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `mp-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]

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
const requestOf = (items: ItemSpec[]) => buildQuoteRequest(items.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
const quoteOf = async (items: ItemSpec[], extra: Record<string, unknown> = {}) => {
  const request: any = requestOf(items)
  request.items = request.items.map((entry: any) => ({ ...entry, ...extra }))
  const r = await post('quote', request)
  assert.equal(r.status, 200, r.text)
  return r.json
}
const unit = async (spec: ItemSpec, extra: Record<string, unknown> = {}) => (await quoteOf([spec], extra)).items[0].unitPriceCents as number

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  await seedScenarioConfig()
  data = await seedScenarioModels('mp')
  await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('the page no longer sends a size in millimetres', () => {
  const request = requestOf([{ model: 'P', part: 1, qty: 2 }, { model: 'V', scale: 1.3 }])
  assert.ok(request.items.every((entry) => !('targetDimensions' in entry)))
})

test('a size in millimetres sent by the browser changes no price, for a part, for a model, tiny or huge', async () => {
  const cases: ItemSpec[] = [{ model: 'P', part: 1 }, { model: 'P', part: 2, qty: 3 }, { model: 'V' }, { model: 'V', scale: 1.7 }, { model: 'L', qty: 4 }]
  const sizes = [{ x: 1, y: 1, z: 1 }, { x: 0.01 }, { x: 5000, y: 5000, z: 5000 }, { x: 40, y: 40, z: 60 }, { x: 83.5, y: 61.1, z: 47.9 }, { y: 7 }]
  for (const spec of cases) {
    const clean = await unit(spec)
    for (const target of sizes) {
      for (const lock of [true, false, undefined]) {
        assert.equal(await unit(spec, { targetDimensions: target, lockDimensions: lock }), clean, `${spec.model}${spec.part ?? ''} with ${JSON.stringify(target)} lock=${lock}`)
      }
    }
  }
})

test('each part is counted at its own price and the parts add up to the whole model', async () => {
  const p1 = await unit({ model: 'P', part: 1 })
  const p2 = await unit({ model: 'P', part: 2 })
  const whole = await unit({ model: 'P' })
  assert.ok(p1 > p2 && p2 > 0, 'the bigger part costs more')
  assert.ok(Math.abs(p1 + p2 - whole) <= 1, `part 1 (${p1}) + part 2 (${p2}) = the whole model (${whole}), to a cent of rounding`)
  // the part prices are the model's stored part prices (what the page of the model shows)
  assert.equal(p1, Math.round(data.parts[0].priceUsd! * 100))
  assert.equal(p2, Math.round(data.parts[1].priceUsd! * 100))
})

test('quantities of parts are respected line by line', async () => {
  const q = await quoteOf([{ model: 'P', part: 1, qty: 3 }, { model: 'P', part: 2, qty: 5 }, { model: 'P', part: 1, qty: 1, material: 'PETG' }])
  const [a, b, c] = q.items
  assert.equal(a.qty, 3); assert.equal(a.lineTotalCents, a.unitPriceCents * 3)
  assert.equal(b.qty, 5); assert.equal(b.lineTotalCents, b.unitPriceCents * 5)
  assert.equal(c.qty, 1)
  assert.equal(q.itemsTotalCents, a.lineTotalCents + b.lineTotalCents + c.lineTotalCents)
})

test('scales: uniform and per axis, applied to the part, bounded 0.1 to 5, and 100% is exactly 100%', async () => {
  const base = await unit({ model: 'P', part: 1 })
  assert.equal(await unit({ model: 'P', part: 1, scale: 1 }), base, '100% is the stored price, with no millimetre rounding in between')
  assert.equal(await unit({ model: 'P', part: 1 }, { scale: undefined }), base)
  for (const [scale, factor] of [[2, 8], [0.5, 0.125], [1.5, 3.375]] as const) {
    const got = await unit({ model: 'P', part: 1, scale })
    assert.ok(Math.abs(got - base * factor) <= Math.max(2, base * factor * 0.002), `scale ${scale}: ${got} vs ${base * factor}`)
  }
  // per axis: the product of the three scales
  const stretched = await unit({ model: 'P', part: 1, dimensionOverrides: { x: 2, y: 0.5, z: 3 } })
  assert.ok(Math.abs(stretched - base * 3) <= 2, `2 x 0.5 x 3 = 3: ${stretched} vs ${base * 3}`)
  // out of range values: above 5 is refused, below 0.1 is brought up to 0.1 by the server
  const refused = await post('quote', { ...requestOf([{ model: 'P', part: 1 }]), items: [{ ...requestOf([{ model: 'P', part: 1 }]).items[0], scale: 9 }] })
  assert.equal(refused.status, 400, 'scale 9 is refused')
  assert.equal(await unit({ model: 'V' }, { scale: 0.0001, scaleX: 0.0001, scaleY: 0.0001, scaleZ: 0.0001 }), await unit({ model: 'V', scale: 0.1 }), '0.0001 is 0.1')
})

test('the size stored for production is the part\'s own size times the validated scale, never what the browser said', async () => {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany(); await prisma.printOrder.deleteMany(); await prisma.rateLimit.deleteMany()
  const request: any = requestOf([{ model: 'P', part: 1, qty: 2, scale: 1.5 }, { model: 'V' }, { model: 'P', part: 2, scale: 2 }, { model: 'L', dimensionOverrides: { x: 2, y: 0.5, z: 3 } }])
  request.items = request.items.map((entry: any) => ({ ...entry, targetDimensions: { x: 1, y: 1, z: 1 } })) // a lying browser
  const q = await post('quote', request)
  assert.equal(q.status, 200, q.text)
  const s = await post('session', { checkoutKey: newKey(), expectedTotalCents: q.json.totalCents, ...request })
  assert.equal(s.status, 200, s.text)
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: s.json.orderId } })
  const lines = (order.metadata as any).checkout.lines as any[]
  const tenth = (v: number) => Math.round(v * 10) / 10
  const part = (n: number) => sizeOf({ sizeXmm: data.parts[n].sizeXmm, sizeYmm: data.parts[n].sizeYmm, sizeZmm: data.parts[n].sizeZmm })!
  const expectedA = scaledSize(part(0), { x: 1.5, y: 1.5, z: 1.5 })
  assert.deepEqual(lines[0].targetDimensions, { x: tenth(expectedA.x), y: tenth(expectedA.y), z: tenth(expectedA.z) })
  const model = sizeOf({ sizeXmm: data.detail.V.sizeXmm, sizeYmm: data.detail.V.sizeYmm, sizeZmm: data.detail.V.sizeZmm })!
  assert.deepEqual(lines[1].targetDimensions, { x: tenth(model.x), y: tenth(model.y), z: tenth(model.z) })
  const expectedC = scaledSize(part(1), { x: 2, y: 2, z: 2 })
  assert.deepEqual(lines[2].targetDimensions, { x: tenth(expectedC.x), y: tenth(expectedC.y), z: tenth(expectedC.z) })
  const lamp = sizeOf({ sizeXmm: data.detail.L.sizeXmm, sizeYmm: data.detail.L.sizeYmm, sizeZmm: data.detail.L.sizeZmm })!
  assert.deepEqual(lines[3].targetDimensions, { x: tenth(lamp.x * 2), y: tenth(lamp.y * 0.5), z: tenth(lamp.z * 3) }, 'each axis has its own scale')
  assert.ok(lines.every((l) => l.targetDimensions.x > 1), 'not the 1 x 1 x 1 the browser claimed')
})

test('a part with no stored size gets no size at all (never the model\'s), and is still priced from its own price', async () => {
  const prisma = await db()
  const part = await prisma.modelPart.create({ data: { modelId: data.ids.P, index: 2, name: 'Senza misure', filePath: 'models/x/none.stl', volumeMm3: 20000, priceUsd: 2 } as any })
  try {
    const { buildCardQuote } = await import('../../lib/checkout-quote')
    viewerGuards.getViewer = async () => null
    const request: any = requestOf([{ model: 'P' }])
    const built = await buildCardQuote({ items: [{ ...request.items[0], partId: part.id }], shippingMethod: 'pickup', rush: false, publicBaseUrl: null })
    assert.equal(built.lineItems[0].targetDimensions, undefined)
    assert.ok(built.lineItems[0].unitPrice > 0)
  } finally {
    await prisma.modelPart.delete({ where: { id: part.id } })
  }
})

test('fuzz: no combination of the geometry fields a browser can send makes a cart cheaper than the scale alone allows', async () => {
  const specs: ItemSpec[] = [{ model: 'P', part: 1 }, { model: 'P', part: 2 }, { model: 'V' }, { model: 'L' }]
  const rnd = (() => { let seed = 42; return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296 })()
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)]
  for (const spec of specs) {
    const floor = await unit(spec)
    for (let i = 0; i < 25; i++) {
      const extra: Record<string, unknown> = {
        targetDimensions: { x: rnd() * 400 + 0.01, y: pick([undefined, rnd() * 400 + 0.01]), z: pick([undefined, rnd() * 400 + 0.01]) },
        lockDimensions: pick([true, false, undefined]),
      }
      assert.ok((await unit(spec, extra)) >= floor, `${spec.model}${spec.part ?? ''} ${JSON.stringify(extra)} is cheaper than ${floor}`)
    }
  }
})
