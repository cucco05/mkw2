-- DR-13 (docs/SESSIONE-OSPITE.md, docs/CHECKOUT-S2-S3.md): ONE payable payment page per order - the floor under the decisions of the application.
-- Additive only: one index; nothing is read, moved, backfilled or deleted.
--
-- "PaymentAttempt_orderId_live_page_key" is a PARTIAL UNIQUE INDEX: an order has at most one attempt that is a reservation ('creating') or an open payment page ('open'). The application takes
-- its decisions under the lock of the order (lib/checkout-sessions.ts) and does not depend on the index; the index makes the one thing that must never exist - two live pages for one order -
-- impossible to write: a statement that would leave two fails with a unique violation, and the application decides again (never a second page, never an error for the customer).
-- Prisma does not model an index with a predicate: the schema does not mention it, and the drift check (`prisma migrate diff`) does not see it.
--
-- BEFORE it is created, on any database that holds orders: scripts/checkout-pages-check.sql (read only), query Q1 - orders with more than one live attempt - must return NO rows. If it returns
-- some, this statement fails and NOTHING is changed (one DDL statement, one transaction); the pages are closed with proof by the application (the planner closes twins at the provider, once a
-- customer comes back), never by hand.
-- ORDER OF RELEASE: the code first, with the checkout suspended (HOSTED_CHECKOUT_ENABLED=false), then this index, then the checkout is enabled again (docs/RILASCIO-PRODUZIONE.md).
--
-- ROLLBACK: `DROP INDEX "PaymentAttempt_orderId_live_page_key"` loses only the extra protection and no data. Code older than DR-13 that runs against the index fails with a unique violation - never
-- with a second page - when it would open a second live page for an order: roll back with the checkout suspended.

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAttempt_orderId_live_page_key" ON "PaymentAttempt" ("orderId") WHERE "status" IN ('creating', 'open');
