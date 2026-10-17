// "An order whose payment is in doubt": the money is being confirmed, or it arrived and a person has to look at it. The same four conditions, written once, for the
// two places that must agree on them:
//   * the guard against paying the same cart twice (lib/checkout-orders.ts, findPurchaseInFlight) looks only at these orders, with NO time limit;
//   * the retention job (lib/data-retention.ts) never empties the browser-session hash of one of them: that hash is what lets the guard recognise the same
//     browser, so it stays for as long as the payment is in doubt - the markers an order needs for its safety are not "retention" material.
// `PAYMENT_IN_DOUBT_WHERE` is for queries; `PAYMENT_IN_DOUBT_SQL` is the same for a single statement that must decide AND write (tests/security/guest-session.sec.ts
// proves the two pick the same orders).
import { Prisma } from '@prisma/client'

export const PAYMENT_IN_DOUBT_WHERE: Prisma.PrintOrderWhereInput = {
  OR: [
    { paymentStatus: 'processing' },
    { paymentReviewReason: { not: null } },
    { status: 'awaiting_review', paymentStatus: { in: ['paid', 'free'] } },
    { paymentAttempts: { some: { status: { in: ['processing', 'mismatch'] } } } },
  ],
}

// (refers to the table by its name: use it in a statement on "PrintOrder")
export const PAYMENT_IN_DOUBT_SQL = Prisma.sql`(
  "PrintOrder"."paymentStatus" = 'processing'
  OR "PrintOrder"."paymentReviewReason" IS NOT NULL
  OR ("PrintOrder"."status" = 'awaiting_review' AND "PrintOrder"."paymentStatus" IN ('paid', 'free'))
  OR EXISTS (SELECT 1 FROM "PaymentAttempt" AS "attempt" WHERE "attempt"."orderId" = "PrintOrder"."id" AND "attempt"."status" IN ('processing', 'mismatch'))
)`
