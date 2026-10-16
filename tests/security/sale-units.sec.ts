// Step 4.6 - the UNIT OF SALE of a model made of several parts, checked through the real quote route.
//
// The rule (lib/sale-units.ts): lines that carry the same `setKey` are believed to be ONE complete copy of the model only when the server can check it -
// every part once, one quantity, one scale. A believed set costs the PRICE OF THE MODEL (what the page advertises, offers included), floored once for the
// unit; anything else is sold as single parts, each with its own floor, EXACTLY as if the key were not there. The browser can not lower a price with a key.
//
// Independent oracle: the price of the same model sold as ONE line (no part, no key), which these tests quote separately; it does not go through the code
// that decides about sets. Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb } from './_harness'
import { installFakeCheckout } from './_fake-checkout'
import { persistedCartItem, seedScenarioConfig, seedScenarioModels, type ItemSpec, type ScenarioData } from './_checkout-scenarios'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards } from '../../lib/viewer'
import { buildQuoteRequest } from '../../lib/checkout-client'

let data: ScenarioData
let ipSeq = 0
const nextIp = () => `10.12.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', STRIPE_MINIMUM_CHARGE_CENTS: '0', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
const MIN = 500 // the shop's minimum per unit in the scenario configuration (5.00)

async function quote(specs: ItemSpec[], mutate: (items: any[]) => void = () => {}) {
  viewerGuards.getViewer = async () => null
  const request: any = buildQuoteRequest(specs.map((spec, i) => persistedCartItem(spec, data, i)) as any, { shippingMethod: 'pickup', rush: false })
  // (the key is put on the request here, from the spec: these tests are about what the SERVER does with a key, whoever wrote it)
  request.items.forEach((entry: any, i: number) => { if (specs[i].setKey) entry.setKey = specs[i].setKey })
  mutate(request.items)
  const mod = await import('../../app/api/checkout/quote/route')
  const res = (await (mod.POST as any)(new NextRequest('http://localhost/api/checkout/quote', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: JSON.stringify(request),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
const ok = async (specs: ItemSpec[], mutate?: (items: any[]) => void) => {
  const r = await quote(specs, mutate)
  assert.equal(r.status, 200, r.text)
  return r.json
}
const total = (q: any) => q.itemsTotalCents as number
const unitOf = async (spec: ItemSpec) => (await ok([spec])).items[0].unitPriceCents as number
const Q3 = (key: string | undefined, over: Partial<ItemSpec> = {}): ItemSpec[] => ([1, 2, 3] as const).map((part) => ({ model: 'Q', part, ...(key ? { setKey: key } : {}), ...over }))
const withoutKey = (specs: ItemSpec[]): ItemSpec[] => specs.map(({ setKey: _ignored, ...rest }) => rest)

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  await seedScenarioConfig()
  await configureTestMachine({ buildXmm: 2000, buildYmm: 2000, buildZmm: 2000 })
  data = await seedScenarioModels('su')
  await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ------------------------------------------------------------------------------------------------------------------------------------
test('T-B: a complete set costs the price of the model - the same as the model sold as one line, to the cent - and can cost less than its parts sold singly', async () => {
  const whole = await unitOf({ model: 'Q' })
  assert.ok(whole > MIN, 'the fixture model is above the shop minimum')
  const set = await ok(Q3('set-q-aaaa'))
  assert.equal(total(set), whole, 'set = model')
  assert.deepEqual(set.items.map((item: any) => item.unit?.kind), ['set', 'set', 'set'])
  assert.equal(set.items.reduce((sum: number, item: any) => sum + item.unitPriceCents, 0), whole)
  const singly = await ok(Q3(undefined))
  assert.ok(total(singly) > total(set), `three single parts (${total(singly)}) cost more than the complete model (${total(set)}): the shares of the small parts are lifted to the minimum`)
  // copies: quantity on every line
  const three = await ok(Q3('set-q-aaab', { qty: 3 }))
  assert.equal(total(three), whole * 3)
})

test('T-B: at every scale a complete set is the model at that scale (floor included), and the floor is applied ONCE for the unit', async () => {
  for (const scale of [0.1, 0.3, 0.5, 0.8, 1, 1.4, 2, 3]) {
    const whole = await unitOf({ model: 'Q', scale })
    const set = await ok(Q3('set-q-bbbb', { scale }))
    assert.equal(total(set), whole, `scale ${scale}`)
    assert.ok(total(set) >= MIN, `scale ${scale}: never under the minimum`)
  }
  const tiny = await ok(Q3('set-q-bbbc', { scale: 0.3 }))
  assert.equal(total(tiny), MIN, 'scale 0.3: the whole model costs the minimum once, not three times')
  const tinySingly = await ok(Q3(undefined, { scale: 0.3 }))
  assert.equal(total(tinySingly), MIN * 3, 'the same three parts bought singly: a minimum each')
})

test('T-B: colours may differ between the parts of a set; the price does not', async () => {
  const same = await ok(Q3('set-q-cccc'))
  const mixed = await ok([{ model: 'Q', part: 1, setKey: 'set-q-cccd' }, { model: 'Q', part: 2, setKey: 'set-q-cccd', colors: ['#000000'] }, { model: 'Q', part: 3, setKey: 'set-q-cccd', colors: ['#ff0000'] }])
  assert.deepEqual(mixed.items.map((item: any) => item.unit?.kind), ['set', 'set', 'set'])
  assert.equal(total(mixed), total(same))
})

test('T-A: a group that is not valid gets NOTHING of the set price: its lines cost exactly what they cost with no key', async () => {
  const causes: Array<[string, ItemSpec[]] | [string, ItemSpec[], string]> = [
    ['a part is missing', Q3('set-q-dd01').slice(0, 2)],
    ['a part twice', [...Q3('set-q-dd02'), { model: 'Q', part: 1, setKey: 'set-q-dd02' }]],
    ['different quantities', Q3('set-q-dd03').map((spec, i) => ({ ...spec, qty: i === 1 ? 2 : 1 }))],
    ['different scales', Q3('set-q-dd04').map((spec, i) => ({ ...spec, scale: i === 1 ? 1.5 : 1 }))],
    ['different scales on one axis', Q3('set-q-dd05').map((spec, i) => (i === 2 ? { ...spec, dimensionOverrides: { x: 1, y: 1, z: 1.2 } } : spec))],
    ['one key on two models', [...Q3('set-q-dd06'), { model: 'P', part: 1, setKey: 'set-q-dd06' }, { model: 'P', part: 2, setKey: 'set-q-dd06' }]],
    ['a key on a whole model', [{ model: 'Q', setKey: 'set-q-dd07' }]],
    ['a key on a ready-made product', [{ model: 'T', variantColor: '#ffffff', setKey: 'set-q-dd08' }]],
    ['a key on the part of a single-part model', [{ model: 'V', setKey: 'set-q-dd09' }], 'single-part'],
  ]
  const prisma = await db()
  const singlePart = await prisma.modelPart.findFirstOrThrow({ where: { modelId: data.ids.V } })
  for (const [label, specs, special] of causes) {
    // (the page adds a single-part model without a part; a part of it can still be named in a request)
    const mutate = special === 'single-part' ? (items: any[]) => { items[0].partId = singlePart.id } : undefined
    const keyed = await quote(specs, mutate)
    const loose = await quote(withoutKey(specs), mutate)
    assert.equal(keyed.status, loose.status, `${label}: same answer`)
    if (keyed.status !== 200) continue
    assert.deepEqual(keyed.json.items.map((item: any) => item.unitPriceCents), loose.json.items.map((item: any) => item.unitPriceCents), `${label}: every line costs what it costs with no key`)
    assert.equal(total(keyed.json), total(loose.json), label)
    assert.ok(keyed.json.items.every((item: any) => item.unit?.kind !== 'set'), `${label}: no set`)
    assert.ok((keyed.json.unitNotices ?? []).some((notice: any) => notice.code === 'SET_NOT_VALID'), `${label}: the customer is told`)
  }
})

test('the parts of a set at different SCALES are not a complete model: the reason is named, and nothing is cheaper than single parts', async () => {
  const q = await ok(Q3('set-q-ee01').map((spec, i) => ({ ...spec, scale: [1, 1.5, 1][i] })))
  const notice = (q.unitNotices ?? []).find((entry: any) => entry.code === 'SET_NOT_VALID')
  assert.equal(notice?.reason, 'SCALE_MISMATCH')
  assert.deepEqual(notice?.itemIndexes, [0, 1, 2])
})

test('loose parts that would make a complete model are only SUGGESTED, never grouped by the server', async () => {
  const q = await ok(Q3(undefined, { qty: 2 }))
  assert.ok(q.items.every((item: any) => item.unit?.kind === 'part'))
  assert.deepEqual((q.unitNotices ?? []).filter((n: any) => n.code === 'COULD_BE_COMPLETE_MODEL'), [{ code: 'COULD_BE_COMPLETE_MODEL', itemIndexes: [0, 1, 2], copies: 2 }])
  const twoOfThree = await ok(Q3(undefined).slice(0, 2))
  assert.deepEqual(twoOfThree.unitNotices ?? [], [])
})

test('P1: adding a single part, or one more copy, NEVER lowers the total - only forming a valid set can', async () => {
  const base = Q3(undefined).slice(0, 2) // two single parts
  let previous = total(await ok(base))
  for (const next of [Q3(undefined), [...Q3(undefined), { model: 'Q', part: 1 } as ItemSpec], [...Q3(undefined), { model: 'Q', part: 1, qty: 2 } as ItemSpec]]) {
    const current = total(await ok(next))
    assert.ok(current > previous, `${next.length} lines (${current}) cost more than before (${previous})`)
    previous = current
  }
  // the one gesture that lowers it is the customer grouping the three parts as a complete model, and the quote shows it
  const singly = total(await ok(Q3(undefined)))
  const grouped = total(await ok(Q3('set-q-ff01')))
  assert.ok(grouped < singly)
})

test('T-C (fuzz): no way of writing keys makes any line cheaper than its structure allows - a believed set is the model, anything else is single parts', async () => {
  let seed = 4242
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]
  const wholeAt = new Map<string, number>()
  const wholePrice = async (scale: number) => {
    const key = String(scale)
    if (!wholeAt.has(key)) wholeAt.set(key, await unitOf({ model: 'Q', scale }))
    return wholeAt.get(key) as number
  }
  const singleAt = new Map<string, number>()
  const singlePrice = async (part: 1 | 2 | 3, scale: number) => {
    const key = `${part}/${scale}`
    if (!singleAt.has(key)) singleAt.set(key, await unitOf({ model: 'Q', part, scale }))
    return singleAt.get(key) as number
  }
  for (let round = 0; round < 120; round++) {
    const lines: ItemSpec[] = []
    for (let i = 0, n = 1 + Math.floor(random() * 7); i < n; i++) {
      lines.push({ model: 'Q', part: pick([1, 2, 3] as const), qty: pick([1, 1, 2, 3]), scale: pick([0.3, 1, 1, 1.5]), ...(random() < 0.75 ? { setKey: pick(['set-q-gg01', 'set-q-gg02', 'set-q-gg03']) } : {}) })
    }
    // the oracle, written independently of the code under test: a key is believed only for exactly the three parts, one quantity, one scale
    let expected = 0
    const keys = new Set(lines.map((spec) => spec.setKey).filter(Boolean) as string[])
    const keyed = new Set<number>()
    for (const key of keys) {
      const members = lines.map((spec, index) => ({ spec, index })).filter((entry) => entry.spec.setKey === key)
      const parts = members.map((entry) => entry.spec.part).sort()
      const valid = parts.join() === '1,2,3' && new Set(members.map((entry) => entry.spec.qty)).size === 1 && new Set(members.map((entry) => entry.spec.scale)).size === 1
      if (!valid) continue
      expected += (await wholePrice(members[0].spec.scale ?? 1)) * (members[0].spec.qty ?? 1)
      members.forEach((entry) => keyed.add(entry.index))
    }
    for (const [index, spec] of lines.entries()) if (!keyed.has(index)) expected += (await singlePrice(spec.part as 1 | 2 | 3, spec.scale ?? 1)) * (spec.qty ?? 1)
    const q = await ok(lines)
    assert.equal(total(q), expected, `round ${round}: ${JSON.stringify(lines.map((s) => [s.part, s.qty, s.scale, s.setKey]))}`)
  }
})

test('the price of a model that is on sale is the SALE price for the complete model, and the parts add up to it', async () => {
  const sale = data.detail.R.priceUsd!
  assert.ok(sale > 0)
  const whole = await unitOf({ model: 'R' })
  const set = await ok([{ model: 'R', part: 1, setKey: 'set-r-aaaa' }, { model: 'R', part: 2, setKey: 'set-r-aaaa' }])
  assert.equal(whole, Math.round(sale * 100), 'the model as one line is the advertised price')
  assert.equal(total(set), Math.round(sale * 100), 'the complete model is the advertised price')
  // and the parts the page lists add up to the model's price, to the cent
  assert.equal(data.partsOf.R.reduce((sum, part) => sum + Math.round((part.priceUsd ?? 0) * 100), 0), Math.round(sale * 100))
})

test('advertised = charged for a model of several parts: the page, the whole line and the set agree, the parts add up, and a part alone costs its share or the minimum', async () => {
  const advertised = Math.round(data.detail.Q.priceUsd! * 100)
  assert.equal(advertised, await unitOf({ model: 'Q' }))
  assert.equal(advertised, total(await ok(Q3('set-q-hhhh'))))
  assert.equal(data.partsOf.Q.reduce((sum, part) => sum + Math.round((part.priceUsd ?? 0) * 100), 0), advertised, 'the parts listed by the page add up to the price of the model')
  for (const [index, part] of data.partsOf.Q.entries()) {
    const alone = await unitOf({ model: 'Q', part: (index + 1) as 1 | 2 | 3 })
    assert.equal(alone, Math.max(MIN, Math.round(part.priceUsd! * 100)), `part ${index + 1} bought alone`)
  }
})

test('F2: an option that lowers the price (draft tolerance, x0.94) is applied AFTER the floor, so it can not take a unit under the minimum', async () => {
  const standard = await unitOf({ model: 'V', scale: 0.5 })
  const draft = await unitOf({ model: 'V', scale: 0.5, toleranceClass: 'draft' })
  assert.equal(standard, MIN)
  assert.equal(draft, MIN, 'draft at the floor costs the floor, not 94% of it')
  // above the floor the option still works as before
  const big = await unitOf({ model: 'V', scale: 1 })
  const bigDraft = await unitOf({ model: 'V', scale: 1, toleranceClass: 'draft' })
  assert.ok(bigDraft < big && bigDraft >= MIN)
  // the same for a complete model
  const setDraft = await ok(Q3('set-q-iiii', { scale: 0.3, toleranceClass: 'draft' }))
  assert.equal(total(setDraft), MIN)
})

test('the key is checked, not trusted: a malformed key is refused, an extra field changes nothing', async () => {
  const bad = await quote(Q3('x'))
  assert.equal(bad.status, 400, 'too short')
  const weird = await quote(Q3('set q 0001!'))
  assert.equal(weird.status, 400, 'characters outside the allowed ones')
  const long = await quote(Q3('k'.repeat(41)))
  assert.equal(long.status, 400, 'too long')
  const extra = await ok(Q3('set-q-jjjj'), (items) => { items.forEach((entry) => { entry.units = 99; entry.setPrice = 1; entry.waiver = true; entry.minimumPriceCents = 0 }) })
  assert.equal(total(extra), total(await ok(Q3('set-q-jjjj'))), 'unknown fields are ignored')
})
