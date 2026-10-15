-- S2/S3 step 3: one Stripe read-and-apply cycle per order at a time (lease), without holding a transaction during the Stripe call.
-- Additive only: three nullable columns on PrintOrder.

-- AlterTable
ALTER TABLE "PrintOrder" ADD COLUMN     "paymentSyncLeaseId" TEXT,
ADD COLUMN     "paymentSyncLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "paymentSyncedAt" TIMESTAMP(3);

