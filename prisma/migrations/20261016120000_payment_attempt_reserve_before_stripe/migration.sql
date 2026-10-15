-- S2/S3 step 2: a payment attempt is reserved BEFORE Stripe is called, so its Stripe session id is not known yet.
-- Relaxes one constraint (the unique index on stripeSessionId still applies to every non-null value) and changes a default.
-- No data is changed.

-- AlterTable
ALTER TABLE "PaymentAttempt" ALTER COLUMN "stripeSessionId" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'creating';

