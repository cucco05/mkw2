#!/bin/bash
# R1-3 / KLOSS - P0: EXPLAIN (ANALYZE) of the queries the owner-intent gate of the plan would run, on a THROW-AWAY database of the isolated local test cluster filled with synthetic rows.
# It reads and writes nothing of the repository, creates ONE database (`kloss_explain_<N>_sectest`, from the migrated test database) and drops it at the end; it refuses any host but this machine.
# usage: tests/red/kloss/explain.sh <orders>        e.g. 100000       (PGHOST/PGPORT/PGUSER/TEMPLATE_DB may be set; the defaults are those of the isolated cluster)
# Not a test (no test pattern matches it). The numbers of the last run are in tests/red/kloss/RED-LEDGER.md.
set -euo pipefail
N=${1:-100000}
HOST=${PGHOST:-127.0.0.1}; PORT=${PGPORT:-55432}; USER_=${PGUSER:-postgres}; TEMPLATE=${TEMPLATE_DB:-mkw_dr13_sectest}
case "$HOST" in 127.0.0.1|localhost) ;; *) echo "refused: not the local isolated cluster ($HOST)" >&2; exit 2;; esac
DB="kloss_explain_${N}_sectest"
ADMIN="psql -h $HOST -p $PORT -U $USER_ -q -At -v ON_ERROR_STOP=1 -d postgres"
P="psql -h $HOST -p $PORT -U $USER_ -q -At -v ON_ERROR_STOP=1 -d $DB"
cleanup() { $ADMIN -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
$ADMIN -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\" TEMPLATE \"$TEMPLATE\""
$P -c 'ALTER TABLE "PrintOrder" DISABLE TRIGGER ALL' -c 'ALTER TABLE "PaymentAttempt" DISABLE TRIGGER ALL'
# 20% of the orders belong to accounts (4 orders each), 80% to guests (about 1.5 orders per browser session); 4000 distinct carts (popular carts repeat); a quarter of the orders paid, a few
# awaiting payment, the rest cancelled; two attempts per order (a quarter of the orders have a paying attempt with a PaymentIntent, a few a live page)
$P <<SQL
INSERT INTO "PrintOrder" (id, status, "paymentStatus", "paymentMethod", "shippingMethod", "subtotalCents", "totalCents", currency, "updatedAt", "createdAt", "userId", "guestSessionHash", metadata, "paidAt")
SELECT 'o' || lpad(g::text, 10, '0'),
       CASE WHEN g % 4 = 0 THEN 'queued' WHEN g % 50 = 1 THEN 'awaiting_payment' ELSE 'cancelled' END,
       CASE WHEN g % 4 = 0 THEN 'paid' WHEN g % 50 = 1 THEN 'pending' ELSE 'canceled' END,
       'card', 'pickup', 1000 + (g % 90) * 100, 1000 + (g % 90) * 100, 'EUR', now(), timestamp '2026-01-01' + (g || ' seconds')::interval,
       CASE WHEN g % 5 = 0 THEN 'u' || lpad(((g / 5) % ($N / 25))::text, 8, '0') ELSE NULL END,
       CASE WHEN g % 5 <> 0 THEN md5('session' || ((g * 2) / 3)::text) || md5('s2' || ((g * 2) / 3)::text) ELSE NULL END,
       jsonb_build_object('source', 'stripe_checkout', 'checkout', jsonb_build_object('version', 1, 'cartFingerprint', md5('cart' || (g % 4000)::text), 'fingerprint', md5('fp' || (g % 4000)::text))),
       CASE WHEN g % 4 = 0 THEN timestamp '2026-01-01' + (g || ' seconds')::interval ELSE NULL END
FROM generate_series(1, $N) g;
INSERT INTO "PaymentAttempt" (id, "orderId", "stripeSessionId", "amountCents", currency, status, "expiresAt", "updatedAt", "createdAt", "failureReason", "stripePaymentIntentId")
SELECT 'a' || lpad(g::text, 10, '0') || k::text, 'o' || lpad(g::text, 10, '0'), 'cs_test_' || md5(g::text || k::text), 1000, 'EUR',
       CASE WHEN g % 4 = 0 AND k = 1 THEN 'paid' WHEN g % 50 = 1 AND k = 1 THEN 'open' ELSE 'expired' END, now(), now(), timestamp '2026-01-01' + (g || ' seconds')::interval,
       CASE WHEN g % 4 = 0 AND k = 1 THEN NULL WHEN g % 50 = 1 AND k = 1 THEN NULL WHEN g % 3 = 0 THEN 'closed_by_us:x' ELSE 'provider_status:expired' END,
       CASE WHEN g % 4 = 0 AND k = 1 THEN 'pi_' || md5(g::text) ELSE NULL END
FROM generate_series(1, $N) g, generate_series(1, 2) k;
ANALYZE "PrintOrder"; ANALYZE "PaymentAttempt";
SQL
echo "rows: orders=$($P -c 'select count(*) from "PrintOrder"') attempts=$($P -c 'select count(*) from "PaymentAttempt"') size=$($P -c "select pg_size_pretty(pg_total_relation_size('\"PrintOrder\"') + pg_total_relation_size('\"PaymentAttempt\"'))")"
CART=$($P -c "select metadata->'checkout'->>'cartFingerprint' from \"PrintOrder\" where \"userId\" is not null order by id limit 1 offset 100")
USERID=$($P -c "select \"userId\" from \"PrintOrder\" where metadata->'checkout'->>'cartFingerprint' = '$CART' and \"userId\" is not null limit 1")
H1=$($P -c "select \"guestSessionHash\" from \"PrintOrder\" where \"guestSessionHash\" is not null order by id limit 1 offset 200")
H2=$($P -c "select \"guestSessionHash\" from \"PrintOrder\" where \"guestSessionHash\" is not null order by id limit 1 offset 4000")
IDS=$($P -c "select string_agg(quote_literal(id), ',') from (select id from \"PrintOrder\" where \"guestSessionHash\" = '$H2' limit 3) s")
CART2=$($P -c "select metadata->'checkout'->>'cartFingerprint' from \"PrintOrder\" where \"guestSessionHash\" = '$H1' limit 1")
best_of_three() { # label sql
  local best="" i
  for i in 1 2 3; do
    local ms; ms=$($P -c "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) $2" | grep 'Execution Time' | sed -E 's/Execution Time: ([0-9.]+) ms/\1/')
    if [ -z "$best" ] || awk "BEGIN { exit !($ms < $best) }"; then best=$ms; fi
  done
  printf '%-96s %9s ms\n' "$1" "$best"
}
JSONCART="o.metadata #> '{checkout,cartFingerprint}' = to_jsonb('%s'::text)"
best_of_three "S-guest  scope: hash IN (H1,H2) OR id IN (3 verified), same cart, ALL states, with attempts" \
  "SELECT o.*, (SELECT json_agg(a.*) FROM \"PaymentAttempt\" a WHERE a.\"orderId\" = o.id) FROM \"PrintOrder\" o WHERE o.\"userId\" IS NULL AND (o.\"guestSessionHash\" IN ('$H1','$H2') OR o.id IN ($IDS)) AND ($(printf "$JSONCART" "$CART2") OR $(printf "$JSONCART" "v1x")) ORDER BY o.\"createdAt\" DESC LIMIT 50"
best_of_three "S-guest  verifiedGuestOrderIds: id IN 5 ids, userId IS NULL" \
  "SELECT id, \"userId\", \"guestAccessTokenHash\", \"guestAccessExpiresAt\", \"guestSessionHash\" FROM \"PrintOrder\" WHERE id IN ($IDS) AND \"userId\" IS NULL"
best_of_three "S-acct   scope: userId = account, same cart, ALL states" \
  "SELECT o.* FROM \"PrintOrder\" o WHERE o.\"userId\" = '$USERID' AND ($(printf "$JSONCART" "$CART") OR $(printf "$JSONCART" "v1x")) ORDER BY o.\"createdAt\" DESC LIMIT 50"
best_of_three "Q3       attempts of terminal orders: PaymentAttempt by orderId, for up to 20 orders of the account" \
  "SELECT * FROM \"PaymentAttempt\" WHERE \"orderId\" IN (SELECT id FROM \"PrintOrder\" WHERE \"userId\" = '$USERID' LIMIT 20)"
best_of_three "Q3b      attempts of terminal orders: PaymentAttempt by orderId, ids already known (20)" \
  "SELECT * FROM \"PaymentAttempt\" WHERE \"orderId\" IN (SELECT id FROM \"PrintOrder\" WHERE \"guestSessionHash\" = '$H2' LIMIT 20)"
best_of_three "TODAY-1  account duplicate search (createPendingCardOrder)" \
  "SELECT o.* FROM \"PrintOrder\" o WHERE o.\"userId\" = '$USERID' AND o.status = 'awaiting_payment' AND o.\"paymentStatus\" = 'pending' AND o.\"paymentMethod\" = 'card' AND o.\"totalCents\" = 1500 AND o.\"createdAt\" > now() - interval '1 hour' AND o.metadata #> '{checkout,fingerprint}' = to_jsonb('x'::text) ORDER BY o.\"createdAt\" DESC LIMIT 1"
best_of_three "TODAY-2  guest duplicate search (hash OR ids)" \
  "SELECT o.* FROM \"PrintOrder\" o WHERE o.\"userId\" IS NULL AND o.status = 'awaiting_payment' AND o.\"paymentStatus\" = 'pending' AND o.\"paymentMethod\" = 'card' AND o.\"totalCents\" = 1500 AND o.\"createdAt\" > now() - interval '1 hour' AND o.metadata #> '{checkout,fingerprint}' = to_jsonb('x'::text) AND (o.\"guestSessionHash\" = '$H1' OR o.id IN ($IDS)) ORDER BY o.\"createdAt\" DESC LIMIT 1"
best_of_three "TODAY-3  findPurchaseInFlight for an account (in doubt)" \
  "SELECT o.* FROM \"PrintOrder\" o WHERE o.\"paymentMethod\" = 'card' AND o.\"userId\" = '$USERID' AND $(printf "$JSONCART" "$CART") AND (o.\"paymentStatus\" = 'processing' OR o.\"paymentReviewReason\" IS NOT NULL OR (o.status = 'awaiting_review' AND o.\"paymentStatus\" IN ('paid','free')) OR EXISTS (SELECT 1 FROM \"PaymentAttempt\" a WHERE a.\"orderId\" = o.id AND a.status IN ('processing','mismatch'))) ORDER BY o.\"createdAt\" DESC LIMIT 10"
echo "plan of S-acct (is there an index on \"userId\"?):"
$P -c "EXPLAIN SELECT o.* FROM \"PrintOrder\" o WHERE o.\"userId\" = '$USERID' AND $(printf "$JSONCART" "$CART")" | head -4
echo "indexes of PrintOrder: $($P -c "select string_agg(indexname, ', ' order by indexname) from pg_indexes where tablename = 'PrintOrder'")"
