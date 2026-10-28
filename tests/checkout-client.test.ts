// Step 4.2 – the browser side of the card checkout (lib/checkout-client.ts, the texts of lib/checkout-copy.ts). No browser, no database.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { z } from 'zod'
import { checkoutItemSchema } from '../lib/checkout-quote'
import {
  CHECKOUT_KEY_PATTERN, HANDSHAKE_PAUSE_MS, buildQuoteRequest, classifyFailure, forgetCheckoutKey, isStripeCheckoutUrl, isUsableQuote, newCheckoutKey,
  cartItemsSignature, quoteSignature, requestManualQuote, requestQuote, requestSession, resolveCheckoutKey, stableStringify, toQuoteItem, affectedLines,
  type CheckoutFailure, type FailureKind,
} from '../lib/checkout-client'
import { HOSTED_CHECKOUT_COPY, MANUAL_QUOTE_COPY_EN, MANUAL_QUOTE_COPY_IT, failureMessage, cartFailureMessage } from '../lib/checkout-copy'
import { SUPPORT_CODE_PATTERN } from '../lib/purchase-intent'

// exactly what /api/checkout/quote accepts (app/api/checkout/quote/route.ts)
const bodySchema = z.object({
  items: z.array(checkoutItemSchema).min(1).max(50),
  shipping: z.object({ method: z.enum(['pickup', 'ship']) }).strict().default({ method: 'pickup' }),
  rush: z.boolean().optional().default(false),
}).strict()

const cartItem = (over: Record<string, any> = {}, options: Record<string, any> = {}): any => ({
  cartItemId: 'c1', modelId: 'clmodelmodelmodel000001', partId: null, partName: null, title: 'Vaso', priceUsd: 10, size: { x: 80, y: 80, z: 60 },
  options: { qty: 2, scale: 1, material: 'pla', colors: ['#ffffff'], toleranceClass: 'standard', finish: null, infillPct: null, customText: null, dimensionOverrides: null, lockDimensions: true, priceMultiplier: null, productTemplateId: null, ...options },
  ...over,
})

test('the request built from a cart is accepted by the server schema, in the shapes the old page got wrong (nulls, odd values)', () => {
  const carts = [
    [cartItem()],
    [cartItem({}, { finish: null, infillPct: null, customText: null, priceMultiplier: null })],
    [cartItem({}, { priceMultiplier: 0.1, toleranceClass: 'fit_critical', finish: 'matte', infillPct: 35.6, customText: 'Ciao' })],
    [cartItem({}, { qty: 0 }), cartItem({}, { qty: 999 }), cartItem({}, { qty: 2.6 })],
    [cartItem({ size: undefined })],
    [cartItem({}, { lockDimensions: false, dimensionOverrides: { x: 2, y: 0.5 } })],
    [cartItem({}, { scale: 9 }), cartItem({}, { scale: 0 })],
    [cartItem({}, { productTemplateId: 'not-a-cuid' }), cartItem({}, { productTemplateId: 'clproductproduct0000001' })],
    [cartItem({ partId: 'clpartpartpart00000001' })],
    [cartItem({}, { colors: Array.from({ length: 30 }, (_, i) => `#00000${i % 10}`) })],
  ]
  for (const items of carts) {
    for (const method of ['pickup', 'ship'] as const) {
      const request = buildQuoteRequest(items, { shippingMethod: method, rush: method === 'ship' })
      const parsed = bodySchema.safeParse(request)
      assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues))
    }
  }
})

test('the request never carries a price: no priceMultiplier, no amounts; only what is wanted', () => {
  const request = buildQuoteRequest([cartItem({}, { priceMultiplier: 0.1 })], { shippingMethod: 'pickup', rush: false })
  const text = JSON.stringify(request)
  assert.equal(/priceMultiplier|price|total|amount|status/i.test(text), false, text)
  assert.equal('priceMultiplier' in request.items[0], false)
})

test('cart lines are cleaned: quantity 1–50 whole, scale 0.1–5, nulls dropped, a malformed product id left out', () => {
  const [low, high, fractional] = [cartItem({}, { qty: 0 }), cartItem({}, { qty: 999 }), cartItem({}, { qty: 2.6 })].map(toQuoteItem)
  assert.equal(low.qty, 1)
  assert.equal(high.qty, 50)
  assert.equal(fractional.qty, 3)
  const wild = toQuoteItem(cartItem({}, { scale: 40 }))
  assert.ok(wild.scale <= 5 && wild.scaleX <= 5)
  const plain = toQuoteItem(cartItem({}, { finish: null, infillPct: null, customText: null, productTemplateId: 'not-a-cuid' }))
  for (const key of ['finish', 'infillPct', 'customText', 'productTemplateId', 'partId', 'toleranceClass'] as const) {
    if (key === 'toleranceClass') continue
    assert.equal(key in plain, false, `${key} must be left out, not sent as null`)
  }
  assert.equal(plain.material, 'PLA')
  assert.equal('targetDimensions' in plain, false, 'no size in millimetres is sent: the server works it out from the scale (a part has its own size)')
  assert.equal(toQuoteItem(cartItem({}, { productTemplateId: 'clproductproduct0000001' })).productTemplateId, 'clproductproduct0000001')
  assert.equal(buildQuoteRequest(Array.from({ length: 70 }, () => cartItem()), { shippingMethod: 'pickup', rush: false }).items.length, 50)
})

test('the signature is the same for the same cart whatever the key order, and changes with anything that changes the price', () => {
  const base = buildQuoteRequest([cartItem()], { shippingMethod: 'pickup', rush: false })
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } }), stableStringify({ a: { c: undefined, d: [1, { x: 2, y: 1 }] }, b: 1 }))
  assert.equal(quoteSignature(base), quoteSignature(JSON.parse(JSON.stringify(base))))
  const variants = [
    buildQuoteRequest([cartItem()], { shippingMethod: 'ship', rush: false }),
    buildQuoteRequest([cartItem()], { shippingMethod: 'pickup', rush: true }),
    buildQuoteRequest([cartItem({}, { qty: 3 })], { shippingMethod: 'pickup', rush: false }),
    buildQuoteRequest([cartItem({}, { material: 'PETG' })], { shippingMethod: 'pickup', rush: false }),
    buildQuoteRequest([cartItem({}, { colors: ['#000000'] })], { shippingMethod: 'pickup', rush: false }),
    buildQuoteRequest([cartItem(), cartItem()], { shippingMethod: 'pickup', rush: false }),
  ]
  const all = new Set([quoteSignature(base), ...variants.map(quoteSignature)])
  assert.equal(all.size, variants.length + 1)
})

// ---- the repeat-key -----------------------------------------------------------------------------------------------------------
const memoryStore = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, data }
}

// R1-1a: only a STRONG key - "k" + 32 base64url characters, at least 16 of them different - is ever kept, reused or sent. The judge written here does NOT use
// lib/checkout-key-format.ts: the module is judged by the tests, not by itself.
const isStrong = (value: unknown): boolean => typeof value === 'string' && /^k[A-Za-z0-9_-]{32}$/.test(value) && new Set(value.slice(1)).size >= 16
const STRONG_KEY = 'kyRJNjAXmY6tAIfp6Cbwv11aOA5_sRhlo' // fixed and well-formed: 27 different characters
// strong keys that differ from each other and are the same on every run (the test makes sure each one is strong)
const strongKeys = () => {
  let n = 0
  return () => {
    n++
    const key = `k${Buffer.from(Uint8Array.from({ length: 24 }, (_, i) => (n * 53 + i * 37 + 11) & 255)).toString('base64url')}`
    assert.equal(isStrong(key), true, `test key ${n} must itself be strong`)
    return key
  }
}

test('checkout key: the same payment gets the same key, a different cart or total gets a new one', () => {
  forgetCheckoutKey(null)
  const store = memoryStore()
  const make = strongKeys()
  const first = resolveCheckoutKey(store, 'sig-A', 5000, make)
  assert.equal(resolveCheckoutKey(store, 'sig-A', 5000, make), first, 'double click / reload / back from the payment page')
  assert.notEqual(resolveCheckoutKey(store, 'sig-A', 5400, make), first, 'the total moved: another payment')
  const third = resolveCheckoutKey(store, 'sig-B', 5400, make)
  assert.notEqual(third, first)
  assert.equal(resolveCheckoutKey(store, 'sig-B', 5400, make), third)
  forgetCheckoutKey(store)
  assert.notEqual(resolveCheckoutKey(store, 'sig-B', 5400, make), third, 'a key the server turned down is not reused')
})

test('checkout key: a blocked or damaged storage still protects a double click, and a damaged value is not trusted', () => {
  forgetCheckoutKey(null)
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  const a = resolveCheckoutKey(broken, 'sig-X', 100)
  assert.equal(resolveCheckoutKey(broken, 'sig-X', 100), a)
  forgetCheckoutKey(null)
  const damaged = memoryStore()
  damaged.data.set('mw:checkout-key:v1', JSON.stringify({ signature: 'sig-Y', totalCents: 100, key: 'short' }))
  const k = resolveCheckoutKey(damaged, 'sig-Y', 100)
  assert.notEqual(k, 'short')
  assert.match(k, CHECKOUT_KEY_PATTERN)
  assert.equal(isStrong(k), true, 'and what replaces a damaged value is a strong key')
  damaged.data.set('mw:checkout-key:v1', '{not json')
  assert.match(resolveCheckoutKey(damaged, 'sig-Y', 100), CHECKOUT_KEY_PATTERN)
})

test('generated keys fit the server pattern, are strong, and do not repeat', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newCheckoutKey()))
  assert.equal(keys.size, 200)
  for (const key of keys) {
    assert.match(key, CHECKOUT_KEY_PATTERN)
    assert.equal(isStrong(key), true, key)
  }
})

// ---- understanding answers -----------------------------------------------------------------------------------------------------
test('every code the quote and session endpoints can send is understood', () => {
  const expected: Record<string, FailureKind> = {
    INVALID_REQUEST: 'invalid', INVALID_ORIGIN: 'invalid', UNSUPPORTED_MEDIA_TYPE: 'invalid', PAYLOAD_TOO_LARGE: 'invalid', TOTAL_INVALID: 'invalid',
    RATE_LIMITED: 'busy', ITEM_UNAVAILABLE: 'items', ITEM_NOT_PRICEABLE: 'items', OPTION_UNAVAILABLE: 'option', COLOR_REQUIRED: 'option',
    COLOR_INVALID: 'option', COLOR_NOT_ALLOWED: 'option', COLOR_UNAVAILABLE: 'option', MINIMUM_ORDER: 'minimum', PRICE_CHANGED: 'price_changed',
    ORDER_NOT_PAYABLE: 'not_payable', TOO_MANY_ATTEMPTS: 'too_many_attempts', CHECKOUT_KEY_CONFLICT: 'conflict', CHECKOUT_DISABLED: 'disabled',
    PAYMENTS_NOT_CONFIGURED: 'disabled', TAX_NOT_CONFIGURED: 'disabled', CHECKOUT_UNAVAILABLE: 'disabled', SHIPPING_NOT_CONFIGURED: 'shipping_unavailable',
    PAYMENT_PROVIDER_UNAVAILABLE: 'temporary', PAYMENT_PROVIDER_ERROR: 'temporary', TEMPORARY_ERROR: 'temporary', CHECKOUT_FAILED: 'temporary', QUOTE_FAILED: 'temporary',
    MANUAL_REVIEW_REQUIRED: 'review', BELOW_PAYMENT_MINIMUM: 'payment_minimum', MINIMUM_ORDER_NOT_CONFIGURED: 'disabled',
    CURRENCY_NOT_CONFIGURED: 'disabled', CURRENCY_INVALID: 'disabled', CURRENCY_MISMATCH: 'disabled', PAYMENT_IN_PROGRESS: 'payment_in_progress', SESSION_REQUIRED: 'session_required',
    // (R1-1b) the answer of the guard against a second order for the same purchase key - ONE code for every order and every state of it (S-01)
    PURCHASE_KEY_IN_USE: 'purchase_key_in_use', CHECKOUT_KEY_INVALID: 'invalid',
  }
  for (const [code, kind] of Object.entries(expected)) assert.equal(classifyFailure(400, { code }).kind, kind, code)
  assert.equal(classifyFailure(500, {}).kind, 'temporary', 'an unknown server error is retryable')
  assert.equal(classifyFailure(418, { code: 'SOMETHING_NEW' }).kind, 'unknown')
  assert.equal(classifyFailure(502, null).kind, 'temporary')
})

test('failures carry what the page needs: the lines, the minimum, the new total, the pause, the order', () => {
  assert.deepEqual(classifyFailure(404, { code: 'ITEM_UNAVAILABLE', details: { itemIndexes: [2, 0, -1, 'x', 1.5] } }).itemIndexes, [2, 0])
  assert.deepEqual(classifyFailure(409, { code: 'OPTION_UNAVAILABLE', details: { itemIndex: 3 } }).itemIndexes, [3])
  assert.equal(classifyFailure(400, { code: 'MINIMUM_ORDER', details: { minimumCents: 1500 } }).minimumCents, 1500)
  assert.equal(classifyFailure(400, { code: 'BELOW_PAYMENT_MINIMUM', details: { minimumCents: 50, totalCents: 1 } }).totalCents, 1)
  assert.equal(classifyFailure(400, { code: 'MINIMUM_ORDER', details: { minimumCents: 1500, itemsTotalCents: 900 } }).itemsTotalCents, 900)
  assert.equal(classifyFailure(400, { code: 'MINIMUM_ORDER', details: { minimumCents: 1500, itemsTotalCents: -5 } }).itemsTotalCents, undefined, 'a negative amount is not believed')
  assert.equal(classifyFailure(409, { code: 'PRICE_CHANGED', currentTotalCents: 4321 }).currentTotalCents, 4321)
  assert.equal(classifyFailure(429, { code: 'RATE_LIMITED', retryAfterSeconds: 30 }).retryAfterSeconds, 30)
  assert.equal(classifyFailure(429, { code: 'RATE_LIMITED' }, '45').retryAfterSeconds, 45)
  assert.equal(classifyFailure(429, { code: 'RATE_LIMITED' }, 'soon').retryAfterSeconds, undefined)
  assert.equal(classifyFailure(429, { code: 'RATE_LIMITED', retryAfterSeconds: 999999 }).retryAfterSeconds, 3600)
  assert.equal(classifyFailure(409, { code: 'ORDER_NOT_PAYABLE', orderId: 'clorder1', reason: 'paid' }).orderId, 'clorder1')
  assert.equal(classifyFailure(503, { code: 'TEMPORARY_ERROR', retry: true }).retry, true)
  assert.equal(classifyFailure(409, { code: 'PRICE_CHANGED' }).retry, false, 'a refused price is not repeated as it is')
  assert.deepEqual([...affectedLines({ ...classifyFailure(404, { code: 'ITEM_UNAVAILABLE', details: { itemIndexes: [1, 7] } }) } as CheckoutFailure, 3)], [1])
})

test('only Stripe\'s own payment page is a place the browser may be sent to', () => {
  assert.equal(isStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_abc#fid'), true)
  for (const bad of [
    'http://checkout.stripe.com/c/pay/x', 'https://checkout.stripe.com.evil.example/x', 'https://evil.example/https://checkout.stripe.com/',
    'https://user:pw@checkout.stripe.com/x', 'https://stripe.com/x', 'javascript:alert(1)', '//checkout.stripe.com/x', '/checkout/success', '', null, undefined, 42,
  ]) assert.equal(isStripeCheckoutUrl(bad), false, String(bad))
})

const goodQuote = () => ({
  currency: 'EUR',
  items: [{ title: 'Vaso', partName: null, qty: 2, material: 'PLA', colors: ['#ffffff'], finish: null, unitPriceCents: 2000, lineTotalCents: 4000, undiscountedLineTotalCents: 4000, discountPercent: 0, leadTimeHours: 4 }],
  itemsTotalCents: 4000, discountPercent: 0,
  shipping: { method: 'pickup', cents: 0, label: null },
  shippingOffer: { shipAvailable: true, shipCents: 700, shipLabel: 'Spedizione in Italia', shipCountries: ['IT'] },
  tax: { mode: 'inclusive', ratePercent: 22, cents: 721, addedToTotal: false },
  totalCents: 4000, canCheckout: true, unavailableReason: null,
})

test('a quote is used only if it is whole cents all the way', () => {
  assert.equal(isUsableQuote(goodQuote()), true)
  const bad: any[] = [null, {}, [], 'x', { ...goodQuote(), totalCents: 40.5 }, { ...goodQuote(), totalCents: '4000' }, { ...goodQuote(), items: [] }, { ...goodQuote(), shipping: null },
    { ...goodQuote(), shippingOffer: undefined }, { ...goodQuote(), canCheckout: 'yes' }, { ...goodQuote(), tax: { cents: -1 } }]
  for (const value of bad) assert.equal(isUsableQuote(value), false, JSON.stringify(value))
})

// ---- the two calls, with a fake fetch -------------------------------------------------------------------------------------------
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

test('requestQuote: sends only the cart, understands answers, and a lost connection is "network" (never a crash)', async () => {
  const request = buildQuoteRequest([cartItem()], { shippingMethod: 'pickup', rush: false })
  let sent: any = null
  const spy = async (url: any, init: any) => { sent = { url, init }; return new Response(JSON.stringify(goodQuote()), { status: 200 }) }
  const ok = await requestQuote(request, undefined, spy as any)
  assert.equal(ok.ok, true)
  assert.equal(sent.url, '/api/checkout/quote')
  assert.equal(sent.init.method, 'POST')
  assert.equal(sent.init.cache, 'no-store')
  assert.deepEqual(JSON.parse(sent.init.body), JSON.parse(JSON.stringify(request)))

  const limited = await requestQuote(request, undefined, reply(429, { code: 'RATE_LIMITED' }, { 'Retry-After': '12' }) as any)
  assert.deepEqual(limited.ok ? null : [limited.failure.kind, limited.failure.retryAfterSeconds], ['busy', 12])
  const junk = await requestQuote(request, undefined, reply(200, { totalCents: 'x' }) as any)
  assert.equal(junk.ok, false)
  const html = await requestQuote(request, undefined, reply(502, '<html>bad gateway</html>') as any)
  assert.deepEqual(html.ok ? null : html.failure.kind, 'temporary')
  const offline = await requestQuote(request, undefined, (async () => { throw new TypeError('Failed to fetch') }) as any)
  assert.deepEqual(offline.ok ? null : [offline.failure.kind, offline.failure.retry], ['network', true])
  await assert.rejects(() => requestQuote(request, undefined, (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }) as any), { name: 'AbortError' })
})

test('requestSession: sends the key and the total that was shown; follows only a Stripe page; every refusal is a failure', async () => {
  const request = buildQuoteRequest([cartItem()], { shippingMethod: 'ship', rush: false })
  let body: any = null
  const okFetch = async (_url: any, init: any) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ orderId: 'clorder1', orderNumber: 7, url: 'https://checkout.stripe.com/c/pay/cs_test_1', totalCents: 4700 }), { status: 200 })
  }
  const ok = await requestSession({ request, expectedTotalCents: 4700, checkoutKey: STRONG_KEY }, undefined, okFetch as any)
  assert.deepEqual(ok.ok ? [ok.url, ok.orderNumber] : null, ['https://checkout.stripe.com/c/pay/cs_test_1', 7])
  assert.equal(body.expectedTotalCents, 4700)
  assert.equal(body.checkoutKey, STRONG_KEY)
  assert.deepEqual(body.items, JSON.parse(JSON.stringify(request.items)))
  assert.deepEqual(body.shipping, { method: 'ship' })
  assert.equal(/priceMultiplier/.test(JSON.stringify(body)), false)

  const evil = await requestSession({ request, expectedTotalCents: 1, checkoutKey: STRONG_KEY }, undefined,
    reply(200, { orderId: 'x', orderNumber: 1, url: 'https://evil.example/pay', totalCents: 1 }) as any)
  assert.deepEqual(evil.ok ? null : evil.failure.code, 'BAD_SESSION_ANSWER')
  const moved = await requestSession({ request, expectedTotalCents: 1, checkoutKey: STRONG_KEY }, undefined, reply(409, { code: 'PRICE_CHANGED', currentTotalCents: 4900 }) as any)
  assert.deepEqual(moved.ok ? null : [moved.failure.kind, moved.failure.currentTotalCents], ['price_changed', 4900])
  const offline = await requestSession({ request, expectedTotalCents: 1, checkoutKey: STRONG_KEY }, undefined, (async () => { throw new TypeError('offline') }) as any)
  assert.equal(offline.ok ? null : offline.failure.kind, 'network')
})

// ---- the sentences ---------------------------------------------------------------------------------------------------------------
test('every failure has a plain Italian sentence; none claims a payment, and amounts come from the caller\'s formatter', () => {
  const kinds: FailureKind[] = ['network', 'busy', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'price_changed', 'not_payable', 'payment_in_progress', 'session_required', 'cookies_blocked', 'too_many_attempts', 'conflict', 'disabled', 'shipping_unavailable', 'temporary', 'invalid', 'unknown', 'crypto_unavailable', 'purchase_key_in_use']
  const money = (cents: number) => `€${(cents / 100).toFixed(2)}`
  for (const kind of kinds) {
    const text = failureMessage({ kind, code: 'X', status: 400, retry: false, minimumCents: 1500, currentTotalCents: 4321, retryAfterSeconds: 20 }, money)
    assert.ok(text.length > 20, kind)
    assert.equal(/pagamento ricevuto|hai pagato|ordine confermato|pagato con successo|registrati|crea un account/i.test(text), false, `${kind}: ${text}`)
    assert.equal(/\b(the|please|error)\b/i.test(text), false, `${kind} must be Italian: ${text}`)
  }
  assert.match(failureMessage({ kind: 'minimum', code: '', status: 400, retry: false, minimumCents: 1500 }, money), /€15\.00/)
  assert.match(failureMessage({ kind: 'price_changed', code: '', status: 409, retry: false, currentTotalCents: 4321 }, money), /€43\.21/)
  assert.match(failureMessage({ kind: 'busy', code: '', status: 429, retry: false, retryAfterSeconds: 20 }, money), /20 secondi/)
  assert.equal(HOSTED_CHECKOUT_COPY.payButton('€40,00'), 'Paga con carta · €40,00')
  assert.equal(HOSTED_CHECKOUT_COPY.leadTime(3.9), 'circa 4 ore')
  assert.equal(HOSTED_CHECKOUT_COPY.leadTime(72), 'circa 3 giorni')
})

// ---- the cart's sentences (English until the translation phase) -------------------------------------------------------------------
test('the cart explains why it has no payable price, in the cart\'s own language, never claiming a payment; amounts come from the formatter', () => {
  const kinds: FailureKind[] = ['network', 'busy', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'price_changed', 'not_payable', 'too_many_attempts', 'conflict', 'disabled', 'shipping_unavailable', 'temporary', 'invalid', 'unknown']
  const money = (cents: number) => `€${(cents / 100).toFixed(2)}`
  for (const kind of kinds) {
    const text = cartFailureMessage({ kind, code: 'X', status: 400, retry: false }, money)
    assert.ok(text.length > 20, kind)
    assert.equal(/paid|payment received|order confirmed/i.test(text), false, `${kind}: ${text}`)
  }
  const both = cartFailureMessage({ kind: 'minimum', code: '', status: 400, retry: false, minimumCents: 3000, itemsTotalCents: 2500 }, money)
  assert.match(both, /€25\.00/)
  assert.match(both, /€30\.00/)
  assert.match(cartFailureMessage({ kind: 'minimum', code: '', status: 400, retry: false, minimumCents: 3000 }, money), /€30\.00/)
})

// ---- manual review (step 4.2-ter, A4/A8) -------------------------------------------------------------------------------------------
test('a cart that needs a person is its own kind of failure, with the lines and the reasons the server gave', () => {
  const body = {
    code: 'MANUAL_REVIEW_REQUIRED',
    details: {
      itemIndexes: [2, 0],
      reviews: [
        { itemIndex: 2, reasons: [{ code: 'TOO_LARGE', sizeMm: { x: 250.4, y: 120, z: 90 }, usableMm: { x: 168, y: 168, z: 178 } }] },
        { itemIndex: 0, reasons: [{ code: 'MATERIAL_UNKNOWN', value: 'PEEK' }, { code: 'FINISH_UNKNOWN', value: 'gold' }] },
      ],
    },
  }
  const failure = classifyFailure(422, body)
  assert.equal(failure.kind, 'review')
  assert.equal(failure.retry, false)
  assert.deepEqual(failure.itemIndexes, [2, 0])
  assert.deepEqual(failure.reviews?.map((line) => line.itemIndex), [2, 0])
  assert.deepEqual(failure.reviews?.[1].reasons.map((reason) => reason.code), ['MATERIAL_UNKNOWN', 'FINISH_UNKNOWN'])
  assert.deepEqual(failure.reviews?.[0].reasons[0].usableMm, { x: 168, y: 168, z: 178 })
  // nothing odd gets through
  const odd = classifyFailure(422, { code: 'MANUAL_REVIEW_REQUIRED', details: { reviews: [{ itemIndex: -1, reasons: [{ code: 'X' }] }, { itemIndex: 1, reasons: [{ code: 5 }, null, { code: 'OK', sizeMm: { x: 'a', y: 1, z: 1 }, value: 'v'.repeat(500) }] }, 'x', null] } })
  assert.deepEqual(odd.reviews, [{ itemIndex: 1, reasons: [{ code: 'OK', value: 'v'.repeat(40) }] }])
})

test('the manual-quote text names each line\'s reasons in plain words, in both languages, with the figures of the machine', () => {
  const reasons = ['NO_ACTIVE_MACHINE', 'MATERIAL_UNKNOWN', 'MATERIAL_NOT_AVAILABLE', 'FINISH_UNKNOWN', 'FINISH_NOT_AVAILABLE', 'SIZE_UNKNOWN', 'UNIT_NOT_MM', 'SIZE_IMPLAUSIBLE', 'TOO_LARGE', 'TOO_THIN', 'SUPPORT_HEAVY', 'SOMETHING_NEW']
  for (const copy of [MANUAL_QUOTE_COPY_EN, MANUAL_QUOTE_COPY_IT]) {
    for (const code of reasons) {
      const text = copy.reason({ code, value: 'X', sizeMm: { x: 250, y: 120, z: 90 }, usableMm: { x: 168, y: 168, z: 178 } })
      assert.ok(text.length > 10, code)
      assert.equal(/paid|pagato|addebitat/i.test(text), false, `${code}: ${text}`)
    }
    assert.match(copy.reason({ code: 'TOO_LARGE', sizeMm: { x: 250, y: 120, z: 90 }, usableMm: { x: 168, y: 168, z: 178 } }), /250 × 120 × 90 mm/)
    assert.match(copy.reason({ code: 'TOO_LARGE', sizeMm: { x: 250, y: 120, z: 90 }, usableMm: { x: 168, y: 168, z: 178 } }), /168 × 168 × 178 mm/)
    assert.match(copy.sent('MW-00012', 'a@b.test'), /MW-00012/)
    assert.match(copy.sent('MW-00012', 'a@b.test'), /a@b\.test/)
  }
  assert.equal(/\b(the|please)\b/i.test(MANUAL_QUOTE_COPY_IT.intro + MANUAL_QUOTE_COPY_IT.title), false, 'the checkout text is Italian')
  assert.match(failureMessage({ kind: 'review', code: 'MANUAL_REVIEW_REQUIRED', status: 422, retry: false }, (cents) => `€${cents}`), /preventivo manuale/)
  assert.match(cartFailureMessage({ kind: 'review', code: 'MANUAL_REVIEW_REQUIRED', status: 422, retry: false }, (cents) => `€${cents}`), /manual quote/)
})

test('the manual request sends the cart and the contact, never a price, and understands the answers', async () => {
  const sent: any[] = []
  const answer = (status: number, body: unknown) => (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }) as any
  const request = { items: [{ modelId: 'm1', qty: 1, scale: 1 }], shipping: { method: 'pickup' as const }, rush: false }
  const ok = await requestManualQuote({ request: request as any, email: ' a@b.test ', name: '', note: ' hi ' }, undefined, answer(201, { ok: true, orderNumber: 12 }))
  assert.deepEqual(ok, { ok: true, orderNumber: 12 })
  assert.deepEqual(sent[0].contact, { email: 'a@b.test' })
  assert.equal(sent[0].note, 'hi')
  assert.equal(sent[0].totalCents, undefined)
  const noContact = await requestManualQuote({ request: request as any, email: '', name: '', note: '' }, undefined, answer(400, { code: 'EMAIL_REQUIRED', error: 'x' }))
  assert.equal(noContact.ok, false)
  assert.equal(sent[1].contact, undefined)
  assert.equal(sent[1].note, undefined)
  if (!noContact.ok) assert.equal(noContact.failure.code, 'EMAIL_REQUIRED')
  const down = await requestManualQuote({ request: request as any, email: 'a@b.test', name: '', note: '' }, undefined, (async () => { throw new TypeError('offline') }) as any)
  assert.equal(down.ok, false)
  if (!down.ok) assert.equal(down.failure.kind, 'network')
})

test('the two minimums have their own sentences and their own figures', () => {
  const money = (cents: number) => `€${(cents / 100).toFixed(2)}`
  const shop = failureMessage({ kind: 'minimum', code: 'MINIMUM_ORDER', status: 400, retry: false, minimumCents: 3000 }, money)
  const provider = failureMessage({ kind: 'payment_minimum', code: 'BELOW_PAYMENT_MINIMUM', status: 400, retry: false, minimumCents: 50 }, money)
  assert.match(shop, /ordine minimo/i)
  assert.match(shop, /€30\.00/)
  assert.match(provider, /pagamento minimo con carta/i)
  assert.match(provider, /€0\.50/)
  assert.match(cartFailureMessage({ kind: 'payment_minimum', code: '', status: 400, retry: false, minimumCents: 50 }, money), /smallest card payment \(€0\.50\)/)
})

// ---- step 4.6: complete models (the lines that share a key) ---------------------------------------------------------------------------------------
const setLine = (partId: string, setKey: string | null, options: Record<string, any> = {}) => cartItem({ cartItemId: `c-${partId}`, partId, setKey }, options)

test('the key that groups the lines of a complete model travels in the request, only when it has the shape the server accepts, and the server schema takes it', () => {
  const items = [setLine('clpartpartpart00000001', 'aBcDeFgH1234'), setLine('clpartpartpart00000002', 'aBcDeFgH1234'), setLine('clpartpartpart00000003', 'too short!'), cartItem()]
  const request = buildQuoteRequest(items, { shippingMethod: 'pickup', rush: false })
  assert.deepEqual(request.items.map((entry) => entry.setKey), ['aBcDeFgH1234', 'aBcDeFgH1234', undefined, undefined])
  const parsed = bodySchema.safeParse(request)
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues))
})

test('what this browser remembers as "this cart" does not depend on the random keys or on the order of the lines, but does on how the lines are grouped', () => {
  const parts = ['clpartpartpart00000001', 'clpartpartpart00000002', 'clpartpartpart00000003']
  const grouped = (key: string) => parts.map((partId) => setLine(partId, key))
  const original = cartItemsSignature(grouped('keyAAAAAAAA'))
  assert.equal(cartItemsSignature(grouped('keyZZZZZZZZ')), original, 'taken apart and put together again with a new key: the same cart')
  assert.equal(cartItemsSignature(grouped('keyAAAAAAAA').reverse()), original, 'another order of the lines: the same cart')
  assert.notEqual(cartItemsSignature(parts.map((partId) => setLine(partId, null))), original, 'single parts are not the same purchase as a complete model')
  assert.notEqual(cartItemsSignature([setLine(parts[0], 'keyAAAAAAAA'), setLine(parts[1], 'keyAAAAAAAA'), setLine(parts[2], 'keyBBBBBBBB')]), original, 'split in two groups')
  assert.notEqual(cartItemsSignature(grouped('keyAAAAAAAA').map((line) => ({ ...line, options: { ...line.options, qty: 3 } }))), original, 'another quantity')
})

// ---- the session handshake (step 4.6, S5) -----------------------------------------------------------------------------------------------
// A guest pays with a session cookie. If a request arrives without one the server makes nothing and answers 428 (handing the browser a session): the page sends
// the same request ONCE more; a second 428 means the browser keeps no cookies. Never a loop, never a second order, the cart is never touched.
const NO_PAUSE = { pauseMs: 0 }
const session428 = () => new Response(JSON.stringify({ error: 'x', code: 'SESSION_REQUIRED', retry: true }), { status: 428 })
const sessionOk = () => new Response(JSON.stringify({ orderId: 'clorder1', orderNumber: 7, url: 'https://checkout.stripe.com/c/pay/cs_test_1', totalCents: 4700 }), { status: 200 })
const sessionInput = () => ({ request: buildQuoteRequest([cartItem()], { shippingMethod: 'pickup', rush: false }), expectedTotalCents: 4700, checkoutKey: STRONG_KEY })
function scripted(...answers: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: string }> = []
  const fetcher = async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init.body) })
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    return next()
  }
  return { fetcher: fetcher as any, calls }
}

test('a 428 is understood: the server made nothing and handed out a session', () => {
  const failure = classifyFailure(428, { code: 'SESSION_REQUIRED', error: 'x', retry: true })
  assert.equal(failure.kind, 'session_required')
  assert.equal(failure.status, 428)
  assert.equal(failure.retry, false, 'the repeat is requestSession\'s own business, not a generic retry button')
})

test('requestSession: a 428 is answered by the SAME request once more (same key, same body) and the payment page follows', async () => {
  const input = sessionInput()
  const { fetcher, calls } = scripted(session428, sessionOk)
  const result = await requestSession(input, undefined, fetcher, NO_PAUSE)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, 'exactly one repeat')
  assert.equal(calls[1].body, calls[0].body, 'the very same request: the same key, the same cart, the same total')
  assert.equal(JSON.parse(calls[1].body).checkoutKey, STRONG_KEY)
  assert.ok(calls.every((c) => c.url === '/api/checkout/session'))
})

test('requestSession: a second 428 means the browser keeps no cookies - said once, no third request, no loop', async () => {
  const { fetcher, calls } = scripted(session428)
  const result = await requestSession(sessionInput(), undefined, fetcher, NO_PAUSE)
  assert.equal(result.ok, false)
  assert.equal(calls.length, 2, 'two requests and no more, whatever the server keeps answering')
  if (!result.ok) {
    assert.equal(result.failure.kind, 'cookies_blocked')
    assert.equal(result.failure.retry, false)
    assert.equal(result.failure.status, 428)
  }
})

test('requestSession: only a 428 is repeated - every other answer, including a lost connection, is returned as it is, after ONE request', async () => {
  for (const [label, answer, kind] of [
    ['payment page', sessionOk, null],
    ['price moved', () => new Response(JSON.stringify({ code: 'PRICE_CHANGED', currentTotalCents: 4900 }), { status: 409 }), 'price_changed'],
    ['payment in progress', () => new Response(JSON.stringify({ code: 'PAYMENT_IN_PROGRESS' }), { status: 409 }), 'payment_in_progress'],
    ['too many requests', () => new Response(JSON.stringify({ code: 'RATE_LIMITED', retryAfterSeconds: 30 }), { status: 429 }), 'busy'],
    ['server error', () => new Response('<html>', { status: 502 }), 'temporary'],
  ] as Array<[string, () => Response, string | null]>) {
    const { fetcher, calls } = scripted(answer)
    const result = await requestSession(sessionInput(), undefined, fetcher, NO_PAUSE)
    assert.equal(calls.length, 1, label)
    assert.equal(result.ok ? null : result.failure.kind, kind, label)
  }
  const offline = { calls: 0 }
  const lost = await requestSession(sessionInput(), undefined, (async () => { offline.calls++; throw new TypeError('offline') }) as any, NO_PAUSE)
  assert.equal(offline.calls, 1, 'a lost connection is not a missing cookie: no repeat')
  assert.equal(lost.ok ? null : lost.failure.kind, 'network')
})

test('requestSession: after the repeat the answer is whatever the server says then (a refusal included), and a cancelled request is cancelled', async () => {
  const afterPrice = scripted(session428, () => new Response(JSON.stringify({ code: 'PRICE_CHANGED', currentTotalCents: 4900 }), { status: 409 }))
  const moved = await requestSession(sessionInput(), undefined, afterPrice.fetcher, NO_PAUSE)
  assert.deepEqual(moved.ok ? null : [moved.failure.kind, moved.failure.currentTotalCents], ['price_changed', 4900])
  assert.equal(afterPrice.calls.length, 2)

  const afterLoss = scripted(session428, () => { throw new TypeError('offline') })
  const lost = await requestSession(sessionInput(), undefined, afterLoss.fetcher, NO_PAUSE)
  assert.equal(lost.ok ? null : lost.failure.kind, 'network', 'the connection dropped on the repeat: nothing was charged, trying again is safe')

  const aborted = scripted(session428, () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })
  await assert.rejects(() => requestSession(sessionInput(), undefined, aborted.fetcher, NO_PAUSE), { name: 'AbortError' })
})

test('the sentences about cookies are Italian, say the cart was not touched and nothing was charged, and never claim a payment; the order is named only when the server named it', () => {
  const money = (cents: number) => `€${(cents / 100).toFixed(2)}`
  for (const kind of ['session_required', 'cookies_blocked'] as FailureKind[]) {
    const text = failureMessage({ kind, code: 'SESSION_REQUIRED', status: 428, retry: false }, money)
    assert.match(text, /cookie/i)
    assert.match(text, /carrello/i)
    assert.match(text, /non è stato addebitato nulla/)
    assert.match(text, /accedi/i, 'and the way out: sign in')
    assert.equal(/pagamento ricevuto|hai pagato|ordine confermato|pagato con successo|registrati|crea un account/i.test(text), false, text)
    assert.equal(/\b(the|please|error)\b/i.test(text), false, text)
  }
  assert.match(HOSTED_CHECKOUT_COPY.cookiesOffNotice, /cookie/i)
  assert.match(HOSTED_CHECKOUT_COPY.cookiesOffNotice, /carrello non viene toccato/)
  assert.equal(/\b(the|please|error)\b/i.test(HOSTED_CHECKOUT_COPY.cookiesOffNotice + HOSTED_CHECKOUT_COPY.guestNote), false)
  const named = failureMessage({ kind: 'payment_in_progress', code: 'PAYMENT_IN_PROGRESS', status: 409, retry: false, orderId: 'clorder1' }, money)
  const unnamed = failureMessage({ kind: 'payment_in_progress', code: 'PAYMENT_IN_PROGRESS', status: 409, retry: false }, money)
  assert.match(named, /Controlla lo stato dell'ordine/)
  assert.equal(/Controlla lo stato dell'ordine/.test(unnamed), false, 'there is no order to send the customer to')
  assert.match(unnamed, /non serve pagare di nuovo/)
  assert.equal(/pagamento ricevuto|hai pagato|ordine confermato|pagato con successo/i.test(named + unnamed), false)
})

test('requestSession: the repeat waits a short, fixed time (both tabs of a new browser get their answer first); a cancelled request does not wait it out', async () => {
  assert.ok(HANDSHAKE_PAUSE_MS >= 100 && HANDSHAKE_PAUSE_MS <= 1000, 'short enough to be unnoticed, long enough for the other tab\'s answer to arrive')
  const stamps: number[] = []
  const timed = scripted(() => { stamps.push(Date.now()); return session428() }, () => { stamps.push(Date.now()); return sessionOk() })
  const result = await requestSession(sessionInput(), undefined, timed.fetcher, { pauseMs: 60 })
  assert.equal(result.ok, true)
  assert.ok(stamps[1] - stamps[0] >= 55, `the repeat came ${stamps[1] - stamps[0]} ms after the first request`)
  // cancelled while waiting: the repeat is never sent
  const controller = new AbortController()
  const cancelled = scripted(session428, sessionOk)
  const waiting = requestSession(sessionInput(), controller.signal, cancelled.fetcher, { pauseMs: 5000 })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(() => waiting, { name: 'AbortError' })
  assert.equal(cancelled.calls.length, 1)
})

// ====================================================================================================================================
// R1-1a - the checkout key can only come from Web Crypto; only a STRONG key is kept, reused or sent; without one nothing leaves the page.
// This is the CLIENT's half of a contract (the server's half, the guard per purchase key of R1-1b, is in tests/security/purchase-key.sec.ts). R1 is still open, and nothing below says otherwise.
// ====================================================================================================================================
const realCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
function setWebCrypto(value: unknown) { Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true, enumerable: false }) }
function restoreWebCrypto() { if (realCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', realCryptoDescriptor); else delete (globalThis as { crypto?: unknown }).crypto }
function withWebCrypto<T>(value: unknown, run: () => T): T {
  setWebCrypto(value)
  try { return run() } finally { restoreWebCrypto() }
}
// a Web Crypto whose bytes the test chooses; `calls` lists the size of every request for random bytes
function fakeCrypto(fill: (bytes: Uint8Array, call: number) => void) {
  const calls: number[] = []
  return {
    calls,
    getRandomValues(array: Uint8Array) { calls.push(array.length); fill(array, calls.length); return array },
  }
}
const FIXED_BYTES = Uint8Array.from([201, 18, 77, 140, 5, 230, 99, 171, 64, 33, 250, 122, 9, 188, 47, 215, 86, 142, 3, 159, 236, 70, 25, 104])
const FIXED_KEY = `k${Buffer.from(FIXED_BYTES).toString('base64url')}`
const KEY_ENTRY = 'mw:checkout-key:v1'
const sessionRequest = () => buildQuoteRequest([cartItem()], { shippingMethod: 'pickup', rush: false })
// a network that would take the request and hand back a Stripe page: in these tests nothing may ever reach it
const networkProbe = () => scripted(sessionOk)

test('R1-1a A: a key is "k" + the base64url of exactly 24 bytes asked once to crypto.getRandomValues (192 bits) - nothing else is mixed in', () => {
  forgetCheckoutKey(null)
  const fake = fakeCrypto((bytes) => { bytes.set(FIXED_BYTES) })
  const key = withWebCrypto(fake, () => newCheckoutKey())
  assert.deepEqual(fake.calls, [24], 'one request, for 24 bytes')
  assert.equal(key, FIXED_KEY)
  assert.equal(key.length, 33)
  assert.equal(isStrong(key), true)
  const real = Array.from({ length: 300 }, () => newCheckoutKey())
  assert.equal(new Set(real).size, 300, 'real Web Crypto: no repeats')
  for (const each of real) assert.equal(isStrong(each), true, each)
})

test('R1-1a B: there is no pseudo-random fallback - not in the code, and not when Web Crypto is missing, broken or degenerate', () => {
  for (const file of ['lib/checkout-client.ts', 'lib/checkout-key-format.ts']) {
    const code = ts.transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText
    assert.equal(/\bMath\s*(\.|\[)\s*['"]?random/.test(code), false, `${file} must not use Math.random in any form`)
  }
  const original = Math.random
  let used = 0
  Math.random = () => { used++; return 0.5 }
  try {
    const sources: unknown[] = [undefined, null, {}, { getRandomValues: 1 }, { getRandomValues() { throw new Error('boom') } }, fakeCrypto((bytes) => { bytes.fill(7) }), fakeCrypto(() => undefined)]
    for (const value of sources) {
      forgetCheckoutKey(null)
      withWebCrypto(value, () => { newCheckoutKey(); resolveCheckoutKey(memoryStore(), 'sig-B', 100) })
    }
  } finally { Math.random = original }
  assert.equal(used, 0, 'Math.random was called')
})

test('R1-1a C: without Web Crypto there is NO key - an empty string, never a valid-looking one - nothing is stored, and no request leaves the page (no repeat after a 428 either)', async () => {
  const absent: Array<[string, unknown]> = [
    ['no crypto at all', undefined], ['crypto is null', null], ['an empty crypto object', {}], ['getRandomValues is not a function', { getRandomValues: 'nope' }], ['only a subtle crypto', { subtle: {} }],
  ]
  for (const [label, value] of absent) {
    forgetCheckoutKey(null)
    const store = memoryStore()
    assert.equal(withWebCrypto(value, () => newCheckoutKey()), '', label)
    const key = withWebCrypto(value, () => resolveCheckoutKey(store, 'sig-C', 4700))
    assert.equal(key, '', label)
    assert.equal(store.data.size, 0, `${label}: nothing was stored`)
    for (const answers of [[sessionOk], [session428, sessionOk]]) {
      const probe = scripted(...answers)
      const result = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: key }, undefined, probe.fetcher, NO_PAUSE)
      assert.equal(probe.calls.length, 0, `${label}: no request, and no round of repeats`)
      assert.equal(result.ok, false, label)
      if (!result.ok) {
        assert.equal(result.failure.kind, 'crypto_unavailable', label)
        assert.equal(result.failure.code, 'CHECKOUT_KEY_UNAVAILABLE', label)
        assert.equal(result.failure.retry, false, label)
        assert.equal(result.failure.status, 0, label)
      }
    }
  }
})

test('R1-1a D: a Web Crypto that throws gives a typed failure and never an exception: nothing is stored, nothing stays locked, and the next try works', async () => {
  forgetCheckoutKey(null)
  const boom = { getRandomValues() { throw new DOMException('no entropy available', 'OperationError') } }
  assert.doesNotThrow(() => withWebCrypto(boom, () => newCheckoutKey()))
  const store = memoryStore()
  let key = 'unset'
  assert.doesNotThrow(() => { key = withWebCrypto(boom, () => resolveCheckoutKey(store, 'sig-D', 100)) })
  assert.equal(key, '')
  assert.equal(store.data.size, 0)
  const probe = networkProbe()
  const result = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: key }, undefined, probe.fetcher, NO_PAUSE)
  assert.equal(probe.calls.length, 0)
  assert.equal(result.ok ? null : result.failure.kind, 'crypto_unavailable')
  // a generator handed to resolveCheckoutKey that throws is handled too
  assert.doesNotThrow(() => resolveCheckoutKey(store, 'sig-D', 100, () => { throw new Error('generator exploded') }))
  assert.equal(resolveCheckoutKey(store, 'sig-D', 100, () => { throw new Error('generator exploded') }), '')
  assert.equal(store.data.size, 0)
  // nothing is poisoned: with Web Crypto working again the same click makes a strong key and keeps it
  const back = resolveCheckoutKey(store, 'sig-D', 100)
  assert.equal(isStrong(back), true)
  assert.equal(resolveCheckoutKey(store, 'sig-D', 100), back)
  assert.equal(JSON.parse(store.data.get(KEY_ENTRY)!).key, back)
})

test('R1-1a E: a degenerate generator never gives a strong key: it is asked again a few times (bounded), then the answer is "no key"', async () => {
  const degenerate: Array<[string, (bytes: Uint8Array) => void]> = [
    ['bytes never written (all zero)', () => undefined],
    ['fill(7)', (bytes) => { bytes.fill(7) }],
    ['all 0xFF', (bytes) => { bytes.fill(255) }],
    ['two bytes in turn', (bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = i % 2 ? 0xAA : 0x55 }],
    ['three bytes in turn', (bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = [1, 2, 3][i % 3] }],
  ]
  for (const [label, fill] of degenerate) {
    forgetCheckoutKey(null)
    const fake = fakeCrypto(fill)
    assert.equal(withWebCrypto(fake, () => newCheckoutKey()), '', label)
    assert.ok(fake.calls.length >= 2 && fake.calls.length <= 8, `${label}: asked ${fake.calls.length} times - more than once, and not for ever`)
    assert.ok(fake.calls.every((size) => size === 24), label)
    const store = memoryStore()
    assert.equal(withWebCrypto(fakeCrypto(fill), () => resolveCheckoutKey(store, 'sig-E', 100)), '', `${label}: resolveCheckoutKey`)
    assert.equal(store.data.size, 0, `${label}: nothing stored`)
  }
  // degenerate once, fine afterwards: the redraw gives a strong key
  const flaky = fakeCrypto((bytes, call) => { if (call === 1) bytes.fill(7); else bytes.set(FIXED_BYTES) })
  assert.equal(withWebCrypto(flaky, () => newCheckoutKey()), FIXED_KEY)
  assert.equal(flaky.calls.length, 2)
  // a generator handed to resolveCheckoutKey that makes weak keys: not stored, not returned, and the request is refused without a fetch
  for (const weak of [`k${'a'.repeat(32)}`, 'kKEYKEYKEYKEYKEYKEY', 'key-0000000000000001', '', `K${FIXED_KEY.slice(1)}`]) {
    forgetCheckoutKey(null)
    const store = memoryStore()
    const key = resolveCheckoutKey(store, 'sig-E2', 100, () => weak)
    assert.equal(key, '', JSON.stringify(weak))
    assert.equal(store.data.size, 0, JSON.stringify(weak))
    const probe = networkProbe()
    const result = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: weak }, undefined, probe.fetcher, NO_PAUSE)
    assert.equal(probe.calls.length, 0, JSON.stringify(weak))
    assert.equal(result.ok ? null : result.failure.kind, 'crypto_unavailable', JSON.stringify(weak))
  }
})

test('R1-1a F: a weak or old key found in the storage is NOT reused - matching the old broad pattern is no guarantee - and a strong key replaces it', () => {
  const body = FIXED_KEY.slice(1)
  const weak: unknown[] = [
    'kKEYKEYKEYKEYKEYKEY', `k${'a'.repeat(32)}`, `k${'ab'.repeat(16)}`, 'key-0000000000000001', 'abcdefghijklmnopqrstuvwxyz', `w${body}`, `K${body}`, `k${body}x`, `k${body.slice(1)}`,
    'short', '', 'k', null, 42, {}, [], true,
  ]
  for (const key of weak) {
    forgetCheckoutKey(null)
    const store = memoryStore()
    store.data.set(KEY_ENTRY, JSON.stringify({ signature: 'sig-F', totalCents: 4700, key }))
    const resolved = resolveCheckoutKey(store, 'sig-F', 4700)
    assert.notEqual(resolved, key, JSON.stringify(key))
    assert.equal(isStrong(resolved), true, JSON.stringify(key))
    assert.equal(JSON.parse(store.data.get(KEY_ENTRY)!).key, resolved, `${JSON.stringify(key)}: the strong key replaced it`)
    assert.equal(resolveCheckoutKey(store, 'sig-F', 4700), resolved, 'and it is stable from then on')
  }
  // no Web Crypto: no key, nothing is written (the weak value stays where it was, but is never used)
  forgetCheckoutKey(null)
  const stuck = memoryStore()
  const before = JSON.stringify({ signature: 'sig-F', totalCents: 4700, key: 'kKEYKEYKEYKEYKEYKEY' })
  stuck.data.set(KEY_ENTRY, before)
  assert.equal(withWebCrypto(undefined, () => resolveCheckoutKey(stuck, 'sig-F', 4700)), '')
  assert.equal(stuck.data.get(KEY_ENTRY), before, 'nothing written')
})

test('R1-1a G: a strong key already stored is reused exactly as it was - no new bytes are asked, nothing is written - for the same cart and total only', () => {
  forgetCheckoutKey(null)
  const store = memoryStore()
  const writes: string[] = []
  const spy = { getItem: (name: string) => store.getItem(name), setItem: (name: string, value: string) => { writes.push(name); store.setItem(name, value) } }
  const stored = strongKeys()() // a strong key that is not the one the fake Web Crypto below would make
  assert.notEqual(stored, FIXED_KEY)
  const entry = JSON.stringify({ signature: 'sig-G', totalCents: 4700, key: stored })
  store.data.set(KEY_ENTRY, entry)
  const fake = fakeCrypto((bytes) => { bytes.set(FIXED_BYTES) })
  assert.equal(withWebCrypto(fake, () => resolveCheckoutKey(spy, 'sig-G', 4700)), stored)
  assert.equal(fake.calls.length, 0, 'no bytes asked')
  assert.deepEqual(writes, [], 'nothing written')
  assert.equal(store.data.get(KEY_ENTRY), entry)
  // another total (or another cart) is another payment: a new strong key, and the stored one is replaced
  const other = withWebCrypto(fake, () => resolveCheckoutKey(spy, 'sig-G', 5400))
  assert.equal(other, FIXED_KEY)
  assert.notEqual(other, stored)
  // a page reload loses the memory of the module but not the storage: the same key
  forgetCheckoutKey(null)
  assert.equal(resolveCheckoutKey(spy, 'sig-G', 5400), FIXED_KEY)
})

test('R1-1a H: with the storage blocked the same payment keeps the same key in memory - as long as it was made securely - and without Web Crypto there is still no key', () => {
  forgetCheckoutKey(null)
  const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  const a = resolveCheckoutKey(blocked, 'sig-H', 100)
  assert.equal(isStrong(a), true)
  assert.equal(resolveCheckoutKey(blocked, 'sig-H', 100), a, 'a double click, a re-render of the page')
  assert.notEqual(resolveCheckoutKey(blocked, 'sig-H', 200), a, 'another total, another payment')
  forgetCheckoutKey(null)
  const bare = resolveCheckoutKey(null, 'sig-H', 100) // no storage object at all
  assert.equal(isStrong(bare), true)
  assert.equal(resolveCheckoutKey(null, 'sig-H', 100), bare)
  // blocked storage AND no Web Crypto: nothing is invented to keep going, and the empty answer is not remembered as if it were a key
  forgetCheckoutKey(null)
  assert.equal(withWebCrypto(undefined, () => resolveCheckoutKey(blocked, 'sig-H', 100)), '')
  assert.equal(withWebCrypto(undefined, () => resolveCheckoutKey(blocked, 'sig-H', 100)), '')
  const back = resolveCheckoutKey(blocked, 'sig-H', 100) // Web Crypto is back
  assert.equal(isStrong(back), true)
  assert.equal(resolveCheckoutKey(blocked, 'sig-H', 100), back)
})

test('R1-1a I: the key does not change after a lost connection, a temporary error, a refusal or an uncertain payment - the same purchase attempt keeps its key; no new place forgets a key', async () => {
  forgetCheckoutKey(null)
  const store = memoryStore()
  const key = resolveCheckoutKey(store, 'sig-I', 4700)
  const entry = store.data.get(KEY_ENTRY)
  const answers: Array<[string, () => Response | Promise<Response>]> = [
    ['lost connection', () => { throw new TypeError('offline') }],
    ['payment service down', () => new Response(JSON.stringify({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', retry: true }), { status: 503 })],
    ['bad gateway', () => new Response('<html>', { status: 502 })],
    ['too many requests', () => new Response(JSON.stringify({ code: 'RATE_LIMITED', retryAfterSeconds: 30 }), { status: 429 })],
    ['price moved', () => new Response(JSON.stringify({ code: 'PRICE_CHANGED', currentTotalCents: 4900 }), { status: 409 })],
    ['a payment is being confirmed (uncertain)', () => new Response(JSON.stringify({ code: 'PAYMENT_IN_PROGRESS', orderId: 'clorder1' }), { status: 409 })],
    ['the order can not be paid again (maybe already paid)', () => new Response(JSON.stringify({ code: 'ORDER_NOT_PAYABLE', orderId: 'clorder1', reason: 'paid' }), { status: 409 })],
    // (R1-1b) the guard of the server says this key is already tied to a purchase (it says no more, whatever that purchase is): the key stays - nothing here is a reason to start another purchase
    ['the key is already tied to a purchase (R1-1b)', () => new Response(JSON.stringify({ code: 'PURCHASE_KEY_IN_USE', supportCode: '3F9A2-C71B0', retry: false }), { status: 409 })],
  ]
  for (const [label, answer] of answers) {
    const { fetcher, calls } = scripted(answer)
    const result = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: key }, undefined, fetcher, NO_PAUSE)
    assert.equal(result.ok, false, label)
    assert.equal(calls.length, 1, `${label}: one request, no automatic repeat`)
    assert.equal(JSON.parse(calls[0].body).checkoutKey, key, label)
    assert.equal(resolveCheckoutKey(store, 'sig-I', 4700), key, `${label}: the next click uses the same key`)
    assert.equal(store.data.get(KEY_ENTRY), entry, `${label}: nothing was rewritten`)
  }
  // The key is forgotten in three places only: the pay button for "conflict" (the server says the key belongs to another cart), and the two places that run once a payment is VERIFIED.
  const callers: string[] = []
  const walk = (dir: string) => {
    for (const item of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const relative = path.join(dir, item.name)
      if (item.isDirectory()) { walk(relative); continue }
      if (/\.(ts|tsx)$/.test(item.name) && !relative.endsWith('checkout-client.ts') && /\bforgetCheckoutKey\(/.test(readFileSync(path.join(process.cwd(), relative), 'utf8'))) callers.push(relative.split(path.sep).join('/'))
    }
  }
  for (const dir of ['app', 'components', 'lib']) walk(dir)
  assert.deepEqual(callers.sort(), ['components/checkout/CheckoutStatus.tsx', 'components/checkout/HostedCheckout.tsx', 'components/checkout/PendingPaymentNotice.tsx'], 'no new place forgets a key')
  const hosted = readFileSync(path.join(process.cwd(), 'components/checkout/HostedCheckout.tsx'), 'utf8')
  assert.equal((hosted.match(/forgetCheckoutKey\(/g) ?? []).length, 1)
  assert.match(hosted, /if \(result\.failure\.kind === 'conflict'\) forgetCheckoutKey\(store\)/, 'the pay button forgets a key only for "conflict"')
})

test('R1-1a J: the cart is never touched - the key code writes only its own entry, and nothing at all when there is no key to keep', async () => {
  const data = new Map<string, string>([['mwv2:cart', '[{"cartItemId":"ci-1","modelId":"clmodelmodelmodel000001"}]'], ['mwv2:other', 'x']])
  const reads: string[] = []
  const writes: string[] = []
  const strict = new Proxy({}, {
    get(_target, property) {
      if (property === 'getItem') return (name: string) => { reads.push(name); return data.get(name) ?? null }
      if (property === 'setItem') return (name: string, value: string) => { writes.push(name); data.set(name, value) }
      throw new Error(`the key code used storage.${String(property)}`)
    },
  }) as { getItem: (name: string) => string | null; setItem: (name: string, value: string) => void }
  const cart = data.get('mwv2:cart')
  // 1. no Web Crypto
  forgetCheckoutKey(null)
  const none = withWebCrypto(undefined, () => resolveCheckoutKey(strict, 'sig-J', 4700))
  assert.equal(none, '')
  const probe = networkProbe()
  const refused = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: none }, undefined, probe.fetcher, NO_PAUSE)
  assert.equal(refused.ok, false)
  assert.deepEqual(writes, [], 'nothing is written when there is no key')
  assert.equal(data.get('mwv2:cart'), cart)
  // 2. Web Crypto works, and the server then refuses
  const key = resolveCheckoutKey(strict, 'sig-J', 4700)
  const failing = scripted(() => new Response('<html>', { status: 502 }))
  await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: key }, undefined, failing.fetcher, NO_PAUSE)
  assert.deepEqual([...new Set(writes)], [KEY_ENTRY], 'only the key entry was written')
  assert.ok(reads.every((name) => name === KEY_ENTRY), `only the key entry was read: ${reads.join(',')}`)
  assert.equal(data.get('mwv2:cart'), cart, 'the cart is byte for byte what it was')
  assert.equal(data.get('mwv2:other'), 'x')
})

test('R1-1a K: requestSession is ONE function for a guest and for a signed-in customer: a strong key goes through exactly as before - one request; after a 428 one repeat with the same body', async () => {
  const signedIn = scripted(sessionOk)
  const ok = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: FIXED_KEY }, undefined, signedIn.fetcher, NO_PAUSE)
  assert.equal(ok.ok, true)
  assert.equal(signedIn.calls.length, 1)
  assert.equal(JSON.parse(signedIn.calls[0].body).checkoutKey, FIXED_KEY)
  const guest = scripted(session428, sessionOk)
  const paid = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: FIXED_KEY }, undefined, guest.fetcher, NO_PAUSE)
  assert.equal(paid.ok, true)
  assert.equal(guest.calls.length, 2)
  assert.equal(guest.calls[1].body, guest.calls[0].body)
  // R1-1a left the server alone and said R1-1b has to change this check on purpose. It does: the route keeps the broad shape in its body schema (an account is held to
  // nothing more than before), holds a GUEST to the strong key and keeps the key bound to its order (tests/security/purchase-key.sec.ts proves what that does).
  const route = readFileSync(path.join(process.cwd(), 'app/api/checkout/session/route.ts'), 'utf8')
  assert.match(route, /checkoutKey: z\.string\(\)\.regex\(CHECKOUT_KEY_PATTERN\)/, 'the body schema keeps the broad shape')
  assert.match(route, /purchaseKeyFor\(checkoutKey\)/, 'a guest\'s key becomes its fingerprint, and a key that is not a strong key has none')
  assert.match(route, /CHECKOUT_KEY_INVALID/, 'and such a key is refused before anything is read or made')
  assert.match(route, /findGuestPurchaseOrder|bindGuestPurchaseKey/, 'and the route consults and feeds the table of bound keys')
})

test('R1-1a L: nothing is sent - so nothing can reach Stripe - when there is no strong key: not even through the global fetch, not even for a cancelled request', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error('the network must not be used in this test') }) as typeof fetch
  try {
    for (const key of ['', 'x', 'kKEYKEYKEYKEYKEYKEY', `k${'a'.repeat(32)}`, `K${FIXED_KEY.slice(1)}`, undefined, null, 42, {}]) {
      const result = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: key as string })
      assert.equal(result.ok, false, JSON.stringify(key))
      assert.equal(result.ok ? null : result.failure.kind, 'crypto_unavailable', JSON.stringify(key))
    }
    const cancelled = new AbortController()
    cancelled.abort()
    const refusal = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: '' }, cancelled.signal)
    assert.equal(refusal.ok, false, 'a cancelled request without a key is a refusal, not a crash')
    // the failure is a fresh object each time: a caller that changes one can not change the next
    const one = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: '' })
    const two = await requestSession({ request: sessionRequest(), expectedTotalCents: 4700, checkoutKey: '' })
    assert.deepEqual(one, two)
    assert.notEqual(one.ok ? null : one.failure, two.ok ? null : two.failure)
  } finally { globalThis.fetch = original }
  assert.equal(calls, 0, 'no call to the network')
})

test('R1-1a N: "this browser can not make a secure key" has its own kind and sentence - Italian, nothing sent from this page, the cart as it was, what to do - and no claim about charges or earlier payments', () => {
  const money = (cents: number) => `€${(cents / 100).toFixed(2)}`
  const text = failureMessage({ kind: 'crypto_unavailable', code: 'CHECKOUT_KEY_UNAVAILABLE', status: 0, retry: false }, money)
  assert.match(text, /browser/i)
  assert.match(text, /nessuna richiesta di pagamento/)
  assert.match(text, /carrello è rimasto/)
  assert.match(text, /aggiorna/i)
  assert.match(text, /ricarica la pagina/i)
  assert.match(text, /pagamenti avviati in precedenza/)
  assert.equal(/addebit|pagato|pagamento ricevuto|ordine confermato|nessun costo|gratuit/i.test(text), false, `no claim about charges: ${text}`)
  assert.equal(/riprova|riprovare|ritenta/i.test(text), false, 'and no invitation to repeat a payment')
  assert.equal(/\b(the|please|error)\b/i.test(text), false, text)
  assert.ok(text.length > 120 && text.length < 420, `${text.length} characters: enough to be clear, short enough for a phone`)
  assert.notEqual(text, failureMessage({ kind: 'unknown', code: '', status: 0, retry: false }, money), 'not the generic sentence')
  // only the page can produce this kind: no answer of the server is ever classified as it
  for (const code of ['CHECKOUT_KEY_UNAVAILABLE', 'CRYPTO_UNAVAILABLE', 'crypto_unavailable', '']) assert.notEqual(classifyFailure(400, { code }).kind, 'crypto_unavailable', code)
  assert.notEqual(classifyFailure(500, { code: 'CHECKOUT_KEY_UNAVAILABLE' }).kind, 'crypto_unavailable')
})

// ---- R1-1b: what the page makes of the answers of the guard against a second order for the same purchase key ---------------------------------------
const SUPPORT = '3F9A2-C71B0'
const moneyText = (cents: number) => `€${(cents / 100).toFixed(2)}`

test('R1-1b A: the refusal of the guard is understood - ONE kind for every purchase - and the support code is kept ONLY in its exact shape and ONLY with it', () => {
  assert.equal(classifyFailure(409, { code: 'PURCHASE_KEY_IN_USE', supportCode: SUPPORT, retry: false }).kind, 'purchase_key_in_use')
  assert.equal(classifyFailure(400, { code: 'CHECKOUT_KEY_INVALID' }).kind, 'invalid')
  const failure = classifyFailure(409, { code: 'PURCHASE_KEY_IN_USE', supportCode: SUPPORT })
  assert.equal(failure.supportCode, SUPPORT)
  assert.equal(failure.retry, false, 'a refusal is not repeated as it is')
  for (const bad of ['', '3f9a2-c71b0', '3F9A2C71B0', '3F9A2-C71B', '3F9A2-C71B01', ' 3F9A2-C71B0', '3F9A2-C71B0\n', '<b>3F9A2</b>', 'GGGGG-HHHHH', 42, null, {}, ['3F9A2-C71B0'], undefined]) {
    assert.equal(classifyFailure(409, { code: 'PURCHASE_KEY_IN_USE', supportCode: bad }).supportCode, undefined, JSON.stringify(bad))
  }
  // (S-01) the guard no longer tells a state: the codes of the first version of R1-1b are not answers any more, and the older refusal for a payment in doubt never carries a code
  for (const code of ['PAYMENT_IN_PROGRESS', 'PURCHASE_ALREADY_STARTED', 'PURCHASE_ALREADY_PAID', 'CHECKOUT_FAILED', 'ORDER_NOT_PAYABLE', 'CHECKOUT_KEY_CONFLICT', 'SESSION_REQUIRED', 'SOMETHING_NEW']) {
    assert.equal(classifyFailure(409, { code, supportCode: SUPPORT }).supportCode, undefined, `${code}: the code is shown only where the guard gave it`)
    assert.notEqual(classifyFailure(409, { code }).kind, 'purchase_key_in_use', code)
  }
  // no answer of the server is the kind that only the page can produce
  for (const code of ['PURCHASE_KEY_IN_USE', 'CHECKOUT_KEY_INVALID', 'PAYMENT_IN_PROGRESS']) assert.notEqual(classifyFailure(409, { code }).kind, 'crypto_unavailable', code)
  assert.equal(SUPPORT_CODE_PATTERN.source, /^[0-9A-F]{5}-[0-9A-F]{5}$/.source, 'the shape the server writes is the shape the page accepts')
})

test('R1-1b B: the sentence is Italian and plain - it says this request started nothing and the cart is as it was, gives the way out and the support code, tells NOTHING about the purchase (S-01), claims no charge and promises no unlocking', () => {
  const kind: FailureKind = 'purchase_key_in_use'
  const withCode = failureMessage({ kind, code: 'PURCHASE_KEY_IN_USE', status: 409, retry: false, supportCode: SUPPORT }, moneyText)
  const without = failureMessage({ kind, code: 'PURCHASE_KEY_IN_USE', status: 409, retry: false }, moneyText)
  for (const text of [withCode, without]) {
    assert.match(text, /non ha avviato nessun nuovo pagamento/, 'what THIS request did')
    assert.match(text, /carrello è rimasto/, 'the cart')
    assert.equal(/addebit|gratuit|nessun costo|nessuna spesa|nulla è stato (pagato|speso)/i.test(text), false, `no claim about charges - an earlier payment may exist: ${text}`)
    assert.equal(/subito|automaticament|si sblocc|verrà sbloccat|entro \d/i.test(text), false, `no promise that it unlocks by itself: ${text}`)
    // S-01: nothing that tells what happened to the purchase the key is tied to - paid, being confirmed, started, cancelled, expired, failed, refunded, finished
    assert.equal(/pagat|andato a buon fine|ricevut|in conferma|in verifica|conclus|terminat|annullat|scadut|fallit|rimbors|non serve pagare di nuovo|già pagato|in corso|in attesa/i.test(text), false, `nothing about the state of the purchase: ${text}`)
    assert.equal(/\b(the|please|error|order|code)\b/i.test(text), false, `must be Italian: ${text}`)
    assert.ok(text.length > 150 && text.length < 480, `${text.length} characters`)
    assert.equal(/[0-9a-f]{24}|cl[a-z0-9]{20,}|MW-\d/i.test(text), false, 'no identifier')
  }
  assert.ok(withCode.includes(SUPPORT), 'the support code is in the sentence')
  assert.match(withCode, /scrivici/, 'and who to write to')
  assert.equal(/codice/.test(without), false, 'without a code the sentence does not ask for one')
  assert.equal(/pagamento ricevuto|hai pagato|ordine confermato|pagato con successo/i.test(withCode + without), false, 'the existing rule: no sentence of the failures claims a payment in these words')
  // the older refusal for a payment in doubt is exactly what it was: it never shows a support code (the guard does not say it any more), whatever the answer carries
  const inDoubt = failureMessage({ kind: 'payment_in_progress', code: 'PAYMENT_IN_PROGRESS', status: 409, retry: false, supportCode: SUPPORT }, moneyText)
  const plain = failureMessage({ kind: 'payment_in_progress', code: 'PAYMENT_IN_PROGRESS', status: 409, retry: false }, moneyText)
  assert.equal(inDoubt, plain)
  assert.equal(/codice/.test(plain), false)
  assert.match(plain, /non serve pagare di nuovo/)
  // the answer of a key the server did not accept does not use the sentence reserved for the page
  assert.notEqual(failureMessage({ kind: 'invalid', code: 'CHECKOUT_KEY_INVALID', status: 400, retry: false }, moneyText), failureMessage({ kind: 'crypto_unavailable', code: 'CHECKOUT_KEY_UNAVAILABLE', status: 0, retry: false }, moneyText))
})

test('R1-1b C: the pay button treats the new refusals like any other: the message, the button given back, the key kept, the cart kept - the components are the ones of R1-1a', () => {
  const hosted = readFileSync(path.join(process.cwd(), 'components/checkout/HostedCheckout.tsx'), 'utf8')
  assert.equal(/purchase_key_in_use|purchase_started_elsewhere|purchase_already_paid/.test(hosted), false, 'the page does not know the new kind: it takes the way of every other refusal')
  assert.match(hosted, /if \(result\.failure\.kind === 'conflict'\) forgetCheckoutKey\(store\)/, 'only "conflict" forgets the key')
  // the kinds that ask for a new quote, and the kinds that keep the button off, are exactly the ones they were
  assert.match(hosted, /\['price_changed', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'invalid', 'shipping_unavailable', 'conflict'\]\.includes\(result\.failure\.kind\)\) refresh\(\)/)
  assert.match(hosted, /failure\?\.kind\.match\(\/\^\(items\|option\|minimum\|payment_minimum\|invalid\|review\)\$\/\)/)
  const refusedKinds: FailureKind[] = ['purchase_key_in_use', 'payment_in_progress']
  for (const kind of refusedKinds) {
    assert.equal(/^(items|option|minimum|payment_minimum|invalid|review)$/.test(kind), false, `${kind} keeps the button`)
    assert.equal(['price_changed', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'invalid', 'shipping_unavailable', 'conflict'].includes(kind), false, `${kind} does not ask for a new quote`)
  }
})
