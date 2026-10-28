// Step 4.6 (S5) – the public checkout takes ONLY cards and wallets, through Stripe.
//
// Step 4.6 S4 taught the production-release rule a fourth proof of payment: a PayPal capture the SERVER verified (`metadata.paypal.captureId` with
// `paymentStatus: 'paid'`). That exists for the old, administrator-only route (and its orders); it must not become a way for a guest to pay with PayPal. What is
// proved here:
//   * the pay endpoint has no field for a payment method, a provider or a payment proof: naming one is refused (400) and nothing is made;
//   * the order a guest makes is a card order, its payment page asks Stripe for cards only, it holds no PayPal data and it is NOT released to production;
//   * the old route refuses PayPal (and every other method but card/quote) to guests, customers and staff, with or without a session cookie;
//   * nothing an outside sender writes can become a PayPal proof (reserved key), and the proof itself needs a capture id AND "paid";
//   * the public pages and components do not offer PayPal: its button lives only in the administrators' billing page.
// Fake Stripe, throw-away database, fake data.
import { db, resetDb, seedShopModel, stripeCalls } from './_harness'
import { strongTestKey } from './_keys'
import { installFakeCheckout } from './_fake-checkout'
import { guestHeaders, newGuestBrowser, type GuestBrowser } from './_guest'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { RESERVED_ORDER_METADATA_KEYS, allowedPaymentMethods, releaseDecision, sanitizeExternalMetadata } from '../../lib/order-payment-policy'

type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
let fake: Fake
let modelId = ''
let browser: GuestBrowser
const ENV = { CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000' }
const saved: Record<string, string | undefined> = {}
for (const key of Object.keys(ENV)) saved[key] = process.env[key]
delete process.env.TAX_MODE; delete process.env.TAX_RATE_PERCENT
let ipSeq = 0
const nextIp = () => `10.12.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
let keySeq = 0
const newKey = () => strongTestKey(`ppm-${++keySeq}`)
const cart = () => ({ items: [{ modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' }, rush: false })

async function post(route: 'quote' | 'session', body: unknown, viewer: Viewer | null = null) {
  viewerGuards.getViewer = async () => viewer
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const res = (await (mod.POST as any)(new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders({}, browser) }, body: JSON.stringify(body),
  }), {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}
const counts = async () => ({ orders: await (await db()).printOrder.count(), stripeCreates: fake.state.createCalls })

test.before(async () => {
  await resetDb()
  Object.assign(process.env, ENV)
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  modelId = (await seedShopModel({ volumeMm3: 150000, priceUsd: 20 })).model.id
  await prisma.model.update({ where: { id: modelId }, data: { sizeXmm: 50, sizeYmm: 40, sizeZmm: 40, colorSlotCount: 4 } as any })
  fake = await installFakeCheckout()
  browser = newGuestBrowser()
})
test.beforeEach(async () => {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.rateLimit.deleteMany()
  Object.assign(fake.state, { createCalls: 0, createdSessions: 0, lastParams: null, allParams: [] })
  fake.sessions.clear(); fake.byKey.clear()
  stripeCalls.length = 0
})
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = value
  }
})

test('the pay endpoint has no field for a payment method, a provider or a proof of payment: naming one is refused and nothing is made', async () => {
  const total = (await post('quote', cart())).json.totalCents as number
  const before = await counts()
  const attempts: Array<Record<string, unknown>> = [
    { paymentMethod: 'paypal' }, { paymentMethod: 'card' }, { paymentMethod: 'cash' }, { provider: 'paypal' }, { payment_method_types: ['paypal'] },
    { paypal: { captureId: 'CAP-FAKE-1', paymentStatus: 'paid' } }, { metadata: { paypal: { captureId: 'CAP-FAKE-2', paymentStatus: 'paid' } } },
    { paymentStatus: 'paid' }, { paymentIntentId: 'pi_fake' }, { paypalOrderId: 'ORDER-FAKE' },
  ]
  for (const extra of attempts) {
    const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: total, ...cart(), ...extra })
    assert.equal(r.status, 400, `${JSON.stringify(extra)}: ${r.text}`)
    assert.equal(r.json.code, 'INVALID_REQUEST')
  }
  assert.deepEqual(await counts(), before)
})

test('a guest\'s order is a card order: Stripe is asked for cards only, no PayPal anywhere, and the order is not released to production', async () => {
  const total = (await post('quote', cart())).json.totalCents as number
  const r = await post('session', { checkoutKey: newKey(), expectedTotalCents: total, ...cart() })
  assert.equal(r.status, 200, r.text)
  const prisma = await db()
  const order = await prisma.printOrder.findUniqueOrThrow({ where: { id: r.json.orderId }, include: { paymentAttempts: true } })
  assert.equal(order.paymentMethod, 'card')
  assert.deepEqual(fake.state.lastParams.payment_method_types, ['card'])
  assert.ok(!/paypal/i.test(JSON.stringify([order, fake.state.allParams])), 'no mention of PayPal in the order or in what Stripe was asked')
  assert.equal((order.metadata as any)?.paypal, undefined)
  const decision = releaseDecision({ ...order, paymentAttempts: order.paymentAttempts, refundOperations: [] })
  assert.equal(decision.released, false, 'an unpaid guest order is not released')
  assert.notEqual(decision.basis, 'paypal_verified')
})

test('the OLD route refuses PayPal (and every method but card and quote) to guests, customers and staff - also with a session cookie - and makes no order', async () => {
  const { POST } = await import('../../app/api/checkout/route')
  const prisma = await db()
  const customer = await prisma.user.create({ data: { email: 'ppm-customer@sectest.invalid', passwordHash: 'x', name: 'ppm', role: 'customer' } })
  const staff = await prisma.user.create({ data: { email: 'ppm-staff@sectest.invalid', passwordHash: 'x', name: 'ppm', role: 'staff' } })
  const who: Array<[string, Viewer]> = [['guest', null], ['customer', { id: customer.id, role: 'customer' }], ['staff', { id: staff.id, role: 'staff' }]]
  for (const [label, viewer] of who) {
    for (const method of ['paypal', 'cash', 'invoice', 'po', 'comped']) {
      viewerGuards.getViewer = async () => viewer
      const res = (await (POST as any)(new NextRequest('http://localhost/api/checkout', {
        method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders({}, browser) },
        body: JSON.stringify({ ...cart(), commit: true, paymentMethod: method, paymentIntentId: 'paypal_order_fake' }),
      }), {})) as Response
      assert.equal(res.status, 403, `${label}/${method}`)
      assert.deepEqual((await res.json() as any).allowedPaymentMethods, ['card', 'quote'])
    }
  }
  assert.equal(await prisma.printOrder.count(), 0)
  assert.deepEqual([...allowedPaymentMethods('guest')], ['card', 'quote'])
})

test('nothing an outside sender writes can become a PayPal proof: the key is reserved, and the proof needs a capture id AND "paid"', async () => {
  assert.ok(RESERVED_ORDER_METADATA_KEYS.includes('paypal'))
  assert.deepEqual(sanitizeExternalMetadata({ paypal: { captureId: 'CAP-FAKE', paymentStatus: 'paid' }, note: 'ok' }), { note: 'ok' })
  const facts = (over: Record<string, unknown>) => ({
    paymentStatus: 'paid', paymentReviewReason: null, metadata: {}, totalCents: 5000, currency: 'EUR', paymentMethod: 'paypal', stripePaymentIntentId: null, stripeInvoiceId: null, paidAt: null,
    refundedCents: 0, financialRevision: 0, paymentAttempts: [], refundOperations: [], ...over,
  }) as any
  // the status says "paid" but there is no proof: not released
  assert.equal(releaseDecision(facts({})).released, false)
  assert.equal(releaseDecision(facts({ metadata: { paypal: { paymentStatus: 'paid' } } })).released, false, 'no capture id')
  assert.equal(releaseDecision(facts({ metadata: { paypal: { captureId: 'CAP-FAKE' } } })).released, false, 'not marked paid')
  assert.equal(releaseDecision(facts({ paymentStatus: 'pending', metadata: { paypal: { captureId: 'CAP-FAKE', paymentStatus: 'paid' } } })).released, false, 'the order is not paid')
  // the one shape the old, administrator-only route writes after the server checked the capture
  const verified = releaseDecision(facts({ metadata: { paypal: { captureId: 'CAP-FAKE', paymentStatus: 'paid' } } }))
  assert.equal(verified.released, true)
  assert.equal(verified.basis, 'paypal_verified')
})

test('the public pages and components do not offer PayPal; its button lives only in the billing page of administrators and organizations', () => {
  const root = path.resolve(__dirname, '../..')
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
  for (const file of ['app/checkout/page.tsx', 'components/checkout/HostedCheckout.tsx', 'app/cart/page.tsx', 'lib/checkout-client.ts', 'lib/checkout-copy.ts', 'app/api/checkout/session/route.ts', 'app/api/checkout/quote/route.ts']) {
    assert.ok(!/paypal/i.test(read(file)), `${file} does not mention PayPal`)
  }
  const importers = (needle: RegExp) => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', '.next', '.git', 'tests', 'docs', 'public', 'prisma'].includes(entry)) continue
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx|js|mjs)$/.test(entry) && needle.test(readFileSync(full, 'utf8'))) found.push(path.relative(root, full).replace(/\\/g, '/'))
      }
    }
    for (const dir of ['app', 'components', 'lib']) walk(path.join(root, dir))
    return found.sort()
  }
  assert.deepEqual(importers(/from\s+['"][^'"]*PayPalCheckoutButton['"]/), ['components/checkout/LegacyCheckout.tsx'])
  assert.deepEqual(importers(/from\s+['"][^'"]*LegacyCheckout['"]/), ['app/checkout/billing/page.tsx'])
})
