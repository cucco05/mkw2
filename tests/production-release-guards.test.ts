// Step 4.6, S4 - guards on the SOURCE of the application (no database, no network): they fail when a new place starts to change an order's production state, to use
// the old eligibility rule, to accept a request from another site, or to command a printer, without anybody having looked at it. They read the files; what the
// routes do when called is proved by tests/security/production-release*.sec.ts.
//   * every file that writes a PrintOrder is in the registry below, with the reason it may; a file that decides about production must go through the release lock;
//   * the old rule (`isProductionEligible`, `productionEligibleOrderWhere`) is used nowhere but where it is declared;
//   * every administrator route that changes an order, a printer, a machine or the stock refuses a request from another site; the callbacks that carry a secret
//     (PrintLab, Stripe, OrderWorks in) do NOT depend on the session or on the origin;
//   * the only code that commands a printer (pause / resume / stop) is the one administrator route made for it;
//   * no production code installs the test hooks of the release lock;
//   * (step 4.6, S6) every write that can change a financial fact of an order raises its financial revision in the same statement (G11), every place that CREATES an order is
//     known and starts it unpaid (G1-create), and the literal "paid" is written as a payment status only where a payment was verified or attested (G12);
//   * (step 4.6, S6, P4-0) the old shortcut that let an administrator decide "no charge" on his own word when Stripe could not be asked has no name left in app/, lib/ or components/ (G13).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { FINANCIAL_COLUMNS } from '../lib/financial-revision'
import { callSites, objectShape, propertyOf, stripComments } from './_source-scan'

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
  'lib/checkout-sessions.ts': { kind: 'payment', why: 'the payment page: when a page turns out to be complete at Stripe its attempt becomes "processing" and the financial revision goes up (markPageCompleteAtProvider)' },
  'lib/orders.ts': { kind: 'payment', why: 'makes orders from a job form or the old checkout; and records a payment received outside Stripe on an order that exists (recordAttestedReceipt: under the release lock, one transaction with its audit event)' },
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
  for (const file of [...Object.keys(REGISTRY), ...Object.keys(CALLBACKS), ...OLD_RULE_USERS, ...Object.keys(NOT_FINANCIAL), ...Object.keys(NOT_FINANCIAL_RAW), ...Object.keys(ATTEMPT_WRITERS), ...Object.keys(CREATORS), ...Object.keys(PAID_WRITERS), ...REFUND_OPERATION_WRITERS]) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} does not exist (renamed? update the registry)`)
  assert.ok(rel(path.join(ROOT, 'lib/order-payment-policy.ts')) === 'lib/order-payment-policy.ts')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 7. The financial revision (step 4.6, S6, P2b)
// ---------------------------------------------------------------------------------------------------------------------------------------------
// An administrator's authorization to produce is valid only while the order has the financial revision it had when it was given. The revision goes up in the SAME statement
// that changes a financial fact (lib/financial-revision.ts: E1-E14), through `withFinancialRevision`. A writer that forgot it would leave an old authorization alive after the
// money moved, so the places that write an order are not trusted by habit: each one either wraps its data, or is on the list below with the keys it can write and the reason that
// none of them is a financial fact.
const stripped = new Map<string, string>()
const plain = (file: string) => {
  if (!stripped.has(file)) stripped.set(file, stripComments(read(file)))
  return stripped.get(file) as string
}
const ORDER_WRITE_OPENING = /\bprintOrder\.(update|updateMany|upsert)\s*\(/g
type NotFinancial = { keys: readonly string[]; why: string; values?: Record<string, RegExp> }
const NOT_FINANCIAL: Record<string, NotFinancial[]> = {
  'app/api/admin/orders/[orderId]/route.ts': [{ keys: ['reprintOfId'], why: 'N6: unlinks the reprints of an order that is being deleted (a delete is refused after payment or production)' }],
  'app/api/admin/orderworks/jobs/[id]/route.ts': [{ keys: ['reprintOfId'], why: 'N6: the same, for the orders of a job' }],
  'app/api/admin/printers/auto-queue/route.ts': [{ keys: ['printerId', 'printerAssignedAt', 'printerAssignedBy'], why: 'N4: puts the oldest queued order on a free printer (after the release decision, under its lock)' }],
  'lib/checkout-orders.ts': [{ keys: ['guestAccessTokenHash', 'guestAccessExpiresAt'], why: 'N7: the access token of the guest order that was just made' }],
  'lib/payment-sync.ts': [{ keys: ['paymentSyncLeaseId', 'paymentSyncLeaseUntil'], why: 'N2: bookkeeping of the synchronisation (take and release the lease)' }],
  'lib/privacy.ts': [{ keys: ['userId', 'customerEmail', 'customerName', 'metadata'], why: 'maintenance: erases a deleted account\'s personal data. The revision column is NOT touched (it holds no personal data); whether the financial metadata should survive the erasure is the separate privacy approval' }],
  'scripts/hold-unpaid-orders.js': [{ keys: ['status'], why: 'N4: moves an unpaid order OUT of production, to awaiting_payment - never into or out of "cancelled"', values: { status: /^['"]awaiting_payment['"]$/ } }],
}
// raw statements: the columns of the SET clause
const NOT_FINANCIAL_RAW: Record<string, readonly string[]> = {
  'lib/payment-sync.ts': ['paymentSyncLeaseId', 'paymentSyncLeaseUntil'],
  'lib/data-retention.ts': ['guestSessionHash'],
}
const RAW_SET = /UPDATE\s+"PrintOrder"\s+SET\s+([\s\S]*?)\s+WHERE/gi

test('G11 every write to an order that could change a financial fact raises the financial revision in the same statement, or is a write that provably can not', () => {
  const problems: string[] = []
  let wrapped = 0
  let exempt = 0
  for (const file of sources) {
    const text = plain(file)
    for (const site of callSites(text, ORDER_WRITE_OPENING)) {
      const where = `${file}:${site.line}`
      const args = objectShape(site.args)
      // upsert has two data objects; update / updateMany have one
      const parts = site.name.endsWith('upsert') ? [propertyOf(args, 'create'), propertyOf(args, 'update')] : [propertyOf(args, 'data')]
      for (const part of parts) {
        if (!part) { problems.push(`${where}: no data to read`); continue }
        if (/^withFinancialRevision\s*\(/.test(part.value.trim())) { wrapped++; continue }
        const shape = part.value.trim().startsWith('{') ? objectShape(part.value) : null
        if (!shape || shape.spreads.length > 0 || shape.properties.some((property) => property.computed)) {
          problems.push(`${where}: the data is not a plain object and is not wrapped in withFinancialRevision(...)`)
          continue
        }
        const keys = shape.properties.map((property) => property.key)
        const entry = (NOT_FINANCIAL[file] ?? []).find((candidate) => keys.every((key) => candidate.keys.includes(key))
          && Object.entries(candidate.values ?? {}).every(([key, pattern]) => !keys.includes(key) || pattern.test(propertyOf(shape, key)!.value.trim())))
        if (!entry) { problems.push(`${where}: writes [${keys.join(', ')}] without withFinancialRevision(...) and is not on the list of writes that cannot change a financial fact`); continue }
        exempt++
      }
    }
    for (const match of text.matchAll(RAW_SET)) {
      const columns = [...match[1].matchAll(/"(\w+)"\s*=/g)].map((column) => column[1])
      const allowed = NOT_FINANCIAL_RAW[file] ?? []
      if (columns.length === 0 || !columns.every((column) => allowed.includes(column))) problems.push(`${file}: a raw UPDATE of "PrintOrder" sets [${columns.join(', ')}], which is not on the list of columns that cannot change a financial fact`)
    }
  }
  assert.deepEqual(problems, [])
  // the scan really sees the writers (a scanner that finds nothing proves nothing)
  assert.ok(wrapped >= 20, `only ${wrapped} wrapped writes were found: the scan is broken`)
  assert.ok(exempt >= 7, `only ${exempt} exempt writes were found: the list is stale`)
})

test('G11 the list of writes that can not change a financial fact never covers a financial column, and says why', () => {
  const forbidden = new Set<string>([...FINANCIAL_COLUMNS, 'financialRevision', 'paymentAttempts', 'refundOperations'])
  for (const [file, entries] of Object.entries(NOT_FINANCIAL)) {
    for (const entry of entries) {
      assert.ok(entry.why.length > 20, `${file}: the reason is missing`)
      assert.deepEqual(entry.keys.filter((key) => forbidden.has(key)), [], `${file}: an exemption lists a financial column`)
    }
  }
  for (const [file, columns] of Object.entries(NOT_FINANCIAL_RAW)) assert.deepEqual(columns.filter((column) => forbidden.has(column)), [], `${file}: a raw exemption lists a financial column`)
  // every exemption is still in use (a stale line is a hole waiting to be used)
  for (const file of Object.keys(NOT_FINANCIAL)) assert.ok(callSites(plain(file), ORDER_WRITE_OPENING).length > 0, `${file} no longer writes an order: remove it from the list`)
})

// payment attempts: the financial moves (to or from processing / paid / mismatch, the amount received, the PaymentIntent) are written in the same transaction as the order, with
// the `attempt` extra; the payment pages themselves (creating -> open -> expired / failed WITHOUT money) are N3 and move nothing
const ATTEMPT_WRITE = /\bpaymentAttempts?\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/
const ATTEMPT_WRITERS: Record<string, string> = {
  'lib/payment-sync.ts': 'financial: the order and the attempt are written in one transaction, the order UPDATE carries the `attempt` extra',
  'lib/payment-hold.ts': 'financial: "no charge" closes the attempts that were being confirmed, in the transaction of the order UPDATE, with the `attempt` extra',
  'lib/checkout-sessions.ts': 'N3: the payment page (creating -> open, creating / open -> expired / failed): never money - EXCEPT open -> processing, which raises the revision (markPageCompleteAtProvider)',
}
test('G11 payment attempts are written only by the files that raise the revision for the financial moves, and the page-only writer can not touch money', () => {
  const writers = sources.filter((file) => ATTEMPT_WRITE.test(plain(file)))
  assert.deepEqual(writers.sort(), Object.keys(ATTEMPT_WRITERS).sort(), 'a new file writes payment attempts: say whether it moves money, and raise the revision if it does')
  for (const file of ['lib/payment-sync.ts', 'lib/payment-hold.ts']) {
    const text = plain(file)
    assert.match(text, /\battemptChangeIsFinancial\(/, `${file} does not ask whether an attempt change is financial`)
    assert.match(text, /withFinancialRevision\([^;]*\battempt\s*:/s, `${file} does not pass the \`attempt\` extra to withFinancialRevision`)
  }
  const pages = plain('lib/checkout-sessions.ts')
  // every status it writes is a page state; closing a page can only produce "failed" / "expired" (the type of closeAttempt says so) and only from "creating" / "open"...
  for (const match of pages.matchAll(/\bstatus:\s*'(\w+)'/g)) assert.ok(['creating', 'open', 'expired', 'failed', 'processing'].includes(match[1]), `checkout-sessions writes the attempt status "${match[1]}"`)
  assert.ok(!/status:\s*'(paid|mismatch)'/.test(pages), 'checkout-sessions writes a financial attempt status')
  assert.match(pages, /async function closeAttempt\([^)]*status: 'failed' \| 'expired'/, 'closeAttempt can close a page as something other than failed / expired')
  for (const match of pages.matchAll(/closeAttempt\([^,]+,\s*(\[[^\]]*\])/g)) assert.ok(/^\[\s*'(creating|open)'(\s*,\s*'(creating|open)')?\s*\]$/.test(match[1]), `closeAttempt is allowed to close only a reservation or an open page ("creating", "open"), not ${match[1]}`)
  // ...and the ONE move into "processing" (the customer finished paying at Stripe) is made by a function that raises the financial revision in the same transaction
  assert.equal((pages.match(/status:\s*'processing'/g) ?? []).length, 1, 'checkout-sessions moves a page into "processing" in more than one place')
  const mover = pages.slice(pages.indexOf('async function markPageCompleteAtProvider'))
  assert.ok(mover.indexOf("status: 'processing'") > -1 && mover.indexOf("status: 'processing'") < mover.indexOf('\n}\n'), 'the move into "processing" is not inside markPageCompleteAtProvider')
  assert.match(mover.slice(0, mover.indexOf('\n}\n')), /FOR UPDATE[\s\S]*withFinancialRevision\(\{\}, \{\}, \{ attempt: true \}\)/, 'markPageCompleteAtProvider does not lock the order and raise the revision')
})

// refund operations: the work that writes them comes later; when it does, it must raise the revision (E13)
const REFUND_OPERATION_WRITE = /\brefundOperations?\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/
const REFUND_OPERATION_WRITERS: string[] = []
test('G11 no file writes a refund operation unless it raises the revision (none exists yet: the refund work is a later step)', () => {
  const writers = sources.filter((file) => REFUND_OPERATION_WRITE.test(plain(file)))
  assert.deepEqual(writers.sort(), [...REFUND_OPERATION_WRITERS].sort(), 'a new file writes refund operations: register it here')
  for (const file of REFUND_OPERATION_WRITERS) assert.match(plain(file), /withFinancialRevision\([^;]*\brefundOperation\s*:\s*true/s, `${file} writes refund operations without the E13 extra`)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 8. Who CREATES an order (G1 looked only at writes to orders that already exist)
// ---------------------------------------------------------------------------------------------------------------------------------------------
// An order created with a payment status of "paid" or "free" starts in the queue: the creators are few and each one must start the order unpaid (or at no charge with a reason),
// except the one that records a payment the server has already verified.
const ORDER_CREATE_OPENING = /\bprintOrder\.(create|createMany)\s*\(/g
const CREATORS: Record<string, { why: string; check: (text: string) => void }> = {
  'app/api/admin/orders/route.ts': {
    why: 'an administrator makes an order by hand: unpaid, or at no charge WITH a written reason; checkManualTransition decides the status',
    check: (text) => assert.match(text, /const paymentStatus = totalCents === 0 \? 'free' : 'pending'/),
  },
  'lib/checkout-orders.ts': {
    why: 'the hosted checkout makes the pending order; only the payment sync can mark it paid',
    check: (text) => {
      const calls = callSites(text, /\bbuildOrderCreateData\s*\(/g)
      assert.ok(calls.length > 0, 'lib/checkout-orders.ts no longer builds its order with buildOrderCreateData')
      for (const call of calls) assert.equal(propertyOf(objectShape(call.args), 'paymentStatus')?.value.trim(), "'pending'", 'the hosted checkout creates an order that is not "pending"')
    },
  },
  'lib/manual-quote.ts': {
    why: 'a request to be quoted: waiting for review, payment status "quote"',
    check: (text) => { for (const call of callSites(text, ORDER_CREATE_OPENING)) assert.equal(propertyOf(objectShape(propertyOf(objectShape(call.args), 'data')!.value), 'paymentStatus')?.value.trim(), "'quote'") },
  },
  'lib/orders.ts': {
    why: 'an order made from a job form (an outside sender\'s payment claim is not trusted: created unpaid) or from the old checkout (the payment was verified by its route); a reprint request is a quote',
    check: (text) => {
      assert.match(text, /const initialPaymentStatus = untrusted \? 'pending' : \(payload\.paymentStatus \|\| 'pending'\)/)
      for (const call of callSites(text, ORDER_CREATE_OPENING)) {
        const data = propertyOf(objectShape(call.args), 'data')!.value.trim()
        if (data.startsWith('{')) assert.equal(propertyOf(objectShape(data), 'paymentStatus')?.value.trim(), "'quote'", 'a create in lib/orders.ts with its own payment status that is not "quote"')
        else assert.equal(data, 'buildOrderCreateData(payload)')
      }
    },
  },
  'scripts/suite-demo-seed.ts': { why: 'demo data for screenshots; never run against real data (reported in docs/RILASCIO-PRODUZIONE.md)', check: () => undefined },
}
test('G1-create every place that creates an order is known, starts it unpaid, and never sets its financial revision', () => {
  const creators = sources.filter((file) => callSites(plain(file), ORDER_CREATE_OPENING).length > 0)
  assert.deepEqual(creators.sort(), Object.keys(CREATORS).sort(), 'a file creates orders and nobody classified it: add it to the registry with the reason and what its payment status can be')
  for (const [file, entry] of Object.entries(CREATORS)) {
    assert.ok(entry.why.length > 20, `${file}: the reason is missing`)
    entry.check(plain(file))
    for (const site of callSites(plain(file), ORDER_CREATE_OPENING)) {
      const data = propertyOf(objectShape(site.args), 'data')
      const shape = data && data.value.trim().startsWith('{') ? objectShape(data.value) : null
      assert.ok(!shape || !propertyOf(shape, 'financialRevision'), `${file}:${site.line} creates an order with its own financial revision`)
    }
  }
  // the old checkout's order-recording function is called by one route only, which passes the status it verified (and falls back to "pending")
  const callers = sources.filter((file) => /\brecordCustomerOrder\s*\(/.test(plain(file)) && file !== 'lib/orders.ts')
  assert.deepEqual(callers, ['app/api/checkout/route.ts'])
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 9. Nothing assumes "paid"
// ---------------------------------------------------------------------------------------------------------------------------------------------
// The literal "paid" / "free" as a payment status is written only where something was VERIFIED or ATTESTED: the verdict of the payment verification (Stripe), a PayPal capture the
// server read, the receipt an administrator attested, the order made by hand at no charge, and the demo data.
const PAID_ASSIGNMENT = /\bpaymentStatus\s*[:=]\s*(?:[^,;\n]*\?\s*)?['"](paid|free)['"]/
const PAID_WRITERS: Record<string, string> = {
  'lib/order-payment-policy.ts': 'the rule itself: filters (`where`) and comparisons about "paid" / "free", never a write (every write to an order is checked by G11)',
  'lib/payment-verification.ts': 'the verdict of the payment verification: the amount, the currency, the order reference and the "succeeded" state were all checked',
  'lib/paypal.ts': 'a PayPal capture the server read and found COMPLETED',
  'lib/orders.ts': 'the receipt an administrator attested (cash / bank transfer, reason, amount and currency from the order) and the free order',
  'app/api/admin/orders/route.ts': 'an order at no charge, which needs a written reason',
  'scripts/suite-demo-seed.ts': 'demo data',
}
test('G12 the literal "paid" or "free" is a payment status only where a payment was verified or attested - and nothing defaults to it', () => {
  const writers = sources.filter((file) => PAID_ASSIGNMENT.test(plain(file)))
  const unknown = writers.filter((file) => !PAID_WRITERS[file])
  assert.deepEqual(unknown, [], `these files write "paid" / "free" as a payment status and nobody looked at them: ${unknown.join(', ')}`)
  // a fallback to "paid" (a missing value read as money received) is the pattern behind F15
  // (a "contribution type" that defaults to "paid" - paid or donated - is another thing: only a PAYMENT status is looked at)
  const defaults = sources.filter((file) => /\w*[Pp]aymentStatus\w*[^;\n]*(\?\?|\|\|)\s*['"](paid|free)['"]/.test(plain(file)))
  assert.deepEqual(defaults, [], `these files fall back to "paid" when a status is missing: ${defaults.join(', ')}`)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 10. An administrator's word does not take the place of the answer of Stripe (F01)
// ---------------------------------------------------------------------------------------------------------------------------------------------
// "No charge" on a payment that is on hold (lib/payment-hold.ts) is decided on what Stripe says. It used to be possible to decide it all the same when Stripe could not be asked, on the
// administrator's declaration: a field of the request, a value kept as the result of the decision, and an error code that explained how to use the field. Step 4.6 (S6, P4-0) took that
// away. The three names must not come back in the code that runs - not as a field, not as a value, not as a code, and not even in a comment. (The history is in docs/VERIFICA-4.6.md and
// in the regression test tests/security/payment-hold.sec.ts: they are not looked at here, and they must be able to name the old defect.) The directories looked at are the ones that run.
const OBSOLETE_SHORTCUT = ['acknowledgeUnverified', 'unreachable_acknowledged', 'STRIPE_UNREACHABLE'] as const
const SHORTCUT_DIRS = ['app/', 'lib/', 'components/']
const obsoleteShortcutWords = (text: string) => OBSOLETE_SHORTCUT.filter((word) => text.includes(word))

test('G13 the detector of the old shortcut sees each of its three names - in a field, a value, a code and a comment - and nothing else', () => {
  for (const word of OBSOLETE_SHORTCUT) {
    for (const text of [`const body = { ${word}: true }`, `stripeCheck = '${word}'`, `throw new PaymentHoldError(409, '${word}', 'x')`, `// ${word}`, `/* ${word} */`]) {
      assert.deepEqual(obsoleteShortcutWords(text), [word], text)
    }
  }
  assert.deepEqual(obsoleteShortcutWords("throw new PaymentHoldError(409, 'STRIPE_UNVERIFIABLE', 'x'); stripeCheck = 'confirmed_no_charge' || 'payment_collected'"), [])
})

test('G13 none of the three names of the old "I know Stripe could not be asked" shortcut is in app/, lib/ or components/', () => {
  const scanned = sources.filter((file) => SHORTCUT_DIRS.some((dir) => file.startsWith(dir)))
  // the scan is not empty, and it does reach the library and the route that used to carry the shortcut
  assert.ok(scanned.length > 100, `the scan saw only ${scanned.length} files`)
  for (const file of ['lib/payment-hold.ts', 'app/api/admin/orders/[orderId]/payment-hold/route.ts']) assert.ok(scanned.includes(file), `the scan does not reach ${file}`)
  const found = scanned.flatMap((file) => obsoleteShortcutWords(read(file)).map((word) => `${file}: ${word}`))
  assert.deepEqual(found, [], `the old shortcut came back (an administrator deciding "no charge" on his own word when Stripe can not be asked): ${found.join('; ')}`)
})
