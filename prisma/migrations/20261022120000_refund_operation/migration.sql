-- Step 4.6 (S6a), M3a: the refunds requested from the application, one row per intention of an administrator (lib/refund-operations.ts, docs/RILASCIO-PRODUZIONE.md).
-- Additive only: one new table, its indexes and one foreign key. No existing row is read, changed or moved; the code of the previous version never looks at this table.
-- While a row of an order is open the order is not released to production (lib/order-payment-policy.ts, `refundOperationBlocks`).
--
-- The CHECK constraint at the end is not known to Prisma (the drift check does not see it, and does not need to): it makes it impossible, even with a direct write to the
-- database, to store "abandoned" - which means "PROVEN that nothing was ever sent to Stripe" - on an operation that has a `firstSentAt`.
--
-- ROLLBACK: once the table holds a single operation, `DROP TABLE "RefundOperation"` is NOT a rollback - it erases the record of money that was asked to move and the
-- idempotency of the refunds. The application is rolled back by deploying the previous version and leaving this table where it is, after closing or adopting every open
-- operation (the previous version does not see them and would no longer block production). See docs/RILASCIO-PRODUZIONE.md, "Migrazioni S6: ripristino senza distruggere dati".

-- CreateTable
CREATE TABLE "RefundOperation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "expectedRefundedCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "stripeRefundStatus" TEXT,
    "failureKind" TEXT,
    "failureCode" TEXT,
    "adminId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendLeaseUntil" TIMESTAMP(3),
    "firstSentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "lastObservation" JSONB,
    "unresolvedAt" TIMESTAMP(3),
    "unresolvedReason" TEXT,
    "recoveredBy" TEXT,
    "adoptedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundOperation_stripeRefundId_key" ON "RefundOperation"("stripeRefundId");

-- CreateIndex
CREATE INDEX "RefundOperation_orderId_status_idx" ON "RefundOperation"("orderId", "status");

-- AddForeignKey
ALTER TABLE "RefundOperation" ADD CONSTRAINT "RefundOperation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PrintOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddCheckConstraint: "abandoned" is only for an operation that never reached Stripe.
ALTER TABLE "RefundOperation" ADD CONSTRAINT "RefundOperation_abandoned_never_sent_check" CHECK ("status" <> 'abandoned' OR "firstSentAt" IS NULL);
