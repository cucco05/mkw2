// S2/S3 step 1 – groundwork: database changes, EUR, tax and the single source of totals.
// (The behaviour of the checkout itself is pinned by checkout-golden.sec.ts; nothing here changes what a customer sees.)
// Fake Stripe, throw-away database, fake data.
import { cartBody, db, installFakeStripe, postJson, resetDb, seedShopModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { viewerGuards } from '../../lib/viewer'
import { formatCurrency } from '../../lib/currency'

let modelId = ''
const RATE = { id: 'shr_FAKE', active: true, display_name: 'Spedizione Italia', fixed_amount: { amount: 700, currency: 'eur' } }
let shippingRate: any = RATE

const ENV_KEYS = ['CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'STRIPE_SHIPPING_RATE_ID'] as const
function withEnv<T>(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
}

async function checkout(body: Record<string, unknown>) {
  const { POST } = await import('../../app/api/checkout/route')
  viewerGuards.getViewer = async () => null
  const res = await postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, body))
  return { res, json: await res.clone().json().catch(() => ({})) as any }
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5 } as any })
  modelId = (await seedShopModel()).model.id
  await installFakeStripe({ 'shippingRates.retrieve': async () => shippingRate })
})

// ---- migration ------------------------------------------------------------------------------------------------------
test('migration is additive: it only adds columns, a table and indexes', () => {
  const sql = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', '20261015120000_checkout_payment_attempts', 'migration.sql'), 'utf8')
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    .replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL|RESTRICT|NO ACTION)/gi, '') // foreign key actions of the NEW table are fine
  for (const forbidden of [/\bDROP\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i, /ALTER\s+COLUMN/i, /\bUPDATE\b/i]) {
    assert.doesNotMatch(code, forbidden)
  }
  // every column added to an existing table is nullable or has a default, so existing rows stay valid
  for (const add of code.matchAll(/ADD COLUMN\s+"(\w+)"\s+([A-Z0-9()]+)([^,;]*)/g)) {
    assert.ok(!/NOT NULL/.test(add[3]) || /DEFAULT/.test(add[3]), `column ${add[1]} must be nullable or have a default`)
  }
})

test('existing orders get neutral defaults for the new columns', async () => {
  const prisma = await db()
  const order = await prisma.printOrder.create({ data: { subtotalCents: 1000, totalCents: 1000, currency: 'USD' } })
  assert.equal(order.shippingCents, 0)
  assert.equal(order.taxCents, 0)
  assert.equal(order.checkoutKey, null)
  assert.equal(order.paidAt, null)
  assert.equal(order.paymentReviewReason, null)
  assert.equal(order.guestAccessTokenHash, null)
  assert.equal(order.guestAccessExpiresAt, null)
  assert.equal(order.currency, 'USD')
})

test('one checkout key = one order', async () => {
  const prisma = await db()
  const base = { subtotalCents: 1000, totalCents: 1000 }
  await prisma.printOrder.create({ data: { ...base, checkoutKey: 'key-abc' } })
  await assert.rejects(prisma.printOrder.create({ data: { ...base, checkoutKey: 'key-abc' } }), /Unique constraint/)
  // orders without a key (everything created before, quotes, admin orders) are not affected
  await prisma.printOrder.create({ data: base })
  await prisma.printOrder.create({ data: base })
})

test('payment attempts: one row per Stripe session, unique ids, removed with their order', async () => {
  const prisma = await db()
  const order = await prisma.printOrder.create({ data: { subtotalCents: 1000, totalCents: 1000, currency: 'EUR' } })
  const attempt = { orderId: order.id, amountCents: 1000, currency: 'EUR', expiresAt: new Date(Date.now() + 1_800_000) }
  const first = await prisma.paymentAttempt.create({ data: { ...attempt, stripeSessionId: 'cs_test_a', stripePaymentIntentId: 'pi_a' } })
  assert.equal(first.status, 'creating') // reserved first, completed after Stripe answered
  assert.equal(first.amountReceivedCents, null)
  await assert.rejects(prisma.paymentAttempt.create({ data: { ...attempt, stripeSessionId: 'cs_test_a' } }), /Unique constraint/)
  await assert.rejects(prisma.paymentAttempt.create({ data: { ...attempt, stripeSessionId: 'cs_test_b', stripePaymentIntentId: 'pi_a' } }), /Unique constraint/)
  await prisma.paymentAttempt.create({ data: { ...attempt, stripeSessionId: 'cs_test_c' } }) // a retry on the same order
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: order.id } }), 2)
  await prisma.printOrder.delete({ where: { id: order.id } })
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: order.id } }), 0)
})

test('stripe events can record the order and session they were applied to', async () => {
  const prisma = await db()
  const event = await prisma.stripeEvent.create({ data: { id: 'evt_step1', type: 'checkout.session.completed', checkoutSessionId: 'cs_test_x', orderId: 'ord_x' } })
  assert.equal(event.orderId, 'ord_x')
  assert.equal((await prisma.stripeEvent.create({ data: { id: 'evt_step1_old', type: 'payment_intent.succeeded' } })).orderId, null)
})

// ---- EUR -----------------------------------------------------------------------------------------------------------------
test('EUR: the checkout works in euro and the order is stored in euro', async () => {
  await withEnv({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' }, async () => {
    const preview = await checkout({ paymentMethod: 'card' })
    assert.equal(preview.res.status, 200)
    assert.equal(preview.json.currency, 'EUR')
    const prisma = await db()
    await prisma.printOrder.deleteMany()
    const { res, json } = await checkout({ paymentMethod: 'quote', commit: true })
    assert.equal(res.status, 200)
    const order = await prisma.printOrder.findFirstOrThrow()
    assert.equal(order.currency, 'EUR')
    assert.equal(order.totalCents, json.amount)
  })
})

test('EUR: no conversion – an existing USD order is left exactly as it was', async () => {
  const prisma = await db()
  await prisma.printOrder.deleteMany()
  const legacy = await prisma.printOrder.create({ data: { subtotalCents: 1500, totalCents: 1500, currency: 'USD', paymentStatus: 'paid', status: 'completed' } })
  await withEnv({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' }, async () => {
    await checkout({ paymentMethod: 'quote', commit: true })
    const after = await prisma.printOrder.findUniqueOrThrow({ where: { id: legacy.id } })
    assert.equal(after.currency, 'USD')
    assert.equal(after.totalCents, 1500)
    assert.equal(after.subtotalCents, 1500)
    // the screens format an order with the order's own currency
    assert.equal(formatCurrency(after.totalCents / 100, after.currency as any), '$15.00')
  })
})

test('EUR: the shipping rate must be in the order currency', async () => {
  const ship = { shipping: { method: 'ship', address: { name: 'Mario Rossi', line1: 'Via Roma 1', city: 'Milano', postalCode: '20100', country: 'IT' } } }
  await withEnv({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', STRIPE_SHIPPING_RATE_ID: 'shr_FAKE' }, async () => {
    shippingRate = RATE
    const ok = await checkout({ paymentMethod: 'card', ...ship })
    assert.equal(ok.res.status, 200)
    assert.equal(ok.json.shippingRate.amount, 7)
    assert.equal(ok.json.shippingRate.currency, 'EUR')
    shippingRate = { ...RATE, fixed_amount: { amount: 700, currency: 'usd' } }
    const bad = await checkout({ paymentMethod: 'card', ...ship })
    assert.equal(bad.res.status, 500)
    assert.match(bad.json.error, /Shipping rate currency must be EUR/)
  })
  shippingRate = RATE
})

// ---- totals: one source for what is shown, stored and (later) sent to Stripe ---------------------------------------------------------
async function totalsFor(env: Parameters<typeof withEnv>[0]) {
  return withEnv({ CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', STRIPE_SHIPPING_RATE_ID: 'shr_FAKE', ...env }, async () => {
    const prisma = await db()
    await prisma.printOrder.deleteMany()
    const body = {
      items: [{ modelId, qty: 3, colors: ['#ffffff'], material: 'PLA' }],
      shipping: { method: 'ship', address: { name: 'Mario Rossi', line1: 'Via Roma 1', city: 'Milano', postalCode: '20100', country: 'IT' } },
      paymentMethod: 'quote',
    }
    const { POST } = await import('../../app/api/checkout/route')
    viewerGuards.getViewer = async () => null
    const preview = await (await postJson(POST as any, 'http://localhost/api/checkout', body)).json() as any
    const committed = await (await postJson(POST as any, 'http://localhost/api/checkout', { ...body, commit: true })).json() as any
    const order = await prisma.printOrder.findFirstOrThrow({ include: { items: true } })
    return { preview, committed, order }
  })
}

test('totals: tax not configured (development) leaves the total as it is and stores no tax', async () => {
  const { preview, order } = await totalsFor({})
  const items = order.items.reduce((sum, item) => sum + item.totalCents, 0)
  assert.equal(order.taxCents, 0)
  assert.equal(order.shippingCents, 700)
  assert.equal(order.totalCents, items + 700)
  assert.equal(order.totalCents, preview.amount)
})

test('totals: exclusive tax is added once, and what is shown equals what is stored', async () => {
  const { preview, committed, order } = await totalsFor({ TAX_MODE: 'exclusive', TAX_RATE_PERCENT: '22' })
  const items = order.items.reduce((sum, item) => sum + item.totalCents, 0)
  const expectedTax = Math.round(((items + 700) * 22) / 100)
  assert.equal(order.shippingCents, 700)
  assert.equal(order.taxCents, expectedTax)
  assert.equal(order.totalCents, items + 700 + expectedTax)
  assert.equal(preview.amount, order.totalCents)
  assert.equal(committed.amount, order.totalCents)
  assert.equal(Math.round(preview.estimatedTotal * 100), order.totalCents)
  assert.equal(Math.round(preview.total * 100), order.totalCents)
})

test('totals: inclusive tax is recorded but the total does not change', async () => {
  const none = await totalsFor({ TAX_MODE: 'none' })
  const inclusive = await totalsFor({ TAX_MODE: 'inclusive', TAX_RATE_PERCENT: '22' })
  assert.equal(inclusive.order.totalCents, none.order.totalCents)
  assert.equal(inclusive.order.taxCents, Math.round((inclusive.order.totalCents * 22) / 122))
  assert.equal(none.order.taxCents, 0)
})
