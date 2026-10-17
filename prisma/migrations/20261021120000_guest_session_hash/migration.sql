-- Step 4.6 (S5): the browser session of a guest, as a hash, on the orders a guest makes (the repeat-key and the "same purchase" check are tied to it).
-- Additive only: one nullable column and its index. No backfill: orders that exist keep NULL and behave exactly as before. Nothing is read from it to open an order.

-- AlterTable
ALTER TABLE "PrintOrder" ADD COLUMN     "guestSessionHash" TEXT;

-- CreateIndex
CREATE INDEX "PrintOrder_guestSessionHash_idx" ON "PrintOrder"("guestSessionHash");
