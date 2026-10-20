// Step 4.6, S6a (P6) - documents and texts must not say "paid" when nothing is proven (F15, F23, F24). Pure checks: no database, no network.
// Written BEFORE the fixes (red on the code of step S5, b464d04), green after.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildOrderReceiptModel } from '../lib/receipts/order-receipt-model'
import { buildReceiptPdfLines } from '../lib/receipts/pdf-renderer'
import { classifyReceiptDocument } from '../lib/receipts/types'
import { adminPaymentNotificationTitle } from '../lib/order-payment-policy'

const ROOT = process.cwd()
const code = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ---- F23: a receipt document says "paid" only for an order that is paid -------------------------------------------------------------------------
test('M47 a document named a payment receipt exists only for a payment that is verified; every other situation gets a neutral, honest title', () => {
  for (const method of ['card', 'paypal', 'cash']) {
    for (const paymentStatus of ['pending', 'processing', 'failed', 'canceled', 'requires_capture', 'authorized', null]) {
      const result = classifyReceiptDocument({ paymentMethod: method, paymentStatus, totalCents: 2500 })
      assert.equal(result.kind, 'order_confirmation', `${method}/${paymentStatus}`)
      assert.match(result.title, /payment pending/i, `${method}/${paymentStatus}`)
    }
  }
  assert.equal(classifyReceiptDocument({ paymentMethod: 'card', paymentStatus: 'paid', totalCents: 2500 }).kind, 'payment_receipt')
  assert.equal(classifyReceiptDocument({ paymentMethod: 'paypal', paymentStatus: 'paid', totalCents: 2500 }).kind, 'payment_receipt')
  assert.equal(classifyReceiptDocument({ paymentMethod: 'cash', paymentStatus: 'paid', totalCents: 2500 }).kind, 'cash_receipt')
  // the documents that do not claim a payment stay what they are
  assert.equal(classifyReceiptDocument({ paymentMethod: 'invoice', paymentStatus: 'pending', totalCents: 2500 }).kind, 'invoice_acknowledgement')
  assert.equal(classifyReceiptDocument({ paymentMethod: 'po', paymentStatus: 'pending', totalCents: 2500 }).kind, 'purchase_order_acknowledgement')
  assert.equal(classifyReceiptDocument({ paymentMethod: 'quote', paymentStatus: 'quote', totalCents: 2500 }).kind, 'quote_request')
  assert.equal(classifyReceiptDocument({ paymentMethod: 'comped', paymentStatus: 'free', totalCents: 2500 }).kind, 'complimentary_receipt')
  assert.equal(classifyReceiptDocument({ paymentMethod: 'cash', paymentStatus: 'pending', totalCents: 0 }).kind, 'complimentary_receipt')
})

function orderRow(over: Record<string, unknown>) {
  return {
    id: 'order_1', orderNumber: 7, customerName: 'Jane Buyer', customerEmail: 'jane@example.com', paymentMethod: 'card', paymentStatus: 'pending',
    subtotalCents: 2500, discountPercent: null, totalCents: 2500, refundedCents: 0, currency: 'EUR', contributionType: 'paid', donatedAmountCents: null,
    materialCostCents: null, machineTimeMinutes: null, contributionNotes: null, shippingMethod: 'pickup', shippingAddress: null, stripePaymentIntentId: null,
    stripeChargeId: null, stripeInvoiceId: null, hostedInvoiceUrl: null, invoicePdfUrl: null, receiptUrl: null, notes: null, createdAt: new Date('2026-10-01T10:00:00Z'),
    metadata: {}, organization: null, items: [{ modelTitle: 'Bracket', material: 'PLA', colors: ['Black'], quantity: 1, unitPriceCents: 2500, totalCents: 2500 }],
    ...over,
  }
}

test('M47 "Amount after refunds" is shown only for an order that was paid: an unpaid order has paid nothing, and nothing to refund', () => {
  const unpaid = buildOrderReceiptModel({ order: orderRow({ paymentStatus: 'pending', refundedCents: 0 }) })
  assert.equal(unpaid.netPaidCents, 0)
  assert.ok(!buildReceiptPdfLines(unpaid).some((line) => line.startsWith('Amount after refunds')), 'no "Amount after refunds" line on an unpaid order')
  const paid = buildOrderReceiptModel({ order: orderRow({ paymentStatus: 'paid', refundedCents: 500 }) })
  assert.equal(paid.netPaidCents, 2000)
  assert.ok(buildReceiptPdfLines(paid).some((line) => /^Amount after refunds: .*20\.00/.test(line)))
  const free = buildOrderReceiptModel({ order: orderRow({ paymentMethod: 'comped', paymentStatus: 'free', totalCents: 0, subtotalCents: 0, items: [] }) })
  assert.equal(free.netPaidCents, 0)
})

// ---- F24: what an administrator is told ----------------------------------------------------------------------------------------------------------
test('M49 the notification to the administrator says "payment received" only for a payment that is verified', () => {
  const cases: Array<[string | null, string | null, { created?: boolean } | undefined, string]> = [
    ['card', 'paid', undefined, 'Payment received'],
    ['cash', 'paid', { created: true }, 'Payment received'],
    ['invoice', 'paid', { created: true }, 'Payment received'],
    ['card', 'paid', { created: false }, 'Payment updated'],
    ['card', 'pending', undefined, 'Payment promise received'],
    ['cash', 'pending', undefined, 'Payment promise received'],
    ['invoice', 'pending', undefined, 'Payment promise received'],
    ['card', 'processing', undefined, 'Order received - payment pending'],
    ['card', 'failed', undefined, 'Order received - payment pending'],
    ['po', null, undefined, 'Order received - payment pending'],
    ['quote', 'quote', undefined, 'Quote request received'],
    ['quote', 'paid', undefined, 'Quote request received'],
    ['comped', 'free', undefined, 'No-charge order received'],
  ]
  for (const [method, status, opts, expected] of cases) {
    assert.equal(adminPaymentNotificationTitle(method, status, opts), expected, `${method}/${status}/${JSON.stringify(opts)}`)
  }
})

test('M49 the routes that notify an administrator take their title from that one function, never from a literal "Payment received"', () => {
  for (const file of ['app/api/checkout/route.ts', 'app/api/makerworks/jobs/route.ts', 'app/api/jobs/[paymentIntentId]/route.ts']) {
    const text = code(file)
    assert.ok(!/['"`]Payment received['"`]/.test(text), `${file} still carries the literal title "Payment received"`)
    assert.match(text, /adminPaymentNotificationTitle\(/, `${file} does not use adminPaymentNotificationTitle`)
  }
})

// ---- F15: nothing invents "paid" ---------------------------------------------------------------------------------------------------------------------
test('F15 no code path falls back to "paid" when a payment status is missing: the old checkout falls back to "pending"', () => {
  const text = code('app/api/checkout/route.ts')
  assert.ok(!/\?\s*'paid'\s*:\s*'pending'/.test(text), 'a card / PayPal order without a confirmed status is not "paid"')
  assert.ok(!/\|\|\s*\([^)]*'paid'/.test(text), 'a fallback to "paid" survives')
})
