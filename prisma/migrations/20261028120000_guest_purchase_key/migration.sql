-- Step 4.6, R1-1b: the guard against a second guest order for the same purchase key (lib/purchase-intent.ts, lib/checkout-orders.ts, docs/SESSIONE-OSPITE.md R1).
-- Additive only: ONE new table, its index and its foreign key. No column of an existing table is added, changed or removed; nothing is read, moved or backfilled: the orders that
-- exist have no row here and behave exactly as before until their owner comes back with the same key (the row is written then). The code of the previous version never looks at
-- this table, and `PrintOrder.checkoutKey` keeps the meaning it had, so the previous code finds every order the new code makes.
--
-- A row says: "this checkout key (as a fingerprint) belongs to this order". The primary key is the arbiter: a key can be bound to ONE order, for good, whatever the session and the
-- process. The CHECK constraint at the end is not known to Prisma (the drift check does not see it, and does not need to): it lets nothing but a fingerprint - 64 lower-case hex
-- digits - into the table, so that a checkout key itself can never be stored here, not even by a direct write.
--
-- ROLLBACK: once the table holds a single row, `DROP TABLE "GuestPurchaseKey"` is NOT a rollback - it removes the only thing that stops a second order for the same purchase when
-- the guest's session has changed. The application is rolled back by SUSPENDING the checkout (HOSTED_CHECKOUT_ENABLED=false), putting the code back while it is suspended, and
-- leaving it suspended until a version that holds the guard runs again; the table stays where it is. `scripts/guest-purchase-keys-check.sql` (read only) counts what a removal
-- would destroy. Undoing this migration is allowed only while the table is empty (before any guest order was bound). See docs/RILASCIO-PRODUZIONE.md, "R1-1b".

-- CreateTable
CREATE TABLE "GuestPurchaseKey" (
    "keyHash" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestPurchaseKey_pkey" PRIMARY KEY ("keyHash")
);

-- CreateIndex
CREATE INDEX "GuestPurchaseKey_orderId_idx" ON "GuestPurchaseKey"("orderId");

-- AddForeignKey
ALTER TABLE "GuestPurchaseKey" ADD CONSTRAINT "GuestPurchaseKey_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PrintOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a fingerprint (64 lower-case hex digits) can be stored: never a checkout key.
ALTER TABLE "GuestPurchaseKey" ADD CONSTRAINT "GuestPurchaseKey_keyHash_shape_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$');
