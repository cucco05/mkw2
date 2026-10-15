-- S2/S3 step 1: groundwork for orders created BEFORE payment (Stripe Checkout).
-- Additive only: new nullable/defaulted columns, one new table, new indexes. No existing row or column is changed or removed.
-- Existing orders keep currency, totals and status exactly as they are (no currency conversion is performed).

-- AlterTable
ALTER TABLE "PrintOrder" ADD COLUMN     "checkoutKey" TEXT,
ADD COLUMN     "guestAccessExpiresAt" TIMESTAMP(3),
ADD COLUMN     "guestAccessTokenHash" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentReviewReason" TEXT,
ADD COLUMN     "shippingCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StripeEvent" ADD COLUMN     "checkoutSessionId" TEXT,
ADD COLUMN     "orderId" TEXT;

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "amountReceivedCents" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_stripeSessionId_key" ON "PaymentAttempt"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_stripePaymentIntentId_key" ON "PaymentAttempt"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_orderId_idx" ON "PaymentAttempt"("orderId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_status_expiresAt_idx" ON "PaymentAttempt"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrintOrder_checkoutKey_key" ON "PrintOrder"("checkoutKey");

-- CreateIndex
CREATE INDEX "PrintOrder_paymentReviewReason_idx" ON "PrintOrder"("paymentReviewReason");

-- CreateIndex
CREATE INDEX "StripeEvent_checkoutSessionId_idx" ON "StripeEvent"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "StripeEvent_orderId_idx" ON "StripeEvent"("orderId");

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PrintOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

