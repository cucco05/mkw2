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

// Step 4.1/4.2: the cart, the checkout and the page Stripe sends the customer back to may be opened without signing in (guests pay
// too), but ONLY those exact pages: reaching one does not make any order or model public (the order's state is asked from
// /api/checkout/status, the prices from /api/checkout/quote, models from the model APIs: each decides by who is asking).
test('only the exact cart, checkout and payment-return pages are public; everything around them stays behind the sign-in', () => {
  for (const path of ['/cart', '/checkout', '/checkout/success']) assert.equal(isPublicPath(path), true, `${path} must be public`)
  for (const path of [
    '/cart/x', '/cart/', '/checkout/x', '/checkout/billing', '/checkout/success/x', '/checkout/successful', '/checkout/other', '/carts', '/checkoutx',
    '/customer/orders', '/customer/orders/abc', '/customer/workspaces', '/admin', '/admin/orders', '/upload', '/me', '/settings/profile', '/files/orders/x/receipt.pdf',
  ]) {
    assert.equal(isPublicPath(path), false, `${path} must not be public`)
  }
})
