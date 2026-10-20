// Shared set-up of the S6 tests that need the HOSTED checkout (quote -> payment page -> Stripe webhook -> payment sync) with the fake Stripe of
// ./_fake-checkout.ts: the same helpers as tests/security/s2s3-step3.sec.ts, in one module so that the S6 files do not each carry a copy.
// Nothing here reaches a real Stripe account, PrintLab, StockWorks or printer. Import ./_harness FIRST in the test file (it sets the environment).
import { db, resetDb, seedShopModel } from './_harness'
import { guestHeaders } from './_guest'
import { installFakeCheckout, type FakeSession } from './_fake-checkout'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { effectHooks } from '../../lib/order-effects'

export type Fake = Awaited<ReturnType<typeof installFakeCheckout>>
export const flow = {
  fake: null as unknown as Fake,
  stripe: null as any,
  modelId: '',
  customerId: '',
  calls: { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 },
}

// ---- environment ---------------------------------------------------------------------------------------------------------------
const ENV_KEYS = ['CURRENCY', 'NEXT_PUBLIC_CURRENCY', 'TAX_MODE', 'TAX_RATE_PERCENT', 'SHIPPING_FLAT_RATE_CENTS', 'NODE_ENV', 'BASE_URL',
  'HOSTED_CHECKOUT_ENABLED', 'LEGACY_CARD_CHECKOUT_ENABLED', 'CHECKOUT_SESSION_RATE_MAX', 'CHECKOUT_QUOTE_RATE_MAX', 'CHECKOUT_GLOBAL_RATE_MAX',
  'PAYMENT_SYNC_MAX_WAIT_MS'] as const
type EnvValues = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>
const snapshotEnv = (): EnvValues => Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
function applyEnv(values: EnvValues) {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete (process.env as any)[key]
    else (process.env as any)[key] = values[key]
  }
}
const ORIGINAL_ENV = snapshotEnv()
const BASELINE_ENV: EnvValues = {
  ...ORIGINAL_ENV, CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR', SHIPPING_FLAT_RATE_CENTS: '700', TAX_MODE: undefined, TAX_RATE_PERCENT: undefined,
  HOSTED_CHECKOUT_ENABLED: undefined, LEGACY_CARD_CHECKOUT_ENABLED: undefined, PAYMENT_SYNC_MAX_WAIT_MS: '3000',
  CHECKOUT_SESSION_RATE_MAX: '1000000', CHECKOUT_QUOTE_RATE_MAX: '1000000', CHECKOUT_GLOBAL_RATE_MAX: '1000000',
}

// ---- spies on the outside services the after-payment effects use ------------------------------------------------------------------
const originalHooks = { ...effectHooks }
function installSpies() {
  effectHooks.printLabConfigured = (() => true) as any
  effectHooks.submitToPrintLab = (async () => { flow.calls.printlab++; return { ok: true, submitted: [], errors: [] } }) as any
  effectHooks.notifyDiscord = (async () => { flow.calls.discord++; return true }) as any
  effectHooks.notifyPush = (async () => { flow.calls.push++; return true }) as any
  effectHooks.consumeInventory = (async () => { flow.calls.inventory++; return { ok: true, movements: 0 } }) as any
  effectHooks.receipt = (async (id: string) => { flow.calls.receipt++; return originalHooks.receipt(id) }) as any
}

// ---- set-up / reset -------------------------------------------------------------------------------------------------------------
// Call once (test.before). Creates a shop model, a customer and the fake Stripe checkout. `reset: false` when the caller has already prepared the database
// (tests/security/_release-fixtures.ts `setup()` does, and creates the administrator the test acts as).
export async function initFlow(opts: { reset?: boolean } = {}) {
  if (opts.reset !== false) await resetDb()
  const prisma = await db()
  await prisma.siteConfig.deleteMany({ where: { id: 'main' } })
  await prisma.siteConfig.create({ data: { id: 'main', machineUsdPerHour: 2.5, laborUsdPerHour: 4, minimumPriceUsd: 5, targetMarginPercent: 20 } as any })
  const customer = await prisma.user.create({ data: { email: `s6flow${Date.now()}@sectest.invalid`, passwordHash: 'x', name: 's6flow', role: 'customer' } })
  flow.customerId = customer.id
  flow.modelId = (await seedShopModel()).model.id
  flow.fake = await installFakeCheckout()
  flow.stripe = flow.fake.stripe
  await freshFlow()
}
export function endFlow() {
  Object.assign(effectHooks, originalHooks)
  applyEnv(ORIGINAL_ENV)
}

// Call at the start of every test: empties the order tables and the fake Stripe.
export async function freshFlow() {
  const prisma = await db()
  await deleteRefundOperations()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.stripeEvent.deleteMany()
  await prisma.rateLimit.deleteMany()
  const fake = flow.fake
  fake.sessions.clear(); fake.byKey.clear(); fake.intents.clear()
  Object.assign(fake.state, {
    createCalls: 0, createdSessions: 0, expireCalls: 0, retrieveCalls: 0, unreachableBeforeCreate: 0, lostAnswerAfterCreate: 0, rejectCreate: false,
    delayMs: 0, amountTotalOverride: null, currencyOverride: null, retrieveFails: false, reads: [], failNextReads: 0, afterSnapshot: null, maxIdleInTransaction: 0,
    lastParams: null, allParams: [],
  })
  Object.assign(flow.calls, { printlab: 0, discord: 0, push: 0, inventory: 0, receipt: 0 })
  Object.assign(effectHooks, originalHooks)
  installSpies()
  applyEnv(BASELINE_ENV)
}

// The RefundOperation table exists only after the S6 migration M3a: on the code of step S5 it does not, and there is nothing to delete.
export async function deleteRefundOperations() {
  const prisma: any = await db()
  if (prisma.refundOperation?.deleteMany) await prisma.refundOperation.deleteMany()
}

// ---- calling the checkout endpoints ------------------------------------------------------------------------------------------------
let ipSeq = 0
let keySeq = 0
const nextIp = () => `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
const newKey = () => `s6flow-key-${String(++keySeq).padStart(6, '0')}-abcdefghij`
export async function post(route: 'quote' | 'session', body: unknown, o: { viewer?: Viewer; headers?: Record<string, string> } = {}) {
  viewerGuards.getViewer = async () => o.viewer ?? null
  const mod = route === 'quote' ? await import('../../app/api/checkout/quote/route') : await import('../../app/api/checkout/session/route')
  const request = new NextRequest(`http://localhost/api/checkout/${route}`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...guestHeaders(o.headers) },
    body: JSON.stringify(body),
  })
  const res = (await (mod.POST as any)(request, {})) as Response
  const text = await res.clone().text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { res, json, text }
}
export const cart = (over: Record<string, unknown> = {}) => ({
  items: [{ modelId: flow.modelId, qty: 2, colors: ['#ffffff'], material: 'PLA' }], shipping: { method: 'pickup' as 'pickup' | 'ship' }, rush: false, ...over,
})

// Quote, then "Pay": returns the order, its attempt and the Stripe session, exactly as the customer's browser would leave them.
export async function startCheckout(o: { viewer?: Viewer; cartOver?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  const c = cart(o.cartOver)
  const quote = await post('quote', c, o)
  assert.equal(quote.res.status, 200, quote.text)
  const key = newKey()
  const r = await post('session', { checkoutKey: key, expectedTotalCents: quote.json.totalCents, ...c }, o)
  assert.equal(r.res.status, 200, r.text)
  const prisma = await db()
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { orderId: r.json.orderId }, orderBy: { createdAt: 'desc' } })
  return { ...r, key, cart: c, orderId: r.json.orderId as string, total: quote.json.totalCents as number, attemptId: attempt.id, sessionId: attempt.stripeSessionId as string }
}

// A second payment page for an order that already has one (what a lost reservation or a twin tab leaves behind), ready to be paid with fake.pay().
export async function addTwinSession(orderId: string, total: number, sessionId: string) {
  const prisma = await db()
  const attempt = await prisma.paymentAttempt.create({
    data: { orderId, amountCents: total, currency: 'EUR', status: 'open', stripeSessionId: sessionId, expiresAt: new Date(Date.now() + 600_000) },
  })
  flow.fake.sessions.set(sessionId, {
    id: sessionId, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: total, currency: 'eur',
    client_reference_id: orderId, metadata: { orderId, attemptId: attempt.id }, payment_intent: null,
  })
  return attempt
}

// ---- webhook delivery ---------------------------------------------------------------------------------------------------------------
let eventSeq = 0
const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_s6_${++eventSeq}_${Math.random().toString(36).slice(2, 8)}`, object: 'event', type, livemode: false, data: { object } })
export const sessionEvent = (type: string, sessionId: string) => {
  const s: FakeSession | undefined = flow.fake.sessions.get(sessionId)
  return evt(type, { id: sessionId, object: 'checkout.session', metadata: s?.metadata ?? {}, payment_intent: s?.payment_intent ?? null })
}
export const piEvent = (type: string, piId: string) => evt(type, { id: piId, object: 'payment_intent', metadata: flow.fake.intents.get(piId)?.metadata ?? {} })
export const chargeEvent = (type: string, piId: string) => evt(type, { id: 'ch_x', object: 'charge', payment_intent: piId })

export async function deliver(event: Record<string, unknown>) {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const payload = JSON.stringify(event)
  const header = flow.stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string })
  const res = (await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload,
  }), {})) as Response
  const text = await res.text()
  let json: any = {}
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

export const orderOf = async (id: string) => (await db()).printOrder.findUniqueOrThrow({ where: { id }, include: { paymentAttempts: { orderBy: { createdAt: 'asc' } } } })

// The release decision for an order, from the facts read the way the application reads them under its lock.
export async function decisionOf(orderId: string) {
  const { readReleaseFacts } = await import('../../lib/production-release')
  const { releaseDecision } = await import('../../lib/order-payment-policy')
  const prisma = await db()
  const facts = await readReleaseFacts(prisma, orderId)
  if (!facts) throw new Error(`order ${orderId} not found`)
  return releaseDecision(facts as any)
}

// An order of the OLD flow (no payment page, tied to a PaymentIntent), worth 10.00.
export async function legacyOrder(piId: string, over: Record<string, unknown> = {}) {
  return (await db()).printOrder.create({
    data: {
      status: 'awaiting_payment', paymentStatus: 'pending', paymentMethod: 'card', subtotalCents: 1000, totalCents: 1000, currency: 'EUR',
      stripePaymentIntentId: piId, metadata: { paymentIntentId: piId }, ...over,
    } as any,
  })
}
export const legacyIntent = (id: string, status: string, over: Record<string, unknown> = {}) => {
  const pi = {
    id, object: 'payment_intent', status, amount: 1000, amount_received: status === 'succeeded' ? 1000 : 0, currency: 'eur', metadata: {}, customer: null,
    latest_charge: { id: 'ch_legacy', receipt_url: 'https://pay.stripe.test/r', amount_refunded: 0, disputed: false }, ...over,
  }
  flow.fake.intents.set(id, pi)
  return pi
}
