-- R1-1b: what a manual removal of the table "GuestPurchaseKey" would destroy. READ ONLY: this file counts and changes nothing.
--
-- The table keeps, for every guest checkout key that was shown to belong to an order, the fingerprint of the key and that order (lib/purchase-intent.ts, lib/checkout-orders.ts).
-- It is the only thing that stops a second order for the same purchase when the browser's session has changed, so it is NOT put away with the code that uses it:
--   * the application is rolled back by SUSPENDING the checkout (HOSTED_CHECKOUT_ENABLED=false), putting the code back while it is suspended, and leaving it suspended until a version
--     that holds the guard is running again; the table stays where it is (docs/RILASCIO-PRODUZIONE.md, "R1-1b");
--   * the table is never dropped while it holds a binding. `safe_to_drop` is 1 only when there is none (the migration undone before any guest order was ever bound).
--
-- Run it with psql against the database in question, in a read-only session:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on" -f scripts/guest-purchase-keys-check.sql
-- (the same definitions of "in doubt" as lib/payment-in-doubt.ts, written out here so that this file can be read on its own; tests/security/purchase-key.sec.ts runs this very file.)
SELECT
  count(*)::int AS bindings,
  count(*) FILTER (WHERE o."paidAt" IS NOT NULL OR o."paymentStatus" IN ('paid', 'free'))::int AS tied_to_paid,
  count(*) FILTER (WHERE
    o."paymentStatus" = 'processing'
    OR o."paymentReviewReason" IS NOT NULL
    OR (o."status" = 'awaiting_review' AND o."paymentStatus" IN ('paid', 'free'))
    OR EXISTS (SELECT 1 FROM "PaymentAttempt" AS a WHERE a."orderId" = o."id" AND a."status" IN ('processing', 'mismatch'))
  )::int AS tied_to_in_doubt,
  count(*) FILTER (WHERE o."status" = 'awaiting_payment' AND o."paymentStatus" = 'pending')::int AS tied_to_unpaid_orders,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "PaymentAttempt" AS a WHERE a."orderId" = o."id" AND a."status" IN ('creating', 'open', 'processing', 'mismatch')))::int AS tied_to_open_attempts,
  (CASE WHEN count(*) = 0 THEN 1 ELSE 0 END)::int AS safe_to_drop
FROM "GuestPurchaseKey" AS k
JOIN "PrintOrder" AS o ON o."id" = k."orderId";
