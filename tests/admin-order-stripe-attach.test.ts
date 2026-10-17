// Step 4.6, S4 - linking a Stripe PaymentIntent to an order by hand. The checks are pure (lib/stripe-attach.ts); the route's refusals that happen before it touches
// anything are tested here without a database. The route against a real database (Stripe asked, the link, the audit event, concurrency) is in
// tests/security/production-release.sec.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

import { viewerGuards } from '../lib/viewer'
import { evaluateAttach, type AttachIntent, type AttachOrder } from '../lib/stripe-attach'

const ORDER: AttachOrder = {
  id: 'order_123', status: 'awaiting_payment', paymentStatus: 'pending', paymentReviewReason: null, totalCents: 4500, currency: 'EUR',
  stripePaymentIntentId: null, paidAt: null, paymentAttempts: [],
}
const INTENT: AttachIntent = { id: 'pi_good123', status: 'succeeded', amount: 4500, amount_received: 4500, currency: 'eur', metadata: { orderId: 'order_123' } }
const NOT_USED = { orderIds: [], attemptIds: [] }
const evaluate = (over: { intent?: AttachIntent | null; order?: Partial<AttachOrder>; used?: { orderIds: string[]; attemptIds: string[] } } = {}) => evaluateAttach({
  requestedId: 'pi_good123',
  intent: over.intent === undefined ? INTENT : over.intent,
  order: { ...ORDER, ...(over.order ?? {}) },
  usedElsewhere: over.used ?? NOT_USED,
})
const checks = (result: ReturnType<typeof evaluate>) => result.problems.map((problem) => problem.check)

test('attach: a collected payment that names this order, with the right amount and currency, can be linked', () => {
  const result = evaluate()
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
})

test('attach: the payment must name THIS order - nothing else stands in for it', () => {
  // no orderId, another order's id: refused
  for (const metadata of [{}, { orderId: 'order_999' }, { orderId: '' }, { orderid: 'order_123' }, { order_id: 'order_123' }, { makerworksOrderId: 'order_123' }] as Array<Record<string, string>>) {
    const result = evaluate({ intent: { ...INTENT, metadata } })
    assert.equal(result.ok, false, JSON.stringify(metadata))
    assert.ok(checks(result).includes('order_association'), JSON.stringify(metadata))
  }
  assert.equal(evaluate({ intent: { ...INTENT, metadata: null } }).ok, false)
  // the same customer, e-mail, user, date, a matching amount: none of them is accepted - not alone, not together, however well they match
  const lookalike = { ...INTENT, metadata: { customerEmail: 'buyer@example.com', email: 'buyer@example.com', userId: 'user_1', customer: 'cus_1', description: 'Ordine MW-00001', receipt_email: 'buyer@example.com', createdAt: '2026-10-17' } }
  const result = evaluate({ intent: lookalike as AttachIntent, order: { totalCents: 4500 } })
  assert.equal(result.ok, false)
  assert.deepEqual(checks(result), ['order_association'], 'the only thing wrong is the missing proof of the association - and that is enough')
})

test('attach: an attempt named by the payment must be one of this order\'s', () => {
  const withAttempt = { ...INTENT, metadata: { orderId: 'order_123', attemptId: 'att_1' } }
  assert.equal(evaluate({ intent: withAttempt }).ok, false, 'the order has no attempts, so it can not be that one')
  // an order with attempts is a hosted-checkout order and is refused for that reason anyway; the association check itself still looks at the attempt
  const result = evaluate({ intent: withAttempt, order: { paymentAttempts: [{ id: 'att_other', status: 'expired' }] } })
  assert.ok(checks(result).includes('order_association'))
})

test('attach: what Stripe says must be exactly right', () => {
  assert.ok(checks(evaluate({ intent: null })).includes('identity'))
  assert.ok(checks(evaluate({ intent: { ...INTENT, id: 'pi_other' } })).includes('identity'), 'Stripe returned another payment')
  for (const status of ['requires_payment_method', 'processing', 'requires_capture', 'canceled', 'requires_action']) {
    assert.ok(checks(evaluate({ intent: { ...INTENT, status } })).includes('collected'), status)
  }
  assert.ok(checks(evaluate({ intent: { ...INTENT, amount: 4499 } })).includes('amount'))
  assert.ok(checks(evaluate({ intent: { ...INTENT, amount_received: 4499 } })).includes('amount'))
  assert.ok(checks(evaluate({ intent: { ...INTENT, amount_received: 9000, amount: 9000 } })).includes('amount'), 'more than the total is not accepted either')
  assert.ok(checks(evaluate({ intent: { ...INTENT, amount_received: null } })).includes('amount'))
  assert.ok(checks(evaluate({ intent: { ...INTENT, amount_received: undefined } })).includes('amount'))
  assert.ok(checks(evaluate({ intent: { ...INTENT, currency: 'usd' } })).includes('currency'))
  assert.equal(evaluate({ intent: { ...INTENT, currency: 'EUR' } }).ok, true, 'the currency compares without regard to case')
})

test('attach: a payment already used elsewhere, and orders in a state that can not take a payment, are refused', () => {
  assert.ok(checks(evaluate({ used: { orderIds: ['order_9'], attemptIds: [] } })).includes('not_reused'))
  assert.ok(checks(evaluate({ used: { orderIds: [], attemptIds: ['att_9'] } })).includes('not_reused'))
  for (const order of [
    { status: 'cancelled' },
    { paymentReviewReason: 'amount' },
    { paymentStatus: 'paid' },
    { paymentStatus: 'processing' },
    { paymentStatus: 'free' },
    { paidAt: new Date() },
    { stripePaymentIntentId: 'pi_another' },
    { paymentAttempts: [{ id: 'att_1', status: 'expired' }] },
  ] as Array<Partial<AttachOrder>>) {
    const result = evaluate({ order })
    assert.equal(result.ok, false, JSON.stringify(order))
    assert.ok(checks(result).includes('order_state'), JSON.stringify(order))
  }
  // linking the same payment again to the same unpaid order is not a state problem
  assert.equal(evaluate({ order: { stripePaymentIntentId: 'pi_good123' } }).ok, true)
})

test('attach: every problem is reported, so the screen can show all of them', () => {
  const result = evaluate({ intent: { ...INTENT, status: 'processing', amount: 1, amount_received: 0, currency: 'usd', metadata: {} }, used: { orderIds: ['o'], attemptIds: [] }, order: { status: 'cancelled' } })
  assert.deepEqual([...new Set(checks(result))].sort(), ['amount', 'collected', 'currency', 'not_reused', 'order_association', 'order_state'])
  assert.ok(result.problems.every((problem) => problem.message.length > 10))
})

// ---- the route: refusals that happen before anything is read or written ----------------------------------------------------------------------
function request(body: unknown, headers: Record<string, string> = { Origin: 'http://localhost' }) {
  return new NextRequest('http://localhost/api/admin/orders/order_123/stripe-attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
const context = { params: Promise.resolve({ orderId: 'order_123' }) } as any

async function asViewer(viewer: { id: string; role: 'admin' | 'staff' | 'customer' } | null, run: () => Promise<void>) {
  const original = viewerGuards.getViewer
  viewerGuards.getViewer = async () => viewer
  try { await run() } finally { viewerGuards.getViewer = original }
}

test('admin stripe attach route: only an administrator, only from this site, only with a valid id and a written reason', async () => {
  const { POST } = await import('../app/api/admin/orders/[orderId]/stripe-attach/route')
  const good = { paymentIntentId: 'pi_good123', reason: 'the buyer paid by card from the link we sent' }
  await asViewer(null, async () => assert.equal((await POST(request(good), context)).status, 401))
  await asViewer({ id: 'u1', role: 'customer' }, async () => assert.equal((await POST(request(good), context)).status, 403))
  await asViewer({ id: 's1', role: 'staff' }, async () => {
    const res = await POST(request(good), context)
    assert.equal(res.status, 403, 'staff can no longer link a payment')
    assert.equal((await res.json()).code, 'ADMIN_ONLY')
  })
  await asViewer({ id: 'a1', role: 'admin' }, async () => {
    for (const headers of [{ Origin: 'https://evil.example' }, {}] as Array<Record<string, string>>) {
      const res = await POST(request(good, headers), context)
      assert.equal(res.status, 403, JSON.stringify(headers))
      assert.equal((await res.json()).code, 'INVALID_ORIGIN')
    }
    const badId = await POST(request({ ...good, paymentIntentId: 'bad_123' }), context)
    assert.equal(badId.status, 400)
    assert.equal((await badId.json()).error, 'A valid Stripe PaymentIntent ID is required.')
    for (const reason of [undefined, '', '   ', 'too short']) {
      const res = await POST(request({ paymentIntentId: 'pi_good123', ...(reason === undefined ? {} : { reason }) }), context)
      assert.equal(res.status, 400, JSON.stringify(reason))
    }
  })
})
