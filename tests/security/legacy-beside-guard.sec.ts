// R1-3 / KLOSS hardening C - the OLD card checkout (POST /api/checkout with a PaymentIntent confirmed by the browser) beside the owner guard of the hosted checkout.
//
// The old path makes a PaymentIntent and records the order AFTER the payment, with no cart fingerprint, no owner lock and none of the arbiters of P2/P3: with it switched on, the controls of the
// hosted checkout could be stepped around. Outside production it is on by default; in production only with LEGACY_CARD_CHECKOUT_ENABLED=true (which the environment check already calls out).
//   * CHECKOUT_OWNER_GUARD=off  - the old checkout as it always was;
//   * CHECKOUT_OWNER_GUARD=shadow - the old checkout EXACTLY as with the guard off (the same answers, the same calls to Stripe, the same rows): the combination is only counted and logged - the
//     shadow of P2 changes nothing;
//   * CHECKOUT_OWNER_GUARD=on   - no card payment of the old checkout: no new PaymentIntent (503, Stripe is not asked), and no finalization of one either. The finalization is refused too because
//     the old path does not show where a PaymentIntent comes from: it accepts ANY PaymentIntent that is paid with the right amount and currency and is not on a recorded order - one of the hosted
//     checkout not recorded yet, or one of another browser's checkout, included (its own metadata are not looked at). Until that is proved, a payment of the old checkout is not finalized beside
//     the guard (fail-closed; the same as production with the old checkout switched off);
//   * in production a guard flag whose value is not off / shadow / on (a typo) stops card checkout altogether - the hosted one (503 CHECKOUT_MISCONFIGURED) and the old one - and the
//     administrator's environment check calls it out (blocking); the old checkout beside the guard is blocking while the guard is on, a warning while it is in shadow; outside production
//     such a value is "off", as before;
//   * a payment of the old checkout that is refused beside the guard is never lost from sight: when its webhook arrives the event is stored with no order and the read-only diagnostic
//     (lib/unmatched-payments.ts, scripts/unmatched-payments-check.ts) reports it; when its webhook never arrives the diagnostic finds nothing - and says that this proves nothing about
//     Stripe (the payments are checked at Stripe, separately: docs/RILASCIO-PRODUZIONE.md).
// NOT closed here, and NOT declared closed: with the guard OFF the old path is what it always was - it finalizes any PaymentIntent paid with the right amount and currency that no recorded
// order carries (one of another account, one of the hosted checkout not recorded yet, one made for another cart of the same total), and two finalizations of one payment at the same
// moment make one order but two announcements to the administrator. Those are the limits of the old path, written down in docs/RILASCIO-PRODUZIONE.md; the cure is to switch it off.
// Fake Stripe (no network), throw-away database, fake data.
import { cartBody, db, installFakeStripe, postJson, resetDb, seedShopModel, stripeCalls } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { viewerGuards, type Viewer } from '../../lib/viewer'
import { getCheckoutBlocker } from '../../lib/checkout-guards'
import { buildEnvChecks } from '../../app/api/admin/env-check/route'
import { getInMemoryMetricsSnapshot } from '../../lib/observability-metrics'
import { describeUnmatchedPayments, diagnoseUnmatchedPayments } from '../../lib/unmatched-payments'
import { spawnSync } from 'node:child_process'
import { NextRequest } from 'next/server'
import { withCheckoutFlags } from './_checkout-flags'

let modelId = ''
let customer: Viewer
let admin: Viewer
const intents = new Map<string, any>()
let seq = 0
let stripe: any

const counted = (name: string, labels: Record<string, string> = {}) => getInMemoryMetricsSnapshot().counters
  .filter((counter) => counter.name === name && Object.entries(labels).every(([key, value]) => String((counter.labels as Record<string, unknown> | undefined)?.[key]) === value))
  .reduce((sum, counter) => sum + counter.value, 0)

async function legacy(body: Record<string, unknown>, viewer: Viewer = null) {
  const { POST } = await import('../../app/api/checkout/route')
  viewerGuards.getViewer = async () => viewer
  const res = await postJson(POST as any, 'http://localhost/api/checkout', cartBody(modelId, body)) as Response
  return { status: res.status, json: await res.clone().json().catch(() => ({})) as any }
}
// the customer pays the PaymentIntent on the page of the old checkout
function pay(id: string) {
  const intent = intents.get(id)
  assert.ok(intent, `premise: the PaymentIntent ${id} was made`)
  Object.assign(intent, { status: 'succeeded', amount_received: intent.amount })
}
const orders = async () => (await db()).printOrder.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, paymentMethod: true, paymentStatus: true, stripePaymentIntentId: true, totalCents: true } })
const shape = (answer: { status: number; json: any }) => ({ status: answer.status, code: answer.json?.code ?? null, keys: Object.keys(answer.json ?? {}).sort().join(',') })

// the whole old card flow: a PaymentIntent, the payment, the finalization
async function oldCardFlow(viewer: Viewer = null) {
  const calls = stripeCalls.length
  const created = await legacy({ paymentMethod: 'card' }, viewer)
  const createCalls = stripeCalls.slice(calls)
  let committed: { status: number; json: any } | null = null
  let commitCalls: string[] = []
  if (created.status === 200 && created.json.paymentIntentId) {
    pay(created.json.paymentIntentId)
    const before = stripeCalls.length
    committed = await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: created.json.paymentIntentId }, viewer)
    commitCalls = stripeCalls.slice(before)
  }
  return { created, committed, createCalls, commitCalls, orders: await orders() }
}

test.before(async () => {
  await resetDb()
  const prisma = await db()
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { email: 'legacy-customer@sectest.invalid', passwordHash: 'x', name: 'legacy customer', role: 'customer' } }),
    prisma.user.create({ data: { email: 'legacy-admin@sectest.invalid', passwordHash: 'x', name: 'legacy admin', role: 'admin', isAdmin: true } }),
  ])
  customer = { id: a.id, role: 'customer' }
  admin = { id: b.id, role: 'admin' }
  modelId = (await seedShopModel()).model.id
  stripe = await installFakeStripe({
    'shippingRates.retrieve': async (id: string) => ({ id, active: true, display_name: 'Courier', fixed_amount: { amount: 700, currency: 'usd' } }),
    'paymentIntents.create': async (params: any) => {
      const intent = { id: `pi_legacy_FAKE_${++seq}`, object: 'payment_intent', client_secret: `secret_FAKE_${seq}`, status: 'requires_payment_method', amount: params.amount, amount_received: 0, currency: params.currency, metadata: { ...params.metadata }, customer: null, latest_charge: null }
      intents.set(intent.id, intent)
      return { ...intent }
    },
    'paymentIntents.retrieve': async (id: string) => {
      const intent = intents.get(id)
      if (!intent) throw Object.assign(new Error('No such payment_intent'), { type: 'StripeInvalidRequestError', code: 'resource_missing' })
      return { ...intent }
    },
  })
})
test.beforeEach(async () => {
  const prisma = await db()
  await prisma.paymentAttempt.deleteMany()
  await prisma.printOrder.deleteMany()
  await prisma.stripeEvent.deleteMany()
  // (an account's Stripe customer is made once and then remembered: forgotten between scenarios, so that two runs of the same flow ask Stripe the same things)
  await prisma.user.updateMany({ data: { stripeCustomerId: null } })
  intents.clear()
})

test('[HC-off] owner guard off: the old card checkout works as it always did - a PaymentIntent is made, and the paid one is recorded as an order', async () => {
  await withCheckoutFlags({ owner: 'off' }, async () => {
    const flow = await oldCardFlow()
    assert.equal(flow.created.status, 200, JSON.stringify(flow.created.json))
    assert.ok(flow.created.json.clientSecret, 'the browser is given the PaymentIntent to confirm')
    assert.deepEqual(flow.createCalls, ['paymentIntents.create'])
    assert.equal(flow.committed?.status, 200, JSON.stringify(flow.committed?.json))
    assert.equal(flow.committed?.json.committed, true)
    assert.deepEqual(flow.orders.map((order) => ({ method: order.paymentMethod, status: order.paymentStatus, intent: order.stripePaymentIntentId })), [{ method: 'card', status: 'paid', intent: flow.created.json.paymentIntentId }])
  })
})

test('[HC-on-create] owner guard on: the old checkout makes no new card payment - 503 LEGACY_CARD_CHECKOUT_DISABLED, Stripe is not asked anything, nothing is made (a guest and an account alike)', async () => {
  await withCheckoutFlags({ owner: 'on' }, async () => {
    for (const viewer of [null, customer]) {
      const calls = stripeCalls.length
      const refused = await legacy({ paymentMethod: 'card' }, viewer)
      assert.deepEqual(shape(refused), { status: 503, code: 'LEGACY_CARD_CHECKOUT_DISABLED', keys: 'code,error' }, JSON.stringify(refused.json))
      assert.deepEqual(stripeCalls.slice(calls), [], 'no PaymentIntent, no customer: Stripe is not asked')
      assert.equal(intents.size, 0)
      assert.equal((await orders()).length, 0)
    }
  })
})

test('[HC-on-commit] owner guard on: a PaymentIntent of the old checkout is not finalized beside the guard either - the old path does not show where a PaymentIntent comes from (fail-closed): 503, Stripe is not asked, no order', async () => {
  // the PaymentIntent was made, and paid, while the guard was off
  const made = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  pay(made.json.paymentIntentId)
  await withCheckoutFlags({ owner: 'on' }, async () => {
    const calls = stripeCalls.length
    const refused = await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: made.json.paymentIntentId })
    assert.deepEqual(shape(refused), { status: 503, code: 'LEGACY_CARD_CHECKOUT_DISABLED', keys: 'code,error' }, JSON.stringify(refused.json))
    assert.deepEqual(stripeCalls.slice(calls), [], 'not even read: nothing of it is finalized here')
    assert.equal((await orders()).length, 0)
  })
})

test('[HC-shadow] owner guard shadow: the old checkout answers EXACTLY as with the guard off - the same answers, the same calls to Stripe, the same order - and the combination is only counted', async () => {
  const off = await withCheckoutFlags({ owner: 'off' }, () => oldCardFlow(customer))
  await (await db()).printOrder.deleteMany()
  await (await db()).user.updateMany({ data: { stripeCustomerId: null } })
  intents.clear()
  const createdBefore = counted('legacy_checkout_beside_guard_total', { mode: 'shadow', stage: 'create' })
  const commitBefore = counted('legacy_checkout_beside_guard_total', { mode: 'shadow', stage: 'commit' })
  const shadow = await withCheckoutFlags({ owner: 'shadow' }, () => oldCardFlow(customer))
  assert.deepEqual([shape(shadow.created), shadow.committed && shape(shadow.committed)], [shape(off.created), off.committed && shape(off.committed)], 'the same answers')
  assert.deepEqual([shadow.createCalls, shadow.commitCalls], [off.createCalls, off.commitCalls], 'the same calls to Stripe')
  assert.deepEqual(shadow.orders.map((order) => [order.paymentMethod, order.paymentStatus, order.totalCents]), off.orders.map((order) => [order.paymentMethod, order.paymentStatus, order.totalCents]), 'the same order')
  assert.equal(shadow.orders.length, 1)
  assert.equal(counted('legacy_checkout_beside_guard_total', { mode: 'shadow', stage: 'create' }), createdBefore + 1, 'the PaymentIntent made beside the guard in shadow is counted')
  assert.equal(counted('legacy_checkout_beside_guard_total', { mode: 'shadow', stage: 'commit' }), commitBefore + 1, 'and so is its finalization')
})

test('[HC-other-doors] owner guard on: what the old checkout does without a card is untouched - a quote request, an administrator\'s no-charge order', async () => {
  await withCheckoutFlags({ owner: 'on' }, async () => {
    const quote = await legacy({ paymentMethod: 'quote', commit: true }, customer)
    assert.equal(quote.status, 200, JSON.stringify(quote.json))
    const comped = await legacy({ paymentMethod: 'comped', commit: true }, admin)
    assert.equal(comped.status, 200, JSON.stringify(comped.json))
    assert.deepEqual((await orders()).map((order) => order.paymentMethod).sort(), ['comped', 'quote'])
  })
})

// a production configuration that sells (the fixture of tests/payment-limits.test.ts)
const PROD = { NODE_ENV: 'production', HOSTED_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', TAX_MODE: 'none', BASE_URL: 'https://shop.example.test', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR' }
const TYPOS = ['onn', 'true', '1', 'enabled', 'o n', 'false']

test('[HC-misconfigured] production: a checkout guard flag whose value is not off / shadow / on stops card checkout - the hosted one (503 CHECKOUT_MISCONFIGURED) and the old one; recognised values do not; outside production such a value is "off", as before', async () => {
  assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: PROD }), null, 'premise: the configuration sells')
  for (const name of ['CHECKOUT_OWNER_GUARD', 'CHECKOUT_REPEAT_GUARD']) {
    for (const value of TYPOS) {
      const blocker = getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, [name]: value } })
      assert.deepEqual({ code: blocker?.code, status: blocker?.status }, { code: 'CHECKOUT_MISCONFIGURED', status: 503 }, `${name}=${JSON.stringify(value)}`)
      assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, NODE_ENV: 'test', [name]: value } }), null, `outside production ${name}=${JSON.stringify(value)} is off`)
    }
    for (const value of ['on', 'shadow', 'off', 'ON', ' Shadow ', '']) {
      assert.equal(getCheckoutBlocker({ shippingMethod: 'pickup', env: { ...PROD, [name]: value } }), null, `${name}=${JSON.stringify(value)} is recognised`)
    }
  }
  // the old checkout switched on in production on purpose, beside a flag nobody can read: refused too
  const env = process.env as Record<string, string | undefined>
  const saved = { NODE_ENV: env.NODE_ENV, LEGACY: env.LEGACY_CARD_CHECKOUT_ENABLED }
  try {
    await withCheckoutFlags({}, async () => {
      env.NODE_ENV = 'production'
      env.LEGACY_CARD_CHECKOUT_ENABLED = 'true'
      env.CHECKOUT_OWNER_GUARD = 'onn'
      const calls = stripeCalls.length
      const refused = await legacy({ paymentMethod: 'card' })
      assert.deepEqual(shape(refused), { status: 503, code: 'LEGACY_CARD_CHECKOUT_DISABLED', keys: 'code,error' }, JSON.stringify(refused.json))
      assert.deepEqual(stripeCalls.slice(calls), [])
    })
  } finally {
    if (saved.NODE_ENV === undefined) delete env.NODE_ENV; else env.NODE_ENV = saved.NODE_ENV
    if (saved.LEGACY === undefined) delete env.LEGACY_CARD_CHECKOUT_ENABLED; else env.LEGACY_CARD_CHECKOUT_ENABLED = saved.LEGACY
  }
})

test('[HC-env-check] the administrator\'s environment check (production): a guard flag nobody can read is a BLOCKING check; the old card checkout beside the owner guard is BLOCKING while the guard is on and only a WARNING while it is in shadow (the shadow stays an observation)', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'a-valid-test-jwt-secret-with-32-chars' }
  const find = (env: Record<string, string>, key: string) => buildEnvChecks(env).find((check) => check.key === key)
  for (const value of TYPOS) {
    const flags = find({ ...base, CHECKOUT_OWNER_GUARD: value }, 'CHECKOUT_GUARD_FLAGS')
    assert.ok(flags, 'the check exists')
    assert.deepEqual({ required: flags!.required, ok: flags!.ok }, { required: true, ok: false }, JSON.stringify(value))
  }
  assert.equal(find({ ...base, CHECKOUT_OWNER_GUARD: 'on', CHECKOUT_REPEAT_GUARD: 'shadow' }, 'CHECKOUT_GUARD_FLAGS')?.ok, true)
  for (const mode of ['on', 'shadow']) {
    const beside = find({ ...base, CHECKOUT_OWNER_GUARD: mode, LEGACY_CARD_CHECKOUT_ENABLED: 'true' }, 'LEGACY_CARD_BESIDE_OWNER_GUARD')
    assert.ok(beside, 'the check exists')
    assert.deepEqual({ required: beside!.required, ok: beside!.ok }, { required: mode === 'on', ok: false }, `${mode}: ${mode === 'on' ? 'blocking' : 'a warning'}`)
    assert.ok(beside!.detail, 'it says what to do')
  }
  // what each combination adds to the BLOCKING failures of the same production configuration with the old checkout off: the shadow adds nothing of its own (what blocks is the old
  // checkout switched on in production at all - the check that already existed); the guard switched on adds its own blocking check
  const blocking = (env: Record<string, string>) => new Set(buildEnvChecks(env).filter((check) => check.required && !check.ok).map((check) => check.key))
  const added = (env: Record<string, string>, baseline: Record<string, string>) => { const before = blocking(baseline); return [...blocking(env)].filter((key) => !before.has(key)).sort() }
  assert.deepEqual(added({ ...base, CHECKOUT_OWNER_GUARD: 'shadow', LEGACY_CARD_CHECKOUT_ENABLED: 'true' }, { ...base, CHECKOUT_OWNER_GUARD: 'shadow' }), ['LEGACY_CARD_CHECKOUT_ENABLED'])
  assert.deepEqual(added({ ...base, CHECKOUT_OWNER_GUARD: 'on', LEGACY_CARD_CHECKOUT_ENABLED: 'true' }, { ...base, CHECKOUT_OWNER_GUARD: 'on' }), ['LEGACY_CARD_BESIDE_OWNER_GUARD', 'LEGACY_CARD_CHECKOUT_ENABLED'])
  assert.deepEqual(added({ ...base, CHECKOUT_OWNER_GUARD: 'shadow' }, base), [], 'the shadow by itself blocks nothing')
  assert.equal(find({ ...base, CHECKOUT_OWNER_GUARD: 'on' }, 'LEGACY_CARD_BESIDE_OWNER_GUARD')?.ok, true, 'the old checkout switched off: nothing beside the guard')
  assert.equal(find({ ...base, LEGACY_CARD_CHECKOUT_ENABLED: 'true' }, 'LEGACY_CARD_BESIDE_OWNER_GUARD')?.ok, true, 'the guard off: the existing check (LEGACY_CARD_CHECKOUT_ENABLED) says what there is to say')
})

// ---- the old card path beside the guard switched on: the cases where a payment could be given to the wrong purchase ---------------------------------------------------------------------
const SHIP = { method: 'ship', address: { name: 'Test Buyer', line1: 'Via di Prova 1', city: 'Milano', postalCode: '20100', country: 'IT' } }

test('[HC-on-create-ship] owner guard on: the refusal comes before ANY call to Stripe - not even the shipping rate of a cart to be shipped is read', async () => {
  const saved = process.env.STRIPE_SHIPPING_RATE_ID
  process.env.STRIPE_SHIPPING_RATE_ID = 'shr_FAKE_courier'
  try {
    // (premise: with the guard off the same cart reads the rate from Stripe before its PaymentIntent is made)
    const calls = stripeCalls.length
    const allowed = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card', shipping: SHIP }, customer))
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json))
    assert.deepEqual(stripeCalls.slice(calls).filter((name) => name !== 'customers.create'), ['shippingRates.retrieve', 'paymentIntents.create'])
    await withCheckoutFlags({ owner: 'on' }, async () => {
      const before = stripeCalls.length
      for (const commit of [false, true]) {
        const refused = await legacy({ paymentMethod: 'card', shipping: SHIP, commit, ...(commit ? { paymentIntentId: allowed.json.paymentIntentId } : {}) }, customer)
        assert.deepEqual(shape(refused), { status: 503, code: 'LEGACY_CARD_CHECKOUT_DISABLED', keys: 'code,error' }, JSON.stringify(refused.json))
      }
      assert.deepEqual(stripeCalls.slice(before), [], 'nothing asked of Stripe')
      assert.equal((await orders()).length, 0)
    })
  } finally {
    if (saved === undefined) delete process.env.STRIPE_SHIPPING_RATE_ID; else process.env.STRIPE_SHIPPING_RATE_ID = saved
  }
})

test('[HC-on-commit-other-account] owner guard on: a paid PaymentIntent made for ANOTHER account is never finalized - 503, nothing read, no order', async () => {
  const prisma = await db()
  const other = await prisma.user.upsert({ where: { email: 'legacy-other@sectest.invalid' }, update: {}, create: { email: 'legacy-other@sectest.invalid', passwordHash: 'x', name: 'other', role: 'customer' } })
  const made = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }, { id: other.id, role: 'customer' }))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.equal(intents.get(made.json.paymentIntentId)?.metadata?.makerworksUserId, other.id, 'premise: the PaymentIntent was made for the other account')
  pay(made.json.paymentIntentId)
  await withCheckoutFlags({ owner: 'on' }, async () => {
    const calls = stripeCalls.length
    const refused = await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: made.json.paymentIntentId }, customer)
    assert.deepEqual(shape(refused), { status: 503, code: 'LEGACY_CARD_CHECKOUT_DISABLED', keys: 'code,error' }, JSON.stringify(refused.json))
    assert.deepEqual(stripeCalls.slice(calls), [])
    assert.equal((await orders()).length, 0)
  })
})

test('[HC-on-commit-other-cart] owner guard on: the same amount and currency for ANOTHER cart is not a proof either - the paid PaymentIntent of one cart never finalizes another', async () => {
  const red = { items: [{ modelId, qty: 1, colors: ['#ff0000'], material: 'PLA' }] }
  const made = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }))
  const otherCart = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card', ...red }))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  assert.equal(otherCart.status, 200, JSON.stringify(otherCart.json))
  assert.deepEqual([otherCart.json.amount, otherCart.json.currency], [made.json.amount, made.json.currency], 'premise: the two carts cost the same, in the same currency')
  pay(made.json.paymentIntentId)
  await withCheckoutFlags({ owner: 'on' }, async () => {
    const calls = stripeCalls.length
    const refused = await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: made.json.paymentIntentId, ...red })
    assert.deepEqual(shape(refused), { status: 503, code: 'LEGACY_CARD_CHECKOUT_DISABLED', keys: 'code,error' }, JSON.stringify(refused.json))
    assert.deepEqual(stripeCalls.slice(calls), [])
    assert.equal((await orders()).length, 0)
  })
})

test('[HC-matrix] the three modes of the owner guard, for the same old card purchase (a PaymentIntent, its payment, its finalization): off and shadow alike - on, nothing', async () => {
  const rows: Record<string, unknown> = {}
  for (const mode of ['off', 'shadow', 'on'] as const) {
    const prisma = await db()
    await prisma.printOrder.deleteMany()
    await prisma.user.updateMany({ data: { stripeCustomerId: null } })
    intents.clear()
    const blocked = { create: counted('legacy_checkout_blocked_total', { reason: 'owner_guard', stage: 'create' }), commit: counted('legacy_checkout_blocked_total', { reason: 'owner_guard', stage: 'commit' }) }
    const beside = counted('legacy_checkout_beside_guard_total', { mode: 'shadow' })
    const flow = await withCheckoutFlags({ owner: mode }, async () => {
      if (mode !== 'on') return oldCardFlow(customer)
      // on: the PaymentIntent of the flow is made (and paid) beside the guard switched off, the finalization is asked with the guard on
      const made = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }, customer))
      pay(made.json.paymentIntentId)
      const calls = stripeCalls.length
      const created = await legacy({ paymentMethod: 'card' }, customer)
      const committed = await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: made.json.paymentIntentId }, customer)
      return { created, committed, createCalls: stripeCalls.slice(calls), commitCalls: [], orders: await orders() }
    })
    rows[mode] = {
      create: flow.created.status,
      commit: flow.committed?.status ?? null,
      orders: flow.orders.length,
      stripe: [...flow.createCalls, ...flow.commitCalls].filter((name) => name !== 'customers.create'),
      blocked: [counted('legacy_checkout_blocked_total', { reason: 'owner_guard', stage: 'create' }) - blocked.create, counted('legacy_checkout_blocked_total', { reason: 'owner_guard', stage: 'commit' }) - blocked.commit],
      beside: counted('legacy_checkout_beside_guard_total', { mode: 'shadow' }) - beside,
    }
  }
  // (the finalization reads the PaymentIntent twice: the route, then the payment sync right after the order is recorded - lib/orders.ts recordCustomerOrder)
  const OLD_WAY = ['paymentIntents.create', 'paymentIntents.retrieve', 'paymentIntents.retrieve']
  assert.deepEqual(rows, {
    off: { create: 200, commit: 200, orders: 1, stripe: OLD_WAY, blocked: [0, 0], beside: 0 },
    shadow: { create: 200, commit: 200, orders: 1, stripe: OLD_WAY, blocked: [0, 0], beside: 2 },
    on: { create: 503, commit: 503, orders: 0, stripe: [], blocked: [1, 1], beside: 0 },
  })
})

// ---- a payment refused beside the guard stays in sight -------------------------------------------------------------------------------------------------------------------------------------
let eventSeq = 0
async function deliverWebhook(type: string, object: Record<string, unknown>) {
  const { POST } = await import('../../app/api/stripe/webhook/route')
  const payload = JSON.stringify({ id: `evt_legacy_FAKE_${++eventSeq}`, object: 'event', type, data: { object } })
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string })
  const res = await (POST as any)(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload }), {}) as Response
  assert.equal(res.status, 200, await res.clone().text())
  return JSON.parse(payload).id as string
}
// a PaymentIntent of the old checkout, paid, whose finalization the guard refused
async function refusedPaidIntent() {
  const made = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  pay(made.json.paymentIntentId)
  const refused = await withCheckoutFlags({ owner: 'on' }, () => legacy({ paymentMethod: 'card', commit: true, paymentIntentId: made.json.paymentIntentId }))
  assert.equal(refused.status, 503)
  assert.equal((await orders()).length, 0, 'premise: no order')
  return made.json.paymentIntentId as string
}
async function everyRow() {
  const prisma = await db()
  return JSON.stringify([
    await prisma.printOrder.findMany({ orderBy: { id: 'asc' } }),
    await prisma.paymentAttempt.findMany({ orderBy: { id: 'asc' } }),
    await prisma.stripeEvent.findMany({ orderBy: { id: 'asc' } }),
  ])
}
function checkCommand(args: string[] = [], env: Record<string, string | undefined> = process.env) {
  const run = spawnSync('npx', ['tsx', 'scripts/unmatched-payments-check.ts', ...args], { cwd: process.cwd(), env: env as NodeJS.ProcessEnv, encoding: 'utf8' })
  return { code: run.status, out: run.stdout, err: run.stderr }
}

test('[HC-orphan-webhook] a paid PaymentIntent refused beside the guard, whose webhook arrived: stored with no order, and reported by the diagnostic - as the old checkout\'s, recent at first and an orphan later; the command ends 1; nothing is changed', async () => {
  const intentId = await refusedPaidIntent()
  await deliverWebhook('payment_intent.succeeded', { ...intents.get(intentId) })
  const stored = await (await db()).stripeEvent.findMany()
  assert.deepEqual(stored.map((event) => [event.type, event.paymentIntentId, event.orderId]), [['payment_intent.succeeded', intentId, null]], 'the event is kept, with no order')
  const before = await everyRow()
  const now = await diagnoseUnmatchedPayments()
  assert.deepEqual(now.candidates.map((candidate) => ({ key: candidate.key, origin: candidate.origin, state: candidate.state })), [{ key: intentId, origin: 'legacy_checkout', state: 'recent' }])
  assert.equal(now.verdict, 'candidates_to_reconcile')
  const later = await diagnoseUnmatchedPayments({ now: new Date(Date.now() + 2 * 3_600_000) })
  assert.deepEqual(later.candidates.map((candidate) => candidate.state), ['orphan'])
  const run = checkCommand()
  assert.equal(run.code, 1, run.err)
  assert.deepEqual(JSON.parse(run.out).candidates.map((candidate: any) => candidate.key), [intentId])
  assert.equal(await everyRow(), before, 'the diagnostic and the command wrote nothing')
})

test('[HC-orphan-no-webhook] the same payment whose webhook NEVER arrived: the database knows nothing of it - the diagnostic finds no candidate and says that this proves nothing about Stripe (a check at Stripe is needed); it never says the payments are reconciled', async () => {
  await refusedPaidIntent()
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual({ verdict: report.verdict, candidates: report.candidates.length, stored: report.coverage.moneyEventsStored, scope: report.scope }, { verdict: 'no_candidate_in_database', candidates: 0, stored: 0, scope: 'database_only' })
  const words = describeUnmatchedPayments(report)
  assert.match(words, /does NOT show that every Stripe payment is reconciled/)
  assert.match(words, /not a statement about Stripe/)
  assert.match(words, /No payment event was ever stored/)
  assert.match(words, /checked at Stripe, separately and with authorization/)
  assert.doesNotMatch(words.replace(/does NOT show that every Stripe payment is reconciled/g, ''), /\b(all|every)\b[^.]*\breconciled\b/i, 'nothing claims that the payments are reconciled')
  const run = checkCommand()
  assert.equal(run.code, 0, run.err)
  assert.equal(JSON.parse(run.out).verdict, 'no_candidate_in_database')
  assert.match(run.err, /does NOT show that every Stripe payment is reconciled/)
})

test('[HC-orphan-grouping] one payment is reported once whatever number of events it has; a payment an order claims and shows paid is reconciled (counted, not reported); one an order claims but does not show paid is still to reconcile', async () => {
  const prisma = await db()
  // (1) one PaymentIntent, two events (the PaymentIntent, then a Checkout session nobody knows that carried it)
  const intentId = await refusedPaidIntent()
  await deliverWebhook('payment_intent.succeeded', { ...intents.get(intentId) })
  await deliverWebhook('checkout.session.completed', { id: 'cs_unknown_FAKE_1', object: 'checkout.session', payment_intent: intentId, metadata: {} })
  // (2) a payment of the old flow whose event came first and whose order was recorded after it (the guard off): reconciled
  const late = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }))
  pay(late.json.paymentIntentId)
  await deliverWebhook('payment_intent.succeeded', { ...intents.get(late.json.paymentIntentId) })
  const recorded = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card', commit: true, paymentIntentId: late.json.paymentIntentId }))
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json))
  // (3) an event whose PaymentIntent an order claims, while the order does not show it paid (it waits for the money)
  const waiting = await prisma.printOrder.create({ data: { status: 'awaiting_payment', paymentStatus: 'processing', paymentMethod: 'card', subtotalCents: 1000, totalCents: 1000, currency: 'USD', stripePaymentIntentId: 'pi_waiting_FAKE_1' } })
  await prisma.stripeEvent.create({ data: { id: 'evt_waiting_FAKE_1', type: 'payment_intent.succeeded', paymentIntentId: 'pi_waiting_FAKE_1', orderId: null, payload: { data: { object: { id: 'pi_waiting_FAKE_1', object: 'payment_intent', metadata: { orderId: waiting.id } } } } } })
  const report = await diagnoseUnmatchedPayments()
  assert.deepEqual(report.candidates.map((candidate) => ({ key: candidate.key, types: candidate.eventTypes, events: candidate.eventIds.length, state: candidate.state, origin: candidate.origin, claimed: candidate.claimedByOrders })), [
    { key: intentId, types: ['checkout.session.completed', 'payment_intent.succeeded'], events: 2, state: 'recent', origin: 'legacy_checkout', claimed: [] },
    { key: 'pi_waiting_FAKE_1', types: ['payment_intent.succeeded'], events: 1, state: 'claimed_not_paid', origin: 'hosted_checkout', claimed: [waiting.id] },
  ])
  assert.deepEqual({ withoutOrder: report.eventsWithoutOrder, reconciled: report.reconciled }, { withoutOrder: 4, reconciled: 1 })
})

test('[HC-orphan-command] the command: wrong use is refused with 64 and nothing on stdout; a database it can not read ends 2 - the diagnostic failed, nothing can be concluded', () => {
  for (const args of [['--recent'], ['--recent-minutes'], ['--recent-minutes', 'x'], ['--recent-minutes', '5', '--recent-minutes', '6']]) {
    const run = checkCommand(args)
    assert.equal(run.code, 64, `${args.join(' ')}: ${run.err}`)
    assert.equal(run.out, '')
  }
  const unreachable = checkCommand([], { ...process.env, DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/does_not_exist_sectest' })
  assert.equal(unreachable.code, 2, unreachable.err)
  assert.equal(unreachable.out, '')
  assert.match(unreachable.err, /The diagnostic failed - nothing can be concluded from it/)
})

test('[HC-refusal-log] a refusal is logged with its reason, its stage and the kind of requester; the PaymentIntent the browser sent is logged only when it has the shape of one; nothing personal, no secret', async () => {
  const made = await withCheckoutFlags({ owner: 'off' }, () => legacy({ paymentMethod: 'card' }, customer))
  assert.equal(made.status, 200, JSON.stringify(made.json))
  const logged: Array<Record<string, unknown>> = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    if (args[0] === '[WARN] checkout.legacy_card' && args[1] && typeof args[1] === 'object') logged.push(args[1] as Record<string, unknown>)
    else original(...args)
  }
  try {
    await withCheckoutFlags({ owner: 'on' }, async () => {
      await legacy({ paymentMethod: 'card' })
      await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: made.json.paymentIntentId }, customer)
      await legacy({ paymentMethod: 'card', commit: true, paymentIntentId: 'pi_<script>alert(1)</script>' }, customer)
      await legacy({ paymentMethod: 'card', commit: true })
    })
  } finally {
    console.log = original
  }
  const fields = logged.map(({ ts: _ts, ...rest }) => rest)
  assert.deepEqual(fields, [
    { outcome: 'refused', reason: 'owner_guard', stage: 'create', requester: 'guest' },
    { outcome: 'refused', reason: 'owner_guard', stage: 'commit', requester: 'account', paymentIntentId: made.json.paymentIntentId },
    { outcome: 'refused', reason: 'owner_guard', stage: 'commit', requester: 'account', paymentIntentId: 'malformed' },
    { outcome: 'refused', reason: 'owner_guard', stage: 'commit', requester: 'guest', paymentIntentId: 'absent' },
  ])
  const text = JSON.stringify(logged)
  for (const leak of ['legacy-customer@sectest.invalid', 'legacy customer', customer!.id, 'secret_FAKE', '<script>']) assert.equal(text.includes(leak), false, `nothing of "${leak}" in the log`)
})
