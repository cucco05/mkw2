-- R1-3 / KLOSS A-idx (docs/RILASCIO-PRODUZIONE.md, section 21): the orders of an account, newest first. Additive only: one index; nothing is read, moved, backfilled or deleted.
--
-- Why: the owner guard reads the orders of an owner and a cart (lib/checkout-owner-guard.ts). For a guest that is an index scan ("guestSessionHash"); for an account, without this index, it is
-- a scan of the whole table - 74 to 90 ms at 1 000 000 orders on the isolated cluster, over the 50 ms the plan accepts. With it: 1.3 ms, and 23 ms for an account with 1000 orders of one cart
-- (docs/RILASCIO-PRODUZIONE.md, section 21).
--
-- CONCURRENTLY: the index is built WITHOUT blocking the writes of "PrintOrder" (a plain CREATE INDEX holds a SHARE lock - no INSERT, UPDATE or DELETE - until it is done). It has two
-- consequences, and both are part of the procedure (docs/RILASCIO-PRODUZIONE.md, 21):
--   * it can NOT run inside a transaction block: it MUST stay the ONLY statement of this file. `prisma migrate deploy` sends a file as one batch, and a second statement would make that batch a
--     transaction - the migration would fail (25001, "cannot run inside a transaction block") and be marked failed (tests/kloss-index-migration.test.ts pins the file);
--   * a build that fails (cancelled, interrupted) leaves an INVALID index of this name, and the migration marked failed (P3018). The recovery is: DROP INDEX CONCURRENTLY IF EXISTS
--     "PrintOrder_userId_createdAt_idx"; then `prisma migrate resolve --rolled-back 20261111150000_kloss_owner_orders_index`; then `prisma migrate deploy` again
--     (tests/security/kloss-index-migration.sec.ts proves it). There is NO "IF NOT EXISTS" here on purpose: an invalid index left behind must make the migration fail, never be taken for done.
--
-- ROLLBACK: DROP INDEX CONCURRENTLY "PrintOrder_userId_createdAt_idx" - no data is lost, the application reads the same orders (slower); the migration stays recorded as applied.

-- CreateIndex
CREATE INDEX CONCURRENTLY "PrintOrder_userId_createdAt_idx" ON "PrintOrder"("userId", "createdAt" DESC);
