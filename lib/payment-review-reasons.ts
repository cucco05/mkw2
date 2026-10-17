// What each `paymentReviewReason` code means, in words an administrator can act on (step 4.6, S4). Pure data: no database, no network.
//
// The codes are written by lib/payment-sync.ts (`decidePaymentUpdate`) and by the creation of an order that came from an outside service. An order with a
// review reason is never released to production (lib/order-payment-policy.ts, `releaseDecision`), whatever the code: the table is for READING the reason,
// not for deciding what it allows. A code this table does not know is still a hold, described prudently.
import type { ReviewReason } from '@/lib/payment-verification'

export type ReviewReasonText = { label: string; detail: string }

export const PAYMENT_REVIEW_REASON_TEXT: Record<ReviewReason, ReviewReasonText> = {
  amount: { label: 'Wrong amount', detail: 'The amount Stripe collected (or was asked to collect) is not the order total.' },
  currency: { label: 'Wrong currency', detail: 'The payment is not in the currency of the order.' },
  order_reference: { label: 'Payment not tied to this order', detail: 'The payment does not point to this order or to the payment attempt we created for it.' },
  session_reference: { label: 'Payment page mismatch', detail: 'The Stripe payment page does not match the one we created for this order.' },
  mode: { label: 'Unexpected payment mode', detail: 'Stripe reports a payment mode this checkout does not use.' },
  payment_intent_missing: { label: 'Payment record missing', detail: 'Stripe closed the payment page without a payment record we can verify.' },
  unpaid_completion: { label: 'Completed without payment', detail: 'The payment page was completed but the money has not been collected.' },
  payment_already_used: { label: 'Payment used by another order', detail: 'This payment already belongs to a different order.' },
  duplicate_payment: { label: 'Paid twice', detail: 'The order was already paid and a second, different payment arrived. One of them probably has to be refunded.' },
  paid_after_cancel: { label: 'Paid after cancellation', detail: 'Money arrived for an order that had been cancelled.' },
  status_regression: { label: 'Payment no longer shows as paid', detail: 'Stripe now shows a not-paid state for an order we hold as paid.' },
  dispute: { label: 'Payment disputed', detail: 'The cardholder opened a dispute (chargeback) on this payment.' },
  shipping_country: { label: 'Delivery country not served', detail: 'The delivery address collected by Stripe is in a country we do not ship to.' },
  shipping_address_missing: { label: 'Delivery address missing', detail: 'The order is paid but has no delivery address to ship to.' },
  external_order: { label: 'Order from an outside service', detail: 'The order was created from an outside service\'s claim and has not been checked by a person.' },
}

export const UNKNOWN_REVIEW_REASON_TEXT: ReviewReasonText = {
  label: 'Payment under review',
  detail: 'A payment problem was recorded for this order. Production stays blocked until a person has resolved it.',
}

export function describeReviewReason(code: string | null | undefined): ReviewReasonText | null {
  if (!code) return null
  return (PAYMENT_REVIEW_REASON_TEXT as Record<string, ReviewReasonText | undefined>)[code] ?? UNKNOWN_REVIEW_REASON_TEXT
}
