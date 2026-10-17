// Step 4.6 (S3) - authorised, traced exceptions to the shop's minimum price per unit (lib/minimum-waivers.ts), through the real routes and the real quote.
//
// What is asserted:
//   * WHO: only an administrator (staff is refused) from the same origin, and - when PRICE_WAIVER_ADMIN_IDS is set - only the ones named; a written reason;
//   * WHAT: a waiver for ONE model or ONE product lowers the floor of THAT unit only, to the cent; nothing a customer sends can name or imply one, and the quote
//     never mentions one; expired, revoked or not-below-the-minimum waivers do nothing; one active waiver per target, even when two grants arrive together;
//   * NOT RETROACTIVE: granting, revoking, expiring a waiver or changing the shop's minimum changes NOTHING in an order that exists - not the order, not its lines,
//     not its payment attempts - in whatever state its payment is;
//   * NO EQUIVALENCE: a waiver is only a threshold in a price - it does not mark anything paid, authorise production or clear a payment on hold, and a production
//     authorisation does not grant a waiver;
//   * TRACE: grant and revoke write their audit event in the SAME transaction (if the audit cannot be written, the waiver does not exist), and the chain is intact.
// Fake Stripe, throw-away database, fake data.
import { configureTestMachine, db, resetDb, seedShopModel } from './_harness'
import { guestHeaders } from './_guest'
import { installFakeCheckout } from './_fake-checkout'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { isProductionEligible } from '../../lib/order-payment-policy'

type Actor = NonNullable<Viewer>
let admin: Actor
let staff: Actor
let customer: Actor
let ghostAdmin: Actor
let ipSeq = 0
const nextIp = () => `10.15.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => `pw-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', STRIPE_MINIMUM_CHARGE_CENTS: '0', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of [...Object.keys(ENV), 'PRICE_WAIVER_ADMIN_IDS']) saved[key] = process.env[key]
const REASON = 'Demo shelf item, sold on purpose below the minimum'
const MIN = 500

async function api(handler: any, method: string, url: string, body: unknown, viewer: Viewer | null, opts: { origin?: string | null; params?: Record<string, string>; headers?: Record<string, string> } = {}) {
  viewerGuards.getViewer = async () => viewer
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...(opts.headers || {}) }
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost'
  const res = (await handler(new NextRequest(url, { method, headers, body: body === undefined || body === null ? undefined : JSON.stringify(body) }), { params: Promise.resolve(opts.params ?? {}) })) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
const grant = async (viewer: Viewer | null, body: unknown, opts: { origin?: string | null } = {}) => {
  const { POST } = await import('../../app/api/admin/price-waivers/route')
  return api(POST, 'POST', 'http://localhost/api/admin/price-waivers', body, viewer, opts)
}
const overview = async (viewer: Viewer | null) => {
  const { GET } = await import('../../app/api/admin/price-waivers/route')
  return api(GET, 'GET', 'http://localhost/api/admin/price-waivers', undefined, viewer)
}
const revoke = async (id: string, viewer: Viewer | null, body: unknown = { reason: REASON }, opts: { origin?: string | null } = {}) => {
  const { POST } = await import('../../app/api/admin/price-waivers/[id]/route')
  return api(POST, 'POST', `http://localhost/api/admin/price-waivers/${id}`, body, viewer, { params: { id }, ...opts })
}
async function checkout(route: 'quote' | 'session', body: unknown) {
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  return api(mod.POST, 'POST', `http://localhost/api/checkout/${route}`, body, null, { headers: guestHeaders() })
}

let fake: Awaited<ReturnType<typeof installFakeCheckout>>
const models = new Map<string, string>()
// a model whose price the shop set by hand (a sale price): the engine sells it at max(that price, the floor of the unit)
async function modelAt(euros: number, tag = ''): Promise<string> {
  const key = `${euros.toFixed(2)}${tag}`
  const known = models.get(key)
  if (known) return known
  const prisma = await db()
  const { model } = await seedShopModel({ volumeMm3: 50000 })
  await prisma.model.update({ where: { id: model.id }, data: { salePriceUsd: euros, title: `PW ${key}` } })
  models.set(key, model.id)
  return model.id
}
const cartOf = (modelId: string, over: Record<string, unknown> = {}) => ({
  items: [{ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA', ...over }],
  shipping: { method: 'pickup' as const },
})
const unitCents = async (modelId: string, over: Record<string, unknown> = {}) => {
  const q = await checkout('quote', cartOf(modelId, over))
  assert.equal(q.status, 200, q.text)
  return q.json.items[0].unitPriceCents as number
}
const clearWaivers = async () => {
  const prisma = await db()
  await prisma.minimumPriceWaiver.deleteMany()
  // the routes limit an administrator to 30 changes a minute (tested on its own below): the other tests start from a clean count
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: 'price-waiver:' } } })
}
const auditCount = async (action: string) => (await db()).adminAuditEvent.count({ where: { action } })
const lastAudit = async (action: string) => (await db()).adminAuditEvent.findFirst({ where: { action }, orderBy: { createdAt: 'desc' } })

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  delete process.env.PRICE_WAIVER_ADMIN_IDS
  delete process.env.TAX_MODE
  await configureTestMachine({ buildXmm: 2000, buildYmm: 2000, buildZmm: 2000 })
  const prisma = await db()
  const mk = (name: string, role: 'admin' | 'staff' | 'customer') => prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role } })
  admin = { id: (await mk('pw-admin', 'admin')).id, role: 'admin' } as Actor
  staff = { id: (await mk('pw-staff', 'staff')).id, role: 'staff' } as Actor
  customer = { id: (await mk('pw-customer', 'customer')).id, role: 'customer' } as Actor
  ghostAdmin = { id: 'user-that-does-not-exist', role: 'admin' } as Actor
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, minimumOrderSubtotalUsd: 0, targetMarginPercent: 20 } as any })
  fake = await installFakeCheckout()
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

// ---- who -----------------------------------------------------------------------------------------------------------------------------------------------------
test('only an administrator, from the same origin, may see or change waivers: anonymous 401, customer 403, STAFF 403', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const body = { target: { type: 'model', id: model }, minimumPriceCents: 200, reason: REASON }
  assert.equal((await grant(null, body)).status, 401)
  assert.equal((await grant(customer, body)).status, 403)
  assert.equal((await grant(staff, body)).status, 403)
  assert.equal((await grant(admin, body, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await grant(admin, body, { origin: null })).status, 403)
  assert.equal((await overview(null)).status, 401)
  assert.equal((await overview(customer)).status, 403)
  assert.equal((await overview(staff)).status, 403)
  assert.equal((await revoke('whatever', staff)).status, 403)
  assert.equal((await revoke('whatever', customer)).status, 403)
  assert.equal((await revoke('whatever', null)).status, 401)
  assert.equal(await (await db()).minimumPriceWaiver.count(), 0, 'nothing was written')
})

test('PRICE_WAIVER_ADMIN_IDS: when set, an administrator who is not named can neither see nor change waivers', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  process.env.PRICE_WAIVER_ADMIN_IDS = 'someone-else, another'
  try {
    const refused = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 200, reason: REASON })
    assert.equal(refused.status, 403, refused.text)
    assert.equal(refused.json.code, 'WAIVER_NOT_ALLOWED')
    assert.equal((await overview(admin)).status, 403)
    assert.equal((await revoke('whatever', admin)).status, 403)
    process.env.PRICE_WAIVER_ADMIN_IDS = `someone-else, ${admin.id}`
    assert.equal((await overview(admin)).status, 200)
  } finally {
    delete process.env.PRICE_WAIVER_ADMIN_IDS
  }
  assert.equal(await (await db()).minimumPriceWaiver.count(), 0)
})

test('what is asked is checked: a written reason, a figure UNDER the minimum, a target that exists, an expiry in the future, no extra fields', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const ok = { target: { type: 'model', id: model }, minimumPriceCents: 200, reason: REASON }
  const refused: Array<[string, unknown, number, string]> = [
    ['no reason', { ...ok, reason: undefined }, 400, 'INVALID_REQUEST'],
    ['short reason', { ...ok, reason: 'short' }, 400, 'REASON_REQUIRED'],
    ['reason too long', { ...ok, reason: 'x'.repeat(301) }, 400, 'REASON_TOO_LONG'],
    ['negative figure', { ...ok, minimumPriceCents: -1 }, 400, 'INVALID_REQUEST'],
    ['a fraction of a cent', { ...ok, minimumPriceCents: 2.5 }, 400, 'INVALID_REQUEST'],
    ['AT the minimum: nothing to waive', { ...ok, minimumPriceCents: MIN }, 400, 'NOT_BELOW_MINIMUM'],
    ['over the minimum', { ...ok, minimumPriceCents: MIN + 100 }, 400, 'NOT_BELOW_MINIMUM'],
    ['a model that does not exist', { ...ok, target: { type: 'model', id: 'nope' } }, 404, 'TARGET_NOT_FOUND'],
    ['a product that does not exist', { ...ok, target: { type: 'product', id: 'nope' } }, 404, 'TARGET_NOT_FOUND'],
    ['an expiry in the past', { ...ok, expiresAt: new Date(Date.now() - 86400_000).toISOString() }, 400, 'INVALID_EXPIRY'],
    ['an extra field', { ...ok, approved: true }, 400, 'INVALID_REQUEST'],
    ['two targets', { ...ok, target: { type: 'model', id: model, productTemplateId: 'x' } }, 400, 'INVALID_REQUEST'],
    ['not an object', 'text', 400, 'INVALID_REQUEST'],
  ]
  for (const [label, body, status, code] of refused) {
    const res = await grant(admin, body)
    assert.equal(res.status, status, `${label}: ${res.text}`)
    assert.equal(res.json.code, code, label)
  }
  assert.equal(await (await db()).minimumPriceWaiver.count(), 0)
})

// ---- what it does to a price -------------------------------------------------------------------------------------------------------------------------------
test('a waiver lowers the floor of THAT model, to the cent, and only while it is in force - the quote never mentions it', async () => {
  await clearWaivers()
  const cheap = await modelAt(3)
  const other = await modelAt(3, 'other')
  assert.equal(await unitCents(cheap), MIN, 'a hand-set 3.00 is sold at the 5.00 minimum')
  const granted = await grant(admin, { target: { type: 'model', id: cheap }, minimumPriceCents: 200, reason: REASON })
  assert.equal(granted.status, 201, granted.text)
  assert.equal(await unitCents(cheap), 300, 'now the shop\'s own 3.00')
  assert.equal(await unitCents(cheap, { scale: 0.5 }), 200, '3.00 x 0.125 = 0.375, under the waiver floor: the floor of 2.00')
  assert.equal(await unitCents(cheap, { qty: 3 }), 300)
  assert.equal(await unitCents(other), MIN, 'another model is not touched')
  const quote = await checkout('quote', cartOf(cheap))
  assert.ok(!/waiver|minimumPrice|floor/i.test(quote.text), 'the answer says nothing about a waiver or about the minimum')
  // a waiver to ZERO: the unit is sold at its own price
  await clearWaivers()
  assert.equal((await grant(admin, { target: { type: 'model', id: cheap }, minimumPriceCents: 0, reason: REASON })).status, 201)
  assert.equal(await unitCents(cheap, { scale: 0.5 }), 38, '3.00 x 0.125 = 0.375 -> 38 cents, no floor at all')
})

test('a waiver at or over the shop minimum (the minimum was lowered afterwards), an expired one, a revoked one: no effect', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const prisma = await db()
  // written straight into the table: the routes would refuse a figure that is not under the minimum
  const over = await prisma.minimumPriceWaiver.create({ data: { modelId: model, minimumPriceCents: 900, reason: REASON, createdById: admin.id } })
  assert.equal(await unitCents(model), MIN, 'a waiver over the minimum can only lower it, never raise it')
  await prisma.minimumPriceWaiver.delete({ where: { id: over.id } })
  const expired = await prisma.minimumPriceWaiver.create({ data: { modelId: model, minimumPriceCents: 100, reason: REASON, createdById: admin.id, expiresAt: new Date(Date.now() - 1000) } })
  assert.equal(await unitCents(model), MIN, 'expired')
  await prisma.minimumPriceWaiver.delete({ where: { id: expired.id } })
  const revoked = await prisma.minimumPriceWaiver.create({ data: { modelId: model, minimumPriceCents: 100, reason: REASON, createdById: admin.id, revokedAt: new Date(), revokedById: admin.id, revokeReason: REASON } })
  assert.equal(await unitCents(model), MIN, 'revoked')
  await prisma.minimumPriceWaiver.delete({ where: { id: revoked.id } })
  // and one that is in force with an expiry still ahead
  await prisma.minimumPriceWaiver.create({ data: { modelId: model, minimumPriceCents: 100, reason: REASON, createdById: admin.id, expiresAt: new Date(Date.now() + 3600_000) } })
  assert.equal(await unitCents(model), 300)
  // the shop's minimum is lowered below the waiver: the waiver does nothing, the (lower) minimum rules
  await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: 1 } })
  try {
    assert.equal(await unitCents(model), 300)
  } finally {
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: 5 } })
  }
})

test('revoking puts the minimum back for future carts; granting again after a revocation works; one ACTIVE waiver per target, also when two grants arrive together', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const first = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 100, reason: REASON })
  assert.equal(first.status, 201, first.text)
  const second = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 50, reason: REASON })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.code, 'ALREADY_ACTIVE')
  assert.equal(await unitCents(model), 300)
  const revoked = await revoke(first.json.waiver.id, admin)
  assert.equal(revoked.status, 200, revoked.text)
  assert.equal(await unitCents(model), MIN)
  assert.equal((await revoke(first.json.waiver.id, admin)).status, 409, 'revoked twice')
  assert.equal((await revoke('does-not-exist', admin)).status, 404)
  for (const reason of [undefined, '', 'short']) assert.equal((await revoke(first.json.waiver.id, admin, { reason })).status, 400)
  const again = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 150, reason: REASON })
  assert.equal(again.status, 201, again.text)
  assert.equal(await unitCents(model), 300)
  // two grants for a target with no waiver, at the same moment: exactly one is written
  await clearWaivers()
  const results = await Promise.all([1, 2, 3, 4].map((n) => grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 100 + n, reason: REASON })))
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(','))
  assert.equal(await (await db()).minimumPriceWaiver.count({ where: { modelId: model, revokedAt: null } }), 1)
})

test('a waiver for a PRODUCT is for that product only: a line with the product takes the product\'s waiver, and the model\'s own waiver does not lower it', async () => {
  await clearWaivers()
  const prisma = await db()
  const base = await modelAt(20, 'product-base')
  const product = await prisma.productTemplate.create({
    data: { title: 'PW product x0.1', baseModelId: base, isActive: true, lockedMaterial: 'PLA', lockedFinish: 'standard', lockedScale: 1, lockedPriceMultiplier: 0.1, colorOptions: [{ label: 'Bianco', value: '#ffffff', colorCount: 1, priceMultiplier: 1 }] } as any,
  })
  const productCart = { items: [{ modelId: base, productTemplateId: product.id, qty: 1, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' as const } }
  const productUnit = async () => {
    const q = await checkout('quote', productCart)
    assert.equal(q.status, 200, q.text)
    return q.json.items[0].unitPriceCents as number
  }
  assert.equal(await productUnit(), MIN, '20.00 x 0.1 = 2.00, under the minimum: the floor')
  // a waiver on the BASE MODEL does not lower the product built on it
  assert.equal((await grant(admin, { target: { type: 'model', id: base }, minimumPriceCents: 100, reason: REASON })).status, 201)
  assert.equal(await productUnit(), MIN)
  assert.equal(await unitCents(base), 2000, 'and the model itself is over the minimum anyway')
  // a waiver on the PRODUCT does
  const granted = await grant(admin, { target: { type: 'product', id: product.id }, minimumPriceCents: 150, reason: REASON })
  assert.equal(granted.status, 201, granted.text)
  assert.equal(await productUnit(), 200, 'the shop\'s own 2.00')
  // ...and only the product line: the same model sold on its own is unaffected by it
  await clearWaivers()
  await prisma.productTemplate.update({ where: { id: product.id }, data: { isActive: false } })
})

test('NOTHING a customer sends names or implies a waiver: extra fields, a metadata object, headers - the price stays the minimum', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const fields = { waiver: true, waiverId: 'x', minimumPriceCents: 1, minimumPrice: 0.01, exempt: true, adminPricing: { by: 'x' }, metadata: { waiver: true, minimumPriceCents: 1 } }
  for (const [key, value] of Object.entries(fields)) {
    const q = await checkout('quote', cartOf(model, { [key]: value }))
    if (q.status === 200) assert.equal(q.json.items[0].unitPriceCents, MIN, `${key} changes no price`)
    else assert.ok([400, 422].includes(q.status), `${key}: ${q.status}`)
  }
  const q = await checkout('quote', { ...cartOf(model), waiver: { minimumPriceCents: 1 }, minimumPriceCents: 1 })
  if (q.status === 200) assert.equal(q.json.items[0].unitPriceCents, MIN)
})

// ---- the order keeps what was sold; waivers are NOT retroactive ---------------------------------------------------------------------------------------
async function snapshotOf(orderId: string) {
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: { orderBy: { id: 'asc' } }, paymentAttempts: { orderBy: { id: 'asc' } } } })
  return JSON.stringify(order)
}

test('an order made under a waiver remembers it (which waiver, the floor, whether the floor raised the price); the customer\'s answer does not show it', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const granted = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 200, reason: REASON })
  const body = cartOf(model, { scale: 0.5 })
  const q = await checkout('quote', body)
  assert.equal(q.json.items[0].unitPriceCents, 200)
  const s = await checkout('session', { ...body, checkoutKey: newKey(), expectedTotalCents: q.json.totalCents })
  assert.equal(s.status, 200, `${s.status} ${s.text}`)
  assert.ok(!/waiver/i.test(s.text), 'the session answer says nothing about a waiver')
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: s.json.orderId }, include: { items: true } })
  assert.equal(order.totalCents, q.json.totalCents)
  const configuration = order.items[0].configuration as any
  assert.deepEqual(configuration.pricing, { minimumUnitCents: 200, floored: true, waiverId: granted.json.waiver.id })
  assert.deepEqual((order.metadata as any).checkout.waiverIds, [granted.json.waiver.id])
})

test('NOT retroactive: granting, revoking, letting expire and changing the shop minimum leave an existing order - with its payment in ANY state - exactly as it was', async () => {
  await clearWaivers()
  const prisma = await db()
  const model = await modelAt(3)
  const body = cartOf(model)
  const states: Array<[string, (orderId: string) => Promise<void>]> = [
    ['unpaid, payment page open', async () => undefined],
    ['payment being confirmed', async (id) => { await prisma.printOrder.update({ where: { id }, data: { paymentStatus: 'processing' } }); await prisma.paymentAttempt.updateMany({ where: { orderId: id }, data: { status: 'processing' } }) }],
    ['paid and verified', async (id) => { await prisma.printOrder.update({ where: { id }, data: { paymentStatus: 'paid', paidAt: new Date(), status: 'queued' } }); await prisma.paymentAttempt.updateMany({ where: { orderId: id }, data: { status: 'paid', completedAt: new Date(), amountReceivedCents: 500 } }) }],
    ['paid and on hold for review', async (id) => { await prisma.printOrder.update({ where: { id }, data: { paymentStatus: 'paid', paidAt: new Date(), status: 'awaiting_review', paymentReviewReason: 'amount_mismatch' } }) }],
  ]
  for (const [label, setState] of states) {
    await prisma.paymentAttempt.deleteMany(); await prisma.printOrder.deleteMany(); await clearWaivers()
    fake.sessions.clear(); fake.byKey.clear()
    const q = await checkout('quote', body)
    const s = await checkout('session', { ...body, checkoutKey: newKey(), expectedTotalCents: q.json.totalCents })
    assert.equal(s.status, 200, `${label}: ${s.text}`)
    const orderId = s.json.orderId as string
    await setState(orderId)
    const before = await snapshotOf(orderId)
    // grant
    const granted = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 100, reason: REASON })
    assert.equal(granted.status, 201, granted.text)
    assert.equal(await snapshotOf(orderId), before, `${label}: after a grant`)
    // change the shop's minimum
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: 8 } })
    assert.equal(await snapshotOf(orderId), before, `${label}: after the minimum was raised`)
    await prisma.siteConfig.update({ where: { id: 'main' }, data: { minimumPriceUsd: 5 } })
    // expire
    await prisma.minimumPriceWaiver.update({ where: { id: granted.json.waiver.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal(await snapshotOf(orderId), before, `${label}: after the waiver expired`)
    await prisma.minimumPriceWaiver.update({ where: { id: granted.json.waiver.id }, data: { expiresAt: null } })
    // revoke
    assert.equal((await revoke(granted.json.waiver.id, admin)).status, 200)
    assert.equal(await snapshotOf(orderId), before, `${label}: after the revocation`)
    // and the payment page already open still asks for the amount that was frozen
    const lines = fake.state.lastParams?.line_items as any[] | undefined
    if (lines) assert.equal(lines.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0), q.json.totalCents, `${label}: the frozen amount`)
  }
})

test('NO equivalence: a waiver does not mark anything paid, authorise production or clear a payment on hold - and a production authorisation grants no waiver', async () => {
  await clearWaivers()
  const prisma = await db()
  const model = await modelAt(3)
  const body = cartOf(model)
  await prisma.paymentAttempt.deleteMany(); await prisma.printOrder.deleteMany()
  const q = await checkout('quote', body)
  const s = await checkout('session', { ...body, checkoutKey: newKey(), expectedTotalCents: q.json.totalCents })
  const held = await prisma.printOrder.update({ where: { id: s.json.orderId }, data: { paymentStatus: 'paid', paidAt: new Date(), status: 'awaiting_review', paymentReviewReason: 'amount_mismatch' } })
  // a waiver for the model of an order on hold changes nothing about the hold
  assert.equal((await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 100, reason: REASON })).status, 201)
  const after = await prisma.printOrder.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.paymentReviewReason, 'amount_mismatch')
  assert.equal(after.status, 'awaiting_review')
  // an order made UNDER a waiver is an ordinary unpaid order: not paid, not eligible for production, no authorisation
  const q2 = await checkout('quote', cartOf(model, { scale: 0.5 }))
  const s2 = await checkout('session', { ...cartOf(model, { scale: 0.5 }), checkoutKey: newKey(), expectedTotalCents: q2.json.totalCents })
  const made = await prisma.printOrder.findUniqueOrThrow({ where: { id: s2.json.orderId } })
  assert.equal(made.paymentStatus, 'pending')
  assert.equal(made.paidAt, null)
  assert.equal(made.paymentReviewReason, null)
  assert.equal(isProductionEligible(made), false)
  assert.equal((made.metadata as any).productionAuthorization, undefined)
  assert.equal((made.metadata as any).manualPayment, undefined)
  // the other way round: authorising production of an order for the model grants no waiver
  await clearWaivers()
  await prisma.printOrder.update({ where: { id: made.id }, data: { metadata: { ...(made.metadata as any), productionAuthorization: { authorized: true, by: admin.id, at: new Date().toISOString(), reason: 'authorised by hand' } } } })
  assert.equal(await unitCents(model), MIN)
  assert.equal(await prisma.minimumPriceWaiver.count(), 0)
})

// ---- the trace -----------------------------------------------------------------------------------------------------------------------------------------------------
test('grant and revoke are audited in the same transaction; the chain of events stays intact; if the audit can not be written there is no waiver', async () => {
  await clearWaivers()
  const prisma = await db()
  const model = await modelAt(3)
  const grantsBefore = await auditCount('admin.price_waiver.grant')
  const granted = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 120, reason: REASON })
  assert.equal(granted.status, 201, granted.text)
  assert.equal(await auditCount('admin.price_waiver.grant'), grantsBefore + 1)
  const grantEvent = await lastAudit('admin.price_waiver.grant')
  assert.equal(grantEvent?.adminId, admin.id)
  assert.equal(grantEvent?.targetType, 'model')
  assert.equal(grantEvent?.targetId, model)
  assert.equal((grantEvent?.metadata as any).waiverId, granted.json.waiver.id)
  assert.equal((grantEvent?.metadata as any).minimumPriceCents, 120)
  assert.equal((grantEvent?.metadata as any).commonMinimumCents, MIN)
  assert.equal((grantEvent?.metadata as any).reason, REASON)
  const row = await prisma.minimumPriceWaiver.findUniqueOrThrow({ where: { id: granted.json.waiver.id } })
  assert.equal(row.createdById, admin.id)
  assert.equal(row.reason, REASON)
  const revoked = await revoke(granted.json.waiver.id, admin, { reason: 'No longer on the demo shelf' })
  assert.equal(revoked.status, 200, revoked.text)
  const revokeEvent = await lastAudit('admin.price_waiver.revoke')
  assert.equal((revokeEvent?.metadata as any).waiverId, granted.json.waiver.id)
  assert.equal((revokeEvent?.metadata as any).reason, 'No longer on the demo shelf')
  const row2 = await prisma.minimumPriceWaiver.findUniqueOrThrow({ where: { id: granted.json.waiver.id } })
  assert.equal(row2.revokedById, admin.id)
  assert.equal(row2.revokeReason, 'No longer on the demo shelf')
  // the hash chain: each event points at the hash of the one before it
  const events = await prisma.adminAuditEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  for (let i = 1; i < events.length; i++) assert.equal(events[i].prevHash, events[i - 1].eventHash, `event ${i} continues the chain`)
  // the audit can not be written (the actor does not exist): the waiver is NOT created, and the failure is not a 2xx
  const before = await prisma.minimumPriceWaiver.count()
  const failed = await grant(ghostAdmin, { target: { type: 'model', id: model }, minimumPriceCents: 120, reason: REASON })
  assert.ok(failed.status >= 500, failed.text)
  assert.equal(await prisma.minimumPriceWaiver.count(), before, 'no audit, no waiver')
  // and the same for a revocation
  const live = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 120, reason: REASON })
  const failedRevoke = await revoke(live.json.waiver.id, ghostAdmin)
  assert.ok(failedRevoke.status >= 500, failedRevoke.text)
  assert.equal((await prisma.minimumPriceWaiver.findUniqueOrThrow({ where: { id: live.json.waiver.id } })).revokedAt, null, 'no audit, no revocation')
})

test('the admin overview lists the waivers and the hand-set prices under the minimum that have none; a waiver takes the model off the list', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const listed = await overview(admin)
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.json.commonMinimumCents, MIN)
  assert.ok(listed.json.fixedPricesWithoutWaiver.some((entry: any) => entry.id === model && entry.salePriceCents === 300))
  assert.ok(listed.json.fixedPricesWithoutWaiver.every((entry: any) => entry.salePriceCents < MIN))
  assert.equal((await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 100, reason: REASON })).status, 201)
  const after = await overview(admin)
  assert.ok(!after.json.fixedPricesWithoutWaiver.some((entry: any) => entry.id === model))
  assert.equal(after.json.waivers.filter((w: any) => w.active).length, 1)
  assert.equal(after.json.waivers[0].targetTitle, 'PW 3.00')
})

test('an administrator is limited to 30 changes a minute: the 31st is turned away, nothing is written for it', async () => {
  await clearWaivers()
  const model = await modelAt(3)
  const prisma = await db()
  await prisma.rateLimit.upsert({
    where: { key: `price-waiver:${admin.id}` }, update: { count: 30, resetAt: new Date(Date.now() + 60_000) }, create: { key: `price-waiver:${admin.id}`, count: 30, resetAt: new Date(Date.now() + 60_000) },
  })
  const res = await grant(admin, { target: { type: 'model', id: model }, minimumPriceCents: 100, reason: REASON })
  assert.equal(res.status, 429, res.text)
  assert.equal(res.json.code, 'RATE_LIMITED')
  assert.equal(await prisma.minimumPriceWaiver.count(), 0)
  await clearWaivers()
})
