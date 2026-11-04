-- DR-13: the state of the payment pages of the orders. READ ONLY: this file counts and lists, and changes nothing.
--
-- One payable payment page per order (lib/checkout-sessions.ts, lib/checkout-session-plan.ts). Run it BEFORE the migration 20261104130000_dr13_single_live_page creates its unique index on
-- a database that holds orders (Q1 must be empty), AFTER a deploy to see what the new code found, and whenever a customer was told that a page is "being checked".
--
-- Run it with psql against the database in question, in a read-only session:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on" -f scripts/checkout-pages-check.sql
-- Nothing in it closes, reopens, moves or deletes a row, and nothing may be added to it that does: a row that cannot be proved is never "cleaned" by hand. A page is closed by the
-- application, at the provider, with proof; a reservation is resolved by the application by sending its own request again where that is provably safe. What this file lists is what is
-- waiting for that, or for a person. (tests/security/dr13-orchestrator.sec.ts runs this very file.)

-- Q1. Orders with more than one LIVE attempt (a reservation or an open page). The unique index can not be created while this returns rows.
SELECT 'Q1_orders_with_several_live_attempts' AS query, "orderId", count(*)::int AS live_attempts, array_agg("id" ORDER BY "createdAt") AS attempts, array_agg("status" ORDER BY "createdAt") AS statuses
FROM "PaymentAttempt"
WHERE "status" IN ('creating', 'open')
GROUP BY "orderId"
HAVING count(*) > 1;

-- Q2. Reservations ("creating"): every one is waiting for its request to be resolved. Age in minutes; an old one is never closed by the clock.
SELECT 'Q2_reservations' AS query, a."id" AS attempt, a."orderId", o."status" AS order_status, o."paymentStatus",
  round(extract(epoch FROM (now() - a."createdAt")) / 60)::int AS age_minutes,
  (a."stripeSessionId" IS NOT NULL) AS has_session_id, (a."requestHash" IS NOT NULL) AS has_stored_request
FROM "PaymentAttempt" AS a JOIN "PrintOrder" AS o ON o."id" = a."orderId"
WHERE a."status" = 'creating'
ORDER BY a."createdAt";

-- Q3. Open pages whose time is over (by the database's own clock) while the order still waits for its payment: they are closed at the provider, with proof, the next time the customer comes back.
SELECT 'Q3_open_pages_past_their_expiry' AS query, a."id" AS attempt, a."orderId", a."stripeSessionId",
  round(extract(epoch FROM (now() - a."expiresAt")) / 60)::int AS minutes_past_expiry
FROM "PaymentAttempt" AS a JOIN "PrintOrder" AS o ON o."id" = a."orderId"
WHERE a."status" = 'open' AND a."expiresAt" < now() AND o."status" = 'awaiting_payment'
ORDER BY a."expiresAt";

-- Q4. Orders paid more than once: a second payment was recorded as a duplicate and waits for a person (refunds are decided by a person, never automatically).
SELECT 'Q4_orders_paid_more_than_once' AS query, o."id" AS "orderId", o."orderNumber", o."paymentReviewReason", count(*) FILTER (WHERE a."status" = 'paid')::int AS paid_attempts
FROM "PrintOrder" AS o JOIN "PaymentAttempt" AS a ON a."orderId" = o."id"
GROUP BY o."id", o."orderNumber", o."paymentReviewReason"
HAVING count(*) FILTER (WHERE a."status" = 'paid') > 1 OR o."paymentReviewReason" = 'duplicate_payment';

-- Q5. Attempts that were CLOSED WITHOUT PROOF: closed ("expired" / "failed") by the clock ("stale_reservation", the old rule), or with no Stripe identifier and no proof that nothing was ever created.
-- While one exists on an order that still waits for its payment, no NEW page is opened for it (a page may exist at the provider that the database never learned about); the row is left as it is.
-- Rows made before DR-13 are all of this kind; the application never writes one.
SELECT 'Q5_closed_without_proof' AS query, a."id" AS attempt, a."orderId", o."status" AS order_status, a."status", a."failureReason", (a."stripeSessionId" IS NOT NULL) AS has_session_id,
  round(extract(epoch FROM (now() - a."createdAt")) / 3600)::int AS age_hours, (a."stripePaymentIntentId" IS NOT NULL OR COALESCE(a."amountReceivedCents", 0) > 0) AS carries_a_payment
FROM "PaymentAttempt" AS a JOIN "PrintOrder" AS o ON o."id" = a."orderId"
WHERE a."status" IN ('expired', 'failed')
  AND (a."failureReason" = 'stale_reservation'
       OR (a."stripeSessionId" IS NULL AND COALESCE(a."failureReason", '') NOT LIKE 'local\_refusal:%' AND COALESCE(a."failureReason", '') NOT LIKE 'provider\_rejected:%'))
ORDER BY (o."status" = 'awaiting_payment') DESC, a."createdAt";

-- Q6. Live pages of an order that can not be paid any more (paid, being confirmed, cancelled, under review): pages whose closing at the provider is still to be proved. This is the
-- persistent record of the closing of the twin pages of a paid order: a closing that failed leaves its row here, and the next sign of life of the order (a payment event, the
-- confirmation page of the customer) tries again. Empty when everything is closed.
SELECT 'Q6_live_pages_of_orders_that_cannot_be_paid' AS query, a."id" AS attempt, a."orderId", o."status" AS order_status, o."paymentStatus", a."status", a."stripeSessionId",
  round(extract(epoch FROM (now() - a."createdAt")) / 60)::int AS age_minutes
FROM "PaymentAttempt" AS a JOIN "PrintOrder" AS o ON o."id" = a."orderId"
WHERE a."status" IN ('creating', 'open')
  AND (o."paymentStatus" IN ('paid', 'free', 'processing') OR o."status" <> 'awaiting_payment' OR o."paymentReviewReason" IS NOT NULL)
ORDER BY a."createdAt";
