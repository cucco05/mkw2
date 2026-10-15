// Golden regression for the checkout calculation (prices, discounts, shipping, errors and the order rows it writes).
//
// Why it exists: S2/S3 move the price calculation out of app/api/checkout/route.ts into lib/checkout-quote.ts. This test
// replays a fixed set of requests against the route and compares status + body (+ the order stored on commit) with a snapshot
// recorded from the code BEFORE that change (tests/fixtures/checkout-golden.json). Same inputs must give the same outputs.
//
//   run:                 npm run test:security          (compares with the snapshot)
//   record a snapshot:   GOLDEN_OUT=/path/file.json node --test --import tsx tests/security/checkout-golden.sec.ts
//   update deliberately: UPDATE_GOLDEN=1 ...            (only when pricing is meant to change, e.g. Phase 3)
//
// Fake Stripe, throw-away database, fake users/models. Random ids are replaced by stable labels before comparing.
import { db, installFakeStripe, postJson, resetDb, seedShopModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { viewerGuards, type Viewer } from '../../lib/viewer'

const GOLDEN_FILE = path.join(__dirname, '..', 'fixtures', 'checkout-golden.json')
const CUID = 'cjld2cjxh0000qzrmn831i7rn' // syntactically valid cuid that matches nothing in the database

type Snapshot = { status: number; body: unknown; order?: unknown }

const ids = new Map<string, string>()
const label = (id: string, name: string) => { ids.set(id, name); return id }
const orgId = () => [...ids].find(([, name]) => name === 'org')![0]

function normalize(value: unknown): unknown {
  let text = JSON.stringify(value ?? null)
  for (const [id, name] of ids) text = text.split(id).join(`<${name}>`)
  text = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\bc[a-z0-9]{24}\b/g, '<cuid>')
  return JSON.parse(text)
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
  }
  return value
}

let viewers: Record<'guest' | 'customer' | 'discounted' | 'orgMember' | 'admin', Viewer>
const m: Record<string, string> = {}
const parts: Record<string, string> = {}
const results: Record<string, Snapshot> = {}

const RATE = { id: 'shr_FAKE', active: true, display_name: 'Standard shipping', fixed_amount: { amount: 1500, currency: 'usd' } }
let shippingRate: any = RATE

const ADDRESS = { name: 'Test Person', line1: '1 Test St', city: 'Testville', postalCode: '12345', country: 'US' }

function item(model: string, extra: Record<string, unknown> = {}) {
  return { modelId: m[model], qty: 1, colors: ['#ffffff'], material: 'PLA', ...extra }
}

async function call(name: string, who: keyof typeof viewers, body: Record<string, unknown>, opts: { order?: boolean } = {}) {
  const { POST } = await import('../../app/api/checkout/route')
  viewerGuards.getViewer = async () => viewers[who]
  const prisma = await db()
  await prisma.printOrder.deleteMany() // every scenario starts with the same (empty) queue
  const res = await postJson(POST as any, 'http://localhost/api/checkout', body)
  const json = await res.clone().json().catch(() => null)
  const snapshot: Snapshot = { status: res.status, body: normalize(json) }
  if (opts.order) {
    const order = await prisma.printOrder.findFirst({ include: { items: { orderBy: { modelTitle: 'asc' } }, approvalRequests: true } })
    snapshot.order = order && normalize({
      status: order.status, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
      subtotalCents: order.subtotalCents, totalCents: order.totalCents, currency: order.currency,
      discountPercent: order.discountPercent, shippingMethod: order.shippingMethod, shippingAddress: order.shippingAddress,
      customerEmail: order.customerEmail, customerName: order.customerName, organizationId: order.organizationId,
      stripePaymentIntentIsPi: Boolean(order.stripePaymentIntentId),
      approvalRequests: order.approvalRequests.length,
      metadata: {
        rush: (order.metadata as any)?.rush, adminFreeCheckout: (order.metadata as any)?.adminFreeCheckout,
        estimatedTotalCents: (order.metadata as any)?.estimatedTotalCents, paymentMethod: (order.metadata as any)?.paymentMethod,
        cartItems: (order.metadata as any)?.cartItems,
      },
      items: order.items.map((i) => ({
        modelTitle: i.modelTitle, partName: i.partName, material: i.material, colors: i.colors, infillPct: i.infillPct,
        finish: i.finish, quantity: i.quantity, unitPriceCents: i.unitPriceCents, totalCents: i.totalCents,
        configuration: { ...(i.configuration as any), storageUrl: undefined, leadTimeHours: undefined, leadTimeWindowHours: undefined, etaConfidenceScore: undefined },
      })),
    })
  }
  results[name] = snapshot
  await prisma.printOrder.deleteMany()
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  await prisma.organizationMember.deleteMany()
  await prisma.organization.deleteMany({ where: { slug: { startsWith: 'golden-' } } })

  const mkUser = (name: string, data: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `${name}@sectest.invalid`, passwordHash: 'x', name, role: 'customer', ...data } as any })
  const [customer, discounted, orgMember, admin] = await Promise.all([
    mkUser('goldencustomer'),
    mkUser('goldendiscounted', { discountPercent: 10, isFriendsAndFamily: true, friendsAndFamilyPercent: 5 }),
    mkUser('goldenorg'),
    mkUser('goldenadmin', { role: 'admin' }),
  ])
  viewers = {
    guest: null,
    customer: { id: customer.id, role: 'customer' },
    discounted: { id: discounted.id, role: 'customer' },
    orgMember: { id: orgMember.id, role: 'customer' },
    admin: { id: admin.id, role: 'admin' },
  }
  label(customer.id, 'user:customer'); label(discounted.id, 'user:discounted'); label(orgMember.id, 'user:org'); label(admin.id, 'user:admin')

  const shop = await seedShopModel()
  const shopId = shop.user.id
  const mk = async (key: string, data: Record<string, unknown>) => {
    const model = await prisma.model.create({
      data: {
        title: `GOLDEN ${key}`, filePath: `models/${shopId}/${key}.stl`, fileType: 'stl', userId: shopId, visibility: 'public',
        sizeXmm: 80, sizeYmm: 80, sizeZmm: 60, ...data,
      } as any,
    })
    m[key] = label(model.id, `model:${key}`)
    return model
  }
  m.plain = label(shop.model.id, 'model:plain')
  await mk('sale', { volumeMm3: 400000, priceUsd: 200, salePriceUsd: 15.5 })
  await mk('flat', { volumeMm3: 50000, flatRatePricing: true })
  await mk('nodisc', { volumeMm3: 100000, disableCustomerDiscounts: true })
  await mk('novolume', { priceUsd: 33.33 })
  await mk('noprice', {})
  await mk('colors', { volumeMm3: 100000, colorSlotCount: 2, allowedColors: ['#ffffff', '#000000'] })
  const multi = await mk('multi', { volumeMm3: 200000 })
  const mkPart = async (key: string, data: Record<string, unknown>) => {
    const part = await prisma.modelPart.create({ data: { modelId: multi.id, name: key, filePath: `models/${shopId}/${key}.stl`, ...data } as any })
    parts[key] = label(part.id, `part:${key}`)
  }
  await mkPart('priced', { priceUsd: 12.34, volumeMm3: 50000, index: 0 })
  await mkPart('volume', { volumeMm3: 150000, index: 1 })
  const single = await mk('single', { volumeMm3: 120000 })
  const singlePart = await prisma.modelPart.create({ data: { modelId: single.id, name: 'only', filePath: `models/${shopId}/only.stl`, volumeMm3: 120000, priceUsd: 7.77 } as any })
  parts.only = label(singlePart.id, 'part:only')
  // a customer's own private model: only its owner may order it
  const own = await prisma.model.create({
    data: { title: 'GOLDEN own', filePath: `models/${customer.id}/own.stl`, fileType: 'stl', userId: customer.id, visibility: 'private', volumeMm3: 100000, priceUsd: 50, sizeXmm: 10, sizeYmm: 10, sizeZmm: 10 } as any,
  })
  m.own = label(own.id, 'model:own')

  const org = await prisma.organization.create({
    data: { name: 'Golden Org', slug: 'golden-org', createdById: admin.id, quoteApprovalRequired: true, requirePoAboveCents: 1, procurementConfig: { departments: [{ code: 'ENG', name: 'Engineering' }] } },
  })
  label(org.id, 'org')
  await prisma.organizationMember.create({ data: { organizationId: org.id, userId: orgMember.id, role: 'requester' } })

  let customerSeq = 0
  await installFakeStripe({
    'customers.create': async () => ({ id: `cus_GOLDEN_${++customerSeq}` }),
    'shippingRates.retrieve': async () => shippingRate,
    'paymentIntents.retrieve': async (id: string) => ({
      // 15.50 is the price of the cart the "card with a succeeded payment intent" scenario pays for (a PaymentIntent of another
      // amount is refused since S2/S3 step 3; that is tested in s2-checkout-amount.sec.ts, not in this snapshot of the old behaviour)
      id, object: 'payment_intent', status: 'succeeded', amount: 1550, amount_received: 1550, currency: 'usd', metadata: {}, customer: null, latest_charge: null, client_secret: 'secret_FAKE',
    }),
  })
})

// Replaces the whole row: nothing set by an earlier scenario (or an earlier run) may leak into the next one.
async function setConfig(data: Record<string, unknown>) {
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', ...data } as any })
}

async function scenarios() {
  const prisma = await db()
  const plain = { shipping: { method: 'pickup' } }
  const card = { paymentMethod: 'card' }

  // --- default (unconfigured) pricing ------------------------------------------------------------------------------------
  await setConfig({})
  await call('default: guest card preview', 'guest', { items: [item('plain')], ...plain, ...card })
  await call('default: guest card preview, sale price', 'guest', { items: [item('sale', { qty: 3 })], ...plain, ...card })

  // --- configured pricing ----------------------------------------------------------------------------------------------
  await setConfig({
    machineUsdPerHour: 2.5, laborUsdPerHour: 4, energyUsdPerHour: 0.3, minimumPriceUsd: 5, targetMarginPercent: 20,
    extraHourlyUsdAfterFirst: 1, plaPricePerKgUsd: 25, petgPricePerKgUsd: 30, printSpeedCm3PerHour: 20,
    batchDiscountTiers: [{ minQty: 3, percent: 5 }, { minQty: 10, percent: 10 }], rushMultiplier: 1.5, demandSurgeMultiplier: 1.1,
  })
  await call('guest card preview', 'guest', { items: [item('plain')], ...plain, ...card })
  await call('guest: quantity tiers, scale, two colors, finish, infill, tolerance', 'guest', {
    items: [item('plain', { qty: 5, scale: 1.5, colors: ['#ffffff', '#ff0000'], finish: 'smooth', infillPct: 30, toleranceClass: 'cosmetic' })],
    ...plain, ...card,
  })
  await call('guest: material PETG, draft tolerance, qty 10', 'guest', { items: [item('plain', { qty: 10, material: 'PETG', toleranceClass: 'draft' })], ...plain, ...card })
  await call('guest: rush', 'guest', { items: [item('plain')], rush: true, ...plain, ...card })
  await call('guest: fit_critical; a price multiplier sent by the browser (0.5) is ignored', 'guest', { items: [item('plain', { toleranceClass: 'fit_critical', priceMultiplier: 0.5 })], ...plain, ...card })
  await call('guest: price multiplier above limit is refused', 'guest', { items: [item('plain', { priceMultiplier: 9 })], ...plain, ...card })
  await call('guest: per-axis scale and target dimensions', 'guest', {
    items: [item('plain', { scaleX: 1.2, scaleY: 0.8, scaleZ: 1, lockDimensions: false, targetDimensions: { x: 96, y: 64, z: 60 } })],
    ...plain, ...card,
  })
  await call('guest: sale price model', 'guest', { items: [item('sale', { qty: 2 })], ...plain, ...card })
  await call('guest: flat rate model, three colors', 'guest', { items: [item('flat', { colors: ['#ffffff', '#ff0000', '#00ff00'] })], ...plain, ...card })
  await call('guest: model with price only', 'guest', { items: [item('novolume')], ...plain, ...card })
  await call('guest: model without any price data', 'guest', { items: [item('noprice')], ...plain, ...card })
  await call('guest: mixed cart', 'guest', { items: [item('plain', { qty: 2 }), item('sale'), item('flat'), item('novolume', { qty: 4 })], ...plain, ...card })

  // --- parts ---------------------------------------------------------------------------------------------------------
  await call('part with its own price', 'guest', { items: [item('multi', { partId: parts.priced })], ...plain, ...card })
  await call('part priced from volume (multipart split)', 'guest', { items: [item('multi', { partId: parts.volume })], ...plain, ...card })
  await call('single-part model, part price', 'guest', { items: [item('single', { partId: parts.only })], ...plain, ...card })
  await call('part of another model is refused', 'guest', { items: [item('plain', { partId: parts.priced })], ...plain, ...card })

  // --- colors / payload validation ------------------------------------------------------------------------------------
  await call('colors: none', 'guest', { items: [item('plain', { colors: [] })], ...plain, ...card })
  await call('colors: not allowed for the model', 'guest', { items: [item('colors', { colors: ['#123456'] })], ...plain, ...card })
  await call('colors: too many slots', 'guest', { items: [item('colors', { colors: ['#ffffff', '#000000', '#ffffff'] })], ...plain, ...card })
  await call('colors: allowed', 'guest', { items: [item('colors', { colors: ['#ffffff', '#000000'] })], ...plain, ...card })
  await call('payload: empty cart', 'guest', { items: [], ...plain, ...card })
  await call('payload: quantity 0', 'guest', { items: [item('plain', { qty: 0 })], ...plain, ...card })
  await call('payload: quantity 51', 'guest', { items: [item('plain', { qty: 51 })], ...plain, ...card })
  await call('payload: unknown payment method', 'guest', { items: [item('plain')], ...plain, paymentMethod: 'bitcoin' })
  await call('payload: unknown model', 'guest', { items: [item('plain', { modelId: 'does-not-exist' })], ...plain, ...card })
  await call('privacy: guest cannot order a customer model', 'guest', { items: [item('own')], ...plain, ...card })
  await call('privacy: the owner can', 'customer', { items: [item('own')], ...plain, ...card })

  // --- discounts ------------------------------------------------------------------------------------------------------
  await call('discounted customer', 'discounted', { items: [item('plain', { qty: 2 }), item('sale')], ...plain, ...card })
  await call('discounted customer, model that blocks discounts', 'discounted', { items: [item('nodisc', { qty: 2 })], ...plain, ...card })
  await call('admin: zero-total no-charge preview', 'admin', { items: [item('plain')], ...plain, ...card })
  await prisma.user.update({ where: { id: viewers.discounted!.id }, data: { discountPercent: 100, friendsAndFamilyPercent: 0, isFriendsAndFamily: false } })
  await call('100% discount is refused (zero total, non-admin)', 'discounted', { items: [item('plain')], ...plain, ...card })
  await prisma.user.update({ where: { id: viewers.discounted!.id }, data: { discountPercent: 10, friendsAndFamilyPercent: 5, isFriendsAndFamily: true } })

  // --- minimum order ----------------------------------------------------------------------------------------------------
  await setConfig({ minimumPriceUsd: 1, minimumOrderSubtotalUsd: 500 })
  await call('minimum order subtotal: guest below the minimum', 'guest', { items: [item('sale')], ...plain, ...card })
  await call('minimum order subtotal: admin is exempt', 'admin', { items: [item('sale')], ...plain, ...card })
  await setConfig({ minimumPriceUsd: 5 })

  // --- payment methods per role ---------------------------------------------------------------------------------------
  for (const method of ['cash', 'invoice', 'po', 'comped', 'paypal', 'quote']) {
    await call(`method ${method}: guest preview`, 'guest', { items: [item('sale')], ...plain, paymentMethod: method })
    await call(`method ${method}: admin preview`, 'admin', { items: [item('sale')], ...plain, paymentMethod: method })
  }
  await call('method cash with shipping', 'admin', { items: [item('sale')], shipping: { method: 'ship', address: ADDRESS }, paymentMethod: 'cash' })

  // --- shipping -------------------------------------------------------------------------------------------------------------
  const shipBody = { items: [item('sale', { qty: 2 })], shipping: { method: 'ship', address: ADDRESS }, ...card }
  delete process.env.STRIPE_SHIPPING_RATE_ID
  await call('shipping: incomplete address', 'guest', { ...shipBody, shipping: { method: 'ship', address: { name: 'x' } } })
  await call('shipping: no rate configured', 'guest', shipBody)
  process.env.STRIPE_SHIPPING_RATE_ID = 'shr_FAKE'
  shippingRate = RATE
  await call('shipping: fixed rate', 'guest', shipBody)
  await call('shipping: admin no-charge ignores the rate', 'admin', shipBody)
  shippingRate = { ...RATE, fixed_amount: { amount: 1500, currency: 'eur' } }
  await call('shipping: rate in another currency', 'guest', shipBody)
  shippingRate = { ...RATE, active: false }
  await call('shipping: inactive rate', 'guest', shipBody)
  shippingRate = { ...RATE, fixed_amount: null }
  await call('shipping: rate without a fixed amount', 'guest', shipBody)
  shippingRate = RATE
  delete process.env.STRIPE_SHIPPING_RATE_ID

  // --- organizations -----------------------------------------------------------------------------------------------------
  await call('organization: not a member', 'customer', { items: [item('sale')], ...plain, ...card, organizationId: CUID })
  await call('organization: requester must submit a quote', 'orgMember', { items: [item('sale')], ...plain, ...card, organizationId: orgId() })
  await call('organization: unknown department', 'orgMember', { items: [item('sale')], ...plain, paymentMethod: 'quote', organizationId: orgId(), departmentCode: 'XXX' })
  await call('organization: quote with a department', 'orgMember', { items: [item('sale')], ...plain, paymentMethod: 'quote', organizationId: orgId(), departmentCode: 'eng', projectCode: 'P-1' })

  // --- the same cart under other currencies (server-side display values and totals) -----------------------------------
  for (const currency of ['CAD', 'AUD']) {
    process.env.CURRENCY = currency
    process.env.NEXT_PUBLIC_CURRENCY = currency
    await call(`currency ${currency}: guest preview`, 'guest', { items: [item('plain', { qty: 3 })], ...plain, ...card })
    await call(`currency ${currency}: minimum order message`, 'guest', { items: [item('sale')], ...plain, ...card })
  }
  delete process.env.CURRENCY
  delete process.env.NEXT_PUBLIC_CURRENCY

  // --- commits: the orders that get written -------------------------------------------------------------------------------
  await setConfig({ minimumPriceUsd: 5, machineUsdPerHour: 2.5, laborUsdPerHour: 4, batchDiscountTiers: [{ minQty: 3, percent: 5 }] })
  await call('commit: quote request (customer)', 'customer', { items: [item('plain', { qty: 3 })], ...plain, paymentMethod: 'quote', commit: true }, { order: true })
  await call('commit: quote request (guest)', 'guest', { items: [item('sale')], ...plain, paymentMethod: 'quote', commit: true }, { order: true })
  await call('commit: admin cash order', 'admin', { items: [item('sale', { qty: 2 })], ...plain, paymentMethod: 'cash', commit: true }, { order: true })
  await call('commit: admin no-charge order', 'admin', { items: [item('plain')], ...plain, paymentMethod: 'comped', commit: true }, { order: true })
  await call('commit: admin card becomes no-charge', 'admin', { items: [item('plain')], ...plain, paymentMethod: 'card', commit: true }, { order: true })
  await call('commit: admin purchase order', 'admin', { items: [item('sale')], ...plain, paymentMethod: 'po', commit: true, paymentDetails: { purchaseOrderNumber: 'PO-1' } }, { order: true })
  await call('commit: admin invoice', 'admin', { items: [item('sale')], ...plain, paymentMethod: 'invoice', commit: true, paymentDetails: { billingEmail: 'billing@sectest.invalid' } }, { order: true })
  await call('commit: card without a payment intent id', 'customer', { items: [item('sale')], ...plain, ...card, commit: true })
  await call('commit: card with a succeeded payment intent', 'customer', { items: [item('sale')], ...plain, ...card, commit: true, paymentIntentId: 'pi_golden_FAKE' }, { order: true })
}

test('checkout calculation and orders are unchanged (golden snapshot)', async () => {
  await scenarios()
  const actual = sortKeys(results)

  const out = process.env.GOLDEN_OUT
  if (out || process.env.UPDATE_GOLDEN === '1') {
    const target = out || GOLDEN_FILE
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(actual, null, 2)}\n`)
    console.log(`golden snapshot written to ${target} (${Object.keys(actual).length} scenarios)`)
    return
  }

  assert.ok(existsSync(GOLDEN_FILE), `missing ${GOLDEN_FILE}`)
  const expected = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'))
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'the set of scenarios changed')
  for (const name of Object.keys(expected)) {
    assert.deepEqual(actual[name], expected[name], `scenario differs: ${name}`)
  }
})
