-- DR-13 (docs/CHECKOUT-S2-S3.md): ONE payable payment page per order. Additive only: one nullable column; nothing is read, moved, backfilled or deleted.
--
-- "PaymentAttempt"."requestHash": the SHA-256 of the exact request sent to Stripe for the attempt (parameters, return address, API version, test/live, idempotency key), written in the
-- SAME insert as the reservation. A reservation is sent again only if the request as it would be built now has the same hash. Rows that exist have no hash and are never sent again.
--
-- ROLLBACK: the column can stay; code older than this migration ignores it.

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN "requestHash" TEXT;
