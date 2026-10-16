-- Step 4.6 (S3): authorised, traced exceptions to the shop's minimum price per unit (one model or one ready-made product each).
-- Additive only: one new, EMPTY table. No waiver exists until an administrator grants one; no existing order, price or setting changes.
-- No foreign keys on purpose (the record of who granted what, and why, must outlive the model or product).

-- CreateTable
CREATE TABLE "MinimumPriceWaiver" (
    "id" TEXT NOT NULL,
    "modelId" TEXT,
    "productTemplateId" TEXT,
    "minimumPriceCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "MinimumPriceWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MinimumPriceWaiver_modelId_idx" ON "MinimumPriceWaiver"("modelId");

-- CreateIndex
CREATE INDEX "MinimumPriceWaiver_productTemplateId_idx" ON "MinimumPriceWaiver"("productTemplateId");

-- CreateIndex
CREATE INDEX "MinimumPriceWaiver_revokedAt_idx" ON "MinimumPriceWaiver"("revokedAt");
