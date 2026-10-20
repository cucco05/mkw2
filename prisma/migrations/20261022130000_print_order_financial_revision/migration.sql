-- Step 4.6 (S6a), M3b: the financial revision of an order (lib/financial-revision.ts, docs/RILASCIO-PRODUZIONE.md).
-- Additive only: one NOT NULL column with the default 0 on "PrintOrder". Every existing row starts at 0, nothing is read or changed, the code of the previous version ignores it.
-- An administrator's authorization records the revision the order had when it was given and is valid only while the order still has that value.
-- The counter only goes up (it is only ever incremented, in the same UPDATE that changes a financial fact).
--
-- ROLLBACK: `DROP COLUMN "financialRevision"` is NOT a rollback once the column has been used - it erases the counter on which the validity of every authorization
-- depends (the previous version would then take old authorizations as valid again). The application is rolled back by deploying the previous version and leaving this column
-- where it is. See docs/RILASCIO-PRODUZIONE.md, "Migrazioni S6: ripristino senza distruggere dati".

-- AlterTable
ALTER TABLE "PrintOrder" ADD COLUMN     "financialRevision" INTEGER NOT NULL DEFAULT 0;

