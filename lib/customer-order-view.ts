// What a customer (or the app on their phone) may read about their own order through the API. An ALLOW list: a column added to the
// order later stays private until it is added here on purpose. Not included: Stripe identifiers, the checkout key, the guest
// access hash, the payment-sync lease, the review reason, accounting fields, printer assignment, and `metadata` (internal markers
// such as production authorizations and effect bookkeeping; what clients need from it is returned separately as `derived`).
const CUSTOMER_ORDER_KEYS = [
  'id', 'orderNumber', 'status', 'paymentMethod', 'paymentStatus', 'paidAt', 'refundedCents',
  'hostedInvoiceUrl', 'invoicePdfUrl', 'receiptUrl',
  'customerEmail', 'customerName', 'shippingMethod', 'shippingAddress',
  'subtotalCents', 'discountPercent', 'shippingCents', 'taxCents', 'totalCents', 'currency',
  'notes', 'failedAt', 'failureNote', 'reprintOfId', 'organizationId', 'createdAt', 'updatedAt',
  // related records the order page shows (the customer's own content)
  'items', 'revisions', 'messages', 'approvalRequests', 'failurePhotos', 'reprintOf', 'reprints',
] as const

export function toCustomerOrderView(order: Record<string, any>): Record<string, unknown> {
  const view: Record<string, unknown> = {}
  for (const key of CUSTOMER_ORDER_KEYS) {
    if (key in order) view[key] = order[key]
  }
  return view
}
