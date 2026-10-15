import assert from 'node:assert/strict'
import test from 'node:test'

import { isPublicPath } from '../proxy'

test('payment badge assets bypass the auth proxy', () => {
  assert.equal(isPublicPath('/ApplePay.svg'), true)
  assert.equal(isPublicPath('/GooglePay.png'), true)
})

test('public image asset folders bypass the auth proxy', () => {
  assert.equal(isPublicPath('/badges/first_upload.png'), true)
  assert.equal(isPublicPath('/brand/logo.png'), true)
})

// Step 4.1: the page Stripe sends the customer back to may be opened without signing in (guests pay too), but ONLY that exact page:
// reaching it does not make any order public (the order's state is asked from /api/checkout/status, which checks who is asking).
test('only the exact return page of the payment is public; the rest of the checkout stays behind the sign-in for now', () => {
  assert.equal(isPublicPath('/checkout/success'), true)
  for (const path of ['/checkout', '/cart', '/checkout/success/x', '/checkout/successful', '/checkout/other', '/customer/orders', '/customer/orders/abc', '/admin', '/files/orders/x/receipt.pdf']) {
    assert.equal(isPublicPath(path), false, `${path} must not be public`)
  }
})
