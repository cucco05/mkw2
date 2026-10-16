// Step 4.2 – the browser side of the card checkout (lib/checkout-client.ts, the texts of lib/checkout-copy.ts). No browser, no database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { checkoutItemSchema } from '../lib/checkout-quote'
import {
  CHECKOUT_KEY_PATTERN, buildQuoteRequest, classifyFailure, forgetCheckoutKey, isStripeCheckoutUrl, isUsableQuote, newCheckoutKey,
  cartItemsSignature, quoteSignature, requestManualQuote, requestQuote, requestSession, resolveCheckoutKey, stableStringify, toQuoteItem, affectedLines,
  type CheckoutFailure, type FailureKind,
} from '../lib/checkout-client'
import { HOSTED_CHECKOUT_COPY, MANUAL_QUOTE_COPY_EN, MANUAL_QUOTE_COPY_IT, failureMessage, cartFailureMessage } from '../lib/checkout-copy'

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

test('checkout key: the same payment gets the same key, a different cart or total gets a new one', () => {
  forgetCheckoutKey(null)
  const store = memoryStore()
  let n = 0
  const make = () => `key-${String(++n).padStart(16, '0')}`
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
  damaged.data.set('mw:checkout-key:v1', '{not json')
  assert.match(resolveCheckoutKey(damaged, 'sig-Y', 100), CHECKOUT_KEY_PATTERN)
})

test('generated keys fit the server pattern and do not repeat', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newCheckoutKey()))
  assert.equal(keys.size, 200)
  for (const key of keys) assert.match(key, CHECKOUT_KEY_PATTERN)
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
    CURRENCY_NOT_CONFIGURED: 'disabled', CURRENCY_INVALID: 'disabled', CURRENCY_MISMATCH: 'disabled',
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
  const ok = await requestSession({ request, expectedTotalCents: 4700, checkoutKey: 'kKEYKEYKEYKEYKEYKEY' }, undefined, okFetch as any)
  assert.deepEqual(ok.ok ? [ok.url, ok.orderNumber] : null, ['https://checkout.stripe.com/c/pay/cs_test_1', 7])
  assert.equal(body.expectedTotalCents, 4700)
  assert.equal(body.checkoutKey, 'kKEYKEYKEYKEYKEYKEY')
  assert.deepEqual(body.items, JSON.parse(JSON.stringify(request.items)))
  assert.deepEqual(body.shipping, { method: 'ship' })
  assert.equal(/priceMultiplier/.test(JSON.stringify(body)), false)

  const evil = await requestSession({ request, expectedTotalCents: 1, checkoutKey: 'kKEYKEYKEYKEYKEYKEY' }, undefined,
    reply(200, { orderId: 'x', orderNumber: 1, url: 'https://evil.example/pay', totalCents: 1 }) as any)
  assert.deepEqual(evil.ok ? null : evil.failure.code, 'BAD_SESSION_ANSWER')
  const moved = await requestSession({ request, expectedTotalCents: 1, checkoutKey: 'kKEYKEYKEYKEYKEYKEY' }, undefined, reply(409, { code: 'PRICE_CHANGED', currentTotalCents: 4900 }) as any)
  assert.deepEqual(moved.ok ? null : [moved.failure.kind, moved.failure.currentTotalCents], ['price_changed', 4900])
  const offline = await requestSession({ request, expectedTotalCents: 1, checkoutKey: 'kKEYKEYKEYKEYKEYKEY' }, undefined, (async () => { throw new TypeError('offline') }) as any)
  assert.equal(offline.ok ? null : offline.failure.kind, 'network')
})

// ---- the sentences ---------------------------------------------------------------------------------------------------------------
test('every failure has a plain Italian sentence; none claims a payment, and amounts come from the caller\'s formatter', () => {
  const kinds: FailureKind[] = ['network', 'busy', 'items', 'option', 'minimum', 'payment_minimum', 'review', 'price_changed', 'not_payable', 'too_many_attempts', 'conflict', 'disabled', 'shipping_unavailable', 'temporary', 'invalid', 'unknown']
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
