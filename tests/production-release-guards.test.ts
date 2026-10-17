// Step 4.6, S4 - guards on the SOURCE of the application (no database, no network): they fail when a new place starts to change an order's production state, to use
// the old eligibility rule, to accept a request from another site, or to command a printer, without anybody having looked at it. They read the files; what the
// routes do when called is proved by tests/security/production-release*.sec.ts.
//   * every file that writes a PrintOrder is in the registry below, with the reason it may; a file that decides about production must go through the release lock;
//   * the old rule (`isProductionEligible`, `productionEligibleOrderWhere`) is used nowhere but where it is declared;
//   * every administrator route that changes an order, a printer, a machine or the stock refuses a request from another site; the callbacks that carry a secret
//     (PrintLab, Stripe, OrderWorks in) do NOT depend on the session or on the origin;
//   * the only code that commands a printer (pause / resume / stop) is the one administrator route made for it;
//   * no production code installs the test hooks of the release lock.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '.git'].includes(entry.name)) continue
      walk(full, into)
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) into.push(full.split(path.sep).join('/'))
  }
  return into
}
const SOURCE_DIRS = ['app', 'lib', 'scripts', 'components']
const sources = SOURCE_DIRS.flatMap((dir) => walk(dir))
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
// the code without its comments, so that a word in an explanation is not mistaken for a call
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. Who writes a PrintOrder
// ---------------------------------------------------------------------------------------------------------------------------------------------
const WRITES = /\bprintOrder\.(update|updateMany|upsert)\s*\(/
const RAW_WRITES = /(UPDATE|INSERT INTO|DELETE FROM)\s+"?PrintOrder"?/i
// what makes a file one that DECIDES about production: it must take the release lock (or the pure decision) before it writes
const GATE_MARKERS = ['withReleaseLock', 'releaseDecision', 'gateAutomaticStatus', 'runGuardedEffect']

type Kind = 'gate' | 'payment' | 'metadata' | 'accountable' | 'maintenance'
const REGISTRY: Record<string, { kind: Kind; why: string }> = {
  // ---- they decide about production or about material: the release lock first ----
  'app/api/admin/orders/[orderId]/status/route.ts': { kind: 'gate', why: 'moves an order through production' },
  'app/api/admin/orders/[orderId]/assign-printer/route.ts': { kind: 'gate', why: 'puts an order on a printer' },
  'app/api/admin/printers/auto-queue/route.ts': { kind: 'gate', why: 'puts the oldest queued order on every free printer' },
  'app/api/admin/orders/[orderId]/printlab-link/route.ts': { kind: 'gate', why: 'records a PrintLab job; moves the status only if released' },
  'app/api/printlab/jobs/[jobId]/route.ts': { kind: 'gate', why: 'PrintLab callback; records the signal, moves the status only if released' },
  'app/api/customer/organizations/[organizationId]/orders/[orderId]/approval/route.ts': { kind: 'gate', why: 'an approver answers a quote' },
  'app/api/admin/orders/[orderId]/external-effects/route.ts': { kind: 'gate', why: 'confirms an outside call by its record' },
  'lib/orderworks-sync.ts': { kind: 'gate', why: 'fulfilment sync from OrderWorks' },
  'lib/printlab-order-submit.ts': { kind: 'gate', why: 'sends the jobs of an order to PrintLab' },
  'lib/stockworks-consumption.ts': { kind: 'gate', why: 'takes the material of an order out of stock' },
  'lib/production-release.ts': { kind: 'gate', why: 'the release lock itself' },
  // ---- the only writers of payment facts ----
  'lib/payment-sync.ts': { kind: 'payment', why: 'verifies a payment with Stripe and records the result' },
  'lib/payment-hold.ts': { kind: 'payment', why: 'a person resolves a payment under review' },
  'lib/checkout-orders.ts': { kind: 'payment', why: 'creates the pending order and its payment attempt' },
  'app/api/admin/orders/[orderId]/stripe-attach/route.ts': { kind: 'payment', why: 'links a PaymentIntent that names this order (verified by payment-sync)' },
  // ---- metadata only, under the row lock ----
  'lib/order-metadata.ts': { kind: 'metadata', why: 'merges into the metadata of an order under a row lock' },
  // ---- administrator work that is accountable (reason, audit) and refuses orders with payment or production evidence ----
  'app/api/admin/orders/[orderId]/route.ts': { kind: 'accountable', why: 'deletes an order; refused after payment or production' },
  'app/api/admin/orders/[orderId]/items/[itemId]/route.ts': { kind: 'accountable', why: 'changes a quantity; refused after payment' },
  'app/api/admin/orderworks/jobs/[id]/route.ts': { kind: 'accountable', why: 'deletes a job and its orders; refused after payment or production' },
  // ---- maintenance ----
  'lib/privacy.ts': { kind: 'maintenance', why: 'erases a deleted account\'s personal data (reported in docs/RILASCIO-PRODUZIONE.md: it also clears the order metadata)' },
  'scripts/hold-unpaid-orders.js': { kind: 'maintenance', why: 'only moves unpaid orders OUT of production (dry run by default)' },
  'lib/data-retention.ts': { kind: 'maintenance', why: 'step 4.6 S5: empties ONLY the guest-session hash column of old orders whose payment is not in doubt (one raw statement; status, payment facts, metadata and updatedAt are not touched)' },
}

test('G1 every file that writes a PrintOrder is in the registry', () => {
  const writers = sources.filter((file) => WRITES.test(code(file)) || RAW_WRITES.test(code(file)))
  const unknown = writers.filter((file) => !REGISTRY[file])
  assert.deepEqual(unknown, [], `these files write a PrintOrder but nobody classified them: add them to the registry with the reason (and, if they decide about production, take the release lock): ${unknown.join(', ')}`)
  const stale = Object.keys(REGISTRY).filter((file) => !writers.includes(file))
  assert.deepEqual(stale, [], `the registry lists files that no longer write a PrintOrder: ${stale.join(', ')}`)
})

test('G2 a file that decides about production takes the release lock before it writes', () => {
  for (const [file, entry] of Object.entries(REGISTRY)) {
    if (entry.kind !== 'gate') continue
    assert.ok(GATE_MARKERS.some((marker) => code(file).includes(marker)), `${file} decides about production but does not use ${GATE_MARKERS.join(' / ')}`)
  }
})

test('G3 the files that decide, and the one that merges metadata, write only through the transaction of the lock', () => {
  for (const [file, entry] of Object.entries(REGISTRY)) {
    if (entry.kind !== 'gate' && entry.kind !== 'metadata') continue
    const bare = code(file).match(/(?<![\w.])prisma\.printOrder\.(update|updateMany|upsert)\s*\(/g) ?? []
    assert.deepEqual(bare, [], `${file} writes a PrintOrder outside a transaction (prisma.printOrder.*): that is a write without the row lock`)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. The old rule
// ---------------------------------------------------------------------------------------------------------------------------------------------
const OLD_RULE_USERS = new Set([
  'lib/order-payment-policy.ts', // where it is declared
  'lib/reprint.ts', // may a CUSTOMER ask for a reprint of an order that was paid? (not an action on production; listed as a known limit)
])
test('G4 the old eligibility rule is not used to decide anything about production', () => {
  const users = sources.filter((file) => /\b(isProductionEligible|productionEligibleOrderWhere)\b/.test(code(file)))
  const unexpected = users.filter((file) => !OLD_RULE_USERS.has(file))
  assert.deepEqual(unexpected, [], `these files use the old rule (it ignores payments under review, being confirmed and still open): ${unexpected.join(', ')} - use releaseDecision`)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. Requests from another site
// ---------------------------------------------------------------------------------------------------------------------------------------------
// The routes that change an order, production, a printer, a machine, a price waiver or the stock. (The other administrator routes - users, site settings, backup,
// catalogue... - are NOT in this list: the origin check was not extended to them in S4, which is declared in docs/RILASCIO-PRODUZIONE.md.)
const CSRF_SCOPE = [
  /^app\/api\/admin\/orders\//,
  /^app\/api\/admin\/printers\//,
  /^app\/api\/admin\/printer-machines\//,
  /^app\/api\/admin\/bambu-view\//,
  /^app\/api\/admin\/orderworks\//,
  /^app\/api\/admin\/price-waivers\//,
  /^app\/api\/stockworks\/movements\//,
  /^app\/api\/jobs\//,
  /^app\/api\/customer\/organizations\/\[organizationId\]\/orders\//,
]
const MUTATING = /export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/g
test('G5 every route that changes an order, production, a printer, a machine or the stock refuses a request from another site', () => {
  const routes = sources.filter((file) => file.endsWith('/route.ts') && CSRF_SCOPE.some((pattern) => pattern.test(file)))
  assert.ok(routes.length >= 20, `the scan found only ${routes.length} routes: the scope patterns are wrong`)
  const missing: string[] = []
  let mutating = 0
  for (const file of routes) {
    const text = code(file)
    const handlers = [...text.matchAll(MUTATING)].map((match) => match[1])
    if (handlers.length === 0) continue
    mutating += handlers.length
    // one check per handler, and a check that ACTS: the answer of the helper is returned (a call whose result is dropped refuses nothing)
    const acting = [
      ...(text.match(/const\s+(\w+)\s*=\s*rejectCrossOrigin\([^)]*\)\s*\n\s*if\s*\(\s*\1\s*\)\s*return\b/g) ?? []),
      ...(text.match(/if\s*\(\s*(?:write\s*&&\s*)?!\s*isSameOriginRequest\(/g) ?? []),
    ].length
    if (acting === 0 || acting < handlers.length) missing.push(`${file} (${handlers.join(', ')}; ${acting} origin check${acting === 1 ? '' : 's'} that refuse)`)
  }
  assert.ok(mutating >= 25, `the scan found only ${mutating} mutating handlers`)
  assert.deepEqual(missing, [], `these routes change something but do not refuse a request from another site: ${missing.join('; ')}`)
})

// The callbacks that carry a secret or a signature are not browser requests: no session, no origin.
const CALLBACKS: Record<string, { secret: RegExp }> = {
  'app/api/printlab/jobs/[jobId]/route.ts': { secret: /PRINTLAB_WEBHOOK_SECRET|PRINTLAB_CALLBACK_SECRET|PRINTLAB_API_KEY|Bearer/ },
  'app/api/stripe/webhook/route.ts': { secret: /constructEvent|stripe-signature|STRIPE_WEBHOOK_SECRET/ },
  'app/api/makerworks/jobs/route.ts': { secret: /MAKERWORKS_INBOUND_SECRET|ORDERWORKS_INBOUND_SECRET|Bearer|secret/i },
}
test('G6 the callbacks that carry a secret or a signature do not depend on a session or on the origin of a browser', () => {
  for (const [file, expectation] of Object.entries(CALLBACKS)) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} does not exist`)
    const text = code(file)
    assert.match(text, expectation.secret, `${file} no longer checks its secret / signature`)
    for (const forbidden of ['viewerGuards', 'requireAdmin', 'requireRole', 'rejectCrossOrigin', 'isSameOriginRequest', 'cookies(']) {
      assert.ok(!text.includes(forbidden), `${file} is a callback (secret / signature) but uses ${forbidden}: a server-to-server call has no session and no origin`)
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. Nothing here commands a printer
// ---------------------------------------------------------------------------------------------------------------------------------------------
test('G7 the only code that pauses, resumes or stops a printer is the administrator route made for it', () => {
  const users = sources.filter((file) => /\bsendPrintLabJobAction\b/.test(code(file)))
  // the definition, the old "Bambu View" name for it (nothing calls that one), and the route
  assert.deepEqual(users.sort(), ['app/api/admin/bambu-view/job/route.ts', 'lib/bambu-view.ts', 'lib/printlab.ts'], 'something else commands a printer')
  const alias = sources.filter((file) => /\bsendBambuJobAction\b/.test(code(file)))
  assert.deepEqual(alias, ['lib/bambu-view.ts'], 'something calls the old printer-command alias')
  // and that route asks for the origin (it reaches a real printer)
  assert.match(code('app/api/admin/bambu-view/job/route.ts'), /rejectCrossOrigin\(/)
})

test('G8 the release code never commands a printer and never sends a DELETE / PUT / PATCH to an outside service', () => {
  for (const file of ['lib/production-release.ts', 'lib/external-effects.ts', 'lib/printlab-order-submit.ts', 'lib/stockworks-consumption.ts', 'lib/orderworks-sync.ts', 'app/api/admin/orders/[orderId]/external-effects/route.ts']) {
    const text = code(file)
    assert.ok(!/\bsendPrintLabJobAction\b/.test(text), `${file} can command a printer`)
    assert.ok(!/method:\s*['"](DELETE|PUT|PATCH)['"]/i.test(text), `${file} sends a DELETE / PUT / PATCH to an outside service`)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5. Test hooks stay in the tests
// ---------------------------------------------------------------------------------------------------------------------------------------------
test('G9 no production code installs the test hooks of the release lock', () => {
  const installers = sources.filter((file) => file !== 'lib/production-release.ts' && /\breleaseHooks\.\w+\s*=[^=]/.test(code(file)))
  assert.deepEqual(installers, [], `these files install a release hook: ${installers.join(', ')}`)
  const own = code('lib/production-release.ts')
  assert.ok(!/\breleaseHooks\.\w+\s*=[^=]/.test(own), 'the release lock installs its own hooks')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 6. The fixtures and the registry agree with the files that exist
// ---------------------------------------------------------------------------------------------------------------------------------------------
test('G10 every registered file exists', () => {
  for (const file of [...Object.keys(REGISTRY), ...Object.keys(CALLBACKS), ...OLD_RULE_USERS]) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} does not exist (renamed? update the registry)`)
  assert.ok(rel(path.join(ROOT, 'lib/order-payment-policy.ts')) === 'lib/order-payment-policy.ts')
})
