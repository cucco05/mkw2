#!/usr/bin/env python3
# R1-3 / KLOSS A-idx - the owner guard's reading of an owner's orders (readSiblings, lib/checkout-owner-guard.ts) BEFORE and AFTER the index on "PrintOrder" ("userId", "createdAt" DESC),
# measured with EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on a THROW-AWAY database of the isolated local test cluster filled with synthetic rows (the data of tests/red/kloss/explain.sh).
#   * the statements are the production ones, built by the production function (tests/red/kloss/tools/explain-relevance.ts prints them with their values written in);
#   * every scenario is run RUNS times (default 7) in each phase: the planning time, the execution time, the JIT compilation, the shared buffers hit and read, the indexes the plan used, the rows;
#   * scenarios: an ordinary account and an INTENSIVE one (1000 orders of the same cart), a guest and an intensive guest - each with relevant orders and without;
#   * the cost of the index: its build (CREATE INDEX CONCURRENTLY, as the migration), its size, and the writes - a bulk insert, single-row inserts, single-row updates - before and after;
#   * the two variants with "id" in the index (as the column is, and COLLATE "C" DESC, the order of the query), measured the same way: does "id" change the plan?
# It reads and writes nothing of the repository; it creates ONE database (kloss_idx_<N>_sectest, from the migrated test database) and drops it at the end; it refuses any host but this machine.
# usage: python3 tests/red/kloss/explain-index.py <orders> [results.json]       (PGHOST/PGPORT/PGUSER/TEMPLATE_DB/RUNS may be set)
# Not a test (no test pattern matches it). The numbers of the last run are in tests/red/kloss/RED-LEDGER.md.
import json, os, re, statistics, subprocess, sys, time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 100000
OUT = sys.argv[2] if len(sys.argv) > 2 else None
RUNS = int(os.environ.get('RUNS', '7'))
HOST, PORT, USER = os.environ.get('PGHOST', '127.0.0.1'), os.environ.get('PGPORT', '55432'), os.environ.get('PGUSER', 'postgres')
TEMPLATE = os.environ.get('TEMPLATE_DB', 'mkw_dr13_sectest')
if HOST not in ('127.0.0.1', 'localhost'):
    sys.exit(f'refused: not the local isolated cluster ({HOST})')
DB = f'kloss_idx_{N}_sectest'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
INDEX = 'PrintOrder_userId_createdAt_idx'
INDEX_SQL = f'CREATE INDEX CONCURRENTLY "{INDEX}" ON "PrintOrder" ("userId", "createdAt" DESC)'
VARIANTS = {
    'id': 'CREATE INDEX CONCURRENTLY "PrintOrder_userId_createdAt_id_idx" ON "PrintOrder" ("userId", "createdAt" DESC, "id")',
    'idC': 'CREATE INDEX CONCURRENTLY "PrintOrder_userId_createdAt_idC_idx" ON "PrintOrder" ("userId", "createdAt" DESC, "id" COLLATE "C" DESC)',
}


def psql(sql: str, db: str = DB, quiet_notices: bool = True) -> subprocess.CompletedProcess:
    # ONE statement per call where it matters (CREATE INDEX CONCURRENTLY refuses a multi-statement string)
    return subprocess.run(['psql', '-h', HOST, '-p', PORT, '-U', USER, '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], capture_output=True, text=True, check=True)


def value(sql: str) -> str:
    return psql(sql).stdout.strip()


def fill():
    psql(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)', 'postgres')
    psql(f'CREATE DATABASE "{DB}" TEMPLATE "{TEMPLATE}"', 'postgres')
    # (the test database may already carry the index of the migration: the "before" is the schema without it)
    psql(f'DROP INDEX IF EXISTS "{INDEX}"')
    psql('ALTER TABLE "PrintOrder" DISABLE TRIGGER ALL')
    psql('ALTER TABLE "PaymentAttempt" DISABLE TRIGGER ALL')
    # the rows of tests/red/kloss/explain.sh: 20% of the orders belong to accounts, 80% to guests; 4000 carts; a quarter paid, a few awaiting payment, the rest cancelled; two attempts each
    psql(f'''INSERT INTO "PrintOrder" (id, status, "paymentStatus", "paymentMethod", "shippingMethod", "subtotalCents", "totalCents", currency, "updatedAt", "createdAt", "userId", "guestSessionHash", metadata, "paidAt")
SELECT 'o' || lpad(g::text, 10, '0'),
       CASE WHEN g % 4 = 0 THEN 'queued' WHEN g % 50 = 1 THEN 'awaiting_payment' ELSE 'cancelled' END,
       CASE WHEN g % 4 = 0 THEN 'paid' WHEN g % 50 = 1 THEN 'pending' ELSE 'canceled' END,
       'card', 'pickup', 1000 + (g % 90) * 100, 1000 + (g % 90) * 100, 'EUR', now(), timestamp '2026-01-01' + (g || ' seconds')::interval,
       CASE WHEN g % 5 = 0 THEN 'u' || lpad(((g / 5) % ({N} / 25))::text, 8, '0') ELSE NULL END,
       CASE WHEN g % 5 <> 0 THEN md5('session' || ((g * 2) / 3)::text) || md5('s2' || ((g * 2) / 3)::text) ELSE NULL END,
       jsonb_build_object('source', 'stripe_checkout', 'checkout', jsonb_build_object('version', 1, 'cartFingerprint', md5('cart' || (g % 4000)::text), 'fingerprint', md5('fp' || (g % 4000)::text))),
       CASE WHEN g % 4 = 0 THEN timestamp '2026-01-01' + (g || ' seconds')::interval ELSE NULL END
FROM generate_series(1, {N}) g''')
    psql(f'''INSERT INTO "PaymentAttempt" (id, "orderId", "stripeSessionId", "amountCents", currency, status, "expiresAt", "updatedAt", "createdAt", "failureReason", "stripePaymentIntentId")
SELECT 'a' || lpad(g::text, 10, '0') || k::text, 'o' || lpad(g::text, 10, '0'), 'cs_test_' || md5(g::text || k::text), 1000, 'EUR',
       CASE WHEN g % 4 = 0 AND k = 1 THEN 'paid' WHEN g % 50 = 1 AND k = 1 THEN 'open' ELSE 'expired' END, now(), now(), timestamp '2026-01-01' + (g || ' seconds')::interval,
       CASE WHEN g % 4 = 0 AND k = 1 THEN NULL WHEN g % 50 = 1 AND k = 1 THEN NULL WHEN g % 3 = 0 THEN 'closed_by_us:x' ELSE 'provider_status:expired' END,
       CASE WHEN g % 4 = 0 AND k = 1 THEN 'pi_' || md5(g::text) ELSE NULL END
FROM generate_series(1, {N}) g, generate_series(1, 2) k''')
    # the intensive owners: an account and a browser session with 1000 orders of ONE cart - one of each with 5 relevant orders (unpaid, 5 minutes old), one of each with none
    for who, owner_sql, cart, relevant in [('ur', "'uintensive'", 'cartintensive', 5), ('u0', "'uintensive0'", 'cartintensive0', 0),
                                            ('gr', "NULL", 'cartintensiveg', 5), ('g0', "NULL", 'cartintensiveg0', 0)]:
        hash_sql = "NULL" if who.startswith('u') else ("'" + ('e' if who == 'gr' else 'f') * 64 + "'")
        psql(f'''INSERT INTO "PrintOrder" (id, status, "paymentStatus", "paymentMethod", "shippingMethod", "subtotalCents", "totalCents", currency, "updatedAt", "createdAt", "userId", "guestSessionHash", metadata, "paidAt", "stripePaymentIntentId")
SELECT 'heavy{who}' || lpad(g::text, 5, '0'),
       CASE WHEN g <= {relevant} THEN 'awaiting_payment' WHEN g % 2 = 0 THEN 'completed' ELSE 'cancelled' END,
       CASE WHEN g <= {relevant} THEN 'pending' WHEN g % 2 = 0 THEN 'paid' ELSE 'canceled' END,
       'card', 'pickup', 1500, 1500, 'EUR', now(), CASE WHEN g <= {relevant} THEN now() - interval '5 minutes' ELSE timestamp '2026-01-01' + (g || ' minutes')::interval END,
       {owner_sql}, {hash_sql},
       jsonb_build_object('source', 'stripe_checkout', 'checkout', jsonb_build_object('version', 1, 'cartFingerprint', '{cart}', 'fingerprint', 'fp{cart}')),
       CASE WHEN g > {relevant} AND g % 2 = 0 THEN timestamp '2026-01-01' + (g || ' minutes')::interval ELSE NULL END,
       CASE WHEN g > {relevant} AND g % 2 = 0 THEN 'pi_heavy_{who}' || g ELSE NULL END
FROM generate_series(1, 1000) g''')
        psql(f'''INSERT INTO "PaymentAttempt" (id, "orderId", "stripeSessionId", "amountCents", currency, status, "expiresAt", "updatedAt", "createdAt", "failureReason", "stripePaymentIntentId", "completedAt")
SELECT 'heavya{who}' || lpad(g::text, 5, '0'), 'heavy{who}' || lpad(g::text, 5, '0'), 'cs_test_heavy_{who}' || g, 1500, 'EUR',
       CASE WHEN g % 2 = 0 THEN 'paid' ELSE 'expired' END, now(), now(), timestamp '2026-01-01' + (g || ' minutes')::interval,
       CASE WHEN g % 2 = 0 THEN NULL ELSE 'closed_by_us:x' END, CASE WHEN g % 2 = 0 THEN 'pi_heavy_{who}' || g ELSE NULL END,
       CASE WHEN g % 2 = 0 THEN timestamp '2026-01-01' + (g || ' minutes')::interval ELSE NULL END
FROM generate_series({relevant} + 1, 1000) g''')
    psql('VACUUM ANALYZE "PrintOrder"')
    psql('VACUUM ANALYZE "PaymentAttempt"')


def relevance_query(kind: str, who: str, carts: str, ids: str = '') -> str:
    args = ['npx', 'tsx', 'tests/red/kloss/tools/explain-relevance.ts', kind, who, carts] + ([ids] if ids else [])
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def in_flight_query(user_id: str, cart: str) -> str:
    # findPurchaseInFlight (lib/checkout-orders.ts) for an account - unchanged, measured only: the statement as Prisma writes it (tests/red/kloss/tools/explain-in-flight.ts)
    env = {**os.environ, 'DATABASE_URL': f'postgresql://{USER}@{HOST}:{PORT}/{DB}'}
    return subprocess.run(['npx', 'tsx', 'tests/red/kloss/tools/explain-in-flight.ts', user_id, cart, 'v1x'], cwd=ROOT, env=env, capture_output=True, text=True, check=True).stdout.strip()


def scenarios() -> dict:
    # an ordinary account WITHOUT a relevant order of its cart, and another one WITH three (unpaid 5 minutes ago, an open page, a payment verified 10 minutes ago)
    pairs = psql('''SELECT o."userId", o.metadata->'checkout'->>'cartFingerprint' FROM "PrintOrder" o WHERE o."userId" LIKE 'u0%' AND o.status = 'cancelled'
                    AND NOT EXISTS (SELECT 1 FROM "PrintOrder" p WHERE p."userId" = o."userId" AND p.status = 'awaiting_payment') ORDER BY o.id LIMIT 2 OFFSET 100''').stdout.strip().splitlines()
    (u_none, c_none), (u_rel, c_rel) = [line.split('|') for line in pairs]
    psql(f'''INSERT INTO "PrintOrder" (id, status, "paymentStatus", "paymentMethod", "shippingMethod", "subtotalCents", "totalCents", currency, "updatedAt", "createdAt", "userId", metadata, "paidAt", "stripePaymentIntentId")
VALUES ('relA1', 'awaiting_payment', 'pending', 'card', 'pickup', 1500, 1500, 'EUR', now(), now() - interval '5 minutes', '{u_rel}', jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', '{c_rel}')), NULL, NULL),
       ('relA2', 'awaiting_payment', 'pending', 'card', 'pickup', 1600, 1600, 'EUR', now(), now() - interval '3 hours', '{u_rel}', jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', '{c_rel}')), NULL, NULL),
       ('relA3', 'queued', 'paid', 'card', 'pickup', 1500, 1500, 'EUR', now(), now() - interval '20 minutes', '{u_rel}', jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', '{c_rel}')), now() - interval '10 minutes', 'pi_relA3')''')
    psql('''INSERT INTO "PaymentAttempt" (id, "orderId", "stripeSessionId", "amountCents", currency, status, "expiresAt", "updatedAt", "createdAt", "stripePaymentIntentId", "completedAt")
VALUES ('relA2a', 'relA2', 'cs_test_relA2', 1600, 'EUR', 'open', now() + interval '20 minutes', now(), now() - interval '3 hours', NULL, NULL),
       ('relA3a', 'relA3', 'cs_test_relA3', 1500, 'EUR', 'paid', now(), now(), now() - interval '20 minutes', 'pi_relA3', now() - interval '10 minutes')''')
    # a guest (a session hash and the ids its cookie opens) without a relevant order of its cart, and one with two
    g_rows = psql('''SELECT "guestSessionHash", metadata->'checkout'->>'cartFingerprint', id FROM "PrintOrder" WHERE "guestSessionHash" IS NOT NULL AND id LIKE 'o%' AND status = 'cancelled' ORDER BY id LIMIT 2 OFFSET 200''').stdout.strip().splitlines()
    (h_none, gc_none, gid_none), (h_rel, gc_rel, gid_rel) = [line.split('|') for line in g_rows]
    psql(f'''INSERT INTO "PrintOrder" (id, status, "paymentStatus", "paymentMethod", "shippingMethod", "subtotalCents", "totalCents", currency, "updatedAt", "createdAt", "guestSessionHash", metadata)
VALUES ('relG1', 'awaiting_payment', 'pending', 'card', 'pickup', 1500, 1500, 'EUR', now(), now() - interval '5 minutes', '{h_rel}', jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', '{gc_rel}'))),
       ('relG2', 'awaiting_payment', 'processing', 'card', 'pickup', 1500, 1500, 'EUR', now(), now() - interval '2 hours', '{h_rel}', jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', '{gc_rel}')))''')
    psql('ANALYZE "PrintOrder"')
    psql('ANALYZE "PaymentAttempt"')
    return {
        'account, none relevant': relevance_query('account', u_none, f'{c_none},v1x'),
        'account, 3 relevant': relevance_query('account', u_rel, f'{c_rel},v1x'),
        'account intensive (1000 orders), 5 relevant': relevance_query('account', 'uintensive', 'cartintensive,v1x'),
        'account intensive (1000 orders), none relevant': relevance_query('account', 'uintensive0', 'cartintensive0,v1x'),
        'guest, none relevant': relevance_query('guest', h_none, f'{gc_none},v1x', gid_none),
        'guest, 2 relevant': relevance_query('guest', h_rel, f'{gc_rel},v1x', gid_rel),
        'guest intensive (1000 orders), 5 relevant': relevance_query('guest', 'e' * 64, 'cartintensiveg,v1x'),
        'guest intensive (1000 orders), none relevant': relevance_query('guest', 'f' * 64, 'cartintensiveg0,v1x'),
        'TODAY findPurchaseInFlight, account (unchanged)': in_flight_query(u_none, c_none),
        'TODAY findPurchaseInFlight, account intensive (unchanged)': in_flight_query('uintensive', 'cartintensive'),
    }


def walk(node: dict, out: dict):
    out['nodes'].add(node.get('Node Type'))
    if 'Index Name' in node: out['indexes'].add(node['Index Name'])
    for child in node.get('Plans', []): walk(child, out)


def explain(sql: str) -> dict:
    data = json.loads(psql(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}').stdout)[0]
    plan = data['Plan']
    seen = {'nodes': set(), 'indexes': set()}
    walk(plan, seen)
    jit = data.get('JIT')
    return {
        'planning_ms': data.get('Planning Time'), 'execution_ms': data.get('Execution Time'),
        'jit_ms': (jit or {}).get('Timing', {}).get('Total') if jit else 0.0, 'jit_functions': (jit or {}).get('Functions', 0) if jit else 0,
        'hit': plan.get('Shared Hit Blocks', 0), 'read': plan.get('Shared Read Blocks', 0), 'rows': plan.get('Actual Rows'),
        'nodes': sorted(n for n in seen['nodes'] if n), 'indexes': sorted(seen['indexes']),
    }


def measure(queries: dict) -> dict:
    out = {}
    for name, sql in queries.items():
        runs = [explain(sql) for _ in range(RUNS)]
        ex = [r['execution_ms'] for r in runs]
        pl = [r['planning_ms'] for r in runs]
        out[name] = {
            'execution_ms': {'min': min(ex), 'median': statistics.median(ex), 'max': max(ex)}, 'planning_ms': {'min': min(pl), 'median': statistics.median(pl), 'max': max(pl)},
            'jit_ms_max': max(r['jit_ms'] for r in runs), 'first_run_buffers': {'hit': runs[0]['hit'], 'read': runs[0]['read']}, 'steady_buffers': {'hit': runs[-1]['hit'], 'read': runs[-1]['read']},
            'rows': runs[-1]['rows'], 'nodes': runs[-1]['nodes'], 'indexes': runs[-1]['indexes'],
        }
    return out


def ms_of_do(body: str) -> float:
    # a DO block that measures itself (clock_timestamp) and says how long it took in a NOTICE
    r = subprocess.run(['psql', '-h', HOST, '-p', PORT, '-U', USER, '-d', DB, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
                        f"DO $$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN {body} RAISE NOTICE 'elapsed_ms=%', round((extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric, 1); END $$"],
                       capture_output=True, text=True, check=True)
    return float(re.search(r'elapsed_ms=([0-9.]+)', r.stderr).group(1))


def writes(tag: str) -> dict:
    # (rows of an account, shaped as the checkout writes them; deleted afterwards so that the next phase reads the same table)
    common = "'card', 'pickup', 1500, 1500, 'EUR', now(), clock_timestamp(), 'uw' || (i % 500), jsonb_build_object('checkout', jsonb_build_object('cartFingerprint', md5('w' || (i % 50)::text)))"
    cols = '(id, status, "paymentStatus", "paymentMethod", "shippingMethod", "subtotalCents", "totalCents", currency, "updatedAt", "createdAt", "userId", metadata)'
    bulk = ms_of_do(f"INSERT INTO \"PrintOrder\" {cols} SELECT 'wb{tag}' || i, 'awaiting_payment', 'pending', {common} FROM generate_series(1, 20000) i;")
    single = ms_of_do(f"FOR i IN 1..2000 LOOP INSERT INTO \"PrintOrder\" {cols} VALUES ('ws{tag}' || i, 'awaiting_payment', 'pending', {common}); END LOOP;")
    update = ms_of_do(f"FOR i IN 1..2000 LOOP UPDATE \"PrintOrder\" SET notes = 'x' || i WHERE id = 'ws{tag}' || i; END LOOP;")
    psql(f"DELETE FROM \"PrintOrder\" WHERE id LIKE 'wb{tag}%' OR id LIKE 'ws{tag}%'")
    psql('VACUUM ANALYZE "PrintOrder"')
    return {'bulk_insert_20000_ms': bulk, 'single_insert_2000_ms': single, 'single_update_2000_ms': update}


def main():
    t = time.time()
    fill()
    results = {'orders': int(value('SELECT count(*) FROM "PrintOrder"')), 'attempts': int(value('SELECT count(*) FROM "PaymentAttempt"')),
               'table_bytes': int(value('''SELECT pg_relation_size('"PrintOrder"')''')), 'settings': {name: value(f'SHOW {name}') for name in ['jit', 'max_parallel_workers_per_gather', 'shared_buffers', 'work_mem', 'random_page_cost']},
               'runs': RUNS}
    queries = scenarios()
    # WRITES_ONLY=1: only the cost of the writes, each measure repeated WRITE_REPEATS times (the queries are measured by the normal run)
    writes_only = os.environ.get('WRITES_ONLY') == '1'
    repeats = int(os.environ.get('WRITE_REPEATS', '1'))
    if writes_only: queries = {}
    results['before'] = measure(queries)
    results['writes_before'] = [writes(f'b{i}') for i in range(repeats)] if repeats > 1 else writes('b')
    t0 = time.time(); psql(INDEX_SQL); results['index_build_concurrently_ms'] = round((time.time() - t0) * 1000, 1)
    psql('ANALYZE "PrintOrder"')
    results['index_valid'] = value(f'''SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '{INDEX}' ''')
    results['index_bytes'] = int(value(f'''SELECT pg_relation_size('"{INDEX}"')'''))
    results['after'] = measure(queries)
    results['writes_after'] = [writes(f'a{i}') for i in range(repeats)] if repeats > 1 else writes('a')
    if writes_only:
        if OUT: json.dump(results, open(OUT, 'w'), indent=1)
        for phase in ['writes_before', 'writes_after']:
            runs = results[phase] if isinstance(results[phase], list) else [results[phase]]
            print(phase, {key: f"{min(r[key] for r in runs):.1f}/{statistics.median(r[key] for r in runs):.1f}/{max(r[key] for r in runs):.1f}" for key in runs[0]})
        return
    # the variants with "id": built beside, the two-column index taken away while they are measured, then put back
    psql(f'DROP INDEX CONCURRENTLY "{INDEX}"')
    for key, sql in VARIANTS.items():
        psql(sql)
        psql('ANALYZE "PrintOrder"')
        name = re.search(r'"(PrintOrder_[A-Za-z_]+)"', sql).group(1)
        results[f'variant_{key}'] = {'bytes': int(value(f'''SELECT pg_relation_size('"{name}"')''')), 'measures': measure(queries)}
        psql(f'DROP INDEX CONCURRENTLY "{name}"')
    results['seconds'] = round(time.time() - t, 1)
    if OUT: json.dump(results, open(OUT, 'w'), indent=1)
    # the table a person reads
    print(f"orders {results['orders']}, attempts {results['attempts']}, table {results['table_bytes'] // (1024 * 1024)} MB, runs per scenario {RUNS}, settings {results['settings']}")
    print(f"index: built CONCURRENTLY in {results['index_build_concurrently_ms']} ms, valid {results['index_valid']}, {results['index_bytes'] // 1024} kB")
    print(f"{'scenario':56} | {'before: exec ms min/med/max':28} | plan ms | JIT ms | buffers | {'after: exec ms min/med/max':28} | plan ms | JIT ms | buffers | index used")
    for name in queries:
        b, a = results['before'][name], results['after'][name]
        fmt = lambda m: f"{m['execution_ms']['min']:.2f}/{m['execution_ms']['median']:.2f}/{m['execution_ms']['max']:.2f}"
        buf = lambda m: f"{m['steady_buffers']['hit']}h+{m['first_run_buffers']['read']}r"
        print(f"{name:56} | {fmt(b):28} | {b['planning_ms']['median']:.2f} | {b['jit_ms_max']:.1f} | {buf(b)} | {fmt(a):28} | {a['planning_ms']['median']:.2f} | {a['jit_ms_max']:.1f} | {buf(a)} | {','.join(a['indexes'])} rows={a['rows']}")
    for key in VARIANTS:
        v = results[f'variant_{key}']
        print(f"variant {key}: {v['bytes'] // 1024} kB; " + '; '.join(f"{name.split(',')[0][:18]}… med {m['execution_ms']['median']:.2f} ms ({','.join(m['indexes'])})" for name, m in list(v['measures'].items())[:4]))
    print(f"writes before: {results['writes_before']}")
    print(f"writes after:  {results['writes_after']}")
    print(f"seconds {results['seconds']}")


try:
    main()
except subprocess.CalledProcessError as error:
    sys.exit(f'failed: {error.cmd[-1][:300]}\n{error.stderr}')
finally:
    subprocess.run(['psql', '-h', HOST, '-p', PORT, '-U', USER, '-d', 'postgres', '-X', '-q', '-c', f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'], capture_output=True)
