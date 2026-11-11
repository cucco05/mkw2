-- R1-3 / KLOSS hardening B - may version :retire of the cart fingerprint leave the registry (lib/cart-fingerprint.ts)? READ ONLY: one transaction PostgreSQL keeps read-only.
--
-- usage:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v retire=1 -f scripts/cart-fingerprint-retirement.sql
--         (without -v retire the statements do not even parse: nothing is assumed)
--
-- A version leaves the registry only when NO order that can still change a decision carries a fingerprint that only that version recognises:
--   * an order written since hardening B says which version computed its fingerprints (metadata.checkout.cartFingerprintVersion);
--   * an order written BEFORE it says nothing: it may be of any version of that time, so it counts against the version to retire (the check is conservative);
--   * "can still change a decision" is the relevance of the owner guard (docs/RILASCIO-PRODUZIONE.md, 22) in its widest form: a payment in doubt; an attempt that is not shown closed by the
--     provider's word, nor proved never created, nor the page that carried the order's own payment; an unpaid order of ANY age (a request sent again finds it by its key); a payment verified in the
--     last 24 hours or at an unknown instant (the widest window of the repeat gate).
-- Q2 must return 0. Q3 lists at most 50 of the orders that still need the version: ids and states only, nothing personal. Nothing is written, nothing is "fixed" from here.

BEGIN;
SET TRANSACTION READ ONLY;

-- Q1: how many orders each version wrote ("unknown": written before hardening B)
SELECT coalesce(o."metadata" #>> '{checkout,cartFingerprintVersion}', 'unknown (before hardening B)') AS version, count(*) AS orders
FROM "PrintOrder" AS o
WHERE o."metadata" #> '{checkout,cartFingerprint}' IS NOT NULL
GROUP BY 1
ORDER BY 1;

-- Q2: THE CHECK - the orders that can still change a decision and that version :retire may be the only one to recognise
SELECT count(*) AS still_needed
FROM "PrintOrder" AS o
WHERE o."metadata" #> '{checkout,cartFingerprint}' IS NOT NULL
  AND (o."metadata" #>> '{checkout,cartFingerprintVersion}' IS NULL OR o."metadata" #>> '{checkout,cartFingerprintVersion}' = :'retire')
  AND (
    o."paymentStatus" = 'processing'
    OR o."paymentReviewReason" IS NOT NULL
    OR (o."status" = 'awaiting_review' AND o."paymentStatus" IN ('paid', 'free'))
    OR EXISTS (SELECT 1 FROM "PaymentAttempt" AS a WHERE a."orderId" = o."id" AND NOT COALESCE((
         (a."status" IN ('expired', 'failed') AND COALESCE(a."failureReason", '') <> 'stale_reservation' AND (
           ((COALESCE(a."stripeSessionId", '') COLLATE "C") ~ '^cs_[A-Za-z0-9_]{1,255}$' AND (starts_with(COALESCE(a."failureReason", ''), 'closed_by_us:') OR starts_with(COALESCE(a."failureReason", ''), 'provider_status:expired')))
           OR (COALESCE(a."stripeSessionId", '') = '' AND (starts_with(COALESCE(a."failureReason", ''), 'local_refusal:') OR starts_with(COALESCE(a."failureReason", ''), 'provider_rejected:')))))
         OR (a."status" = 'paid' AND COALESCE(a."stripePaymentIntentId", '') <> '' AND COALESCE(a."stripePaymentIntentId" = o."stripePaymentIntentId", FALSE)
             AND o."paymentStatus" IN ('paid', 'free', 'refunded', 'succeeded', 'success'))
       ), FALSE))
    OR (o."status" = 'awaiting_payment' AND o."paymentStatus" = 'pending')
    OR (o."paymentStatus" NOT IN ('pending', 'processing', 'requires_capture', 'quote', 'failed', 'canceled', 'cancelled') AND (o."paidAt" IS NULL OR o."paidAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours'))
  );

-- Q3: at most 50 of them, the newest first (ids and states only)
SELECT o."id", o."orderNumber", o."status", o."paymentStatus", o."createdAt", coalesce(o."metadata" #>> '{checkout,cartFingerprintVersion}', 'unknown') AS version
FROM "PrintOrder" AS o
WHERE o."metadata" #> '{checkout,cartFingerprint}' IS NOT NULL
  AND (o."metadata" #>> '{checkout,cartFingerprintVersion}' IS NULL OR o."metadata" #>> '{checkout,cartFingerprintVersion}' = :'retire')
  AND (
    o."paymentStatus" = 'processing'
    OR o."paymentReviewReason" IS NOT NULL
    OR (o."status" = 'awaiting_review' AND o."paymentStatus" IN ('paid', 'free'))
    OR EXISTS (SELECT 1 FROM "PaymentAttempt" AS a WHERE a."orderId" = o."id" AND NOT COALESCE((
         (a."status" IN ('expired', 'failed') AND COALESCE(a."failureReason", '') <> 'stale_reservation' AND (
           ((COALESCE(a."stripeSessionId", '') COLLATE "C") ~ '^cs_[A-Za-z0-9_]{1,255}$' AND (starts_with(COALESCE(a."failureReason", ''), 'closed_by_us:') OR starts_with(COALESCE(a."failureReason", ''), 'provider_status:expired')))
           OR (COALESCE(a."stripeSessionId", '') = '' AND (starts_with(COALESCE(a."failureReason", ''), 'local_refusal:') OR starts_with(COALESCE(a."failureReason", ''), 'provider_rejected:')))))
         OR (a."status" = 'paid' AND COALESCE(a."stripePaymentIntentId", '') <> '' AND COALESCE(a."stripePaymentIntentId" = o."stripePaymentIntentId", FALSE)
             AND o."paymentStatus" IN ('paid', 'free', 'refunded', 'succeeded', 'success'))
       ), FALSE))
    OR (o."status" = 'awaiting_payment' AND o."paymentStatus" = 'pending')
    OR (o."paymentStatus" NOT IN ('pending', 'processing', 'requires_capture', 'quote', 'failed', 'canceled', 'cancelled') AND (o."paidAt" IS NULL OR o."paidAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours'))
  )
ORDER BY o."createdAt" DESC
LIMIT 50;

COMMIT;
